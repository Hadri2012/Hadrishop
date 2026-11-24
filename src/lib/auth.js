'use strict';
const { now, randomToken, sha256, HttpError } = require('./util');

const COOKIE = 'hs_sid';
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
  function cookieOpts(maxAgeMs) {
    return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
  }

  function loadSession(req, res, next) {
    req.user = null;
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid && sid.length <= 100) {
      const row = db.prepare(`SELECT u.*, s.id_hash AS session_hash FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND u.deleted_at IS NULL`).get(sha256(sid), now());
      if (row) { req.user = row; req.sessionHash = row.session_hash; }
    }
    next();
  }

  function createSession(req, res, userId) {
    const token = randomToken(32);
    const t = now();
    db.prepare('INSERT INTO sessions(id_hash, user_id, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), userId, t, t + SESSION_DAYS * 86400, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200));
    res.cookie(COOKIE, token, cookieOpts(SESSION_DAYS * 86400 * 1000));
  }

  function destroySession(req, res) {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.sessionHash);
    res.clearCookie(COOKIE, { path: '/' });
  }

  const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Connexion requise', 'auth_required')));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Connexion requise', 'auth_required'));
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Réservé aux administrateurs', 'forbidden'));
    next();
  };

  // Protection CSRF : en-tête personnalisé obligatoire (impossible à envoyer cross-site sans CORS,
  // que le serveur n'accorde pas) + contrôle de l'en-tête Origin + cookies SameSite=Lax.
  const appOrigin = new URL(cfg.appUrl).origin;
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-hadrishop'] !== '1') return next(new HttpError(403, 'Requête refusée (CSRF)', 'csrf'));
    const origin = req.headers.origin;
    if (origin && origin !== appOrigin) return next(new HttpError(403, 'Origine refusée', 'csrf'));
    next();
  }

  return { loadSession, createSession, destroySession, requireUser, requireAdmin, csrf, COOKIE };
}

module.exports = { makeAuth, parseCookies };
