'use strict';
// Géolocalisation des codes postaux belges (collection postcodes) : import GeoNames / saisie admin,
// et optionnellement Nominatim (OSM) avec cache, 1 requête/seconde max et User-Agent identifiant.
const { now } = require('./util');

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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
  const col = db.collection('postcodes');

  async function nominatim(code) {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(code)}&country=be&format=jsonv2&limit=1`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': `HADRISHOP/2.0 (${cfg.geocoderContact || cfg.appUrl})`, 'Accept-Language': 'fr' } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const arr = await res.json();
    return arr.length ? { lat: Number(arr[0].lat), lng: Number(arr[0].lon) } : null;
  }

  async function coordsFor(code) {
    if (!/^\d{4}$/.test(code)) return null;
    const s = await col.doc(code).get();
    if (s.exists) { const d = s.data(); return d.lat == null ? null : { lat: d.lat, lng: d.lng }; }
    if (cfg.geocoder !== 'nominatim') return null;
    try {
      const c = await nominatim(code);
      await col.doc(code).set({ lat: c ? c.lat : null, lng: c ? c.lng : null, source: 'nominatim', updatedAt: now() });
      return c;
    } catch { return null; }
  }

  async function importText(text, source = 'import') {
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
    await Promise.all([...acc].map(([code, a]) => col.doc(code).set({ lat: a.lat / a.n, lng: a.lng / a.n, source, updatedAt: now() })));
    return acc.size;
  }

  async function count() { return (await col.get()).docs.filter((d) => d.data().lat != null).length; }

  return { coordsFor, importText, count, haversineKm, parsePostalList };
}

module.exports = { makeGeo, haversineKm, parsePostalList };
