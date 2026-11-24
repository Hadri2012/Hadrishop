'use strict';
// Faux Firestore en mémoire pour les tests (sous-ensemble de l'API Admin utilisée par HADRISHOP).
// Les transactions sont sérialisées (verrou global) et imposent « lectures avant écritures », comme Firestore.
const crypto = require('crypto');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeFakeFirestore() {
  const data = new Map(); // chemin du document -> objet
  let lock = Promise.resolve();

  const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);
  const match = (doc, [f, op, v]) => {
    const x = doc[f];
    switch (op) {
      case '==': return x === v;
      case '!=': return x !== v && x !== undefined;
      case '<': return x !== undefined && x !== null && x < v;
      case '<=': return x !== undefined && x !== null && x <= v;
      case '>': return x !== undefined && x !== null && x > v;
      case '>=': return x !== undefined && x !== null && x >= v;
      case 'in': return v.includes(x);
      case 'array-contains': return Array.isArray(x) && x.includes(v);
      default: throw new Error('op non supporté ' + op);
    }
  };

  function snap(ref) {
    const d = data.get(ref.path);
    return { id: ref.id, ref, exists: d !== undefined, data: () => clone(d) };
  }

  class DocRef {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    collection(c) { return new Query(`${this.path}/${c}`); }
    async get() { return snap(this); }
    async set(d, opts) { applyWrite({ type: 'set', ref: this, d, opts }); }
    async update(d) { applyWrite({ type: 'update', ref: this, d }); }
    async create(d) { applyWrite({ type: 'create', ref: this, d }); }
    async delete() { applyWrite({ type: 'delete', ref: this }); }
  }

  class Query {
    constructor(coll, filters = [], order = [], lim = null) { this.coll = coll; this.filters = filters; this.order = order; this.lim = lim; }
    doc(id) { return new DocRef(`${this.coll}/${id || crypto.randomBytes(10).toString('hex')}`); }
    async add(d) { const ref = this.doc(); await ref.set(d); return ref; }
    where(f, op, v) { return new Query(this.coll, [...this.filters, [f, op, v]], this.order, this.lim); }
    orderBy(f, dir = 'asc') { return new Query(this.coll, this.filters, [...this.order, [f, dir]], this.lim); }
    limit(n) { return new Query(this.coll, this.filters, this.order, n); }
    run() {
      const prefix = this.coll + '/';
      let docs = [];
      for (const [path, d] of data) {
        if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
        if (this.filters.every((f) => match(d, f))) docs.push(new DocRef(path));
      }
      // Comme Firestore : un orderBy exclut les documents sans ce champ
      for (const [f] of this.order) docs = docs.filter((r) => data.get(r.path)[f] !== undefined);
      if (this.order.length) docs.sort((a, b) => { for (const [f, dir] of this.order) { const c = cmp(data.get(a.path)[f], data.get(b.path)[f]); if (c) return dir === 'desc' ? -c : c; } return 0; });
      if (this.lim != null) docs = docs.slice(0, this.lim);
      const out = docs.map(snap);
      return { docs: out, empty: out.length === 0, size: out.length };
    }
    async get() { return this.run(); }
  }

  function applyWrite(w) {
    const cur = data.get(w.ref.path);
    if (w.type === 'create') { if (cur !== undefined) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } data.set(w.ref.path, clone(w.d)); }
    else if (w.type === 'set') {
      if (w.opts && w.opts.merge && cur) { const deep = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deep(a[k], v); else a[k] = v; } return a; }; data.set(w.ref.path, deep(clone(cur), clone(w.d))); }
      else data.set(w.ref.path, clone(w.d));
    } else if (w.type === 'update') {
      if (cur === undefined) { const e = new Error('NOT_FOUND: ' + w.ref.path); e.code = 5; throw e; }
      const next = clone(cur); for (const [k, v] of Object.entries(clone(w.d))) { if (k.includes('.')) throw new Error('chemins pointés non supportés dans le faux Firestore'); next[k] = v; }
      data.set(w.ref.path, next);
    } else if (w.type === 'delete') data.delete(w.ref.path);
  }

  const db = {
    collection: (c) => new Query(c),
    doc: (p) => new DocRef(p),
    async getAll(...refs) { return refs.map(snap); },
    settings() {},
    async runTransaction(fn) {
      let release; const prev = lock; lock = new Promise((r) => { release = r; });
      await prev;
      try {
        const writes = []; let wrote = false;
        const guard = () => { if (wrote) throw new Error('Firestore : toutes les lectures doivent précéder les écritures dans une transaction'); };
        const tx = {
          async get(x) { guard(); return x instanceof DocRef ? snap(x) : x.run(); },
          async getAll(...refs) { guard(); return refs.map(snap); },
          set(ref, d, opts) { wrote = true; writes.push({ type: 'set', ref, d, opts }); return tx; },
          update(ref, d) { wrote = true; writes.push({ type: 'update', ref, d }); return tx; },
          create(ref, d) { wrote = true; writes.push({ type: 'create', ref, d }); return tx; },
          delete(ref) { wrote = true; writes.push({ type: 'delete', ref }); return tx; },
        };
        const result = await fn(tx);
        // Validation puis application atomique
        const backup = new Map(data);
        try { for (const w of writes) applyWrite(w); } catch (e) { data.clear(); for (const [k, v] of backup) data.set(k, v); throw e; }
        return result;
      } finally { release(); }
    },
    _dump: () => data,
  };
  return db;
}

function makeFakeStorage() {
  const files = new Map();
  return {
    async save(path, buffer, contentType) { files.set(path, { buffer: Buffer.from(buffer), contentType }); },
    async read(path) { const f = files.get(path); return f ? f : null; },
    async remove(path) { files.delete(path); },
    _files: files,
  };
}

module.exports = { makeFakeFirestore, makeFakeStorage };
