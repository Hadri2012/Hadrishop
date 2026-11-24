'use strict';
const path = require('path');

function bool(v, d) { if (v === undefined || v === '') return d; return /^(1|true|yes|on)$/i.test(v); }

function loadConfig(overrides = {}) {
  const env = process.env;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(__dirname, '..', 'data');
  const cfg = {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'hadrishop.sqlite'),
    uploadsDir: path.join(dataDir, 'uploads'),
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    smtpUrl: env.SMTP_URL || '',
    mailFrom: env.MAIL_FROM || 'HADRISHOP <no-reply@localhost>',
    adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || '',
    trustProxy: env.TRUST_PROXY || '',
    geocoder: env.GEOCODER || 'none', // 'none' | 'nominatim'
    geocoderContact: env.GEOCODER_CONTACT || '',
    cookieSecure: bool(env.COOKIE_SECURE, (env.APP_URL || '').startsWith('https://')),
    scrypt: { N: Number(env.SCRYPT_N || 65536), r: 8, p: Number(env.SCRYPT_P || 2) },
    jobsIntervalMs: Number(env.JOBS_INTERVAL_MS || 30000),
    reservationMinutes: 15,
    ...overrides,
  };
  cfg.scrypt = { N: Number(env.SCRYPT_N || 65536), r: 8, p: Number(env.SCRYPT_P || 2), ...(overrides.scrypt || {}) };
  return cfg;
}

module.exports = { loadConfig };
