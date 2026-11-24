'use strict';
// Catalogue de DÉMONSTRATION (produits, prix et stocks d'exemple, illustrations générées) :
// à remplacer par vos vrais produits et photos depuis /admin.
// Utilisé par les tests navigateur et l'aperçu local ; en production, créez vos produits dans /admin.
// Passe uniquement par l'API d'administration (mêmes validations que /admin).
const sharp = require('sharp');

const plate = '<path d="M90 690 L710 690 L760 730 L40 730 Z" fill="#c9a45c"/><rect x="40" y="730" width="720" height="16" fill="#8f6d2e"/><ellipse cx="400" cy="760" rx="330" ry="22" fill="#000" opacity=".08"/>';
const bg = (a, b) => `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="800" height="800" fill="url(#bg)"/>`;
const layers = (n, top, h, widthFn, color, cx = 400) => Array.from({ length: n }, (_, i) => {
  const w = widthFn(i), y = top + i * h;
  return `<rect x="${cx - w / 2}" y="${y}" width="${w}" height="${h - 1.5}" rx="${h / 2}" fill="${color}" opacity="${0.86 + (i % 3) * 0.05}"/><rect x="${cx - w / 2 + 10}" y="${y + 2}" width="${w * 0.18}" height="3" rx="1.5" fill="#fff" opacity=".45"/>`;
}).join('');

const ART = {
  vase: (c) => `${bg('#eef1fb', '#dfe5fa')}${plate}${layers(44, 230, 10.5, (i) => 200 + Math.sin(i / 6) * 60 + i * 1.6, c)}`,
  pot: (c) => `${bg('#fdf1ea', '#f8e1d4')}${plate}<path d="M340 250 C330 170 300 150 270 140 C320 150 350 180 360 240 Z M440 250 C450 160 500 130 540 125 C490 150 465 190 455 245 Z M400 245 C395 150 400 110 410 90 C420 140 418 200 412 245 Z" fill="#2f8f4e"/>${layers(40, 260, 10.7, (i) => 330 - i * 2.4 + (i % 8 < 4 ? 8 : 0), c)}`,
  casque: (c) => `${bg('#f1f2f5', '#e3e5ea')}${plate}<path d="M260 680 L540 680 L520 650 L280 650 Z" fill="${c}"/><rect x="385" y="300" width="30" height="352" fill="${c}"/><path d="M280 300 Q400 170 520 300 L500 312 Q400 205 300 312 Z" fill="${c}"/>${Array.from({ length: 30 }, (_, i) => `<line x1="385" x2="415" y1="${310 + i * 11.5}" y2="${310 + i * 11.5}" stroke="#fff" opacity=".18"/>`).join('')}`,
  hexa: (c) => `${bg('#eef4fb', '#dde8f6')}${plate}${[[400, 470], [300, 530], [500, 530], [300, 410], [500, 410], [400, 590], [400, 350]].map(([x, y], k) => `<polygon points="${[0, 1, 2, 3, 4, 5].map((j) => `${x + 62 * Math.cos(Math.PI / 3 * j)},${y + 62 * Math.sin(Math.PI / 3 * j)}`).join(' ')}" fill="${k % 2 ? c : '#ffffff'}" stroke="#14161a" stroke-width="6"/>`).join('')}`,
  keychain: (c) => `${bg('#fff4ee', '#fde4d6')}${plate}<circle cx="400" cy="250" r="46" fill="none" stroke="#9aa0ad" stroke-width="14"/><rect x="270" y="300" width="260" height="330" rx="60" fill="${c}"/><circle cx="400" cy="345" r="18" fill="#fde4d6"/><rect x="320" y="420" width="160" height="22" rx="11" fill="#fff" opacity=".9"/><rect x="340" y="465" width="120" height="22" rx="11" fill="#fff" opacity=".7"/><rect x="355" y="510" width="90" height="22" rx="11" fill="#fff" opacity=".5"/>`,
  dragon: (c) => `${bg('#fff1ea', '#fbdccb')}${plate}${Array.from({ length: 14 }, (_, i) => { const a = -0.3 + i * 0.36; const x = 400 + Math.cos(a) * (220 - i * 8); const y = 470 + Math.sin(a) * (150 - i * 5); return `<ellipse cx="${x}" cy="${y}" rx="${46 - i * 2.2}" ry="${30 - i * 1.3}" fill="${c}" stroke="#14161a" stroke-width="5" transform="rotate(${a * 57} ${x} ${y})"/>`; }).join('')}<circle cx="610" cy="430" r="58" fill="${c}" stroke="#14161a" stroke-width="6"/><circle cx="628" cy="415" r="9" fill="#14161a"/><path d="M590 380 L575 330 L610 372 Z M630 375 L650 325 L652 380 Z" fill="${c}" stroke="#14161a" stroke-width="5"/>`,
  clips: (c) => `${bg('#f1f2f5', '#e1e4ea')}${plate}${[[260, 520], [400, 470], [540, 520], [330, 610], [470, 610]].map(([x, y]) => `<path d="M${x - 50} ${y} a50 50 0 1 1 100 0" fill="none" stroke="${c}" stroke-width="30" stroke-linecap="round"/><rect x="${x - 62}" y="${y}" width="124" height="34" rx="8" fill="${c}"/>`).join('')}`,
  stl: (c) => `<rect width="800" height="800" fill="#10131d"/>${Array.from({ length: 11 }, (_, i) => `<line x1="${80 + i * 64}" y1="80" x2="${80 + i * 64}" y2="720" stroke="#1e2433"/><line x1="80" y1="${80 + i * 64}" x2="720" y2="${80 + i * 64}" stroke="#1e2433"/>`).join('')}
    ${(() => { const pts = Array.from({ length: 26 }, (_, i) => { const a = i * 0.55; return [400 + Math.cos(a) * (60 + i * 9), 420 + Math.sin(a) * (40 + i * 6)]; }); return pts.slice(2).map((p, i) => `<polygon points="${pts[i].join(',')} ${pts[i + 1].join(',')} ${p.join(',')}" fill="${c}" fill-opacity=".14" stroke="${c}" stroke-width="2"/>`).join(''); })()}
    <text x="80" y="760" font-family="Arial" font-size="34" font-weight="bold" fill="${c}">.STL</text>`,
};

const CATEGORIES = [['decoration', 'Décoration'], ['bureau', 'Bureau & rangement'], ['figurines', 'Figurines & jeux'], ['pieces', 'Pièces techniques'], ['fichiers-stl', 'Fichiers STL']];
const PRODUCTS = [
  { name: 'Vase spirale', cat: 'decoration', art: 'vase', color: '#2340e6', material: 'PLA', featured: 1,
    desc: 'Vase décoratif imprimé en mode spirale, une seule paroi continue.\nUsage décoratif : pour des fleurs fraîches, placez un récipient étanche à l’intérieur.',
    variants: [['VASE-S', 'Petit (12 cm)', 1490, 8], ['VASE-M', 'Moyen (18 cm)', 1990, 5], ['VASE-L', 'Grand (24 cm)', 2790, 2]] },
  { name: 'Cache-pot géométrique', cat: 'decoration', art: 'pot', color: '#e2480f', material: 'PETG', featured: 1,
    desc: 'Cache-pot à facettes pour plantes d’intérieur, avec fond plein.\nDiamètre intérieur adapté aux pots standard indiqués dans la variante.',
    variants: [['POT-9', 'Pour pot de 9 cm', 1290, 10], ['POT-12', 'Pour pot de 12 cm', 1690, 6]] },
  { name: 'Support de casque audio', cat: 'bureau', art: 'casque', color: '#3a3f4b', material: 'PETG', featured: 1,
    desc: 'Support de bureau pour casque audio, base large et stable.',
    variants: [['CASQ-N', 'Noir', 2490, 4], ['CASQ-B', 'Blanc', 2490, 0]] },
  { name: 'Organiseur hexagonal', cat: 'bureau', art: 'hexa', color: '#2340e6', material: 'PLA',
    desc: 'Organiseur modulaire en alvéoles hexagonales pour stylos, pinceaux et petits outils.',
    variants: [['HEX-7', '7 alvéoles', 1890, 7]] },
  { name: 'Porte-clés personnalisé', cat: 'decoration', art: 'keychain', color: '#e2480f', material: 'PLA',
    desc: 'Porte-clés avec texte en relief (jusqu’à 12 caractères), anneau métallique inclus.\nIndiquez le texte souhaité dans la note de commande.',
    variants: [['KEY-1', 'À l’unité', 690, 30], ['KEY-5', 'Lot de 5', 2790, 10]] },
  { name: 'Dragon articulé', cat: 'figurines', art: 'dragon', color: '#ff7a45', material: 'PLA', featured: 1,
    desc: 'Dragon imprimé d’une seule pièce avec articulations mobiles intégrées. Ne convient pas aux enfants de moins de 3 ans (petites pièces).',
    variants: [['DRG-M', 'Moyen (30 cm)', 2290, 3], ['DRG-L', 'Grand (45 cm)', 3490, 1]] },
  { name: 'Clips de câbles', cat: 'pieces', art: 'clips', color: '#14161a', material: 'TPU',
    desc: 'Clips souples pour ranger les câbles le long d’un bureau, à fixer avec un adhésif double face (non fourni).',
    variants: [['CLIP-10', 'Lot de 10', 790, 25]] },
  { name: 'Fichier STL : dragon articulé', cat: 'fichiers-stl', art: 'stl', color: '#6b82ff', type: 'digital',
    desc: 'Fichier numérique du dragon articulé, à imprimer chez vous. Licence d’usage personnel, revente interdite.',
    variants: [['STL-DRG', 'Licence personnelle', 590, null]] },
  { name: 'Fichier STL : organiseur modulaire', cat: 'fichiers-stl', art: 'stl', color: '#ff7a45', type: 'digital', premium: 1,
    desc: 'Fichier numérique de l’organiseur hexagonal modulaire. Réservé aux membres Premium. Licence d’usage personnel.',
    variants: [['STL-HEX', 'Licence personnelle', 390, null]] },
];

function binaryStlPlaceholder() {
  // Petit STL binaire valide (un tétraèdre) servant de fichier de démonstration
  const tri = [[[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 0, 0], [0, 10, 0], [0, 0, 10]], [[0, 0, 0], [0, 0, 10], [10, 0, 0]], [[10, 0, 0], [0, 0, 10], [0, 10, 0]]];
  const b = Buffer.alloc(84 + 50 * tri.length); b.write('HADRISHOP demo tetrahedron', 0); b.writeUInt32LE(tri.length, 80);
  tri.forEach((t, i) => { let o = 84 + i * 50 + 12; for (const v of t) for (const c of v) { b.writeFloatLE(c, o); o += 4; } });
  return b;
}

async function seedDemo(admin, { setOrigin = true } = {}) {
  const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what} : ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  if ((ok(await admin.get('/api/admin/products'), 'liste')).length > 0) return { skipped: true };
  const catIds = {};
  for (const [slug, name] of CATEGORIES) catIds[slug] = ok(await admin.post('/api/admin/categories').send({ name, slug }), 'catégorie').id;
  for (const p of PRODUCTS) {
    const prod = ok(await admin.post('/api/admin/products').send({ name: p.name, description: p.desc, category_id: catIds[p.cat], type: p.type || 'physical', material: p.material || null,
      active: true, featured: !!p.featured, premium_only: !!p.premium, variants: p.variants.map(([sku, name, price_cents, stock]) => ({ sku, name, price_cents, stock })) }), 'produit');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">${ART[p.art](p.color)}</svg>`;
    const webp = await sharp(Buffer.from(svg)).resize(640, 640).webp({ quality: 78 }).toBuffer();
    ok(await admin.post(`/api/admin/products/${prod.id}/images`).attach('images', webp, { filename: `${prod.slug}.webp`, contentType: 'image/webp' }), 'image');
    if (p.type === 'digital') ok(await admin.post(`/api/admin/products/${prod.id}/files`).attach('files', binaryStlPlaceholder(), `${prod.slug}-DEMO.stl`), 'fichier STL');
  }
  ok(await admin.post('/api/admin/shipping/zones').send({ name: 'Retrait à l’atelier', kind: 'pickup', description: 'Sur rendez-vous, gratuit', price_cents: 0, sort: 0 }), 'zone');
  ok(await admin.post('/api/admin/shipping/zones').send({ name: 'Livraison locale', kind: 'radius', description: 'Livrée en main propre dans un rayon de 30 km autour de l’atelier', radius_km: 30, price_cents: 490, free_above_cents: 5000, sort: 1 }), 'zone');
  ok(await admin.post('/api/admin/shipping/zones').send({ name: 'Exemple : liste de codes postaux', kind: 'postal', description: 'Zone d’exemple désactivée', postal_codes: '1000-1210', price_cents: 590, active: false, sort: 2 }), 'zone');
  if (setOrigin) ok(await admin.put('/api/admin/shipping/origin').send({ lat: 50.8467, lng: 4.3525 }), 'origine'); // EXEMPLE (Bruxelles)
  ok(await admin.post('/api/admin/promos').send({ code: 'BIENVENUE10', type: 'percent', value: 10, per_user_limit: 1 }), 'promo');
  return { products: PRODUCTS.length };
}

module.exports = { seedDemo };
