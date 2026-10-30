// Assistant de configuration : première configuration obligatoire, puis
// seulement les réglages nouveaux d'une mise à jour.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { monterBanc } from './banc.js';
import { adminComplet, membreInvite } from '../essai/inscription.js';
import { appliquerReglages, Assistant, REGLAGES_SOCLE, SPEC_SOCLE } from '../src/index.js';

const SPEC = {
  couleur: { env: 'ESSAI_COULEUR', type: 'choix', parmi: ['bleu', 'vert'], defaut: 'bleu' },
  seuil: { env: 'ESSAI_SEUIL', type: 'entier', min: 1, max: 10, defaut: 3 },
  cleApi: { env: 'ESSAI_CLE_API', type: 'secret', min: 20 },
  cible: { env: 'ESSAI_CIBLE', type: 'url' },
};
const V1 = [
  { env: 'ESSAI_COULEUR', groupe: 'Service', libelle: 'Couleur', depuis: '1.0.0' },
  { env: 'ESSAI_SEUIL', groupe: 'Service', libelle: 'Seuil', depuis: '1.0.0' },
  { env: 'ESSAI_CLE_API', groupe: 'Service', libelle: 'Clé d’API', depuis: '1.0.0' },
];
const V2 = [...V1, { env: 'ESSAI_CIBLE', groupe: 'Service', libelle: 'Cible', depuis: '1.1.0', requis: true }];

const dossiers = [];
const nouveauDossier = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-')); dossiers.push(d); return d; };
after(() => { for (const d of dossiers) fs.rmSync(d, { recursive: true, force: true }); });
const CLE = crypto.randomBytes(32).toString('base64');

test('première configuration : le service reste fermé (428) jusqu’à la fin de l’assistant', async () => {
  const s = await monterBanc({ assistant: { reglages: V1, spec: SPEC, version: '1.0.0', redemarrer: null } });
  try {
    const admin = s.client();
    await adminComplet(admin, { jeton: s.jeton, maintenant: () => s.horloge.t, terminer: false });
    const e = await admin.etat();
    assert.deepEqual(e.assistant, { doit: true, premiere: true, nouveaux: V1.length + REGLAGES_SOCLE.length, redemarrage: false });
    let r = await admin.get('/api/lecture');
    assert.equal(r.status, 428);
    assert.equal(r.json.details.assistant, true);
    r = await admin.get('/api/compte/reglages');
    assert.equal(r.status, 200);
    assert.equal(r.json.premiere, true);
    const couleur = r.json.reglages.find(x => x.env === 'ESSAI_COULEUR');
    assert.deepEqual(couleur.parmi.map(o => o.valeur), ['bleu', 'vert']);
    assert.equal(couleur.valeur, 'bleu');
    assert.equal(r.json.reglages.find(x => x.env === 'ESSAI_CLE_API').valeur, undefined);
    // Valeur fausse : refusée champ par champ, rien n'est écrit.
    r = await admin.post('/api/compte/reglages', { valeurs: { ESSAI_SEUIL: '40', ESSAI_COULEUR: 'rouge' } });
    assert.equal(r.status, 400);
    assert.ok(r.json.details.champs.ESSAI_SEUIL);
    assert.ok(r.json.details.champs.ESSAI_COULEUR);
    assert.equal(fs.existsSync(path.join(s.dossier, 'reglages.json')), false);
    // Réglages croisés du socle : SMTP sans expéditeur refusé.
    r = await admin.post('/api/compte/reglages', { valeurs: { SOCLE_SMTP_HOTE: 'smtp.exemple.org' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /SOCLE_SMTP_DE/);
    r = await admin.post('/api/compte/reglages', { valeurs: { ESSAI_SEUIL: '7', ESSAI_CLE_API: 'k'.repeat(10) + crypto.randomBytes(12).toString('hex') } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.redemarrage, true);
    assert.equal(r.json.automatique, false);
    assert.equal((await admin.get('/api/lecture')).status, 200);
    assert.deepEqual((await admin.etat()).assistant, { doit: false, redemarrage: true });
    // Le secret est scellé dans le fichier, jamais en clair.
    const brut = fs.readFileSync(path.join(s.dossier, 'reglages.json'), 'utf8');
    assert.doesNotMatch(brut, /kkkkkkkkkk/);
    assert.equal((fs.statSync(path.join(s.dossier, 'reglages.json')).mode & 0o777), 0o600);
    const reglages = await admin.get('/api/compte/reglages');
    const cle = reglages.json.reglages.find(x => x.env === 'ESSAI_CLE_API');
    assert.equal(cle.pose, true);
    assert.equal(cle.source, 'assistant');
    assert.doesNotMatch(JSON.stringify(reglages.json), /kkkkkkkkkk/);
  } finally { await s.fermer(); }
});

test('un membre attend l’administrateur ; il ne lit ni ne pose les réglages', async () => {
  const s = await monterBanc({ assistant: { reglages: V1, spec: SPEC, version: '1.0.0', redemarrer: null } });
  try {
    const admin = s.client();
    await adminComplet(admin, { jeton: s.jeton, maintenant: () => s.horloge.t });
    // Puis une mise à jour qui ajoute un réglage, vue par un membre.
    s.socle.portail.assistant.liste.push({ env: 'ESSAI_CIBLE', libelle: 'Cible', groupe: 'Service', spec: SPEC.cible });
    s.socle.portail.assistant.cache = null;
    const { client: membre } = await membreInvite(admin, () => s.client(), { identifiant: 'bea', maintenant: () => s.horloge.t });
    assert.equal((await membre.etat()).assistant.doit, true);
    assert.equal((await membre.get('/api/lecture')).status, 428);
    assert.equal((await membre.get('/api/compte/reglages')).status, 403);
    assert.equal((await membre.post('/api/compte/reglages', { valeurs: {} })).status, 403);
  } finally { await s.fermer(); }
});

test('après une mise à jour : seuls les réglages nouveaux sont demandés, l’obligatoire est exigé', async () => {
  const dossier = nouveauDossier();
  let s = await monterBanc({ dossier, assistant: { reglages: V1, spec: SPEC, version: '1.0.0', redemarrer: null } });
  const admin = s.client();
  const { auth } = await adminComplet(admin, { jeton: s.jeton, maintenant: () => s.horloge.t });
  await s.fermer();

  // Nouvelle version, même volume : ESSAI_CIBLE apparaît.
  const relances = [];
  s = await monterBanc({ dossier, env: appliquerReglages({ dossier, env: {} }), assistant: { reglages: V2, spec: SPEC, version: '1.1.0', redemarrer: () => relances.push(1) } });
  try {
    const c = s.client();
    c.cookies = admin.cookies;
    const e = await c.etat();
    assert.deepEqual(e.assistant, { doit: true, premiere: false, nouveaux: 1, redemarrage: false });
    assert.equal((await c.get('/api/lecture')).status, 428);
    let r = await c.get('/api/compte/reglages');
    assert.equal(r.json.premiere, false);
    assert.deepEqual(r.json.reglages.filter(x => x.nouveau).map(x => x.env), ['ESSAI_CIBLE']);
    assert.equal(r.json.reglages.find(x => x.env === 'ESSAI_CIBLE').depuis, '1.1.0');
    // Hors première configuration : identité confirmée d'abord.
    s.horloge.t += 10 * 60e3;
    r = await c.post('/api/compte/reglages', { valeurs: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json.details.renfort, true);
    const o = await c.post('/api/compte/renfort/options');
    assert.equal((await c.post('/api/compte/renfort', { methode: 'cle', reponse: auth.signer(o.json, c.origine) })).status, 200);
    r = await c.post('/api/compte/reglages', { valeurs: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.details.champs.ESSAI_CIBLE, 'Obligatoire.');
    r = await c.post('/api/compte/reglages', { valeurs: { ESSAI_CIBLE: 'https://cible.exemple.org' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.automatique, true);
    await new Promise(f => setTimeout(f, 400));
    assert.equal(relances.length, 1);
    assert.equal((await c.get('/api/lecture')).status, 200);
  } finally { await s.fermer(); }
});

test('Assistant seul : nouveaux réglages, obligatoire, redémarrage, environnement prioritaire', () => {
  const dossier = nouveauDossier();
  const relances = [];
  const env1 = appliquerReglages({ dossier, env: { SOCLE_CLE: CLE, ESSAI_SEUIL: '5' } });
  let a = new Assistant({ dossier, env: env1, liste: [...REGLAGES_SOCLE, ...V1], specs: [SPEC_SOCLE, SPEC], version: '1.0.0', redemarrer: () => relances.push(1) });
  assert.equal(a.aFaire().premiere, true);
  const pub = a.public();
  assert.equal(pub.reglages.find(r => r.env === 'ESSAI_SEUIL').source, 'environnement');
  assert.equal(a.enAttente().some(r => r.env === 'ESSAI_SEUIL'), false, 'posé dans l’environnement : jamais demandé');
  let r = a.poser({ ESSAI_SEUIL: '2' });
  assert.equal(r.ok, false);
  assert.match(r.erreurs.ESSAI_SEUIL, /environnement/);
  r = a.poser({ ESSAI_COULEUR: 'bleu' });
  assert.equal(r.ok, true);
  assert.equal(r.redemarrage, false, 'la valeur proposée gardée ne relance rien');
  assert.equal(a.aFaire().doit, false);
  r = a.poser({ ESSAI_CLE_API: 'jeton-api-'.padEnd(30, 'z') });
  assert.equal(r.redemarrage, true);
  assert.deepEqual(r.changes, ['ESSAI_CLE_API']);

  // Redémarrage : l'environnement relu porte le secret ; l'environnement réel l'emporte toujours.
  const env2 = appliquerReglages({ dossier, env: { SOCLE_CLE: CLE, ESSAI_SEUIL: '5' } });
  assert.equal(env2.ESSAI_CLE_API, 'jeton-api-'.padEnd(30, 'z'));
  assert.equal(env2.ESSAI_COULEUR, 'bleu');
  assert.equal(appliquerReglages({ dossier, env: { SOCLE_CLE: CLE, ESSAI_CLE_API: 'autre'.padEnd(25, 'y') } }).ESSAI_CLE_API, 'autre'.padEnd(25, 'y'));

  // Version suivante : un réglage obligatoire, seul demandé.
  a = new Assistant({ dossier, env: env2, liste: [...REGLAGES_SOCLE, ...V2], specs: [SPEC_SOCLE, SPEC], version: '1.1.0', redemarrer: () => relances.push(1) });
  assert.deepEqual(a.aFaire(), { doit: true, premiere: false, nouveaux: 1 });
  r = a.poser({});
  assert.equal(r.ok, false);
  assert.equal(r.erreurs.ESSAI_CIBLE, 'Obligatoire.');
  r = a.poser({ ESSAI_CIBLE: 'ftp://x' });
  assert.equal(r.ok, false);
  r = a.poser({ ESSAI_CIBLE: 'https://cible.exemple.org/' });
  assert.equal(r.ok, true);
  assert.equal(a.aFaire().doit, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dossier, 'reglages.json'), 'utf8')).vus.ESSAI_CIBLE, '1.1.0');
  // Un texte vide efface (retour au défaut) ; un secret effacé disparaît.
  r = a.poser({ ESSAI_CLE_API: '' });
  assert.deepEqual(r.changes, ['ESSAI_CLE_API']);
  assert.equal(appliquerReglages({ dossier, env: { SOCLE_CLE: CLE } }).ESSAI_CLE_API, undefined);
});

test('rotation de la clé maîtresse : les secrets des réglages passent sous la neuve', () => {
  const dossier = nouveauDossier();
  const neuve = crypto.randomBytes(32).toString('base64');
  const env = appliquerReglages({ dossier, env: { SOCLE_CLE: CLE } });
  const a = new Assistant({ dossier, env, liste: V1, specs: [SPEC], version: '1.0.0' });
  assert.equal(a.poser({ ESSAI_CLE_API: 'cle-api-'.padEnd(28, 'q') }).ok, true);
  const avant = fs.readFileSync(path.join(dossier, 'reglages.json'), 'utf8');
  const tourne = appliquerReglages({ dossier, env: { SOCLE_CLE: neuve, SOCLE_CLE_ANCIENNE: CLE } });
  assert.equal(tourne.ESSAI_CLE_API, 'cle-api-'.padEnd(28, 'q'));
  assert.notEqual(fs.readFileSync(path.join(dossier, 'reglages.json'), 'utf8'), avant);
  assert.equal(appliquerReglages({ dossier, env: { SOCLE_CLE: neuve } }).ESSAI_CLE_API, 'cle-api-'.padEnd(28, 'q'));
  assert.throws(() => appliquerReglages({ dossier, env: { SOCLE_CLE: crypto.randomBytes(32).toString('base64') } }));
});

test('déclaration fautive : une variable inconnue arrête le démarrage', () => {
  assert.throws(() => new Assistant({ dossier: nouveauDossier(), env: {}, liste: [{ env: 'INCONNUE', libelle: 'x' }], specs: [SPEC] }), /INCONNUE/);
});

test('nouveautés : une fois par compte et par version, rien sur une installation neuve', async () => {
  const { Nouveautes, comparerVersions } = await import('../src/nouveautes.js');
  assert.equal(comparerVersions('2.10.0', '2.9.3'), 1);
  assert.equal(comparerVersions('2.4.0-rc.1', '2.4.0'), -1);
  const liste = [{ version: '1.2.0', date: '2026-10-30', points: ['Deux'] }, { version: '1.1.0', points: ['Un'] }, { version: '1.3.0', points: ['Futur'] }];
  const dossier = nouveauDossier();
  let s = await monterBanc({ dossier, version: '1.1.0', nouveautes: liste });
  const admin = s.client();
  await adminComplet(admin, { jeton: s.jeton, maintenant: () => s.horloge.t });
  assert.equal((await admin.etat()).nouveautes, undefined, 'compte neuf : rien à montrer');
  await s.fermer();
  s = await monterBanc({ dossier, version: '1.2.0', nouveautes: liste });
  try {
    const c = s.client(); c.cookies = admin.cookies;
    const e = await c.etat();
    assert.deepEqual(e.nouveautes, { version: '1.2.0', depuis: '1.1.0', versions: [{ version: '1.2.0', date: '2026-10-30', points: ['Deux'] }] });
    assert.equal((await c.post('/api/compte/nouveautes/vues')).status, 200);
    assert.equal((await c.etat()).nouveautes, undefined);
  } finally { await s.fermer(); }
  // Compte d'avant la fonction (aucune trace, créé il y a longtemps) : voit la version en cours.
  const n = new Nouveautes({ db: { prepare: () => ({ get: () => undefined, run: () => {} }) }, version: '1.2.0', liste });
  assert.equal(n.pour('x', { cree: 0, maintenant: Date.now() }).versions[0].version, '1.2.0');
  assert.equal(n.pour('x', { cree: Date.now() - 1000, maintenant: Date.now() }), null);
});
