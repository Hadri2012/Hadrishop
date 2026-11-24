'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, client, createUser, createProduct } = require('./helpers');

describe('Comptes, sessions et sécurité', () => {
  let ctx, admin;
  before(async () => { ctx = setup(); admin = await createUser(ctx, { role: 'admin' }); });
  after(() => ctx.db.close());

  test('inscription : cookie HttpOnly SameSite, e-mail de vérification, mot de passe haché', async () => {
    const c = client(ctx);
    const r = await c.post('/api/auth/register').send({ email: 'Nouveau@Test.be', password: 'un-mot-de-passe-long', name: 'Nouveau', accept_terms: true });
    assert.equal(r.status, 201);
    const cookie = r.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    const u = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get('nouveau@test.be');
    assert.match(u.password_hash, /^scrypt\$/);
    assert.ok(!u.password_hash.includes('un-mot-de-passe-long'));
    const mail = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'verify' AND to_addr = ?`).get('nouveau@test.be');
    const token = mail.text_body.match(/token=([A-Za-z0-9_-]+)/)[1];
    const v = await request(ctx.app).get('/api/auth/verify?token=' + token);
    assert.equal(v.status, 302); assert.match(v.headers.location, /verification=ok/);
    assert.ok(ctx.db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(u.id).email_verified_at);
    const again = await request(ctx.app).get('/api/auth/verify?token=' + token);
    assert.match(again.headers.location, /invalide/, 'jeton à usage unique');
    const dup = await c.post('/api/auth/register').send({ email: 'nouveau@test.be', password: 'un-mot-de-passe-long', name: 'X', accept_terms: true });
    assert.equal(dup.status, 409);
    const weak = await client(ctx).post('/api/auth/register').send({ email: 'w@test.be', password: 'court', name: 'X', accept_terms: true });
    assert.equal(weak.status, 400);
  });

  test('connexion : mauvais mot de passe refusé, message identique si e-mail inconnu', async () => {
    const u = await createUser(ctx, { email: 'login@test.be' });
    const a = await client(ctx).post('/api/auth/login').send({ email: 'login@test.be', password: 'faux-mot-de-passe' });
    const b = await client(ctx).post('/api/auth/login').send({ email: 'inconnu@test.be', password: 'faux-mot-de-passe' });
    assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.error, b.body.error);
    const out = await u.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.equal((await u.get('/api/me')).status, 401, 'session détruite côté serveur');
  });

  test('limitation des tentatives de connexion', async () => {
    const limited = setup({ rateLimits: { login: 3 } });
    const c = client(limited);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login').send({ email: 'x@test.be', password: 'nimporte' })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    limited.db.close();
  });

  test('réinitialisation du mot de passe : jeton unique, sessions révoquées, pas d’énumération', async () => {
    const u = await createUser(ctx, { email: 'reset@test.be' });
    const unknown = await client(ctx).post('/api/auth/password/forgot').send({ email: 'personne@test.be' });
    const known = await client(ctx).post('/api/auth/password/forgot').send({ email: 'reset@test.be' });
    assert.deepEqual(unknown.body, known.body);
    const mail = ctx.db.prepare(`SELECT * FROM emails WHERE kind = 'reset' AND to_addr = ?`).get('reset@test.be');
    const token = mail.text_body.match(/reinitialisation=([A-Za-z0-9_-]+)/)[1];
    const r = await client(ctx).post('/api/auth/password/reset').send({ token, password: 'nouveau-mot-de-passe' });
    assert.equal(r.status, 200);
    assert.equal((await u.get('/api/me')).status, 401, 'anciennes sessions révoquées');
    assert.equal((await client(ctx).post('/api/auth/password/reset').send({ token, password: 'encore-un-autre-mdp' })).status, 400);
    assert.equal((await client(ctx).post('/api/auth/login').send({ email: 'reset@test.be', password: 'nouveau-mot-de-passe' })).status, 200);
  });

  test('CSRF : requête sans en-tête dédié ou d’une autre origine refusée', async () => {
    const u = await createUser(ctx);
    const noHeader = await u.agent.post('/api/me/addresses').send({ name: 'A', line1: 'B', postal_code: '1000', city: 'C' });
    assert.equal(noHeader.status, 403);
    const evil = await u.agent.post('/api/me/addresses').set('X-Hadrishop', '1').set('Origin', 'https://evil.example').send({ name: 'A', line1: 'B', postal_code: '1000', city: 'C' });
    assert.equal(evil.status, 403);
  });

  test('toutes les routes /api/admin sont refusées aux clients et aux visiteurs', async () => {
    const cust = await createUser(ctx);
    const anon = client(ctx);
    const routes = [['get', '/api/admin/stats'], ['get', '/api/admin/orders'], ['get', '/api/admin/products'], ['post', '/api/admin/products'],
      ['get', '/api/admin/customers'], ['patch', '/api/admin/customers/1'], ['get', '/api/admin/settings'], ['put', '/api/admin/settings'],
      ['post', '/api/admin/promos'], ['post', '/api/admin/shipping/zones'], ['get', '/api/admin/newsletter'], ['post', '/api/admin/newsletter/campaigns/1/send'],
      ['post', '/api/admin/orders/1/refunds'], ['get', '/api/admin/emails'], ['get', '/api/admin/audit'], ['get', '/api/admin/custom-requests']];
    for (const [m, url] of routes) {
      assert.equal((await cust[m](url).send({})).status, 403, `${m} ${url} (client)`);
      assert.equal((await anon[m](url).send({})).status, 401, `${m} ${url} (anonyme)`);
    }
  });

  test('un admin ne peut pas retirer ses propres droits ; un compte désactivé est déconnecté', async () => {
    assert.equal((await admin.patch(`/api/admin/customers/${admin.user.id}`).send({ role: 'customer' })).status, 403);
    const u = await createUser(ctx);
    assert.equal((await admin.patch(`/api/admin/customers/${u.user.id}`).send({ disabled: true })).status, 200);
    assert.equal((await u.get('/api/me')).status, 401);
    assert.equal((await client(ctx).post('/api/auth/login').send({ email: u.user.email, password: u.password })).status, 403);
  });

  test('en-têtes de sécurité et CSP stricte sur les pages', async () => {
    const r = await request(ctx.app).get('/');
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal((await request(ctx.app).get('/admin')).status, 200);
  });

  test('téléversement : une image SVG/HTML déguisée en PNG est refusée', async () => {
    const p = await createProduct(admin, { name: 'Upload' });
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await admin.post(`/api/admin/products/${p.id}/images`).attach('images', evil, { filename: 'image.png', contentType: 'image/png' });
    assert.equal(r.status, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const ok = await admin.post(`/api/admin/products/${p.id}/images`).attach('images', png, { filename: 'vrai.png', contentType: 'image/png' });
    assert.equal(ok.status, 201);
    const img = await request(ctx.app).get(ok.body[0].url);
    assert.equal(img.status, 200);
    assert.equal(img.headers['x-content-type-options'], 'nosniff');
  });

  test('erreurs internes jamais exposées, JSON invalide géré', async () => {
    const r = await request(ctx.app).post('/api/auth/login').set('X-Hadrishop', '1').set('Content-Type', 'application/json').send('{pas du json');
    assert.equal(r.status, 400);
    assert.equal((await request(ctx.app).get('/api/inexistant')).status, 404);
  });

  test('recherche : caractères spéciaux SQL traités comme du texte', async () => {
    await createProduct(admin, { name: 'Porte-clés 100% recyclé' });
    const r = await request(ctx.app).get('/api/products').query({ q: "100%' OR 1=1 --" });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
    const ok = await request(ctx.app).get('/api/products').query({ q: '100%' });
    assert.equal(ok.body.items[0].name, 'Porte-clés 100% recyclé');
  });

  test('suppression du compte : données personnelles anonymisées, commandes conservées', async () => {
    const u = await createUser(ctx);
    await u.post('/api/me/addresses').send({ name: 'A B', line1: 'Rue 1', postal_code: '1000', city: 'Bruxelles' });
    assert.equal((await u.delete('/api/me').send({ password: 'mauvais' })).status, 401);
    assert.equal((await u.delete('/api/me').send({ password: u.password })).status, 200);
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(u.user.id);
    assert.ok(row.deleted_at); assert.match(row.email, /@invalid$/);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM addresses WHERE user_id = ?').get(u.user.id).n, 0);
  });
});
