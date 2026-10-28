// La hiérarchie des cerveaux de bout en bout : rangement à l'écriture,
// lecture par cerveau, gestes humains, mode plusieurs comptes, jetons de compte.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { lancer, service, JETON_INSTALLATION, JETON_HUB } from './instance.mjs';
import { Client } from '../socle/essai/client.js';
import { adminComplet, membreInvite } from '../socle/essai/inscription.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jetonPour } = require('../src/cerveaux.js');
const inst = await lancer();
after(() => inst.arreter());
const admin = new Client(inst.port);
const { auth: cleAdmin } = await adminComplet(admin, { jeton: JETON_INSTALLATION });
const hub = service(inst, JETON_HUB);
const kimi = service(inst, jetonPour(JETON_HUB, 'kimi'));
const claude = service(inst, jetonPour(JETON_HUB, 'claude-code'));
async function renforcer(c) {
  const o = await c.post('/api/compte/renfort/options');
  const r = await c.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(o.json, c.origine) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const arbre = async c => (await c.get('/v1/hierarchie')).json;
const trouve = (a, nom) => a.comptes[0].domaines.flatMap(d => d.membres).find(m => m.nom === nom);
const communDe = (a, nom, i = 0) => a.comptes[i].domaines.find(d => d.nom === nom).commun;

test('écriture : rangée dans son cerveau, la réponse dit où', async () => {
  const r = await claude.post('/v1/ingest', { kind: 'note', title: 'La VM 102 est sur le VLAN 66', body: '' });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.deepEqual(r.json.hierarchie.cles.sort(), ['vlan:66', 'vm:102']);
  const r2 = await kimi.post('/v1/ingest', { kind: 'note', title: 'VLAN 66 filtré par le pare-feu', body: '', domaine: 'IA', entites: ['ghost'] });
  assert.ok(r2.json.hierarchie.cles.includes('e:ghost'));
  const a = await arbre(claude);
  assert.equal(a.mode, 'un');
  assert.ok(trouve(a, 'claude-code') && trouve(a, 'kimi'));
  assert.equal(communDe(a, 'IA').n, 1, 'la fiche commune des deux IA');
  // Un champ inventé est refusé, rien n'est écrit.
  assert.equal((await kimi.post('/v1/ingest', { kind: 'note', title: 'x', inconnu: 1 })).status, 400);
  assert.equal((await kimi.post('/v1/ingest', { kind: 'note', title: 'x', importance: 140 })).status, 400);
});

test('lecture : son cerveau, les fiches au-dessus, jamais le cerveau d\'une autre IA', async () => {
  const a = await arbre(claude);
  const moi = trouve(a, 'claude-code'), autre = trouve(a, 'kimi'), ia = communDe(a, 'IA');
  const r = await claude.get(`/v1/hierarchie/chercher?cerveau=${ia.id}&q=vlan&monter=0`);
  assert.equal(r.status, 200);
  assert.ok(r.json.hits.length && r.json.hits.every(h => h.kind.startsWith('fiche.')), JSON.stringify(r.json));
  assert.equal((await claude.get(`/v1/hierarchie/chercher?cerveau=${autre.id}&q=vlan`)).status, 403);
  assert.equal((await claude.get(`/v1/hierarchie/chercher?cerveau=${moi.id}&q=vlan&agent=kimi`)).status, 403, 'un service ne parle que pour lui');
  assert.equal((await claude.get(`/v1/hierarchie/chercher?cerveau=999999&q=x`)).status, 404);
  // La fiche se lit aussi par /v1/entry dans son compte ; elle ne s'écrit pas à la main.
  const f = r.json.hits[0];
  assert.equal((await claude.get('/v1/entry?id=' + f.id)).status, 200);
  assert.equal((await claude.post('/v1/ingest', { ns: 'h:compte-x', kind: 'note', title: 'fausse fiche' })).status, 403);
  assert.equal((await claude.post('/v1/link', { from_id: f.id, to_id: f.id + 1, relation: 'consolide' })).status, 400);
});

test('réglages : geste humain, à valider puis validé', async () => {
  assert.equal((await kimi.put('/v1/hierarchie/reglages', { cerveau: 1, seuil: 10 })).status, 403, 'un service ne règle rien');
  const a = await arbre(admin);
  const ia = communDe(a, 'IA');
  const r = await admin.put('/v1/hierarchie/reglages', { cerveau: ia.id, remontee: 'valider' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.reglages.remontee, 'valider');
  const d = await kimi.post('/v1/ingest', { kind: 'decision.modele', title: 'On garde qwen pour le routeur', body: '' });
  assert.equal(d.json.hierarchie.remontees, 1);
  const att = await admin.get(`/v1/hierarchie/remontees?cerveau=${ia.id}&statut=a_valider`);
  assert.equal(att.json.remontees.length, 1);
  const v = await admin.post('/v1/hierarchie/valider', { id: att.json.remontees[0].id, accepter: true });
  assert.equal(v.status, 200);
  assert.equal(v.json.statut, 'faite');
  assert.equal((await admin.post('/v1/hierarchie/valider', { id: att.json.remontees[0].id, accepter: true })).status, 409);
  assert.equal((await admin.put('/v1/hierarchie/reglages', { cerveau: ia.id, remontee: 'auto' })).status, 200);
});

test('domaines et sous-domaines, rattachement, projets partagés', async () => {
  const d = await admin.post('/v1/hierarchie/domaines', { chemin: 'Connaissance/Réseau' });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.equal((await admin.post('/v1/hierarchie/domaines', { chemin: '../etc' })).status, 400);
  const a = await arbre(admin);
  const reseau = a.comptes[0].domaines.find(x => x.nom === 'Réseau');
  const conn = a.comptes[0].domaines.find(x => x.nom === 'Connaissance');
  assert.equal(reseau.parent_id, conn.id);
  // Un projet entre deux IA : chacune lit chez l'autre ce qui porte l'étiquette du projet.
  const moi = trouve(a, 'claude-code'), autre = trouve(a, 'kimi');
  const p = await admin.post('/v1/hierarchie/projets', { nom: 'Hub', membres: [moi.id, autre.id] });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal((await admin.post('/v1/hierarchie/projets', { nom: 'Hub', membres: [moi.id, autre.id] })).status, 409);
  await kimi.post('/v1/ingest', { kind: 'note', title: 'Route /v1/events du Hub', body: '', tags: [p.json.etiquette] });
  await kimi.post('/v1/ingest', { kind: 'note', title: 'Note personnelle de kimi', body: '' });
  const vue = await claude.get(`/v1/hierarchie/chercher?cerveau=${autre.id}&monter=0`);
  assert.equal(vue.status, 200);
  assert.deepEqual(vue.json.hits.map(h => h.title), ['Route /v1/events du Hub']);
  assert.equal((await admin.post('/v1/hierarchie/projets/clore', { id: p.json.id })).status, 200);
  assert.equal((await claude.get(`/v1/hierarchie/chercher?cerveau=${autre.id}&monter=0`)).status, 403);
  // Rattacher kimi à Connaissance/Réseau.
  const rt = await admin.put('/v1/hierarchie/rattacher', { cerveau: autre.id, domaine: reseau.id });
  assert.equal(rt.status, 200);
  assert.equal((await admin.put('/v1/hierarchie/rattacher', { cerveau: communDe(a, 'IA').id, domaine: reseau.id })).status, 400);
});

test('plusieurs comptes : chacun son arbre, le commun pour tous, jetons de compte', async () => {
  assert.equal((await admin.put('/v1/hierarchie/versements', { domaine: 1, actif: true })).status, 409, 'pas de versement en mode un');
  await renforcer(admin);
  assert.equal((await admin.put('/v1/hierarchie/mode', { mode: 'plusieurs' })).status, 200);
  const { client: bruno } = await membreInvite(admin, () => new Client(inst.port), { identifiant: 'bruno' });
  const ab = await arbre(bruno);
  assert.equal(ab.mode, 'plusieurs');
  assert.equal(ab.comptes.length, 2, 'son arbre et le commun');
  assert.equal(ab.comptes[1].compte, '@commun');
  // Le premier compte garde la hiérarchie d'avant.
  const aa = await arbre(admin);
  assert.equal(aa.compte, '@principal');
  assert.ok(trouve(aa, 'claude-code'));
  // Un service sans compte écrit au commun ; Bruno le lit, pas l'arbre d'Ana.
  const w = await hub.post('/v1/ingest', { kind: 'note', title: 'Proxmox : nœud pve redémarré', body: '' });
  const communHub = (await arbre(bruno)).comptes[1].domaines.flatMap(d => d.membres).find(m => m.nom === 'hub');
  assert.ok(communHub, JSON.stringify(w.json));
  assert.equal((await bruno.get(`/v1/hierarchie/chercher?cerveau=${communHub.id}&monter=0`)).status, 200);
  assert.equal((await bruno.get(`/v1/hierarchie/chercher?cerveau=${trouve(aa, 'claude-code').id}`)).status, 403);
  assert.equal((await bruno.put('/v1/hierarchie/reglages', { cerveau: communDe(aa, 'IA').id, seuil: 5 })).status, 403, 'pas l\'arbre d\'un autre');
  assert.equal((await bruno.post('/v1/hierarchie/domaines', { chemin: 'Études', compte: '@commun' })).status, 403, 'le commun se règle par un admin');
  assert.equal((await admin.post('/v1/hierarchie/domaines', { chemin: 'Études', compte: '@commun' })).status, 201);
  // Jeton de compte : l'IA d'Ana écrit dans l'arbre d'Ana.
  const j = await admin.post('/v1/hierarchie/jetons', { nom: 'ollama-ana' });
  assert.equal(j.status, 201, JSON.stringify(j.json));
  assert.match(j.json.jeton, /^cpt_/);
  assert.equal((await admin.post('/v1/hierarchie/jetons', { nom: 'ollama-ana' })).status, 409);
  const ollama = service(inst, j.json.jeton);
  const e = await ollama.post('/v1/ingest', { kind: 'note', title: 'Préférence d\'Ana : réponses courtes', body: '' });
  assert.equal(e.status, 202);
  assert.ok(trouve(await arbre(admin), 'ollama-ana'), 'dans l\'arbre d\'Ana');
  assert.ok(!(await arbre(bruno)).comptes.some(c => c.domaines.some(d => d.membres.some(m => m.nom === 'ollama-ana'))), 'invisible pour Bruno');
  // Versement : Bruno choisit de verser son domaine IA au commun.
  const iaBruno = (await arbre(bruno)).comptes[0].domaines.find(d => d.nom === 'IA');
  const v = await bruno.put('/v1/hierarchie/versements', { domaine: iaBruno.id, actif: true });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal((await bruno.put('/v1/hierarchie/versements', { domaine: communDe(aa, 'IA').id, actif: true })).status, 400);
});
