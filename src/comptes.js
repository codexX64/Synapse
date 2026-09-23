'use strict';
/* Comptes humains gérés par un administrateur — le Hub, en pratique.

   Un compte créé ainsi n'a pas de second facteur : l'administrateur ne
   doit jamais voir le secret TOTP d'un autre, sinon il peut se connecter
   à sa place. Le titulaire pose lui-même son second facteur à sa première
   connexion, sur /setup, et ne peut rien faire d'autre avant.

   Cette fenêtre — un mot de passe qui ouvre /setup et rien d'autre — est
   bornée dans le temps : passé le délai, il faut un nouveau mot de passe,
   c'est-à-dire repasser par l'administrateur. */

const A = require('./auth.js');

const NOM_RE = /^[a-z0-9._-]{3,32}$/i;
const DELAI_MFA_MS = 7 * 86400000;
const ROLE = 'admin';            // SYNAPSE n'a qu'un rôle humain

function migrate(db) {
  for (const col of ['init INTEGER NOT NULL DEFAULT 0',
                     'mfa_a_poser INTEGER NOT NULL DEFAULT 0',
                     'mfa_depuis TEXT']) {
    try { db.exec(`ALTER TABLE auth_users ADD COLUMN ${col}`); } catch {}
  }
}

function ligne(db, nom) {
  return db.prepare(`SELECT * FROM auth_users WHERE name=?`).get(String(nom || ''));
}

/* Le second facteur reste à poser, et l'invitation n'a pas expiré. */
function mfaAPoser(db, nom) {
  const u = ligne(db, nom);
  return !!(u && u.mfa_a_poser && !u.init);
}
function invitationExpiree(u) {
  return !!(u && u.mfa_a_poser && u.mfa_depuis
    && Date.now() - new Date(u.mfa_depuis).getTime() > DELAI_MFA_MS);
}

/* Compte temporaire ou second facteur manquant : seule /setup est permise. */
function enAttente(db, nom) {
  return A.estInit(db, nom) ? 'init' : mfaAPoser(db, nom) ? 'mfa' : null;
}

/* Le compte d'origine : le plus ancien compte définitif. C'est par lui
   qu'on reprend la main ; il ne se supprime pas depuis l'extérieur. */
function fondateur(db) {
  const r = db.prepare(`SELECT name FROM auth_users WHERE init=0
                        ORDER BY created_at, name LIMIT 1`).get();
  return r ? r.name : null;
}

function liste(db) {
  const f = fondateur(db);
  /* Le compte temporaire n'apparaît pas : ce n'est pas un compte, c'est
     une porte vers /setup, et l'annoncer ne servirait qu'à qui cherche. */
  const rows = db.prepare(
    `SELECT u.name, u.totp, u.active, u.mfa_a_poser, u.mfa_depuis, u.created_at, u.last_seen,
            (SELECT count(*) FROM auth_passkeys p WHERE p.user = u.name) cles
     FROM auth_users u WHERE u.init = 0 ORDER BY u.created_at, u.name`).all();
  return rows.map(u => ({
    id: u.name,
    username: u.name,
    role: ROLE,
    actif: !!u.active,
    totpEnabled: !u.mfa_a_poser && (!!u.totp || Number(u.cles) > 0),
    mfaEnAttente: !!u.mfa_a_poser,
    invitationExpiree: invitationExpiree(u),
    createdAt: u.created_at,
    lastLogin: u.last_seen || null,
    fondateur: u.name === f,
  }));
}

function cree(db, { username, password }) {
  const nom = String(username || '').trim();
  const pass = String(password || '');
  if (!NOM_RE.test(nom)) return { error: 'identifiant : 3 à 32 caractères simples (lettres, chiffres, . _ -)' };
  if (pass.length < 12) return { error: 'mot de passe : 12 caractères au minimum' };
  if (nom === A.INIT_USER) return { error: 'identifiant réservé' };
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO auth_users(name,pass,totp,active,init,mfa_a_poser,mfa_depuis,created_at)
                VALUES(?,?,NULL,1,0,1,?,?)`).run(nom, A.hachePass(pass), now, now);
  } catch { return { error: 'ce compte existe déjà' }; }
  /* Un vrai compte existe désormais : le compte temporaire du premier
     démarrage n'a plus de raison d'être, et le laisser en place, c'est
     laisser admin / Temp1234 ouvrir /setup à qui le connaît. */
  const tmp = db.prepare(`SELECT name FROM auth_users WHERE init=1`).all();
  for (const t of tmp) A.fermeTout(db, t.name);
  db.prepare(`DELETE FROM auth_users WHERE init=1`).run();
  return { ok: true, id: nom,
    message: `Compte ${nom} créé. Son titulaire pose son second facteur à la première connexion (sous 7 jours).` };
}

function motDePasse(db, nom, password) {
  const u = ligne(db, nom);
  if (!u || u.init) return { error: 'compte inconnu', status: 404 };
  const pass = String(password || '');
  if (pass.length < 12) return { error: 'mot de passe : 12 caractères au minimum' };
  db.prepare(`UPDATE auth_users SET pass=? WHERE name=?`).run(A.hachePass(pass), u.name);
  /* Un second facteur encore à poser : le nouveau mot de passe rouvre
     l'invitation pour la même durée. */
  if (u.mfa_a_poser) db.prepare(`UPDATE auth_users SET mfa_depuis=? WHERE name=?`)
    .run(new Date().toISOString(), u.name);
  /* On change un mot de passe parce qu'on le croit compromis : les
     sessions ouvertes avec l'ancien tombent avec lui. */
  A.fermeTout(db, u.name);
  return { ok: true };
}

function supprime(db, nom) {
  const u = ligne(db, nom);
  if (!u || u.init) return { error: 'compte inconnu', status: 404 };
  if (u.name === fondateur(db))
    return { error: 'le compte d’origine ne se supprime pas à distance', status: 403 };
  const actifs = db.prepare(`SELECT count(*) n FROM auth_users WHERE init=0 AND active=1 AND mfa_a_poser=0`).get().n;
  if (actifs <= 1 && u.active && !u.mfa_a_poser)
    return { error: 'dernier compte utilisable : le supprimer fermerait SYNAPSE à tout le monde', status: 409 };
  A.fermeTout(db, u.name);
  db.prepare(`DELETE FROM auth_passkeys WHERE user=?`).run(u.name);
  db.prepare(`DELETE FROM auth_users WHERE name=?`).run(u.name);
  return { ok: true };
}

/* Le titulaire pose son second facteur. Le code est vérifié AVANT
   d'écrire : un secret scanné de travers laisserait un compte que plus
   personne ne peut ouvrir. */
function poseMfa(db, nom, secret, code) {
  const u = ligne(db, nom);
  if (!u || !u.mfa_a_poser) return { error: 'aucun second facteur à poser pour ce compte' };
  if (invitationExpiree(u)) return { error: 'invitation expirée : demande un nouveau mot de passe à l’administrateur' };
  if (!/^[A-Z2-7]{16,}$/.test(String(secret || ''))) return { error: 'secret invalide' };
  if (!A.verifieTotp(secret, code)) return { error: 'code du second facteur incorrect : rescanne et réessaie' };
  db.prepare(`UPDATE auth_users SET totp=?, mfa_a_poser=0, mfa_depuis=NULL WHERE name=?`).run(secret, u.name);
  const codes = A.activeUser(db, u.name);
  return { ok: true, name: u.name, codes };
}

module.exports = {
  migrate, liste, cree, motDePasse, supprime, poseMfa,
  enAttente, mfaAPoser, invitationExpiree, fondateur, ligne,
  DELAI_MFA_MS, ROLE,
};
