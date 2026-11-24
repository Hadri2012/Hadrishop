'use strict';
// Paramètres de la boutique (document Firestore settings/shop), modifiables depuis /admin.
const DEFAULTS = {
  shop_name: 'HADRISHOP',
  shop_tagline: 'Impressions 3D sur mesure, imprimées en Belgique',
  contact_email: '',
  shop_address: '',
  origin_lat: null,
  origin_lng: null,
  require_email_verification: true,
  download_max_count: 10,
  premium_enabled: true,
  premium_price_cents: 499,
  premium_interval: 'month',
  premium_discount_percent: 10,
  premium_free_shipping: true,
  low_stock_threshold: 3,
  max_print_dimensions_mm: '225 x 225 x 265',
  materials: ['PLA', 'PETG', 'TPU'],
  colors: ['Noir', 'Blanc', 'Gris', 'Rouge', 'Bleu', 'Vert', 'Orange'],
  terms_text: 'Conditions générales de vente : à compléter par le vendeur avant la mise en ligne.',
};
const ALLOWED = new Set(Object.keys(DEFAULTS));

function makeSettings(db) {
  const ref = db.collection('settings').doc('shop');
  let cache = null, cachedAt = 0;
  async function get() {
    if (cache && Date.now() - cachedAt < 10000) return cache;
    const s = await ref.get();
    const stored = s.exists ? s.data() : {};
    cache = { ...DEFAULTS };
    for (const [k, v] of Object.entries(stored)) if (ALLOWED.has(k)) cache[k] = v;
    cachedAt = Date.now();
    return cache;
  }
  async function set(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) if (ALLOWED.has(k)) clean[k] = v;
    await ref.set(clean, { merge: true });
    cache = null;
    return get();
  }
  return { get, set, invalidate: () => { cache = null; } };
}

module.exports = { makeSettings, DEFAULTS };
