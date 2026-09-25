'use strict';
/* ============================================================
   Tests de l'annuaire des cerveaux.

   Ce que prouve cette suite : un jeton de cerveau ne vaut que pour son
   nom, une fiche ne dit que ce qu'on lui permet de dire, orienter
   retrouve le bon cerveau et reconnaît une action, et le brief ne
   renvoie jamais un cerveau vers lui-même.

   node --test src/cerveaux.test.js
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { open } = require('./db.js');
const CER = require('./cerveaux.js');

const FILE = '/tmp/cerveaux-test.db';
try { for (const s of ['', '-wal', '-shm']) fs.unlinkSync(FILE + s); } catch {}
const db = open(FILE);
CER.migrate(db);

const CLE = 'jeton-du-hub-assez-long-pour-servir';

test('un jeton de cerveau ne vaut que pour son nom, et seulement avec la bonne clé', () => {
  const j = CER.jetonPour(CLE, 'mapmylan');
  assert.match(j, /^cer_mapmylan_[0-9a-f]{64}$/);
  assert.equal(CER.verifieJeton(CLE, j), 'mapmylan');
  assert.equal(CER.verifieJeton('une-autre-cle-bien-longue', j), null, 'une autre clé ne le valide pas');
  assert.equal(CER.verifieJeton(CLE, j.replace('cer_mapmylan_', 'cer_hub_')), null, 'changer le nom invalide le jeton');
  assert.equal(CER.verifieJeton('', j), null, 'sans clé du Hub, aucun jeton dérivé');
  assert.equal(CER.jetonPour(CLE, 'Nom Invalide'), null);
});

test('une fiche est nettoyée : longueurs bornées, adresse http seulement', () => {
  const r = CER.inscrire(db, 'mapmylan', {
    titre: 'MapMyLAN — le réseau local', perimetre: 'Le réseau : appareils, VLAN, alertes, ports, vulnérabilités.',
    sait: ['réseau', 'appareils', 'adresse IP', 'VLAN', 'alertes', 'quarantaine', 'x'.repeat(200)],
    actions: [{ nom: 'bloquer ou mettre en quarantaine un appareil', ou: 'MapMyLAN → Sécurité' }, { nom: '' }],
    regles: 'Lecture seule.', ui: 'javascript:alert(1)',
  });
  assert.equal(r.ok, true);
  const f = CER.un(db, 'mapmylan');
  assert.equal(f.ui, '', 'une adresse qui n’est pas http est refusée');
  assert.equal(f.sait.at(-1).length, 48);
  assert.equal(f.actions.length, 1);
  assert.equal(CER.inscrire(db, 'x', { titre: 't' }).ok, false, 'nom trop court');
  assert.equal(CER.inscrire(db, 'vide', {}).ok, false, 'titre requis');
});

test('orienter : le cerveau nommé ou dont c’est le sujet, et qui fait l’action', () => {
  CER.inscrire(db, 'hub', {
    titre: 'Hub — chef d’orchestre', perimetre: 'Installe et relie les services, crée et lance les workflows, envoie les notifications.',
    sait: ['workflow', 'workflows', 'automatisation', 'extension', 'installer un service', 'telegram', 'notification'],
    actions: [{ nom: 'créer ou modifier un workflow', ou: 'Hub → Assistant' }, { nom: 'installer ou mettre à jour un service', ou: 'Hub → Extensions' }],
    ui: 'http://192.0.2.10:8100',
  });
  CER.inscrire(db, 'sentinel', { titre: 'Sentinel — surveillance', sait: ['intrusion', 'honeypot', 'ids'], actions: [{ nom: 'isoler une machine compromise', ou: 'Sentinel' }] });
  CER.poserEtat(db, 'hub', '4 services en ligne, 7 workflows actifs, 0 échec depuis 24 h.');

  const a = CER.orienter(db, 'Crée des workflows pour Sentinel', { depuis: 'mapmylan' });
  assert.equal(a.action, true);
  assert.deepEqual(a.cerveaux.map(c => c.nom).slice(0, 2).sort(), ['hub', 'sentinel']);
  const hub = a.cerveaux.find(c => c.nom === 'hub');
  assert.equal(hub.action.nom, 'créer ou modifier un workflow');
  assert.equal(hub.ui, 'http://192.0.2.10:8100');

  const q = CER.orienter(db, 'combien d’appareils en quarantaine sur le réseau ?', { depuis: 'hub' });
  assert.equal(q.action, false);
  assert.equal(q.cerveaux[0].nom, 'mapmylan');

  assert.deepEqual(CER.orienter(db, 'bonjour').cerveaux, [], 'rien à orienter');
});

test('le brief donne les AUTRES cerveaux concernés, avec leur état, jamais soi-même', () => {
  const b = CER.pourBrief(db, 'état des workflows et des appareils du réseau', 'mapmylan');
  assert.deepEqual(b.map(c => c.nom), ['hub']);
  const t = CER.texteBrief(b);
  assert.match(t, /Hub — chef d’orchestre \[hub\] — état au .* 4 services en ligne/);
  const act = CER.texteBrief(CER.pourBrief(db, 'crée un workflow qui me prévient', 'mapmylan'));
  assert.match(act, /Action « créer ou modifier un workflow » : c'est lui qui la fait \(Hub → Assistant\)\. Ne la fais pas/);
});

test('l’état exige une fiche, et un cerveau se retire', () => {
  assert.equal(CER.poserEtat(db, 'inconnu', 'x').ok, false);
  assert.equal(CER.retirer(db, 'sentinel'), true);
  assert.equal(CER.un(db, 'sentinel'), undefined);
});
