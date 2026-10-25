// Ce qui expire ou se retire : session inactive ou trop vieille, compte
// désactivé, lien de réinitialisation périmé ; ce qui protège les rôles : le
// dernier administrateur, le renfort ; ce que la chaîne du journal voit ; ce
// que la taille annoncée d'un corps suffit à refuser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { monterBanc } from './banc.js';
import { adminComplet, membreInvite, MDP_ESSAI } from '../essai/inscription.js';
import { connexion } from '../essai/client.js';
import * as totp from '../src/totp.js';

let s, cleAdmin, membre;
const avance = ms => { s.horloge.t += ms; };
const maintenant = () => s.horloge.t;
before(async () => {
  s = await monterBanc();
  ({ auth: cleAdmin } = await adminComplet(s.client(), { jeton: s.jeton, maintenant }));
  membre = await membreInvite(await adminParCle(), () => s.client(), { identifiant: 'leo', maintenant });
});
after(() => s.fermer());

// Une session d'administrateur neuve, par sa clé d'accès (elle vaut renfort cinq minutes).
async function adminParCle() {
  const a = s.client();
  const o = await a.post('/api/compte/connexion/cle/options');
  const r = await a.post('/api/compte/connexion/cle', { reponse: cleAdmin.signer(o.json, a.origine) });
  assert.equal(r.json?.niveau, 'complet', JSON.stringify(r.json));
  return a;
}
// Une session complète du membre : mot de passe, puis TOTP.
async function membreConnecte() {
  const m = s.client();
  assert.equal((await connexion(m, 'leo', MDP_ESSAI + ' leo')).status, 200);
  avance(30e3);
  const r = await m.post('/api/compte/connexion/totp', { code: totp.code(membre.secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return m;
}

test('session : une heure sans activité la ferme, et douze heures au plus même active', async () => {
  const m = await membreConnecte();
  assert.equal((await m.get('/api/lecture')).status, 200);
  avance(61 * 60e3);
  assert.equal((await m.get('/api/lecture')).status, 401, 'inactive plus d’une heure');
  const a = await adminParCle();
  let n = 0;
  while (n < 20 && (await a.get('/api/lecture')).status === 200) { avance(50 * 60e3); n++; }
  assert.ok(n >= 14 && n <= 15, `active toutes les cinquante minutes, elle tombe à douze heures (${n} pas)`);
});

test('compte désactivé : ses sessions ouvertes ne valent plus rien', async () => {
  const m = await membreConnecte();
  assert.equal((await m.get('/api/lecture')).status, 200);
  s.db.prepare("UPDATE socle_comptes SET actif = 0 WHERE identifiant = 'leo'").run();
  try { assert.equal((await m.get('/api/lecture')).status, 401); }
  finally { s.db.prepare("UPDATE socle_comptes SET actif = 1 WHERE identifiant = 'leo'").run(); }
});

test('lien de réinitialisation : vingt minutes, pas une de plus', async () => {
  const a = await adminParCle();
  const r = await a.post(`/api/compte/admin/comptes/${membre.compteId}/reinit`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const jeton = r.json.lien.split('#reinit=')[1];
  avance(21 * 60e3);
  assert.equal((await s.client().post('/api/compte/jeton', { usage: 'reinit', jeton, motDePasse: MDP_ESSAI + ' après' })).status, 400, 'périmé');
});

test('rôles : le dernier administrateur ne se retire pas son rôle, et un changement de rôle demande le renfort', async () => {
  const a = await adminParCle();
  const moi = s.db.prepare("SELECT id FROM socle_comptes WHERE identifiant = 'ana'").get().id;
  const soi = await a.req('PATCH', `/api/compte/admin/comptes/${moi}`, { role: 'membre' });
  assert.equal(soi.status, 409, JSON.stringify(soi.json));
  avance(6 * 60e3);
  const r = await a.req('PATCH', `/api/compte/admin/comptes/${membre.compteId}`, { role: 'lecture' });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.details?.renfort, true);
});

test('journal : retirer une ligne au milieu casse la chaîne', () => {
  for (let i = 0; i < 3; i++) s.socle.journal.ecrire({ action: 'essai.chaine', objet: String(i) });
  assert.equal(s.socle.journal.verifier().ok, true);
  const n = s.db.prepare("SELECT n FROM socle_journal WHERE action = 'essai.chaine' AND objet = '1'").get().n;
  s.db.prepare('DELETE FROM socle_journal WHERE n = ?').run(n);
  assert.equal(s.socle.journal.verifier().ok, false);
});

test('corps : une taille annoncée trop grande est refusée sans attendre le corps', async () => {
  const status = await new Promise((ok, ko) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/compte/connexion', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024), origin: s.origine, host: `localhost:${s.port}` } }, x => { x.resume(); ok(x.statusCode); });
    r.on('error', ko);
    r.setTimeout(5000, () => { ok('aucune réponse : le serveur attendait le corps annoncé'); r.destroy(); });
    r.write('{}');   // deux octets envoyés, dix mégaoctets annoncés : la réponse n'attend pas le reste
  });
  assert.equal(status, 413);
});

test('lien de vérification d’adresse : trente minutes, puis plus rien', async () => {
  const jeton = s.socle.comptes.emettreJeton('courriel', membre.compteId, 30 * 60e3, 'leo@exemple.org');
  avance(31 * 60e3);
  assert.equal((await s.client().post('/api/compte/courriel/verifier', { jeton })).status, 400, 'périmé');
  assert.equal(s.db.prepare('SELECT courriel FROM socle_comptes WHERE id = ?').get(membre.compteId).courriel, null);
});
