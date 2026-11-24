'use strict';
// Téléversements : lecture multipart avec busboy (compatible Cloud Functions, qui fournit req.rawBody),
// validation du contenu réel (octets magiques) puis stockage dans Cloud Storage.
const Busboy = require('busboy');
const path = require('path');
const { randomToken, bad } = require('./util');

function imageType(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
function modelType(buf, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ext === '.stl') {
    if (buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length) return 'stl';
    const head = buf.slice(0, 512).toString('latin1').trimStart();
    return /^solid\b/i.test(head) && !buf.includes(0) ? 'stl' : null;
  }
  if (ext === '.3mf') return buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? '3mf' : null;
  if (ext === '.obj') return !buf.slice(0, 65536).includes(0) ? 'obj' : null;
  return null;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', stl: 'model/stl', '3mf': 'model/3mf', obj: 'text/plain' };

// Lit une requête multipart → { fields, files:[{ originalname, buffer, size }] }
function parseMultipart(req, { maxFileMb, maxFiles }) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxFileMb * 1024 * 1024, files: maxFiles, fields: 30, fieldSize: 20000 } }); }
    catch { return reject(bad('Formulaire invalide')); }
    const fields = {}, files = [];
    let failed = null;
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { failed = bad(`Fichier trop volumineux (${maxFileMb} Mo max.)`); });
      stream.on('end', () => { const buffer = Buffer.concat(chunks); files.push({ field: name, originalname: String(info.filename || 'fichier').slice(0, 200), buffer, size: buffer.length }); });
    });
    bb.on('filesLimit', () => { failed = bad(`${maxFiles} fichiers maximum`); });
    bb.on('error', () => reject(bad('Téléversement refusé')));
    bb.on('close', () => (failed ? reject(failed) : resolve({ fields, files })));
    if (req.rawBody) bb.end(req.rawBody); else req.pipe(bb);
  });
}

function makeUploads(storage) {
  async function saveImage(file) {
    const t = imageType(file.buffer);
    if (!t) throw bad(`« ${file.originalname} » n'est pas une image PNG, JPEG ou WebP valide`);
    const name = `${randomToken(12)}.${t}`;
    await storage.save(`images/${name}`, file.buffer, MIME[t]);
    return name;
  }
  async function saveModel(file, where) {
    const t = modelType(file.buffer, file.originalname);
    if (!t) throw bad(`« ${file.originalname} » n'est pas un fichier STL, 3MF ou OBJ valide`);
    const name = `${randomToken(16)}.${t}`;
    await storage.save(`private/${where}/${name}`, file.buffer, MIME[t]);
    return name;
  }
  async function saveCustomFile(file) {
    const t = imageType(file.buffer);
    if (t) { const name = `${randomToken(16)}.${t}`; await storage.save(`private/custom/${name}`, file.buffer, MIME[t]); return name; }
    return saveModel(file, 'custom');
  }
  const remove = (p) => storage.remove(p).catch(() => {});
  const read = (p) => storage.read(p);
  return { parseMultipart, saveImage, saveModel, saveCustomFile, remove, read };
}

module.exports = { makeUploads, parseMultipart, imageType, modelType };
