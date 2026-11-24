'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, createProduct, sendWebhook, completedSession, key, addZone } = require('./helpers');

describe('Remboursements partiels et complets', () => {
  let ctx, admin, pickup;
  before(async () => {
    ctx = setup();
    admin = await createUser(ctx, { role: 'admin' });
    pickup = await addZone(admin, { name: 'Retrait', kind: 'pickup', price_cents: 0 });
  });
  after(() => ctx.db.close());

  async function paidOrder(qty = 2, price = 2500, stock = 5) {
    const p = await createProduct(admin, { name: 'R' + Math.random(), variants: [{ sku: 'R-' + key(), name: 'X', price_cents: price, stock }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty }], shippingZoneId: pickup.id, checkoutKey: key() });
    await sendWebhook(ctx, 'checkout.session.completed', completedSession(ctx, r.body.number));
    const o = ctx.db.prepare('SELECT * FROM orders WHERE number = ?').get(r.body.number);
    assert.equal(o.payment_status, 'paid');
    return { o, p, c };
  }

  test('remboursement partiel puis solde avec remise en stock', async () => {
    const { o, p } = await paidOrder(2, 2500, 5);
    assert.equal(ctx.db.prepare('SELECT stock FROM variants WHERE id = ?').get(p.variants[0].id).stock, 3);
    let r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000, reason: 'Geste commercial' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.payment_status, 'partially_refunded');
    assert.equal(r.body.refunded_cents, 1000);
    assert.equal(r.body.refundable_cents, 4000);
    // remise en stock refusée si ce n'est pas le solde
    r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000, restock: true });
    assert.equal(r.status, 400);
    r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 4000, restock: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.payment_status, 'refunded');
    assert.equal(r.body.status, 'cancelled');
    assert.equal(ctx.db.prepare('SELECT stock FROM variants WHERE id = ?').get(p.variants[0].id).stock, 5);
    const calls = ctx.fakeStripe.calls.filter((x) => x[0] === 'refunds.create' && x[1].payment_intent === o.stripe_payment_intent);
    assert.deepEqual(calls.map((x) => x[1].amount), [1000, 4000]);
    assert.ok(calls.every((x) => x[2].idempotencyKey.startsWith(`refund-${o.id}-`)));
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE kind = 'refund' AND to_addr = ?`).get(o.email).n, 2);
  });

  test('impossible de rembourser plus que le montant payé', async () => {
    const { o } = await paidOrder(1, 1500);
    const r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1501 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /15,00|15\.00/);
  });

  test('remboursements simultanés : jamais au-delà du montant payé', async () => {
    const { o } = await paidOrder(1, 3000);
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000 })));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(results.filter((r) => r.status === 400 || r.status === 409).length, 2);
    const total = ctx.db.prepare(`SELECT SUM(amount_cents) n FROM refunds WHERE order_id = ? AND status = 'succeeded'`).get(o.id).n;
    assert.equal(total, 3000);
  });

  test('refus Stripe : remboursement marqué échoué, montant de nouveau remboursable', async () => {
    const { o } = await paidOrder(1, 2000);
    ctx.fakeStripe.state.fail.refunds = 'charge_already_refunded';
    const r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2000 });
    delete ctx.fakeStripe.state.fail.refunds;
    assert.equal(r.status, 502);
    assert.equal(ctx.db.prepare('SELECT status FROM refunds WHERE order_id = ?').get(o.id).status, 'failed');
    const again = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2000 });
    assert.equal(again.status, 201);
  });

  test('remboursement en attente confirmé ensuite par webhook refund.updated (effets appliqués une seule fois)', async () => {
    const { o } = await paidOrder(1, 2200);
    ctx.fakeStripe.state.refundStatus = 'pending';
    const r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2200 });
    delete ctx.fakeStripe.state.refundStatus;
    assert.equal(r.body.payment_status, 'paid');
    const ref = ctx.db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(o.id);
    assert.equal(ref.status, 'pending');
    const obj = { id: ref.stripe_refund_id, object: 'refund', status: 'succeeded', amount: 2200, payment_intent: o.stripe_payment_intent, metadata: { refund_id: String(ref.id) } };
    await sendWebhook(ctx, 'refund.updated', obj);
    await sendWebhook(ctx, 'refund.updated', obj);
    const after = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    assert.equal(after.payment_status, 'refunded');
    assert.equal(after.refunded_cents, 2200);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM emails WHERE kind = 'refund' AND to_addr = ?`).get(o.email).n, 1);
  });

  test('remboursement fait depuis le Dashboard Stripe : rattrapé via charge.refunded', async () => {
    const { o } = await paidOrder(1, 1800);
    ctx.fakeStripe.state.refunds.push({ id: 're_dashboard_1', object: 'refund', status: 'succeeded', amount: 800, payment_intent: o.stripe_payment_intent, metadata: {} });
    await sendWebhook(ctx, 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: o.stripe_payment_intent, amount_refunded: 800 });
    const after = ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    assert.equal(after.payment_status, 'partially_refunded');
    assert.equal(after.refunded_cents, 800);
  });

  test('demande de remboursement du client puis approbation par l’admin', async () => {
    const { o, c } = await paidOrder(1, 2000);
    const req1 = await c.post(`/api/me/orders/${o.number}/refund-request`).send({ reason: 'Pièce cassée à la livraison' });
    assert.equal(req1.status, 201);
    const dup = await c.post(`/api/me/orders/${o.number}/refund-request`).send({ reason: 'Encore une fois svp' });
    assert.equal(dup.status, 409);
    const list = await admin.get('/api/admin/refund-requests');
    const rr = list.body.find((x) => x.order_id === o.id);
    const ok = await admin.post(`/api/admin/refund-requests/${rr.id}`).send({ action: 'approve', amount_cents: 2000 });
    assert.equal(ok.status, 200);
    const det = await c.get(`/api/me/orders/${o.number}`);
    assert.equal(det.body.payment_status, 'refunded');
    assert.equal(det.body.refund_requests[0].status, 'approved');
  });

  test('un client ne peut ni rembourser ni voir la commande d’un autre', async () => {
    const { o } = await paidOrder(1, 1000);
    const intrus = await createUser(ctx);
    assert.equal((await intrus.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 100 })).status, 403);
    assert.equal((await intrus.get(`/api/me/orders/${o.number}`)).status, 404);
    assert.equal((await intrus.post(`/api/me/orders/${o.number}/refund-request`).send({ reason: 'tentative frauduleuse' })).status, 404);
  });
});
