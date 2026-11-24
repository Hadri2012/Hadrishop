'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup, client, createUser, createProduct, D } = require('./helpers');

describe('Comptes, sessions et sécurité (Firestore)', () => {
  let ctx, admin;
  before(async () => { ctx = setup(); admin = await createUser(ctx, { role: 'admin' }); });
  const userByEmail = async (email) => { const e = (await ctx.db.collection('user_emails').doc(email).get()).data(); return { id: e.uid, ...(await ctx.db.collection('users').doc(e.uid).get()).data() }; };

  test('inscription : cookie __session HttpOnly, vérification e-mail à usage unique, mot de passe haché', async () => {
    const c = client(ctx);
    const r = await c.post('/api/auth/register').send({ email: 'Nouveau@Test.be', password: 'un-mot-de-passe-long', name: 'Nouveau', accept_terms: true });
    assert.equal(r.status, 201);
    const cookie = r.headers['set-cookie'][0];
    assert.match(cookie, /^__session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    const u = await userByEmail('nouveau@test.be');
    assert.match(u.password_hash, /^scrypt\$/);
    const token = (await D.emails(ctx, 'nouveau@test.be', 'verify'))[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    assert.match((await request(ctx.app).get('/api/auth/verify?token=' + token)).headers.location, /verification=ok/);
    assert.ok((await userByEmail('nouveau@test.be')).email_verified_at);
    assert.match((await request(ctx.app).get('/api/auth/verify?token=' + token)).headers.location, /invalide/);
    assert.equal((await client(ctx).post('/api/auth/register').send({ email: 'nouveau@test.be', password: 'un-mot-de-passe-long', name: 'X', accept_terms: true })).status, 409);
    assert.equal((await client(ctx).post('/api/auth/register').send({ email: 'w@test.be', password: 'court', name: 'X', accept_terms: true })).status, 400);
  });

  test('inscriptions simultanées avec le même e-mail : un seul compte', async () => {
    const res = await Promise.all(Array.from({ length: 4 }, () => client(ctx).post('/api/auth/register').send({ email: 'course@test.be', password: 'un-mot-de-passe-long', name: 'X', accept_terms: true })));
    assert.equal(res.filter((r) => r.status === 201).length, 1);
    assert.equal((await D.all(ctx, 'users')).filter((u) => u.email === 'course@test.be').length, 1);
  });

  test('premier administrateur via ADMIN_EMAIL : seulement après vérification de l’e-mail', async () => {
    const c2 = setup({ config: { adminEmail: 'patron@test.be' } });
    const c = client(c2);
    await c.post('/api/auth/register').send({ email: 'Patron@test.be', password: 'un-mot-de-passe-long', name: 'Patron', accept_terms: true });
    assert.equal((await c.get('/api/admin/stats')).status, 403);
    const token = (await D.emails(c2, 'patron@test.be', 'verify'))[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    await request(c2.app).get('/api/auth/verify?token=' + token);
    assert.equal((await c.get('/api/admin/stats')).status, 200);
    const other = client(c2);
    await other.post('/api/auth/register').send({ email: 'autre@test.be', password: 'un-mot-de-passe-long', name: 'Autre', accept_terms: true });
    const t2 = (await D.emails(c2, 'autre@test.be', 'verify'))[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    await request(c2.app).get('/api/auth/verify?token=' + t2);
    assert.equal((await other.get('/api/admin/stats')).status, 403);
  });

  test('connexion : message identique si e-mail inconnu, déconnexion côté serveur', async () => {
    const u = await createUser(ctx, { email: 'login@test.be' });
    const a = await client(ctx).post('/api/auth/login').send({ email: 'login@test.be', password: 'faux-mot-de-passe' });
    const b = await client(ctx).post('/api/auth/login').send({ email: 'inconnu@test.be', password: 'faux-mot-de-passe' });
    assert.equal(a.status, 401); assert.equal(a.body.error, b.body.error);
    await u.post('/api/auth/logout');
    assert.equal((await u.get('/api/me')).status, 401);
  });

  test('limitation des tentatives de connexion', async () => {
    const limited = setup({ rateLimits: { login: 3 } });
    const c = client(limited);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login').send({ email: 'x@test.be', password: 'nimporte' })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  });

  test('réinitialisation : jeton unique, sessions révoquées, pas d’énumération', async () => {
    const u = await createUser(ctx, { email: 'reset@test.be' });
    const x = await client(ctx).post('/api/auth/password/forgot').send({ email: 'personne@test.be' });
    const y = await client(ctx).post('/api/auth/password/forgot').send({ email: 'reset@test.be' });
    assert.deepEqual(x.body, y.body);
    const token = (await D.emails(ctx, 'reset@test.be', 'reset'))[0].text.match(/reinitialisation=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await client(ctx).post('/api/auth/password/reset').send({ token, password: 'nouveau-mot-de-passe' })).status, 200);
    assert.equal((await u.get('/api/me')).status, 401);
    assert.equal((await client(ctx).post('/api/auth/password/reset').send({ token, password: 'encore-un-autre-mdp' })).status, 400);
    assert.equal((await client(ctx).post('/api/auth/login').send({ email: 'reset@test.be', password: 'nouveau-mot-de-passe' })).status, 200);
  });

  test('CSRF : en-tête manquant ou origine étrangère refusés', async () => {
    const u = await createUser(ctx);
    const body = { name: 'A', line1: 'B', postal_code: '1000', city: 'C' };
    assert.equal((await u.agent.post('/api/me/addresses').send(body)).status, 403);
    assert.equal((await u.agent.post('/api/me/addresses').set('X-Hadrishop', '1').set('Origin', 'https://evil.example').send(body)).status, 403);
  });

  test('toutes les routes /api/admin refusées aux clients et visiteurs', async () => {
    const cust = await createUser(ctx), anon = client(ctx);
    const routes = [['get', '/api/admin/stats'], ['get', '/api/admin/orders'], ['get', '/api/admin/products'], ['post', '/api/admin/products'], ['get', '/api/admin/customers'],
      ['patch', '/api/admin/customers/x'], ['get', '/api/admin/settings'], ['put', '/api/admin/settings'], ['post', '/api/admin/promos'], ['post', '/api/admin/shipping/zones'],
      ['get', '/api/admin/newsletter'], ['post', '/api/admin/newsletter/campaigns/x/send'], ['post', '/api/admin/orders/x/refunds'], ['get', '/api/admin/emails'], ['get', '/api/admin/audit'], ['get', '/api/admin/custom-requests']];
    for (const [m, url] of routes) {
      assert.equal((await cust[m](url).send({})).status, 403, `${m} ${url}`);
      assert.equal((await anon[m](url).send({})).status, 401, `${m} ${url}`);
    }
  });

  test('admin : pas d’auto-rétrogradation ; compte désactivé déconnecté', async () => {
    assert.equal((await admin.patch(`/api/admin/customers/${admin.user.id}`).send({ role: 'customer' })).status, 403);
    const u = await createUser(ctx);
    assert.equal((await admin.patch(`/api/admin/customers/${u.user.id}`).send({ disabled: true })).status, 200);
    assert.equal((await u.get('/api/me')).status, 401);
    assert.equal((await client(ctx).post('/api/auth/login').send({ email: u.user.email, password: u.password })).status, 403);
  });

  test('CSP stricte et en-têtes de sécurité', async () => {
    const r = await request(ctx.app).get('/');
    assert.match(r.headers['content-security-policy'], /script-src 'self' 'sha256-/);
    assert.doesNotMatch(r.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal((await request(ctx.app).get('/admin')).status, 200);
  });

  test('téléversement : SVG déguisé en PNG refusé, vraie image servie avec nosniff', async () => {
    const p = await createProduct(admin, { name: 'Upload' });
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal((await admin.post(`/api/admin/products/${p.id}/images`).attach('images', evil, { filename: 'image.png', contentType: 'image/png' })).status, 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const ok = await admin.post(`/api/admin/products/${p.id}/images`).attach('images', png, { filename: 'vrai.png', contentType: 'image/png' });
    assert.equal(ok.status, 201);
    const img = await request(ctx.app).get(ok.body[0].url);
    assert.equal(img.status, 200); assert.equal(img.headers['x-content-type-options'], 'nosniff'); assert.equal(img.headers['content-type'], 'image/png');
    assert.equal((await request(ctx.app).get('/uploads/images/..%2F..%2Fsecret.png')).status, 404);
  });

  test('erreurs internes masquées, JSON invalide géré, recherche « SQL » inoffensive', async () => {
    assert.equal((await request(ctx.app).post('/api/auth/login').set('X-Hadrishop', '1').set('Content-Type', 'application/json').send('{pas du json')).status, 400);
    assert.equal((await request(ctx.app).get('/api/inexistant')).status, 404);
    await createProduct(admin, { name: 'Porte-clés 100% recyclé' });
    assert.equal((await request(ctx.app).get('/api/products').query({ q: "100%' OR 1=1 --" })).body.total, 0);
    assert.equal((await request(ctx.app).get('/api/products').query({ q: '100%' })).body.items[0].name, 'Porte-clés 100% recyclé');
  });

  test('suppression du compte : données personnelles effacées', async () => {
    const u = await createUser(ctx);
    await u.post('/api/me/addresses').send({ name: 'A B', line1: 'Rue 1', postal_code: '1000', city: 'Bruxelles' });
    assert.equal((await u.delete('/api/me').send({ password: 'mauvais' })).status, 401);
    assert.equal((await u.delete('/api/me').send({ password: u.password })).status, 200);
    const row = (await ctx.db.collection('users').doc(u.user.id).get()).data();
    assert.ok(row.deleted_at); assert.match(row.email, /@invalid$/);
    assert.equal((await D.all(ctx, 'addresses')).filter((a) => a.uid === u.user.id).length, 0);
    assert.equal((await client(ctx).post('/api/auth/login').send({ email: u.user.email, password: u.password })).status, 401);
  });
});
