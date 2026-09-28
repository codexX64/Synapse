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
