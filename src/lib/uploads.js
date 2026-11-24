'use strict';
// Téléversements : stockage en mémoire puis validation du contenu réel (octets magiques), jamais du seul nom.
const multer = require('multer');
const fs = require('fs');
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
    if (buf.length >= 84) {
      const n = buf.readUInt32LE(80);
      if (84 + n * 50 === buf.length) return 'stl';
    }
    const head = buf.slice(0, 512).toString('latin1').trimStart();
    if (/^solid\b/i.test(head) && !buf.includes(0)) return 'stl';
    return null;
  }
  if (ext === '.3mf') return buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ? '3mf' : null;
  if (ext === '.obj') return !buf.slice(0, 65536).includes(0) ? 'obj' : null;
  return null;
}

function makeUploads(cfg) {
  const dirs = {
    images: path.join(cfg.uploadsDir, 'images'),
    products: path.join(cfg.uploadsDir, 'private', 'products'),
    custom: path.join(cfg.uploadsDir, 'private', 'custom'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const mem = (maxMb, maxFiles) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles, fields: 30, fieldSize: 20000 } });

  function saveImage(file) {
    const t = imageType(file.buffer);
    if (!t) throw bad(`« ${file.originalname} » n'est pas une image PNG, JPEG ou WebP valide`);
    const name = `${randomToken(12)}.${t}`;
    fs.writeFileSync(path.join(dirs.images, name), file.buffer);
    return name;
  }
  function saveModel(file, where) {
    const t = modelType(file.buffer, file.originalname);
    if (!t) throw bad(`« ${file.originalname} » n'est pas un fichier STL, 3MF ou OBJ valide`);
    const name = `${randomToken(16)}.${t}`;
    fs.writeFileSync(path.join(dirs[where], name), file.buffer);
    return name;
  }
  function saveCustomFile(file) {
    if (imageType(file.buffer)) return saveImageTo(file, 'custom');
    return saveModel(file, 'custom');
  }
  function saveImageTo(file, where) {
    const t = imageType(file.buffer);
    const name = `${randomToken(16)}.${t}`;
    fs.writeFileSync(path.join(dirs[where], name), file.buffer);
    return name;
  }
  function remove(where, name) { try { fs.unlinkSync(path.join(dirs[where], path.basename(name))); } catch { /* déjà absent */ } }
  const pathOf = (where, name) => path.join(dirs[where], path.basename(name));

  return { mem, saveImage, saveModel, saveCustomFile, remove, pathOf, dirs };
}

module.exports = { makeUploads, imageType, modelType };
