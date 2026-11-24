'use strict';
// Paramètres de la boutique modifiables depuis /admin (stockés en base).
const DEFAULTS = {
  shop_name: 'HADRISHOP',
  shop_tagline: 'Impressions 3D sur mesure, imprimées en Belgique',
  contact_email: '',
  shop_address: '',
  origin_lat: null,          // coordonnées de l'atelier (pour le rayon de livraison)
  origin_lng: null,
  require_email_verification: true,
  download_max_count: 10,
  premium_enabled: true,
  premium_price_cents: 499,
  premium_interval: 'month',  // 'month' | 'year'
  premium_discount_percent: 10,
  premium_free_shipping: true,
  low_stock_threshold: 3,
  max_print_dimensions_mm: '225 x 225 x 265',
  materials: ['PLA', 'PETG', 'TPU'],
  colors: ['Noir', 'Blanc', 'Gris', 'Rouge', 'Bleu', 'Vert', 'Orange'],
  terms_text: 'Conditions générales de vente : à compléter par le vendeur avant la mise en ligne.',
};

const ALLOWED = new Set(Object.keys(DEFAULTS));

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const r of rows) if (ALLOWED.has(r.key)) out[r.key] = JSON.parse(r.value);
  return out;
}

function setSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.atomic(() => { for (const [k, v] of Object.entries(patch)) if (ALLOWED.has(k)) stmt.run(k, JSON.stringify(v)); });
  return getSettings(db);
}

module.exports = { getSettings, setSettings, DEFAULTS };
