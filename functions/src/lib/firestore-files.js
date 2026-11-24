'use strict';
// Stockage des fichiers (images, STL, pièces jointes) DANS Firestore, découpés en morceaux.
// Utilisé quand Cloud Storage n'est pas disponible (projet Firebase gratuit « Spark », sans carte).
// Un document Firestore est limité à 1 Mio : chaque morceau fait 700 Kio au plus.
const CHUNK = 700 * 1024;
const PER_BATCH = 8; // ~5,6 Mio par écriture groupée (limite Firestore : 10 Mio par requête)

const idOf = (p) => Buffer.from(String(p)).toString('base64url');

function firestoreFiles(db) {
  const meta = db.collection('files');
  const chunks = db.collection('file_chunks');
  async function remove(p) {
    const id = idOf(p);
    const snap = await meta.doc(id).get();
    if (!snap.exists) return;
    const n = snap.data().chunks || 0;
    await meta.doc(id).delete(); // le fichier disparaît d'abord, puis ses morceaux
    for (let i = 0; i < n; i += PER_BATCH) {
      const b = db.batch();
      for (let j = i; j < Math.min(n, i + PER_BATCH); j++) b.delete(chunks.doc(`${id}_${j}`));
      await b.commit();
    }
  }
  return {
    async save(p, buffer, contentType) {
      const id = idOf(p);
      await remove(p);
      const n = Math.max(1, Math.ceil(buffer.length / CHUNK));
      for (let i = 0; i < n; i += PER_BATCH) {
        const b = db.batch();
        for (let j = i; j < Math.min(n, i + PER_BATCH); j++) b.set(chunks.doc(`${id}_${j}`), { data: buffer.subarray(j * CHUNK, (j + 1) * CHUNK) });
        await b.commit();
      }
      // Le document principal est écrit en dernier : un fichier à moitié écrit n'est jamais servi.
      await meta.doc(id).set({ path: String(p), contentType: contentType || 'application/octet-stream', size: buffer.length, chunks: n, created_at: Math.floor(Date.now() / 1000) });
    },
    async read(p) {
      const id = idOf(p);
      const snap = await meta.doc(id).get();
      if (!snap.exists) return null;
      const m = snap.data();
      const refs = Array.from({ length: m.chunks }, (_, i) => chunks.doc(`${id}_${i}`));
      const docs = await db.getAll(...refs);
      if (docs.some((d) => !d.exists)) return null;
      const buffer = Buffer.concat(docs.map((d) => Buffer.from(d.data().data)));
      if (buffer.length !== m.size) return null;
      return { buffer, contentType: m.contentType };
    },
    remove,
  };
}

module.exports = { firestoreFiles, CHUNK };
