'use strict';
// Crée (ou promeut) un compte administrateur.
// Usage : npm run create-admin -- admin@exemple.be "Nom Prénom"
// Le mot de passe est demandé de façon interactive (jamais passé en argument → absent de l'historique shell).
const readline = require('readline');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { hashPassword, now } = require('../src/lib/util');

async function askHidden(q) {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = function (s) { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); }));
}

(async () => {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Usage : npm run create-admin -- email@exemple.be "Nom"'); process.exit(1); }
  const cfg = loadConfig();
  const db = openDb(cfg.dbFile);
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  const password = await askHidden('Mot de passe (12 caractères minimum) : ');
  if (password.length < 12) { console.error('Mot de passe trop court.'); process.exit(1); }
  const hash = await hashPassword(password, cfg.scrypt);
  if (existing) {
    db.prepare(`UPDATE users SET role = 'admin', password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), disabled = 0 WHERE id = ?`).run(hash, now(), existing.id);
    console.log(`Compte existant promu administrateur : ${email}`);
  } else {
    db.prepare(`INSERT INTO users(email, password_hash, name, role, email_verified_at, created_at) VALUES (?,?,?, 'admin', ?, ?)`).run(email.toLowerCase(), hash, nameParts.join(' ') || 'Administrateur', now(), now());
    console.log(`Administrateur créé : ${email} → connectez-vous sur ${cfg.appUrl}/admin`);
  }
  db.close();
})();
