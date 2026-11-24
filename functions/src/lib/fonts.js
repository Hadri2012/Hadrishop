'use strict';
// Polices Archivo (licence SIL OFL 1.1, paquet @fontsource/archivo) intégrées en data: URI :
// aucune requête vers un service tiers (pas de Google Fonts → pas de transfert d'IP hors UE).
const fs = require('fs');
const path = require('path');

let cached = null;
function fontFaceCss() {
  if (cached) return cached;
  const dir = path.dirname(require.resolve('@fontsource/archivo/package.json'));
  cached = [400, 700, 800].map((w) => {
    const b64 = fs.readFileSync(path.join(dir, 'files', `archivo-latin-${w}-normal.woff2`)).toString('base64');
    return `@font-face{font-family:'Archivo';font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  }).join('\n');
  return cached;
}

module.exports = { fontFaceCss };
