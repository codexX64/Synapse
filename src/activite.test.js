'use strict';
/* Activité mesurée : ce que l'interface affiche au lieu de chiffres écrits en dur. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const ACT = require('./activite.js');
const APP = require('./apprentissage.js');
const { buildGraph } = require('./graph.js');

function base() {
  const db = new DatabaseSync(':memory:');
  ACT.migrate(db);
  return db;
}

test('étage d’arrêt : déduit de ce que la recherche a réellement fait', () => {
  assert.equal(ACT.etageDe({ hits: [] }), 'VIDE');
  assert.equal(ACT.etageDe({ hits: [1], engines: { early: true } }), 'L0');
  assert.equal(ACT.etageDe({ hits: [1], engines: {} }), 'L1');
  assert.equal(ACT.etageDe({ hits: [1], engines: { vector: true } }), 'L2');
  assert.equal(ACT.etageDe({ hits: [] }, { synthese: true }), 'L3');
});

test('résumé : 24 h, moyenne, étages, questions récentes sans doublon', () => {
  const db = base();
  ACT.noter(db, { route: 'answer', q: 'Où tourne la supervision ?', ms: 100, arret: 'L1', hits: 2 });
  ACT.noter(db, { route: 'answer', q: 'où tourne la supervision ?', ms: 300, arret: 'L3', hits: 2 });
  ACT.noter(db, { route: 'search', q: 'oom', ms: 20, arret: 'L0', hits: 1 });
  ACT.noter(db, { route: 'brief', q: '', ms: 40, arret: 'VIDE', hits: 0 });
  const r = ACT.resume(db);
  assert.equal(r.requetes_24h, 4);
  assert.equal(r.ms_moyen_24h, 115);
  assert.deepEqual(r.etages, { L0: 1, L1: 1, L2: 0, L3: 1, VIDE: 1 });
  assert.equal(r.recentes.length, 1, 'une seule question, casse ignorée');
  assert.ok(!r.recentes.includes('oom'), 'seules les questions posées à /v1/answer servent de raccourcis');
});

test('rétention : les requêtes anciennes disparaissent', () => {
  const db = base();
  ACT.noter(db, { route: 'search', q: 'x', ms: 1, arret: 'L1', hits: 1 });
  db.prepare(`UPDATE requetes SET ts=?`).run(new Date(Date.now() - 40 * 86400000).toISOString());
  ACT.noter(db, { route: 'search', q: 'y', ms: 1, arret: 'L1', hits: 1 });
  ACT.purge(db);
  assert.equal(db.prepare(`SELECT count(*) n FROM requetes`).get().n, 1);
});

test('le journal ne fait jamais échouer la requête observée', () => {
  const db = new DatabaseSync(':memory:');   // table absente
  assert.doesNotThrow(() => ACT.noter(db, { route: 'search', q: 'x', ms: 1, arret: 'L1' }));
});

test('apprentissage : totaux et derniers événements, tous agents', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, kind TEXT, archived INTEGER DEFAULT 0)`);
  APP.migrate(db);
  assert.deepEqual(APP.resumeGlobal(db).evenements, []);
  APP.poser(db, { agent: 'qwen', cle: 'format', valeur: 'Un seul bloc de commandes.', confiance: 0.7 });
  APP.corriger(db, { agent: 'kimi', question: 'port du hub ?', correction: '8100' });
  db.prepare(`INSERT INTO entries(kind) VALUES('echange')`).run();
  const r = APP.resumeGlobal(db);
  assert.equal(r.traits, 1);
  assert.equal(r.corrections, 1);
  assert.equal(r.echanges, 1);
  assert.deepEqual(r.evenements.map(e => e.type).sort(), ['correction', 'trait']);
});

test('graphe : un échange est un échange, pas un service', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, ns TEXT, source TEXT, kind TEXT, ref TEXT, level TEXT,
    title TEXT, tags TEXT, occurred_at TEXT, dup_count INTEGER DEFAULT 1, archived INTEGER DEFAULT 0);
    CREATE TABLE links (from_id INTEGER, to_id INTEGER, relation TEXT);`);
  db.prepare(`INSERT INTO entries(ns,source,kind,level,title,tags,occurred_at) VALUES('shared','hub','echange','L0','question','echange agent:qwen',?)`)
    .run(new Date().toISOString());
  const g = buildGraph(db, { ns: 'shared' });
  assert.equal(g.nodes[0].type, 'echange');
});
