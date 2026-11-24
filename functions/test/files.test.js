'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeFakeFirestore } = require('./fake-firestore');
const { firestoreFiles, CHUNK } = require('../src/lib/firestore-files');

test('fichiers dans Firestore : petit, gros (30 Mo), remplacement, suppression', async () => {
  const db = makeFakeFirestore();
  const fs = firestoreFiles(db);
  assert.equal(await fs.read('images/absent.png'), null);
  const small = crypto.randomBytes(1000);
  await fs.save('images/a.png', small, 'image/png');
  const r = await fs.read('images/a.png');
  assert.ok(r.buffer.equals(small)); assert.equal(r.contentType, 'image/png');
  const big = crypto.randomBytes(30 * 1024 * 1024 + 17);
  await fs.save('private/products/b.stl', big, 'model/stl');
  assert.ok((await fs.read('private/products/b.stl')).buffer.equals(big));
  const chunks = () => [...db._dump().keys()].filter((k) => k.startsWith('file_chunks/')).length;
  assert.equal(chunks(), 1 + Math.ceil(big.length / CHUNK));
  await fs.save('private/products/b.stl', small, 'model/stl'); // remplacement : anciens morceaux supprimés
  assert.ok((await fs.read('private/products/b.stl')).buffer.equals(small));
  assert.equal(chunks(), 2);
  await fs.remove('private/products/b.stl'); await fs.remove('images/a.png'); await fs.remove('inexistant');
  assert.equal(chunks(), 0);
  assert.equal(await fs.read('images/a.png'), null);
});

test('application complète avec les fichiers stockés dans Firestore', async () => {
  const { setup, createUser, createProduct } = require('./helpers');
  const request = require('supertest');
  const ctx = setup({ filesInFirestore: true });
  const admin = await createUser(ctx, { role: 'admin' });
  const p = await createProduct(admin, { name: 'Image Firestore' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2_000_000)]);
  const up = await admin.post(`/api/admin/products/${p.id}/images`).attach('images', png, { filename: 'x.png', contentType: 'image/png' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const img = await request(ctx.app).get(up.body[0].url).buffer(true).parse((res, cb) => { const a = []; res.on('data', (c) => a.push(c)); res.on('end', () => cb(null, Buffer.concat(a))); });
  assert.equal(img.status, 200); assert.ok(img.body.equals(png));
});
