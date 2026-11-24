'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, client, createUser, createProduct, sendWebhook, completedSession, key, addZone, ADDRESS, D } = require('./helpers');

const binaryStl = (n = 2) => { const b = Buffer.alloc(84 + 50 * n); b.write('hadrishop test', 0); b.writeUInt32LE(n, 80); return b; };

describe('Catalogue, STL, sur mesure, Premium, newsletter, adresses, stats (Firestore)', () => {
  let ctx, admin, pickup, brussels;
  before(async () => {
    ctx = setup();
    admin = await createUser(ctx, { role: 'admin' });
    pickup = await addZone(admin, { name: 'Retrait', kind: 'pickup', price_cents: 0 });
    brussels = await addZone(admin, { name: 'Bruxelles', kind: 'postal', postal_codes: '1000-1210', price_cents: 500 });
  });

  test('catalogue : catégories, recherche, inactifs masqués', async () => {
    const cat = (await admin.post('/api/admin/categories').send({ name: 'Déco maison' })).body;
    assert.equal(cat.slug, 'deco-maison');
    await createProduct(admin, { name: 'Vase spirale', category_id: cat.id, variants: [{ sku: 'VS-S', name: 'Petit', price_cents: 1900, stock: 3 }, { sku: 'VS-L', name: 'Grand', price_cents: 2900, stock: 0 }] });
    const hidden = await createProduct(admin, { name: 'Vase caché', category_id: cat.id });
    const h = await admin.put(`/api/admin/products/${hidden.id}`).send({ name: 'Vase caché', type: 'physical', active: false, variants: hidden.variants.map(({ reserved, ...v }) => v) });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const list = await request(ctx.app).get('/api/products').query({ category: 'deco-maison' });
    assert.deepEqual(list.body.items.map((p) => p.name), ['Vase spirale']);
    assert.equal(list.body.items[0].price_from_cents, 1900);
    assert.equal((await request(ctx.app).get('/api/products').query({ q: 'spirale' })).body.total, 1);
    const d = await request(ctx.app).get('/api/products/vase-spirale');
    assert.deepEqual(d.body.variants.map((v) => [v.name, v.available, v.in_stock]), [['Petit', 3, true], ['Grand', 0, false]]);
    assert.equal((await request(ctx.app).get('/api/products/vase-cache')).status, 404);
    assert.equal((await request(ctx.app).get('/api/categories')).body.find((c) => c.slug === 'deco-maison').count, 1);
  });

  test('admin : variantes, SKU unique, stock jamais négatif', async () => {
    const p = await createProduct(admin, { name: 'Organiseur', variants: [{ sku: 'ORG-A', name: 'A', price_cents: 1000, stock: 5 }, { sku: 'ORG-B', name: 'B', price_cents: 1200, stock: 5 }] });
    const upd = await admin.put(`/api/admin/products/${p.id}`).send({ name: 'Organiseur', type: 'physical', variants: [{ id: p.variants[0].id, sku: 'ORG-A', name: 'A+', price_cents: 1100, stock: 7 }, { sku: 'ORG-C', name: 'C', price_cents: 1500, stock: 2 }] });
    assert.equal(upd.status, 200); assert.deepEqual(upd.body.variants.map((v) => v.sku), ['ORG-A', 'ORG-C']);
    assert.equal((await admin.post('/api/admin/products').send({ name: 'Autre', type: 'physical', variants: [{ sku: 'org-a', name: 'x', price_cents: 1, stock: 1 }] })).status, 409);
    const vid = upd.body.variants[0].id;
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ delta: -10 })).status, 400);
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ delta: -2 })).body.stock, 5);
    assert.equal((await admin.post(`/api/admin/variants/${vid}/stock`).send({ set: 12 })).body.stock, 12);
  });

  test('fichiers STL : achat, téléchargements limités, révoqués après remboursement', async () => {
    await ctx.settings.set({ download_max_count: 2 });
    const p = await createProduct(admin, { name: 'Fichier STL dragon', type: 'digital', variants: [{ sku: 'STL-DRG', name: 'Licence personnelle', price_cents: 600, stock: null }] });
    assert.equal(p.variants[0].stock, null);
    assert.equal((await admin.post(`/api/admin/products/${p.id}/files`).attach('files', Buffer.from('pas un stl'), 'faux.stl')).status, 400);
    const up = await admin.post(`/api/admin/products/${p.id}/files`).attach('files', binaryStl(3), 'dragon.stl');
    assert.equal(up.status, 201);
    const c = await createUser(ctx);
    assert.equal((await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], checkoutKey: key() })).status, 409);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], checkoutKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop()[1].shipping_options, undefined);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number));
    const o = await D.order(ctx, r.body.number);
    assert.equal(o.status, 'completed');
    const dls = (await c.get('/api/me/downloads')).body;
    assert.equal(dls.length, 1);
    const d1 = await c.get(`/api/downloads/${dls[0].id}`);
    assert.equal(d1.status, 200); assert.match(d1.headers['content-disposition'], /dragon\.stl/); assert.equal(Number(d1.headers['content-length']), 84 + 150);
    assert.equal((await c.get(`/api/downloads/${dls[0].id}`)).status, 200);
    assert.equal((await c.get(`/api/downloads/${dls[0].id}`)).status, 403);
    assert.equal((await (await createUser(ctx)).get(`/api/downloads/${dls[0].id}`)).status, 404);
    assert.equal((await request(ctx.app).get(`/api/downloads/${dls[0].id}`)).status, 401);
    await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 600 });
    assert.equal((await ctx.db.collection('downloads').doc(dls[0].id).get()).data().revoked, true);
    assert.equal((await admin.delete(`/api/admin/products/${p.id}/files/${up.body[0].id}`)).status, 200);
  });

  test('commande personnalisée : fichier, devis, acceptation, paiement', async () => {
    const c = await createUser(ctx);
    const r = await c.post('/api/custom-requests').field('title', 'Pièce de rechange lave-vaisselle').field('description', 'Roulette cassée, je joins le modèle.')
      .field('quantity', '2').field('material', 'PETG').attach('files', binaryStl(1), 'roulette.stl');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await c.post('/api/custom-requests').field('title', 'Test').field('description', 'Fichier exécutable déguisé').field('quantity', '1').attach('files', Buffer.from('MZ\x90\x00'), 'virus.stl')).status, 400);
    assert.equal((await c.post(`/api/custom-requests/${r.body.id}/accept`).send({ shippingZoneId: pickup.id, checkoutKey: key() })).status, 409);
    const row = (await admin.get('/api/admin/custom-requests')).body.find((x) => x.id === r.body.id);
    assert.equal(row.files[0].original_name, 'roulette.stl');
    assert.equal((await admin.get(`/api/admin/custom-files/${row.id}/${row.files[0].id}`)).status, 200);
    assert.equal((await admin.post(`/api/admin/custom-requests/${r.body.id}/quote`).send({ quote_cents: 2400, quote_days: 3, quote_message: 'PETG noir.' })).status, 200);
    assert.equal((await D.emails(ctx, c.user.email, 'custom_quote')).length, 1);
    const acc = await c.post(`/api/custom-requests/${r.body.id}/accept`).send({ shippingZoneId: brussels.id, address: ADDRESS, checkoutKey: key() });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal((await D.order(ctx, acc.body.number)).total_cents, 2900);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, acc.body.number));
    const mine = (await c.get('/api/me/custom-requests')).body.find((x) => x.id === r.body.id);
    assert.equal(mine.status, 'paid'); assert.equal(mine.order_number, acc.body.number);
  });

  test('adresse : client dans la même zone, admin libre, e-mails envoyés', async () => {
    const p = await createProduct(admin, { name: 'Adresse' });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: brussels.id, address: ADDRESS, checkoutKey: key() });
    assert.equal((await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, postal_code: '1050' })).status, 409);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number));
    const ok = await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, line1: 'Avenue Louise 1', postal_code: '1050' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.ship_line1, 'Avenue Louise 1');
    assert.equal((await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, postal_code: '4000', city: 'Liège' })).status, 409);
    const o = await D.order(ctx, r.body.number);
    await admin.post(`/api/admin/orders/${o.id}/status`).send({ status: 'shipped', tracking_carrier: 'bpost', tracking_number: 'CD123', tracking_url: 'https://track.bpost.cloud/' });
    assert.equal((await c.patch(`/api/me/orders/${r.body.number}/address`).send({ ...ADDRESS, line1: 'Rue X 2' })).status, 409);
    assert.equal((await admin.patch(`/api/admin/orders/${o.id}/address`).send({ ...ADDRESS, postal_code: '4000', city: 'Liège' })).status, 200);
    assert.ok((await D.emails(ctx, c.user.email, 'address')).length >= 2);
    assert.match((await D.emails(ctx, c.user.email, 'order_status'))[0].text, /CD123/);
    assert.equal((await admin.post(`/api/admin/orders/${o.id}/status`).send({ status: 'shipped', tracking_url: 'javascript:alert(1)' })).status, 400);
  });

  test('Premium : abonnement Stripe, remise et livraison offerte, résiliation', async () => {
    const c = await createUser(ctx);
    assert.equal((await c.post('/api/premium/subscribe')).status, 200);
    assert.equal(ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop()[1].mode, 'subscription');
    assert.equal((await c.post('/api/premium/subscribe')).body.reused, true);
    const cus = (await ctx.db.collection('users').doc(c.user.id).get()).data().stripe_customer_id;
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    ctx.fakeStripe.state.subs.set('sub_1', { id: 'sub_1', object: 'subscription', status: 'active', customer: cus, cancel_at_period_end: false, metadata: { kind: 'premium', user_id: c.user.id }, items: { data: [{ current_period_end: end }] } });
    await sendWebhook(ctx, 'checkout.session.completed', { id: 'cs_sub', object: 'checkout.session', mode: 'subscription', subscription: 'sub_1', client_reference_id: c.user.id });
    assert.equal((await c.get('/api/me')).body.premium, true);
    const p = await createProduct(admin, { name: 'Premium test', variants: [{ sku: 'PT-1', name: 'X', price_cents: 3000, stock: 5 }] });
    const q = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: brussels.id, postal_code: '1000' });
    assert.deepEqual([q.body.premium_discount_cents, q.body.shipping_cents, q.body.total_cents], [300, 0, 2700]);
    const cancel = await c.post('/api/premium/cancel');
    assert.equal(cancel.body.premium_cancel_at_period_end, true); assert.equal(cancel.body.premium, true);
    ctx.fakeStripe.state.subs.get('sub_1').status = 'canceled';
    await sendWebhook(ctx, 'customer.subscription.deleted', ctx.fakeStripe.state.subs.get('sub_1'));
    assert.equal((await c.get('/api/me')).body.premium, false);
    assert.equal((await D.emails(ctx, c.user.email, 'premium')).length, 2);
    const ex = await createProduct(admin, { name: 'Exclusif', premium_only: true, variants: [{ sku: 'EXC-1', name: 'X', price_cents: 1000, stock: 5 }] });
    const rr = await c.post('/api/checkout').send({ items: [{ variantId: ex.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(rr.status, 409); assert.match(rr.body.error, /Premium/);
  });

  test('newsletter : double opt-in, désinscription en un clic, campagne aux confirmés', async () => {
    const anon = client(ctx);
    await anon.post('/api/newsletter/subscribe').send({ email: 'lecteur@test.be' });
    await anon.post('/api/newsletter/subscribe').send({ email: 'jamais@test.be' });
    const token = (await D.emails(ctx, 'lecteur@test.be', 'nl_confirm'))[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    assert.match((await request(ctx.app).get('/api/newsletter/confirm?token=' + token)).headers.location, /newsletter=ok/);
    const camp = await admin.post('/api/admin/newsletter/campaigns').send({ subject: 'Nouveautés de décembre', body: 'Bonjour,\n\nVoici nos nouvelles pièces.' });
    assert.equal((await admin.post(`/api/admin/newsletter/campaigns/${camp.body.id}/send`)).body.recipients, 1);
    assert.equal((await admin.post(`/api/admin/newsletter/campaigns/${camp.body.id}/send`)).status, 409);
    assert.match((await D.emails(ctx, 'lecteur@test.be', 'newsletter'))[0].text, /unsubscribe\?token=/);
    assert.equal((await request(ctx.app).post('/api/newsletter/unsubscribe').type('form').send({ token })).status, 200);
    assert.equal((await ctx.db.collection('newsletter').doc('lecteur@test.be').get()).data().status, 'unsubscribed');
    assert.equal((await D.emails(ctx, 'jamais@test.be', 'newsletter')).length, 0);
  });

  test('e-mails envoyés par SMTP (transport de test)', async () => {
    const before = ctx.sent.length;
    await ctx.mailer.processQueue(500);
    assert.ok(ctx.sent.length > before);
    assert.equal((await D.all(ctx, 'emails')).filter((m) => m.status === 'queued').length, 0);
  });

  test('tableau de bord : net = encaissé − remboursé', async () => {
    const s = await admin.get('/api/admin/stats?days=30');
    assert.equal(s.status, 200);
    const orders = (await D.all(ctx, 'orders')).filter((o) => o.payment_status !== 'unpaid');
    const refunded = (await D.all(ctx, 'refund_log')).reduce((a, r) => a + r.amount_cents, 0);
    assert.equal(s.body.totals.gross_cents, orders.reduce((a, o) => a + o.total_cents, 0));
    assert.equal(s.body.totals.refunds_cents, refunded);
    assert.equal(s.body.daily.length, 30);
    assert.ok(s.body.top_products.length >= 1);
  });

  test('paramètres validés et journalisés ; annulation client libère le stock', async () => {
    assert.equal((await admin.put('/api/admin/settings').send({ premium_discount_percent: 95 })).status, 400);
    assert.equal((await admin.put('/api/admin/settings').send({ premium_price_cents: 699, materials: ['PLA', 'PETG'] })).status, 200);
    const cfg = await request(ctx.app).get('/api/config');
    assert.equal(cfg.body.premium.price_cents, 699); assert.deepEqual(cfg.body.materials, ['PLA', 'PETG']);
    assert.ok((await admin.get('/api/admin/audit')).body.some((a) => a.action === 'settings_update'));
    const p = await createProduct(admin, { name: 'Annul', variants: [{ sku: 'AN-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal((await c.post(`/api/me/orders/${r.body.number}/cancel`)).status, 200);
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 0);
  });

  test('toutes les vues admin répondent', async () => {
    for (const u of ['/api/admin/orders', '/api/admin/products', '/api/admin/categories', '/api/admin/promos', '/api/admin/shipping', '/api/admin/custom-requests',
      '/api/admin/refund-requests', '/api/admin/customers', '/api/admin/newsletter', '/api/admin/emails', '/api/admin/settings', '/api/admin/audit', '/api/admin/stripe-events']) {
      assert.equal((await admin.get(u)).status, 200, u);
    }
  });
});
