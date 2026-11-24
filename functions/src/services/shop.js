'use strict';
// Logique métier sur Firestore : prix, livraison, réservations de stock (15 min), Stripe Checkout,
// encaissement, expiration et remboursements. Toute modification de stock passe par une transaction
// Firestore qui lit le document de la variante (verrou) : pas de survente possible.
const { now, bad, notFound, forbidden, conflict, HttpError, randomToken, euros, docData, newId } = require('../lib/util');

const STATUS_LABELS = {
  pending_payment: 'En attente de paiement', payment_processing: 'Paiement en cours de traitement',
  payment_failed: 'Paiement échoué', expired: 'Réservation expirée', cancelled: 'Annulée',
  paid: 'Payée', in_production: 'En impression', shipped: 'Expédiée', ready_for_pickup: 'Prête à retirer',
  delivered: 'Livrée', completed: 'Terminée',
};
const ADMIN_STATUS_FLOW = ['paid', 'in_production', 'shipped', 'ready_for_pickup', 'delivered', 'completed', 'cancelled'];
const ADDRESS_EDITABLE = new Set(['paid', 'in_production', 'payment_processing']);
const MIN_CHARGE_CENTS = 50;
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });

function isPremium(user) {
  const p = user && user.premium;
  return !!p && ['active', 'trialing'].includes(p.status) && (p.until || 0) > now();
}
// Stock disponible d'après le document variante (réservations actives des autres commandes déduites)
function available(v, { orderId = null, uid = null } = {}) {
  if (v.stock === null || v.stock === undefined) return Infinity;
  const t = now();
  let held = 0;
  for (const [oid, r] of Object.entries(v.reserved || {})) {
    if (oid === orderId || (uid && r.uid === uid) || r.exp <= t) continue;
    held += r.qty;
  }
  return Math.max(0, v.stock - held);
}
function event(o, type, message, actor = 'system') { o.events = [...(o.events || []), { type, message: message || null, actor, created_at: now() }]; }

function makeShop({ db, cfg, mailer, geo, stripe, settings, log = console }) {
  const C = (n) => db.collection(n);

  // ---------- Livraison ----------
  async function eligibleZones(address) {
    const zones = (await C('zones').where('active', '==', true).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.created_at || 0) - (b.created_at || 0));
    const s = await settings.get();
    const code = address && String(address.postal_code || '').trim();
    const country = address && String(address.country || 'BE').toUpperCase();
    let coords;
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
          else { distance = geo.haversineKm(Number(s.origin_lat), Number(s.origin_lng), coords.lat, coords.lng); ok = distance <= Number(z.radius_km || 0); if (!ok) reason = `Hors du rayon de ${z.radius_km} km`; }
        }
      }
      out.push({ id: z.id, name: z.name, kind: z.kind, description: z.description || null, price_cents: z.price_cents, free_above_cents: z.free_above_cents ?? null,
        eligible: ok, distance_km: distance == null ? null : Math.round(distance * 10) / 10, reason });
    }
    return out;
  }

  // ---------- Codes promo (pur : à partir du document) ----------
  function evaluatePromo(p, user, base, subtotal) {
    const t = now();
    if (!p || !p.active) return { error: 'Code promo invalide' };
    if (p.starts_at && t < p.starts_at) return { error: "Ce code n'est pas encore valable" };
    if (p.ends_at && t > p.ends_at) return { error: 'Ce code a expiré' };
    if (p.premium_only && !isPremium(user)) return { error: 'Code réservé aux membres Premium' };
    if (subtotal < (p.min_subtotal_cents || 0)) return { error: `Montant minimum requis : ${euros(p.min_subtotal_cents)}` };
    const live = Object.values(p.holds || {}).filter((h) => h.paid || h.exp > t);
    if (p.max_uses != null && live.length >= p.max_uses) return { error: "Ce code n'est plus disponible" };
    if (p.per_user_limit != null && user && live.filter((h) => h.uid === user.id).length >= p.per_user_limit) return { error: 'Vous avez déjà utilisé ce code' };
    const amount = p.type === 'percent' ? Math.floor((base * Math.min(p.value, 100)) / 100) : Math.min(p.value, base);
    return { promo: p, amount };
  }

  // Lit variantes, produits et code promo (dans une transaction si tx fourni)
  async function loadCart(tx, items, promoCode) {
    const get = (ref) => (tx ? tx.get(ref) : ref.get());
    const merged = new Map(), errors = [];
    for (const it of items || []) {
      const qty = Number(it.qty), vid = String(it.variantId || '');
      if (!vid || !Number.isInteger(qty) || qty < 1 || qty > 99) { errors.push({ variantId: it.variantId, message: 'Quantité invalide' }); continue; }
      merged.set(vid, (merged.get(vid) || 0) + qty);
    }
    const vids = [...merged.keys()];
    const vsnaps = vids.length ? (tx ? await tx.getAll(...vids.map((id) => C('variants').doc(id))) : await db.getAll(...vids.map((id) => C('variants').doc(id)))) : [];
    const variants = new Map(vsnaps.filter((s) => s.exists).map((s) => [s.id, { id: s.id, ...s.data() }]));
    const pids = [...new Set([...variants.values()].map((v) => v.product_id))];
    const psnaps = pids.length ? (tx ? await tx.getAll(...pids.map((id) => C('products').doc(id))) : await db.getAll(...pids.map((id) => C('products').doc(id)))) : [];
    const products = new Map(psnaps.filter((s) => s.exists).map((s) => [s.id, { id: s.id, ...s.data() }]));
    let promoDoc = null;
    if (promoCode) {
      const q = C('promos').where('code', '==', String(promoCode).trim().toUpperCase()).limit(1);
      const qs = tx ? await tx.get(q) : await q.get();
      if (!qs.empty) promoDoc = { id: qs.docs[0].id, ...qs.docs[0].data() };
    }
    void get;
    return { merged, variants, products, promoDoc, errors };
  }

  // Calcul pur du panier
  function priceCart(user, cart, { promoCode, zoneId, zones, custom, s }) {
    const errors = [...(cart ? cart.errors : [])];
    const premium = isPremium(user);
    let lines = [];
    if (custom) {
      lines = [{ variant_id: null, product_id: null, product_name: custom.name, variant_name: 'Commande sur mesure', sku: null, type: 'custom', unit_price_cents: custom.price_cents, qty: 1, line_total_cents: custom.price_cents, stock_tracked: false }];
    } else {
      if (cart.merged.size === 0 && !errors.length) errors.push({ message: 'Panier vide' });
      if (cart.merged.size > 50) errors.push({ message: 'Trop d’articles différents' });
      for (const [vid, qty] of cart.merged) {
        const v = cart.variants.get(vid); const p = v && cart.products.get(v.product_id);
        if (!v || !p || !v.active || !p.active) { errors.push({ variantId: vid, message: 'Article indisponible' }); continue; }
        if (p.premium_only && !premium) { errors.push({ variantId: vid, message: 'Article réservé aux membres Premium' }); continue; }
        if (p.type === 'digital' && qty !== 1) { errors.push({ variantId: vid, message: 'Un fichier numérique ne peut être acheté qu’une fois par commande' }); continue; }
        const tracked = p.type === 'physical' && v.stock !== null && v.stock !== undefined;
        if (tracked) {
          const avail = available(v, { uid: user && user.id });
          if (qty > avail) { errors.push({ variantId: vid, code: 'insufficient_stock', available: avail, message: avail ? `Plus que ${avail} en stock` : 'Rupture de stock' }); continue; }
        }
        lines.push({ variant_id: v.id, product_id: p.id, product_name: p.name, variant_name: v.name, sku: v.sku, type: p.type, unit_price_cents: v.price_cents, qty, line_total_cents: v.price_cents * qty, stock_tracked: tracked });
      }
    }
    const subtotal = lines.reduce((a, l) => a + l.line_total_cents, 0);
    const premiumDiscount = premium && !custom ? Math.floor((subtotal * Number(s.premium_discount_percent || 0)) / 100) : 0;
    let promo = null, promoDiscount = 0, promoError = null;
    if (promoCode && !custom) {
      const r = evaluatePromo(cart.promoDoc, user, subtotal - premiumDiscount, subtotal);
      if (r.error) promoError = r.error; else { promo = r.promo; promoDiscount = r.amount; }
    }
    const needsShipping = lines.some((l) => l.type === 'physical' || l.type === 'custom');
    let zone = null, shipping = 0;
    if (needsShipping) {
      if (zoneId == null) errors.push({ code: 'shipping_required', message: 'Choisissez un mode de livraison' });
      else {
        zone = zones.find((z) => z.id === String(zoneId));
        if (!zone) errors.push({ code: 'shipping_invalid', message: 'Mode de livraison inconnu' });
        else if (!zone.eligible) errors.push({ code: 'shipping_ineligible', message: zone.reason || 'Livraison indisponible pour cette adresse' });
        else {
          shipping = zone.price_cents;
          if (zone.free_above_cents != null && subtotal - premiumDiscount - promoDiscount >= zone.free_above_cents) shipping = 0;
          if (premium && s.premium_free_shipping) shipping = 0;
        }
      }
    }
    return { lines, subtotal, premium, premiumDiscount, promo, promoDiscount, promoError, needsShipping, zone, shipping, total: subtotal - premiumDiscount - promoDiscount + shipping, errors };
  }

  async function quote(user, body) {
    const zones = await eligibleZones(body.address || null);
    const cart = await loadCart(null, body.items || [], body.promoCode);
    const q = priceCart(user, cart, { promoCode: body.promoCode, zoneId: body.shippingZoneId, zones, s: await settings.get() });
    return { ...publicQuote(q), zones };
  }
  function publicQuote(q) {
    return { lines: q.lines.map(({ stock_tracked, ...l }) => l), subtotal_cents: q.subtotal, premium: q.premium, premium_discount_cents: q.premiumDiscount,
      promo_code: q.promo ? q.promo.code : null, promo_discount_cents: q.promoDiscount, promo_error: q.promoError, needs_shipping: q.needsShipping,
      shipping_cents: q.shipping, total_cents: q.total, errors: q.errors };
  }

  function validateAddress(a) {
    if (!a) throw bad('Adresse de livraison requise');
    const clean = {};
    for (const k of ['name', 'line1', 'line2', 'postal_code', 'city', 'country', 'phone']) clean[k] = a[k] == null ? '' : String(a[k]).trim().slice(0, 200);
    for (const k of ['name', 'line1', 'postal_code', 'city']) if (!clean[k]) throw bad('Adresse incomplète');
    clean.country = (clean.country || 'BE').toUpperCase();
    if (clean.country === 'BE' && !/^\d{4}$/.test(clean.postal_code)) throw bad('Code postal belge invalide (4 chiffres)');
    return clean;
  }

  async function ensureStripeCustomer(user) {
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const c = await stripe.customers.create({ email: user.email, name: user.name, metadata: { user_id: String(user.id) } }, { idempotencyKey: `customer-${user.id}` });
    return db.runTransaction(async (tx) => {
      const ref = C('users').doc(user.id); const u = (await tx.get(ref)).data();
      if (u.stripe_customer_id) return u.stripe_customer_id;
      tx.update(ref, { stripe_customer_id: c.id }); return c.id;
    });
  }

  // Libère la réservation d'une commande et change son statut (si la condition est remplie)
  async function releaseOrder(orderId, newStatus, message, { onlyIf = ['pending_payment'], actor = 'system' } = {}) {
    return db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o || o.payment_status !== 'unpaid' || !onlyIf.includes(o.status)) return false;
      const res = o.reserved_variants || [];
      const vsnaps = res.length ? await tx.getAll(...res.map((r) => C('variants').doc(r.variant_id))) : [];
      const pref = o.promo_id ? C('promos').doc(o.promo_id) : null;
      const promo = pref ? docData(await tx.get(pref)) : null;
      for (const s of vsnaps) if (s.exists) { const r = { ...(s.data().reserved || {}) }; delete r[orderId]; tx.update(s.ref, { reserved: r }); }
      if (promo) { const h = { ...(promo.holds || {}) }; delete h[orderId]; tx.update(pref, { holds: h }); }
      const { id, ...rest } = o; event(rest, newStatus, message, actor);
      tx.update(oref, { status: newStatus, events: rest.events, updated_at: now() });
      return true;
    });
  }

  // ---------- Création de commande + Stripe Checkout ----------
  async function startCheckout(user, body, { custom = null } = {}) {
    const s = await settings.get();
    if (s.require_email_verification && !user.email_verified_at) throw forbidden('Confirmez votre adresse e-mail avant de commander.');
    const key = String(body.checkoutKey || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw bad('Clé de paiement invalide');
    let address = body.address || null;
    if (body.addressId) {
      const a = docData(await C('addresses').doc(String(body.addressId)).get());
      if (!a || a.uid !== user.id) throw bad('Adresse introuvable');
      address = a;
    }
    const zones = await eligibleZones(address);

    const res = await db.runTransaction(async (tx) => {
      const kref = C('checkout_keys').doc(`${user.id}_${key}`);
      const ks = await tx.get(kref);
      if (ks.exists) { const o = docData(await tx.get(C('orders').doc(ks.data().order_id))); return { existing: o }; }
      const cart = custom ? { merged: new Map(), variants: new Map(), products: new Map(), promoDoc: null, errors: [] } : await loadCart(tx, body.items, body.promoCode);
      const cref = C('counters').doc('orders');
      const counter = await tx.get(cref);
      const q = priceCart(user, cart, { promoCode: body.promoCode, zoneId: body.shippingZoneId, zones, custom, s });
      if (q.promoError) throw new HttpError(409, q.promoError, 'promo_invalid');
      if (q.errors.length) { const e = new HttpError(409, q.errors[0].message, q.errors[0].code || 'cart_invalid'); e.details = q.errors; throw e; }
      if (q.total < MIN_CHARGE_CENTS) throw bad('Le montant minimum de paiement est de 0,50 €');
      const a = q.needsShipping && q.zone && q.zone.kind !== 'pickup' ? validateAddress(address) : null;
      const t = now(), exp = t + cfg.reservationMinutes * 60;
      const n = (counter.exists ? counter.data().n : 0) + 1;
      const orderId = newId();
      const number = `HS-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
      const reserved = q.lines.filter((l) => l.stock_tracked).map((l) => ({ variant_id: l.variant_id, qty: l.qty }));
      const order = {
        number, uid: user.id, checkout_key: key, status: 'pending_payment', payment_status: 'unpaid',
        subtotal_cents: q.subtotal, premium_discount_cents: q.premiumDiscount, discount_cents: q.promoDiscount, shipping_cents: q.shipping, total_cents: q.total, refunded_cents: 0,
        promo_id: q.promo ? q.promo.id : null, promo_code: q.promo ? q.promo.code : null,
        shipping_zone_id: q.zone ? q.zone.id : null, shipping_method: q.zone ? q.zone.name : null, needs_shipping: q.needsShipping,
        ship_name: a ? a.name : (q.needsShipping ? user.name : null), ship_line1: a ? a.line1 : null, ship_line2: a ? a.line2 || null : null,
        ship_postal: a ? a.postal_code : null, ship_city: a ? a.city : null, ship_country: a ? a.country || 'BE' : null, ship_phone: a ? a.phone || null : null,
        email: user.email, stripe_session_id: null, stripe_session_url: null, stripe_payment_intent: null, stripe_coupon_id: null,
        reservation_expires_at: exp, paid_at: null, tracking_carrier: null, tracking_number: null, tracking_url: null,
        customer_note: body.note ? String(body.note).slice(0, 1000) : null, admin_note: null, custom_request_id: custom ? custom.requestId : null,
        items: q.lines.map(({ stock_tracked, ...l }, i) => ({ id: String(i + 1), ...l })), reserved_variants: reserved, consumed: [], refunds: [], events: [],
        created_at: t, updated_at: t,
      };
      event(order, 'created', `Commande créée, stock réservé 15 minutes (jusqu'à ${hhmm(exp)})`);
      tx.set(cref, { n });
      tx.create(kref, { order_id: orderId, created_at: t });
      for (const r of reserved) { const v = cart.variants.get(r.variant_id); tx.update(C('variants').doc(r.variant_id), { reserved: { ...(v.reserved || {}), [orderId]: { qty: r.qty, exp, uid: user.id } } }); }
      if (q.promo) tx.update(C('promos').doc(q.promo.id), { holds: { ...(q.promo.holds || {}), [orderId]: { uid: user.id, exp, paid: false } } });
      tx.set(C('orders').doc(orderId), order);
      return { order: { id: orderId, ...order }, lines: q.lines };
    });

    if (res.existing) {
      const o = res.existing;
      if (o.status === 'pending_payment' && o.stripe_session_url && o.reservation_expires_at > now()) return { url: o.stripe_session_url, number: o.number, reused: true };
      if (o.status === 'pending_payment' && !o.stripe_session_url) throw conflict('Paiement en cours de préparation, réessayez dans un instant.', 'checkout_in_progress');
      throw conflict('Cette tentative de paiement est terminée. Rechargez le panier pour recommencer.', 'checkout_closed');
    }
    const o = res.order;
    // Une seule commande en attente par client : les précédentes sont annulées et leur stock libéré
    const previous = (await C('orders').where('uid', '==', user.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((x) => x.status === 'pending_payment' && x.id !== o.id);
    for (const p of previous) {
      if (await releaseOrder(p.id, 'cancelled', 'Remplacée par une nouvelle tentative de paiement') && p.stripe_session_id) stripe.checkout.sessions.expire(p.stripe_session_id).catch(() => {});
    }
    try {
      const customer = await ensureStripeCustomer(user);
      const discount = o.premium_discount_cents + o.discount_cents;
      let coupon = null;
      if (discount > 0) coupon = await stripe.coupons.create({ amount_off: discount, currency: 'eur', duration: 'once', max_redemptions: 1, name: `Remises ${o.number}`.slice(0, 40), metadata: { order_id: o.id } }, { idempotencyKey: `coupon-order-${o.id}` });
      const params = {
        mode: 'payment', customer, client_reference_id: o.id, locale: 'fr',
        line_items: res.lines.map((l) => ({ quantity: l.qty, price_data: { currency: 'eur', unit_amount: l.unit_price_cents, product_data: { name: `${l.product_name}${l.variant_name ? ' — ' + l.variant_name : ''}`.slice(0, 250) } } })),
        metadata: { order_id: o.id, order_number: o.number, kind: 'order' },
        payment_intent_data: { metadata: { order_id: o.id, order_number: o.number } },
        expires_at: now() + 31 * 60, // minimum Stripe : 30 min ; la réservation de 15 min est gérée par le serveur
        success_url: `${cfg.appUrl}/?paiement=ok#commande-${o.number}`,
        cancel_url: `${cfg.appUrl}/?paiement=annule#panier`,
      };
      if (coupon) params.discounts = [{ coupon: coupon.id }];
      if (o.needs_shipping) params.shipping_options = [{ shipping_rate_data: { type: 'fixed_amount', display_name: (o.shipping_method || 'Livraison').slice(0, 100), fixed_amount: { amount: o.shipping_cents, currency: 'eur' } } }];
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-order-${o.id}` });
      await C('orders').doc(o.id).update({ stripe_session_id: session.id, stripe_session_url: session.url, stripe_coupon_id: coupon ? coupon.id : null, updated_at: now() });
      return { url: session.url, number: o.number };
    } catch (e) {
      await releaseOrder(o.id, 'cancelled', `Erreur Stripe : ${String(e.message).slice(0, 200)}`);
      log.error('[checkout] Stripe error', e.message);
      throw new HttpError(502, 'Le service de paiement est indisponible. Aucun montant n’a été prélevé.', 'stripe_error');
    }
  }

  // ---------- Encaissement (webhook) ----------
  async function markPaid(orderId, session) {
    const out = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o) return { skip: true };
      if (o.payment_status !== 'unpaid') return { already: true };
      const need = new Map();
      for (const r of o.reserved_variants || []) need.set(r.variant_id, (need.get(r.variant_id) || 0) + r.qty);
      const vsnaps = need.size ? await tx.getAll(...[...need.keys()].map((id) => C('variants').doc(id))) : [];
      const digitalPids = [...new Set(o.items.filter((i) => i.type === 'digital' && i.product_id).map((i) => i.product_id))];
      const psnaps = digitalPids.length ? await tx.getAll(...digitalPids.map((id) => C('products').doc(id))) : [];
      const pref = o.promo_id ? C('promos').doc(o.promo_id) : null;
      const promo = pref ? docData(await tx.get(pref)) : null;
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent && session.payment_intent.id;
      const mismatch = Number(session.amount_total) !== o.total_cents;
      const t = now();
      const feasible = vsnaps.every((s) => s.exists && (s.data().stock === null || available(s.data(), { orderId }) >= need.get(s.id)));
      const { id, ...upd } = o;
      if (!feasible) {
        for (const s of vsnaps) if (s.exists) { const r = { ...(s.data().reserved || {}) }; delete r[orderId]; tx.update(s.ref, { reserved: r }); }
        if (promo) { const h = { ...(promo.holds || {}) }; delete h[orderId]; tx.update(pref, { holds: h }); }
        event(upd, 'out_of_stock', 'Paiement reçu après expiration de la réservation et stock insuffisant : remboursement automatique');
        Object.assign(upd, { status: 'cancelled', payment_status: 'paid', paid_at: t, stripe_payment_intent: pi, updated_at: t });
        tx.set(oref, upd);
        return { oos: true, o: { id: orderId, ...upd } };
      }
      for (const s of vsnaps) {
        const v = s.data(); const r = { ...(v.reserved || {}) }; delete r[orderId];
        if (v.stock === null || v.stock === undefined) { tx.update(s.ref, { reserved: r }); continue; }
        tx.update(s.ref, { stock: v.stock - need.get(s.id), reserved: r });
      }
      if (promo) tx.update(pref, { holds: { ...(promo.holds || {}), [orderId]: { uid: o.uid, exp: t, paid: true } } });
      const maxDl = Number((await settings.get()).download_max_count) || 10;
      for (const ps of psnaps) for (const f of (ps.exists && ps.data().files) || []) {
        tx.set(C('downloads').doc(`${orderId}_${f.id}`), { order_id: orderId, order_number: o.number, uid: o.uid, product_id: ps.id, product_name: ps.data().name, file_id: f.id, filename: f.filename, original_name: f.original_name, size: f.size, count: 0, max_count: maxDl, revoked: false, created_at: t });
      }
      if (o.custom_request_id) tx.update(C('custom_requests').doc(o.custom_request_id), { status: 'paid', updated_at: t });
      const allDigital = o.items.every((i) => i.type === 'digital');
      event(upd, 'paid', `Paiement reçu (${euros(session.amount_total)})` + (mismatch ? ' — ATTENTION : montant différent du total calculé' : ''));
      Object.assign(upd, { status: allDigital ? 'completed' : 'paid', payment_status: 'paid', paid_at: t, stripe_payment_intent: pi, reservation_expires_at: null,
        consumed: [...need].map(([variant_id, qty]) => ({ variant_id, qty })).filter((c) => vsnaps.find((s) => s.id === c.variant_id && s.data().stock !== null)), updated_at: t });
      tx.set(oref, upd);
      return { paid: true, o: { id: orderId, ...upd }, mismatch };
    });
    if (out.paid) {
      await mailer.T.orderPaid(out.o);
      await mailer.T.adminNotify(`Nouvelle commande ${out.o.number}`, `Montant : ${euros(out.o.total_cents)}` + (out.mismatch ? ' (montant Stripe différent : à vérifier)' : ''));
    }
    if (out.oos) {
      await refund(out.o.id, out.o.total_cents, { reason: 'Rupture de stock après expiration de la réservation', actor: 'system', notify: false });
      await mailer.T.outOfStockRefund(out.o);
    }
    return out;
  }

  async function markProcessing(orderId) {
    await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o || o.payment_status !== 'unpaid' || !['pending_payment', 'expired'].includes(o.status)) return;
      const vsnaps = (o.reserved_variants || []).length ? await tx.getAll(...o.reserved_variants.map((r) => C('variants').doc(r.variant_id))) : [];
      const until = now() + 7 * 86400;
      for (const s of vsnaps) if (s.exists) {
        const r = o.reserved_variants.find((x) => x.variant_id === s.id);
        tx.update(s.ref, { reserved: { ...(s.data().reserved || {}), [orderId]: { qty: r.qty, exp: until, uid: o.uid } } });
      }
      const { id, ...upd } = o; event(upd, 'payment_processing', 'Paiement différé en cours de traitement (stock conservé 7 jours)');
      tx.update(oref, { status: 'payment_processing', reservation_expires_at: null, events: upd.events, updated_at: now() });
    });
  }
  const markPaymentFailed = (orderId) => releaseOrder(orderId, 'payment_failed', 'Le paiement différé a échoué', { onlyIf: ['pending_payment', 'payment_processing', 'expired'] });
  const markExpired = (orderId, reason = 'Session de paiement expirée') => releaseOrder(orderId, 'expired', reason);

  async function expireReservations() {
    const due = (await C('orders').where('status', '==', 'pending_payment').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((o) => o.reservation_expires_at && o.reservation_expires_at <= now());
    for (const o of due) {
      if (await markExpired(o.id, 'Réservation de 15 minutes expirée') && o.stripe_session_id) {
        try { await stripe.checkout.sessions.expire(o.stripe_session_id); } catch { /* déjà payée ou expirée : le webhook tranche */ }
      }
    }
    return due.length;
  }

  // ---------- Remboursements ----------
  function recompute(o) {
    const refunded = (o.refunds || []).filter((r) => r.status === 'succeeded').reduce((a, r) => a + r.amount_cents, 0);
    let ps = o.payment_status;
    if (ps !== 'unpaid') ps = refunded >= o.total_cents ? 'refunded' : refunded > 0 ? 'partially_refunded' : 'paid';
    let status = o.status;
    if (ps === 'refunded' && ['paid', 'in_production', 'payment_processing', 'ready_for_pickup'].includes(status)) status = 'cancelled';
    return { refunded_cents: refunded, payment_status: ps, status };
  }

  async function applyRefund(orderId, refundId, notify = true) {
    const res = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o) return null;
      const r = (o.refunds || []).find((x) => x.id === refundId);
      if (!r || r.status !== 'succeeded' || r.applied) return null;
      const consumed = r.restock ? o.consumed || [] : [];
      const vsnaps = consumed.length ? await tx.getAll(...consumed.map((c) => C('variants').doc(c.variant_id))) : [];
      const after = { ...o, refunds: o.refunds.map((x) => (x.id === refundId ? { ...x, applied: true, updated_at: now() } : x)) };
      Object.assign(after, recompute(after));
      const dls = after.payment_status === 'refunded' ? (await tx.get(C('downloads').where('order_id', '==', orderId))).docs : [];
      for (const s of vsnaps) if (s.exists && s.data().stock !== null) tx.update(s.ref, { stock: s.data().stock + consumed.find((c) => c.variant_id === s.id).qty });
      if (r.restock) after.consumed = [];
      for (const d of dls) tx.update(d.ref, { revoked: true });
      event(after, 'refunded', `Remboursement de ${euros(r.amount_cents)} effectué` + (r.restock ? ' (articles remis en stock)' : ''), r.created_by);
      after.updated_at = now();
      const { id, ...data } = after;
      tx.set(oref, data);
      tx.set(C('refund_log').doc(refundId), { order_id: orderId, amount_cents: r.amount_cents, at: now() });
      return { r, o: after, full: after.payment_status === 'refunded' };
    });
    if (res && notify) await mailer.T.refund(res.o, res.r.amount_cents, res.full);
    return res;
  }

  async function refund(orderId, amountCents, { reason = '', restock = false, actor = 'admin', notify = true } = {}) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Montant de remboursement invalide');
    const prep = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o) throw notFound('Commande introuvable');
      if (!['paid', 'partially_refunded'].includes(o.payment_status)) throw conflict('Cette commande ne peut pas être remboursée');
      if (!o.stripe_payment_intent) throw conflict('Paiement Stripe introuvable pour cette commande');
      const engaged = (o.refunds || []).filter((r) => ['pending', 'succeeded', 'requires_action'].includes(r.status)).reduce((a, r) => a + r.amount_cents, 0);
      const remaining = o.total_cents - engaged;
      if (amount > remaining) throw bad(`Montant trop élevé : ${euros(remaining)} remboursables au maximum`);
      if (restock && amount !== remaining) throw bad('La remise en stock n’est possible que pour un remboursement du solde complet');
      const t = now();
      const entry = { id: newId(), amount_cents: amount, reason: String(reason || '').slice(0, 500), status: 'pending', stripe_refund_id: null,
        idempotency_key: `refund-${orderId}-${randomToken(9)}`, restock: !!restock, applied: false, created_by: actor, error: null, created_at: t, updated_at: t };
      tx.update(oref, { refunds: [...(o.refunds || []), entry], updated_at: t });
      return { entry, pi: o.stripe_payment_intent };
    });
    const setEntry = (patch) => db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId); const o = (await tx.get(oref)).data();
      tx.update(oref, { refunds: o.refunds.map((x) => (x.id === prep.entry.id ? { ...x, ...patch, updated_at: now() } : x)) });
    });
    let r;
    try {
      r = await stripe.refunds.create({ payment_intent: prep.pi, amount, reason: 'requested_by_customer', metadata: { order_id: orderId, refund_id: prep.entry.id } }, { idempotencyKey: prep.entry.idempotency_key });
    } catch (e) {
      await setEntry({ status: 'failed', error: String(e.message).slice(0, 500) });
      throw new HttpError(502, `Stripe a refusé le remboursement : ${e.message}`, 'stripe_error');
    }
    const st = ['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(r.status) ? r.status : 'pending';
    await setEntry({ stripe_refund_id: r.id, status: st });
    if (st === 'succeeded') await applyRefund(orderId, prep.entry.id, notify);
    return { ...prep.entry, stripe_refund_id: r.id, status: st };
  }

  async function syncStripeRefund(sr) {
    const st = ['succeeded', 'pending', 'failed', 'canceled', 'requires_action'].includes(sr.status) ? sr.status : 'pending';
    let orderId = sr.metadata && sr.metadata.order_id;
    if (!orderId) {
      const pi = typeof sr.payment_intent === 'string' ? sr.payment_intent : sr.payment_intent && sr.payment_intent.id;
      if (!pi) return null;
      const qs = await C('orders').where('stripe_payment_intent', '==', pi).limit(1).get();
      if (qs.empty) return null;
      orderId = qs.docs[0].id;
    }
    const refundId = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const o = docData(await tx.get(oref));
      if (!o) return null;
      let refunds = [...(o.refunds || [])];
      let entry = refunds.find((x) => x.stripe_refund_id === sr.id) || (sr.metadata && sr.metadata.refund_id && refunds.find((x) => x.id === sr.metadata.refund_id));
      const t = now();
      if (!entry) {
        entry = { id: newId(), amount_cents: sr.amount, reason: 'Créé depuis le Dashboard Stripe', status: st, stripe_refund_id: sr.id, idempotency_key: `stripe-${sr.id}`, restock: false, applied: false, created_by: 'stripe', error: null, created_at: t, updated_at: t };
        refunds.push(entry);
      } else refunds = refunds.map((x) => (x.id === entry.id ? { ...x, status: st, stripe_refund_id: sr.id, updated_at: t } : x));
      const after = { ...o, refunds };
      if (st !== 'succeeded') Object.assign(after, recompute(after));
      const { id, ...data } = after;
      tx.set(oref, data);
      return entry.id;
    });
    if (refundId && st === 'succeeded') await applyRefund(orderId, refundId);
    return refundId;
  }

  // ---------- Statuts / adresses ----------
  async function setStatus(orderId, status, { tracking_carrier, tracking_number, tracking_url, actor = 'admin', message } = {}) {
    if (!ADMIN_STATUS_FLOW.includes(status)) throw bad('Statut invalide');
    if (tracking_url && !/^https:\/\//.test(tracking_url)) throw bad('Le lien de suivi doit commencer par https://');
    const o = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const cur = docData(await tx.get(oref));
      if (!cur) throw notFound();
      if (cur.payment_status === 'unpaid') throw conflict('Commande non payée');
      const { id, ...upd } = cur;
      Object.assign(upd, { status, tracking_carrier: tracking_carrier || cur.tracking_carrier, tracking_number: tracking_number || cur.tracking_number, tracking_url: tracking_url || cur.tracking_url, updated_at: now() });
      event(upd, 'status', `${STATUS_LABELS[status]}${message ? ' — ' + message : ''}`, actor);
      tx.set(oref, upd);
      return { id, ...upd };
    });
    let extra = message || '';
    if (o.tracking_number) extra += `${extra ? '\n' : ''}Suivi : ${o.tracking_carrier || ''} ${o.tracking_number}${o.tracking_url ? ' — ' + o.tracking_url : ''}`;
    await mailer.T.orderStatus(o, STATUS_LABELS[status], extra || null);
    return o;
  }

  async function changeAddress(orderId, address, { byAdmin = false, userId = null, actor } = {}) {
    const a = validateAddress(address);
    const o0 = docData(await C('orders').doc(orderId).get());
    if (!o0 || (!byAdmin && o0.uid !== userId)) throw notFound('Commande introuvable');
    if (!o0.needs_shipping) throw conflict('Cette commande ne nécessite pas de livraison');
    if (!byAdmin) {
      if (!ADDRESS_EDITABLE.has(o0.status)) throw conflict("L'adresse ne peut plus être modifiée à ce stade");
      const zone = (await eligibleZones(a)).find((x) => x.id === o0.shipping_zone_id);
      if (zone && zone.kind === 'pickup') throw conflict('Commande en retrait sur place : aucune adresse de livraison');
      if (!zone || !zone.eligible) throw conflict('La nouvelle adresse est hors de la zone de livraison choisie. Contactez-nous.');
    }
    const o = await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId);
      const cur = docData(await tx.get(oref));
      if (!byAdmin && !ADDRESS_EDITABLE.has(cur.status)) throw conflict("L'adresse ne peut plus être modifiée à ce stade");
      const { id, ...upd } = cur;
      Object.assign(upd, { ship_name: a.name, ship_line1: a.line1, ship_line2: a.line2 || null, ship_postal: a.postal_code, ship_city: a.city, ship_country: a.country, ship_phone: a.phone || null, updated_at: now() });
      event(upd, 'address', 'Adresse de livraison modifiée', actor || (byAdmin ? 'admin' : 'client'));
      tx.set(oref, upd);
      return { id, ...upd };
    });
    await mailer.T.addressChanged(o);
    return o;
  }

  async function addEvent(orderId, type, message, actor) {
    await db.runTransaction(async (tx) => {
      const oref = C('orders').doc(orderId); const o = (await tx.get(oref)).data();
      const tmp = { events: o.events || [] }; event(tmp, type, message, actor);
      tx.update(oref, { events: tmp.events });
    });
  }

  return { isPremium, available, eligibleZones, quote, priceCart, publicQuote, startCheckout, ensureStripeCustomer, releaseOrder, markPaid, markProcessing,
    markPaymentFailed, markExpired, expireReservations, refund, applyRefund, syncStripeRefund, setStatus, changeAddress, validateAddress, addEvent,
    STATUS_LABELS, ADMIN_STATUS_FLOW };
}

module.exports = { makeShop, STATUS_LABELS, isPremium, available };
