'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { setup, createUser, createProduct, sendWebhook, completedSession, key, addZone, D } = require('./helpers');

describe('Remboursements (Firestore)', () => {
  let ctx, admin, pickup;
  before(async () => { ctx = setup(); admin = await createUser(ctx, { role: 'admin' }); pickup = await addZone(admin, { name: 'Retrait', kind: 'pickup', price_cents: 0 }); });

  async function paidOrder(qty = 2, price = 2500, stock = 5) {
    const p = await createProduct(admin, { name: 'R' + key(), variants: [{ sku: 'R-' + key(), name: 'X', price_cents: price, stock }] });
    const c = await createUser(ctx);
    const r = await c.post('/api/checkout').send({ items: [{ variantId: p.variants[0].id, qty }], shippingZoneId: pickup.id, checkoutKey: key() });
    await sendWebhook(ctx, 'checkout.session.completed', await completedSession(ctx, r.body.number));
    const o = await D.order(ctx, r.body.number);
    assert.equal(o.payment_status, 'paid');
    return { o, p, c };
  }

  test('partiel puis solde avec remise en stock', async () => {
    const { o, p } = await paidOrder(2, 2500, 5);
    assert.equal((await D.variant(ctx, p.variants[0].id)).stock, 3);
    let r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000, reason: 'Geste' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.payment_status, r.body.refunded_cents, r.body.refundable_cents], ['partially_refunded', 1000, 4000]);
    assert.equal((await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000, restock: true })).status, 400);
    r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 4000, restock: true });
    assert.equal(r.body.payment_status, 'refunded'); assert.equal(r.body.status, 'cancelled');
    assert.equal((await D.variant(ctx, p.variants[0].id)).stock, 5);
    assert.deepEqual(ctx.fakeStripe.calls.filter((x) => x[0] === 'refunds.create' && x[1].payment_intent === o.stripe_payment_intent).map((x) => x[1].amount), [1000, 4000]);
    assert.equal((await D.emails(ctx, o.email, 'refund')).length, 2);
  });

  test('jamais plus que le montant payé', async () => {
    const { o } = await paidOrder(1, 1500);
    const r = await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1501 });
    assert.equal(r.status, 400); assert.match(r.body.error, /15,00/);
  });

  test('remboursements simultanés : total plafonné', async () => {
    const { o } = await paidOrder(1, 3000);
    const results = await Promise.all(Array.from({ length: 5 }, () => admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 1000 })));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    const after = await D.orderById(ctx, o.id);
    assert.equal(after.refunds.filter((x) => x.status === 'succeeded').reduce((a, x) => a + x.amount_cents, 0), 3000);
  });

  test('refus Stripe : marqué échoué, montant à nouveau remboursable', async () => {
    const { o } = await paidOrder(1, 2000);
    ctx.fakeStripe.state.fail.refunds = 'charge_already_refunded';
    assert.equal((await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2000 })).status, 502);
    delete ctx.fakeStripe.state.fail.refunds;
    assert.equal((await D.orderById(ctx, o.id)).refunds[0].status, 'failed');
    assert.equal((await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2000 })).status, 201);
  });

  test('remboursement en attente confirmé par refund.updated (une seule fois)', async () => {
    const { o } = await paidOrder(1, 2200);
    ctx.fakeStripe.state.refundStatus = 'pending';
    await admin.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 2200 });
    delete ctx.fakeStripe.state.refundStatus;
    const ref = (await D.orderById(ctx, o.id)).refunds[0];
    assert.equal(ref.status, 'pending');
    const obj = { id: ref.stripe_refund_id, object: 'refund', status: 'succeeded', amount: 2200, payment_intent: o.stripe_payment_intent, metadata: { order_id: o.id, refund_id: ref.id } };
    await sendWebhook(ctx, 'refund.updated', obj); await sendWebhook(ctx, 'refund.updated', obj);
    const after = await D.orderById(ctx, o.id);
    assert.equal(after.payment_status, 'refunded'); assert.equal(after.refunded_cents, 2200);
    assert.equal((await D.emails(ctx, o.email, 'refund')).length, 1);
  });

  test('remboursement fait dans le Dashboard Stripe : rattrapé via charge.refunded', async () => {
    const { o } = await paidOrder(1, 1800);
    ctx.fakeStripe.state.refunds.push({ id: 're_dash_1', object: 'refund', status: 'succeeded', amount: 800, payment_intent: o.stripe_payment_intent, metadata: {} });
    await sendWebhook(ctx, 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: o.stripe_payment_intent, amount_refunded: 800 });
    const after = await D.orderById(ctx, o.id);
    assert.equal(after.payment_status, 'partially_refunded'); assert.equal(after.refunded_cents, 800);
  });

  test('demande client puis approbation admin ; accès croisé refusé', async () => {
    const { o, c } = await paidOrder(1, 2000);
    assert.equal((await c.post(`/api/me/orders/${o.number}/refund-request`).send({ reason: 'Pièce cassée à la livraison' })).status, 201);
    assert.equal((await c.post(`/api/me/orders/${o.number}/refund-request`).send({ reason: 'Encore une fois svp' })).status, 409);
    const rr = (await admin.get('/api/admin/refund-requests')).body.find((x) => x.order_id === o.id);
    assert.equal((await admin.post(`/api/admin/refund-requests/${rr.id}`).send({ action: 'approve', amount_cents: 2000 })).status, 200);
    const det = await c.get(`/api/me/orders/${o.number}`);
    assert.equal(det.body.payment_status, 'refunded'); assert.equal(det.body.refund_requests[0].status, 'approved');
    const intrus = await createUser(ctx);
    assert.equal((await intrus.post(`/api/admin/orders/${o.id}/refunds`).send({ amount_cents: 100 })).status, 403);
    assert.equal((await intrus.get(`/api/me/orders/${o.number}`)).status, 404);
  });
});
