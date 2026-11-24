'use strict';
// Outils de test : faux Firestore/Storage en mémoire, faux client Stripe (aucun appel réseau, aucun paiement)
// et webhooks signés avec la VRAIE bibliothèque Stripe.
const crypto = require('crypto');
const request = require('supertest');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const { createApp } = require('../src/app');
const { hashPassword, now, list } = require('../src/lib/util');
const { makeFakeFirestore, makeFakeStorage } = require('./fake-firestore');

const WEBHOOK_SECRET = 'whsec_test_secret_hadrishop';
const realStripe = new Stripe('sk_test_dummy');

function makeFakeStripe() {
  const calls = [];
  const state = { sessions: new Map(), refunds: [], subs: new Map(), fail: {}, seq: 0 };
  const id = (p) => `${p}_${++state.seq}_${crypto.randomBytes(3).toString('hex')}`;
  const maybeFail = (name) => { if (state.fail[name]) throw new Error(state.fail[name]); };
  const idem = new Map();
  const withIdem = (name, opts, fn) => { const key = opts && opts.idempotencyKey; if (key && idem.has(name + key)) return idem.get(name + key); const r = fn(); if (key) idem.set(name + key, r); return r; };
  return {
    calls, state,
    customers: { create: async (p, o) => { calls.push(['customers.create', p, o]); maybeFail('customers'); return withIdem('cus', o, () => ({ id: id('cus'), ...p })); } },
    coupons: { create: async (p, o) => { calls.push(['coupons.create', p, o]); maybeFail('coupons'); return withIdem('cpn', o, () => ({ id: id('cpn'), ...p })); } },
    checkout: { sessions: {
      create: async (p, o) => { calls.push(['checkout.sessions.create', p, o]); maybeFail('checkout'); return withIdem('cs', o, () => { const s = { id: id('cs_test'), url: `https://checkout.stripe.test/${state.seq}`, status: 'open', ...p }; state.sessions.set(s.id, s); return s; }); },
      expire: async (sid) => { calls.push(['checkout.sessions.expire', sid]); const s = state.sessions.get(sid); if (!s || s.status !== 'open') throw new Error('Session not open'); s.status = 'expired'; return s; },
      retrieve: async (sid) => { calls.push(['checkout.sessions.retrieve', sid]); const s = state.sessions.get(sid); if (!s) throw new Error('No such session'); return s; },
    } },
    refunds: {
      create: async (p, o) => { calls.push(['refunds.create', p, o]); maybeFail('refunds'); return withIdem('re', o, () => { const r = { id: id('re'), object: 'refund', status: state.refundStatus || 'succeeded', ...p }; state.refunds.push(r); return r; }); },
      list: async (p) => { calls.push(['refunds.list', p]); return { data: state.refunds.filter((r) => r.payment_intent === p.payment_intent) }; },
    },
    subscriptions: {
      retrieve: async (sid) => { const s = state.subs.get(sid); if (!s) throw new Error('No such subscription'); return JSON.parse(JSON.stringify(s)); },
      update: async (sid, p) => { calls.push(['subscriptions.update', sid, p]); const s = state.subs.get(sid); Object.assign(s, p); return JSON.parse(JSON.stringify(s)); },
      cancel: async (sid) => { calls.push(['subscriptions.cancel', sid]); const s = state.subs.get(sid); s.status = 'canceled'; return JSON.parse(JSON.stringify(s)); },
    },
    webhooks: realStripe.webhooks,
  };
}

function setup(extra = {}) {
  const stripe = makeFakeStripe();
  const sent = [];
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const orig = transport.sendMail.bind(transport);
  transport.sendMail = async (m) => { sent.push(m); return orig(m); };
  const silent = { log() {}, warn() {}, error() {}, info() {} };
  const db = makeFakeFirestore();
  const ctx = createApp({ db, storage: makeFakeStorage(), stripe, log: extra.log || silent,
    config: { appUrl: 'http://localhost:3000', stripeWebhookSecret: WEBHOOK_SECRET, scrypt: { N: 1024, p: 1 }, mailTransport: transport,
      rateLimits: { login: 1000, register: 1000, mail: 1000, ...(extra.rateLimits || {}) }, ...(extra.config || {}) } });
  ctx.fakeStripe = stripe; ctx.sent = sent;
  return ctx;
}

function client(ctx) {
  const agent = request.agent(ctx.app);
  const wrap = (m) => (url) => agent[m](url).set('X-Hadrishop', '1');
  return { agent, get: (u) => agent.get(u), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
}

async function createUser(ctx, { email = `u${crypto.randomBytes(4).toString('hex')}@test.be`, password = 'motdepasse-solide', name = 'Client Test', role = 'customer', verified = true } = {}) {
  const uid = crypto.randomBytes(10).toString('hex');
  await ctx.db.collection('users').doc(uid).set({ email, password_hash: await hashPassword(password, ctx.cfg.scrypt), name, role, email_verified_at: verified ? now() : null, disabled: false, stripe_customer_id: null, premium: null, created_at: now(), deleted_at: null });
  await ctx.db.collection('user_emails').doc(email).set({ uid });
  const c = client(ctx);
  const r = await c.post('/api/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error('login failed ' + r.status + ' ' + JSON.stringify(r.body));
  c.user = { id: uid, email, name, role };
  c.password = password;
  return c;
}

async function createProduct(admin, { name = 'Vase', type = 'physical', variants, premium_only = false, category_id = null } = {}) {
  const r = await admin.post('/api/admin/products').send({ name, type, description: `Description ${name}`, category_id, premium_only,
    variants: variants || [{ sku: `SKU-${crypto.randomBytes(3).toString('hex')}`, name: 'Standard', price_cents: 1500, stock: type === 'digital' ? null : 10 }] });
  if (r.status !== 201) throw new Error('createProduct ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}

async function sendWebhook(ctx, type, object, { eventId, secret = WEBHOOK_SECRET } = {}) {
  const payload = JSON.stringify({ id: eventId || `evt_${crypto.randomBytes(8).toString('hex')}`, object: 'event', type, created: now(), data: { object } });
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return request(ctx.app).post('/api/stripe/webhook').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
}

const D = {
  async order(ctx, number) { const qs = await ctx.db.collection('orders').where('number', '==', number).get(); return qs.empty ? null : { id: qs.docs[0].id, ...qs.docs[0].data() }; },
  async orderById(ctx, id) { const s = await ctx.db.collection('orders').doc(id).get(); return { id, ...s.data() }; },
  async variant(ctx, id) { const s = await ctx.db.collection('variants').doc(id).get(); return { id, ...s.data() }; },
  async emails(ctx, to, kind) { return list(await ctx.db.collection('emails').get()).filter((m) => (!to || m.to === to) && (!kind || m.kind === kind)); },
  async all(ctx, coll) { return list(await ctx.db.collection(coll).get()); },
  async reservedQty(ctx, variantId) { const v = await D.variant(ctx, variantId); const t = now(); return Object.values(v.reserved || {}).filter((r) => r.exp > t).reduce((a, r) => a + r.qty, 0); },
};

async function completedSession(ctx, number, overrides = {}) {
  const o = await D.order(ctx, number);
  return { id: o.stripe_session_id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete', amount_total: o.total_cents,
    client_reference_id: o.id, metadata: { order_id: o.id, order_number: o.number }, payment_intent: `pi_test_${o.id}`, ...overrides };
}

const key = () => crypto.randomBytes(12).toString('hex');
async function addZone(admin, z) { const r = await admin.post('/api/admin/shipping/zones').send(z); if (r.status !== 201) throw new Error('zone ' + JSON.stringify(r.body)); return r.body; }
const ADDRESS = { name: 'Jean Client', line1: 'Rue de la Loi 16', postal_code: '1000', city: 'Bruxelles', country: 'BE' };

module.exports = { setup, client, createUser, createProduct, sendWebhook, completedSession, key, addZone, ADDRESS, WEBHOOK_SECRET, D };
