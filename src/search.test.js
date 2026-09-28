'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, decide } = require('./search.js');

test('« résume les alertes » : une demande de rédaction, pas une liste', () => {
  const p = parse('Résume les alertes');
  assert.equal(p.redige, true);
  assert.equal(p.intent, 'QUESTION');
  assert.deepEqual(p.toks, ['alertes'], 'le verbe ne part pas à la recherche');
  const hits = [{ source: 'mapmylan' }, { source: 'hub' }, { source: 'shared' }];
  assert.equal(decide(p, hits, 0.02).decision, 'SYNTHESE');
  assert.equal(decide(p, hits, 0.5).decision, 'SYNTHESE', 'même quand un résultat domine : on veut un texte');
  assert.equal(decide(p, [], 0).decision, 'VIDE');
});

test('les autres tournures de rédaction, et ce qui n’en est pas', () => {
  for (const q of ['peux-tu résumer les incidents de la semaine', 'explique l’incident de hier', 'fais le point sur le réseau', 'compare camera et nas', 'synthétise les échanges'])
    assert.equal(parse(q).redige, true, q);
  for (const q of ['alertes réseau', 'bilan du réseau', 'camera-213', 'liste les workflows'])
    assert.equal(parse(q).redige, false, q);
  assert.deepEqual(parse('résume').toks, ['resume'], 'un verbe seul reste un terme : rien d’autre à chercher');
});

test('le pluriel trouve le singulier : « alertes » cherche alerte*', () => {
  const { ftsQuery } = require('./search.js');
  assert.equal(ftsQuery(['alertes', 'reseaux', 'cves', 'mapmylan', 'acces', 'bus']), '"alerte"* OR "reseau"* OR "cves"* OR "mapmylan"* OR "acce"* OR "bus"*');
});

test('recherche réelle : « Résume les alertes » remonte les alertes de MapMyLAN', async () => {
  const openDb = require('./db.js').open;
  const ingest = require('./ingest.js');
  const { search } = require('./search.js');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-'));
  const db = openDb(path.join(dir, 't.db'));
  ingest.insert(db, { kind: 'incident.network', title: 'Vulnérabilité CVE-2021-36260 sur camera-213', body: 'Alerte MapMyLAN, gravité critique.', tags: ['mapmylan', 'alerte', 'critical'] }, 'mapmylan');
  ingest.insert(db, { kind: 'network.alert', title: 'Port 23 ouvert sur pont-hue-38', body: 'Alerte MapMyLAN, gravité élevée.', tags: ['mapmylan', 'alerte', 'high'] }, 'mapmylan');
  ingest.insert(db, { kind: 'note', title: 'Recette de cuisine', body: 'Rien à voir.' }, 'hub');
  const r = await search(db, { q: 'Résume les alertes', ns: 'shared', limit: 8 });
  assert.equal(r.decision, 'SYNTHESE');
  const titres = r.hits.map(h => h.title);
  assert.ok(titres.some(t => /CVE-2021-36260/.test(t)) && titres.some(t => /Port 23/.test(t)), JSON.stringify(titres));
  assert.ok(!titres.some(t => /cuisine/.test(t)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un résumé fait passer le grave devant : la CVE critique n’est pas noyée sous les « ne répond plus »', async () => {
  const openDb = require('./db.js').open;
  const ingest = require('./ingest.js');
  const { search } = require('./search.js');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-'));
  const db = openDb(path.join(dir, 't.db'));
  ingest.insert(db, { kind: 'incident.network', title: 'Vulnérabilité CVE-2019-0708 sur portable-40', body: 'Alerte MapMyLAN, gravité critique.', tags: ['mapmylan', 'alerte', 'critical'], occurred_at: new Date(Date.now() - 3 * 3600e3).toISOString() }, 'mapmylan');
  for (let i = 0; i < 20; i++)
    ingest.insert(db, { kind: 'network.alert', title: `Alerte : nas-${i} ne répond plus`, body: `Alerte MapMyLAN, gravité faible, appareil nas-${i}. Alerte réseau.`, tags: ['mapmylan', 'alerte', 'low'] }, 'mapmylan');
  const r = await search(db, { q: 'Résume les alertes', ns: 'shared', limit: 12 });
  const rang = r.hits.findIndex(h => /CVE-2019-0708/.test(h.title));
  assert.ok(rang >= 0 && rang < 3, `rang de la CVE : ${rang}`);
  const r2 = await search(db, { q: 'alertes', ns: 'shared', limit: 12 });
  assert.equal(r2.decision === 'SYNTHESE', false, 'une simple recherche ne change pas');
  fs.rmSync(dir, { recursive: true, force: true });
});
