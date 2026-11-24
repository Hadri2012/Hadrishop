'use strict';
// Démarrage en serveur Node classique (Render, ou tout hébergeur Node) avec Firestore gratuit (Spark).
// Les fichiers (images, STL) sont stockés dans Firestore : aucun Cloud Storage, donc aucune carte bancaire.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createApp } = require('./src/app');
const { firestoreFiles } = require('./src/lib/firestore-files');

function credentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.error('FIREBASE_SERVICE_ACCOUNT manquant (contenu JSON de la clé du compte de service Firebase).'); process.exit(1); }
  let sa;
  try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { console.error('FIREBASE_SERVICE_ACCOUNT illisible : collez le contenu complet du fichier JSON.'); process.exit(1); }
  return sa;
}

const sa = credentials();
initializeApp({ credential: cert(sa), projectId: sa.project_id });
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

const ctx = createApp({ db, storage: firestoreFiles(db) });
const port = Number(process.env.PORT || 3000);
const server = ctx.app.listen(port, () => console.log(`HADRISHOP en ligne sur le port ${port} (${ctx.cfg.appUrl})`));

// Tâches de fond (réservations expirées, e-mails, nettoyage) : chaque minute tant que le serveur est éveillé.
let running = false;
async function jobs() {
  if (running) return; running = true;
  try { await ctx.runJobs(); } catch (e) { console.error('Tâches de fond :', e.message); } finally { running = false; }
}
setTimeout(jobs, 5000);
const timer = setInterval(jobs, 60 * 1000);

function stop() { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
