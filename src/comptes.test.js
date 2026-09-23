'use strict';
/* Comptes administrés à distance : création sans second facteur, pose
   par le titulaire, invitation bornée, compte d'origine intouchable. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const A = require('./auth.js');
const C = require('./comptes.js');

function base() {
  const db = new DatabaseSync(':memory:');
  A.migrate(db);
  C.migrate(db);
  return db;
}

/* Un compte définitif, comme au sortir de /setup. */
function fondateur(db, nom = 'origine') {
  A.assureInitial(db);
  const secret = A.secretTotp();
  const r = A.finaliseInitial(db, { nouveauNom: nom, nouveauPass: 'un-long-mot-de-passe', totpSecret: secret, totpCode: A.codeTotp(secret) });
  assert.ok(r.ok, r.error);
  return secret;
}

test('liste : le compte temporaire n’apparaît pas, le fondateur est désigné', () => {
  const db = base();
  A.assureInitial(db);
  assert.deepEqual(C.liste(db), []);
  fondateur(db);
  const [o] = C.liste(db);
  assert.equal(o.username, 'origine');
  assert.equal(o.fondateur, true);
  assert.equal(o.totpEnabled, true);
  assert.equal(o.role, 'admin');
});

test('création : pas de secret TOTP, seulement une invitation à le poser', () => {
  const db = base();
  fondateur(db);
  const r = C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' });
  assert.ok(r.ok);
  assert.ok(!('totp' in r) && !('otpauth' in r), 'l’administrateur ne voit jamais le secret');
  const a = C.liste(db).find(u => u.id === 'alice');
  assert.equal(a.totpEnabled, false);
  assert.equal(a.mfaEnAttente, true);
  assert.equal(C.enAttente(db, 'alice'), 'mfa');

  assert.match(C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' }).error, /existe/);
  assert.match(C.cree(db, { username: 'x', password: 'encore-un-long-mdp' }).error, /identifiant/);
  assert.match(C.cree(db, { username: 'bob', password: 'court' }).error, /12/);
  assert.match(C.cree(db, { username: 'admin', password: 'encore-un-long-mdp' }).error, /réservé/);
});

test('pose du second facteur : code vérifié avant écriture, puis compte normal', () => {
  const db = base();
  fondateur(db);
  C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' });
  const secret = A.secretTotp();
  assert.match(C.poseMfa(db, 'alice', secret, '000000').error || '', /incorrect|code/);
  assert.equal(C.enAttente(db, 'alice'), 'mfa', 'un mauvais code ne pose rien');
  const r = C.poseMfa(db, 'alice', secret, A.codeTotp(secret));
  assert.ok(r.ok);
  assert.equal(r.codes.length, 8);
  assert.equal(C.enAttente(db, 'alice'), null);
  assert.equal(C.liste(db).find(u => u.id === 'alice').totpEnabled, true);
  assert.match(C.poseMfa(db, 'alice', secret, A.codeTotp(secret)).error, /aucun/);
});

test('invitation expirée : refusée, un nouveau mot de passe la rouvre', () => {
  const db = base();
  fondateur(db);
  C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' });
  const vieux = new Date(Date.now() - C.DELAI_MFA_MS - 1000).toISOString();
  db.prepare(`UPDATE auth_users SET mfa_depuis=? WHERE name='alice'`).run(vieux);
  assert.ok(C.invitationExpiree(C.ligne(db, 'alice')));
  const secret = A.secretTotp();
  assert.match(C.poseMfa(db, 'alice', secret, A.codeTotp(secret)).error, /expirée/);
  assert.ok(C.motDePasse(db, 'alice', 'un-tout-nouveau-mdp').ok);
  assert.ok(!C.invitationExpiree(C.ligne(db, 'alice')));
  assert.ok(C.poseMfa(db, 'alice', secret, A.codeTotp(secret)).ok);
});

test('mot de passe : remplacé, sessions fermées', () => {
  const db = base();
  fondateur(db);
  A.ouvre(db, 'origine', '', '');
  assert.equal(db.prepare(`SELECT count(*) n FROM auth_sessions`).get().n, 1);
  assert.ok(C.motDePasse(db, 'origine', 'nouveau-mot-de-passe').ok);
  assert.equal(db.prepare(`SELECT count(*) n FROM auth_sessions`).get().n, 0);
  assert.ok(A.verifiePass('nouveau-mot-de-passe', C.ligne(db, 'origine').pass));
  assert.match(C.motDePasse(db, 'origine', 'court').error, /12/);
  assert.equal(C.motDePasse(db, 'personne', 'nouveau-mot-de-passe').status, 404);
});

test('suppression : ni le fondateur, ni le dernier compte utilisable', () => {
  const db = base();
  fondateur(db);
  assert.equal(C.supprime(db, 'origine').status, 403);
  C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' });
  assert.ok(C.supprime(db, 'alice').ok);
  assert.equal(C.ligne(db, 'alice'), undefined);
  assert.equal(C.supprime(db, 'alice').status, 404);
  assert.equal(C.supprime(db, A.INIT_USER).status, 404, 'le compte temporaire n’est pas administrable');
});

test('premier compte créé à distance : le compte temporaire disparaît', () => {
  const db = base();
  A.assureInitial(db);
  assert.ok(C.ligne(db, A.INIT_USER));
  assert.ok(C.cree(db, { username: 'alice', password: 'encore-un-long-mdp' }).ok);
  assert.equal(C.ligne(db, A.INIT_USER), undefined, 'admin / Temp1234 ne doit plus ouvrir /setup');
  assert.equal(A.assureInitial(db), false, 'et il ne revient pas au redémarrage');
});
