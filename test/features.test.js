'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, client, createUser, createProduct, sendWebhook, completedSession, key, addZone, ADDRESS } = require('./helpers');

// STL binaire valide : en-tête 80 octets + nombre de triangles + 50 octets par triangle
function binaryStl(triangles = 2) {
  const b = Buffer.alloc(84 + 50 * triangles); b.write('hadrishop test', 0); b.writeUInt32LE(triangles, 80); return b;
}

describe('Catalogue, STL, sur mesure, Premium, newsletter, adresses, statistiques', () => {
  let ctx, admin, pickup, brussels;
  before(async () => {
    ctx = setup();
    admin = await createUser(ctx, { role: 'admin' });
    pickup = await addZone(admin, { name: 'Retrait', kind: 'pickup', price_cents: 0 });
    brussels = await addZone(admin, { name: 'Bruxelles', kind: 'postal', postal_codes: '1000-1210', price_cents: 500 });
  });
  after(() => ctx.db.close());

  test('catalogue : catégories, recherche, filtres, tri, produits inactifs masqués', async () => {
    const cat = (await admin.post('/api/admin/categories').send({ name: 'Déco maison' })).body;
    assert.equal(cat.slug, 'deco-maison');
    await createProduct(admin, { name: 'Vase spirale', category_id: cat.id, variants: [{ sku: 'VS-S', name: 'Petit', price_cents: 1900, stock: 3 }, { sku: 'VS-L', name: 'Grand', price_cents: 2900, stock: 0 }] });
    const hidden = await createProduct(admin, { name: 'Vase caché', category_id: cat.id });
    const hid = await admin.put(`/api/admin/products/${hidden.id}`).send({ name: 'Vase caché', type: 'physical', active: false, variants: hidden.variants.map(({ reserved, ...v }) => v) });
    assert.equal(hid.status, 200, JSON.stringify(hid.body));
    const list = await request(ctx.app).get('/api/products').query({ category: 'deco-maison' });
    assert.deepEqual(list.body.items.map((p) => p.name), ['Vase spirale']);
    assert.equal(list.body.items[0].price_from_cents, 1900);
    const search = await request(ctx.app).get('/api/products').query({ q: 'spirale' });
    assert.equal(search.body.total, 1);
    const detail = await request(ctx.app).get('/api/products/vase-spirale');
    assert.deepEqual(detail.body.variants.map((v) => [v.name, v.available, v.in_stock]), [['Petit', 3, true], ['Grand', 0, false]]);
    assert.equal((await request(ctx.app).get('/api/products/vase-cache')).status, 404);
    const cats = await request(ctx.app).get('/api/categories');
    assert.equal(cats.body.find((c) => c.slug === 'deco-maison').count, 1);
  });

  test('admin : variantes modifiées, supprimées, ajustement de stock jamais négatif', async () => {
    const p = await createProduct(admin, { name: 'Organiseur', variants: [{ sku: 'ORG-A', name: 'A', price_cents: 1000, stock: 5 }, { sku: 'ORG-B', name: 'B', price_cents: 1200, stock: 5 }] });
    const upd = await admin.put(`/api/admin/products/${p.id}`).send({ name: 'Organiseur', type: 'physical',
      variants: [{ id: p.variants[0].id, sku: 'ORG-A', name: 'A+', price_cents: 1100, stock: 7 }, { sku: 'ORG-C', name: 'C', price_cents: 1500, stock: 2 }] });
    assert.equal(upd.status, 200);
    assert.deepEqual(upd.body.variants.map((v) => v.sku), ['ORG-A', 'ORG-C']);
    const dupSku = await admin.post('/api/admin/products').send({ name: 'Autre', type: 'physical', variants: [{ sku: 'ORG-A', name: 'x', price_cents: 1, stock: 1 }] });
    assert.equal(dupSku.status, 409);
    const vid = upd.body.variants[0].id;
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ delta: -10 })).status, 400);
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ delta: -2 })).body.stock, 5);
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ set: 12 })).body.stock, 12);
  });

  test('vente de fichiers STL : téléchargement réservé à l’acheteur, limité, révoqué après remboursement total', async () => {
    await ctx.db.prepare(`INSERT INTO settings(key, value) VALUES ('download_max_count', '2') ON CONFLICT(key) DO UPDATE SET value = '2'`).run();
    const p = await createProduct(admin, { name: 'Fichier STL dragon', type: 'digital', variants: [{ sku: 'STL-DRG', name: 'Licence personnelle', price_cents: 600, stock: null }] });
    assert.equal(p.variants[0].stock, null, 'pas de stock pour un fichier');
    const badFile = await admin.post(`/api/admin/products/${p.id}/files`).attach('files', Buffer.from('pas un stl'), 'faux.stl');
    assert.equal(badFile.status, 400);
    const up = await admin.post(`/api/admin/products/${p.id}/files`).attach('files', binaryStl(3), 'dragon.stl');
    assert.equal(up.status, 201);
    const c = await createUser(ctx);
    const qty2 = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], checkoutKey: key() });
    assert.equal(qty2.status, 409);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], checkoutKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const params = ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop()[1];
    assert.equal(params.shipping_options, undefined, 'pas de livraison pour un fichier');
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number));
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.status, 'completed');
    const dls = (await c.get('/api/me/downloads')).body;
    assert.equal(dls.length, 1);
    const d1 = await c.get(`/api/downloads/${dls[0].id}`);
    assert.equal(d1.status, 200); assert.match(d1.headers['content-disposition'], /dragon\.stl/);
    assert.equal(d1.body.length || Number(d1.headers['content-length']), 84 + 150);
    assert.equal((await c.get(`/api/downloads/${dls[0].id}`)).status, 200);
    assert.equal((await c.get(`/api/downloads/${dls[0].id}`)).status, 403, 'limite atteinte');
    const other = await createUser(ctx);
    assert.equal((await other.get(`/api/downloads/${dls[0].id}`)).status, 404);
    assert.equal((await request(ctx.app).get(`/api/downloads/${dls[0].id}`)).status, 401);
    await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 600 });
    assert.equal(ctx.db.prepare('SELECT revoked FROM downloads WHERE id = ?').get(dls[0].id).revoked, 1);
    assert.equal((await admin.delete(`/api/admin/files/${up.body[0].id}`)).status, 200, 'fichier supprimable une fois les droits révoqués');
  });

  test('commande personnalisée : demande avec fichier, devis, acceptation, paiement', async () => {
    const c = await createUser(ctx);
    const r = await c.post('/api/custom-requests').field('title', 'Pièce de rechange lave-vaisselle').field('description', 'Roulette cassée, je joins le modèle.')
      .field('quantity', '2').field('material', 'PETG').attach('files', binaryStl(1), 'roulette.stl');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const rejectedFile = await c.post('/api/custom-requests').field('title', 'Test').field('description', 'Fichier exécutable déguisé').field('quantity', '1')
      .attach('files', Buffer.from('MZ\x90\x00'), 'virus.stl');
    assert.equal(rejectedFile.status, 400);
    assert.equal((await c.post(`/api/custom-requests/${r.body.id}/accept`).send({ shippingZoneId: pickup.id, checkoutKey: key() })).status, 409, 'pas encore de devis');
    const list = (await admin.get('/api/admin/custom-requests')).body;
    const reqRow = list.find((x) => x.id === r.body.id);
    assert.equal(reqRow.files[0].original_name, 'roulette.stl');
    assert.equal((await admin.get(`/api/admin/custom-files/${reqRow.files[0].id}`)).status, 200);
    const q = await admin.post(`/api/admin/custom-requests/${r.body.id}/quote`).send({ quote_cents: 2400, quote_days: 3, quote_message: 'Imprimé en PETG noir.' });
    assert.equal(q.status, 200);
    assert.ok(ctx.db.prepare(`SELECT 1 FROM emails WHERE kind = 'custom_quote' AND to_addr = ?`).get(c.user.email));
    const acc = await c.post(`/api/custom-requests/${r.body.id}/accept`).send({ shippingZoneId: brussels.id, address: ADDRESS, checkoutKey: key() });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(acc.body.number);
    assert.equal(o.total_cents, 2900);
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, acc.body.number));
    const mine = (await c.get('/api/me/custom-requests')).body.find((x) => x.id === r.body.id);
    assert.equal(mine.status, 'paid'); assert.equal(mine.order_number, acc.body.number);
  });

  test('modification d’adresse : client dans la même zone uniquement, admin sans restriction, e-mail envoyé', async () => {
    const p = await createProduct(admin, { name: 'Adresse' });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: brussels.id, address: ADDRESS, checkoutKey: key() });
    const early = await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, line1: 'Avenue Louise 1', postal_code: '1050' });
    assert.equal(early.status, 409, 'pas avant paiement');
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number));
    const ok = await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, line1: 'Avenue Louise 1', postal_code: '1050' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.ship_line1, 'Avenue Louise 1');
    const outZone = await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, postal_code: '4000', city: 'Liège' });
    assert.equal(outZone.status, 409);
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    await admin.post(`/api/admin/orders/${o.id}/status`).send({ status: 'shipped', tracking_carrier: 'bpost', tracking_number: 'CD123', tracking_url: 'https://track.bpost.cloud/' });
    assert.equal((await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, line1: 'Rue X 2' })).status, 409, 'plus modifiable après expédition');
    assert.equal((await admin.patch(`/api/admin/orders/${o.id}/address`).send({ ...ADDRESS, postal_code: '4000', city: 'Liège' })).status, 200);
    assert.ok(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE kind = 'address' AND to_addr = ?`).get(c.user.email).n >= 2);
    const statusMail = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'order_status' AND to_addr = ?`).get(c.user.email);
    assert.match(statusMail.text_body, /CD123/);
    assert.equal((await admin.post(`/api/admin/orders/${o.id}/status`).send({ status: 'shipped', tracking_url: 'javascript:alert(1)' })).status, 400);
  });

  test('Premium : abonnement Stripe, remise et livraison offerte, résiliation', async () => {
    const c = await createUser(ctx);
    const sub = await c.post('/api/premium/subscribe');
    assert.equal(sub.status, 200);
    const call = ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop()[1];
    assert.equal(call.mode, 'subscription');
    assert.equal(call.line_items[0].price_data.recurring.interval, 'month');
    const again = await c.post('/api/premium/subscribe');
    assert.equal(again.body.reused, true, 'pas de second abonnement en parallèle');
    const subId = 'sub_test_1';
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    ctx.fakeStripe.state.subs.set(subId, { id: subId, object: 'subscription', status: 'active', customer: c.user.stripe_customer_id || ctx.db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(c.user.id).stripe_customer_id,
      cancel_at_period_end: false, metadata: { kind: 'premium', user_id: String(c.user.id) }, items: { data: [{ current_period_end: end }] } });
    await sendWebhook(ctx, 'checkout.session.completed', { id: 'cs_sub', object: 'checkout.session', mode: 'subscription', subscription: subId, client_reference_id: String(c.user.id) });
    const me = await c.get('/api/me');
    assert.equal(me.body.premium, true);
    const p = await createProduct(admin, { name: 'Premium test', variants: [{ sku: 'PT-1', name: 'X', price_cents: 3000, stock: 5 }] });
    const q = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: brussels.id, postal_code: '1000' });
    assert.equal(q.body.premium_discount_cents, 300);
    assert.equal(q.body.shipping_cents, 0);
    assert.equal(q.body.total_cents, 2700);
    const cancel = await c.post('/api/premium/cancel');
    assert.equal(cancel.body.premium_cancel_at_period_end, true);
    assert.equal(cancel.body.premium, true, 'reste actif jusqu’à la fin de la période');
    ctx.fakeStripe.state.subs.get(subId).status = 'canceled';
    await sendWebhook(ctx, 'customer.subscription.deleted', ctx.fakeStripe.state.subs.get(subId));
    assert.equal((await c.get('/api/me')).body.premium, false);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE kind = 'premium' AND to_addr = ?`).get(c.user.email).n, 2);
  });

  test('produit réservé aux membres Premium', async () => {
    const p = await createProduct(admin, { name: 'Exclusif', premium_only: true, variants: [{ sku: 'EXC-1', name: 'X', price_cents: 1000, stock: 5 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r.status, 409); assert.match(r.body.error, /Premium/);
  });

  test('newsletter : double opt-in, désinscription en un clic, campagne envoyée aux seuls confirmés', async () => {
    const anon = client(ctx);
    await anon.post('/api/newsletter/subscribe').send({ email: 'lecteur@test.be' });
    await anon.post('/api/newsletter/subscribe').send({ email: 'jamais-confirme@test.be' });
    const mail = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'nl_confirm' AND to_addr = ?`).get('lecteur@test.be');
    const token = mail.text_body.match(/token=([A-Za-z0-9_-]+)/)[1];
    const conf = await request(ctx.app).get('/api/newsletter/confirm?token=' + token);
    assert.match(conf.headers.location, /newsletter=ok/);
    const camp = await admin.post('/api/admin/newsletter/campaigns').send({ subject: 'Nouveautés de décembre', body: 'Bonjour,\n\nVoici nos nouvelles pièces.' });
    const sent = await admin.post(`/api/admin/newsletter/campaigns/${camp.body.id}/send`);
    assert.equal(sent.body.recipients, 1);
    assert.equal((await admin.post(`/api/admin/newsletter/campaigns/${camp.body.id}/send`)).status, 409, 'pas de double envoi');
    const nl = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'newsletter' AND to_addr = ?`).get('lecteur@test.be');
    assert.match(nl.text_body, /unsubscribe\?token=/);
    const one = await request(ctx.app).post('/api/newsletter/unsubscribe').type('form').send({ token });
    assert.equal(one.status, 200);
    assert.equal(ctx.db.prepare('SELECT status FROM newsletter_subscribers WHERE email = ?').get('lecteur@test.be').status, 'unsubscribed');
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE kind = 'newsletter' AND to_addr = ?`).get('jamais-confirme@test.be').n, 0);
  });

  test('e-mails : file d’attente envoyée via SMTP (transport de test)', async () => {
    const before = ctx.sent.length;
    await ctx.mailer.processQueue(500);
    assert.ok(ctx.sent.length > before);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE status = 'queued'`).get().n, 0);
    const m = ctx.sent[ctx.sent.length - 1];
    assert.ok(m.html && m.text);
  });

  test('tableau de bord : chiffre d’affaires net = encaissé − remboursé', async () => {
    const s = await admin.get('/api/admin/stats?days=30');
    assert.equal(s.status, 200);
    const paid = ctx.db.prepare(`SELECT COALESCE(SUM(total_cents),0) n FROM orders WHERE payment_status != 'unpaid'`).get().n;
    const refunded = ctx.db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM refunds WHERE status = 'succeeded'`).get().n;
    assert.equal(s.body.totals.gross_cents, paid);
    assert.equal(s.body.totals.refunds_cents, refunded);
    assert.equal(s.body.totals.net_cents, paid - refunded);
    assert.equal(s.body.daily.length, 30);
    assert.ok(s.body.top_products.length >= 1);
    assert.ok(Array.isArray(s.body.low_stock));
  });

  test('paramètres : validation et application immédiate', async () => {
    assert.equal((await admin.put('/api/admin/settings').send({ premium_discount_percent: 95 })).status, 400);
    const r = await admin.put('/api/admin/settings').send({ shop_name: 'HADRISHOP', premium_price_cents: 699, materials: ['PLA', 'PETG'] });
    assert.equal(r.status, 200);
    const cfg = await request(ctx.app).get('/api/config');
    assert.equal(cfg.body.premium.price_cents, 699);
    assert.deepEqual(cfg.body.materials, ['PLA', 'PETG']);
    const audit = (await admin.get('/api/admin/audit')).body;
    assert.ok(audit.some((a) => a.action === 'settings_update'));
  });

  test('commande en attente annulée par le client : stock libéré et session expirée', async () => {
    const p = await createProduct(admin, { name: 'Annul', variants: [{ sku: 'AN-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal((await c.post(`/api/me/orders/${r.body.number}/cancel`)).status, 200);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM reservations WHERE variant_id = ? AND status = 'active'`).get(p.variants[0].id).n, 0);
  });
});
