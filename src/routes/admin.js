'use strict';
// API d'administration (/api/admin/*) : réservée au rôle « admin », chaque action sensible est journalisée.
const express = require('express');
const fs = require('fs');
const { z } = require('zod');
const { now, bad, notFound, conflict, forbidden, slugify } = require('../lib/util');
const { getSettings, setSettings } = require('../lib/settings');
const { parse, asyncH, addressS } = require('./api');

// Attention : z.coerce.number() convertit null en 0 ; on normalise donc d'abord ''/null/undefined en null.
const nullish = (schema) => z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), schema.nullable()).optional();
const intOrNull = nullish(z.coerce.number().int());
const boolish = z.union([z.boolean(), z.literal(0).transform(() => false), z.literal(1).transform(() => true),
  z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true')]);

function makeAdmin({ db, cfg, auth, shop, premium, mailer, uploads, geo, audit, stats }) {
  const r = express.Router();
  r.use(auth.requireAdmin);
  const log = (req, action, details) => audit(req.user.id, action, details ? JSON.stringify(details).slice(0, 2000) : null, req.ip);

  // ---------- Tableau de bord ----------
  r.get('/stats', (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(366).optional() }), req.query);
    res.json(stats(q.days || 30));
  });

  // ---------- Catégories ----------
  const catS = z.object({ name: z.string().trim().min(1).max(80), slug: z.string().trim().max(80).optional(), description: z.string().max(1000).optional().nullable(),
    sort: z.coerce.number().int().optional(), active: boolish.optional() });
  r.get('/categories', (req, res) => res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS count FROM categories c ORDER BY sort, name`).all()));
  r.post('/categories', (req, res) => {
    const b = parse(catS, req.body);
    try {
      const id = db.prepare('INSERT INTO categories(slug, name, description, sort, active) VALUES (?,?,?,?,?)')
        .run(slugify(b.slug || b.name), b.name, b.description || null, b.sort || 0, b.active === false ? 0 : 1).lastInsertRowid;
      log(req, 'category_create', { id, name: b.name });
      res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('Ce slug existe déjà'); throw e; }
  });
  r.put('/categories/:id', (req, res) => {
    const b = parse(catS, req.body);
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
    if (!c) throw notFound();
    try {
      db.prepare('UPDATE categories SET slug=?, name=?, description=?, sort=?, active=? WHERE id=?')
        .run(slugify(b.slug || c.slug), b.name, b.description ?? null, b.sort ?? c.sort, b.active === undefined ? c.active : (b.active ? 1 : 0), c.id);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('Ce slug existe déjà'); throw e; }
    log(req, 'category_update', { id: c.id });
    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(c.id));
  });
  r.delete('/categories/:id', (req, res) => {
    const info = db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) throw notFound();
    log(req, 'category_delete', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // ---------- Produits & variantes ----------
  const variantS = z.object({ id: z.coerce.number().int().optional(), sku: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(120),
    price_cents: z.coerce.number().int().min(0).max(10_000_000), compare_at_cents: intOrNull, stock: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(1_000_000).nullable()),
    active: boolish.optional(), sort: z.coerce.number().int().optional() });
  const productS = z.object({ name: z.string().trim().min(1).max(160), slug: z.string().trim().max(80).optional(), description: z.string().max(20000).default(''),
    category_id: intOrNull, type: z.enum(['physical', 'digital']), material: z.string().trim().max(80).optional().nullable(),
    active: boolish.optional(), featured: boolish.optional(), premium_only: boolish.optional(), variants: z.array(variantS).min(1).max(100) });

  function productAdmin(id) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw notFound('Produit introuvable');
    return { ...p,
      variants: db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY sort, id').all(id).map((v) => ({ ...v,
        reserved: db.prepare(`SELECT COALESCE(SUM(qty),0) n FROM reservations WHERE variant_id = ? AND status = 'active' AND expires_at > ?`).get(v.id, now()).n })),
      images: db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(id).map((i) => ({ ...i, url: `/uploads/images/${i.filename}` })),
      files: db.prepare('SELECT id, original_name, size, created_at FROM product_files WHERE product_id = ?').all(id) };
  }

  r.get('/products', (req, res) => {
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const like = `%${(q.q || '').replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    res.json(db.prepare(`SELECT p.id, p.slug, p.name, p.type, p.active, p.featured, p.premium_only, c.name AS category,
      (SELECT MIN(price_cents) FROM variants v WHERE v.product_id = p.id) AS price_from,
      (SELECT SUM(stock) FROM variants v WHERE v.product_id = p.id) AS stock_total,
      (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS variants,
      (SELECT filename FROM product_images i WHERE i.product_id = p.id ORDER BY sort, id LIMIT 1) AS image
      FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.name LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' ORDER BY p.id DESC`).all(like, like)
      .map((p) => ({ ...p, image: p.image ? `/uploads/images/${p.image}` : null })));
  });
  r.get('/products/:id', (req, res) => res.json(productAdmin(Number(req.params.id))));

  function saveProduct(req, id) {
    const b = parse(productS, req.body);
    if (b.type === 'digital' && b.variants.some((v) => v.stock !== null)) throw bad('Un produit numérique n’a pas de stock (laissez le stock vide)');
    const skus = b.variants.map((v) => v.sku.toLowerCase());
    if (new Set(skus).size !== skus.length) throw bad('Chaque variante doit avoir un SKU unique');
    return db.atomic(() => {
      const t = now();
      const slug = slugify(b.slug || b.name);
      let pid = id;
      try {
        if (pid) {
          const info = db.prepare(`UPDATE products SET name=?, slug=?, description=?, category_id=?, type=?, material=?, active=?, featured=?, premium_only=?, updated_at=? WHERE id=?`)
            .run(b.name, slug, b.description, b.category_id ?? null, b.type, b.material || null, b.active === false ? 0 : 1, b.featured ? 1 : 0, b.premium_only ? 1 : 0, t, pid);
          if (!info.changes) throw notFound('Produit introuvable');
        } else {
          pid = Number(db.prepare(`INSERT INTO products(name, slug, description, category_id, type, material, active, featured, premium_only, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(b.name, slug, b.description, b.category_id ?? null, b.type, b.material || null, b.active === false ? 0 : 1, b.featured ? 1 : 0, b.premium_only ? 1 : 0, t, t).lastInsertRowid);
        }
      } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('Ce slug est déjà utilisé'); throw e; }
      const keep = [];
      for (const [i, v] of b.variants.entries()) {
        try {
          if (v.id) {
            const cur = db.prepare('SELECT * FROM variants WHERE id = ? AND product_id = ?').get(v.id, pid);
            if (!cur) throw bad('Variante inconnue');
            db.prepare(`UPDATE variants SET sku=?, name=?, price_cents=?, compare_at_cents=?, stock=?, active=?, sort=? WHERE id=?`)
              .run(v.sku, v.name, v.price_cents, v.compare_at_cents ?? null, v.stock, v.active === false ? 0 : 1, v.sort ?? i, v.id);
            keep.push(v.id);
          } else {
            keep.push(Number(db.prepare(`INSERT INTO variants(product_id, sku, name, price_cents, compare_at_cents, stock, active, sort) VALUES (?,?,?,?,?,?,?,?)`)
              .run(pid, v.sku, v.name, v.price_cents, v.compare_at_cents ?? null, v.stock, v.active === false ? 0 : 1, v.sort ?? i).lastInsertRowid));
          }
        } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict(`Le SKU « ${v.sku} » est déjà utilisé`); throw e; }
      }
      // Variantes retirées : supprimées si jamais vendues/réservées, sinon désactivées (historique conservé)
      for (const old of db.prepare('SELECT id FROM variants WHERE product_id = ?').all(pid)) {
        if (keep.includes(old.id)) continue;
        const used = db.prepare('SELECT 1 FROM order_items WHERE variant_id = ? UNION SELECT 1 FROM reservations WHERE variant_id = ?').get(old.id, old.id);
        if (used) db.prepare('UPDATE variants SET active = 0 WHERE id = ?').run(old.id); else db.prepare('DELETE FROM variants WHERE id = ?').run(old.id);
      }
      return pid;
    });
  }
  r.post('/products', (req, res) => { const id = saveProduct(req, null); log(req, 'product_create', { id }); res.status(201).json(productAdmin(id)); });
  r.put('/products/:id', (req, res) => { const id = saveProduct(req, Number(req.params.id)); log(req, 'product_update', { id }); res.json(productAdmin(id)); });
  r.delete('/products/:id', (req, res) => {
    const id = Number(req.params.id);
    const sold = db.prepare('SELECT 1 FROM order_items WHERE product_id = ?').get(id);
    if (sold) { db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(now(), id); log(req, 'product_archive', { id }); return res.json({ ok: true, archived: true }); }
    const imgs = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').all(id);
    const files = db.prepare('SELECT filename FROM product_files WHERE product_id = ?').all(id);
    db.atomic(() => { db.prepare('DELETE FROM reservations WHERE variant_id IN (SELECT id FROM variants WHERE product_id = ?)').run(id); db.prepare('DELETE FROM products WHERE id = ?').run(id); });
    imgs.forEach((i) => uploads.remove('images', i.filename)); files.forEach((f) => uploads.remove('products', f.filename));
    log(req, 'product_delete', { id });
    res.json({ ok: true });
  });
  r.post('/variants/:id/stock', (req, res) => {
    const b = parse(z.object({ delta: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional(), set: z.coerce.number().int().min(0).max(1_000_000).optional() }), req.body);
    const v = db.atomic(() => {
      const cur = db.prepare('SELECT * FROM variants WHERE id = ?').get(Number(req.params.id));
      if (!cur) throw notFound();
      if (cur.stock === null) throw bad('Stock non suivi pour cette variante');
      const next = b.set != null ? b.set : cur.stock + (b.delta || 0);
      if (next < 0) throw bad('Le stock ne peut pas être négatif');
      db.prepare('UPDATE variants SET stock = ? WHERE id = ?').run(next, cur.id);
      return db.prepare('SELECT * FROM variants WHERE id = ?').get(cur.id);
    });
    log(req, 'stock_adjust', { variant: v.id, stock: v.stock });
    res.json(v);
  });

  const imgUpload = uploads.mem(10, 10).array('images', 10);
  r.post('/products/:id/images', (req, res, next) => imgUpload(req, res, (e) => e ? next(bad('Image refusée (10 Mo max., 10 fichiers)')) : next()), (req, res) => {
    const pid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) throw notFound();
    const names = (req.files || []).map((f) => uploads.saveImage(f));
    let sort = db.prepare('SELECT COALESCE(MAX(sort), -1) m FROM product_images WHERE product_id = ?').get(pid).m;
    for (const n of names) db.prepare('INSERT INTO product_images(product_id, filename, alt, sort) VALUES (?,?,?,?)').run(pid, n, String(req.body.alt || '').slice(0, 200) || null, ++sort);
    log(req, 'images_add', { product: pid, count: names.length });
    res.status(201).json(productAdmin(pid).images);
  });
  r.put('/products/:id/images/order', (req, res) => {
    const b = parse(z.object({ ids: z.array(z.coerce.number().int()).max(50) }), req.body);
    db.atomic(() => b.ids.forEach((id, i) => db.prepare('UPDATE product_images SET sort = ? WHERE id = ? AND product_id = ?').run(i, id, Number(req.params.id))));
    res.json(productAdmin(Number(req.params.id)).images);
  });
  r.delete('/images/:id', (req, res) => {
    const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(Number(req.params.id));
    if (!img) throw notFound();
    db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
    uploads.remove('images', img.filename);
    res.json({ ok: true });
  });
  const stlUpload = uploads.mem(200, 5).array('files', 5);
  r.post('/products/:id/files', (req, res, next) => stlUpload(req, res, (e) => e ? next(bad('Fichier refusé (200 Mo max.)')) : next()), (req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!p) throw notFound();
    if (p.type !== 'digital') throw bad('Les fichiers STL ne peuvent être attachés qu’à un produit numérique');
    for (const f of req.files || []) {
      const name = uploads.saveModel(f, 'products');
      db.prepare('INSERT INTO product_files(product_id, filename, original_name, size, created_at) VALUES (?,?,?,?,?)').run(p.id, name, f.originalname.slice(0, 200), f.size, now());
    }
    log(req, 'files_add', { product: p.id });
    res.status(201).json(productAdmin(p.id).files);
  });
  r.delete('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM product_files WHERE id = ?').get(Number(req.params.id));
    if (!f) throw notFound();
    if (db.prepare('SELECT 1 FROM downloads WHERE product_file_id = ? AND revoked = 0').get(f.id)) throw conflict('Fichier déjà vendu : il reste téléchargeable par les acheteurs. Ajoutez plutôt une nouvelle version.');
    db.prepare('DELETE FROM product_files WHERE id = ?').run(f.id);
    uploads.remove('products', f.filename);
    res.json({ ok: true });
  });

  // ---------- Commandes ----------
  r.get('/orders', (req, res) => {
    const q = parse(z.object({ status: z.string().max(30).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).optional() }), req.query);
    const where = ['1=1'], args = [];
    if (q.status === 'to_process') where.push(`o.status IN ('paid','in_production')`);
    else if (q.status) { where.push('o.status = ?'); args.push(q.status); }
    if (q.q) { where.push(`(o.number LIKE ? OR o.email LIKE ? OR u.name LIKE ?)`); const l = `%${q.q}%`; args.push(l, l, l); }
    const per = 50, page = q.page || 1;
    const rows = db.prepare(`SELECT o.id, o.number, o.status, o.payment_status, o.total_cents, o.refunded_cents, o.email, o.shipping_method, o.created_at, o.paid_at, u.name AS customer
      FROM orders o JOIN users u ON u.id = o.user_id WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
    res.json(rows.map((o) => ({ ...o, status_label: shop.STATUS_LABELS[o.status] || o.status })));
  });
  function orderAdmin(id) {
    const o = db.prepare(`SELECT o.*, u.name AS customer FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(id);
    if (!o) throw notFound('Commande introuvable');
    return { ...o, status_label: shop.STATUS_LABELS[o.status],
      items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id),
      events: db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY id').all(id),
      refunds: db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY id').all(id),
      refund_requests: db.prepare('SELECT * FROM refund_requests WHERE order_id = ? ORDER BY id').all(id),
      refundable_cents: o.payment_status === 'paid' || o.payment_status === 'partially_refunded'
        ? o.total_cents - db.prepare(`SELECT COALESCE(SUM(amount_cents),0) n FROM refunds WHERE order_id = ? AND status IN ('pending','succeeded','requires_action')`).get(id).n : 0,
      statuses: shop.ADMIN_STATUS_FLOW.map((s) => ({ value: s, label: shop.STATUS_LABELS[s] })) };
  }
  r.get('/orders/:id', (req, res) => res.json(orderAdmin(Number(req.params.id))));
  r.post('/orders/:id/status', (req, res) => {
    const b = parse(z.object({ status: z.string(), tracking_carrier: z.string().trim().max(60).optional().nullable(), tracking_number: z.string().trim().max(80).optional().nullable(),
      tracking_url: z.string().trim().max(300).optional().nullable(), message: z.string().trim().max(1000).optional().nullable() }), req.body);
    shop.setStatus(Number(req.params.id), b.status, { ...b, actor: `admin:${req.user.id}` });
    log(req, 'order_status', { id: Number(req.params.id), status: b.status });
    res.json(orderAdmin(Number(req.params.id)));
  });
  r.patch('/orders/:id/address', asyncH(async (req, res) => {
    const a = parse(addressS, req.body);
    await shop.changeAddress(Number(req.params.id), a, { byAdmin: true, actor: `admin:${req.user.id}` });
    log(req, 'order_address', { id: Number(req.params.id) });
    res.json(orderAdmin(Number(req.params.id)));
  }));
  r.patch('/orders/:id/note', (req, res) => {
    const b = parse(z.object({ admin_note: z.string().max(5000) }), req.body);
    db.prepare('UPDATE orders SET admin_note = ?, updated_at = ? WHERE id = ?').run(b.admin_note, now(), Number(req.params.id));
    res.json(orderAdmin(Number(req.params.id)));
  });
  r.post('/orders/:id/refunds', asyncH(async (req, res) => {
    const b = parse(z.object({ amount_cents: z.coerce.number().int().positive(), reason: z.string().trim().max(500).optional(), restock: z.boolean().optional() }), req.body);
    const ref = await shop.refund(Number(req.params.id), b.amount_cents, { reason: b.reason, restock: !!b.restock, actor: `admin:${req.user.id}` });
    log(req, 'refund', { order: Number(req.params.id), amount: b.amount_cents, status: ref.status });
    res.status(201).json(orderAdmin(Number(req.params.id)));
  }));

  // ---------- Demandes de remboursement ----------
  r.get('/refund-requests', (req, res) => {
    res.json(db.prepare(`SELECT rr.*, o.number, o.total_cents, o.refunded_cents, u.name AS customer FROM refund_requests rr JOIN orders o ON o.id = rr.order_id
      JOIN users u ON u.id = rr.user_id ORDER BY rr.status = 'open' DESC, rr.id DESC LIMIT 200`).all());
  });
  r.post('/refund-requests/:id', asyncH(async (req, res) => {
    const b = parse(z.object({ action: z.enum(['approve', 'reject']), amount_cents: z.coerce.number().int().positive().optional(), restock: z.boolean().optional(),
      message: z.string().trim().max(1000).optional() }), req.body);
    const rr = db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(Number(req.params.id));
    if (!rr) throw notFound();
    if (rr.status !== 'open') throw conflict('Demande déjà traitée');
    if (b.action === 'approve') {
      if (!b.amount_cents) throw bad('Montant requis');
      await shop.refund(rr.order_id, b.amount_cents, { reason: `Demande client : ${rr.reason}`.slice(0, 500), restock: !!b.restock, actor: `admin:${req.user.id}` });
    }
    db.prepare('UPDATE refund_requests SET status = ?, admin_message = ?, updated_at = ? WHERE id = ?').run(b.action === 'approve' ? 'approved' : 'rejected', b.message || null, now(), rr.id);
    if (b.action === 'reject') {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(rr.order_id);
      mailer.compose(o.email, 'refund_rejected', `Demande de remboursement — ${o.number}`, ['Votre demande de remboursement n’a pas été acceptée.', ...(b.message ? [b.message] : [])]);
    }
    log(req, 'refund_request', { id: rr.id, action: b.action });
    res.json({ ok: true });
  }));

  // ---------- Clients ----------
  r.get('/customers', (req, res) => {
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const l = `%${q.q || ''}%`;
    res.json(db.prepare(`SELECT u.id, u.email, u.name, u.role, u.disabled, u.email_verified_at, u.premium_status, u.premium_until, u.created_at, u.deleted_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.payment_status != 'unpaid') AS orders,
      (SELECT COALESCE(SUM(total_cents - refunded_cents),0) FROM orders o WHERE o.user_id = u.id AND o.payment_status != 'unpaid') AS spent_cents
      FROM users u WHERE u.email LIKE ? OR u.name LIKE ? ORDER BY u.id DESC LIMIT 500`).all(l, l).map((u) => ({ ...u, premium: shop.isPremium(u) })));
  });
  r.get('/customers/:id', (req, res) => {
    const u = db.prepare('SELECT id, email, name, role, disabled, email_verified_at, premium_status, premium_until, premium_cancel_at_period_end, premium_sub_id, stripe_customer_id, created_at, deleted_at FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw notFound();
    res.json({ ...u, premium: shop.isPremium(u), addresses: db.prepare('SELECT * FROM addresses WHERE user_id = ?').all(u.id),
      orders: db.prepare('SELECT id, number, status, payment_status, total_cents, created_at FROM orders WHERE user_id = ? ORDER BY id DESC').all(u.id) });
  });
  r.patch('/customers/:id', (req, res) => {
    const b = parse(z.object({ disabled: z.boolean().optional(), role: z.enum(['customer', 'admin']).optional(), verify_email: z.boolean().optional() }), req.body);
    const id = Number(req.params.id);
    if (id === req.user.id && (b.disabled || b.role === 'customer')) throw forbidden('Vous ne pouvez pas vous désactiver ou retirer vos propres droits');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound();
    db.atomic(() => {
      if (b.disabled !== undefined) { db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, id); if (b.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
      if (b.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
      if (b.verify_email) db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(now(), id);
    });
    log(req, 'customer_update', { id, ...b });
    res.json({ ok: true });
  });
  r.post('/customers/:id/premium/cancel', asyncH(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw notFound();
    const b = parse(z.object({ immediately: z.boolean().optional() }), req.body);
    if (b.immediately) await premium.cancelNow(u); else await premium.setCancelAtPeriodEnd(u, true);
    log(req, 'premium_cancel', { id: u.id, immediately: !!b.immediately });
    res.json({ ok: true });
  }));

  // ---------- Codes promo ----------
  const promoS = z.object({ code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, 'lettres, chiffres, - et _ uniquement'), type: z.enum(['percent', 'fixed']),
    value: z.coerce.number().int().positive(), min_subtotal_cents: z.coerce.number().int().min(0).default(0), max_uses: intOrNull, per_user_limit: intOrNull,
    starts_at: intOrNull, ends_at: intOrNull, premium_only: boolish.optional(), active: boolish.optional() })
    .refine((p) => p.type !== 'percent' || p.value <= 100, { message: 'un pourcentage ne peut pas dépasser 100', path: ['value'] });
  r.get('/promos', (req, res) => res.json(db.prepare('SELECT * FROM promo_codes ORDER BY id DESC').all().map((p) => ({ ...p, uses: db.prepare(`SELECT COUNT(*) n FROM orders WHERE promo_code_id = ? AND payment_status != 'unpaid'`).get(p.id).n }))));
  function savePromo(req, id) {
    const b = parse(promoS, req.body);
    const vals = [b.code.toUpperCase(), b.type, b.value, b.min_subtotal_cents, b.max_uses ?? null, b.per_user_limit ?? null, b.starts_at ?? null, b.ends_at ?? null, b.premium_only ? 1 : 0, b.active === false ? 0 : 1];
    try {
      if (id) { const i = db.prepare('UPDATE promo_codes SET code=?, type=?, value=?, min_subtotal_cents=?, max_uses=?, per_user_limit=?, starts_at=?, ends_at=?, premium_only=?, active=? WHERE id=?').run(...vals, id); if (!i.changes) throw notFound(); return id; }
      return Number(db.prepare('INSERT INTO promo_codes(code, type, value, min_subtotal_cents, max_uses, per_user_limit, starts_at, ends_at, premium_only, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, now()).lastInsertRowid);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('Ce code existe déjà'); throw e; }
  }
  r.post('/promos', (req, res) => { const id = savePromo(req); log(req, 'promo_create', { id }); res.status(201).json(db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id)); });
  r.put('/promos/:id', (req, res) => { const id = savePromo(req, Number(req.params.id)); log(req, 'promo_update', { id }); res.json(db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id)); });
  r.delete('/promos/:id', (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM orders WHERE promo_code_id = ?').get(id)) { db.prepare('UPDATE promo_codes SET active = 0 WHERE id = ?').run(id); return res.json({ ok: true, archived: true }); }
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(id); log(req, 'promo_delete', { id }); res.json({ ok: true });
  });

  // ---------- Livraison ----------
  const zoneS = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['pickup', 'radius', 'postal']), description: z.string().max(500).optional().nullable(),
    radius_km: nullish(z.coerce.number().min(0.1).max(500)), postal_codes: z.string().max(5000).optional().nullable(),
    price_cents: z.coerce.number().int().min(0), free_above_cents: intOrNull, active: boolish.optional(), sort: z.coerce.number().int().optional() })
    .refine((zn) => zn.kind !== 'radius' || zn.radius_km, { message: 'rayon requis', path: ['radius_km'] })
    .refine((zn) => zn.kind !== 'postal' || (zn.postal_codes && /\d{4}/.test(zn.postal_codes)), { message: 'au moins un code postal', path: ['postal_codes'] });
  r.get('/shipping', (req, res) => {
    const s = getSettings(db);
    res.json({ zones: db.prepare('SELECT * FROM shipping_zones ORDER BY sort, id').all(), origin: { lat: s.origin_lat, lng: s.origin_lng },
      postcodes_count: db.prepare('SELECT COUNT(*) n FROM postcodes WHERE lat IS NOT NULL').get().n, geocoder: cfg.geocoder });
  });
  function saveZone(req, id) {
    const b = parse(zoneS, req.body);
    const vals = [b.name, b.kind, b.description || null, b.kind === 'radius' ? b.radius_km : null, b.kind === 'postal' ? b.postal_codes : null, b.price_cents, b.free_above_cents ?? null, b.active === false ? 0 : 1, b.sort || 0];
    if (id) { const i = db.prepare('UPDATE shipping_zones SET name=?, kind=?, description=?, radius_km=?, postal_codes=?, price_cents=?, free_above_cents=?, active=?, sort=? WHERE id=?').run(...vals, id); if (!i.changes) throw notFound(); return id; }
    return Number(db.prepare('INSERT INTO shipping_zones(name, kind, description, radius_km, postal_codes, price_cents, free_above_cents, active, sort) VALUES (?,?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
  }
  r.post('/shipping/zones', (req, res) => { const id = saveZone(req); log(req, 'zone_create', { id }); res.status(201).json(db.prepare('SELECT * FROM shipping_zones WHERE id = ?').get(id)); });
  r.put('/shipping/zones/:id', (req, res) => { const id = saveZone(req, Number(req.params.id)); log(req, 'zone_update', { id }); res.json(db.prepare('SELECT * FROM shipping_zones WHERE id = ?').get(id)); });
  r.delete('/shipping/zones/:id', (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM orders WHERE shipping_zone_id = ?').get(id)) { db.prepare('UPDATE shipping_zones SET active = 0 WHERE id = ?').run(id); return res.json({ ok: true, archived: true }); }
    db.prepare('DELETE FROM shipping_zones WHERE id = ?').run(id); log(req, 'zone_delete', { id }); res.json({ ok: true });
  });
  r.put('/shipping/origin', (req, res) => {
    const b = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }), req.body);
    setSettings(db, { origin_lat: b.lat, origin_lng: b.lng }); log(req, 'origin_update', b); res.json({ ok: true });
  });
  r.post('/shipping/postcodes', (req, res) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{4}$/), lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }), req.body);
    db.prepare('INSERT OR REPLACE INTO postcodes(code, lat, lng, source, updated_at) VALUES (?,?,?,?,?)').run(b.code, b.lat, b.lng, 'manuel', now());
    res.json({ ok: true });
  });
  const pcUpload = uploads.mem(20, 1).single('file');
  r.post('/shipping/postcodes/import', (req, res, next) => pcUpload(req, res, (e) => e ? next(bad('Fichier refusé')) : next()), (req, res) => {
    if (!req.file) throw bad('Fichier requis');
    const n = geo.importText(req.file.buffer.toString('utf8'), 'import');
    log(req, 'postcodes_import', { count: n });
    res.json({ imported: n });
  });
  r.post('/shipping/test', asyncH(async (req, res) => {
    const b = parse(z.object({ postal_code: z.string().regex(/^\d{4}$/) }), req.body);
    res.json(await shop.eligibleZones({ postal_code: b.postal_code, country: 'BE' }));
  }));

  // ---------- Sur mesure ----------
  r.get('/custom-requests', (req, res) => {
    const rows = db.prepare(`SELECT c.*, u.name AS customer, u.email, o.number AS order_number FROM custom_requests c JOIN users u ON u.id = c.user_id
      LEFT JOIN orders o ON o.id = c.order_id ORDER BY c.status = 'submitted' DESC, c.id DESC LIMIT 300`).all();
    res.json(rows.map((c) => ({ ...c, files: db.prepare('SELECT id, original_name, size FROM custom_files WHERE request_id = ?').all(c.id) })));
  });
  r.post('/custom-requests/:id/quote', (req, res) => {
    const b = parse(z.object({ quote_cents: z.coerce.number().int().min(50).max(10_000_000), quote_days: z.coerce.number().int().min(1).max(365), quote_message: z.string().trim().max(2000).optional() }), req.body);
    const c = db.prepare('SELECT * FROM custom_requests WHERE id = ?').get(Number(req.params.id));
    if (!c) throw notFound();
    if (!['submitted', 'quoted'].includes(c.status)) throw conflict('Le devis ne peut plus être modifié');
    db.prepare(`UPDATE custom_requests SET status = 'quoted', quote_cents = ?, quote_days = ?, quote_message = ?, updated_at = ? WHERE id = ?`).run(b.quote_cents, b.quote_days, b.quote_message || null, now(), c.id);
    const updated = db.prepare('SELECT * FROM custom_requests WHERE id = ?').get(c.id);
    mailer.T.customQuoted(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id), updated);
    log(req, 'custom_quote', { id: c.id, cents: b.quote_cents });
    res.json(updated);
  });
  r.post('/custom-requests/:id/reject', (req, res) => {
    const b = parse(z.object({ message: z.string().trim().max(2000).optional() }), req.body);
    const c = db.prepare('SELECT * FROM custom_requests WHERE id = ?').get(Number(req.params.id));
    if (!c) throw notFound();
    if (!['submitted', 'quoted'].includes(c.status)) throw conflict('Demande déjà engagée');
    db.prepare(`UPDATE custom_requests SET status = 'rejected', quote_message = ?, updated_at = ? WHERE id = ?`).run(b.message || null, now(), c.id);
    mailer.T.customRejected(db.prepare('SELECT * FROM users WHERE id = ?').get(c.user_id), { ...c, quote_message: b.message });
    log(req, 'custom_reject', { id: c.id });
    res.json({ ok: true });
  });
  r.get('/custom-files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM custom_files WHERE id = ?').get(Number(req.params.id));
    if (!f) throw notFound();
    const p = uploads.pathOf('custom', f.filename);
    if (!fs.existsSync(p)) throw notFound('Fichier manquant');
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(p, f.original_name);
  });

  // ---------- Newsletter ----------
  r.get('/newsletter', (req, res) => {
    res.json({ subscribers: db.prepare('SELECT id, email, status, created_at, confirmed_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 2000').all(),
      campaigns: db.prepare('SELECT * FROM newsletter_campaigns ORDER BY id DESC').all() });
  });
  r.delete('/newsletter/subscribers/:id', (req, res) => { db.prepare('DELETE FROM newsletter_subscribers WHERE id = ?').run(Number(req.params.id)); log(req, 'subscriber_delete', { id: Number(req.params.id) }); res.json({ ok: true }); });
  r.post('/newsletter/campaigns', (req, res) => {
    const b = parse(z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(10).max(50000) }), req.body);
    const id = db.prepare('INSERT INTO newsletter_campaigns(subject, body, created_at) VALUES (?,?,?)').run(b.subject, b.body, now()).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM newsletter_campaigns WHERE id = ?').get(id));
  });
  r.put('/newsletter/campaigns/:id', (req, res) => {
    const b = parse(z.object({ subject: z.string().trim().min(3).max(150), body: z.string().trim().min(10).max(50000) }), req.body);
    const i = db.prepare(`UPDATE newsletter_campaigns SET subject = ?, body = ? WHERE id = ? AND status = 'draft'`).run(b.subject, b.body, Number(req.params.id));
    if (!i.changes) throw conflict('Campagne introuvable ou déjà envoyée');
    res.json(db.prepare('SELECT * FROM newsletter_campaigns WHERE id = ?').get(Number(req.params.id)));
  });
  r.post('/newsletter/campaigns/:id/test', (req, res) => {
    const c = db.prepare('SELECT * FROM newsletter_campaigns WHERE id = ?').get(Number(req.params.id));
    if (!c) throw notFound();
    queueCampaignMail(c, req.user.email, null, '[TEST] ');
    res.json({ ok: true });
  });
  function queueCampaignMail(c, email, token, prefix = '') {
    const s = getSettings(db);
    const unsubUrl = token ? `${cfg.appUrl}/api/newsletter/unsubscribe?token=${token}` : `${cfg.appUrl}/#compte`;
    const paragraphs = c.body.split(/\n{2,}/);
    const html = mailer.layout(s.shop_name, c.subject, paragraphs.map((p) => `<p>${require('../lib/util').escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
      + `<p style="font-size:12px;color:#5b6070">Vous recevez ce message car vous êtes inscrit·e à la newsletter. <a href="${unsubUrl}">Se désinscrire</a></p>`, cfg.appUrl);
    mailer.queue({ to: email, subject: `${prefix}${c.subject}`, text: `${c.body}\n\nSe désinscrire : ${unsubUrl}`, html, kind: 'newsletter' });
  }
  r.post('/newsletter/campaigns/:id/send', (req, res) => {
    const n = db.atomic(() => {
      const c = db.prepare('SELECT * FROM newsletter_campaigns WHERE id = ?').get(Number(req.params.id));
      if (!c) throw notFound();
      if (c.status !== 'draft') throw conflict('Campagne déjà envoyée');
      const subs = db.prepare(`SELECT email, token FROM newsletter_subscribers WHERE status = 'confirmed'`).all();
      for (const s of subs) queueCampaignMail(c, s.email, s.token);
      db.prepare(`UPDATE newsletter_campaigns SET status = 'sent', sent_at = ?, recipients = ? WHERE id = ?`).run(now(), subs.length, c.id);
      return subs.length;
    });
    log(req, 'campaign_send', { id: Number(req.params.id), recipients: n });
    res.json({ ok: true, recipients: n });
  });

  // ---------- E-mails ----------
  r.get('/emails', (req, res) => res.json(db.prepare('SELECT id, to_addr, subject, kind, status, attempts, last_error, created_at, sent_at FROM emails ORDER BY id DESC LIMIT 300').all()));
  r.post('/emails/:id/retry', (req, res) => {
    db.prepare(`UPDATE emails SET status = 'queued', next_attempt_at = ?, attempts = 0 WHERE id = ? AND status = 'failed'`).run(now(), Number(req.params.id));
    res.json({ ok: true });
  });
  r.post('/emails/test', (req, res) => {
    mailer.compose(req.user.email, 'test', 'E-mail de test', ['Si vous lisez ce message, l’envoi d’e-mails fonctionne.']);
    res.json({ ok: true, smtp_configured: mailer.hasTransport });
  });

  // ---------- Paramètres ----------
  const settingsS = z.object({
    shop_name: z.string().trim().min(1).max(80), shop_tagline: z.string().trim().max(200), contact_email: z.union([z.string().trim().email(), z.literal('')]),
    shop_address: z.string().trim().max(300), require_email_verification: z.boolean(), download_max_count: z.coerce.number().int().min(1).max(1000),
    premium_enabled: z.boolean(), premium_price_cents: z.coerce.number().int().min(50).max(1_000_000), premium_interval: z.enum(['month', 'year']),
    premium_discount_percent: z.coerce.number().int().min(0).max(90), premium_free_shipping: z.boolean(), low_stock_threshold: z.coerce.number().int().min(0).max(10000),
    max_print_dimensions_mm: z.string().trim().max(60), materials: z.array(z.string().trim().min(1).max(40)).max(40), colors: z.array(z.string().trim().min(1).max(40)).max(60),
    terms_text: z.string().max(50000),
  }).partial();
  r.get('/settings', (req, res) => res.json({ ...getSettings(db), _env: { stripe: !!cfg.stripeSecretKey || !!cfg.stripeInjected, webhook: !!cfg.stripeWebhookSecret, smtp: mailer.hasTransport, app_url: cfg.appUrl } }));
  r.put('/settings', (req, res) => {
    const b = parse(settingsS, req.body);
    const out = setSettings(db, b);
    log(req, 'settings_update', Object.keys(b));
    res.json(out);
  });

  // ---------- Journal ----------
  r.get('/audit', (req, res) => res.json(db.prepare(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`).all()));
  r.get('/stripe-events', (req, res) => res.json(db.prepare('SELECT * FROM stripe_events ORDER BY received_at DESC LIMIT 200').all()));

  return r;
}

module.exports = { makeAdmin };
