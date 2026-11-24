'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, createUser, createProduct, sendWebhook, completedSession, key, addZone, ADDRESS } = require('./helpers');

describe('Panier, réservation de stock et paiement Stripe', () => {
  let ctx, admin, pickup, local;
  before(async () => {
    ctx = setup();
    admin = await createUser(ctx, { role: 'admin', email: 'admin@test.be' });
    pickup = await addZone(admin, { name: 'Retrait à l’atelier', kind: 'pickup', price_cents: 0 });
    local = await addZone(admin, { name: 'Livraison Bruxelles', kind: 'postal', postal_codes: '1000-1210', price_cents: 590, free_above_cents: 6000 });
  });
  after(() => ctx.db.close());

  test('le devis calcule sous-total, livraison et total côté serveur', async () => {
    const p = await createProduct(admin, { name: 'Devis', variants: [{ sku: 'Q-1', name: 'S', price_cents: 1250, stock: 5 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, postal_code: '1050' });
    assert.equal(r.status, 200);
    assert.equal(r.body.subtotal_cents, 2500);
    assert.equal(r.body.shipping_cents, 590);
    assert.equal(r.body.total_cents, 3090);
    const far = await c.post('/api/cart/quote').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, postal_code: '4000' });
    assert.equal(far.body.errors[0].code, 'shipping_ineligible');
  });

  test('checkout : commande, réservation 15 min et session Stripe aux bons montants', async () => {
    const p = await createProduct(admin, { name: 'Lampe', variants: [{ sku: 'L-1', name: 'Blanche', price_cents: 2000, stock: 3 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: local.id, address: { ...ADDRESS, postal_code: '1040' }, checkoutKey: key() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\//);
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.status, 'pending_payment');
    assert.equal(o.total_cents, 4590);
    const expiresIn = o.reservation_expires_at - Math.floor(Date.now() / 1000);
    assert.ok(expiresIn > 14 * 60 && expiresIn <= 15 * 60, `réservation de 15 min (reste ${expiresIn}s)`);
    const res = ctx.db.prepare('SELECT * FROM reservations WHERE order_id = ?').all(o.id);
    assert.deepEqual(res.map((x) => [x.qty, x.status]), [[2, 'active']]);
    const call = ctx.fakeStripe.calls.filter((x) => x[0] === 'checkout.sessions.create').pop();
    const params = call[1];
    assert.equal(params.mode, 'payment');
    assert.equal(params.line_items[0].price_data.unit_amount, 2000);
    assert.equal(params.line_items[0].quantity, 2);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 590);
    assert.equal(params.metadata.order_id, String(o.id));
    assert.ok(params.expires_at - Math.floor(Date.now() / 1000) >= 30 * 60, 'expires_at ≥ 30 min (minimum Stripe)');
    assert.equal(call[2].idempotencyKey, `checkout-order-${o.id}`);
    assert.ok(!('payment_method_types' in params), 'paramètre supprimé dans l’API Endive');
    // Le stock disponible publié tient compte de la réservation
    const pub = await request(ctx.app).get('/api/products/' + p.slug);
    assert.equal(pub.body.variants[0].available, 1);
  });

  test('aucune survente : 12 paiements simultanés pour 5 articles → exactement 5 réservations', async () => {
    const p = await createProduct(admin, { name: 'Edition limitée', variants: [{ sku: 'LIM-1', name: 'Unique', price_cents: 3000, stock: 5 }] });
    const users = await Promise.all(Array.from({ length: 12 }, () => createUser(ctx)));
    const results = await Promise.all(users.map((u) => u.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() })));
    const ok = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 409 && r.body.code === 'insufficient_stock').length;
    assert.equal(ok, 5);
    assert.equal(refused, 7);
    const reserved = ctx.db.prepare(`SELECT SUM(qty) n FROM reservations WHERE variant_id = ? AND status = 'active'`).get(p.variants[0].id).n;
    assert.equal(reserved, 5);
  });

  test('double clic : même clé de paiement → même session, aucune seconde commande', async () => {
    const p = await createProduct(admin, { name: 'Double clic', variants: [{ sku: 'DC-1', name: 'X', price_cents: 1000, stock: 10 }] });
    const c = await createUser(ctx);
    const k = key();
    const body = { items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: k };
    const a = await c.post('/api/checkout').send(body);
    const b = await c.post('/api/checkout').send(body);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.url, b.body.url);
    assert.equal(b.body.reused, true);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM orders WHERE user_id = ?').get(c.user.id).n, 1);
  });

  test('une nouvelle tentative annule la précédente et libère son stock', async () => {
    const p = await createProduct(admin, { name: 'Retente', variants: [{ sku: 'RT-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const first = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: pickup.id, checkoutKey: key() });
    const second = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 2 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const o1 = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(first.body.number);
    assert.equal(o1.status, 'cancelled');
    assert.ok(ctx.fakeStripe.calls.some((x) => x[0] === 'checkout.sessions.expire' && x[1] === o1.stripe_session_id));
  });

  test('paiement confirmé par webhook signé : stock décrémenté une seule fois malgré un webhook dupliqué', async () => {
    const p = await createProduct(admin, { name: 'Support', variants: [{ sku: 'SUP-1', name: 'Noir', price_cents: 1800, stock: 4 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 3 }], shippingZoneId: pickup.id, checkoutKey: key() });
    const session = completedSession(ctx, r.body.number);
    const w1 = await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_1' });
    assert.equal(w1.status, 200);
    const w2 = await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_1' });
    assert.equal(w2.body.duplicate, true);
    const w3 = await sendWebhook(ctx, 'checkout.session.completed', session, { eventId: 'evt_dup_2' }); // même session, autre événement
    assert.equal(w3.status, 200);
    const v = ctx.db.prepare('SELECT stock FROM variants WHERE id = ?').get(p.variants[0].id);
    assert.equal(v.stock, 1);
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.status, 'paid'); assert.equal(o.payment_status, 'paid');
    assert.equal(o.stripe_payment_intent, session.payment_intent);
    const mails = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'order_paid' AND to_addr = ?`).all(c.user.email);
    assert.equal(mails.length, 1, 'un seul e-mail de confirmation');
    const det = await c.get('/api/me/orders/' + r.body.number);
    assert.equal(det.body.status_label, 'Payée');
  });

  test('webhook à signature invalide ou absente : refusé (400) et sans effet', async () => {
    const p = await createProduct(admin, { name: 'Pirate', variants: [{ sku: 'PIR-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    const bad = await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number), { secret: 'whsec_mauvais' });
    assert.equal(bad.status, 400);
    const none = await request(ctx.app).post('/api/stripe/webhook').set('Content-Type', 'application/json').send(JSON.stringify({ type: 'checkout.session.completed' }));
    assert.equal(none.status, 400);
    assert.equal(ctx.db.prepare('SELECT payment_status FROM orders WHERE number = ?').get(r.body.number).payment_status, 'unpaid');
  });

  test('expiration après 15 min : stock libéré et session Stripe expirée', async () => {
    const p = await createProduct(admin, { name: 'Expire', variants: [{ sku: 'EXP-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    ctx.db.prepare('UPDATE orders SET reservation_expires_at = ? WHERE number = ?').run(Math.floor(Date.now() / 1000) - 1, r.body.number);
    ctx.db.prepare('UPDATE reservations SET expires_at = ? WHERE order_id = (SELECT id FROM orders WHERE number = ?)').run(Math.floor(Date.now() / 1000) - 1, r.body.number);
    await ctx.runJobs();
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.status, 'expired');
    assert.equal(ctx.db.prepare(`SELECT status FROM reservations WHERE order_id = ?`).get(o.id).status, 'released');
    assert.ok(ctx.fakeStripe.calls.some((x) => x[0] === 'checkout.sessions.expire' && x[1] === o.stripe_session_id));
    const other = await createUser(ctx);
    const r2 = await other.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r2.status, 200, 'le stock est de nouveau disponible');
  });

  test('paiement arrivé après expiration, stock encore libre → commande honorée', async () => {
    const p = await createProduct(admin, { name: 'Tardif OK', variants: [{ sku: 'TOK-1', name: 'X', price_cents: 1000, stock: 2 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    ctx.shop.markExpired(o.id);
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number));
    const after = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    assert.equal(after.status, 'paid');
    assert.equal(ctx.db.prepare('SELECT stock FROM variants WHERE id = ?').get(p.variants[0].id).stock, 1);
  });

  test('paiement arrivé après expiration, stock vendu entre-temps → annulation + remboursement automatique, jamais de stock négatif', async () => {
    const p = await createProduct(admin, { name: 'Tardif KO', variants: [{ sku: 'TKO-1', name: 'X', price_cents: 1500, stock: 1 }] });
    const a = await createUser(ctx), b = await createUser(ctx);
    const ra = await a.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    const oa = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(ra.body.number);
    ctx.shop.markExpired(oa.id);
    const rb = await b.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, rb.body.number));
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, ra.body.number)); // A paie trop tard
    const after = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(oa.id);
    assert.equal(after.status, 'cancelled');
    assert.equal(after.payment_status, 'refunded');
    assert.equal(ctx.db.prepare('SELECT stock FROM variants WHERE id = ?').get(p.variants[0].id).stock, 0);
    const refundCall = ctx.fakeStripe.calls.filter((x) => x[0] === 'refunds.create').pop();
    assert.equal(refundCall[1].amount, 1500);
    assert.equal(refundCall[1].payment_intent, `pi_test_${oa.id}`);
    assert.ok(ctx.db.prepare(`SELECT 1 FROM emails WHERE kind = 'oos_refund' AND to_addr = ?`).get(a.user.email));
  });

  test('la base refuse physiquement tout stock négatif (contrainte CHECK)', () => {
    const v = ctx.db.prepare('SELECT id FROM variants LIMIT 1').get();
    assert.throws(() => ctx.db.prepare('UPDATE variants SET stock = -1 WHERE id = ?').run(v.id), /CHECK constraint failed/);
  });

  test('paiement différé (SEPA) : stock conservé puis libéré si échec', async () => {
    const p = await createProduct(admin, { name: 'SEPA', variants: [{ sku: 'SEPA-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number, { payment_status: 'unpaid' }));
    let o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.status, 'payment_processing');
    await ctx.runJobs(); // ne doit pas expirer
    assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'payment_processing');
    await sendWebhook(ctx, 'checkout.session.async_payment_failed', completedSession(ctx, r.body.number, { payment_status: 'unpaid' }));
    o = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    assert.equal(o.status, 'payment_failed');
    assert.equal(ctx.db.prepare('SELECT status FROM reservations WHERE order_id = ?').get(o.id).status, 'released');
  });

  test('montant Stripe différent du total : signalé dans l’historique', async () => {
    const p = await createProduct(admin, { name: 'Ecart', variants: [{ sku: 'ECA-1', name: 'X', price_cents: 1000, stock: 3 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number, { amount_total: 1 }));
    const ev = ctx.db.prepare(`SELECT message FROM order_events WHERE type = 'paid' AND order_id = (SELECT id FROM orders WHERE number = ?)`).get(r.body.number);
    assert.match(ev.message, /ATTENTION/);
  });

  test('codes promo : pourcentage, montant fixe, minimum, limites globale et par client', async () => {
    const p = await createProduct(admin, { name: 'Promo', variants: [{ sku: 'PR-1', name: 'X', price_cents: 2000, stock: 50 }] });
    const vid = p.variants[0].id;
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'DIX', type: 'percent', value: 10 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'CINQ', type: 'fixed', value: 500, min_subtotal_cents: 3000 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'UNE', type: 'percent', value: 20, max_uses: 1 })).status, 201);
    assert.equal((await admin.post('/api/admin/promos').send({ code: 'TROP', type: 'percent', value: 150 })).status, 400);
    const c = await createUser(ctx);
    let q = await c.post('/api/cart/quote').send({ items: [{ variantId: vid, qty: 2 }], promoCode: 'dix', shippingZoneId: pickup.id });
    assert.equal(q.body.promo_discount_cents, 400); assert.equal(q.body.total_cents, 3600);
    q = await c.post('/api/cart/quote').send({ items: [{ variantId: vid, qty: 1 }], promoCode: 'CINQ', shippingZoneId: pickup.id });
    assert.match(q.body.promo_error, /minimum/i);
    q = await c.post('/api/cart/quote').send({ items: [{ variantId: vid, qty: 2 }], promoCode: 'CINQ', shippingZoneId: pickup.id });
    assert.equal(q.body.promo_discount_cents, 500);
    q = await c.post('/api/cart/quote').send({ items: [{ variantId: vid, qty: 1 }], promoCode: 'INEXISTANT', shippingZoneId: pickup.id });
    assert.equal(q.body.promo_error, 'Code promo invalide');
    // Le code UNE est consommé par une commande en attente (réservé) puis payée
    const r = await c.post('/api/checkout').send({ items: [{ variantId: vid, qty: 1 }], promoCode: 'UNE', shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r.status, 200);
    const coupon = ctx.fakeStripe.calls.filter((x) => x[0] === 'coupons.create').pop()[1];
    assert.equal(coupon.amount_off, 400); assert.equal(coupon.duration, 'once'); assert.equal(coupon.max_redemptions, 1);
    const d = await createUser(ctx);
    const r2 = await d.post('/api/checkout').send({ items: [{ variantId: vid, qty: 1 }], promoCode: 'UNE', shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r2.status, 409); assert.equal(r2.body.code, 'promo_invalid');
  });

  test('vérification d’e-mail obligatoire avant de payer', async () => {
    const p = await createProduct(admin, { name: 'Verif', variants: [{ sku: 'VER-1', name: 'X', price_cents: 1000, stock: 3 }] });
    const c = await createUser(ctx, { verified: false });
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r.status, 403);
  });

  test('montant minimum Stripe (0,50 €) et articles inactifs refusés', async () => {
    const p = await createProduct(admin, { name: 'Mini', variants: [{ sku: 'MIN-1', name: 'X', price_cents: 20, stock: 3 }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r.status, 400);
    await admin.put('/api/admin/products/' + p.id).send({ name: 'Mini', type: 'physical', active: false, variants: [{ id: p.variants[0].id, sku: 'MIN-1', name: 'X', price_cents: 2000, stock: 3 }] });
    const r2 = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    assert.equal(r2.status, 409);
  });

  test('Stripe indisponible : commande annulée, réservation libérée, rien n’est prélevé', async () => {
    const p = await createProduct(admin, { name: 'Panne', variants: [{ sku: 'PAN-1', name: 'X', price_cents: 1000, stock: 1 }] });
    const c = await createUser(ctx);
    ctx.fakeStripe.state.fail.checkout = 'API down';
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty: 1 }], shippingZoneId: pickup.id, checkoutKey: key() });
    delete ctx.fakeStripe.state.fail.checkout;
    assert.equal(r.status, 502);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM reservations WHERE variant_id = ? AND status = 'active'`).get(p.variants[0].id).n, 0);
  });

  test('livraison par rayon de 30 km autour de l’atelier', async () => {
    const z = await addZone(admin, { name: 'Rayon 30 km', kind: 'radius', radius_km: 30, price_cents: 490 });
    await admin.put('/api/admin/shipping/origin').send({ lat: 50.8467, lng: 4.3525 }); // Bruxelles (exemple)
    await admin.post('/api/admin/shipping/postcodes').send({ code: '1300', lat: 50.7167, lng: 4.6167 });  // Wavre ≈ 23 km
    await admin.post('/api/admin/shipping/postcodes').send({ code: '4000', lat: 50.6333, lng: 5.5667 });  // Liège ≈ 88 km
    const near = await request(ctx.app).post('/api/shipping/options').set('X-Hadrishop', '1').send({ postal_code: '1300' });
    const far = await request(ctx.app).post('/api/shipping/options').set('X-Hadrishop', '1').send({ postal_code: '4000' });
    const unknown = await request(ctx.app).post('/api/shipping/options').set('X-Hadrishop', '1').send({ postal_code: '9999' });
    const pick = (res) => res.body.find((x) => x.id === z.id);
    assert.equal(pick(near).eligible, true); assert.ok(pick(near).distance_km > 20 && pick(near).distance_km < 30);
    assert.equal(pick(far).eligible, false);
    assert.equal(pick(unknown).eligible, false);
    assert.equal(near.body.find((x) => x.kind === 'pickup').eligible, true);
  });

  test('import GeoNames des codes postaux (format tabulé)', () => {
    const line = (code, lat, lng) => ['BE', code, 'Lieu', 'R', 'BRU', '', '', '', '', lat, lng, '4'].join('\t');
    const n = ctx.geo.importText([line('1050', 50.82, 4.37), line('1050', 50.84, 4.39), 'garbage', line('ABCD', 1, 1)].join('\n'));
    assert.equal(n, 1);
    const row = ctx.db.prepare('SELECT * FROM postcodes WHERE code = ?').get('1050');
    assert.ok(Math.abs(row.lat - 50.83) < 1e-9);
  });
});
