'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, createUser, createProduct, sendWebhook, completedSession, key, addZone, ADDRESS, D } = require('./helpers');

describe('Panier, réservation de stock et paiement Stripe (Firestore)', () => {
  let ctx, admin, pickup, local;
  before(async () => {
    ctx = setup();
    admin = await createUser(ctx, { role: 'admin', email: 'admin@test.be' });
    pickup = await addZone(admin, { name: 'Retrait à l’atelier', kind: 'pickup', price_cents: 0 });
    local = await addZone(admin, { name: 'Livraison Bruxelles', kind: 'postal', postal_codes: '1000-1210', price_cents: 590, free_above_cents: 6000 });
  });
  const buy = (c, vid, qty, extra = {}) => c.post('/api/checkout').send({ items: [{ variantId: vid, qty }], shippingZoneId: pickup.id, checkoutKey: key(), ...extra });

  test('devis calculé côté serveur', async () => {
    const p = await createProduct(admin, { name: 'Devis', variants: [{ sku: 'Q-1', name: 'S', price_cents: 1250, stock: 5 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, postal_code: '1050' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.subtotal_cents, r.body.shipping_cents, r.body.total_cents], [2500, 590, 3090]);
    const far = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, postal_code: '4000' });
    assert.equal(far.body.errors[0].code, 'shipping_ineligible');
  });

  test('checkout : réservation 15 min et session Stripe aux bons montants', async () => {
    const p = await createProduct(admin, { name: 'Lampe', variants: [{ sku: 'L-1', name: 'Blanche', price_cents: 2000, stock: 3 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, address: { ...ADDRESS, postal_code: '1040' }, checkoutKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = await D.order(ctx, r.body.number);
    assert.equal(o.status, 'pending_payment'); assert.equal(o.total_cents, 4590);
    const left = o.reservation_expires_at - Math.floor(Date.now() / 1000);
    assert.ok(left > 14 * 60 && left <= 15 * 60);
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 2);
    const call = ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop();
    assert.equal(call[1].line_items[0].price_data.unit_amount, 2000);
    assert.equal(call[1].shipping_options[0].shipping_rate_data.fixed_amount.amount, 590);
    assert.ok(call[1].expires_at - Math.floor(Date.now() / 1000) >= 30 * 60);
    assert.equal(call[2].idempotencyKey, `checkout-order-${o.id}`);
    assert.ok(!('payment_method_types' in call[1]));
    assert.equal((await request(ctx.app).get('/api/products/' + p.slug)).body.variants[0].available, 1);
  });

  test('aucune survente : 12 achats simultanés pour 5 articles → exactement 5', async () => {
    const p = await createProduct(admin, { name: 'Edition limitée', variants: [{ sku: 'LIM-1', name: 'Unique', price_cents: 3000, stock: 5 }] });
    const users = await Promise.all(Array.from({ length: 12 }, () => createUser(ctx)));
    const results = await Promise.all(users.map((u) => buy(u, p.variants[0].id, 1)));
    assert.equal(results.filter((r) => r.status === 200).length, 5);
    assert.equal(results.filter((r) => r.status === 409 && r.body.code === 'insufficient_stock').length, 7);
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 5);
  });

  test('double clic : même clé → même session, une seule commande', async () => {
    const p = await createProduct(admin, { name: 'Double clic', variants: [{ sku: 'DC-1', name: 'X', price_cents: 1000, stock: 10 }] });
    const c = await createUser(ctx);
    const body = { items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() };
    const a = await c.post('/api/checkout').send(body), b = await c.post('/api/checkout').send(body);
    assert.equal(a.body.url, b.body.url); assert.equal(b.body.reused, true);
    assert.equal((await D.all(ctx, 'orders')).filter((o) => o.uid === c.user.id).length, 1);
  });

  test('nouvelle tentative : la précédente est annulée et son stock libéré', async () => {
    const p = await createProduct(admin, { name: 'Retente', variants: [{ sku: 'RT-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const first = await buy(c, p.variants[0].id, 2);
    const second = await buy(c, p.variants[0].id, 2);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const o1 = await D.order(ctx, first.body.number);
    assert.equal(o1.status, 'cancelled');
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 2);
    assert.ok(ctx.fakeStripe.calls.some((x) => x[0] === 'checkout.sessions.expire' && x[1] === o1.stripe_session_id));
  });

  test('webhook signé : stock décrémenté une seule fois malgré les doublons', async () => {
    const p = await createProduct(admin, { name: 'Support', variants: [{ sku: 'SUP-1', name: 'Noir', price_cents: 1800, stock: 4 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 3);
    const session = await completedSession(ctx, r.body.number);
    assert.equal((await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_1' })).status, 200);
    assert.equal((await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_1' })).body.duplicate, true);
    assert.equal((await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_2' })).status, 200);
    assert.equal((await D.variant(ctx, p.variants[0].id)).stock, 1);
    const o = await D.order(ctx, r.body.number);
    assert.equal(o.status, 'paid'); assert.equal(o.stripe_payment_intent, session.payment_intent);
    assert.equal((await D.emails(ctx, c.user.email, 'order_paid')).length, 1);
    assert.equal((await c.get('/api/me/orders/' + r.body.number)).body.status_label, 'Payée');
  });

  test('webhook à signature invalide ou absente : refusé, sans effet', async () => {
    const p = await createProduct(admin, { name: 'Pirate', variants: [{ sku: 'PIR-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 1);
    assert.equal((await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number), { secret: 'whsec_mauvais' })).status, 400);
    assert.equal((await request(ctx.app).post('/api/stripe/webhook').set('Content-Type', 'application/json').send('{"type":"x"}')).status, 400);
    assert.equal((await D.order(ctx, r.body.number)).payment_status, 'unpaid');
  });

  test('expiration après 15 min : stock libéré, session Stripe expirée', async () => {
    const p = await createProduct(admin, { name: 'Expire', variants: [{ sku: 'EXP-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 1);
    const o = await D.order(ctx, r.body.number);
    await ctx.db.collection('orders').doc(o.id).update({ reservation_expires_at: Math.floor(Date.now() / 1000) - 1 });
    await ctx.runJobs();
    const after = await D.orderById(ctx, o.id);
    assert.equal(after.status, 'expired');
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 0);
    assert.ok(ctx.fakeStripe.calls.some((x) => x[0] === 'checkout.sessions.expire' && x[1] === o.stripe_session_id));
    assert.equal((await buy(await createUser(ctx), p.variants[0].id, 1)).status, 200);
  });

  test('paiement après expiration, stock encore libre → honoré', async () => {
    const p = await createProduct(admin, { name: 'Tardif OK', variants: [{ sku: 'TOK-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 1);
    const o = await D.order(ctx, r.body.number);
    await ctx.shop.markExpired(o.id);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number));
    assert.equal((await D.orderById(ctx, o.id)).status, 'paid');
    assert.equal((await D.variant(ctx, p.variants[0].id)).stock, 1);
  });

  test('paiement après expiration, stock vendu entre-temps → annulé et remboursé, jamais négatif', async () => {
    const p = await createProduct(admin, { name: 'Tardif KO', variants: [{ sku: 'TKO-1', name: 'X', price_cents: 1500, stock: 1 }] });
    const a = await createUser(ctx), b = await createUser(ctx);
    const ra = await buy(a, p.variants[0].id, 1);
    const oa = await D.order(ctx, ra.body.number);
    await ctx.shop.markExpired(oa.id);
    const rb = await buy(b, p.variants[0].id, 1);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, rb.body.number));
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, ra.body.number));
    const after = await D.orderById(ctx, oa.id);
    assert.equal(after.status, 'cancelled'); assert.equal(after.payment_status, 'refunded');
    assert.equal((await D.variant(ctx, p.variants[0].id)).stock, 0);
    const rc = ctx.fakeStripe.calls.filter((x) => x[0] === 'refunds.create').pop();
    assert.equal(rc[1].amount, 1500); assert.equal(rc[1].payment_intent, `pi_test_${oa.id}`);
    assert.equal((await D.emails(ctx, a.user.email, 'oos_refund')).length, 1);
  });

  test('paiement différé (SEPA) : stock conservé puis libéré si échec', async () => {
    const p = await createProduct(admin, { name: 'SEPA', variants: [{ sku: 'SEPA-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 1);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number, { payment_status: 'unpaid' }));
    const o = await D.order(ctx, r.body.number);
    assert.equal(o.status, 'payment_processing');
    await ctx.runJobs();
    assert.equal((await D.orderById(ctx, o.id)).status, 'payment_processing');
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 1);
    await sendWebhook(ctx, 'checkout.session.async_payment_failed', await completedSession(ctx, r.body.number, { payment_status: 'unpaid' }));
    assert.equal((await D.orderById(ctx, o.id)).status, 'payment_failed');
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 0);
  });

  test('montant Stripe différent : signalé dans l’historique', async () => {
    const p = await createProduct(admin, { name: 'Ecart', variants: [{ sku: 'ECA-1', name: 'X', price_cents: 1000, stock: 3 }] });
    const c = await createUser(ctx);
    const r = await buy(c, p.variants[0].id, 1);
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number, { amount_total: 1 }));
    assert.match((await D.order(ctx, r.body.number)).events.find((e) => e.type === 'paid').message, /ATTENTION/);
  });

  test('codes promo : %, fixe, minimum, limite globale réservée', async () => {
    const p = await createProduct(admin, { name: 'Promo', variants: [{ sku: 'PR-1', name: 'X', price_cents: 2000, stock: 50 }] });
    const vid = p.variants[0].id;
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'DIX', type: 'percent', value: 10 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'CINQ', type: 'fixed', value: 500, min_subtotal_cents: 3000 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'UNE', type: 'percent', value: 20, max_uses: 1 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'TROP', type: 'percent', value: 150 })).status, 400);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'dix', type: 'percent', value: 5 })).status, 409);
    const c = await createUser(ctx);
    const q = (code, qty) => c.post('/api/cart/quote').send({ items: [{ variantId: vid, qty }], promoCode: code, shippingZoneId: pickup.id });
    let r = await q('dix', 2); assert.equal(r.body.promo_discount_cents, 400); assert.equal(r.body.total_cents, 3600);
    assert.match((await q('CINQ', 1)).body.promo_error, /minimum/i);
    assert.equal((await q('CINQ', 2)).body.promo_discount_cents, 500);
    assert.equal((await q('NOPE', 1)).body.promo_error, 'Code promo invalide');
    r = await buy(c, vid, 1, { promoCode: 'UNE' });
    assert.equal(r.status, 200);
    const coupon = ctx.fakeStripe.calls.filter((x) => x[0] === 'coupons.create').pop()[1];
    assert.equal(coupon.amount_off, 400); assert.equal(coupon.duration, 'once');
    const d = await createUser(ctx);
    const r2 = await buy(d, vid, 1, { promoCode: 'UNE' });
    assert.equal(r2.status, 409); assert.equal(r2.body.code, 'promo_invalid');
  });

  test('vérification e-mail obligatoire, minimum 0,50 €, article inactif', async () => {
    const p = await createProduct(admin, { name: 'Mini', variants: [{ sku: 'MIN-1', name: 'X', price_cents: 20, stock: 3 }] });
    assert.equal((await buy(await createUser(ctx, { verified: false }), p.variants[0].id, 1)).status, 403);
    const c = await createUser(ctx);
    assert.equal((await buy(c, p.variants[0].id, 1)).status, 400);
    await admin.put('/api/admin/products/' + p.id).send({ name: 'Mini', type: 'physical', active: false, variants: [{ id: p.variants[0].id, sku: 'MIN-1', name: 'X', price_cents: 2000, stock: 3 }] });
    assert.equal((await buy(c, p.variants[0].id, 1)).status, 409);
  });

  test('Stripe indisponible : commande annulée, réservation libérée', async () => {
    const p = await createProduct(admin, { name: 'Panne', variants: [{ sku: 'PAN-1', name: 'X', price_cents: 1000, stock: 1 }] });
    ctx.fakeStripe.state.fail.checkout = 'API down';
    const r = await buy(await createUser(ctx), p.variants[0].id, 1);
    delete ctx.fakeStripe.state.fail.checkout;
    assert.equal(r.status, 502);
    assert.equal(await D.reservedQty(ctx, p.variants[0].id), 0);
  });

  test('livraison dans un rayon de 30 km', async () => {
    const z = await addZone(admin, { name: 'Rayon 30 km', kind: 'radius', radius_km: 30, price_cents: 490 });
    await admin.put('/api/admin/shipping/origin').send({ lat: 50.8467, lng: 4.3525 });
    await admin.post('/api/admin/shipping/postcodes').send({ code: '1300', lat: 50.7167, lng: 4.6167 });
    await admin.post('/api/admin/shipping/postcodes').send({ code: '4000', lat: 50.6333, lng: 5.5667 });
    const opt = async (pc) => (await request(ctx.app).post('/api/shipping/options').set('X-Hadrishop', '1').send({ postal_code: pc })).body;
    const near = (await opt('1300')).find((x) => x.id === z.id);
    assert.equal(near.eligible, true); assert.ok(near.distance_km > 20 && near.distance_km < 30);
    assert.equal((await opt('4000')).find((x) => x.id === z.id).eligible, false);
    assert.equal((await opt('9999')).find((x) => x.id === z.id).eligible, false);
  });

  test('import GeoNames (format tabulé)', async () => {
    const line = (code, lat, lng) => ['BE', code, 'Lieu', 'R', 'BRU', '', '', '', '', lat, lng, '4'].join('\t');
    assert.equal(await ctx.geo.importText([line('1050', 50.82, 4.37), line('1050', 50.84, 4.39), 'x', line('ABCD', 1, 1)].join('\n')), 1);
    const s = (await ctx.db.collection('postcodes').doc('1050').get()).data();
    assert.ok(Math.abs(s.lat - 50.83) < 1e-9);
  });
});
