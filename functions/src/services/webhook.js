'use strict';
// Webhook Stripe : signature vérifiée sur le corps brut (req.rawBody fourni par Cloud Functions),
// dédoublonnage par identifiant d'événement, traitements idempotents.
const { now } = require('../lib/util');

function makeWebhookHandler({ db, cfg, stripe, shop, premium, log = console }) {
  const events = db.collection('stripe_events');
  const orderIdFrom = (o) => (o.metadata && o.metadata.order_id) || o.client_reference_id || null;

  async function handle(event) {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode === 'subscription') { const sid = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id; if (sid) await premium.syncFromStripe(sid); return; }
        const id = orderIdFrom(obj); if (!id) return;
        if (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required') await shop.markPaid(id, obj); else await shop.markProcessing(id);
        return;
      }
      case 'checkout.session.async_payment_succeeded': { const id = orderIdFrom(obj); if (id) await shop.markPaid(id, obj); return; }
      case 'checkout.session.async_payment_failed': { const id = orderIdFrom(obj); if (id) await shop.markPaymentFailed(id); return; }
      case 'checkout.session.expired': { if (obj.mode === 'subscription') return; const id = orderIdFrom(obj); if (id) await shop.markExpired(id); return; }
      case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted':
        if (obj.metadata && obj.metadata.kind && obj.metadata.kind !== 'premium') return;
        if (event.type === 'customer.subscription.deleted') await premium.applySubscription(obj); else await premium.syncFromStripe(obj.id);
        return;
      case 'refund.created': case 'refund.updated': case 'refund.failed': await shop.syncStripeRefund(obj); return;
      case 'charge.refunded': {
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id;
        if (!pi) return;
        for (const r of (await stripe.refunds.list({ payment_intent: pi, limit: 100 })).data) await shop.syncStripeRefund(r);
        return;
      }
      default: return;
    }
  }

  return async function webhook(req, res) {
    let event;
    try {
      if (!cfg.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET manquant');
      event = stripe.webhooks.constructEvent(req.rawBody || req.body, req.headers['stripe-signature'], cfg.stripeWebhookSecret);
    } catch (e) { log.warn('[webhook] signature refusée :', e.message); return res.status(400).json({ error: 'Signature invalide' }); }
    const ref = events.doc(event.id);
    const claimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && ['processed', 'processing'].includes(s.data().status)) return false;
      tx.set(ref, { type: event.type, status: 'processing', error: null, received_at: now() });
      return true;
    });
    if (!claimed) return res.json({ received: true, duplicate: true });
    try {
      await handle(event);
      await ref.update({ status: 'processed' });
      res.json({ received: true });
    } catch (e) {
      log.error('[webhook] échec', event.type, e);
      await ref.update({ status: 'failed', error: String(e.message).slice(0, 500) });
      res.status(500).json({ error: 'Traitement échoué, Stripe réessaiera' });
    }
  };
}

module.exports = { makeWebhookHandler };
