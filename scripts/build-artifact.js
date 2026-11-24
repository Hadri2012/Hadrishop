'use strict';
// Génère dist/hadrishop-apercu.html : la page boutique réelle (public/index.html) en mode « aperçu »,
// avec un instantané du catalogue (produits, variantes, stocks, images en data: URI).
// Sans serveur, cette page n'active ni comptes, ni paiement, ni administration (rien n'est simulé).
// Usage : npm run build-artifact            → instantané du catalogue de démonstration
//         npm run build-artifact -- --live  → instantané de votre base (DATA_DIR)
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { fontFaceCss } = require('../src/lib/fonts');
const { seedDemo } = require('./seed-demo');

(async () => {
  const live = process.argv.includes('--live');
  const dir = live ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'hadrishop-artifact-'));
  const ctx = createApp({ config: dir ? { dataDir: dir, dbFile: path.join(dir, 'db.sqlite') } : {}, log: { log() {}, warn() {}, error() {} } });
  if (!live) await seedDemo({ db: ctx.db, uploadsDir: ctx.cfg.uploadsDir });
  const http = request(ctx.app);
  const config = (await http.get('/api/config')).body;
  const categories = (await http.get('/api/categories')).body;
  const list = (await http.get('/api/products?per=60')).body.items;
  const toData = (url) => {
    const file = path.join(ctx.cfg.uploadsDir, 'images', path.basename(url));
    const ext = path.extname(file).slice(1).replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  };
  const products = [];
  for (const item of list) {
    const p = (await http.get('/api/products/' + item.slug)).body;
    p.images = p.images.map((i) => ({ ...i, url: toData(i.url) }));
    products.push(p);
  }
  const snapshot = { config: { ...config, user: null, payments_configured: false }, categories, products, generated_at: new Date().toISOString(), demo: !live };
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace('/*@FONTS@*/', () => fontFaceCss());
  const note = live ? '' : ' Catalogue, prix et illustrations d’exemple.';
  html = html.replace('<script>\n{', `<script type="application/json" id="vitrine-data">${json}</script>\n<script>\n{`)
    .replace('Les comptes, le paiement Stripe et l\'administration fonctionnent sur le serveur déployé.', `Les comptes, le paiement Stripe et l'administration fonctionnent sur le serveur déployé.${note}`);
  fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
  const out = path.join(__dirname, '..', 'dist', 'hadrishop-apercu.html');
  fs.writeFileSync(out, html);
  ctx.db.close();
  console.log(`Aperçu généré : ${out} (${(html.length / 1024).toFixed(0)} Ko, ${products.length} produits)`);
})();
