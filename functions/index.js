'use strict';
// Point d'entrée Cloud Functions for Firebase (2e génération, région Belgique).
const { onRequest } = require('firebase-functions/https');
const { onSchedule } = require('firebase-functions/scheduler');
const { setGlobalOptions } = require('firebase-functions/options');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { createApp } = require('./src/app');

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });
initializeApp();
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

let ctx;
const context = () => (ctx ||= createApp({ db, bucket: getStorage().bucket() }));

// Toute la boutique (pages, API, webhook Stripe, images) : Firebase Hosting redirige tout vers cette fonction.
exports.api = onRequest({ memory: '512MiB', timeoutSeconds: 60, concurrency: 40 }, (req, res) => context().app(req, res));

// Toutes les minutes : expiration des réservations de 15 min, envoi des e-mails, nettoyage.
exports.jobs = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Europe/Brussels', memory: '256MiB' }, async () => { await context().runJobs(); });
