'use strict';
// Tests de bout en bout dans Chrome (puppeteer-core). Stripe est remplacé par le faux client de test :
// la redirection vers Checkout est interceptée, AUCUN paiement réel n'est effectué.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { setup, createUser, sendWebhook, completedSession } = require('../test/helpers');
const { seedDemo } = require('../scripts/seed-demo');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOTS = path.join(__dirname, '..', 'dist', 'screenshots');
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

describe('Navigateur : boutique, paiement et administration', () => {
  let ctx, server, browser, base, admin;
  const errors = [];
  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    ctx = setup({ config: { appUrl: base } });
    await seedDemo({ db: ctx.db, uploadsDir: ctx.cfg.uploadsDir });
    admin = await createUser(ctx, { role: 'admin', email: 'admin@hadrishop.test', password: 'admin-mot-de-passe' });
    await new Promise((r) => { server = ctx.app.listen(port, '127.0.0.1', r); });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    fs.mkdirSync(SHOTS, { recursive: true });
  });
  after(async () => { if (browser) await browser.close(); if (server) server.close(); ctx.db.close(); });

  async function newPage(width = 1280, height = 900) {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
    return page;
  }
  const settle = (page) => page.waitForFunction(() => !document.querySelector('#app .loading, #main > p.muted'), { timeout: 10000 });

  test('accueil, recherche, fiche produit et panier (sans erreur JS ni violation CSP)', async () => {
    const page = await newPage();
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    await settle(page);
    assert.ok(await page.$('.hero h1'));
    assert.ok((await page.$$('.products .card')).length >= 4);
    await page.screenshot({ path: path.join(SHOTS, 'accueil.png') });
    await page.type('#search-input', 'vase');
    await page.click('#search-form button');
    await page.waitForFunction(() => location.hash === '#boutique' && (document.querySelector('h1')?.textContent || '').includes('vase'));
    await settle(page);
    const names = await page.$$eval('.products .card .name', (els) => els.map((e) => e.textContent));
    assert.deepEqual(names, ['Vase spirale']);
    await page.click('.products .card');
    await page.waitForSelector('#add');
    await page.click('[data-variant]:nth-child(2)');
    await page.click('#add');
    await page.waitForFunction(() => document.querySelector('#cart-count').textContent === '1');
    await page.screenshot({ path: path.join(SHOTS, 'produit.png') });
    await page.goto(base + '/#panier', { waitUntil: 'networkidle0' });
    await settle(page);
    assert.match(await page.$eval('.line', (e) => e.textContent), /Moyen/);
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('inscription → confirmation e-mail → paiement Stripe (redirection interceptée) → webhook → commande payée', async () => {
    const page = await newPage();
    await page.goto(base + '/#compte', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear()); // panier vide (le test précédent a rempli le panier)
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#reg-form');
    await page.type('#rg-name', 'Hadrien Test');
    await page.type('#rg-email', 'client-e2e@test.be');
    await page.type('#rg-pass', 'mot-de-passe-solide');
    await page.click('#rg-terms');
    await page.click('#reg-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent.includes('Hadrien'));
    // Confirmation de l'e-mail via le lien réellement envoyé
    const mail = ctx.db.prepare(`SELECT text_body FROM emails WHERE kind = 'verify' AND to_addr = 'client-e2e@test.be'`).get();
    const link = mail.text_body.match(/http:\/\/\S+token=[A-Za-z0-9_-]+/)[0];
    await page.goto(link, { waitUntil: 'networkidle0' });
    // Panier : 2 porte-clés, retrait à l'atelier
    await page.goto(base + '/#produit-porte-cles-personnalise', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#add');
    await page.click('[data-q="1"]');
    await page.click('#add');
    await page.goto(base + '/#panier', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#pc-form');
    await page.type('#pc', '1000');
    await page.click('#pc-form button');
    await page.waitForSelector('input[name=zone]:not([disabled])');
    await page.click('input[name=zone][value="1"]');
    await page.waitForFunction(() => document.querySelector('#pay') && !document.querySelector('#pay').disabled);
    await page.type('#promo', 'BIENVENUE10');
    await page.click('#promo-form button');
    await page.waitForFunction(() => document.body.textContent.includes('Code BIENVENUE10'));
    await page.screenshot({ path: path.join(SHOTS, 'panier.png'), fullPage: true });
    await page.setRequestInterception(true);
    let stripeUrl = null;
    const onReq = (r) => { if (r.url().startsWith('https://checkout.stripe.test/')) { stripeUrl = r.url(); r.abort(); } else r.continue(); };
    page.on('request', onReq);
    await page.click('#pay');
    await page.waitForFunction(() => true, { timeout: 500 }).catch(() => {});
    for (let i = 0; i < 40 && !stripeUrl; i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(stripeUrl, /^https:\/\/checkout\.stripe\.test\//, 'redirection vers Stripe Checkout');
    const order = ctx.db.prepare(`SELECT * FROM orders WHERE email = 'client-e2e@test.be'`).get();
    assert.equal(order.total_cents, 1242, '2 × 6,90 € − 10 %');
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, order.number));
    page.off('request', onReq);
    await page.setRequestInterception(false);
    await page.goto(`${base}/?paiement=ok#commande-${order.number}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.textContent.includes('Payée'));
    await page.screenshot({ path: path.join(SHOTS, 'commande.png'), fullPage: true });
    assert.equal(await page.$eval('#cart-count', (e) => e.textContent), '0', 'panier vidé après paiement');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('mobile 390 px : aucune page plus large que l’écran', async () => {
    const page = await newPage(390, 844);
    for (const h of ['#accueil', '#boutique', '#produit-dragon-articule', '#panier', '#sur-mesure', '#premium', '#compte']) {
      await page.goto(base + '/' + h, { waitUntil: 'networkidle0' });
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${h} déborde de ${overflow}px`);
    }
    await page.goto(base + '/#accueil', { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(SHOTS, 'mobile-accueil.png') });
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('/admin : connexion puis chaque écran se charge sans erreur', async () => {
    const page = await newPage(1366, 900);
    await page.goto(base + '/admin', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#lf');
    await page.type('#lf-e', 'admin@hadrishop.test');
    await page.type('#lf-p', 'admin-mot-de-passe');
    await page.click('#lf button');
    await page.waitForSelector('#chart svg rect');
    await page.screenshot({ path: path.join(SHOTS, 'admin-tableau-de-bord.png'), fullPage: true });
    for (const v of ['orders', 'products', 'categories', 'promos', 'shipping', 'custom', 'refunds', 'customers', 'newsletter', 'emails', 'settings', 'audit', 'products-nouveau', 'orders-1', 'customers-1']) {
      await page.goto(`${base}/admin#${v}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.querySelector('#main h1'), { timeout: 8000 });
      const notice = await page.$('#main .notice.err');
      assert.ok(!notice || !(await notice.evaluate((n) => /introuvable|Erreur/.test(n.textContent))), `écran ${v} en erreur`);
    }
    await page.goto(`${base}/admin#orders-1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#o-st-save');
    await page.screenshot({ path: path.join(SHOTS, 'admin-commande.png'), fullPage: true });
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('/admin : création d’un produit par le formulaire et passage d’une commande en « Expédiée »', async () => {
    const page = await newPage(1366, 900);
    await page.goto(`${base}/admin#products-nouveau`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#pe-name');
    await page.type('#pe-name', 'Lampe lithophanie');
    await page.$eval('[data-v="0"][data-f="sku"]', (e) => { e.value = 'LITHO-1'; });
    await page.$eval('[data-v="0"][data-f="price"]', (e) => { e.value = '34,90'; });
    await page.$eval('[data-v="0"][data-f="stock"]', (e) => { e.value = '4'; });
    await page.click('#pe-save');
    await page.waitForFunction(() => /#products-\d+/.test(location.hash));
    const p = ctx.db.prepare(`SELECT p.*, v.price_cents, v.stock FROM products p JOIN variants v ON v.product_id = p.id WHERE p.name = 'Lampe lithophanie'`).get();
    assert.equal(p.price_cents, 3490); assert.equal(p.stock, 4);
    await page.goto(`${base}/admin#orders-1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#o-st');
    await page.select('#o-st', 'shipped');
    await page.type('#o-num', 'CD-E2E-1');
    await page.click('#o-st-save');
    await page.waitForFunction(() => document.body.textContent.includes('Expédiée'));
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = 1').get().status, 'shipped');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('aperçu Artifact (fichier autonome, mode vitrine) : catalogue et panier sans serveur', async () => {
    const file = path.join(__dirname, '..', 'dist', 'hadrishop-apercu.html');
    assert.ok(fs.existsSync(file), 'lancer npm run build-artifact avant');
    const page = await newPage(1280, 900);
    await page.goto('file://' + file, { waitUntil: 'load' });
    await page.waitForSelector('.products .card');
    assert.equal(await page.$eval('#vitrine-note', (e) => e.hidden), false);
    await page.goto('file://' + file + '#produit-vase-spirale');
    await page.waitForSelector('#add');
    await page.click('#add');
    await page.goto('file://' + file + '#panier');
    await page.waitForSelector('.line');
    assert.ok(!(await page.$('#pay')), 'aucun bouton de paiement en aperçu');
    await page.screenshot({ path: path.join(SHOTS, 'apercu-panier.png') });
    await page.goto('file://' + file + '#compte');
    await page.waitForFunction(() => document.body.textContent.includes('serveur HADRISHOP déployé'));
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });

  test('aperçu Artifact avec stockage navigateur bloqué (cadre isolé) : la page fonctionne quand même', async () => {
    const file = path.join(__dirname, '..', 'dist', 'hadrishop-apercu.html');
    const page = await newPage(1024, 800);
    await page.evaluateOnNewDocument(() => {
      for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { get() { throw new DOMException('bloqué', 'SecurityError'); } });
    });
    await page.goto('file://' + file + '#produit-dragon-articule', { waitUntil: 'load' });
    await page.waitForSelector('#add');
    await page.click('#add');
    await page.waitForFunction(() => document.querySelector('#cart-count').textContent === '1');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.close();
  });
});
