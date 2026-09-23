'use strict';
/* ============================================================
   CLI d'administration.

   Le jeton n'est affiché qu'UNE fois, à la création. Seul son hash
   est stocké : personne, pas même toi, ne peut le relire ensuite.
   C'est volontaire — un jeton relisible dans une base est un jeton
   qui finit dans un journal.
   ============================================================ */

const crypto = require('node:crypto');
const { open } = require('./db.js');

const DB_FILE = process.env.DB_FILE || '/data/synapse.db';
const db = open(DB_FILE);
const [, , cmd, ...rest] = process.argv;

function hash(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function arg(name, dflt) {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
}

function sourceAdd(name) {
  if (!name) die('nom de source requis');
  const scope = arg('scope', 'write');
  const channel = arg('channel', 'A');
  const prefix = scope === 'admin' ? 'adm'
               : scope === 'incidents' ? 'trg'
               : scope.includes('read') && scope.includes('write') ? 'ai'
               : scope === 'read' ? 'ui' : 'svc';
  const token = prefix + '_' + crypto.randomBytes(24).toString('base64url');
  try {
    db.prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at)
                VALUES(?,?,?,?,?)`).run(name, hash(token), scope, channel, new Date().toISOString());
  } catch (e) {
    die(/UNIQUE/.test(String(e)) ? `la source « ${name} » existe déjà` : String(e.message || e));
  }
  if (scope.includes('read') && !['shared'].includes(name)) {
    db.prepare(`INSERT OR IGNORE INTO namespaces(name,kind,owner,created_at) VALUES(?,?,?,?)`)
      .run('agent:' + name, 'agent', name, new Date().toISOString());
  }
  console.log(`source « ${name} » créée · portée ${scope} · canal ${channel}`);
  console.log('');
  console.log('  ' + token);
  console.log('');
  console.log('Ce jeton ne sera plus jamais affiché : seul son hash est stocké.');
}

function sourceRotate(name) {
  if (!name) die('nom de source requis');
  const row = db.prepare(`SELECT scope FROM sources WHERE name=?`).get(name);
  if (!row) die('source inconnue : ' + name);
  const prefix = row.scope === 'admin' ? 'adm'
    : row.scope === 'incidents' ? 'trg'
    : row.scope.includes('read') && row.scope.includes('write') ? 'ai'
    : row.scope === 'read' ? 'ui' : 'svc';
  const token = prefix + '_' + crypto.randomBytes(24).toString('base64url');
  db.prepare(`UPDATE sources SET token_hash=? WHERE name=?`).run(hash(token), name);
  console.log(`jeton de « ${name} » remplacé :\n\n  ${token}\n`);
  console.log("L'ancien ne fonctionne plus. Mets à jour le service avant son prochain envoi.");
}

function sourceList() {
  const rows = db.prepare(
    `SELECT name,scope,channel,enabled,last_seen,n_events FROM sources ORDER BY name`).all();
  if (!rows.length) return console.log('aucune source');
  console.log('source'.padEnd(18) + 'portée'.padEnd(13) + 'canal'.padEnd(7) +
              'événements'.padEnd(12) + 'dernier envoi');
  console.log('-'.repeat(74));
  for (const r of rows) {
    const age = r.last_seen
      ? Math.round((Date.now() - new Date(r.last_seen).getTime()) / 60000) + ' min'
      : 'jamais';
    console.log(r.name.padEnd(18) + r.scope.padEnd(13) + r.channel.padEnd(7) +
                String(r.n_events).padEnd(12) + age + (r.enabled ? '' : '  [désactivé]'));
  }
}

function stats() {
  const q = s => db.prepare(s).get();
  console.log('entrées      ', q(`SELECT count(*) n FROM entries WHERE archived=0`).n);
  console.log('liens        ', q(`SELECT count(*) n FROM links`).n);
  console.log('morceaux     ',
    q(`SELECT count(*) n FROM chunks WHERE embedded=1`).n + ' vectorisés · ' +
    q(`SELECT count(*) n FROM chunks WHERE embedded=0`).n + ' en attente · ' +
    q(`SELECT count(*) n FROM chunks WHERE embedded=-1`).n + ' exclus');
  const lv = db.prepare(`SELECT level,count(*) n FROM entries WHERE archived=0 GROUP BY level`).all();
  console.log('niveaux      ', lv.map(r => r.level + ':' + r.n).join(' · ') || '—');
  const fq = db.prepare(`SELECT query_norm,n FROM failed_queries ORDER BY n DESC LIMIT 8`).all();
  if (fq.length) {
    console.log('\nrequêtes sans résultat — ce que la mémoire ne contient pas :');
    for (const r of fq) console.log('  ' + String(r.n).padStart(4) + '  ' + r.query_norm);
  }
}

function promptSet(agent) {
  if (!agent) die('nom d\u2019agent requis');
  const body = require('node:fs').readFileSync(arg('file', '/dev/stdin'), 'utf8');
  const last = db.prepare(`SELECT MAX(version) v FROM prompts WHERE agent=?`).get(agent);
  const v = (last?.v || 0) + 1;
  db.prepare(`INSERT INTO prompts(agent,version,body,created_at) VALUES(?,?,?,?)`)
    .run(agent, v, body, new Date().toISOString());
  console.log(`prompt « ${agent} » enregistré en version ${v}`);
}

/* ---------- comptes humains ---------- */
const A = require('./auth.js');
A.migrate(db);

function userAdd(nom) {
  if (!nom) die('nom d\u2019utilisateur requis');
  const pass = arg('pass', '');
  if (!pass) die('mot de passe requis : --pass "<au moins 12 caracteres>"');
  const r = A.creeUser(db, nom, pass);
  if (r.error) die(r.error);
  const codes = A.activeUser(db, nom);
  console.log(`compte « ${nom} » cree et active.`);
  console.log('');
  console.log('  Second facteur — a scanner MAINTENANT dans ton application :');
  console.log('  ' + r.otpauth);
  console.log('');
  console.log('  Secret manuel : ' + r.totp);
  console.log('');
  console.log('  Codes de secours, a usage unique chacun :');
  console.log('  ' + codes.join('  '));
  console.log('');
  console.log('Ces valeurs ne seront plus jamais affichees : seuls les');
  console.log('hachages sont conserves. Note-les avant de fermer.');
}

function userList() {
  const rows = db.prepare(
    `SELECT name, active, created_at, last_seen,
            (SELECT count(*) FROM auth_passkeys p WHERE p.user = u.name) cles,
            (SELECT count(*) FROM auth_sessions s WHERE s.user = u.name) sessions
     FROM auth_users u ORDER BY name`).all();
  if (!rows.length) return console.log('aucun compte');
  console.log('compte'.padEnd(18) + 'etat'.padEnd(10) + 'cles'.padEnd(7)
              + 'sessions'.padEnd(11) + 'derniere connexion');
  console.log('-'.repeat(74));
  for (const r of rows) {
    const v = r.last_seen
      ? Math.round((Date.now() - new Date(r.last_seen).getTime()) / 60000) + ' min'
      : 'jamais';
    console.log(r.name.padEnd(18) + (r.active ? 'actif' : 'inactif').padEnd(10)
      + String(r.cles).padEnd(7) + String(r.sessions).padEnd(11) + v);
  }
}

function userPass(nom) {
  if (!nom) die('nom requis');
  const pass = arg('pass', '');
  if (!pass) die('--pass requis');
  if (pass.length < 12) die('mot de passe : 12 caracteres au minimum');
  const u = db.prepare(`SELECT name FROM auth_users WHERE name=?`).get(nom);
  if (!u) die('compte inconnu : ' + nom);
  db.prepare(`UPDATE auth_users SET pass=? WHERE name=?`).run(A.hachePass(pass), nom);
  /* Toutes les sessions tombent : un mot de passe change parce qu on le
     croit compromis ne doit pas laisser les sessions ouvertes derriere. */
  A.fermeTout(db, nom);
  console.log(`mot de passe de « ${nom} » remplace. Toutes ses sessions sont fermees.`);
}

function userDel(nom) {
  if (!nom) die('nom requis');
  const r = db.prepare(`DELETE FROM auth_users WHERE name=?`).run(nom);
  console.log(Number(r.changes) ? `compte « ${nom} » supprime` : 'compte inconnu');
}

function sessions() {
  const rows = db.prepare(
    `SELECT user, created_at, expires_at, ip, agent FROM auth_sessions
     ORDER BY created_at DESC`).all();
  if (!rows.length) return console.log('aucune session ouverte');
  for (const r of rows) {
    console.log(r.user.padEnd(16) + String(r.ip || '?').padEnd(18)
      + 'expire ' + r.expires_at.slice(11, 16) + '  '
      + String(r.agent || '').slice(0, 40));
  }
}

function die(m) { console.error('erreur : ' + m); process.exit(1); }

function usage() {
  console.log(`SYNAPSE — administration

  source add <nom> [--scope write|read|read+write|incidents|admin] [--channel A|B|C]
  source rotate <nom>
  source list
  prompt set <agent> --file <chemin>
  stats

  user add <nom> --pass "<12 caracteres minimum>"
  user list
  user pass <nom> --pass "<nouveau>"
  user del <nom>
  sessions

Exemples
  node src/cli.js source add relay --scope write
  node src/cli.js source add oracle --scope read+write --channel B
  node src/cli.js source add hub --scope read
  node src/cli.js source add triage --scope incidents
  node src/cli.js source list`);
}

switch (cmd) {
  case 'source':
    if (rest[0] === 'add')         sourceAdd(rest[1]);
    else if (rest[0] === 'rotate') sourceRotate(rest[1]);
    else if (rest[0] === 'list')   sourceList();
    else usage();
    break;
  case 'prompt':
    if (rest[0] === 'set') promptSet(rest[1]); else usage();
    break;
  case 'stats': stats(); break;
  case 'user':
    if (rest[0] === 'add')       userAdd(rest[1]);
    else if (rest[0] === 'list') userList();
    else if (rest[0] === 'pass') userPass(rest[1]);
    else if (rest[0] === 'del')  userDel(rest[1]);
    else usage();
    break;
  case 'sessions': sessions(); break;
  default: usage();
}
db.close();
