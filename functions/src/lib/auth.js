'use strict';
// Sessions stockées hachées dans Firestore. Le cookie s'appelle « __session » : c'est le seul cookie
// que Firebase Hosting transmet aux Cloud Functions.
const { now, randomToken, sha256, HttpError } = require('./util');

const COOKIE = '__session';
const SESSION_DAYS = 30;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeAuth(db, cfg) {
  const sessions = db.collection('sessions');
  const users = db.collection('users');

  async function loadSession(req, res, next) {
    req.user = null;
    try {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid && sid.length <= 100) {
        const hash = sha256(sid);
        const s = await sessions.doc(hash).get();
        if (s.exists && s.data().expiresAt > now()) {
          const u = await users.doc(s.data().uid).get();
          if (u.exists && !u.data().disabled && !u.data().deletedAt) { req.user = { id: u.id, ...u.data() }; req.sessionHash = hash; }
        }
      }
      next();
    } catch (e) { next(e); }
  }

  async function createSession(req, res, uid) {
    const token = randomToken(32);
    const t = now();
    await sessions.doc(sha256(token)).set({ uid, createdAt: t, expiresAt: t + SESSION_DAYS * 86400, ip: req.ip || null });
    res.cookie(COOKIE, token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 * 1000 });
  }
  async function destroySession(req, res) {
    if (req.sessionHash) await sessions.doc(req.sessionHash).delete();
    res.clearCookie(COOKIE, { path: '/' });
  }
  async function destroyAllSessions(uid, exceptHash) {
    const all = (await sessions.where('uid', '==', uid).get()).docs;
    await Promise.all(all.filter((d) => d.id !== exceptHash).map((d) => d.ref.delete()));
  }

  const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Connexion requise', 'auth_required')));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Connexion requise', 'auth_required'));
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Réservé aux administrateurs', 'forbidden'));
    next();
  };

  // CSRF : en-tête personnalisé obligatoire + origine contrôlée + SameSite=Lax
  const origins = new Set([cfg.appUrl, ...cfg.extraOrigins].map((u) => new URL(u).origin));
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-hadrishop'] !== '1') return next(new HttpError(403, 'Requête refusée (CSRF)', 'csrf'));
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return next(new HttpError(403, 'Origine refusée', 'csrf'));
    next();
  }

  return { loadSession, createSession, destroySession, destroyAllSessions, requireUser, requireAdmin, csrf, COOKIE };
}

module.exports = { makeAuth, parseCookies };
