'use strict';
// Statistiques : uniquement commandes réellement encaissées et remboursements confirmés par Stripe.
const { now, list } = require('../lib/util');
const { isPremium } = require('./shop');

function makeStats(db, settings) {
  const C = (n) => db.collection(n);
  return async function stats(days = 30) {
    const t = now();
    const dayKey = (ts) => new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
    const start = t - days * 86400 - 86400;
    const keys = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(t - i * 86400));
    const series = Object.fromEntries(keys.map((k) => [k, { date: k, gross_cents: 0, refunds_cents: 0, orders: 0 }]));
    const paid = list(await C('orders').where('paid_at', '>=', start).get()).filter((o) => o.payment_status !== 'unpaid');
    for (const o of paid) { const s = series[dayKey(o.paid_at)]; if (s) { s.gross_cents += o.total_cents; s.orders++; } }
    for (const r of list(await C('refund_log').where('at', '>=', start).get())) { const s = series[dayKey(r.at)]; if (s) s.refunds_cents += r.amount_cents; }
    const daily = keys.map((k) => ({ ...series[k], net_cents: series[k].gross_cents - series[k].refunds_cents }));
    const sum = (f) => daily.reduce((a, d) => a + d[f], 0);
    const gross = sum('gross_cents'), refunds = sum('refunds_cents'), orders = sum('orders');
    const top = new Map();
    for (const o of paid) {
      if (o.status === 'cancelled' || dayKey(o.paid_at) < keys[0]) continue;
      for (const it of o.items) { const a = top.get(it.product_name) || { name: it.product_name, qty: 0, revenue_cents: 0 }; a.qty += it.qty; a.revenue_cents += it.line_total_cents; top.set(it.product_name, a); }
    }
    const s = await settings.get();
    const allOrders = list(await C('orders').get());
    const users = list(await C('users').get());
    const products = new Map(list(await C('products').get()).map((p) => [p.id, p]));
    const variants = list(await C('variants').get());
    const premiumMembers = users.filter(isPremium).length;
    return {
      days, daily,
      totals: { gross_cents: gross, refunds_cents: refunds, net_cents: gross - refunds, orders, average_order_cents: orders ? Math.round(gross / orders) : 0 },
      all_time_net_cents: allOrders.filter((o) => o.payment_status !== 'unpaid').reduce((a, o) => a + o.total_cents - (o.refunded_cents || 0), 0),
      top_products: [...top.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 8),
      low_stock: variants.filter((v) => v.active && v.stock !== null && v.stock !== undefined && v.stock <= Number(s.low_stock_threshold) && products.get(v.product_id) && products.get(v.product_id).active)
        .map((v) => ({ id: v.id, sku: v.sku, name: v.name, stock: v.stock, product: products.get(v.product_id).name, product_id: v.product_id })).sort((a, b) => a.stock - b.stock).slice(0, 30),
      to_process: {
        orders: allOrders.filter((o) => ['paid', 'in_production'].includes(o.status)).length,
        custom_requests: (await C('custom_requests').where('status', '==', 'submitted').get()).size,
        refund_requests: (await C('refund_requests').where('status', '==', 'open').get()).size,
        failed_emails: (await C('emails').where('status', '==', 'failed').get()).size,
        failed_webhooks: (await C('stripe_events').where('status', '==', 'failed').get()).size,
      },
      customers: users.filter((u) => !u.deleted_at && u.role === 'customer').length,
      new_customers: users.filter((u) => u.role === 'customer' && u.created_at >= t - days * 86400).length,
      premium_members: premiumMembers,
      premium_mrr_estimate_cents: Math.round(premiumMembers * Number(s.premium_price_cents) / (s.premium_interval === 'year' ? 12 : 1)),
      newsletter_confirmed: (await C('newsletter').where('status', '==', 'confirmed').get()).size,
    };
  };
}

module.exports = { makeStats };
