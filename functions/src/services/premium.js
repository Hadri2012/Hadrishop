'use strict';
// Abonnement Premium (Stripe Checkout mode « subscription ») ; état resynchronisé depuis Stripe.
const { now, bad, conflict, HttpError, docData } = require('../lib/util');

function periodEnd(sub) {
  const ends = ((sub.items && sub.items.data) || []).map((i) => i.current_period_end).filter(Boolean);
  return ends.length ? Math.max(...ends) : sub.current_period_end || null;
}

function makePremium({ db, cfg, stripe, shop, mailer, settings }) {
  const users = db.collection('users');

  async function subscribe(user) {
    const s = await settings.get();
    if (!s.premium_enabled) throw bad('Le programme Premium est désactivé');
    if (shop.isPremium(user)) throw conflict('Votre abonnement Premium est déjà actif');
    if (s.require_email_verification && !user.email_verified_at) throw new HttpError(403, 'Confirmez votre adresse e-mail avant de vous abonner.');
    const p = user.premium || {};
    if (p.checkout_session_id && p.checkout_expires_at > now()) {
      const open = await stripe.checkout.sessions.retrieve(p.checkout_session_id);
      if (open.status === 'open') return { url: open.url, reused: true };
      if (open.status === 'complete') throw conflict('Votre abonnement est en cours d’activation. Patientez quelques instants.');
    }
    const customer = await shop.ensureStripeCustomer(user);
    const price = Number(s.premium_price_cents);
    if (!Number.isInteger(price) || price < 50) throw bad('Prix Premium mal configuré');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer, client_reference_id: user.id, locale: 'fr',
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: price, recurring: { interval: s.premium_interval === 'year' ? 'year' : 'month' }, product_data: { name: `${s.shop_name} Premium` } } }],
      metadata: { kind: 'premium', user_id: user.id }, subscription_data: { metadata: { kind: 'premium', user_id: user.id } },
      expires_at: now() + 31 * 60, success_url: `${cfg.appUrl}/?premium=ok#compte`, cancel_url: `${cfg.appUrl}/#premium`,
    });
    await users.doc(user.id).update({ premium: { ...p, checkout_session_id: session.id, checkout_expires_at: now() + 30 * 60 } });
    return { url: session.url };
  }

  async function applySubscription(sub) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    let user = sub.metadata && sub.metadata.user_id ? docData(await users.doc(sub.metadata.user_id).get()) : null;
    if (!user && customerId) { const qs = await users.where('stripe_customer_id', '==', customerId).limit(1).get(); if (!qs.empty) user = { id: qs.docs[0].id, ...qs.docs[0].data() }; }
    if (!user) return null;
    const p = user.premium || {};
    if (p.sub_id && p.sub_id !== sub.id && ['active', 'trialing'].includes(p.status) && !['active', 'trialing'].includes(sub.status)) return user;
    const was = shop.isPremium(user);
    const premium = { status: sub.status, sub_id: sub.id, until: periodEnd(sub), cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at), checkout_session_id: null, checkout_expires_at: null };
    await users.doc(user.id).update({ premium });
    const updated = { ...user, premium };
    const isNow = shop.isPremium(updated);
    if (was !== isNow) await mailer.T.premiumChanged(updated, isNow);
    return updated;
  }
  const syncFromStripe = async (subId) => applySubscription(await stripe.subscriptions.retrieve(subId));
  async function setCancelAtPeriodEnd(user, cancel) {
    if (!user.premium || !user.premium.sub_id) throw bad('Aucun abonnement');
    return applySubscription(await stripe.subscriptions.update(user.premium.sub_id, { cancel_at_period_end: !!cancel }));
  }
  async function cancelNow(user) {
    if (!user.premium || !user.premium.sub_id) throw bad('Aucun abonnement');
    return applySubscription(await stripe.subscriptions.cancel(user.premium.sub_id));
  }
  return { subscribe, applySubscription, syncFromStripe, setCancelAtPeriodEnd, cancelNow };
}

module.exports = { makePremium };
