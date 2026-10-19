// Un service ouvert par son adresse IP, même en HTTPS : pas de clé d'accès
// (le navigateur n'en crée ni n'en présente sur une IP), le TOTP prend le relais.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { monterBanc } from './banc.js';
import { adminComplet } from '../essai/inscription.js';
import { connexion } from '../essai/client.js';
import * as totp from '../src/totp.js';

// Le banc écoute en clair : un relais déclaré (127.0.0.1) dit que la connexion était chiffrée.
const s = await monterBanc({ env: { SOCLE_PROXYS: '127.0.0.1/32' } });
after(() => s.fermer());
const MDP = 'phrase de passe pour les essais du service';
// Un client qui joint le service par cet hôte, en HTTPS derrière le relais.
const par = (hote, c = s.client()) => {
  const req = c.req.bind(c);
  c.req = (m, ch, b, o = {}) => req(m, ch, b, { ...o, entetes: { host: hote, 'x-forwarded-proto': 'https', ...(o.entetes || {}) }, origine: `https://${hote}` });
  return c;
};

test('ouvert par son IP en HTTPS : aucune clé proposée ni exigée au renfort, le TOTP suffit ; par son nom, la clé revient', async () => {
  const { secret } = await adminComplet(s.client(), { jeton: s.jeton, maintenant: () => s.horloge.t });
  const ip = par('192.0.2.10:8100');
  const etat = await ip.get('/api/compte/etat');
  assert.equal(etat.json.securise, true);
  assert.equal(etat.json.cles, false, 'la porte ne propose pas de clé sur une IP');

  let r = await connexion(ip, 'ana', MDP);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s.horloge.t += 31_000;
  r = await ip.post('/api/compte/connexion/totp', { code: totp.code(secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s.horloge.t += 6 * 60e3;
  r = await ip.get('/api/dangereux');
  assert.equal(r.status, 403);
  assert.deepEqual(r.json.details.methodes, ['totp'], 'sur une IP, le renfort se fait au TOTP');
  r = await ip.post('/api/compte/renfort', { methode: 'totp', code: totp.code(secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await ip.post('/api/compte/cles/options');
  assert.equal(r.status, 400, 'aucune clé ne s’inscrit sur une IP');
  assert.match(r.json.error, /pas par une adresse IP/);
  assert.equal((await ip.get('/api/compte/securite')).json.clesPossibles, false, 'la page Sécurité ne propose pas d’en ajouter');

  // La même session ouverte par le nom de sa clé : la clé d'accès est de nouveau la règle.
  s.db.prepare("UPDATE socle_cles SET rp = 'service.exemple.fr'").run();
  const nom = par('service.exemple.fr', Object.assign(s.client(), { cookies: ip.cookies, csrf: ip.csrf }));
  s.horloge.t += 6 * 60e3;
  r = await nom.get('/api/dangereux');
  assert.deepEqual(r.json.details.methodes, ['cle'], 'par un nom, la clé reste exigée');
});

// Le service capte seul d'où l'on vient : un administrateur qui n'a pas encore
// de clé entre par l'adresse IP (HTTPS ou HTTP simple) avec mot de passe et
// TOTP, et c'est par le nom en HTTPS que la clé lui est demandée — puis créée.
test('administrateur sans clé : complet par l’adresse, en inscription par le nom, sans SOCLE_HTTP', async () => {
  const b = await monterBanc({ env: { SOCLE_PROXYS: '127.0.0.1/32' } });
  try {
    // Installation par l'IP : mot de passe, puis TOTP et codes de secours — pas de clé possible ici.
    const ip = par('192.0.2.20:8100', b.client());
    let r = await ip.post('/api/compte/installation', { jeton: b.jeton, identifiant: 'ana', motDePasse: MDP });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await ip.post('/api/compte/cles/options')).status, 400, 'aucune clé par l’IP');
    const t = await ip.post('/api/compte/totp');
    assert.equal(t.status, 200);
    r = await ip.post('/api/compte/totp/confirmer', { code: totp.code(t.json.secret, totp.pasCourant(b.horloge.t)) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await ip.post('/api/compte/secours')).status, 200);
    let e = await ip.get('/api/compte/etat');
    assert.equal(e.json.session.niveau, 'complet', 'par l’IP, mot de passe + TOTP suffisent : rien à inscrire');
    assert.equal(e.json.sansCle, true); assert.equal(e.json.modeHttp, false);
    assert.equal(e.json.session.compte.cle, 'ailleurs', 'la clé se crée ailleurs : par le nom');
    assert.equal((await ip.get('/api/admin')).status, 200);
    assert.equal((await ip.get('/api/compte/securite')).json.sansCle, true);

    // En HTTP simple (sans relais, cookie distinct) : une connexion neuve, pareil, et sans SOCLE_HTTP.
    const http = b.client();
    const req = http.req.bind(http);
    http.req = (m, ch, body, o = {}) => req(m, ch, body, { ...o, entetes: { host: '192.0.2.20:8100', ...(o.entetes || {}) }, origine: 'http://192.0.2.20:8100' });
    b.horloge.t += 31_000;
    r = await connexion(http, 'ana', MDP);
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.etape, 'second'); assert.deepEqual(r.json.methodes, ['totp', 'secours']);
    r = await http.post('/api/compte/connexion/totp', { code: totp.code(t.json.secret, totp.pasCourant(b.horloge.t)) });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.niveau, 'complet');
    e = await http.get('/api/compte/etat');
    assert.equal(e.json.securise, false); assert.equal(e.json.session.niveau, 'complet'); assert.equal(e.json.sansCle, true);

    // Par le nom en HTTPS : la clé est due, la session passe en inscription jusqu'à sa création.
    const nom = par('service.exemple.fr', Object.assign(b.client(), { cookies: ip.cookies, csrf: ip.csrf }));
    e = await nom.get('/api/compte/etat');
    assert.equal(e.json.session.niveau, 'inscription');
    assert.deepEqual(e.json.session.compte.manquants, ['cle']);
    assert.equal(e.json.sansCle, false); assert.equal(e.json.session.compte.cle, 'toujours');
    r = await nom.get('/api/admin');
    assert.equal(r.status, 403); assert.deepEqual(r.json.details.inscription, ['cle']);
    const { Authentificateur } = await import('../essai/authentificateur.js');
    const auth = new Authentificateur();
    const o = await nom.post('/api/compte/cles/options');
    assert.equal(o.status, 200, JSON.stringify(o.json));
    r = await nom.post('/api/compte/cles', { reponse: auth.creer(o.json, 'https://service.exemple.fr'), nom: 'Téléphone' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    e = await nom.get('/api/compte/etat');
    assert.equal(e.json.session.niveau, 'complet');
    // Et de retour par l'IP : toujours complet, la clé existe même si elle ne s'y présente pas.
    const retour = par('192.0.2.20:8100', Object.assign(b.client(), { cookies: nom.cookies, csrf: nom.csrf }));
    e = await retour.get('/api/compte/etat');
    assert.equal(e.json.session.niveau, 'complet'); assert.equal(e.json.session.compte.cle, 'ailleurs');
  } finally { await b.fermer(); }
});
