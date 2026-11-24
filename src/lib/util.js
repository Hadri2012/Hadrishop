'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; this.expose = true; }
}
const bad = (msg, code) => new HttpError(400, msg, code);
const notFound = (msg = 'Introuvable') => new HttpError(404, msg, 'not_found');
const forbidden = (msg = 'Accès refusé') => new HttpError(403, msg, 'forbidden');
const conflict = (msg, code) => new HttpError(409, msg, code || 'conflict');

const now = () => Math.floor(Date.now() / 1000);
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'produit';
}

function euros(cents) {
  return new Intl.NumberFormat('fr-BE', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
}

// Hachage des mots de passe : scrypt (recommandé par l'OWASP si Argon2id indisponible).
async function hashPassword(password, { N, r, p }) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const n = Number(N), rr = Number(r), pp = Number(p);
  if (n > 1 << 20 || rr > 32 || pp > 16) return false; // borne contre des paramètres hostiles
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
    { N: n, r: rr, p: pp, maxmem: 256 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}
// Hachage factice pour égaliser les temps de réponse quand l'e-mail n'existe pas.
let dummyHash = null;
async function dummyVerify(password, params) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing', params);
  await verifyPassword(password, dummyHash);
  return false;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { HttpError, bad, notFound, forbidden, conflict, now, randomToken, sha256, slugify, euros,
  hashPassword, verifyPassword, dummyVerify, escapeHtml };
