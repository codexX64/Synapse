// Dévoiler un secret en clair : une vérification faite exprès (mot de passe et
// code ensemble, ou la clé d'accès), qui vaut deux minutes, tracée, et jamais
// ouverte au Hub délégué.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { monterBanc } from './banc.js';
import { adminComplet } from '../essai/inscription.js';
import { connexion } from '../essai/client.js';
import * as totp from '../src/totp.js';

const s = await monterBanc({ env: { SOCLE_PROXYS: '127.0.0.1/32' } });
after(() => s.fermer());
const MDP = 'phrase de passe pour les essais du service';
const par = (hote, c = s.client()) => {
  const req = c.req.bind(c);
  c.req = (m, ch, b, o = {}) => req(m, ch, b, { ...o, entetes: { host: hote, 'x-forwarded-proto': 'https', ...(o.entetes || {}) }, origine: `https://${hote}` });
  return c;
};

test('une session fraîche ne dévoile rien : mot de passe et code ensemble, puis deux minutes', async () => {
  const { secret } = await adminComplet(s.client(), { jeton: s.jeton, maintenant: () => s.horloge.t });
  const ip = par('192.0.2.10:8100');
  let r = await connexion(ip, 'ana', MDP);
  s.horloge.t += 31_000;
  r = await ip.post('/api/compte/connexion/totp', { code: totp.code(secret, totp.pasCourant(s.horloge.t)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Connectée à l'instant, donc renforcée — mais pas de quoi dévoiler.
  r = await ip.get('/api/dangereux'); assert.equal(r.status, 200);
  r = await ip.get('/api/secret');
  assert.equal(r.status, 403);
  assert.equal(r.json.details.devoiler, true);
  assert.deepEqual(r.json.details.methodes, ['motdepasse+totp'], 'sur une IP : mot de passe et code');
  // Le mot de passe seul ne suffit pas, le code seul non plus.
  s.horloge.t += 31_000;
  const code = () => totp.code(secret, totp.pasCourant(s.horloge.t));
  r = await ip.post('/api/compte/devoiler', { methode: 'motdepasse', motDePasse: MDP });
  assert.equal(r.status, 400);
  r = await ip.post('/api/compte/devoiler', { methode: 'motdepasse+totp', motDePasse: 'faux', code: code() });
  assert.equal(r.status, 401);
  s.horloge.t += 31_000;
  r = await ip.post('/api/compte/devoiler', { methode: 'motdepasse+totp', motDePasse: MDP, code: code() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.devoileJusqua > s.horloge.t);
  r = await ip.get('/api/secret');
  assert.equal(r.status, 200);
  assert.equal(r.json.valeur, 'sk_secret_en_clair');
  assert.ok((await ip.get('/api/compte/etat')).json.session.devoileJusqua > 0);
  // Deux minutes plus tard, c'est fini.
  s.horloge.t += 2 * 60e3 + 1;
  r = await ip.get('/api/secret');
  assert.equal(r.status, 403);
  assert.equal((await ip.get('/api/compte/etat')).json.session.devoileJusqua, 0);
  // Et le journal en garde la trace.
  const traces = s.db.prepare("SELECT action, resultat FROM socle_journal WHERE action = 'devoilement' ORDER BY rowid").all();
  assert.deepEqual(traces.map(t => t.resultat), ['refus', 'ok']);
});
