'use strict';
// Configuration lue dans les variables d'environnement (fichier functions/.env généré au déploiement).
function bool(v, d) { if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(v); }

function loadConfig(overrides = {}) {
  const env = process.env;
  // RENDER_EXTERNAL_URL est fourni automatiquement par Render (adresse publique du service).
  const appUrl = (overrides.appUrl || env.APP_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:5000').replace(/\/$/, '');
  const cfg = {
    appUrl,
    extraOrigins: (env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || 'HADRISHOP <no-reply@localhost>',
    adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || '',
    adminEmail: String(env.ADMIN_EMAIL || '').trim().toLowerCase(),
    geocoder: env.GEOCODER || 'none',
    geocoderContact: env.GEOCODER_CONTACT || '',
    cookieSecure: bool(env.COOKIE_SECURE, appUrl.startsWith('https://')),
    reservationMinutes: 15,
    ...overrides,
  };
  cfg.scrypt = { N: Number(env.SCRYPT_N || 32768), r: 8, p: Number(env.SCRYPT_P || 3), ...(overrides.scrypt || {}) };
  return cfg;
}

module.exports = { loadConfig };
