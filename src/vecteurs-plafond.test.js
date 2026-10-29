'use strict';
/* Au-delà du plafond de l'index en mémoire, la recherche vectorielle passe
   par le repli en flux. Ce fichier tourne dans son propre processus : le
   plafond est abaissé avant le chargement des modules. */
process.env.VECTEURS_MAX = '50';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, vecToBlob } = require('./db');
const ingest = require('./ingest');
const VEC = require('./vecteurs');
const { search } = require('./search');

const DIM = 32;
const vec = graine => { const v = new Float32Array(DIM); let n = 0; for (let i = 0; i < DIM; i++) { v[i] = Math.sin(graine * 7.3 + i * 1.7); n += v[i] * v[i]; } n = Math.sqrt(n); return v.map(x => x / n); };

test('plafond : au-delà, l\'index ne charge rien, et le repli en flux trouve la bonne entrée', async () => {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-vec-')), 'v.db'));
  assert.equal(VEC.MAX_MORCEAUX, 50);
  const ids = [];
  for (let i = 0; i < 200; i++) ids.push(ingest.insert(db, { ns: 'shared', kind: 'note', title: `entrée ${i}`, body: '' }, 'kimi').id);
  const maj = db.prepare(`UPDATE chunks SET vec = ?, embedded = 1 WHERE entry_id = ?`);
  ids.forEach((id, i) => maj.run(vecToBlob(vec(i)), id));
  assert.equal(VEC.index(db, 'shared'), null, 'au-delà du plafond : pas d\'index en mémoire');
  const cible = 137;
  const r = await search(db, { q: 'zzzz', ns: 'shared', limit: 3, embed: async () => Array.from(vec(cible)) });
  assert.ok(r.hits.length, JSON.stringify(r));
  assert.equal(r.hits[0].id, ids[cible], 'le repli en flux trouve l\'entrée la plus proche');
});
