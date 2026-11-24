'use strict';
// Fabrique de l'application : dépendances injectables (Stripe, transport e-mail) pour les tests.
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Stripe = require('stripe');
const { openDb } = require('./db');
const { loadConfig } = require('./config');
const { getSettings } = require('./lib/settings');
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

// Lit une page HTML et calcule l'empreinte SHA-256 de ses scripts en ligne (CSP stricte sans 'unsafe-inline').
function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8').replace('/*@FONTS@*/', () => fontFaceCss());
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return { html, hashes };
}

function createApp(overrides = {}) {
  const cfg = loadConfig(overrides.config || {});
  const log = overrides.log || console;
  const db = overrides.db || openDb(cfg.dbFile);
  let stripe = overrides.stripe;
  if (stripe) cfg.stripeInjected = true;
  else stripe = new Stripe(cfg.stripeSecretKey || 'sk_test_non_configure', { maxNetworkRetries: 2, timeout: 20000 });
  const mailer = makeMailer(db, cfg, getSettings);
  const geo = makeGeo(db, cfg);
  const auth = makeAuth(db, cfg);
  const uploads = makeUploads(cfg);
  const shop = makeShop({ db, cfg, mailer, geo, stripe, log });
  const premium = makePremium({ db, cfg, stripe, shop, mailer });
  const stats = makeStats(db, shop);
  const audit = (userId, action, details, ip) => db.prepare('INSERT INTO audit_log(user_id, action, details, ip, created_at) VALUES (?,?,?,?,?)').run(userId, action, details, ip || null, now());

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);

  const store = loadPage(path.join(PUBLIC_DIR, 'index.html'));
  const admin = loadPage(path.join(PUBLIC_DIR, 'admin.html'));
  const csp = (hashes) => helmet({
    contentSecurityPolicy: { useDefaults: false, directives: {
      'default-src': ["'self'"], 'script-src': ["'self'", ...hashes], 'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'], 'font-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'form-action': ["'self'", 'https://checkout.stripe.com'],
      'frame-ancestors': ["'none'"], 'base-uri': ["'self'"], 'object-src': ["'none'"],
    } },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: cfg.cookieSecure ? { maxAge: 15552000 } : false,
  });
  app.use(csp([...new Set([...store.hashes, ...admin.hashes])]));

  // Webhook Stripe AVANT tout analyseur JSON (corps brut indispensable à la vérification de signature)
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), makeWebhookHandler({ db, cfg, stripe, shop, premium, log }));

  app.use(express.json({ limit: '200kb' }));
  app.use(auth.loadSession);
  const api = makeApi({ db, cfg, auth, shop, premium, mailer, uploads, audit, stripe });
  app.post('/api/newsletter/unsubscribe', express.urlencoded({ extended: false }), api.unsub); // désinscription « en un clic » (sans CSRF : jeton suffisant)
  app.use('/api', auth.csrf);
  app.use('/api/admin', makeAdmin({ db, cfg, auth, shop, premium, mailer, uploads, geo, audit, stats }));
  app.use('/api', api.router);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

  app.use('/uploads/images', express.static(uploads.dirs.images, { maxAge: '7d', immutable: true, index: false, dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
  app.get('/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
  const sendPage = (page) => (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(page.html); };
  app.get(['/admin', '/admin/*'], sendPage(admin));
  app.get('/', sendPage(store));
  app.get(/^\/(?!api\/|uploads\/).*/, sendPage(store));

  // Gestion d'erreurs : messages internes jamais exposés
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
    const status = err.status && err.expose ? err.status : 500;
    if (status >= 500) log.error('[erreur]', err);
    res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur' : err.message, code: err.code, details: err.details });
  });

  // Tâches périodiques
  let timer = null, running = false;
  async function runJobs() {
    if (running) return; running = true;
    try {
      await shop.expireReservations();
      await mailer.processQueue();
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now() - 86400);
    } catch (e) { log.error('[jobs]', e); } finally { running = false; }
  }
  function startJobs() { if (!timer) { timer = setInterval(runJobs, cfg.jobsIntervalMs); timer.unref(); } }
  function stopJobs() { if (timer) clearInterval(timer); timer = null; }

  return { app, db, cfg, stripe, shop, premium, mailer, geo, runJobs, startJobs, stopJobs };
}

module.exports = { createApp };
