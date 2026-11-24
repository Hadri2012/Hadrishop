'use strict';
// Abonnement Premium : Stripe Checkout en mode « subscription ». L'état local est toujours
// resynchronisé depuis l'objet Subscription récupéré chez Stripe (robuste à l'ordre des webhooks).
const { now, bad, conflict, HttpError } = require('../lib/util');
const { getSettings } = require('../lib/settings');

function periodEnd(sub) {
  const items = (sub.items && sub.items.data) || [];
  const ends = items.map((i) => i.current_period_end).filter(Boolean);
  if (ends.length) return Math.max(...ends);
  return sub.current_period_end || null; // anciennes versions d'API
}

function makePremium({ db, cfg, stripe, shop, mailer }) {
  async function subscribe(user) {
    const s = getSettings(db);
    if (!s.premium_enabled) throw bad('Le programme Premium est désactivé');
    if (shop.isPremium(user)) throw conflict('Votre abonnement Premium est déjà actif');
    if (s.require_email_verification && !user.email_verified_at) throw new HttpError(403, 'Confirmez votre adresse e-mail avant de vous abonner.');
    // Empêche deux abonnements simultanés : on réutilise la session ouverte si elle existe.
    if (user.premium_checkout_session_id && user.premium_checkout_expires_at > now()) {
      const open = await stripe.checkout.sessions.retrieve(user.premium_checkout_session_id);
      if (open.status === 'open') return { url: open.url, reused: true };
      if (open.status === 'complete') throw conflict('Votre abonnement est en cours d’activation. Patientez quelques instants.');
    }
    const customer = await shop.ensureStripeCustomer(user);
    const price = Number(s.premium_price_cents);
    if (!Number.isInteger(price) || price < 50) throw bad('Prix Premium mal configuré');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer, client_reference_id: String(user.id), locale: 'fr',
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: price, recurring: { interval: s.premium_interval === 'year' ? 'year' : 'month' },
        product_data: { name: `${s.shop_name} Premium` } } }],
      metadata: { kind: 'premium', user_id: String(user.id) },
      subscription_data: { metadata: { kind: 'premium', user_id: String(user.id) } },
      expires_at: now() + 31 * 60,
      success_url: `${cfg.appUrl}/?premium=ok#compte`,
      cancel_url: `${cfg.appUrl}/#premium`,
    });
    db.prepare('UPDATE users SET premium_checkout_session_id = ?, premium_checkout_expires_at = ? WHERE id = ?').run(session.id, now() + 30 * 60, user.id);
    return { url: session.url };
  }

  function applySubscription(sub) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    let user = sub.metadata && sub.metadata.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(sub.metadata.user_id)) : null;
    if (!user && customerId) user = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
    if (!user) return null;
    // Un autre abonnement actif existe déjà pour ce client : on ignore l'ancien s'il est terminé.
    if (user.premium_sub_id && user.premium_sub_id !== sub.id && ['active', 'trialing'].includes(user.premium_status) && !['active', 'trialing'].includes(sub.status)) return user;
    const wasPremium = shop.isPremium(user);
    db.prepare(`UPDATE users SET premium_sub_id = ?, premium_status = ?, premium_until = ?, premium_cancel_at_period_end = ?,
      premium_checkout_session_id = NULL, premium_checkout_expires_at = NULL WHERE id = ?`)
      .run(sub.id, sub.status, periodEnd(sub), sub.cancel_at_period_end || sub.cancel_at ? 1 : 0, user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const isNow = shop.isPremium(updated);
    if (wasPremium !== isNow) mailer.T.premiumChanged(updated, isNow);
    return updated;
  }

  async function syncFromStripe(subId) {
    const sub = await stripe.subscriptions.retrieve(subId);
    return applySubscription(sub);
  }

  async function setCancelAtPeriodEnd(user, cancel) {
    if (!user.premium_sub_id) throw bad('Aucun abonnement');
    const sub = await stripe.subscriptions.update(user.premium_sub_id, { cancel_at_period_end: !!cancel });
    return applySubscription(sub);
  }

  async function cancelNow(user) {
    if (!user.premium_sub_id) throw bad('Aucun abonnement');
    const sub = await stripe.subscriptions.cancel(user.premium_sub_id);
    return applySubscription(sub);
  }

  return { subscribe, applySubscription, syncFromStripe, setCancelAtPeriodEnd, cancelNow };
}

module.exports = { makePremium };
