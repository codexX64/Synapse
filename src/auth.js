'use strict';
/* ============================================================
   Authentification humaine — mot de passe + second facteur.

   Jusqu'ici l'interface recevait un jeton `ui_` injecté dans son
   HTML : quiconque ouvrait l'URL lisait toute la mémoire. Une
   session nominative remplace ça.

   Les jetons machine (svc_, trg_, ai_) restent : ils servent aux
   services, qui n'ont pas de navigateur. Ce module ne concerne
   que les humains.

   Zéro dépendance, donc trois choix expliqués :

   1. scrypt et non Argon2id. Le manuel exige Argon2id 32 MiB /
      3 passes ; aucune implémentation n'existe sans module natif.
      scrypt avec N=32768, r=8, p=1 consomme exactement 32 MiB et
      coûte ~330 ms — même ordre de résistance au matériel dédié,
      et c'est du crypto natif audité plutôt qu'une réimplémentation
      maison d'Argon2 qui serait bien pire.

   2. TOTP écrit ici (RFC 6238, ~30 lignes de HMAC-SHA1 natif).

   3. WebAuthn ES256 : décodeur CBOR minimal, vérification par
      crypto.verify. Couvre Touch ID, Face ID, Windows Hello et
      les clés physiques.
   ============================================================ */

const crypto = require('node:crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_MS   = 12 * 3600 * 1000;   /* 12 h */
const STEPUP_MS    = 5 * 60 * 1000;      /* 5 min après une élévation */
const MAX_ESSAIS   = 5;
const FENETRE_MS   = 15 * 60 * 1000;

/* ---------- schéma ---------- */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      name       TEXT PRIMARY KEY,
      pass       TEXT NOT NULL,          -- scrypt : sel:hash, en hexadécimal
      totp       TEXT,                   -- secret base32, NULL si non utilisé
      backup     TEXT,                   -- codes de secours, hachés
      active     INTEGER NOT NULL DEFAULT 0,
      init       INTEGER NOT NULL DEFAULT 0,   -- 1 = compte temporaire, a remplacer
      created_at TEXT NOT NULL,
      last_seen  TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      sid        TEXT PRIMARY KEY,
      user       TEXT NOT NULL REFERENCES auth_users(name) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      stepup_at  TEXT,
      ip         TEXT,
      agent      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sess_user ON auth_sessions(user);
    CREATE TABLE IF NOT EXISTS auth_passkeys (
      id         TEXT PRIMARY KEY,       -- credentialId, base64url
      user       TEXT NOT NULL REFERENCES auth_users(name) ON DELETE CASCADE,
      pubkey     TEXT NOT NULL,          -- SPKI DER, base64
      counter    INTEGER NOT NULL DEFAULT 0,
      label      TEXT,
      created_at TEXT NOT NULL,
      last_used  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pk_user ON auth_passkeys(user);
    /* Défis à usage unique : sans eux, une signature capturée pourrait
       être rejouée indéfiniment. */
    CREATE TABLE IF NOT EXISTS auth_defis (
      defi       TEXT PRIMARY KEY,
      user       TEXT,
      usage      TEXT NOT NULL,          -- inscription | connexion
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_essais (
      cle   TEXT PRIMARY KEY,            -- utilisateur ou adresse
      n     INTEGER NOT NULL DEFAULT 0,
      debut TEXT NOT NULL
    );
  `);
}

/* ---------- mot de passe ---------- */
function hachePass(clair) {
  const sel = crypto.randomBytes(16);
  const h = crypto.scryptSync(clair, sel, 32, SCRYPT);
  return sel.toString('hex') + ':' + h.toString('hex');
}

function verifiePass(clair, stocke) {
  try {
    const [selHex, hHex] = String(stocke).split(':');
    if (!selHex || !hHex) return false;
    const attendu = Buffer.from(hHex, 'hex');
    const calcule = crypto.scryptSync(clair, Buffer.from(selHex, 'hex'),
                                      attendu.length, SCRYPT);
    return crypto.timingSafeEqual(attendu, calcule);
  } catch { return false; }
}

/* ---------- TOTP, RFC 6238 ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function secretTotp() {
  const b = crypto.randomBytes(20);
  let bits = '';
  for (const o of b) bits += o.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function b32vers(secret) {
  let bits = '';
  for (const c of String(secret).toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
}

function codeTotp(secret, t = Date.now()) {
  const ctr = Buffer.alloc(8);
  ctr.writeUInt32BE(Math.floor(t / 30000), 4);
  const h = crypto.createHmac('sha1', b32vers(secret)).update(ctr).digest();
  const o = h[19] & 0x0f;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/* Une fenêtre de ±1 pas absorbe une horloge légèrement décalée. Plus
   large ouvrirait la porte au rejeu d'un code déjà vu. */
function verifieTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || '').trim())) return false;
  const c = String(code).trim(), now = Date.now();
  for (const d of [-1, 0, 1]) {
    const a = Buffer.from(codeTotp(secret, now + d * 30000));
    if (crypto.timingSafeEqual(a, Buffer.from(c))) return true;
  }
  return false;
}

function urlOtpauth(user, secret, emetteur = 'SYNAPSE') {
  return `otpauth://totp/${encodeURIComponent(emetteur)}:${encodeURIComponent(user)}`
       + `?secret=${secret}&issuer=${encodeURIComponent(emetteur)}&digits=6&period=30`;
}

/* ---------- CBOR, sous-ensemble WebAuthn ----------
   L'attestation d'une clé d'accès est du CBOR. On n'a besoin que des
   entiers, chaînes, octets, tableaux et maps — pas de la norme entière. */
function cbor(buf, i = 0) {
  const t = buf[i] >> 5, v = buf[i] & 0x1f;
  let j = i + 1, n = v;
  if (v === 24) { n = buf[j]; j += 1; }
  else if (v === 25) { n = buf.readUInt16BE(j); j += 2; }
  else if (v === 26) { n = buf.readUInt32BE(j); j += 4; }
  else if (v === 27) { n = Number(buf.readBigUInt64BE(j)); j += 8; }

  switch (t) {
    case 0: return [n, j];
    case 1: return [-1 - n, j];
    case 2: return [buf.subarray(j, j + n), j + n];
    case 3: return [buf.subarray(j, j + n).toString('utf8'), j + n];
    case 4: {
      const a = [];
      for (let k = 0; k < n; k++) { const [x, nj] = cbor(buf, j); a.push(x); j = nj; }
      return [a, j];
    }
    case 5: {
      const m = new Map();
      for (let k = 0; k < n; k++) {
        const [cle, j1] = cbor(buf, j);
        const [val, j2] = cbor(buf, j1);
        m.set(cle, val); j = j2;
      }
      return [m, j];
    }
    case 7:
      if (v === 20) return [false, j];
      if (v === 21) return [true, j];
      if (v === 22) return [null, j];
      return [undefined, j];
    default:
      throw new Error('CBOR : type ' + t + ' non géré');
  }
}

/* Une clé COSE ES256 (x, y sur P-256) vers un SPKI DER, seul format
   que crypto.createPublicKey accepte. Le préfixe est constant pour
   prime256v1 : on le colle devant le point non compressé. */
const SPKI_P256 = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function coseVersSpki(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty !== 2 || alg !== -7) throw new Error('seul ES256 (P-256) est accepté');
  const x = cose.get(-2), y = cose.get(-3);
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('coordonnées invalides');
  return Buffer.concat([SPKI_P256, Buffer.from([0x04]), x, y]);
}

/* ---------- authenticatorData : offsets fixes ---------- */
function litAuthData(ad) {
  const flags = ad[32];
  const out = {
    rpIdHash: ad.subarray(0, 32),
    up: !!(flags & 0x01),          /* présence de l'utilisateur */
    uv: !!(flags & 0x04),          /* vérification : biométrie ou code */
    at: !!(flags & 0x40),          /* données d'attestation présentes */
    counter: ad.readUInt32BE(33)
  };
  if (out.at) {
    const lg = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + lg);
    out.cose = cbor(ad, 55 + lg)[0];
  }
  return out;
}

const b64url = b => Buffer.from(b).toString('base64url');

/* ---------- défis ---------- */
function nouveauDefi(db, usage, user = null) {
  const d = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO auth_defis(defi,user,usage,expires_at) VALUES(?,?,?,?)`)
    .run(d, user, usage, new Date(Date.now() + 5 * 60000).toISOString());
  db.prepare(`DELETE FROM auth_defis WHERE expires_at < ?`).run(new Date().toISOString());
  return d;
}

/* Un défi est consommé à la première utilisation : c'est ce qui rend
   le rejeu d'une signature impossible. */
function consommeDefi(db, defi, usage) {
  const r = db.prepare(
    `SELECT user FROM auth_defis WHERE defi=? AND usage=? AND expires_at > ?`)
    .get(defi, usage, new Date().toISOString());
  if (r) db.prepare(`DELETE FROM auth_defis WHERE defi=?`).run(defi);
  return r || null;
}

/* ---------- inscription d'une clé d'accès ---------- */
function debutInscriptionPasskey(db, user) {
  return {
    challenge: nouveauDefi(db, 'inscription', user),
    rp: { name: 'SYNAPSE' },
    user: { id: b64url(user), name: user, displayName: user },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    timeout: 120000,
    attestation: 'none'
  };
}

function finInscriptionPasskey(db, user, rep, origine) {
  const cd = JSON.parse(Buffer.from(rep.clientDataJSON, 'base64url').toString('utf8'));
  if (cd.type !== 'webauthn.create') return { ok: false, error: 'type de défi inattendu' };
  if (!consommeDefi(db, cd.challenge, 'inscription')) return { ok: false, error: 'défi inconnu ou expiré' };
  if (origine && cd.origin !== origine) return { ok: false, error: 'origine refusée' };

  const att = cbor(Buffer.from(rep.attestationObject, 'base64url'))[0];
  const ad = litAuthData(att.get('authData'));
  if (!ad.at || !ad.credId) return { ok: false, error: 'attestation sans identifiant' };

  let spki;
  try { spki = coseVersSpki(ad.cose); }
  catch (e) { return { ok: false, error: e.message }; }

  const id = b64url(ad.credId);
  db.prepare(`INSERT OR REPLACE INTO auth_passkeys(id,user,pubkey,counter,label,created_at)
              VALUES(?,?,?,?,?,?)`)
    .run(id, user, spki.toString('base64'), ad.counter,
         String(rep.label || 'clé d\u2019accès').slice(0, 60), new Date().toISOString());
  return { ok: true, id };
}

/* ---------- connexion par clé d'accès ---------- */
function debutConnexionPasskey(db, user) {
  const cles = db.prepare(`SELECT id FROM auth_passkeys WHERE user=?`).all(user || '');
  return {
    challenge: nouveauDefi(db, 'connexion', user || null),
    allowCredentials: cles.map(c => ({ type: 'public-key', id: c.id })),
    userVerification: 'preferred',
    timeout: 120000
  };
}

function finConnexionPasskey(db, rep, origine) {
  const cd = JSON.parse(Buffer.from(rep.clientDataJSON, 'base64url').toString('utf8'));
  if (cd.type !== 'webauthn.get') return { ok: false, error: 'type de défi inattendu' };
  if (!consommeDefi(db, cd.challenge, 'connexion')) return { ok: false, error: 'défi inconnu ou expiré' };
  if (origine && cd.origin !== origine) return { ok: false, error: 'origine refusée' };

  const pk = db.prepare(`SELECT * FROM auth_passkeys WHERE id=?`).get(rep.id);
  if (!pk) return { ok: false, error: 'clé inconnue' };

  const ad = Buffer.from(rep.authenticatorData, 'base64url');
  const signe = Buffer.concat([
    ad, crypto.createHash('sha256').update(Buffer.from(rep.clientDataJSON, 'base64url')).digest()
  ]);
  const cle = crypto.createPublicKey({
    key: Buffer.from(pk.pubkey, 'base64'), format: 'der', type: 'spki'
  });
  const bon = crypto.verify('sha256', signe, { key: cle, dsaEncoding: 'der' },
                            Buffer.from(rep.signature, 'base64url'));
  if (!bon) return { ok: false, error: 'signature invalide' };

  /* Un compteur qui recule trahit une clé clonée. Certaines clés le
     laissent à zéro : dans ce cas seulement, on ne vérifie pas. */
  const info = litAuthData(ad);
  if (pk.counter > 0 && info.counter > 0 && info.counter <= pk.counter)
    return { ok: false, error: 'compteur incohérent : clé possiblement clonée' };
  db.prepare(`UPDATE auth_passkeys SET counter=?, last_used=? WHERE id=?`)
    .run(info.counter, new Date().toISOString(), pk.id);

  return { ok: true, user: pk.user, uv: info.uv };
}

/* ---------- limitation des tentatives ---------- */
function trop(db, cle) {
  const now = Date.now();
  const r = db.prepare(`SELECT n, debut FROM auth_essais WHERE cle=?`).get(cle);
  if (!r) return false;
  if (now - new Date(r.debut).getTime() > FENETRE_MS) {
    db.prepare(`DELETE FROM auth_essais WHERE cle=?`).run(cle);
    return false;
  }
  return r.n >= MAX_ESSAIS;
}
function rate(db, cle) {
  db.prepare(`INSERT INTO auth_essais(cle,n,debut) VALUES(?,1,?)
              ON CONFLICT(cle) DO UPDATE SET n=n+1`).run(cle, new Date().toISOString());
}
function oublie(db, cle) { db.prepare(`DELETE FROM auth_essais WHERE cle=?`).run(cle); }

/* ---------- premier demarrage ----------
   Sans aucun compte, on en cree un temporaire : admin / Temp1234.
   Il ne donne acces a RIEN d'autre qu'a la page d'initialisation, qui
   exige un nouvel identifiant, un mot de passe de 12 caracteres, un
   second facteur verifie, et supprime ce compte a la fin. Il n'existe
   donc que le temps d'une premiere connexion. */
const INIT_USER = 'admin';
const INIT_PASS = 'Temp1234';

function assureInitial(db) {
  const n = db.prepare(`SELECT count(*) n FROM auth_users`).get().n;
  if (n > 0) return false;
  try {
    db.prepare(`ALTER TABLE auth_users ADD COLUMN init INTEGER NOT NULL DEFAULT 0`).run();
  } catch {}
  db.prepare(`INSERT INTO auth_users(name,pass,totp,active,init,created_at)
              VALUES(?,?,NULL,1,1,?)`)
    .run(INIT_USER, hachePass(INIT_PASS), new Date().toISOString());
  return true;
}

function estInit(db, name) {
  const u = db.prepare(`SELECT init FROM auth_users WHERE name=?`).get(name);
  return !!(u && u.init);
}

/* Remplace le compte temporaire par le compte definitif. Le TOTP est
   verifie AVANT d'ecrire : un secret scanne de travers laisserait un
   compte sans second facteur utilisable. */
function finaliseInitial(db, { nouveauNom, nouveauPass, totpSecret, totpCode }) {
  if (!/^[a-z0-9._-]{3,32}$/i.test(nouveauNom || '')) return { error: 'identifiant : 3 a 32 caracteres simples' };
  if (String(nouveauPass || '').length < 12) return { error: 'mot de passe : 12 caracteres au minimum' };
  if (nouveauNom === INIT_USER && nouveauPass === INIT_PASS) return { error: 'choisis un autre identifiant et mot de passe' };
  if (!verifieTotp(totpSecret, totpCode)) return { error: 'code du second facteur incorrect : rescanne et reessaie' };

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM auth_users WHERE init=1`).run();
    db.prepare(`INSERT INTO auth_users(name,pass,totp,active,init,created_at)
                VALUES(?,?,?,1,0,?)`)
      .run(nouveauNom, hachePass(nouveauPass), totpSecret, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: /UNIQUE/.test(String(e)) ? 'cet identifiant existe deja' : 'echec' };
  }
  const codes = activeUser(db, nouveauNom);
  return { ok: true, name: nouveauNom, codes };
}

/* ---------- comptes ---------- */
/* « Installe » = un vrai compte existe. Le compte temporaire ne compte pas :
   c'est lui que la page de connexion doit proposer tant qu'il est la. */
function installe(db) {
  return db.prepare(`SELECT count(*) n FROM auth_users WHERE active=1 AND init=0`).get().n > 0;
}

function creeUser(db, name, pass) {
  if (!/^[a-z0-9._-]{3,32}$/i.test(name || '')) return { error: 'nom : 3 à 32 caractères simples' };
  if (String(pass || '').length < 12) return { error: 'mot de passe : 12 caractères au minimum' };
  const totp = secretTotp();
  try {
    db.prepare(`INSERT INTO auth_users(name,pass,totp,active,created_at) VALUES(?,?,?,0,?)`)
      .run(name, hachePass(pass), totp, new Date().toISOString());
  } catch { return { error: 'ce compte existe déjà' }; }
  return { name, totp, otpauth: urlOtpauth(name, totp) };
}

/* Les codes de secours sont hachés : perdus, ils ne sont pas
   retrouvables — seulement remplaçables. */
function activeUser(db, name) {
  const codes = Array.from({ length: 8 },
    () => crypto.randomBytes(5).toString('hex').toUpperCase());
  const haches = codes.map(c => crypto.createHash('sha256').update(c).digest('hex'));
  db.prepare(`UPDATE auth_users SET active=1, backup=? WHERE name=?`)
    .run(JSON.stringify(haches), name);
  return codes;
}

function verifieBackup(db, name, code) {
  const u = db.prepare(`SELECT backup FROM auth_users WHERE name=?`).get(name);
  if (!u || !u.backup) return false;
  const h = crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
  const liste = JSON.parse(u.backup);
  const i = liste.indexOf(h);
  if (i < 0) return false;
  liste.splice(i, 1);                     /* à usage unique */
  db.prepare(`UPDATE auth_users SET backup=? WHERE name=?`).run(JSON.stringify(liste), name);
  return true;
}

/* ---------- sessions ---------- */
function ouvre(db, user, ip, agent) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(`INSERT INTO auth_sessions(sid,user,created_at,expires_at,ip,agent)
              VALUES(?,?,?,?,?,?)`)
    .run(sid, user, new Date(now).toISOString(),
         new Date(now + SESSION_MS).toISOString(),
         String(ip || '').slice(0, 45), String(agent || '').slice(0, 200));
  db.prepare(`UPDATE auth_users SET last_seen=? WHERE name=?`)
    .run(new Date().toISOString(), user);
  return sid;
}

function session(db, sid) {
  if (!sid) return null;
  const s = db.prepare(`SELECT * FROM auth_sessions WHERE sid=?`).get(sid);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM auth_sessions WHERE sid=?`).run(sid);
    return null;
  }
  return s;
}

function ferme(db, sid) { db.prepare(`DELETE FROM auth_sessions WHERE sid=?`).run(sid); }
function fermeTout(db, user) { db.prepare(`DELETE FROM auth_sessions WHERE user=?`).run(user); }

function eleve(db, sid) {
  db.prepare(`UPDATE auth_sessions SET stepup_at=? WHERE sid=?`)
    .run(new Date().toISOString(), sid);
}
function aStepUp(db, sid) {
  const s = db.prepare(`SELECT stepup_at FROM auth_sessions WHERE sid=?`).get(sid);
  return !!(s && s.stepup_at && Date.now() - new Date(s.stepup_at).getTime() < STEPUP_MS);
}

function purge(db) {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(now);
  db.prepare(`DELETE FROM auth_defis WHERE expires_at < ?`).run(now);
}

module.exports = {
  migrate, installe, creeUser, activeUser, verifieBackup,
  assureInitial, estInit, finaliseInitial, INIT_USER,
  hachePass, verifiePass,
  secretTotp, codeTotp, verifieTotp, urlOtpauth,
  debutInscriptionPasskey, finInscriptionPasskey,
  debutConnexionPasskey, finConnexionPasskey,
  ouvre, session, ferme, fermeTout, eleve, aStepUp, purge,
  trop, rate, oublie,
  SESSION_MS, STEPUP_MS, MAX_ESSAIS
};
