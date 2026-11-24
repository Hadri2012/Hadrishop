'use strict';
// Géolocalisation des codes postaux belges (pour la livraison dans un rayon) :
// 1) table « postcodes » (import GeoNames ou saisie dans /admin) ; 2) optionnellement Nominatim (OSM)
// avec cache, 1 requête/seconde maximum et User-Agent identifiant, conformément à sa politique d'usage.
const { now } = require('./util');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Parse « 1000, 1020-1210, 1300 » -> fonction de test
function parsePostalList(spec) {
  const parts = String(spec || '').split(/[\s,;]+/).filter(Boolean);
  const singles = new Set(), ranges = [];
  for (const p of parts) {
    const m = p.match(/^(\d{4})-(\d{4})$/);
    if (m) ranges.push([Number(m[1]), Number(m[2])]);
    else if (/^\d{4}$/.test(p)) singles.add(p);
  }
  return (code) => singles.has(code) || ranges.some(([a, b]) => Number(code) >= a && Number(code) <= b);
}

function makeGeo(db, cfg) {
  let lastCall = 0;
  const fetchImpl = cfg.fetch || globalThis.fetch;

  async function nominatim(code) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(code)}&country=be&format=jsonv2&limit=1`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': `HADRISHOP/1.0 (${cfg.geocoderContact || cfg.appUrl})`, 'Accept-Language': 'fr' } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const arr = await res.json();
    if (!arr.length) return null;
    return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
  }

  async function coordsFor(code) {
    if (!/^\d{4}$/.test(code)) return null;
    const row = db.prepare('SELECT lat, lng FROM postcodes WHERE code = ?').get(code);
    if (row) return row.lat == null ? null : row;
    if (cfg.geocoder !== 'nominatim') return null;
    try {
      const c = await nominatim(code);
      db.prepare('INSERT OR REPLACE INTO postcodes(code, lat, lng, source, updated_at) VALUES (?,?,?,?,?)')
        .run(code, c ? c.lat : null, c ? c.lng : null, 'nominatim', now());
      return c;
    } catch { return null; }
  }

  // Import d'un fichier GeoNames (tabulations) ou CSV « code,lat,lng ». Moyenne par code postal.
  function importText(text, source = 'import') {
    const acc = new Map();
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let code, lat, lng;
      const tab = line.split('\t');
      if (tab.length >= 11) { code = tab[1]; lat = Number(tab[9]); lng = Number(tab[10]); }
      else { const c = line.split(/[;,]/); code = c[0]; lat = Number(c[1]); lng = Number(c[2]); }
      code = String(code || '').trim();
      if (!/^\d{4}$/.test(code) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const a = acc.get(code) || { lat: 0, lng: 0, n: 0 };
      a.lat += lat; a.lng += lng; a.n++; acc.set(code, a);
    }
    const stmt = db.prepare('INSERT OR REPLACE INTO postcodes(code, lat, lng, source, updated_at) VALUES (?,?,?,?,?)');
    db.atomic(() => { for (const [code, a] of acc) stmt.run(code, a.lat / a.n, a.lng / a.n, source, now()); });
    return acc.size;
  }

  return { coordsFor, importText, haversineKm, parsePostalList };
}

module.exports = { makeGeo, haversineKm, parsePostalList };
