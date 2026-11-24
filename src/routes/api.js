'use strict';
// API publique et espace client.
const express = require('express');
const fs = require('fs');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { now, bad, notFound, conflict, forbidden, randomToken, sha256, hashPassword, verifyPassword, dummyVerify, HttpError } = require('../lib/util');
const { getSettings } = require('../lib/settings');

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw bad(`${i.path.join('.') || 'données'} : ${i.message}`, 'validation');
  }
  return r.data;
}
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const emailS = z.string().trim().toLowerCase().email().max(200);
const passwordS = z.string().min(10, 'au moins 10 caractères').max(200);
const addressS = z.object({
  label: z.string().trim().max(60).optional().nullable(), name: z.string().trim().min(1).max(120), line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional().nullable(), postal_code: z.string().trim().regex(/^\d{4}$/, 'code postal belge à 4 chiffres'),
  city: z.string().trim().min(1).max(120), country: z.literal('BE').default('BE'), phone: z.string().trim().max(40).optional().nullable(),
});
const itemsS = z.array(z.object({ variantId: z.coerce.number().int().positive(), qty: z.coerce.number().int().min(1).max(99) })).max(50);

function publicUser(u, shop) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, email_verified: !!u.email_verified_at,
    premium: shop.isPremium(u), premium_status: u.premium_status, premium_until: u.premium_until, premium_cancel_at_period_end: !!u.premium_cancel_at_period_end };
}

function productRow(db, p, shop) {
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ? AND active = 1 ORDER BY sort, id').all(p.id);
  const images = db.prepare('SELECT id, filename, alt FROM product_images WHERE product_id = ? ORDER BY sort, id').all(p.id);
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description, type: p.type, material: p.material, featured: !!p.featured,
    premium_only: !!p.premium_only, category: p.category_slug ? { slug: p.category_slug, name: p.category_name } : null,
    images: images.map((i) => ({ url: `/uploads/images/${i.filename}`, alt: i.alt || p.name })),
    variants: variants.map((v) => {
      const avail = p.type === 'digital' ? null : shop.availableStock(v);
      return { id: v.id, name: v.name, sku: v.sku, price_cents: v.price_cents, compare_at_cents: v.compare_at_cents,
        available: avail === Infinity ? null : avail, in_stock: p.type === 'digital' || avail === Infinity || avail > 0 };
    }),
    files_count: p.type === 'digital' ? db.prepare('SELECT COUNT(*) n FROM product_files WHERE product_id = ?').get(p.id).n : 0,
  };
}

function makeApi({ db, cfg, auth, shop, premium, mailer, uploads, audit, stripe }) {
  const r = express.Router();
  const rl = cfg.rateLimits || {};
  const limiter = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Trop de tentatives. Réessayez plus tard.' } });
  const loginLimiter = limiter(15 * 60 * 1000, rl.login ?? 10);
  const registerLimiter = limiter(60 * 60 * 1000, rl.register ?? 10);
  const mailLimiter = limiter(60 * 60 * 1000, rl.mail ?? 5);

  // ---------- Configuration publique ----------
  r.get('/config', (req, res) => {
    const s = getSettings(db);
    res.json({
      shop_name: s.shop_name, tagline: s.shop_tagline, contact_email: s.contact_email, shop_address: s.shop_address,
      premium: { enabled: !!s.premium_enabled, price_cents: s.premium_price_cents, interval: s.premium_interval,
        discount_percent: s.premium_discount_percent, free_shipping: !!s.premium_free_shipping },
      materials: s.materials, colors: s.colors, max_print_dimensions_mm: s.max_print_dimensions_mm, terms_text: s.terms_text,
      require_email_verification: !!s.require_email_verification, reservation_minutes: cfg.reservationMinutes,
      payments_configured: !!cfg.stripeSecretKey || !!cfg.stripeInjected,
      user: publicUser(req.user, shop),
    });
  });

  // ---------- Catalogue ----------
  r.get('/categories', (req, res) => {
    res.json(db.prepare(`SELECT c.slug, c.name, c.description, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS count
      FROM categories c WHERE c.active = 1 ORDER BY c.sort, c.name`).all());
  });

  r.get('/products', (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), category: z.string().max(80).optional(),
      sort: z.enum(['featured', 'price_asc', 'price_desc', 'new', 'name']).optional(), type: z.enum(['physical', 'digital']).optional(),
      page: z.coerce.number().int().min(1).max(1000).optional(), per: z.coerce.number().int().min(1).max(60).optional() }), req.query);
    const where = ['p.active = 1'], args = [];
    if (q.q) {
      const terms = q.q.split(/\s+/).filter(Boolean).slice(0, 6);
      for (const t of terms) { where.push(`(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.material LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
        const like = `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`; args.push(like, like, like, like); }
    }
    if (q.category) { where.push('c.slug = ?'); args.push(q.category); }
    if (q.type) { where.push('p.type = ?'); args.push(q.type); }
    const order = { featured: 'p.featured DESC, p.created_at DESC', price_asc: 'min_price ASC', price_desc: 'min_price DESC', new: 'p.created_at DESC', name: 'p.name COLLATE NOCASE' }[q.sort || 'featured'];
    const per = q.per || 24, page = q.page || 1;
    const base = `FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where.join(' AND ')}
      AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.active = 1)`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...args).n;
    const rows = db.prepare(`SELECT p.*, c.slug AS category_slug, c.name AS category_name,
      (SELECT MIN(price_cents) FROM variants v WHERE v.product_id = p.id AND v.active = 1) AS min_price ${base}
      ORDER BY ${order}, p.id LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
    res.json({ total, page, per, items: rows.map((p) => {
      const full = productRow(db, p, shop);
      return { id: full.id, slug: full.slug, name: full.name, type: full.type, material: full.material, featured: full.featured,
        premium_only: full.premium_only, category: full.category, image: full.images[0] || null, price_from_cents: p.min_price,
        in_stock: full.variants.some((v) => v.in_stock), variants_count: full.variants.length };
    }) });
  });

  r.get('/products/:slug', (req, res) => {
    const p = db.prepare(`SELECT p.*, c.slug AS category_slug, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ? AND p.active = 1`).get(String(req.params.slug));
    if (!p) throw notFound('Produit introuvable');
    res.json(productRow(db, p, shop));
  });

  // ---------- Panier / livraison ----------
  r.post('/shipping/options', asyncH(async (req, res) => {
    const b = parse(z.object({ postal_code: z.string().trim().max(10).optional().default(''), country: z.string().trim().max(2).optional().default('BE') }), req.body);
    res.json(await shop.eligibleZones(b.postal_code ? b : null));
  }));

  r.post('/cart/quote', asyncH(async (req, res) => {
    const b = parse(z.object({ items: itemsS, promoCode: z.string().trim().max(40).optional().nullable(), shippingZoneId: z.coerce.number().int().optional().nullable(),
      postal_code: z.string().trim().max(10).optional().nullable() }), req.body);
    const address = b.postal_code ? { postal_code: b.postal_code, country: 'BE' } : null;
    res.json(await shop.quote(req.user, { items: b.items, promoCode: b.promoCode || null, shippingZoneId: b.shippingZoneId ?? null, address }));
  }));

  // ---------- Authentification ----------
  r.post('/auth/register', registerLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS, password: passwordS, name: z.string().trim().min(1).max(120), newsletter: z.boolean().optional(),
      accept_terms: z.literal(true, { message: 'acceptez les conditions générales' }) }), req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) throw conflict('Un compte existe déjà avec cette adresse', 'email_taken');
    const hash = await hashPassword(b.password, cfg.scrypt);
    let userId;
    try {
      userId = Number(db.prepare('INSERT INTO users(email, password_hash, name, created_at) VALUES (?,?,?,?)').run(b.email, hash, b.name, now()).lastInsertRowid);
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw conflict('Un compte existe déjà avec cette adresse', 'email_taken'); throw e; }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    sendVerification(user);
    if (b.newsletter) subscribeNewsletter(b.email, userId);
    auth.createSession(req, res, userId);
    res.status(201).json({ user: publicUser(user, shop) });
  }));

  function sendVerification(user) {
    const token = randomToken(32);
    db.prepare(`DELETE FROM tokens WHERE user_id = ? AND type = 'verify'`).run(user.id);
    db.prepare(`INSERT INTO tokens(id_hash, user_id, type, expires_at) VALUES (?,?, 'verify', ?)`).run(sha256(token), user.id, now() + 86400);
    mailer.T.verify(user, `${cfg.appUrl}/api/auth/verify?token=${token}`);
  }

  r.post('/auth/login', loginLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ email: emailS, password: z.string().min(1).max(200) }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(b.email);
    const ok = u ? await verifyPassword(b.password, u.password_hash) : await dummyVerify(b.password, cfg.scrypt);
    if (!ok || !u) throw new HttpError(401, 'E-mail ou mot de passe incorrect', 'bad_credentials');
    if (u.disabled) throw forbidden('Ce compte est désactivé');
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(u.id, now());
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.sessionHash); // pas de réutilisation d'une ancienne session
    auth.createSession(req, res, u.id);
    if (u.role === 'admin') audit(u.id, 'admin_login', null, req.ip);
    res.json({ user: publicUser(u, shop) });
  }));

  r.post('/auth/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

  r.get('/auth/verify', (req, res) => {
    const token = String(req.query.token || '');
    const row = db.prepare(`SELECT * FROM tokens WHERE id_hash = ? AND type = 'verify'`).get(sha256(token));
    if (!row || row.used_at || row.expires_at < now()) return res.redirect(302, '/?verification=invalide#compte');
    db.atomic(() => {
      db.prepare('UPDATE tokens SET used_at = ? WHERE id_hash = ?').run(now(), row.id_hash);
      db.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(now(), row.user_id);
    });
    res.redirect(302, '/?verification=ok#compte');
  });

  r.post('/auth/verify/resend', mailLimiter, auth.requireUser, (req, res) => {
    if (req.user.email_verified_at) return res.json({ ok: true, already: true });
    sendVerification(req.user); res.json({ ok: true });
  });

  r.post('/auth/password/forgot', mailLimiter, (req, res) => {
    const b = parse(z.object({ email: emailS }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL AND disabled = 0').get(b.email);
    if (u) {
      const token = randomToken(32);
      db.prepare(`DELETE FROM tokens WHERE user_id = ? AND type = 'reset'`).run(u.id);
      db.prepare(`INSERT INTO tokens(id_hash, user_id, type, expires_at) VALUES (?,?, 'reset', ?)`).run(sha256(token), u.id, now() + 3600);
      mailer.T.reset(u, `${cfg.appUrl}/?reinitialisation=${token}#mot-de-passe`);
    }
    res.json({ ok: true }); // réponse identique : pas d'énumération des comptes
  });

  r.post('/auth/password/reset', loginLimiter, asyncH(async (req, res) => {
    const b = parse(z.object({ token: z.string().min(10).max(100), password: passwordS }), req.body);
    const row = db.prepare(`SELECT * FROM tokens WHERE id_hash = ? AND type = 'reset'`).get(sha256(b.token));
    if (!row || row.used_at || row.expires_at < now()) throw bad('Lien invalide ou expiré', 'token_invalid');
    const hash = await hashPassword(b.password, cfg.scrypt);
    db.atomic(() => {
      db.prepare('UPDATE tokens SET used_at = ? WHERE id_hash = ?').run(now(), row.id_hash);
      db.prepare('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(hash, now(), row.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // déconnexion de tous les appareils
    });
    res.json({ ok: true });
  }));

  // ---------- Profil ----------
  r.get('/me', auth.requireUser, (req, res) => res.json(publicUser(req.user, shop)));
  r.patch('/me', auth.requireUser, (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(b.name, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), shop));
  });
  r.post('/me/password', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ current: z.string().min(1).max(200), password: passwordS }), req.body);
    if (!(await verifyPassword(b.current, req.user.password_hash))) throw new HttpError(401, 'Mot de passe actuel incorrect', 'bad_credentials');
    const hash = await hashPassword(b.password, cfg.scrypt);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(req.user.id, req.sessionHash);
    res.json({ ok: true });
  }));
  r.delete('/me', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    if (!(await verifyPassword(b.password, req.user.password_hash))) throw new HttpError(401, 'Mot de passe incorrect', 'bad_credentials');
    if (req.user.role === 'admin') throw forbidden('Un administrateur ne peut pas supprimer son compte ici');
    if (shop.isPremium(req.user) && !req.user.premium_cancel_at_period_end) throw conflict('Résiliez d’abord votre abonnement Premium');
    const u = req.user;
    db.atomic(() => {
      db.prepare(`UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE email = ? OR user_id = ?`).run(u.email, u.id);
      db.prepare('DELETE FROM addresses WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare(`UPDATE users SET email = ?, name = 'Compte supprimé', password_hash = '!', deleted_at = ? WHERE id = ?`).run(`supprime-${u.id}-${randomToken(6)}@invalid`, now(), u.id);
    });
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  }));

  // ---------- Adresses ----------
  r.get('/me/addresses', auth.requireUser, (req, res) => res.json(db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY id').all(req.user.id)));
  r.post('/me/addresses', auth.requireUser, (req, res) => {
    const a = parse(addressS, req.body);
    if (db.prepare('SELECT COUNT(*) n FROM addresses WHERE user_id = ?').get(req.user.id).n >= 20) throw bad('Nombre maximum d’adresses atteint');
    const id = db.prepare('INSERT INTO addresses(user_id, label, name, line1, line2, postal_code, city, country, phone) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, a.label || null, a.name, a.line1, a.line2 || null, a.postal_code, a.city, a.country, a.phone || null).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM addresses WHERE id = ?').get(id));
  });
  r.put('/me/addresses/:id', auth.requireUser, (req, res) => {
    const a = parse(addressS, req.body);
    const info = db.prepare('UPDATE addresses SET label=?, name=?, line1=?, line2=?, postal_code=?, city=?, country=?, phone=? WHERE id = ? AND user_id = ?')
      .run(a.label || null, a.name, a.line1, a.line2 || null, a.postal_code, a.city, a.country, a.phone || null, Number(req.params.id), req.user.id);
    if (!info.changes) throw notFound('Adresse introuvable');
    res.json(db.prepare('SELECT * FROM addresses WHERE id = ?').get(Number(req.params.id)));
  });
  r.delete('/me/addresses/:id', auth.requireUser, (req, res) => {
    const info = db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    if (!info.changes) throw notFound('Adresse introuvable');
    res.json({ ok: true });
  });

  // ---------- Paiement ----------
  r.post('/checkout', auth.requireUser, asyncH(async (req, res) => {
    const b = parse(z.object({ items: itemsS.min(1), promoCode: z.string().trim().max(40).optional().nullable(), shippingZoneId: z.coerce.number().int().optional().nullable(),
      addressId: z.coerce.number().int().optional().nullable(), address: addressS.optional().nullable(), note: z.string().max(1000).optional().nullable(),
      checkoutKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }), req.body);
    res.json(await shop.startCheckout(req.user, b));
  }));

  // ---------- Commandes du client ----------
  function orderFor(req) {
    const o = db.prepare('SELECT * FROM orders WHERE number = ? AND user_id = ?').get(String(req.params.number), req.user.id);
    if (!o) throw notFound('Commande introuvable');
    return o;
  }
  function orderDetail(o) {
    const { stripe_session_url, stripe_session_id, stripe_coupon_id, checkout_key, admin_note, ...pub } = o;
    return {
      ...pub, status_label: shop.STATUS_LABELS[o.status] || o.status,
      pay_url: o.status === 'pending_payment' && o.reservation_expires_at > now() ? stripe_session_url : null,
      items: db.prepare('SELECT id, product_name, variant_name, sku, type, unit_price_cents, qty, line_total_cents FROM order_items WHERE order_id = ?').all(o.id),
      events: db.prepare(`SELECT type, message, created_at FROM order_events WHERE order_id = ? AND type NOT IN ('stripe_error') ORDER BY id`).all(o.id),
      refunds: db.prepare('SELECT amount_cents, status, created_at FROM refunds WHERE order_id = ? ORDER BY id').all(o.id),
      refund_requests: db.prepare('SELECT reason, status, admin_message, created_at FROM refund_requests WHERE order_id = ? ORDER BY id').all(o.id),
      downloads: db.prepare(`SELECT d.id, d.count, d.max_count, d.revoked, f.original_name, f.size FROM downloads d JOIN product_files f ON f.id = d.product_file_id WHERE d.order_id = ?`).all(o.id),
      address_editable: o.needs_shipping === 1 && ['paid', 'in_production', 'payment_processing'].includes(o.status) && !!o.ship_line1,
    };
  }
  r.get('/me/orders', auth.requireUser, (req, res) => {
    res.json(db.prepare(`SELECT number, status, payment_status, total_cents, refunded_cents, created_at, paid_at FROM orders
      WHERE user_id = ? AND status NOT IN ('cancelled','expired') OR (user_id = ? AND payment_status != 'unpaid') ORDER BY id DESC LIMIT 200`)
      .all(req.user.id, req.user.id).map((o) => ({ ...o, status_label: shop.STATUS_LABELS[o.status] || o.status })));
  });
  r.get('/me/orders/:number', auth.requireUser, (req, res) => res.json(orderDetail(orderFor(req))));
  r.patch('/me/orders/:number/address', auth.requireUser, asyncH(async (req, res) => {
    const o = orderFor(req);
    const a = parse(addressS, req.body);
    await shop.changeAddress(o.id, a, { userId: req.user.id, actor: 'client' });
    res.json(orderDetail(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)));
  }));
  r.post('/me/orders/:number/cancel', auth.requireUser, asyncH(async (req, res) => {
    const o = orderFor(req);
    if (o.status !== 'pending_payment') throw conflict('Seule une commande en attente de paiement peut être annulée ici');
    const changed = db.atomic(() => {
      const r2 = db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_payment' AND payment_status = 'unpaid'`).run(now(), o.id);
      if (r2.changes) { db.prepare(`UPDATE reservations SET status = 'released' WHERE order_id = ? AND status = 'active'`).run(o.id); shop.addEvent(o.id, 'cancelled', 'Annulée par le client', 'client'); }
      return r2.changes;
    });
    if (changed && o.stripe_session_id) { try { await stripe.checkout.sessions.expire(o.stripe_session_id); } catch { /* déjà expirée ou payée : le webhook tranchera */ } }
    res.json({ ok: true });
  }));
  r.post('/me/orders/:number/refund-request', auth.requireUser, (req, res) => {
    const o = orderFor(req);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(1000) }), req.body);
    if (!['paid', 'partially_refunded'].includes(o.payment_status)) throw conflict('Aucun paiement remboursable sur cette commande');
    if (db.prepare(`SELECT 1 FROM refund_requests WHERE order_id = ? AND status = 'open'`).get(o.id)) throw conflict('Une demande est déjà en cours');
    db.prepare('INSERT INTO refund_requests(order_id, user_id, reason, created_at, updated_at) VALUES (?,?,?,?,?)').run(o.id, req.user.id, b.reason, now(), now());
    shop.addEvent(o.id, 'refund_request', 'Demande de remboursement envoyée', 'client');
    mailer.T.adminNotify(`Demande de remboursement ${o.number}`, b.reason);
    res.status(201).json({ ok: true });
  });

  // ---------- Téléchargements STL ----------
  r.get('/me/downloads', auth.requireUser, (req, res) => {
    res.json(db.prepare(`SELECT d.id, d.count, d.max_count, d.revoked, f.original_name, f.size, o.number, p.name AS product_name
      FROM downloads d JOIN product_files f ON f.id = d.product_file_id JOIN orders o ON o.id = d.order_id LEFT JOIN products p ON p.id = f.product_id
      WHERE d.user_id = ? ORDER BY d.id DESC`).all(req.user.id));
  });
  r.get('/downloads/:id', auth.requireUser, (req, res) => {
    const d = db.atomic(() => {
      const row = db.prepare(`SELECT d.*, f.filename, f.original_name, o.payment_status FROM downloads d JOIN product_files f ON f.id = d.product_file_id
        JOIN orders o ON o.id = d.order_id WHERE d.id = ? AND d.user_id = ?`).get(Number(req.params.id), req.user.id);
      if (!row) throw notFound('Téléchargement introuvable');
      if (row.revoked || !['paid', 'partially_refunded'].includes(row.payment_status)) throw forbidden('Ce téléchargement n’est plus disponible');
      const upd = db.prepare('UPDATE downloads SET count = count + 1 WHERE id = ? AND count < max_count').run(row.id);
      if (!upd.changes) throw forbidden('Nombre maximum de téléchargements atteint');
      return row;
    });
    const file = uploads.pathOf('products', d.filename);
    if (!fs.existsSync(file)) throw notFound('Fichier manquant sur le serveur');
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(file, d.original_name);
  });

  // ---------- Premium ----------
  r.post('/premium/subscribe', auth.requireUser, asyncH(async (req, res) => res.json(await premium.subscribe(req.user))));
  r.post('/premium/cancel', auth.requireUser, asyncH(async (req, res) => { await premium.setCancelAtPeriodEnd(req.user, true); res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), shop)); }));
  r.post('/premium/resume', auth.requireUser, asyncH(async (req, res) => { await premium.setCancelAtPeriodEnd(req.user, false); res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), shop)); }));

  // ---------- Commandes personnalisées ----------
  const customUpload = uploads.mem(50, 5).array('files', 5);
  r.post('/custom-requests', auth.requireUser, (req, res, next) => customUpload(req, res, (e) => e ? next(bad(e.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (50 Mo max.)' : 'Téléversement refusé')) : next()), (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(3).max(120), description: z.string().trim().min(10).max(5000), material: z.string().trim().max(40).optional(),
      color: z.string().trim().max(40).optional(), quantity: z.coerce.number().int().min(1).max(500), dimensions: z.string().trim().max(120).optional() }), req.body);
    const open = db.prepare(`SELECT COUNT(*) n FROM custom_requests WHERE user_id = ? AND status IN ('submitted','quoted')`).get(req.user.id).n;
    if (open >= 10) throw conflict('Trop de demandes en cours');
    const saved = (req.files || []).map((f) => ({ name: uploads.saveCustomFile(f), original: f.originalname.slice(0, 200), size: f.size }));
    const id = db.atomic(() => {
      const rid = Number(db.prepare(`INSERT INTO custom_requests(user_id, title, description, material, color, quantity, dimensions, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(req.user.id, b.title, b.description, b.material || null, b.color || null, b.quantity, b.dimensions || null, now(), now()).lastInsertRowid);
      for (const f of saved) db.prepare('INSERT INTO custom_files(request_id, filename, original_name, size) VALUES (?,?,?,?)').run(rid, f.name, f.original, f.size);
      return rid;
    });
    mailer.T.adminNotify('Nouvelle demande sur mesure', `${b.title}\n\n${b.description}`);
    res.status(201).json({ id });
  });
  r.get('/me/custom-requests', auth.requireUser, (req, res) => {
    const rows = db.prepare(`SELECT c.*, o.number AS order_number FROM custom_requests c LEFT JOIN orders o ON o.id = c.order_id WHERE c.user_id = ? ORDER BY c.id DESC`).all(req.user.id);
    res.json(rows.map((c) => ({ ...c, files: db.prepare('SELECT original_name, size FROM custom_files WHERE request_id = ?').all(c.id) })));
  });
  r.post('/custom-requests/:id/cancel', auth.requireUser, (req, res) => {
    const info = db.prepare(`UPDATE custom_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('submitted','quoted')`).run(now(), Number(req.params.id), req.user.id);
    if (!info.changes) throw conflict('Cette demande ne peut plus être annulée');
    res.json({ ok: true });
  });
  r.post('/custom-requests/:id/accept', auth.requireUser, asyncH(async (req, res) => {
    const c = db.prepare('SELECT * FROM custom_requests WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!c) throw notFound('Demande introuvable');
    if (c.status !== 'quoted' && !(c.status === 'accepted')) throw conflict('Aucun devis à accepter');
    const b = parse(z.object({ shippingZoneId: z.coerce.number().int(), addressId: z.coerce.number().int().optional().nullable(),
      address: addressS.optional().nullable(), checkoutKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }), req.body);
    const out = await shop.startCheckout(req.user, { ...b, items: [] }, { custom: { name: `Sur mesure : ${c.title}`, price_cents: c.quote_cents, requestId: c.id } });
    const o = db.prepare('SELECT id FROM orders WHERE number = ?').get(out.number);
    db.prepare(`UPDATE custom_requests SET status = 'accepted', order_id = ?, updated_at = ? WHERE id = ?`).run(o.id, now(), c.id);
    res.json(out);
  }));

  // ---------- Newsletter ----------
  function subscribeNewsletter(email, userId = null) {
    const ex = db.prepare('SELECT * FROM newsletter_subscribers WHERE email = ?').get(email);
    if (ex && ex.status === 'confirmed') return 'already';
    const token = ex ? ex.token : randomToken(24);
    if (ex) db.prepare(`UPDATE newsletter_subscribers SET status = 'pending', user_id = COALESCE(user_id, ?) WHERE id = ?`).run(userId, ex.id);
    else db.prepare(`INSERT INTO newsletter_subscribers(email, status, token, user_id, created_at) VALUES (?, 'pending', ?, ?, ?)`).run(email, token, userId, now());
    mailer.T.newsletterConfirm(email, `${cfg.appUrl}/api/newsletter/confirm?token=${token}`);
    return 'pending';
  }
  r.post('/newsletter/subscribe', mailLimiter, (req, res) => {
    const b = parse(z.object({ email: emailS }), req.body);
    subscribeNewsletter(b.email, req.user && req.user.email.toLowerCase() === b.email ? req.user.id : null);
    res.json({ ok: true, message: 'Si cette adresse est valide, un e-mail de confirmation vient d’être envoyé.' });
  });
  r.get('/newsletter/confirm', (req, res) => {
    const info = db.prepare(`UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = ? WHERE token = ? AND status = 'pending'`).run(now(), String(req.query.token || ''));
    res.redirect(302, info.changes ? '/?newsletter=ok' : '/?newsletter=invalide');
  });
  const unsub = (req, res) => {
    const token = String((req.body && req.body.token) || req.query.token || '');
    db.prepare(`UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE token = ?`).run(token);
    if (req.method === 'GET') return res.redirect(302, '/?newsletter=desinscrit');
    res.json({ ok: true });
  };
  r.get('/newsletter/unsubscribe', unsub);
  r.get('/me/newsletter', auth.requireUser, (req, res) => {
    const row = db.prepare('SELECT status FROM newsletter_subscribers WHERE email = ?').get(req.user.email);
    res.json({ status: row ? row.status : 'none' });
  });
  r.post('/me/newsletter', auth.requireUser, (req, res) => {
    const b = parse(z.object({ subscribe: z.boolean() }), req.body);
    if (b.subscribe) return res.json({ status: subscribeNewsletter(req.user.email.toLowerCase(), req.user.id) });
    db.prepare(`UPDATE newsletter_subscribers SET status = 'unsubscribed' WHERE email = ?`).run(req.user.email);
    res.json({ status: 'unsubscribed' });
  });

  return { router: r, unsub };
}

module.exports = { makeApi, parse, asyncH, addressS };
