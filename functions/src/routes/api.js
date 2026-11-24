'use strict';
// API publique et espace client (Firestore).
const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { now, bad, notFound, conflict, forbidden, randomToken, sha256, hashPassword, verifyPassword, dummyVerify, HttpError, docData, list, newId } = require('../lib/util');

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) { const i = r.error.issues[0]; throw bad(`${i.path.join('.') || 'données'} : ${i.message}`, 'validation'); }
  return r.data;
}
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = z.string().trim().min(1).max(80);
const emailS = z.string().trim().toLowerCase().email().max(200);
const passwordS = z.string().min(10, 'au moins 10 caractères').max(200);
const addressS = z.object({
  label: z.string().trim().max(60).optional().nullable(), name: z.string().trim().min(1).max(120), line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional().nullable(), postal_code: z.string().trim().regex(/^\d{4}$/, 'code postal belge à 4 chiffres'),
  city: z.string().trim().min(1).max(120), country: z.literal('BE').default('BE'), phone: z.string().trim().max(40).optional().nullable(),
});
const itemsS = z.array(z.object({ variantId: id, qty: z.coerce.number().int().min(1).max(99) })).max(50);

function makeApi({ db, cfg, auth, shop, premium, mailer, uploads, audit, stripe, settings }) {
  const r = express.Router();
  const C = (n) => db.collection(n);
  const rl = cfg.rateLimits || {};
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Trop de tentatives. Réessayez plus tard.' }, validate: false });
  const loginLimiter = limiter(15 * 60 * 1000, rl.login ?? 10);
  const registerLimiter = limiter(60 * 60 * 1000, rl.register ?? 10);
  const mailLimiter = limiter(60 * 60 * 1000, rl.mail ?? 5);

  const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, email_verified: !!u.email_verified_at, premium: shop.isPremium(u),
    premium_status: u.premium ? u.premium.status : null, premium_until: u.premium ? u.premium.until : null, premium_cancel_at_period_end: !!(u.premium && u.premium.cancel_at_period_end) });
  const getUser = async (uid) => docData(await C('users').doc(uid).get());

  // ---------- Configuration ----------
  r.get('/config', asyncH(async (req, res) => {
    const s = await settings.get();
    res.json({ shop_name: s.shop_name, tagline: s.shop_tagline, contact_email: s.contact_email, shop_address: s.shop_address,
      premium: { enabled: !!s.premium_enabled, price_cents: s.premium_price_cents, interval: s.premium_interval, discount_percent: s.premium_discount_percent, free_shipping: !!s.premium_free_shipping },
      materials: s.materials, colors: s.colors, max_print_dimensions_mm: s.max_print_dimensions_mm, terms_text: s.terms_text,
      require_email_verification: !!s.require_email_verification, reservation_minutes: cfg.reservationMinutes,
      payments_configured: !!cfg.stripeSecretKey || !!cfg.stripeInjected, user: publicUser(req.user) });
  }));

  // ---------- Catalogue ----------
  async function catalog() {
    const [cats, prods, vars] = await Promise.all([C('categories').get(), C('products').where('active', '==', true).get(), C('variants').where('active', '==', true).get()]);
    const categories = new Map(list(cats).map((c) => [c.id, c]));
    const byProduct = new Map();
    for (const v of list(vars)) { if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []); byProduct.get(v.product_id).push(v); }
    return list(prods).map((p) => {
      const c = categories.get(p.category_id);
      const variants = (byProduct.get(p.id) || []).sort((a, b) => (a.sort || 0) - (b.sort || 0)).map((v) => {
        const avail = p.type === 'digital' ? null : shop.available(v);
        return { id: v.id, name: v.name, sku: v.sku, price_cents: v.price_cents, compare_at_cents: v.compare_at_cents ?? null, available: avail === Infinity ? null : avail, in_stock: p.type === 'digital' || avail === Infinity || avail > 0 };
      });
      return { id: p.id, slug: p.slug, name: p.name, description: p.description || '', type: p.type, material: p.material || null, featured: !!p.featured, premium_only: !!p.premium_only,
        category: c && c.active ? { slug: c.slug, name: c.name } : null, created_at: p.created_at,
        images: (p.images || []).map((i) => ({ url: `/uploads/images/${i.filename}`, alt: i.alt || p.name })), variants, files_count: p.type === 'digital' ? (p.files || []).length : 0 };
    }).filter((p) => p.variants.length);
  }

  r.get('/categories', asyncH(async (req, res) => {
    const prods = await catalog();
    const cats = list(await C('categories').where('active', '==', true).get()).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
    res.json(cats.map((c) => ({ slug: c.slug, name: c.name, description: c.description || null, count: prods.filter((p) => p.category && p.category.slug === c.slug).length })));
  }));

  r.get('/products', asyncH(async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), category: z.string().max(80).optional(), sort: z.enum(['featured', 'price_asc', 'price_desc', 'new', 'name']).optional(),
      type: z.enum(['physical', 'digital']).optional(), page: z.coerce.number().int().min(1).max(1000).optional(), per: z.coerce.number().int().min(1).max(60).optional() }), req.query);
    let items = await catalog();
    if (q.category) items = items.filter((p) => p.category && p.category.slug === q.category);
    if (q.type) items = items.filter((p) => p.type === q.type);
    if (q.q) { const terms = q.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6); items = items.filter((p) => terms.every((t) => `${p.name} ${p.description} ${p.material || ''} ${p.category ? p.category.name : ''}`.toLowerCase().includes(t))); }
    const min = (p) => Math.min(...p.variants.map((v) => v.price_cents));
    const sorters = { featured: (a, b) => (b.featured - a.featured) || (b.created_at - a.created_at), price_asc: (a, b) => min(a) - min(b), price_desc: (a, b) => min(b) - min(a), new: (a, b) => b.created_at - a.created_at, name: (a, b) => a.name.localeCompare(b.name, 'fr') };
    items.sort(sorters[q.sort || 'featured']);
    const per = q.per || 24, page = q.page || 1;
    res.json({ total: items.length, page, per, items: items.slice((page - 1) * per, page * per).map((p) => ({ id: p.id, slug: p.slug, name: p.name, type: p.type, material: p.material, featured: p.featured,
      premium_only: p.premium_only, category: p.category, image: p.images[0] || null, price_from_cents: min(p), in_stock: p.variants.some((v) => v.in_stock), variants_count: p.variants.length })) });
  }));

  r.get('/products/:slug', asyncH(async (req, res) => {
    const p = (await catalog()).find((x) => x.slug === String(req.params.slug));
    if (!p) throw notFound('Produit introuvable');
    res.json(p);
  }));

  // ---------- Panier ----------
  r.post('/shipping/options', asyncH(async (req, res) => {
    const b = parse(z.object({ postal_code: z.string().trim().max(10).optional().default(''), country: z.string().trim().max(2).optional().default('BE') }), req.body);
    res.json(await shop.eligibleZones(b.postal_code ? b : null));
  }));
  r.post('/cart/quote', asyncH(async (req, res) => {
    const b = parse(z.object({ items: itemsS, promoCode: z.string().trim().max(40).optional().nullable(), shippingZoneId: id.optional().nullable(), postal_code: z.string().trim().max(10).optional().nullable() }), req.body);
    res.json(await shop.quote(req.user, { items: b.items, promoCode: b.promoCode || null, shippingZoneId: b.shippingZoneId ?? null, address: b.postal_code ? { postal_code: b.postal_code, country: 'BE' } : null }));
  }));

  // ---------- Authentification ----------
  async function sendVerification(user) {
    const token = randomToken(32);
    await C('tokens').doc(sha256(token)).set({ uid: user.id, type: 'verify', expires_at: now() + 86400, used_at: null });
    await mailer.T.verify(user, `${cfg.appUrl}/api/auth/verify?token=${token}`);
  }

  r.post('/auth/register', registerLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS, password: passwordS, name: z.string().trim().min(1).max(120), newsletter: z.boolean().optional(), accept_terms: z.literal(true, { message: 'acceptez les conditions générales' }) }), req.body);
    const hash = await hashPassword(b.password, cfg.scrypt);
    const uid = newId();
    const user = { email: b.email, password_hash: hash, name: b.name, role: 'customer', email_verified_at: null, disabled: false, stripe_customer_id: null, premium: null, created_at: now(), deleted_at: null };
    await db.runTransaction(async (tx) => {
      const eref = C('user_emails').doc(b.email);
      if ((await tx.get(eref)).exists) throw conflict('Un compte existe déjà avec cette adresse', 'email_taken');
      tx.create(eref, { uid }); tx.set(C('users').doc(uid), user);
    });
    await sendVerification({ id: uid, ...user });
    if (b.newsletter) await subscribeNewsletter(b.email, uid);
    await auth.createSession(req, res, uid);
    res.status(201).json({ user: publicUser({ id: uid, ...user }) });
  }));

  async function userByEmail(email) {
    const e = await C('user_emails').doc(email).get();
    return e.exists ? getUser(e.data().uid) : null;
  }

  r.post('/auth/login', loginLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS, password: z.string().min(1).max(200) }), req.body);
    const u = await userByEmail(b.email);
    const ok = u && !u.deleted_at ? await verifyPassword(b.password, u.password_hash) : await dummyVerify(b.password, cfg.scrypt);
    if (!ok || !u || u.deleted_at) throw new HttpError(401, 'E-mail ou mot de passe incorrect', 'bad_credentials');
    if (u.disabled) throw forbidden('Ce compte est désactivé');
    if (req.sessionHash) await C('sessions').doc(req.sessionHash).delete();
    await auth.createSession(req, res, u.id);
    if (u.role === 'admin') await audit(u.id, 'admin_login', null, req.ip);
    res.json({ user: publicUser(u) });
  }));
  r.post('/auth/logout', asyncH(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));

  r.get('/auth/verify', asyncH(async (req, res) => {
    const ref = C('tokens').doc(sha256(String(req.query.token || '')));
    const ok = await db.runTransaction(async (tx) => {
      const t = docData(await tx.get(ref));
      if (!t || t.type !== 'verify' || t.used_at || t.expires_at < now()) return false;
      const uref = C('users').doc(t.uid); const u = (await tx.get(uref)).data();
      const upd = { email_verified_at: u.email_verified_at || now() };
      // Premier administrateur : l'adresse définie dans ADMIN_EMAIL devient admin une fois sa boîte mail prouvée.
      if (cfg.adminEmail && u.email === cfg.adminEmail && u.role !== 'admin' && !u.disabled) upd.role = 'admin';
      tx.update(ref, { used_at: now() }); tx.update(uref, upd);
      return true;
    });
    res.redirect(302, ok ? '/?verification=ok#compte' : '/?verification=invalide#compte');
  }));
  r.post('/auth/verify/resend', mailLimiter, auth.requireUser, asyncH(async (req, res) => {
    if (req.user.email_verified_at) return res.json({ ok: true, already: true });
    await sendVerification(req.user); res.json({ ok: true });
  }));
  r.post('/auth/password/forgot', mailLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS }), req.body);
    const u = await userByEmail(b.email);
    if (u && !u.deleted_at && !u.disabled) {
      const token = randomToken(32);
      await C('tokens').doc(sha256(token)).set({ uid: u.id, type: 'reset', expires_at: now() + 3600, used_at: null });
      await mailer.T.reset(u, `${cfg.appUrl}/?reinitialisation=${token}#mot-de-passe`);
    }
    res.json({ ok: true });
  }));
  r.post('/auth/password/reset', loginLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ token: z.string().min(10).max(100), password: passwordS }), req.body);
    const hash = await hashPassword(b.password, cfg.scrypt);
    const ref = C('tokens').doc(sha256(b.token));
    const uid = await db.runTransaction(async (tx) => {
      const t = docData(await tx.get(ref));
      if (!t || t.type !== 'reset' || t.used_at || t.expires_at < now()) throw bad('Lien invalide ou expiré', 'token_invalid');
      const uref = C('users').doc(t.uid); const u = (await tx.get(uref)).data();
      tx.update(ref, { used_at: now() }); tx.update(uref, { password_hash: hash, email_verified_at: u.email_verified_at || now() });
      return t.uid;
    });
    await auth.destroyAllSessions(uid);
    res.json({ ok: true });
  }));

  // ---------- Profil ----------
  r.get('/me', auth.requireUser, (req, res) => res.json(publicUser(req.user)));
  r.patch('/me', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    await C('users').doc(req.user.id).update({ name: b.name });
    res.json(publicUser({ ...req.user, name: b.name }));
  }));
  r.post('/me/password', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ current: z.string().min(1).max(200), password: passwordS }), req.body);
    if (!(await verifyPassword(b.current, req.user.password_hash))) throw new HttpError(401, 'Mot de passe actuel incorrect', 'bad_credentials');
    await C('users').doc(req.user.id).update({ password_hash: await hashPassword(b.password, cfg.scrypt) });
    await auth.destroyAllSessions(req.user.id, req.sessionHash);
    res.json({ ok: true });
  }));
  r.delete('/me', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    if (!(await verifyPassword(b.password, req.user.password_hash))) throw new HttpError(401, 'Mot de passe incorrect', 'bad_credentials');
    if (req.user.role === 'admin') throw forbidden('Un administrateur ne peut pas supprimer son compte ici');
    if (shop.isPremium(req.user) && !req.user.premium.cancel_at_period_end) throw conflict('Résiliez d’abord votre abonnement Premium');
    const u = req.user;
    const nl = await C('newsletter').doc(u.email).get();
    if (nl.exists) await nl.ref.update({ status: 'unsubscribed' });
    for (const a of (await C('addresses').where('uid', '==', u.id).get()).docs) await a.ref.delete();
    await auth.destroyAllSessions(u.id);
    await C('user_emails').doc(u.email).delete();
    await C('users').doc(u.id).update({ email: `supprime-${u.id}@invalid`, name: 'Compte supprimé', password_hash: '!', deleted_at: now() });
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  // ---------- Adresses ----------
  const myAddresses = async (uid) => list(await C('addresses').where('uid', '==', uid).get()).sort((a, b) => a.created_at - b.created_at);
  r.get('/me/addresses', auth.requireUser, asyncH(async (req, res) => res.json(await myAddresses(req.user.id))));
  r.post('/me/addresses', auth.requireUser, asyncH(async (req, res) => {
    const a = parse(addressS, req.body);
    if ((await myAddresses(req.user.id)).length >= 20) throw bad('Nombre maximum d’adresses atteint');
    const ref = await C('addresses').add({ uid: req.user.id, label: a.label || null, name: a.name, line1: a.line1, line2: a.line2 || null, postal_code: a.postal_code, city: a.city, country: a.country, phone: a.phone || null, created_at: now() });
    res.status(201).json(docData(await ref.get()));
  }));
  async function ownAddress(req) { const a = docData(await C('addresses').doc(String(req.params.id)).get()); if (!a || a.uid !== req.user.id) throw notFound('Adresse introuvable'); return a; }
  r.put('/me/addresses/:id', auth.requireUser, asyncH(async (req, res) => {
    const a = parse(addressS, req.body); await ownAddress(req);
    await C('addresses').doc(String(req.params.id)).update({ label: a.label || null, name: a.name, line1: a.line1, line2: a.line2 || null, postal_code: a.postal_code, city: a.city, country: a.country, phone: a.phone || null });
    res.json(docData(await C('addresses').doc(String(req.params.id)).get()));
  }));
  r.delete('/me/addresses/:id', auth.requireUser, asyncH(async (req, res) => { await ownAddress(req); await C('addresses').doc(String(req.params.id)).delete(); res.json({ ok: true }); }));

  // ---------- Paiement ----------
  r.post('/checkout', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ items: itemsS.min(1), promoCode: z.string().trim().max(40).optional().nullable(), shippingZoneId: id.optional().nullable(), addressId: id.optional().nullable(),
      address: addressS.optional().nullable(), note: z.string().max(1000).optional().nullable(), checkoutKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }), req.body);
    res.json(await shop.startCheckout(req.user, b));
  }));

  // ---------- Commandes du client ----------
  async function orderFor(req) {
    const qs = await C('orders').where('number', '==', String(req.params.number)).limit(1).get();
    const o = qs.empty ? null : { id: qs.docs[0].id, ...qs.docs[0].data() };
    if (!o || o.uid !== req.user.id) throw notFound('Commande introuvable');
    return o;
  }
  async function orderDetail(o) {
    const reqs = list(await C('refund_requests').where('order_id', '==', o.id).get()).sort((a, b) => a.created_at - b.created_at);
    const dls = list(await C('downloads').where('order_id', '==', o.id).get());
    return {
      id: o.id, number: o.number, status: o.status, status_label: shop.STATUS_LABELS[o.status] || o.status, payment_status: o.payment_status,
      subtotal_cents: o.subtotal_cents, premium_discount_cents: o.premium_discount_cents, discount_cents: o.discount_cents, promo_code: o.promo_code, shipping_cents: o.shipping_cents,
      total_cents: o.total_cents, refunded_cents: o.refunded_cents, needs_shipping: o.needs_shipping, shipping_method: o.shipping_method,
      ship_name: o.ship_name, ship_line1: o.ship_line1, ship_line2: o.ship_line2, ship_postal: o.ship_postal, ship_city: o.ship_city, ship_phone: o.ship_phone,
      tracking_carrier: o.tracking_carrier, tracking_number: o.tracking_number, tracking_url: o.tracking_url, created_at: o.created_at, paid_at: o.paid_at,
      reservation_expires_at: o.reservation_expires_at, pay_url: o.status === 'pending_payment' && o.reservation_expires_at > now() ? o.stripe_session_url : null,
      items: o.items, events: (o.events || []).map(({ actor, ...e }) => e),
      refunds: (o.refunds || []).map((x) => ({ amount_cents: x.amount_cents, status: x.status, created_at: x.created_at })),
      refund_requests: reqs.map((x) => ({ reason: x.reason, status: x.status, admin_message: x.admin_message, created_at: x.created_at })),
      downloads: dls.map((d) => ({ id: d.id, count: d.count, max_count: d.max_count, revoked: d.revoked, original_name: d.original_name, size: d.size })),
      address_editable: !!o.needs_shipping && ['paid', 'in_production', 'payment_processing'].includes(o.status) && !!o.ship_line1,
    };
  }
  r.get('/me/orders', auth.requireUser, asyncH(async (req, res) => {
    const rows = list(await C('orders').where('uid', '==', req.user.id).get())
      .filter((o) => !['cancelled', 'expired'].includes(o.status) || o.payment_status !== 'unpaid').sort((a, b) => b.created_at - a.created_at).slice(0, 200);
    res.json(rows.map((o) => ({ number: o.number, status: o.status, status_label: shop.STATUS_LABELS[o.status] || o.status, payment_status: o.payment_status, total_cents: o.total_cents, refunded_cents: o.refunded_cents, created_at: o.created_at, paid_at: o.paid_at })));
  }));
  r.get('/me/orders/:number', auth.requireUser, asyncH(async (req, res) => res.json(await orderDetail(await orderFor(req)))));
  r.patch('/me/orders/:number/address', auth.requireUser, asyncH(async (req, res) => {
    const o = await orderFor(req);
    await shop.changeAddress(o.id, parse(addressS, req.body), { userId: req.user.id, actor: 'client' });
    res.json(await orderDetail(docData(await C('orders').doc(o.id).get())));
  }));
  r.post('/me/orders/:number/cancel', auth.requireUser, asyncH(async (req, res) => {
    const o = await orderFor(req);
    if (o.status !== 'pending_payment') throw conflict('Seule une commande en attente de paiement peut être annulée ici');
    if (await shop.releaseOrder(o.id, 'cancelled', 'Annulée par le client', { actor: 'client' }) && o.stripe_session_id) {
      try { await stripe.checkout.sessions.expire(o.stripe_session_id); } catch { /* déjà expirée ou payée */ }
    }
    res.json({ ok: true });
  }));
  r.post('/me/orders/:number/refund-request', auth.requireUser, asyncH(async (req, res) => {
    const o = await orderFor(req);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(1000) }), req.body);
    if (!['paid', 'partially_refunded'].includes(o.payment_status)) throw conflict('Aucun paiement remboursable sur cette commande');
    await db.runTransaction(async (tx) => {
      const lock = C('refund_request_locks').doc(o.id);
      const l = await tx.get(lock);
      if (l.exists && l.data().open) throw conflict('Une demande est déjà en cours');
      const rid = newId();
      tx.set(lock, { open: true, request_id: rid });
      tx.set(C('refund_requests').doc(rid), { order_id: o.id, number: o.number, uid: req.user.id, customer: req.user.name, reason: b.reason, status: 'open', admin_message: null, created_at: now(), updated_at: now() });
    });
    await shop.addEvent(o.id, 'refund_request', 'Demande de remboursement envoyée', 'client');
    await mailer.T.adminNotify(`Demande de remboursement ${o.number}`, b.reason);
    res.status(201).json({ ok: true });
  }));

  // ---------- Téléchargements STL ----------
  r.get('/me/downloads', auth.requireUser, asyncH(async (req, res) => {
    res.json(list(await C('downloads').where('uid', '==', req.user.id).get()).sort((a, b) => b.created_at - a.created_at)
      .map((d) => ({ id: d.id, count: d.count, max_count: d.max_count, revoked: d.revoked, original_name: d.original_name, size: d.size, number: d.order_number, product_name: d.product_name })));
  }));
  r.get('/downloads/:id', auth.requireUser, asyncH(async (req, res) => {
    const ref = C('downloads').doc(String(req.params.id));
    const d = await db.runTransaction(async (tx) => {
      const row = docData(await tx.get(ref));
      if (!row || row.uid !== req.user.id) throw notFound('Téléchargement introuvable');
      const o = (await tx.get(C('orders').doc(row.order_id))).data();
      if (row.revoked || !['paid', 'partially_refunded'].includes(o.payment_status)) throw forbidden('Ce téléchargement n’est plus disponible');
      if (row.count >= row.max_count) throw forbidden('Nombre maximum de téléchargements atteint');
      tx.update(ref, { count: row.count + 1 });
      return row;
    });
    const f = await uploads.read(`private/products/${d.filename}`);
    if (!f) throw notFound('Fichier manquant sur le serveur');
    res.setHeader('Cache-Control', 'private, no-store');
    res.attachment(d.original_name);
    res.type('application/octet-stream').send(f.buffer);
  }));

  // ---------- Premium ----------
  r.post('/premium/subscribe', auth.requireUser, asyncH(async (req, res) => res.json(await premium.subscribe(req.user))));
  r.post('/premium/cancel', auth.requireUser, asyncH(async (req, res) => res.json(publicUser(await premium.setCancelAtPeriodEnd(req.user, true)))));
  r.post('/premium/resume', auth.requireUser, asyncH(async (req, res) => res.json(publicUser(await premium.setCancelAtPeriodEnd(req.user, false)))));

  // ---------- Sur mesure ----------
  r.post('/custom-requests', auth.requireUser, asyncH(async (req, res) => {
    const { fields, files } = await uploads.parseMultipart(req, { maxFileMb: 25, maxFiles: 5 });
    const b = parse(z.object({ title: z.string().trim().min(3).max(120), description: z.string().trim().min(10).max(5000), material: z.string().trim().max(40).optional(),
      color: z.string().trim().max(40).optional(), quantity: z.coerce.number().int().min(1).max(500), dimensions: z.string().trim().max(120).optional() }), fields);
    const open = list(await C('custom_requests').where('uid', '==', req.user.id).get()).filter((c) => ['submitted', 'quoted'].includes(c.status)).length;
    if (open >= 10) throw conflict('Trop de demandes en cours');
    const saved = [];
    for (const f of files) saved.push({ id: newId(), filename: await uploads.saveCustomFile(f), original_name: f.originalname, size: f.size });
    const ref = await C('custom_requests').add({ uid: req.user.id, customer: req.user.name, email: req.user.email, title: b.title, description: b.description, material: b.material || null, color: b.color || null,
      quantity: b.quantity, dimensions: b.dimensions || null, status: 'submitted', quote_cents: null, quote_days: null, quote_message: null, order_id: null, order_number: null, files: saved, created_at: now(), updated_at: now() });
    await mailer.T.adminNotify('Nouvelle demande sur mesure', `${b.title}\n\n${b.description}`);
    res.status(201).json({ id: ref.id });
  }));
  r.get('/me/custom-requests', auth.requireUser, asyncH(async (req, res) => {
    res.json(list(await C('custom_requests').where('uid', '==', req.user.id).get()).sort((a, b) => b.created_at - a.created_at)
      .map((c) => ({ ...c, files: (c.files || []).map((f) => ({ original_name: f.original_name, size: f.size })) })));
  }));
  r.post('/custom-requests/:id/cancel', auth.requireUser, asyncH(async (req, res) => {
    const ref = C('custom_requests').doc(String(req.params.id));
    await db.runTransaction(async (tx) => {
      const c = docData(await tx.get(ref));
      if (!c || c.uid !== req.user.id || !['submitted', 'quoted'].includes(c.status)) throw conflict('Cette demande ne peut plus être annulée');
      tx.update(ref, { status: 'cancelled', updated_at: now() });
    });
    res.json({ ok: true });
  }));
  r.post('/custom-requests/:id/accept', auth.requireUser, asyncH(async (req, res) => {
    const c = docData(await C('custom_requests').doc(String(req.params.id)).get());
    if (!c || c.uid !== req.user.id) throw notFound('Demande introuvable');
    if (!['quoted', 'accepted'].includes(c.status)) throw conflict('Aucun devis à accepter');
    const b = parse(z.object({ shippingZoneId: id, addressId: id.optional().nullable(), address: addressS.optional().nullable(), checkoutKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }), req.body);
    const out = await shop.startCheckout(req.user, { ...b, items: [] }, { custom: { name: `Sur mesure : ${c.title}`, price_cents: c.quote_cents, requestId: c.id } });
    const qs = await C('orders').where('number', '==', out.number).limit(1).get();
    await C('custom_requests').doc(c.id).update({ status: 'accepted', order_id: qs.docs[0].id, order_number: out.number, updated_at: now() });
    res.json(out);
  }));

  // ---------- Newsletter ----------
  async function subscribeNewsletter(email, uid = null) {
    const ref = C('newsletter').doc(email);
    const ex = docData(await ref.get());
    if (ex && ex.status === 'confirmed') return 'already';
    const token = ex ? ex.token : randomToken(24);
    await ref.set({ email, status: 'pending', token, uid: (ex && ex.uid) || uid, created_at: ex ? ex.created_at : now(), confirmed_at: null });
    await mailer.T.newsletterConfirm(email, `${cfg.appUrl}/api/newsletter/confirm?token=${token}`);
    return 'pending';
  }
  const byToken = async (token) => { const qs = await C('newsletter').where('token', '==', String(token || '')).limit(1).get(); return qs.empty ? null : qs.docs[0]; };
  r.post('/newsletter/subscribe', mailLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS }), req.body);
    await subscribeNewsletter(b.email, req.user && req.user.email === b.email ? req.user.id : null);
    res.json({ ok: true, message: 'Si cette adresse est valide, un e-mail de confirmation vient d’être envoyé.' });
  }));
  r.get('/newsletter/confirm', asyncH(async (req, res) => {
    const d = await byToken(req.query.token);
    if (d && d.data().status === 'pending') { await d.ref.update({ status: 'confirmed', confirmed_at: now() }); return res.redirect(302, '/?newsletter=ok'); }
    res.redirect(302, '/?newsletter=invalide');
  }));
  const unsub = asyncH(async (req, res) => {
    const d = await byToken((req.body && req.body.token) || req.query.token);
    if (d) await d.ref.update({ status: 'unsubscribed' });
    if (req.method === 'GET') return res.redirect(302, '/?newsletter=desinscrit');
    res.json({ ok: true });
  });
  r.get('/newsletter/unsubscribe', unsub);
  r.get('/me/newsletter', auth.requireUser, asyncH(async (req, res) => { const d = await C('newsletter').doc(req.user.email).get(); res.json({ status: d.exists ? d.data().status : 'none' }); }));
  r.post('/me/newsletter', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ subscribe: z.boolean() }), req.body);
    if (b.subscribe) return res.json({ status: await subscribeNewsletter(req.user.email, req.user.id) });
    const d = await C('newsletter').doc(req.user.email).get();
    if (d.exists) await d.ref.update({ status: 'unsubscribed' });
    res.json({ status: 'unsubscribed' });
  }));

  return { router: r, unsub };
}

module.exports = { makeApi, parse, asyncH, addressS, id };
