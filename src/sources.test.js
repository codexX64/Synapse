'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('./db.js');
const ingest = require('./ingest.js');
const SRC = require('./sources.js');

test('par source : comptes, types du jour, simulées ; la purge ne touche que les simulées', () => {
  const db = open(':memory:');
  ingest.insert(db, { kind: 'network.alert', title: 'Port 23 ouvert sur camera', tags: ['mapmylan', 'simulation'] }, 'mapmylan');
  ingest.insert(db, { kind: 'network.device.new', title: 'Nouvel appareil 10.0.0.9', tags: ['simulation'] }, 'mapmylan');
  ingest.insert(db, { kind: 'network.alert', title: 'Vraie alerte', tags: ['mapmylan'] }, 'mapmylan');
  ingest.insert(db, { kind: 'echange', title: 'Question au Hub' }, 'hub');
  const s = Object.fromEntries(SRC.parSource(db).map(x => [x.source, x]));
  assert.equal(s.mapmylan.total, 3); assert.equal(s.mapmylan.simule, 2); assert.equal(s.mapmylan.jour, 3);
  assert.deepEqual(s.mapmylan.types.find(t => t.kind === 'network.alert'), { kind: 'network.alert', n: 2 });
  assert.equal(s.hub.simule, 0);
  assert.deepEqual(SRC.purgerSimulation(db), { supprimees: 2 });
  assert.equal(SRC.parSource(db).find(x => x.source === 'mapmylan').total, 1, 'la vraie alerte reste');
  assert.equal(db.prepare('SELECT count(*) n FROM chunks').get().n, db.prepare('SELECT count(*) n FROM chunks c JOIN entries e ON e.id = c.entry_id').get().n, 'pas de morceau orphelin');
});
