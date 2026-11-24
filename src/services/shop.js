'use strict';
// Logique métier centrale : calcul des prix, livraison, réservations de stock (15 min),
// création des sessions Stripe Checkout, encaissement, expiration et remboursements.
const { now, bad, notFound, forbidden, conflict, HttpError, randomToken, euros } = require('../lib/util');
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });
const { getSettings } = require('../lib/settings');

const STATUS_LABELS = {
  pending_payment: 'En attente de paiement', payment_processing: 'Paiement en cours de traitement',
  payment_failed: 'Paiement échoué', expired: 'Réservation expirée', cancelled: 'Annulée',
  paid: 'Payée', in_production: 'En impression', shipped: 'Expédiée', ready_for_pickup: 'Prête à retirer',
  delivered: 'Livrée', completed: 'Terminée',
};
const ADMIN_STATUS_FLOW = ['paid', 'in_production', 'shipped', 'ready_for_pickup', 'delivered', 'completed', 'cancelled'];
const ADDRESS_EDITABLE = new Set(['paid', 'in_production', 'payment_processing']);
const MIN_CHARGE_CENTS = 50;

function makeShop({ db, cfg, mailer, geo, stripe, log = console }) {
  const settings = () => getSettings(db);

  function isPremium(user) {
    return !!user && ['active', 'trialing'].includes(user.premium_status) && (user.premium_until || 0) > now();
  }

  function reservedByOthers(variantId, orderId = 0) {
    return db.prepare(`SELECT COALESCE(SUM(qty),0) AS n FROM reservations
      WHERE variant_id = ? AND status = 'active' AND expires_at > ? AND order_id != ?`).get(variantId, now(), orderId).n;
  }
  function availableStock(variant, orderId = 0) {
    if (variant.stock === null || variant.stock === undefined) return Infinity;
    return Math.max(0, variant.stock - reservedByOthers(variant.id, orderId));
  }

  // ---------- Livraison ----------
  async function eligibleZones(address) {
    const zones = db.prepare('SELECT * FROM shipping_zones WHERE active = 1 ORDER BY sort, id').all();
    const s = settings();
    const code = address && String(address.postal_code || '').trim();
    const country = address && String(address.country || 'BE').toUpperCase();
    let coords; // résolu paresseusement
    const out = [];
    for (const z of zones) {
      let ok = false, distance = null, reason = null;
      if (z.kind === 'pickup') ok = true;
      else if (!code) reason = 'Code postal requis';
      else if (country !== 'BE') reason = 'Livraison limitée à la Belgique';
      else if (z.kind === 'postal') { ok = geo.parsePostalList(z.postal_codes)(code); if (!ok) reason = 'Code postal hors zone'; }
      else if (z.kind === 'radius') {
        if (s.origin_lat == null || s.origin_lng == null) reason = "Adresse de l'atelier non configurée";
        else {
          if (coords === undefined) coords = await geo.coordsFor(code);
          if (!coords) reason = 'Distance inconnue pour ce code postal';
          else {
            distance = geo.haversineKm(Number(s.origin_lat), Number(s.origin_lng), coords.lat, coords.lng);
            ok = distance <= Number(z.radius_km || 0);
            if (!ok) reason = `Hors du rayon de ${z.radius_km} km`;
          }
        }
      }
      out.push({ id: z.id, name: z.name, kind: z.kind, description: z.description, price_cents: z.price_cents,
        free_above_cents: z.free_above_cents, eligible: ok, distance_km: distance == null ? null : Math.round(distance * 10) / 10, reason });
    }
    return out;
  }

  // ---------- Codes promo ----------
  function promoUsage(promoId, userId) {
    const live = `(payment_status != 'unpaid' OR (status IN ('pending_payment','payment_processing') AND (reservation_expires_at IS NULL OR reservation_expires_at > ${now()})))`;
    const total = db.prepare(`SELECT COUNT(*) n FROM orders WHERE promo_code_id = ? AND ${live}`).get(promoId).n;
    const mine = userId ? db.prepare(`SELECT COUNT(*) n FROM orders WHERE promo_code_id = ? AND user_id = ? AND ${live}`).get(promoId, userId).n : 0;
    return { total, mine };
  }

  function evaluatePromo(code, user, base, subtotal, excludeOrderId) {
    const p = db.prepare('SELECT * FROM promo_codes WHERE code = ?').get(String(code).trim());
    const t = now();
    if (!p || !p.active) return { error: 'Code promo invalide' };
    if (p.starts_at && t < p.starts_at) return { error: "Ce code n'est pas encore valable" };
    if (p.ends_at && t > p.ends_at) return { error: 'Ce code a expiré' };
    if (p.premium_only && !isPremium(user)) return { error: 'Code réservé aux membres Premium' };
    if (subtotal < p.min_subtotal_cents) return { error: `Montant minimum requis : ${euros(p.min_subtotal_cents)}` };
    const u = promoUsage(p.id, user && user.id);
    if (p.max_uses != null && u.total >= p.max_uses) return { error: "Ce code n'est plus disponible" };
    if (p.per_user_limit != null && user && u.mine >= p.per_user_limit) return { error: 'Vous avez déjà utilisé ce code' };
    const amount = p.type === 'percent' ? Math.floor((base * Math.min(p.value, 100)) / 100) : Math.min(p.value, base);
    return { promo: p, amount };
  }

  // ---------- Calcul de commande (synchrone : appelé dans une transaction) ----------
  function priceCart(user, { items = [], promoCode, zoneId, zones = [], custom = null }) {
    const errors = [];
    const premium = isPremium(user);
    const s = settings();
    let lines = [];

    if (custom) {
      lines = [{ variant_id: null, product_id: null, product_name: custom.name, variant_name: 'Commande sur mesure', sku: null,
        type: 'custom', unit_price_cents: custom.price_cents, qty: 1, line_total_cents: custom.price_cents, stock_tracked: false }];
    } else {
      const merged = new Map();
      for (const it of items) {
        const vid = Number(it.variantId), qty = Number(it.qty);
        if (!Number.isInteger(vid) || !Number.isInteger(qty) || qty < 1 || qty > 99) { errors.push({ variantId: it.variantId, message: 'Quantité invalide' }); continue; }
        merged.set(vid, (merged.get(vid) || 0) + qty);
      }
      if (merged.size === 0 && !errors.length) errors.push({ message: 'Panier vide' });
      if (merged.size > 50) errors.push({ message: 'Trop d’articles différents' });
      for (const [vid, qty] of merged) {
        const v = db.prepare(`SELECT v.*, p.name AS product_name, p.type AS product_type, p.active AS p_active, p.premium_only, p.id AS pid
          FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`).get(vid);
        if (!v || !v.active || !v.p_active) { errors.push({ variantId: vid, message: 'Article indisponible' }); continue; }
        if (v.premium_only && !premium) { errors.push({ variantId: vid, message: 'Article réservé aux membres Premium' }); continue; }
        if (v.product_type === 'digital' && qty !== 1) { errors.push({ variantId: vid, message: 'Un fichier numérique ne peut être acheté qu’une fois par commande' }); continue; }
        const tracked = v.product_type === 'physical' && v.stock !== null;
        if (tracked) {
          const avail = availableStock(v);
          if (qty > avail) { errors.push({ variantId: vid, code: 'insufficient_stock', available: avail, message: avail ? `Plus que ${avail} en stock` : 'Rupture de stock' }); continue; }
        }
        lines.push({ variant_id: v.id, product_id: v.pid, product_name: v.product_name, variant_name: v.name, sku: v.sku, type: v.product_type,
          unit_price_cents: v.price_cents, qty, line_total_cents: v.price_cents * qty, stock_tracked: tracked });
      }
    }

    const subtotal = lines.reduce((a, l) => a + l.line_total_cents, 0);
    const premiumDiscount = premium && !custom ? Math.floor((subtotal * Number(s.premium_discount_percent || 0)) / 100) : 0;
    let promo = null, promoDiscount = 0, promoError = null;
    if (promoCode && !custom) {
      const r = evaluatePromo(promoCode, user, subtotal - premiumDiscount, subtotal);
      if (r.error) promoError = r.error; else { promo = r.promo; promoDiscount = r.amount; }
    }
    const needsShipping = lines.some((l) => l.type === 'physical' || l.type === 'custom');
    let zone = null, shipping = 0;
    if (needsShipping) {
      if (zoneId == null) errors.push({ code: 'shipping_required', message: 'Choisissez un mode de livraison' });
      else {
        zone = zones.find((z) => z.id === Number(zoneId));
        if (!zone) errors.push({ code: 'shipping_invalid', message: 'Mode de livraison inconnu' });
        else if (!zone.eligible) errors.push({ code: 'shipping_ineligible', message: zone.reason || 'Livraison indisponible pour cette adresse' });
        else {
          const afterDiscounts = subtotal - premiumDiscount - promoDiscount;
          shipping = zone.price_cents;
          if (zone.free_above_cents != null && afterDiscounts >= zone.free_above_cents) shipping = 0;
          if (premium && s.premium_free_shipping) shipping = 0;
        }
      }
    }
    const total = subtotal - premiumDiscount - promoDiscount + shipping;
    return { lines, subtotal, premium, premiumDiscount, promo, promoDiscount, promoError, needsShipping, zone, shipping, total, errors };
  }

  async function quote(user, body) {
    const zones = await eligibleZones(body.address || null);
    const q = priceCart(user, { items: body.items || [], promoCode: body.promoCode, zoneId: body.shippingZoneId, zones });
    return { ...publicQuote(q), zones };
  }
  function publicQuote(q) {
    return { lines: q.lines.map(({ stock_tracked, ...l }) => l), subtotal_cents: q.subtotal, premium: q.premium,
      premium_discount_cents: q.premiumDiscount, promo_code: q.promo ? q.promo.code : null, promo_discount_cents: q.promoDiscount,
      promo_error: q.promoError, needs_shipping: q.needsShipping, shipping_cents: q.shipping, total_cents: q.total, errors: q.errors };
  }

  // ---------- Création de commande + Stripe Checkout ----------
  async function ensureStripeCustomer(user) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const c = await stripe.customers.create({ email: user.email, name: user.name, metadata: { user_id: String(user.id) } },
      { idempotencyKey: `customer-${user.id}` });
    db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(c.id, user.id);
    return db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(user.id).stripe_customer_id;
  }

  function releaseReservations(orderId) {
    db.prepare(`UPDATE reservations SET status = 'released' WHERE order_id = ? AND status = 'active'`).run(orderId);
  }
  function addEvent(orderId, type, message, actor = 'system') {
    db.prepare('INSERT INTO order_events(order_id, type, message, actor, created_at) VALUES (?,?,?,?,?)').run(orderId, type, message || null, actor, now());
  }

  function resolveAddress(user, body) {
    if (body.addressId) {
      const a = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?').get(Number(body.addressId), user.id);
      if (!a) throw bad('Adresse introuvable');
      return a;
    }
    return body.address || null;
  }

  async function startCheckout(user, body, { custom = null } = {}) {
    const s = settings();
    if (s.require_email_verification && !user.email_verified_at) throw forbidden('Confirmez votre adresse e-mail avant de commander.');
    const key = String(body.checkoutKey || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw bad('Clé de paiement invalide');
    const address = resolveAddress(user, body);
    const zones = await eligibleZones(address);

    const res = db.atomic(() => {
      const existing = db.prepare('SELECT * FROM orders WHERE user_id = ? AND checkout_key = ?').get(user.id, key);
      if (existing) return { existing };
      // Une seule commande en attente par client : les précédentes sont annulées (stock libéré).
      const previous = db.prepare(`SELECT id, stripe_session_id FROM orders WHERE user_id = ? AND status = 'pending_payment'`).all(user.id);
      for (const p of previous) {
        db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now(), p.id);
        releaseReservations(p.id);
        addEvent(p.id, 'superseded', 'Remplacée par une nouvelle tentative de paiement');
      }
      const q = priceCart(user, { items: body.items, promoCode: body.promoCode, zoneId: body.shippingZoneId, zones, custom });
      if (q.promoError) throw new HttpError(409, q.promoError, 'promo_invalid');
      if (q.errors.length) { const e = new HttpError(409, q.errors[0].message, q.errors[0].code || 'cart_invalid'); e.details = q.errors; throw e; }
      if (q.total < MIN_CHARGE_CENTS) throw bad('Le montant minimum de paiement est de 0,50 €');
      const needsAddr = q.needsShipping && q.zone && q.zone.kind !== 'pickup';
      const a = needsAddr ? validateAddress(address) : null;
      const t = now();
      const exp = t + cfg.reservationMinutes * 60;
      const info = db.prepare(`INSERT INTO orders(user_id, checkout_key, status, payment_status, subtotal_cents, premium_discount_cents, discount_cents,
        shipping_cents, total_cents, promo_code_id, promo_code, shipping_zone_id, shipping_method, needs_shipping,
        ship_name, ship_line1, ship_line2, ship_postal, ship_city, ship_country, ship_phone, email, reservation_expires_at,
        customer_note, custom_request_id, created_at, updated_at)
        VALUES (?,?,'pending_payment','unpaid',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        user.id, key, q.subtotal, q.premiumDiscount, q.promoDiscount, q.shipping, q.total, q.promo ? q.promo.id : null, q.promo ? q.promo.code : null,
        q.zone ? q.zone.id : null, q.zone ? q.zone.name : null, q.needsShipping ? 1 : 0,
        a ? a.name : (q.needsShipping ? user.name : null), a ? a.line1 : null, a ? a.line2 || null : null, a ? a.postal_code : null,
        a ? a.city : null, a ? a.country || 'BE' : null, a ? a.phone || null : null, user.email, exp,
        body.note ? String(body.note).slice(0, 1000) : null, custom ? custom.requestId : null, t, t);
      const orderId = Number(info.lastInsertRowid);
      const number = `HS-${new Date().getFullYear()}-${String(orderId).padStart(6, '0')}`;
      db.prepare('UPDATE orders SET number = ? WHERE id = ?').run(number, orderId);
      const insItem = db.prepare(`INSERT INTO order_items(order_id, variant_id, product_id, product_name, variant_name, sku, type, unit_price_cents, qty, line_total_cents)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const insRes = db.prepare('INSERT INTO reservations(order_id, variant_id, qty, expires_at) VALUES (?,?,?,?)');
      for (const l of q.lines) {
        insItem.run(orderId, l.variant_id, l.product_id, l.product_name, l.variant_name, l.sku, l.type, l.unit_price_cents, l.qty, l.line_total_cents);
        if (l.stock_tracked) insRes.run(orderId, l.variant_id, l.qty, exp);
      }
      addEvent(orderId, 'created', `Commande créée, stock réservé 15 minutes (jusqu'à ${hhmm(exp)})`);
      return { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), lines: q.lines, previous };
    });

    if (res.existing) {
      const o = res.existing;
      if (o.status === 'pending_payment' && o.stripe_session_url && o.reservation_expires_at > now()) return { url: o.stripe_session_url, number: o.number, reused: true };
      if (o.status === 'pending_payment' && !o.stripe_session_url) throw conflict('Paiement en cours de préparation, réessayez dans un instant.', 'checkout_in_progress');
      throw conflict('Cette tentative de paiement est terminée. Rechargez le panier pour recommencer.', 'checkout_closed');
    }
    for (const p of res.previous) if (p.stripe_session_id) stripe.checkout.sessions.expire(p.stripe_session_id).catch(() => {});

    const o = res.order;
    try {
      const customer = await ensureStripeCustomer(user);
      const discount = o.premium_discount_cents + o.discount_cents;
      let coupon = null;
      if (discount > 0) {
        coupon = await stripe.coupons.create({ amount_off: discount, currency: 'eur', duration: 'once', max_redemptions: 1,
          name: `Remises ${o.number}`.slice(0, 40), metadata: { order_id: String(o.id) } }, { idempotencyKey: `coupon-order-${o.id}` });
      }
      const params = {
        mode: 'payment', customer, client_reference_id: String(o.id), locale: 'fr',
        line_items: res.lines.map((l) => ({ quantity: l.qty, price_data: { currency: 'eur', unit_amount: l.unit_price_cents,
          product_data: { name: `${l.product_name}${l.variant_name ? ' — ' + l.variant_name : ''}`.slice(0, 250) } } })),
        metadata: { order_id: String(o.id), order_number: o.number, kind: 'order' },
        payment_intent_data: { metadata: { order_id: String(o.id), order_number: o.number } },
        expires_at: now() + 31 * 60, // minimum Stripe : 30 min ; la réservation de 15 min est gérée par le serveur qui expire la session
        success_url: `${cfg.appUrl}/?paiement=ok#commande-${o.number}`,
        cancel_url: `${cfg.appUrl}/?paiement=annule#panier`,
      };
      if (coupon) params.discounts = [{ coupon: coupon.id }];
      if (o.needs_shipping) params.shipping_options = [{ shipping_rate_data: { type: 'fixed_amount', display_name: (o.shipping_method || 'Livraison').slice(0, 100),
        fixed_amount: { amount: o.shipping_cents, currency: 'eur' } } }];
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-order-${o.id}` });
      db.prepare('UPDATE orders SET stripe_session_id = ?, stripe_session_url = ?, stripe_coupon_id = ?, updated_at = ? WHERE id = ?')
        .run(session.id, session.url, coupon ? coupon.id : null, now(), o.id);
      return { url: session.url, number: o.number };
    } catch (e) {
      db.atomic(() => {
        db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_payment'`).run(now(), o.id);
        releaseReservations(o.id);
        addEvent(o.id, 'stripe_error', String(e.message).slice(0, 300));
      });
      log.error('[checkout] Stripe error', e.message);
      throw new HttpError(502, 'Le service de paiement est indisponible. Aucun montant n’a été prélevé.', 'stripe_error');
    }
  }

  function validateAddress(a) {
    if (!a) throw bad('Adresse de livraison requise');
    const clean = {}; const req = ['name', 'line1', 'postal_code', 'city'];
    for (const k of ['name', 'line1', 'line2', 'postal_code', 'city', 'country', 'phone']) clean[k] = a[k] == null ? '' : String(a[k]).trim().slice(0, 200);
    for (const k of req) if (!clean[k]) throw bad('Adresse incomplète');
    clean.country = (clean.country || 'BE').toUpperCase();
    if (clean.country === 'BE' && !/^\d{4}$/.test(clean.postal_code)) throw bad('Code postal belge invalide (4 chiffres)');
    return clean;
  }

  // ---------- Encaissement (appelé depuis le webhook) ----------
  async function markPaid(orderId, session) {
    const out = db.atomic(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o) return { skip: true };
      if (o.payment_status !== 'unpaid') return { already: true, o };
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent && session.payment_intent.id;
      const mismatch = Number(session.amount_total) !== o.total_cents;
      // Vérifie la disponibilité (réservation active ou stock encore libre si elle a expiré)
      const need = new Map();
      for (const it of items) {
        if (it.type !== 'physical' || !it.variant_id) continue;
        const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(it.variant_id);
        if (!v || v.stock === null) continue;
        need.set(v.id, (need.get(v.id) || 0) + it.qty);
      }
      let feasible = true;
      for (const [vid, qty] of need) {
        const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(vid);
        if (v.stock - reservedByOthers(vid, orderId) < qty) feasible = false;
      }
      const t = now();
      if (!feasible) {
        db.prepare(`UPDATE orders SET status = 'cancelled', payment_status = 'paid', paid_at = ?, stripe_payment_intent = ?, updated_at = ? WHERE id = ?`).run(t, pi, t, orderId);
        releaseReservations(orderId);
        addEvent(orderId, 'out_of_stock', 'Paiement reçu après expiration de la réservation et stock insuffisant : remboursement automatique');
        return { oos: true, o: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) };
      }
      for (const [vid, qty] of need) {
        const r = db.prepare('UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, vid, qty);
        if (r.changes !== 1) throw new Error('Stock incohérent'); // ne devrait jamais arriver (contrôlé ci-dessus)
      }
      db.prepare(`UPDATE reservations SET status = 'consumed' WHERE order_id = ?`).run(orderId);
      const allDigital = items.every((i) => i.type === 'digital');
      db.prepare(`UPDATE orders SET status = ?, payment_status = 'paid', paid_at = ?, stripe_payment_intent = ?, reservation_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(allDigital ? 'completed' : 'paid', t, pi, t, orderId);
      const maxDl = Number(settings().download_max_count) || 10;
      for (const it of items.filter((i) => i.type === 'digital' && i.product_id)) {
        for (const f of db.prepare('SELECT id FROM product_files WHERE product_id = ?').all(it.product_id)) {
          db.prepare('INSERT OR IGNORE INTO downloads(order_id, user_id, product_file_id, max_count, created_at) VALUES (?,?,?,?,?)').run(orderId, o.user_id, f.id, maxDl, t);
        }
      }
      if (o.custom_request_id) db.prepare(`UPDATE custom_requests SET status = 'paid', updated_at = ? WHERE id = ?`).run(t, o.custom_request_id);
      addEvent(orderId, 'paid', `Paiement reçu (${euros(session.amount_total)})` + (mismatch ? ' — ATTENTION : montant différent du total calculé' : ''));
      return { paid: true, o: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), items, mismatch };
    });
    if (out.paid) {
      mailer.T.orderPaid(out.o, out.items);
      mailer.T.adminNotify(`Nouvelle commande ${out.o.number}`, `Montant : ${euros(out.o.total_cents)}` + (out.mismatch ? ' (montant Stripe différent : à vérifier)' : ''));
    }
    if (out.oos) {
      await refund(out.o.id, out.o.total_cents, { reason: 'Rupture de stock après expiration de la réservation', actor: 'system', notify: false });
      mailer.T.outOfStockRefund(out.o);
    }
    return out;
  }

  function markProcessing(orderId) {
    db.atomic(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o || o.payment_status !== 'unpaid' || !['pending_payment', 'expired'].includes(o.status)) return;
      const until = now() + 7 * 86400;
      db.prepare(`UPDATE orders SET status = 'payment_processing', reservation_expires_at = NULL, updated_at = ? WHERE id = ?`).run(now(), orderId);
      db.prepare(`UPDATE reservations SET expires_at = ? WHERE order_id = ? AND status = 'active'`).run(until, orderId);
      addEvent(orderId, 'payment_processing', 'Paiement différé en cours de traitement (stock conservé 7 jours)');
    });
  }
  function markPaymentFailed(orderId) {
    db.atomic(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o || o.payment_status !== 'unpaid') return;
      db.prepare(`UPDATE orders SET status = 'payment_failed', updated_at = ? WHERE id = ?`).run(now(), orderId);
      releaseReservations(orderId);
      addEvent(orderId, 'payment_failed', 'Le paiement différé a échoué');
    });
  }
  function markExpired(orderId, reason = 'Session de paiement expirée') {
    return db.atomic(() => {
      const r = db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_payment' AND payment_status = 'unpaid'`).run(now(), orderId);
      if (r.changes) { releaseReservations(orderId); addEvent(orderId, 'expired', reason); }
      return r.changes === 1;
    });
  }

  // Tâche périodique : expiration des réservations de 15 minutes
  async function expireReservations() {
    const due = db.prepare(`SELECT id, stripe_session_id FROM orders WHERE status = 'pending_payment' AND reservation_expires_at <= ?`).all(now());
    for (const o of due) {
      if (markExpired(o.id, 'Réservation de 15 minutes expirée') && o.stripe_session_id) {
        try { await stripe.checkout.sessions.expire(o.stripe_session_id); } catch (e) { /* session déjà payée/expirée : le webhook tranchera */ }
      }
    }
    return due.length;
  }

  // ---------- Remboursements ----------
  function recomputeRefunds(orderId) {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const refunded = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM refunds WHERE order_id = ? AND status = 'succeeded'`).get(orderId).n;
    let ps = o.payment_status;
    if (o.payment_status !== 'unpaid') ps = refunded >= o.total_cents ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid';
    let status = o.status;
    if (ps === 'refunded' && ['paid', 'in_production', 'payment_processing', 'ready_for_pickup'].includes(status)) status = 'cancelled';
    db.prepare('UPDATE orders SET refunded_cents = ?, payment_status = ?, status = ?, updated_at = ? WHERE id = ?').run(refunded, ps, status, now(), orderId);
    if (ps === 'refunded') db.prepare('UPDATE downloads SET revoked = 1 WHERE order_id = ?').run(orderId);
    return { refunded, ps };
  }

  // Applique les effets d'un remboursement réussi (une seule fois grâce au drapeau « applied »)
  function applyRefund(refundId, notify = true) {
    const res = db.atomic(() => {
      const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
      if (!r || r.status !== 'succeeded' || r.applied) return null;
      db.prepare('UPDATE refunds SET applied = 1, updated_at = ? WHERE id = ?').run(now(), refundId);
      if (r.restock) {
        // Seules les quantités réellement décomptées du stock (réservations consommées) sont remises en stock.
        for (const res of db.prepare(`SELECT variant_id, qty FROM reservations WHERE order_id = ? AND status = 'consumed'`).all(r.order_id)) {
          db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').run(res.qty, res.variant_id);
        }
        db.prepare(`UPDATE reservations SET status = 'released' WHERE order_id = ? AND status = 'consumed'`).run(r.order_id);
      }
      const { ps } = recomputeRefunds(r.order_id);
      addEvent(r.order_id, 'refunded', `Remboursement de ${euros(r.amount_cents)} effectué` + (r.restock ? ' (articles remis en stock)' : ''), r.created_by);
      return { r, o: db.prepare('SELECT * FROM orders WHERE id = ?').get(r.order_id), full: ps === 'refunded' };
    });
    if (res && notify) mailer.T.refund(res.o, res.r.amount_cents, res.full);
    return res;
  }

  async function refund(orderId, amountCents, { reason = '', restock = false, actor = 'admin', notify = true } = {}) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Montant de remboursement invalide');
    const prep = db.atomic(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o) throw notFound('Commande introuvable');
      if (!['paid', 'partially_refunded'].includes(o.payment_status)) throw conflict('Cette commande ne peut pas être remboursée');
      if (!o.stripe_payment_intent) throw conflict('Paiement Stripe introuvable pour cette commande');
      const engaged = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM refunds WHERE order_id = ? AND status IN ('pending','succeeded','requires_action')`).get(orderId).n;
      const remaining = o.total_cents - engaged;
      if (amount > remaining) throw bad(`Montant trop élevé : ${euros(remaining)} remboursables au maximum`);
      if (restock && amount !== remaining) throw bad('La remise en stock n’est possible que pour un remboursement du solde complet');
      const key = `refund-${orderId}-${randomToken(9)}`;
      const t = now();
      const info = db.prepare(`INSERT INTO refunds(order_id, amount_cents, reason, status, idempotency_key, restock, created_by, created_at, updated_at)
        VALUES (?,?,?,'pending',?,?,?,?,?)`).run(orderId, amount, String(reason || '').slice(0, 500), key, restock ? 1 : 0, actor, t, t);
      return { id: Number(info.lastInsertRowid), key, o };
    });
    let r;
    try {
      r = await stripe.refunds.create({ payment_intent: prep.o.stripe_payment_intent, amount, reason: 'requested_by_customer',
        metadata: { order_id: String(orderId), refund_id: String(prep.id) } }, { idempotencyKey: prep.key });
    } catch (e) {
      db.prepare(`UPDATE refunds SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(String(e.message).slice(0, 500), now(), prep.id);
      throw new HttpError(502, `Stripe a refusé le remboursement : ${e.message}`, 'stripe_error');
    }
    const st = ['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(r.status) ? r.status : 'pending';
    db.prepare('UPDATE refunds SET stripe_refund_id = ?, status = ?, updated_at = ? WHERE id = ?').run(r.id, st, now(), prep.id);
    if (st === 'succeeded') applyRefund(prep.id, notify);
    return db.prepare('SELECT * FROM refunds WHERE id = ?').get(prep.id);
  }

  // Synchronise un objet Refund Stripe (événements refund.* ou création depuis le Dashboard Stripe)
  function syncStripeRefund(sr) {
    const st = ['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(sr.status) ? sr.status : 'pending';
    let row = db.prepare('SELECT * FROM refunds WHERE stripe_refund_id = ?').get(sr.id);
    if (!row && sr.metadata && sr.metadata.refund_id) {
      row = db.prepare('SELECT * FROM refunds WHERE id = ?').get(Number(sr.metadata.refund_id));
      if (row) db.prepare('UPDATE refunds SET stripe_refund_id = ? WHERE id = ?').run(sr.id, row.id);
    }
    if (!row) {
      const pi = typeof sr.payment_intent === 'string' ? sr.payment_intent : sr.payment_intent && sr.payment_intent.id;
      const o = pi && db.prepare('SELECT * FROM orders WHERE stripe_payment_intent = ?').get(pi);
      if (!o) return null;
      const t = now();
      const info = db.prepare(`INSERT OR IGNORE INTO refunds(order_id, amount_cents, reason, status, stripe_refund_id, idempotency_key, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(o.id, sr.amount, 'Créé depuis le Dashboard Stripe', st, sr.id, `stripe-${sr.id}`, 'stripe', t, t);
      row = db.prepare('SELECT * FROM refunds WHERE stripe_refund_id = ?').get(sr.id);
      if (!info.changes && !row) return null;
    }
    if (row.status !== st) db.prepare('UPDATE refunds SET status = ?, updated_at = ? WHERE id = ?').run(st, now(), row.id);
    if (st === 'succeeded') applyRefund(row.id);
    else if (['failed', 'canceled'].includes(st)) db.atomic(() => recomputeRefunds(row.order_id));
    return row.id;
  }

  // ---------- Statuts / adresses ----------
  function setStatus(orderId, status, { tracking_carrier, tracking_number, tracking_url, actor = 'admin', message } = {}) {
    if (!ADMIN_STATUS_FLOW.includes(status)) throw bad('Statut invalide');
    if (tracking_url && !/^https:\/\//.test(tracking_url)) throw bad('Le lien de suivi doit commencer par https://');
    const o = db.atomic(() => {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!o) throw notFound();
      if (o.payment_status === 'unpaid') throw conflict('Commande non payée');
      db.prepare(`UPDATE orders SET status = ?, tracking_carrier = COALESCE(?, tracking_carrier), tracking_number = COALESCE(?, tracking_number),
        tracking_url = COALESCE(?, tracking_url), updated_at = ? WHERE id = ?`).run(status, tracking_carrier || null, tracking_number || null, tracking_url || null, now(), orderId);
      addEvent(orderId, 'status', `${STATUS_LABELS[status]}${message ? ' — ' + message : ''}`, actor);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    });
    let extra = message || '';
    if (o.tracking_number) extra += `${extra ? '\n' : ''}Suivi : ${o.tracking_carrier || ''} ${o.tracking_number}${o.tracking_url ? ' — ' + o.tracking_url : ''}`;
    mailer.T.orderStatus(o, STATUS_LABELS[status], extra || null);
    return o;
  }

  async function changeAddress(orderId, address, { byAdmin = false, userId = null, actor } = {}) {
    const a = validateAddress(address);
    const o0 = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o0 || (!byAdmin && o0.user_id !== userId)) throw notFound('Commande introuvable');
    if (!o0.needs_shipping) throw conflict('Cette commande ne nécessite pas de livraison');
    if (!byAdmin && !ADDRESS_EDITABLE.has(o0.status)) throw conflict("L'adresse ne peut plus être modifiée à ce stade");
    const zone = db.prepare('SELECT * FROM shipping_zones WHERE id = ?').get(o0.shipping_zone_id);
    if (!byAdmin) {
      if (zone && zone.kind === 'pickup') throw conflict('Commande en retrait sur place : aucune adresse de livraison');
      const zones = await eligibleZones(a);
      const z = zones.find((x) => x.id === o0.shipping_zone_id);
      if (!z || !z.eligible) throw conflict('La nouvelle adresse est hors de la zone de livraison choisie. Contactez-nous.');
    }
    const o = db.atomic(() => {
      const cur = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!byAdmin && !ADDRESS_EDITABLE.has(cur.status)) throw conflict("L'adresse ne peut plus être modifiée à ce stade");
      db.prepare(`UPDATE orders SET ship_name=?, ship_line1=?, ship_line2=?, ship_postal=?, ship_city=?, ship_country=?, ship_phone=?, updated_at=? WHERE id=?`)
        .run(a.name, a.line1, a.line2 || null, a.postal_code, a.city, a.country, a.phone || null, now(), orderId);
      addEvent(orderId, 'address', 'Adresse de livraison modifiée', actor || (byAdmin ? 'admin' : 'client'));
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    });
    mailer.T.addressChanged(o);
    return o;
  }

  return { isPremium, availableStock, eligibleZones, quote, priceCart, publicQuote, startCheckout, ensureStripeCustomer, markPaid, markProcessing,
    markPaymentFailed, markExpired, expireReservations, refund, applyRefund, syncStripeRefund, recomputeRefunds, setStatus, changeAddress,
    validateAddress, addEvent, STATUS_LABELS, ADMIN_STATUS_FLOW };
}

module.exports = { makeShop, STATUS_LABELS };
