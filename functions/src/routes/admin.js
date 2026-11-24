'use strict';
// API d'administration (/api/admin/*) sur Firestore : rôle « admin » obligatoire, actions journalisées.
const express = require('express');
const { z } = require('zod');
const { now, bad, notFound, conflict, forbidden, slugify, escapeHtml, docData, list, newId } = require('../lib/util');
const { parse, asyncH, addressS, id } = require('./api');

const nullish = (schema) => z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), schema.nullable()).optional();
const intOrNull = nullish(z.coerce.number().int());
const boolish = z.union([z.boolean(), z.literal(0).transform(() => false), z.literal(1).transform(() => true), z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true')]);

function makeAdmin({ db, cfg, auth, shop, premium, mailer, uploads, geo, audit, stats, settings }) {
  const r = express.Router();
  const C = (n) => db.collection(n);
  r.use(auth.requireAdmin);
  const log = (req, action, details) => audit(req.user.id, action, details ? JSON.stringify(details).slice(0, 2000) : null, req.ip);
  const H = (fn) => asyncH(fn);

  r.get('/stats', H(async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(366).optional() }), req.query);
    res.json(await stats(q.days || 30));
  }));

  // ---------- Catégories ----------
  const catS = z.object({ name: z.string().trim().min(1).max(80), slug: z.string().trim().max(80).optional(), description: z.string().max(1000).optional().nullable(), sort: z.coerce.number().int().optional(), active: boolish.optional() });
  async function slugTaken(coll, slug, exceptId) { return list(await C(coll).where('slug', '==', slug).get()).some((d) => d.id !== exceptId); }
  r.get('/categories', H(async (req, res) => {
    const prods = list(await C('products').get());
    res.json(list(await C('categories').get()).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name)).map((c) => ({ ...c, count: prods.filter((p) => p.category_id === c.id).length })));
  }));
  r.post('/categories', H(async (req, res) => {
    const b = parse(catS, req.body); const slug = slugify(b.slug || b.name);
    if (await slugTaken('categories', slug)) throw conflict('Ce slug existe déjà');
    const ref = await C('categories').add({ slug, name: b.name, description: b.description || null, sort: b.sort || 0, active: b.active !== false });
    await log(req, 'category_create', { id: ref.id, name: b.name });
    res.status(201).json(docData(await ref.get()));
  }));
  r.put('/categories/:id', H(async (req, res) => {
    const b = parse(catS, req.body); const ref = C('categories').doc(req.params.id); const c = docData(await ref.get());
    if (!c) throw notFound();
    const slug = slugify(b.slug || c.slug);
    if (await slugTaken('categories', slug, c.id)) throw conflict('Ce slug existe déjà');
    await ref.update({ slug, name: b.name, description: b.description ?? null, sort: b.sort ?? c.sort, active: b.active === undefined ? c.active : b.active });
    await log(req, 'category_update', { id: c.id });
    res.json(docData(await ref.get()));
  }));
  r.delete('/categories/:id', H(async (req, res) => {
    const ref = C('categories').doc(req.params.id);
    if (!(await ref.get()).exists) throw notFound();
    for (const p of (await C('products').where('category_id', '==', req.params.id).get()).docs) await p.ref.update({ category_id: null });
    await ref.delete(); await log(req, 'category_delete', { id: req.params.id });
    res.json({ ok: true });
  }));

  // ---------- Produits & variantes ----------
  const variantS = z.object({ id: id.optional(), sku: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(120), price_cents: z.coerce.number().int().min(0).max(10_000_000),
    compare_at_cents: intOrNull, stock: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(1_000_000).nullable()), active: boolish.optional(), sort: z.coerce.number().int().optional() });
  const productS = z.object({ name: z.string().trim().min(1).max(160), slug: z.string().trim().max(80).optional(), description: z.string().max(20000).default(''), category_id: nullish(id),
    type: z.enum(['physical', 'digital']), material: z.string().trim().max(80).optional().nullable(), active: boolish.optional(), featured: boolish.optional(), premium_only: boolish.optional(), variants: z.array(variantS).min(1).max(100) });

  async function productAdmin(pid) {
    const p = docData(await C('products').doc(pid).get());
    if (!p) throw notFound('Produit introuvable');
    const t = now();
    const variants = list(await C('variants').where('product_id', '==', pid).get()).sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(({ reserved, ...v }) => ({ ...v, reserved: Object.values(reserved || {}).filter((x) => x.exp > t).reduce((a, x) => a + x.qty, 0) }));
    return { ...p, variants, images: (p.images || []).map((i) => ({ ...i, url: `/uploads/images/${i.filename}` })), files: (p.files || []).map(({ filename, ...f }) => f) };
  }

  r.get('/products', H(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const cats = new Map(list(await C('categories').get()).map((c) => [c.id, c.name]));
    const vars = list(await C('variants').get());
    res.json(list(await C('products').get()).filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q)).sort((a, b) => b.created_at - a.created_at).map((p) => {
      const vs = vars.filter((v) => v.product_id === p.id);
      return { id: p.id, slug: p.slug, name: p.name, type: p.type, active: p.active, featured: p.featured, premium_only: p.premium_only, category: cats.get(p.category_id) || null,
        price_from: vs.length ? Math.min(...vs.map((v) => v.price_cents)) : null, stock_total: vs.some((v) => v.stock !== null) ? vs.reduce((a, v) => a + (v.stock || 0), 0) : null,
        variants: vs.length, image: p.images && p.images[0] ? `/uploads/images/${p.images[0].filename}` : null };
    }));
  }));
  r.get('/products/:id', H(async (req, res) => res.json(await productAdmin(req.params.id))));

  async function saveProduct(req, pid) {
    const b = parse(productS, req.body);
    if (b.type === 'digital' && b.variants.some((v) => v.stock !== null)) throw bad('Un produit numérique n’a pas de stock (laissez le stock vide)');
    const skus = b.variants.map((v) => v.sku.toUpperCase());
    if (new Set(skus).size !== skus.length) throw bad('Chaque variante doit avoir un SKU unique');
    const slug = slugify(b.slug || b.name);
    if (await slugTaken('products', slug, pid)) throw conflict('Ce slug est déjà utilisé');
    const allVars = list(await C('variants').get());
    for (const v of b.variants) { const clash = allVars.find((x) => x.sku.toUpperCase() === v.sku.toUpperCase() && x.id !== v.id); if (clash) throw conflict(`Le SKU « ${v.sku} » est déjà utilisé`); }
    const t = now();
    const data = { name: b.name, slug, description: b.description, category_id: b.category_id ?? null, type: b.type, material: b.material || null, active: b.active !== false, featured: !!b.featured, premium_only: !!b.premium_only, updated_at: t };
    if (pid) { const ref = C('products').doc(pid); if (!(await ref.get()).exists) throw notFound('Produit introuvable'); await ref.update(data); }
    else pid = (await C('products').add({ ...data, images: [], files: [], created_at: t })).id;
    const existing = allVars.filter((v) => v.product_id === pid);
    const keep = [];
    for (const [i, v] of b.variants.entries()) {
      const vd = { product_id: pid, sku: v.sku, name: v.name, price_cents: v.price_cents, compare_at_cents: v.compare_at_cents ?? null, stock: v.stock, active: v.active !== false, sort: v.sort ?? i };
      if (v.id) {
        if (!existing.find((x) => x.id === v.id)) throw bad('Variante inconnue');
        // Stock et champs modifiés dans une transaction (préserve les réservations en cours)
        await db.runTransaction(async (tx) => { const ref = C('variants').doc(v.id); const cur = (await tx.get(ref)).data(); tx.set(ref, { ...vd, reserved: cur.reserved || {} }); });
        keep.push(v.id);
      } else keep.push((await C('variants').add({ ...vd, reserved: {} })).id);
    }
    const ordersRef = list(await C('orders').get());
    for (const old of existing) {
      if (keep.includes(old.id)) continue;
      const used = ordersRef.some((o) => (o.items || []).some((it) => it.variant_id === old.id)) || Object.keys(old.reserved || {}).length;
      if (used) await C('variants').doc(old.id).update({ active: false }); else await C('variants').doc(old.id).delete();
    }
    return pid;
  }
  r.post('/products', H(async (req, res) => { const pid = await saveProduct(req, null); await log(req, 'product_create', { id: pid }); res.status(201).json(await productAdmin(pid)); }));
  r.put('/products/:id', H(async (req, res) => { const pid = await saveProduct(req, req.params.id); await log(req, 'product_update', { id: pid }); res.json(await productAdmin(pid)); }));
  r.delete('/products/:id', H(async (req, res) => {
    const pid = req.params.id; const p = docData(await C('products').doc(pid).get());
    if (!p) throw notFound();
    const sold = list(await C('orders').get()).some((o) => (o.items || []).some((it) => it.product_id === pid));
    if (sold) { await C('products').doc(pid).update({ active: false, updated_at: now() }); await log(req, 'product_archive', { id: pid }); return res.json({ ok: true, archived: true }); }
    for (const v of (await C('variants').where('product_id', '==', pid).get()).docs) await v.ref.delete();
    for (const i of p.images || []) await uploads.remove(`images/${i.filename}`);
    for (const f of p.files || []) await uploads.remove(`private/products/${f.filename}`);
    await C('products').doc(pid).delete(); await log(req, 'product_delete', { id: pid });
    res.json({ ok: true });
  }));
  r.post('/variants/:id/stock', H(async (req, res) => {
    const b = parse(z.object({ delta: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(), set: z.coerce.number().int().min(0).max(1_000_000).optional() }), req.body);
    const ref = C('variants').doc(req.params.id);
    const v = await db.runTransaction(async (tx) => {
      const cur = docData(await tx.get(ref));
      if (!cur) throw notFound();
      if (cur.stock === null) throw bad('Stock non suivi pour cette variante');
      const next = b.set != null ? b.set : cur.stock + (b.delta || 0);
      if (next < 0) throw bad('Le stock ne peut pas être négatif');
      tx.update(ref, { stock: next });
      return { ...cur, stock: next };
    });
    await log(req, 'stock_adjust', { variant: v.id, stock: v.stock });
    const { reserved, ...pub } = v; res.json(pub);
  }));

  r.post('/products/:id/images', H(async (req, res) => {
    const ref = C('products').doc(req.params.id);
    if (!(await ref.get()).exists) throw notFound();
    const { fields, files } = await uploads.parseMultipart(req, { maxFileMb: 10, maxFiles: 10 });
    const added = [];
    for (const f of files) added.push({ id: newId(), filename: await uploads.saveImage(f), alt: String(fields.alt || '').slice(0, 200) || null });
    await db.runTransaction(async (tx) => { const p = (await tx.get(ref)).data(); tx.update(ref, { images: [...(p.images || []), ...added], updated_at: now() }); });
    await log(req, 'images_add', { product: req.params.id, count: added.length });
    res.status(201).json((await productAdmin(req.params.id)).images);
  }));
  r.put('/products/:id/images/order', H(async (req, res) => {
    const b = parse(z.object({ ids: z.array(id).max(50) }), req.body);
    const ref = C('products').doc(req.params.id);
    await db.runTransaction(async (tx) => { const p = (await tx.get(ref)).data(); const imgs = p.images || []; tx.update(ref, { images: [...b.ids.map((i) => imgs.find((x) => x.id === i)).filter(Boolean), ...imgs.filter((x) => !b.ids.includes(x.id))] }); });
    res.json((await productAdmin(req.params.id)).images);
  }));
  r.delete('/products/:pid/images/:id', H(async (req, res) => {
    const ref = C('products').doc(req.params.pid);
    const img = await db.runTransaction(async (tx) => { const p = (await tx.get(ref)).data(); const i = (p.images || []).find((x) => x.id === req.params.id); if (!i) throw notFound(); tx.update(ref, { images: p.images.filter((x) => x.id !== i.id) }); return i; });
    await uploads.remove(`images/${img.filename}`);
    res.json({ ok: true });
  }));
  r.post('/products/:id/files', H(async (req, res) => {
    const ref = C('products').doc(req.params.id);
    const p = docData(await ref.get());
    if (!p) throw notFound();
    if (p.type !== 'digital') throw bad('Les fichiers STL ne peuvent être attachés qu’à un produit numérique');
    const { files } = await uploads.parseMultipart(req, { maxFileMb: 30, maxFiles: 5 });
    const added = [];
    for (const f of files) added.push({ id: newId(), filename: await uploads.saveModel(f, 'products'), original_name: f.originalname, size: f.size, created_at: now() });
    await db.runTransaction(async (tx) => { const cur = (await tx.get(ref)).data(); tx.update(ref, { files: [...(cur.files || []), ...added] }); });
    await log(req, 'files_add', { product: p.id });
    res.status(201).json((await productAdmin(p.id)).files);
  }));
  r.delete('/products/:pid/files/:id', H(async (req, res) => {
    const live = list(await C('downloads').where('file_id', '==', req.params.id).get()).some((d) => !d.revoked);
    if (live) throw conflict('Fichier déjà vendu : il reste téléchargeable par les acheteurs. Ajoutez plutôt une nouvelle version.');
    const ref = C('products').doc(req.params.pid);
    const f = await db.runTransaction(async (tx) => { const p = (await tx.get(ref)).data(); const x = (p.files || []).find((y) => y.id === req.params.id); if (!x) throw notFound(); tx.update(ref, { files: p.files.filter((y) => y.id !== x.id) }); return x; });
    await uploads.remove(`private/products/${f.filename}`);
    res.json({ ok: true });
  }));

  // ---------- Commandes ----------
  r.get('/orders', H(async (req, res) => {
    const q = parse(z.object({ status: z.string().max(30).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).optional() }), req.query);
    let rows = list(await C('orders').get());
    if (q.status === 'to_process') rows = rows.filter((o) => ['paid', 'in_production'].includes(o.status));
    else if (q.status) rows = rows.filter((o) => o.status === q.status);
    const users = new Map(list(await C('users').get()).map((u) => [u.id, u.name]));
    if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter((o) => o.number.toLowerCase().includes(s) || o.email.toLowerCase().includes(s) || (users.get(o.uid) || '').toLowerCase().includes(s)); }
    rows.sort((a, b) => b.created_at - a.created_at);
    const per = 50, page = q.page || 1;
    res.json(rows.slice((page - 1) * per, page * per).map((o) => ({ id: o.id, number: o.number, status: o.status, status_label: shop.STATUS_LABELS[o.status] || o.status, payment_status: o.payment_status,
      total_cents: o.total_cents, refunded_cents: o.refunded_cents, email: o.email, shipping_method: o.shipping_method, created_at: o.created_at, paid_at: o.paid_at, customer: users.get(o.uid) || '' })));
  }));
  async function orderAdmin(oid) {
    const o = docData(await C('orders').doc(oid).get());
    if (!o) throw notFound('Commande introuvable');
    const u = docData(await C('users').doc(o.uid).get());
    const engaged = (o.refunds || []).filter((x) => ['pending', 'succeeded', 'requires_action'].includes(x.status)).reduce((a, x) => a + x.amount_cents, 0);
    return { ...o, user_id: o.uid, customer: u ? u.name : '', status_label: shop.STATUS_LABELS[o.status],
      refund_requests: list(await C('refund_requests').where('order_id', '==', oid).get()),
      refundable_cents: ['paid', 'partially_refunded'].includes(o.payment_status) ? o.total_cents - engaged : 0,
      statuses: shop.ADMIN_STATUS_FLOW.map((s) => ({ value: s, label: shop.STATUS_LABELS[s] })) };
  }
  r.get('/orders/:id', H(async (req, res) => res.json(await orderAdmin(req.params.id))));
  r.post('/orders/:id/status', H(async (req, res) => {
    const b = parse(z.object({ status: z.string(), tracking_carrier: z.string().trim().max(60).optional().nullable(), tracking_number: z.string().trim().max(80).optional().nullable(),
      tracking_url: z.string().trim().max(300).optional().nullable(), message: z.string().trim().max(1000).optional().nullable() }), req.body);
    await shop.setStatus(req.params.id, b.status, { ...b, actor: `admin:${req.user.id}` });
    await log(req, 'order_status', { id: req.params.id, status: b.status });
    res.json(await orderAdmin(req.params.id));
  }));
  r.patch('/orders/:id/address', H(async (req, res) => {
    await shop.changeAddress(req.params.id, parse(addressS, req.body), { byAdmin: true, actor: `admin:${req.user.id}` });
    await log(req, 'order_address', { id: req.params.id });
    res.json(await orderAdmin(req.params.id));
  }));
  r.patch('/orders/:id/note', H(async (req, res) => {
    const b = parse(z.object({ admin_note: z.string().max(5000) }), req.body);
    await C('orders').doc(req.params.id).update({ admin_note: b.admin_note, updated_at: now() });
    res.json(await orderAdmin(req.params.id));
  }));
  r.post('/orders/:id/refunds', H(async (req, res) => {
    const b = parse(z.object({ amount_cents: z.coerce.number().int().positive(), reason: z.string().trim().max(500).optional(), restock: z.boolean().optional() }), req.body);
    const ref = await shop.refund(req.params.id, b.amount_cents, { reason: b.reason, restock: !!b.restock, actor: `admin:${req.user.id}` });
    await log(req, 'refund', { order: req.params.id, amount: b.amount_cents, status: ref.status });
    res.status(201).json(await orderAdmin(req.params.id));
  }));

  // ---------- Demandes de remboursement ----------
  r.get('/refund-requests', H(async (req, res) => {
    const orders = new Map(list(await C('orders').get()).map((o) => [o.id, o]));
    res.json(list(await C('refund_requests').get()).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.created_at - a.created_at)
      .map((x) => ({ ...x, total_cents: (orders.get(x.order_id) || {}).total_cents, refunded_cents: (orders.get(x.order_id) || {}).refunded_cents })));
  }));
  r.post('/refund-requests/:id', H(async (req, res) => {
    const b = parse(z.object({ action: z.enum(['approve', 'reject']), amount_cents: z.coerce.number().int().positive().optional(), restock: z.boolean().optional(), message: z.string().trim().max(1000).optional() }), req.body);
    const ref = C('refund_requests').doc(req.params.id);
    const rr = docData(await ref.get());
    if (!rr) throw notFound();
    if (rr.status !== 'open') throw conflict('Demande déjà traitée');
    if (b.action === 'approve') {
      if (!b.amount_cents) throw bad('Montant requis');
      await shop.refund(rr.order_id, b.amount_cents, { reason: `Demande client : ${rr.reason}`.slice(0, 500), restock: !!b.restock, actor: `admin:${req.user.id}` });
    }
    await ref.update({ status: b.action === 'approve' ? 'approved' : 'rejected', admin_message: b.message || null, updated_at: now() });
    await C('refund_request_locks').doc(rr.order_id).set({ open: false });
    if (b.action === 'reject') { const o = docData(await C('orders').doc(rr.order_id).get()); await mailer.compose(o.email, 'refund_rejected', `Demande de remboursement — ${o.number}`, ['Votre demande de remboursement n’a pas été acceptée.', ...(b.message ? [b.message] : [])]); }
    await log(req, 'refund_request', { id: rr.id, action: b.action });
    res.json({ ok: true });
  }));

  // ---------- Clients ----------
  r.get('/customers', H(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const orders = list(await C('orders').get()).filter((o) => o.payment_status !== 'unpaid');
    res.json(list(await C('users').get()).filter((u) => !q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)).sort((a, b) => b.created_at - a.created_at).slice(0, 500).map((u) => {
      const mine = orders.filter((o) => o.uid === u.id);
      return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, email_verified_at: u.email_verified_at, premium_status: u.premium ? u.premium.status : null, premium_until: u.premium ? u.premium.until : null,
        created_at: u.created_at, deleted_at: u.deleted_at, orders: mine.length, spent_cents: mine.reduce((a, o) => a + o.total_cents - (o.refunded_cents || 0), 0), premium: shop.isPremium(u) };
    }));
  }));
  r.get('/customers/:id', H(async (req, res) => {
    const u = docData(await C('users').doc(req.params.id).get());
    if (!u) throw notFound();
    const { password_hash, ...pub } = u;
    res.json({ ...pub, premium: shop.isPremium(u), premium_status: u.premium ? u.premium.status : null, premium_until: u.premium ? u.premium.until : null,
      premium_cancel_at_period_end: !!(u.premium && u.premium.cancel_at_period_end), premium_sub_id: u.premium ? u.premium.sub_id : null,
      addresses: list(await C('addresses').where('uid', '==', u.id).get()),
      orders: list(await C('orders').where('uid', '==', u.id).get()).sort((a, b) => b.created_at - a.created_at).map((o) => ({ id: o.id, number: o.number, status: o.status, payment_status: o.payment_status, total_cents: o.total_cents, created_at: o.created_at })) });
  }));
  r.patch('/customers/:id', H(async (req, res) => {
    const b = parse(z.object({ disabled: z.boolean().optional(), role: z.enum(['customer', 'admin']).optional(), verify_email: z.boolean().optional() }), req.body);
    if (req.params.id === req.user.id && (b.disabled || b.role === 'customer')) throw forbidden('Vous ne pouvez pas vous désactiver ou retirer vos propres droits');
    const ref = C('users').doc(req.params.id); const u = docData(await ref.get());
    if (!u) throw notFound();
    const patch = {};
    if (b.disabled !== undefined) patch.disabled = b.disabled;
    if (b.role) patch.role = b.role;
    if (b.verify_email) patch.email_verified_at = u.email_verified_at || now();
    await ref.update(patch);
    if (b.disabled) await auth.destroyAllSessions(u.id);
    await log(req, 'customer_update', { id: u.id, ...b });
    res.json({ ok: true });
  }));
  r.post('/customers/:id/premium/cancel', H(async (req, res) => {
    const u = docData(await C('users').doc(req.params.id).get());
    if (!u) throw notFound();
    const b = parse(z.object({ immediately: z.boolean().optional() }), req.body);
    if (b.immediately) await premium.cancelNow(u); else await premium.setCancelAtPeriodEnd(u, true);
    await log(req, 'premium_cancel', { id: u.id, immediately: !!b.immediately });
    res.json({ ok: true });
  }));

  // ---------- Codes promo ----------
  const promoS = z.object({ code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, 'lettres, chiffres, - et _ uniquement'), type: z.enum(['percent', 'fixed']), value: z.coerce.number().int().positive(),
    min_subtotal_cents: z.coerce.number().int().min(0).default(0), max_uses: intOrNull, per_user_limit: intOrNull, starts_at: intOrNull, ends_at: intOrNull, premium_only: boolish.optional(), active: boolish.optional() })
    .refine((p) => p.type !== 'percent' || p.value <= 100, { message: 'un pourcentage ne peut pas dépasser 100', path: ['value'] });
  const uses = (p) => Object.values(p.holds || {}).filter((h) => h.paid).length;
  r.get('/promos', H(async (req, res) => res.json(list(await C('promos').get()).sort((a, b) => b.created_at - a.created_at).map(({ holds, ...p }) => ({ ...p, uses: uses({ holds }) })))));
  async function savePromo(req, pid) {
    const b = parse(promoS, req.body); const code = b.code.toUpperCase();
    if (list(await C('promos').where('code', '==', code).get()).some((p) => p.id !== pid)) throw conflict('Ce code existe déjà');
    const data = { code, type: b.type, value: b.value, min_subtotal_cents: b.min_subtotal_cents, max_uses: b.max_uses ?? null, per_user_limit: b.per_user_limit ?? null, starts_at: b.starts_at ?? null, ends_at: b.ends_at ?? null, premium_only: !!b.premium_only, active: b.active !== false };
    if (pid) { const ref = C('promos').doc(pid); if (!(await ref.get()).exists) throw notFound(); await ref.update(data); return pid; }
    return (await C('promos').add({ ...data, holds: {}, created_at: now() })).id;
  }
  const promoOut = async (pid) => { const { holds, ...p } = docData(await C('promos').doc(pid).get()); return p; };
  r.post('/promos', H(async (req, res) => { const pid = await savePromo(req); await log(req, 'promo_create', { id: pid }); res.status(201).json(await promoOut(pid)); }));
  r.put('/promos/:id', H(async (req, res) => { const pid = await savePromo(req, req.params.id); await log(req, 'promo_update', { id: pid }); res.json(await promoOut(pid)); }));
  r.delete('/promos/:id', H(async (req, res) => {
    const ref = C('promos').doc(req.params.id); const p = docData(await ref.get()); if (!p) throw notFound();
    if (Object.keys(p.holds || {}).length) { await ref.update({ active: false }); return res.json({ ok: true, archived: true }); }
    await ref.delete(); await log(req, 'promo_delete', { id: p.id }); res.json({ ok: true });
  }));

  // ---------- Livraison ----------
  const zoneS = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['pickup', 'radius', 'postal']), description: z.string().max(500).optional().nullable(),
    radius_km: nullish(z.coerce.number().min(0.1).max(500)), postal_codes: z.string().max(5000).optional().nullable(), price_cents: z.coerce.number().int().min(0),
    free_above_cents: intOrNull, active: boolish.optional(), sort: z.coerce.number().int().optional() })
    .refine((zn) => zn.kind !== 'radius' || zn.radius_km, { message: 'rayon requis', path: ['radius_km'] })
    .refine((zn) => zn.kind !== 'postal' || (zn.postal_codes && /\d{4}/.test(zn.postal_codes)), { message: 'au moins un code postal', path: ['postal_codes'] });
  r.get('/shipping', H(async (req, res) => {
    const s = await settings.get();
    res.json({ zones: list(await C('zones').get()).sort((a, b) => (a.sort || 0) - (b.sort || 0)), origin: { lat: s.origin_lat, lng: s.origin_lng }, postcodes_count: await geo.count(), geocoder: cfg.geocoder });
  }));
  async function saveZone(req, zid) {
    const b = parse(zoneS, req.body);
    const data = { name: b.name, kind: b.kind, description: b.description || null, radius_km: b.kind === 'radius' ? b.radius_km : null, postal_codes: b.kind === 'postal' ? b.postal_codes : null,
      price_cents: b.price_cents, free_above_cents: b.free_above_cents ?? null, active: b.active !== false, sort: b.sort || 0 };
    if (zid) { const ref = C('zones').doc(zid); if (!(await ref.get()).exists) throw notFound(); await ref.update(data); return zid; }
    return (await C('zones').add({ ...data, created_at: now() })).id;
  }
  r.post('/shipping/zones', H(async (req, res) => { const zid = await saveZone(req); await log(req, 'zone_create', { id: zid }); res.status(201).json(docData(await C('zones').doc(zid).get())); }));
  r.put('/shipping/zones/:id', H(async (req, res) => { const zid = await saveZone(req, req.params.id); await log(req, 'zone_update', { id: zid }); res.json(docData(await C('zones').doc(zid).get())); }));
  r.delete('/shipping/zones/:id', H(async (req, res) => {
    const used = (await C('orders').where('shipping_zone_id', '==', req.params.id).limit(1).get()).size;
    if (used) { await C('zones').doc(req.params.id).update({ active: false }); return res.json({ ok: true, archived: true }); }
    await C('zones').doc(req.params.id).delete(); await log(req, 'zone_delete', { id: req.params.id }); res.json({ ok: true });
  }));
  r.put('/shipping/origin', H(async (req, res) => {
    const b = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }), req.body);
    await settings.set({ origin_lat: b.lat, origin_lng: b.lng }); await log(req, 'origin_update', b); res.json({ ok: true });
  }));
  r.post('/shipping/postcodes', H(async (req, res) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{4}$/), lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }), req.body);
    await C('postcodes').doc(b.code).set({ lat: b.lat, lng: b.lng, source: 'manuel', updatedAt: now() }); res.json({ ok: true });
  }));
  r.post('/shipping/postcodes/import', H(async (req, res) => {
    const { files } = await uploads.parseMultipart(req, { maxFileMb: 20, maxFiles: 1 });
    if (!files.length) throw bad('Fichier requis');
    const n = await geo.importText(files[0].buffer.toString('utf8'), 'import');
    await log(req, 'postcodes_import', { count: n }); res.json({ imported: n });
  }));
  r.post('/shipping/test', H(async (req, res) => {
    const b = parse(z.object({ postal_code: z.string().regex(/^\d{4}$/) }), req.body);
    res.json(await shop.eligibleZones({ postal_code: b.postal_code, country: 'BE' }));
  }));

  // ---------- Sur mesure ----------
  r.get('/custom-requests', H(async (req, res) => {
    res.json(list(await C('custom_requests').get()).sort((a, b) => (a.status === 'submitted' ? 0 : 1) - (b.status === 'submitted' ? 0 : 1) || b.created_at - a.created_at)
      .map((c) => ({ ...c, user_id: c.uid, files: (c.files || []).map(({ filename, ...f }) => f) })));
  }));
  r.post('/custom-requests/:id/quote', H(async (req, res) => {
    const b = parse(z.object({ quote_cents: z.coerce.number().int().min(50).max(10_000_000), quote_days: z.coerce.number().int().min(1).max(365), quote_message: z.string().trim().max(2000).optional() }), req.body);
    const ref = C('custom_requests').doc(req.params.id); const c = docData(await ref.get());
    if (!c) throw notFound();
    if (!['submitted', 'quoted'].includes(c.status)) throw conflict('Le devis ne peut plus être modifié');
    await ref.update({ status: 'quoted', quote_cents: b.quote_cents, quote_days: b.quote_days, quote_message: b.quote_message || null, updated_at: now() });
    const updated = docData(await ref.get());
    await mailer.T.customQuoted({ email: c.email, name: c.customer }, updated);
    await log(req, 'custom_quote', { id: c.id, cents: b.quote_cents });
    res.json(updated);
  }));
  r.post('/custom-requests/:id/reject', H(async (req, res) => {
    const b = parse(z.object({ message: z.string().trim().max(2000).optional() }), req.body);
    const ref = C('custom_requests').doc(req.params.id); const c = docData(await ref.get());
    if (!c) throw notFound();
    if (!['submitted', 'quoted'].includes(c.status)) throw conflict('Demande déjà engagée');
    await ref.update({ status: 'rejected', quote_message: b.message || null, updated_at: now() });
    await mailer.T.customRejected({ email: c.email, name: c.customer }, { ...c, quote_message: b.message });
    await log(req, 'custom_reject', { id: c.id }); res.json({ ok: true });
  }));
  r.get('/custom-files/:rid/:fid', H(async (req, res) => {
    const c = docData(await C('custom_requests').doc(req.params.rid).get());
    const f = c && (c.files || []).find((x) => x.id === req.params.fid);
    if (!f) throw notFound();
    const data = await uploads.read(`private/custom/${f.filename}`);
    if (!data) throw notFound('Fichier manquant');
    res.setHeader('Cache-Control', 'private, no-store'); res.attachment(f.original_name); res.type('application/octet-stream').send(data.buffer);
  }));

  // ---------- Newsletter ----------
  r.get('/newsletter', H(async (req, res) => {
    res.json({ subscribers: list(await C('newsletter').get()).sort((a, b) => b.created_at - a.created_at).map(({ token, ...s }) => s),
      campaigns: list(await C('campaigns').get()).sort((a, b) => b.created_at - a.created_at) });
  }));
  r.delete('/newsletter/subscribers/:id', H(async (req, res) => { await C('newsletter').doc(req.params.id).delete(); await log(req, 'subscriber_delete', { id: req.params.id }); res.json({ ok: true }); }));
  const campS = z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(10).max(50000) });
  r.post('/newsletter/campaigns', H(async (req, res) => { const b = parse(campS, req.body); const ref = await C('campaigns').add({ ...b, status: 'draft', recipients: 0, created_at: now(), sent_at: null }); res.status(201).json(docData(await ref.get())); }));
  r.put('/newsletter/campaigns/:id', H(async (req, res) => {
    const b = parse(campS, req.body); const ref = C('campaigns').doc(req.params.id); const c = docData(await ref.get());
    if (!c || c.status !== 'draft') throw conflict('Campagne introuvable ou déjà envoyée');
    await ref.update(b); res.json(docData(await ref.get()));
  }));
  async function queueCampaignMail(c, email, token, prefix = '') {
    const s = await settings.get();
    const unsubUrl = token ? `${cfg.appUrl}/api/newsletter/unsubscribe?token=${token}` : `${cfg.appUrl}/#compte`;
    const html = mailer.layout(s.shop_name, c.subject, c.body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
      + `<p style="font-size:12px;color:#5b6070">Vous recevez ce message car vous êtes inscrit·e à la newsletter. <a href="${unsubUrl}">Se désinscrire</a></p>`, cfg.appUrl);
    await mailer.queue({ to: email, subject: `${prefix}${c.subject}`, text: `${c.body}\n\nSe désinscrire : ${unsubUrl}`, html, kind: 'newsletter' });
  }
  r.post('/newsletter/campaigns/:id/test', H(async (req, res) => { const c = docData(await C('campaigns').doc(req.params.id).get()); if (!c) throw notFound(); await queueCampaignMail(c, req.user.email, null, '[TEST] '); res.json({ ok: true }); }));
  r.post('/newsletter/campaigns/:id/send', H(async (req, res) => {
    const ref = C('campaigns').doc(req.params.id);
    const c = await db.runTransaction(async (tx) => {
      const cur = docData(await tx.get(ref));
      if (!cur) throw notFound();
      if (cur.status !== 'draft') throw conflict('Campagne déjà envoyée');
      tx.update(ref, { status: 'sending' });
      return cur;
    });
    const subs = list(await C('newsletter').where('status', '==', 'confirmed').get());
    for (const s of subs) await queueCampaignMail(c, s.email, s.token);
    await ref.update({ status: 'sent', sent_at: now(), recipients: subs.length });
    await log(req, 'campaign_send', { id: c.id, recipients: subs.length });
    res.json({ ok: true, recipients: subs.length });
  }));

  // ---------- E-mails ----------
  r.get('/emails', H(async (req, res) => res.json(list(await C('emails').orderBy('createdAt', 'desc').limit(300).get())
    .map((m) => ({ id: m.id, to_addr: m.to, subject: m.subject, kind: m.kind, status: m.status, attempts: m.attempts, last_error: m.lastError, created_at: m.createdAt, sent_at: m.sentAt })))));
  r.post('/emails/:id/retry', H(async (req, res) => {
    const ref = C('emails').doc(req.params.id); const m = docData(await ref.get());
    if (m && m.status === 'failed') await ref.update({ status: 'queued', nextAttemptAt: now(), attempts: 0 });
    res.json({ ok: true });
  }));
  r.post('/emails/test', H(async (req, res) => { await mailer.compose(req.user.email, 'test', 'E-mail de test', ['Si vous lisez ce message, l’envoi d’e-mails fonctionne.']); res.json({ ok: true, smtp_configured: mailer.hasTransport }); }));

  // ---------- Paramètres ----------
  const settingsS = z.object({
    shop_name: z.string().trim().min(1).max(80), shop_tagline: z.string().trim().max(200), contact_email: z.union([z.string().trim().email(), z.literal('')]), shop_address: z.string().trim().max(300),
    require_email_verification: z.boolean(), download_max_count: z.coerce.number().int().min(1).max(1000), premium_enabled: z.boolean(), premium_price_cents: z.coerce.number().int().min(50).max(1_000_000),
    premium_interval: z.enum(['month', 'year']), premium_discount_percent: z.coerce.number().int().min(0).max(90), premium_free_shipping: z.boolean(), low_stock_threshold: z.coerce.number().int().min(0).max(10000),
    max_print_dimensions_mm: z.string().trim().max(60), materials: z.array(z.string().trim().min(1).max(40)).max(40), colors: z.array(z.string().trim().min(1).max(40)).max(60), terms_text: z.string().max(50000),
  }).partial();
  r.get('/settings', H(async (req, res) => res.json({ ...(await settings.get()), _env: { stripe: !!cfg.stripeSecretKey || !!cfg.stripeInjected, webhook: !!cfg.stripeWebhookSecret, smtp: mailer.hasTransport, app_url: cfg.appUrl } })));
  r.put('/settings', H(async (req, res) => { const b = parse(settingsS, req.body); const out = await settings.set(b); await log(req, 'settings_update', Object.keys(b)); res.json(out); }));

  // ---------- Journal ----------
  r.get('/audit', H(async (req, res) => {
    const users = new Map(list(await C('users').get()).map((u) => [u.id, u.email]));
    res.json(list(await C('audit').orderBy('created_at', 'desc').limit(500).get()).map((a) => ({ ...a, email: users.get(a.user_id) || null })));
  }));
  r.get('/stripe-events', H(async (req, res) => res.json(list(await C('stripe_events').orderBy('received_at', 'desc').limit(200).get()))));

  return r;
}

module.exports = { makeAdmin };
