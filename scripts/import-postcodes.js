'use strict';
// Importe des coordonnées de codes postaux belges pour le calcul du rayon de livraison.
// Source conseillée : GeoNames, fichier BE.txt de l'archive https://download.geonames.org/export/zip/BE.zip (licence CC BY 4.0).
// Usage : npm run import-postcodes -- chemin/vers/BE.txt
const fs = require('fs');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');
const { makeGeo } = require('../src/lib/geo');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage : npm run import-postcodes -- BE.txt'); process.exit(1); }
const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const n = makeGeo(db, cfg).importText(fs.readFileSync(file, 'utf8'), 'geonames');
console.log(`${n} codes postaux importés.`);
db.close();
