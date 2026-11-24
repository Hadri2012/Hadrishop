'use strict';
// Webhook Stripe : signature vérifiée sur le corps brut, événements dédoublonnés par identifiant,
// traitements idempotents (chaque étape vérifie l'état avant d'agir).
const { now } = require('../lib/util');

function makeWebhookHandler({ db, cfg, stripe, shop, premium, log = console }) {
  function orderIdFrom(obj) {
    const id = Number((obj.metadata && obj.metadata.order_id) || obj.client_reference_id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  async function handle(event) {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode === 'subscription') {
          const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id;
          if (subId) await premium.syncFromStripe(subId);
          return;
        }
        const id = orderIdFrom(obj); if (!id) return;
        if (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required') await shop.markPaid(id, obj);
        else shop.markProcessing(id); // moyen de paiement différé (ex. prélèvement SEPA)
        return;
      }
      case 'checkout.session.async_payment_succeeded': { const id = orderIdFrom(obj); if (id) await shop.markPaid(id, obj); return; }
      case 'checkout.session.async_payment_failed': { const id = orderIdFrom(obj); if (id) shop.markPaymentFailed(id); return; }
      case 'checkout.session.expired': {
        if (obj.mode === 'subscription') { db.prepare('UPDATE users SET premium_checkout_session_id = NULL WHERE premium_checkout_session_id = ?').run(obj.id); return; }
        const id = orderIdFrom(obj); if (id) shop.markExpired(id); return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        if (obj.metadata && obj.metadata.kind && obj.metadata.kind !== 'premium') return;
        if (event.type === 'customer.subscription.deleted') premium.applySubscription(obj);
        else await premium.syncFromStripe(obj.id);
        return;
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        shop.syncStripeRefund(obj); return;
      case 'charge.refunded': {
        // Rattrapage : remboursements effectués hors de l'application (Dashboard Stripe)
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id;
        if (!pi) return;
        const list = await stripe.refunds.list({ payment_intent: pi, limit: 100 });
        for (const r of list.data) shop.syncStripeRefund(r);
        return;
      }
      default: return; // événement non utilisé
    }
  }

  // Middleware Express (doit recevoir le corps brut : express.raw)
  return async function webhook(req, res) {
    let event;
    try {
      if (!cfg.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET manquant');
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], cfg.stripeWebhookSecret);
    } catch (e) {
      log.warn('[webhook] signature refusée :', e.message);
      return res.status(400).json({ error: 'Signature invalide' });
    }
    const prev = db.prepare('SELECT status FROM stripe_events WHERE id = ?').get(event.id);
    if (prev && (prev.status === 'processed' || prev.status === 'processing')) return res.json({ received: true, duplicate: true });
    if (prev) db.prepare(`UPDATE stripe_events SET status = 'processing', error = NULL WHERE id = ?`).run(event.id);
    else {
      const ins = db.prepare(`INSERT OR IGNORE INTO stripe_events(id, type, status, received_at) VALUES (?,?, 'processing', ?)`).run(event.id, event.type, now());
      if (!ins.changes) return res.json({ received: true, duplicate: true });
    }
    try {
      await handle(event);
      db.prepare(`UPDATE stripe_events SET status = 'processed' WHERE id = ?`).run(event.id);
      res.json({ received: true });
    } catch (e) {
      log.error('[webhook] échec', event.type, e);
      db.prepare(`UPDATE stripe_events SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message).slice(0, 500), event.id);
      res.status(500).json({ error: 'Traitement échoué, Stripe réessaiera' });
    }
  };
}

module.exports = { makeWebhookHandler };
