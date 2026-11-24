'use strict';
const { now } = require('../lib/util');
const { getSettings } = require('../lib/settings');

// Statistiques de ventes : chiffres calculés uniquement à partir des commandes réellement encaissées
// (payment_status ≠ unpaid) et des remboursements confirmés par Stripe (status = succeeded).
function makeStats(db, shop) {
  return function stats(days = 30) {
    const t = now();
    const dayKey = (ts) => new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });
    const start = t - (days - 1) * 86400 - 86400; // marge, filtrée ensuite par date locale
    const keys = [];
    for (let i = days - 1; i >= 0; i--) keys.push(dayKey(t - i * 86400));
    const series = Object.fromEntries(keys.map((k) => [k, { date: k, gross_cents: 0, refunds_cents: 0, orders: 0 }]));
    for (const o of db.prepare(`SELECT paid_at, total_cents FROM orders WHERE payment_status != 'unpaid' AND paid_at >= ?`).all(start)) {
      const s = series[dayKey(o.paid_at)]; if (s) { s.gross_cents += o.total_cents; s.orders++; }
    }
    for (const r of db.prepare(`SELECT updated_at, amount_cents FROM refunds WHERE status = 'succeeded' AND updated_at >= ?`).all(start)) {
      const s = series[dayKey(r.updated_at)]; if (s) s.refunds_cents += r.amount_cents;
    }
    const daily = keys.map((k) => ({ ...series[k], net_cents: series[k].gross_cents - series[k].refunds_cents }));
    const sum = (f) => daily.reduce((a, d) => a + d[f], 0);
    const gross = sum('gross_cents'), refunds = sum('refunds_cents'), orders = sum('orders');
    const firstKey = keys[0];
    const inPeriod = (ts) => dayKey(ts) >= firstKey;
    const top = new Map();
    for (const it of db.prepare(`SELECT oi.product_name, oi.qty, oi.line_total_cents, o.paid_at FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.payment_status != 'unpaid' AND o.status != 'cancelled' AND o.paid_at >= ?`).all(start)) {
      if (!inPeriod(it.paid_at)) continue;
      const a = top.get(it.product_name) || { name: it.product_name, qty: 0, revenue_cents: 0 };
      a.qty += it.qty; a.revenue_cents += it.line_total_cents; top.set(it.product_name, a);
    }
    const s = getSettings(db);
    const premiumMembers = db.prepare('SELECT * FROM users WHERE premium_status IN (\'active\',\'trialing\') AND premium_until > ?').all(t).length;
    return {
      days, daily,
      totals: { gross_cents: gross, refunds_cents: refunds, net_cents: gross - refunds, orders, average_order_cents: orders ? Math.round(gross / orders) : 0 },
      all_time_net_cents: db.prepare(`SELECT COALESCE(SUM(total_cents - refunded_cents),0) n FROM orders WHERE payment_status != 'unpaid'`).get().n,
      top_products: [...top.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 8),
      low_stock: db.prepare(`SELECT v.id, v.sku, v.name, v.stock, p.name AS product, p.id AS product_id FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1 AND v.stock IS NOT NULL AND v.stock <= ? ORDER BY v.stock, p.name LIMIT 30`).all(Number(s.low_stock_threshold)),
      to_process: {
        orders: db.prepare(`SELECT COUNT(*) n FROM orders WHERE status IN ('paid','in_production')`).get().n,
        custom_requests: db.prepare(`SELECT COUNT(*) n FROM custom_requests WHERE status = 'submitted'`).get().n,
        refund_requests: db.prepare(`SELECT COUNT(*) n FROM refund_requests WHERE status = 'open'`).get().n,
        failed_emails: db.prepare(`SELECT COUNT(*) n FROM emails WHERE status = 'failed'`).get().n,
        failed_webhooks: db.prepare(`SELECT COUNT(*) n FROM stripe_events WHERE status = 'failed'`).get().n,
      },
      customers: db.prepare('SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL AND role = \'customer\'').get().n,
      new_customers: db.prepare('SELECT COUNT(*) n FROM users WHERE created_at >= ? AND role = \'customer\'').get(t - days * 86400).n,
      premium_members: premiumMembers,
      premium_mrr_estimate_cents: Math.round(premiumMembers * Number(s.premium_price_cents) / (s.premium_interval === 'year' ? 12 : 1)),
      newsletter_confirmed: db.prepare(`SELECT COUNT(*) n FROM newsletter_subscribers WHERE status = 'confirmed'`).get().n,
    };
  };
}

module.exports = { makeStats };
