'use strict';
// Fabrique de l'application Express (Firestore + Cloud Storage injectables pour les tests).
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Stripe = require('stripe');
const { loadConfig } = require('./config');
const { makeSettings } = require('./lib/settings');
const { makeMailer } = require('./lib/mailer');
const { makeGeo } = require('./lib/geo');
const { makeAuth } = require('./lib/auth');
const { makeUploads } = require('./lib/uploads');
const { makeShop } = require('./services/shop');
const { makePremium } = require('./services/premium');
const { makeWebhookHandler } = require('./services/webhook');
const { makeStats } = require('./services/stats');
const { makeApi } = require('./routes/api');
const { makeAdmin } = require('./routes/admin');
const { now } = require('./lib/util');
const { fontFaceCss } = require('./lib/fonts');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8').replace('/*@FONTS@*/', () => fontFaceCss());
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return { html, hashes };
}

// Stockage de fichiers Cloud Storage
function gcsStorage(bucket) {
  return {
    async save(p, buffer, contentType) { await bucket.file(p).save(buffer, { contentType, resumable: false }); },
    async read(p) { const f = bucket.file(p); const [exists] = await f.exists(); if (!exists) return null; const [buffer] = await f.download(); const [meta] = await f.getMetadata(); return { buffer, contentType: meta.contentType }; },
    async remove(p) { await bucket.file(p).delete({ ignoreNotFound: true }); },
  };
}

function createApp(overrides = {}) {
  const cfg = loadConfig(overrides.config || {});
  const log = overrides.log || console;
  const db = overrides.db;
  const storage = overrides.storage || gcsStorage(overrides.bucket);
  let stripe = overrides.stripe;
  if (stripe) cfg.stripeInjected = true;
  else stripe = new Stripe(cfg.stripeSecretKey || 'sk_test_non_configure', { maxNetworkRetries: 2, timeout: 20000 });
  const settings = makeSettings(db);
  const mailer = makeMailer(db, cfg, settings);
  const geo = makeGeo(db, cfg);
  const auth = makeAuth(db, cfg);
  const uploads = makeUploads(storage);
  const shop = makeShop({ db, cfg, mailer, geo, stripe, settings, log });
  const premium = makePremium({ db, cfg, stripe, shop, mailer, settings });
  const stats = makeStats(db, settings);
  const audit = (uid, action, details, ip) => db.collection('audit').add({ user_id: uid, action, details: details || null, ip: ip || null, created_at: now() });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const store = loadPage(path.join(PUBLIC_DIR, 'index.html'));
  const admin = loadPage(path.join(PUBLIC_DIR, 'admin.html'));
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      'default-src': ["'self'"], 'script-src': ["'self'", ...new Set([...store.hashes, ...admin.hashes])], 'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'], 'font-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'form-action': ["'self'"],
      'frame-ancestors': ["'none'"], 'base-uri': ["'self'"], 'object-src': ["'none'"] } },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: cfg.cookieSecure ? { maxAge: 15552000 } : false,
  }));

  // Webhook Stripe : Cloud Functions fournit req.rawBody ; hors Functions, on lit le corps brut.
  app.post('/api/stripe/webhook', (req, res, next) => (req.rawBody ? next() : express.raw({ type: '*/*', limit: '1mb' })(req, res, next)),
    makeWebhookHandler({ db, cfg, stripe, shop, premium, log }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(auth.loadSession);
  const api = makeApi({ db, cfg, auth, shop, premium, mailer, uploads, audit, stripe, settings });
  app.post('/api/newsletter/unsubscribe', api.unsub); // désinscription en un clic (jeton suffisant)
  app.use('/api', auth.csrf);
  app.use('/api/admin', makeAdmin({ db, cfg, auth, shop, premium, mailer, uploads, geo, audit, stats, settings }));
  app.use('/api', api.router);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

  app.get('/uploads/images/:name', async (req, res, next) => {
    try {
      const name = path.basename(req.params.name);
      if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(name)) return res.status(404).end();
      const f = await uploads.read(`images/${name}`);
      if (!f) return res.status(404).end();
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type(f.contentType || 'application/octet-stream').send(f.buffer);
    } catch (e) { next(e); }
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  const sendPage = (page) => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(page.html); };
  app.get(['/admin', '/admin/*'], sendPage(admin));
  app.get(/^\/(?!api\/|uploads\/).*/, sendPage(store));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
    const status = err.status && err.expose ? err.status : 500;
    if (status >= 500) log.error('[erreur]', err);
    res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur' : err.message, code: err.code, details: err.details });
  });

  async function runJobs() {
    await shop.expireReservations();
    await mailer.processQueue();
    const t = now();
    for (const s of (await db.collection('sessions').where('expiresAt', '<', t).get()).docs) await s.ref.delete();
    for (const s of (await db.collection('tokens').where('expires_at', '<', t - 86400).get()).docs) await s.ref.delete();
  }

  return { app, db, cfg, stripe, shop, premium, mailer, geo, settings, runJobs, storage };
}

module.exports = { createApp };
