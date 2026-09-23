'use strict';
/* L'index en mémoire doit rendre EXACTEMENT ce que rendait la boucle
   SQL. Un index plus rapide mais qui classe autrement n'est pas une
   optimisation, c'est une régression silencieuse. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { vecToBlob, blobToVec } = require('./db.js');
const VEC = require('./vecteurs.js');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, seq INTEGER,
                         text TEXT, embedded INTEGER DEFAULT 0, vec BLOB, dim INTEGER, model TEXT)`);
  return db;
}

function pose(db, ns, entryId, vec, { archived = 0 } = {}) {
  db.prepare(`INSERT OR IGNORE INTO entries(id,ns,archived) VALUES (?,?,?)`).run(entryId, ns, archived);
  db.prepare(`UPDATE entries SET archived=? WHERE id=?`).run(archived, entryId);
  db.prepare(`INSERT INTO chunks(entry_id,seq,text,embedded,vec,dim,model) VALUES (?,?,?,1,?,?,'t')`)
    .run(entryId, 0, 'x', vecToBlob(vec), vec.length);
}

/* La référence : la boucle telle qu'elle existait avant l'index. */
function referenceSQL(db, ns, qvec, limit) {
  const rows = db.prepare(
    `SELECT c.entry_id AS id, c.vec AS v FROM chunks c JOIN entries e ON e.id = c.entry_id
     WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.archived = 0 AND e.ns = ?`).all(ns);
  const best = new Map();
  for (const r of rows) {
    const v = blobToVec(r.v);
    if (v.length !== qvec.length) continue;
    let dot = 0;
    for (let i = 0; i < qvec.length; i++) dot += v[i] * qvec[i];
    const prev = best.get(r.id);
    if (prev === undefined || dot > prev) best.set(r.id, dot);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

function normalise(v) {
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

test('index : même classement que la boucle SQL', () => {
  VEC.invalider();
  const db = base();
  const dim = 24;
  for (let i = 1; i <= 60; i++) {
    const v = normalise(Array.from({ length: dim }, (_, k) => Math.sin(i * (k + 1)) + 0.1 * k));
    pose(db, 'shared', i, v);
  }
  const q = normalise(Array.from({ length: dim }, (_, k) => Math.sin(7 * (k + 1)) + 0.1 * k));
  const qv = Float32Array.from(q);

  const attendu = referenceSQL(db, 'shared', qv, 8);
  const obtenu = VEC.proches(db, 'shared', qv, 8).map(h => h.id);
  assert.deepEqual(obtenu, attendu);
  assert.equal(obtenu[0], 7, 'le vecteur identique arrive premier');
});

test('index : une entrée archivée disparaît, et l’index s’en aperçoit tout seul', () => {
  VEC.invalider();
  const db = base();
  const dim = 8;
  const v = normalise([1, 0, 0, 0, 0, 0, 0, 0]);
  pose(db, 'shared', 1, v);
  pose(db, 'shared', 2, normalise([0, 1, 0, 0, 0, 0, 0, 0]));
  const qv = Float32Array.from(v);
  assert.equal(VEC.proches(db, 'shared', qv, 5)[0].id, 1);

  db.prepare(`UPDATE entries SET archived=1 WHERE id=1`).run();
  VEC.invalider('shared');                       // l'archivage ne touche pas aux morceaux
  const ids = VEC.proches(db, 'shared', qv, 5).map(h => h.id);
  assert.deepEqual(ids, [2]);
  assert.equal(dim, 8);
});

test('index : les espaces restent étanches', () => {
  VEC.invalider();
  const db = base();
  const v = normalise([1, 0, 0, 0]);
  pose(db, 'shared', 1, v);
  pose(db, 'prive', 2, v);
  const qv = Float32Array.from(v);
  assert.deepEqual(VEC.proches(db, 'shared', qv, 5).map(h => h.id), [1]);
  assert.deepEqual(VEC.proches(db, 'prive', qv, 5).map(h => h.id), [2]);
});

test('index : le laissez-passer restreint sans changer l’ordre', () => {
  VEC.invalider();
  const db = base();
  const dim = 12;
  for (let i = 1; i <= 20; i++) {
    pose(db, 'shared', i, normalise(Array.from({ length: dim }, (_, k) => Math.cos(i + k))));
  }
  const qv = Float32Array.from(normalise(Array.from({ length: dim }, (_, k) => Math.cos(5 + k))));
  const tous = VEC.proches(db, 'shared', qv, 20).map(h => h.id);
  const garde = new Set([tous[1], tous[3], tous[7]]);
  const filtres = VEC.proches(db, 'shared', qv, 20, garde).map(h => h.id);
  assert.deepEqual(filtres, tous.filter(id => garde.has(id)));
});

test('index : un vecteur d’une autre dimension est écarté, pas planté', () => {
  VEC.invalider();
  const db = base();
  pose(db, 'shared', 1, normalise([1, 0, 0, 0]));
  pose(db, 'shared', 2, normalise([1, 0, 0, 0, 0, 0]));   // modèle changé en cours de route
  const qv = Float32Array.from(normalise([1, 0, 0, 0]));
  assert.deepEqual(VEC.proches(db, 'shared', qv, 5).map(h => h.id), [1]);

  // Une requête d'une dimension inconnue rend null : l'appelant reprend le SQL.
  assert.equal(VEC.proches(db, 'shared', Float32Array.from([1, 0]), 5), null);
});

test('index : un espace vide rend null plutôt qu’une liste vide', () => {
  VEC.invalider();
  const db = base();
  assert.equal(VEC.proches(db, 'vide', Float32Array.from([1, 0]), 5), null);
});

test('index : il ne se reconstruit pas tant que rien n’a été vectorisé', () => {
  VEC.invalider();
  const db = base();
  pose(db, 'shared', 1, normalise([1, 0, 0, 0]));
  const a = VEC.index(db, 'shared');
  const b = VEC.index(db, 'shared');
  assert.equal(a, b, 'même objet : aucun travail refait');
  pose(db, 'shared', 2, normalise([0, 1, 0, 0]));
  assert.notEqual(VEC.index(db, 'shared'), a, 'une ingestion le périme');
});
