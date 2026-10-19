// SYNAPSE de bout en bout : comptes humains par le socle, reprise des comptes
// de la 1.x, jetons de service, en-têtes, pages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lancer, service, JETON_INSTALLATION, JETON_HUB, JETON_ADMIN_HUB } from './instance.mjs';
import { Client, connexion } from '../socle/essai/client.js';
import { adminComplet, membreInvite, codeTotp, MDP_ESSAI } from '../socle/essai/inscription.js';
import { Authentificateur } from '../socle/essai/authentificateur.js';
import { createRequire } from 'node:module';
const { open: ouvrirBase } = createRequire(import.meta.url)('../src/db.js');

const instances = [];
after(async () => { for (const i of instances) await i.arreter(); });
const demarrer = async o => { const i = await lancer(o); instances.push(i); return i; };

const inst = await demarrer();
const admin = new Client(inst.port);
const { secret: secretAdmin, auth: cleAdmin } = await adminComplet(admin, { jeton: JETON_INSTALLATION });
const hub = service(inst, JETON_HUB);
// Renfort d'un administrateur par sa clé d'accès.
async function renforcer(c, cle = cleAdmin) {
  const o = await c.post('/api/compte/renfort/options');
  const r = await c.post('/api/compte/renfort', { methode: 'cle', reponse: cle.signer(o.json, c.origine) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('premier démarrage : aucun compte par défaut, le premier se crée avec le jeton d\'installation', async () => {
  const neuve = await demarrer();
  const c = new Client(neuve.port);
  assert.equal((await c.get('/api/compte/etat')).json.installe, false);
  for (const [identifiant, motDePasse] of [['admin', 'Temp1234'], ['admin', 'Temp1234Temp1234']]) {
    const r = await connexion(c, identifiant, motDePasse);
    assert.notEqual(r.status, 200, 'aucun compte temporaire');
  }
  assert.equal((await c.post('/api/compte/installation', { jeton: 'jeton-faux-'.padEnd(40, 'z'), identifiant: 'eve', motDePasse: MDP_ESSAI })).status, 403);
  assert.equal((await c.get('/v1/stats')).status, 401);
  const r = await fetch(neuve.url('/'), { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/connexion');
});

test('session humaine : lecture permise, écriture sous jeton anti-CSRF et rôle, réglages sous renfort', async () => {
  assert.equal((await admin.get('/v1/search?q=test')).status, 200);
  assert.equal((await admin.get('/v1/moi')).status, 200);
  const sansCsrf = await admin.put('/v1/moi/trait', { cle: 'langue', valeur: 'français' }, { sansCsrf: true });
  assert.equal(sansCsrf.status, 403, 'écriture sans jeton anti-CSRF refusée');
  const autreSite = await admin.put('/v1/moi/trait', { cle: 'langue', valeur: 'français' }, { origine: 'https://ailleurs.example' });
  assert.equal(autreSite.status, 403, 'écriture depuis un autre site refusée');
  assert.equal((await admin.put('/v1/moi/trait', { cle: 'langue', valeur: 'français' })).status, 200);
  // Une session humaine n'écrit pas dans la mémoire : c'est l'affaire des services.
  assert.equal((await admin.post('/v1/ingest', { title: 'note', body: 'texte' })).status, 403);
  // Le jeton Telegram : administrateur et renfort ; scellé dans la base.
  const { client: membre } = await membreInvite(admin, () => new Client(inst.port), { identifiant: 'bruno' });
  assert.equal((await membre.post('/v1/rangement/config', { telegram_chat: '-100123' })).status, 403, 'un membre ne règle pas Telegram');
  const lecteur = (await membreInvite(admin, () => new Client(inst.port), { identifiant: 'carla', role: 'lecture' })).client;
  assert.equal((await lecteur.put('/v1/moi/trait', { cle: 'x', valeur: 'valeur' })).status, 403, 'la lecture ne corrige pas la fiche');
  assert.equal((await lecteur.get('/v1/moi')).status, 200);
  const jetonTg = '123456789:' + 'A'.repeat(35);
  // Une connexion vaut renfort cinq minutes : on vieillit celui de la session.
  const a2 = new Client(inst.port);
  await connexion(a2, 'ana', MDP_ESSAI);
  await a2.post('/api/compte/connexion/totp', { code: codeTotp(secretAdmin, Date.now(), 1) });
  const vieillir = new DatabaseSync(inst.db);
  vieillir.prepare("UPDATE socle_sessions SET renfort = 0 WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')").run();
  vieillir.close();
  const sansRenfort = await a2.post('/v1/rangement/config', { telegram_token: jetonTg, telegram_chat: '-100123' });
  assert.equal(sansRenfort.status, 403);
  assert.equal(sansRenfort.json.details?.renfort, true, 'renfort demandé');
  assert.deepEqual(sansRenfort.json.details.methodes, ['cle'], 'un administrateur confirme par sa clé d\'accès');
  const orf = await a2.post('/api/compte/renfort/options');
  const rf = await a2.post('/api/compte/renfort', { methode: 'cle', reponse: cleAdmin.signer(orf.json, a2.origine) });
  assert.equal(rf.status, 200, JSON.stringify(rf.json) + JSON.stringify(sansRenfort.json));
  const inventé = await a2.post('/v1/rangement/config', { telegram_token: jetonTg, telegram_chat: '-100123', inconnu: 'champ inventé' });
  assert.equal(inventé.status, 400, 'un champ inventé est refusé, rien n\'est écrit');
  const ok = await a2.post('/v1/rangement/config', { telegram_token: jetonTg, telegram_chat: '-100123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.config.telegram_token, '…' + jetonTg.slice(-4));
  assert.equal(ok.json.config.inconnu, undefined);
  assert.equal((await a2.post('/v1/rangement/config', { telegram_token: 'pas-un-jeton' })).status, 400);
  const db = new DatabaseSync(inst.db, { readOnly: true });
  const brut = db.prepare("SELECT v FROM meta WHERE k = 'rangement'").get().v;
  db.close();
  assert.ok(!brut.includes(jetonTg), 'jeton scellé au repos');
  assert.match(JSON.parse(brut).telegram_token, /^v1\./);
  const journal = (await admin.get('/api/compte/admin/journal')).json;
  assert.ok(journal.lignes.some(l => l.action === 'reglages.rangement'), 'le réglage est au journal');
});

test('jetons de service : un jeton refusé ne retombe pas sur la session, il est compté et journalisé', async () => {
  assert.equal((await hub.get('/v1/stats')).status, 200);
  const faux = service(inst, 'jeton-invente-' + 'z'.repeat(20));
  assert.equal((await faux.get('/v1/stats')).status, 401);
  // Même avec un cookie de session valide, un jeton présenté et faux est refusé.
  const cookie = [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  assert.equal((await faux.req('GET', '/v1/stats', undefined, { cookie })).status, 401);
  let dernier = 0;
  for (let i = 0; i < 25; i++) dernier = (await faux.get('/v1/stats')).status;
  assert.equal(dernier, 429, 'trop de jetons refusés : coupé une minute');
  const journal = (await admin.get('/api/compte/admin/journal')).json;
  assert.ok(journal.lignes.some(l => l.action === 'jeton.refuse'), 'refus au journal');
});

test('en-têtes de sécurité et pages servies par le socle', async () => {
  const r = await fetch(inst.url('/connexion'));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-[^']+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const html = await r.text();
  assert.ok(!html.includes('__NONCE__') && html.includes('nonce="'), 'nonce posé dans la page');
  for (const p of ['/login', '/setup', '/login.html', '/index.html', '/parametres.html']) assert.equal((await fetch(inst.url(p), { redirect: 'manual' })).status, 404, p);
  assert.equal((await fetch(inst.url('/v/0/vendor/three.min.js'))).status, 200, 'three.js servi ici, pas par un CDN');
  // La page de la mémoire, à une session complète.
  const cookie = [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const page = await fetch(inst.url('/'), { headers: { cookie } });
  assert.equal(page.status, 200);
  const corps = await page.text();
  assert.ok(!/cdnjs|googleapis|gstatic/.test(corps), 'aucune ressource tierce');
  assert.equal((await fetch(inst.url('/.well-known/security.txt'))).status, 200);
  const notice = await fetch(inst.url('/confidentialite.txt'));
  assert.equal(notice.status, 200);
  assert.match(await notice.text(), /Questions posées[\s\S]*trente jours/);
  const cors = await demarrer({ env: { CORS_ORIGIN: 'https://hub.example' } });
  const rc = await fetch(cors.url('/healthz'));
  assert.equal(rc.headers.get('access-control-allow-origin'), 'https://hub.example');
  assert.equal(rc.headers.get('access-control-allow-credentials'), null, 'jamais les cookies d\'une autre origine');
});

test('données d\'un compte : ses questions exportées à sa demande, effacées avec lui', async () => {
  await renforcer(admin);
  const { client: dora } = await membreInvite(admin, () => new Client(inst.port), { identifiant: 'dora' });
  await dora.get('/v1/search?q=question+de+dora');
  const exp = await dora.get('/api/compte/export');
  if (exp.status === 403) await dora.post('/api/compte/renfort', { methode: 'motdepasse', motDePasse: MDP_ESSAI + ' dora' });
  const e = (await dora.get('/api/compte/export')).json;
  assert.ok(e.synapse.requetes.some(q => q.q === 'question de dora'), 'la question est exportée');
  const db = () => new DatabaseSync(inst.db, { readOnly: true });
  const avant = db(); const n = avant.prepare("SELECT count(*) n FROM requetes WHERE q = 'question de dora'").get().n; avant.close();
  assert.equal(n, 1);
  const sup = await dora.post('/api/compte/supprimer', { identifiant: 'dora' });
  assert.equal(sup.status, 200, JSON.stringify(sup.json));
  const apres = db(); const m = apres.prepare("SELECT count(*) n FROM requetes WHERE q = 'question de dora'").get().n; apres.close();
  assert.equal(m, 0, 'effacée avec le compte');
});

test('reprise des comptes de SYNAPSE 1.x : mot de passe, second facteur et clé d\'accès gardés, compte temporaire écarté', async () => {
  const auth = new Authentificateur();
  auth.handle = Buffer.from('alice').toString('base64url');
  const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const sel = crypto.randomBytes(16);
  const empreinte = sel.toString('hex') + ':' + crypto.scryptSync('ancien mot de passe d\'alice', sel, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 }).toString('hex');
  const ancienJetonAdmin = 'ancien-jeton-admin-du-hub-' + 'w'.repeat(20);
  const ancienne = await demarrer({ preparer: f => {
    const base = ouvrirBase(f);
    base.prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at) VALUES('hub-admin',?,'admin','A','2026-01-01T00:00:00Z')`)
      .run(crypto.createHash('sha256').update(ancienJetonAdmin).digest('hex'));
    base.close();
    const db = new DatabaseSync(f);
    db.exec(`CREATE TABLE auth_users (name TEXT PRIMARY KEY, pass TEXT NOT NULL, totp TEXT, backup TEXT, active INTEGER NOT NULL DEFAULT 0,
               init INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_seen TEXT, mfa_a_poser INTEGER NOT NULL DEFAULT 0, mfa_depuis TEXT);
             CREATE TABLE auth_sessions (sid TEXT PRIMARY KEY, user TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, stepup_at TEXT, ip TEXT, agent TEXT);
             CREATE TABLE auth_passkeys (id TEXT PRIMARY KEY, user TEXT NOT NULL, pubkey TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, label TEXT, created_at TEXT NOT NULL, last_used TEXT);`);
    db.prepare(`INSERT INTO auth_users(name,pass,totp,active,init,created_at) VALUES('admin',?,NULL,1,1,'2026-01-01T00:00:00Z')`).run(empreinte);
    db.prepare(`INSERT INTO auth_users(name,pass,totp,active,init,created_at) VALUES('alice',?,?,1,0,'2026-02-01T00:00:00Z')`).run(empreinte, totpSecret);
    db.prepare(`INSERT INTO auth_sessions VALUES('vieille-session','alice','2026-02-01T00:00:00Z','2099-01-01T00:00:00Z',NULL,NULL,NULL)`).run();
    db.prepare(`INSERT INTO auth_passkeys(id,user,pubkey,counter,label,created_at) VALUES(?,?,?,0,'MacBook','2026-02-02T00:00:00Z')`)
      .run(auth.credId.toString('base64url'), 'alice', auth.publique.export({ type: 'spki', format: 'der' }).toString('base64'));
    db.close();
  } });
  assert.equal((await service(ancienne, ancienJetonAdmin).get('/v1/export')).status, 401, 'la source admin « hub-admin » de la 1.x est retirée');
  const c = new Client(ancienne.port);
  assert.equal((await c.get('/api/compte/etat')).json.installe, true, 'le compte repris suffit : pas d\'installation');
  assert.notEqual((await connexion(c, 'admin', 'ancien mot de passe d\'alice')).status, 200, 'le compte temporaire n\'est pas repris');
  const r = await connexion(c, 'alice', 'ancien mot de passe d\'alice');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.niveau, 'partiel', 'le mot de passe seul n\'ouvre pas');
  const t = await c.post('/api/compte/connexion/totp', { code: codeTotp(totpSecret) });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  // Par la clé d'accès de la 1.x, enregistrée sous le nom du compte.
  const k = new Client(ancienne.port);
  const o = await k.post('/api/compte/connexion/cle/options');
  const cle = await k.post('/api/compte/connexion/cle', { reponse: auth.signer(o.json, k.origine) });
  assert.equal(cle.status, 200, JSON.stringify(cle.json));
  const db = new DatabaseSync(ancienne.db, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'auth_%'").get().n, 0, 'anciennes tables retirées');
  const ligne = db.prepare("SELECT mdp, totp FROM socle_comptes WHERE identifiant = 'alice'").get();
  db.close();
  assert.match(ligne.mdp, /^\$argon2id\$/, 'empreinte passée en Argon2id à la connexion');
  assert.ok(!ligne.totp.includes(totpSecret), 'secret TOTP scellé');
});

test('schémas : champ ou paramètre inconnu, type faux, paramètre répété → 400 ; un inconnu n\'apprend rien des routes', async () => {
  const inst = await demarrer(), hub = service(inst, JETON_HUB);
  assert.equal((await fetch(inst.url('/v1/search?q=x&inventé=1'))).status, 401, 'pas authentifié : 401, pas 400');
  assert.equal((await hub.get('/v1/search?q=x&inventé=1')).status, 400);
  assert.equal((await hub.get('/v1/search?q=x&q=y')).status, 400);
  assert.equal((await hub.get('/v1/search?q=x&limit=beaucoup')).status, 400);
  assert.equal((await hub.get('/v1/search?q=x&limit=5')).status, 200);
  assert.equal((await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 't', body: 'b', role: 'admin' })).status, 400);
  assert.equal((await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 't', body: 42 })).status, 400);
  assert.equal((await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 't', body: 'b', __proto__: { x: 1 }, meta: JSON.parse('{"__proto__":{"x":1}}') })).status, 400);
  assert.equal((await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 't', body: 'b' })).status, 202);
  // Le client fourni (client/) envoie son empreinte : admise, le serveur calcule la sienne.
  const evt = { source: 'hub', kind: 'note', ref: null, title: 'client fourni', body: 'b', tags: [], occurred_at: new Date().toISOString(), meta: {}, hash: 'a'.repeat(64) };
  assert.equal((await hub.post('/v1/ingest/batch', { events: [evt] })).json.results[0].ok, true);
});

test('corps : JSON exigé pour écrire, taille annoncée trop grande refusée en 413 avant lecture, limite par route', async () => {
  const inst = await demarrer(), hub = service(inst, JETON_HUB);
  const brut = (chemin, corps, entetes) => fetch(inst.url(chemin), { method: 'POST', headers: { authorization: `Bearer ${JETON_HUB}`, ...entetes }, body: corps });
  assert.equal((await brut('/v1/link', '{"from_id":1,"to_id":2,"relation":"x"}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await brut('/v1/link', '{', { 'content-type': 'application/json' })).status, 400);
  const gros = JSON.stringify({ q: 'x'.repeat(70 * 1024) });
  assert.equal((await brut('/v1/click', gros, { 'content-type': 'application/json' })).status, 413, '64 Kio par défaut');
  const doc = 'mot '.repeat(120_000);
  assert.equal((await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 'long document', body: doc })).status, 202, 'un document de 480 Kio entre par l\'ingestion');
});

test('méthodes : un chemin connu appelé par une autre méthode → 405 avec Allow ; un chemin inconnu → 404', async () => {
  const r = await hub.req('PATCH', '/v1/neuron');
  assert.equal(r.status, 405);
  assert.equal(r.entetes.get('allow'), 'GET, DELETE');
  const { request } = await import('node:http');
  const trace = await new Promise((ok, ko) => request(inst.url('/v1/neuron'), { method: 'TRACE', headers: { authorization: `Bearer ${JETON_HUB}` } }, r => { r.resume(); ok(r.statusCode); }).on('error', ko).end());
  assert.equal(trace, 405, 'TRACE ne renvoie rien de la requête');
  assert.equal((await hub.get('/v1/debug')).status, 404);
});
