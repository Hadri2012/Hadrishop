'use strict';
const { createApp } = require('./app');

const ctx = createApp();
const { cfg } = ctx;
const problems = [];
if (!cfg.stripeSecretKey) problems.push('STRIPE_SECRET_KEY manquant : les paiements échoueront.');
if (!cfg.stripeWebhookSecret) problems.push('STRIPE_WEBHOOK_SECRET manquant : aucun paiement ne sera confirmé.');
if (!cfg.smtpUrl) problems.push('SMTP_URL manquant : les e-mails resteront en file d’attente.');
if (cfg.env === 'production' && !cfg.appUrl.startsWith('https://')) problems.push('APP_URL doit être en https:// en production.');
for (const p of problems) console.warn('[config] ' + p);

const server = ctx.app.listen(cfg.port, () => console.log(`HADRISHOP en écoute sur le port ${cfg.port} (${cfg.appUrl})`));
ctx.startJobs();
ctx.runJobs();

function shutdown() { ctx.stopJobs(); server.close(() => { ctx.db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
