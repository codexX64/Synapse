// Autorisation objet par objet : un service ne lit ni n'écrit l'espace, le
// profil, les neurones ou les liens d'un autre, et ne signe pas à sa place.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lancer, service, JETON_HUB } from './instance.mjs';

const require = createRequire(import.meta.url);
const { jetonPour } = require('../src/cerveaux.js');
const inst = await lancer();
after(() => inst.arreter());
const hub = service(inst, JETON_HUB);
const vigie = service(inst, jetonPour(JETON_HUB, 'vigie'));
const mml = service(inst, jetonPour(JETON_HUB, 'mapmylan'));

const prive = (await mml.post('/v1/ingest', { ns: 'agent:mapmylan', kind: 'note', title: 'note privée de mapmylan', body: 'rien que pour lui' })).json;
const commune = (await vigie.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 'note commune de vigie', body: 'pour tous' })).json;

test('écriture : son espace ou un espace commun, jamais celui d\'un autre', async () => {
  assert.ok(prive.id && commune.id, JSON.stringify([prive, commune]));
  assert.equal((await vigie.post('/v1/ingest', { ns: 'agent:mapmylan', kind: 'note', title: 'intrus', body: 'x' })).status, 403);
  assert.equal((await vigie.post('/v1/ingest', { ns: 'agent:vigie', kind: 'note', title: 'note de vigie à elle', body: 'x' })).status, 202);
  assert.equal((await vigie.post('/v1/ingest', { ns: 'n\'importe quoi', kind: 'note', title: 'x', body: 'x' })).status, 403);
  const lot = await vigie.post('/v1/ingest/batch', { events: [{ ns: 'agent:mapmylan', kind: 'note', title: 'intrus en lot', body: 'x' }] });
  assert.equal(lot.json.results[0].ok, false);
  assert.equal((await vigie.post('/v1/echange', { question: 'q', reponse: 'r', ns: 'agent:mapmylan' })).status, 403);
});

test('provenance : celle du jeton, l\'origine annoncée reste à part', async () => {
  const r = await vigie.post('/v1/ingest', { ns: 'shared', kind: 'note', source: 'hub', title: 'signée hub par vigie', body: 'x' });
  const e = (await hub.get('/v1/entry?id=' + r.json.id)).json;
  assert.equal(e.source, 'vigie');
  assert.equal(e.meta.origine, 'hub');
});

test('profil et apprentissage : un service ne parle que pour lui, le Hub relaie ses IA', async () => {
  assert.equal((await vigie.post('/v1/brief', { agent: 'mapmylan', q: 'réseau' })).status, 403);
  assert.equal((await vigie.post('/v1/brief', { agent: 'vigie', q: 'réseau' })).status, 200);
  assert.equal((await vigie.post('/v1/brief', { agent: 'vigie', q: 'réseau', ns: 'agent:mapmylan' })).status, 403);
  assert.equal((await hub.post('/v1/brief', { agent: 'qwen-3', q: 'réseau' })).status, 200);
  assert.equal((await vigie.get('/v1/profil?agent=mapmylan')).status, 403);
  assert.equal((await vigie.del('/v1/profil?agent=mapmylan&cle=x')).status, 403);
  assert.equal((await vigie.post('/v1/apprendre', { agent: 'mapmylan', correction: 'faux', question: 'q' })).status, 403);
  assert.equal((await vigie.post('/v1/echange', { agent: 'qwen-3', question: 'q', reponse: 'r' })).status, 403);
  assert.equal((await vigie.get('/v1/prompts?agent=mapmylan')).status, 403);
});

test('liens, clics et rangement : seulement sur ce qu\'on lit', async () => {
  assert.equal((await vigie.post('/v1/link', { from_id: commune.id, to_id: prive.id, relation: 'relates_to' })).status, 403);
  assert.equal((await vigie.post('/v1/click', { q: 'note', entry_id: prive.id })).status, 404);
  assert.equal((await vigie.get('/v1/rangement/analyse')).status, 403, 'tous les espaces : pas pour un service');
  assert.equal((await vigie.get('/v1/rangement/analyse?ns=agent:mapmylan')).status, 403);
  assert.equal((await vigie.get('/v1/rangement/analyse?ns=shared')).status, 200);
  const mcp = await vigie.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_link', arguments: { from_id: commune.id, to_id: prive.id, relation: 'relates_to' } } });
  assert.match(mcp.json.result.content[0].text, /espace interdit/);
});

test('neurones : oubliés par la source qui les a écrits', async () => {
  const n = await mml.post('/v1/neurons', { neuron: { type: 'note', root_cause: 'cause', resolution: 'fait' } });
  assert.ok([200, 201].includes(n.status), JSON.stringify(n.json));
  const id = n.json.neuron_id ?? n.json.id;
  assert.equal((await vigie.del('/v1/neuron?id=' + id)).status, 403);
  assert.equal((await mml.del('/v1/neuron?id=' + id)).status, 200);
});
