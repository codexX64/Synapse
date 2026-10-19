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
let base = null;
const db = () => base || (base = open(DB_FILE));
/* Chaque geste laisse sa trace au journal de sécurité, chaîné comme celui
   du service, qui tourne pendant ce temps : la base est en WAL. */
let journal = null;
const trace = (action, objet, details) => journal && journal.ecrire({ action, objet, details: { par: 'ligne de commande', ...details } });
const [, , cmd, ...rest] = process.argv;

function hash(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function arg(name, dflt) {
  const i = rest.indexOf('--' + name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
}

const PORTEES = ['write', 'read', 'read+write', 'incidents', 'admin'];
function sourceAdd(name) {
  if (!name || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) die('nom de source : 2 à 32 caractères, minuscules, chiffres, - et _');
  const scope = arg('scope', 'write');
  if (!PORTEES.includes(scope)) die('portée : ' + PORTEES.join(', '));
  const channel = arg('channel', 'A');
  if (!['A', 'B', 'C'].includes(channel)) die('canal : A, B ou C');
  const prefix = scope === 'admin' ? 'adm'
               : scope === 'incidents' ? 'trg'
               : scope.includes('read') && scope.includes('write') ? 'ai'
               : scope === 'read' ? 'ui' : 'svc';
  const token = prefix + '_' + crypto.randomBytes(24).toString('base64url');
  try {
    db().prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at)
                VALUES(?,?,?,?,?)`).run(name, hash(token), scope, channel, new Date().toISOString());
  } catch (e) {
    die(/UNIQUE/.test(String(e)) ? `la source « ${name} » existe déjà` : String(e.message || e));
  }
  if (scope.includes('read') && !['shared'].includes(name)) {
    db().prepare(`INSERT OR IGNORE INTO namespaces(name,kind,owner,created_at) VALUES(?,?,?,?)`)
      .run('agent:' + name, 'agent', name, new Date().toISOString());
  }
  trace('source.creee', name, { portee: scope, canal: channel });
  console.log(`source « ${name} » créée · portée ${scope} · canal ${channel}`);
  console.log('');
  console.log('  ' + token);
  console.log('');
  console.log('Ce jeton ne sera plus jamais affiché : seul son hash est stocké.');
}

function sourceRotate(name) {
  if (!name) die('nom de source requis');
  const row = db().prepare(`SELECT scope FROM sources WHERE name=?`).get(name);
  if (!row) die('source inconnue : ' + name);
  const prefix = row.scope === 'admin' ? 'adm'
    : row.scope === 'incidents' ? 'trg'
    : row.scope.includes('read') && row.scope.includes('write') ? 'ai'
    : row.scope === 'read' ? 'ui' : 'svc';
  const token = prefix + '_' + crypto.randomBytes(24).toString('base64url');
  db().prepare(`UPDATE sources SET token_hash=? WHERE name=?`).run(hash(token), name);
  trace('source.jeton_remplace', name);
  console.log(`jeton de « ${name} » remplacé :\n\n  ${token}\n`);
  console.log("L'ancien ne fonctionne plus. Mets à jour le service avant son prochain envoi.");
}

/* Changer la portée d'une source garde son jeton : rien à redistribuer. */
function sourceScope(name, scope) {
  if (!name || !scope) die('usage : source scope <nom> <read|write|read+write>');
  if (!['read', 'write', 'read+write'].includes(scope)) die('portée : read, write ou read+write');
  const r = db().prepare(`UPDATE sources SET scope=? WHERE name=?`).run(scope, name);
  if (!Number(r.changes)) die('source inconnue : ' + name);
  trace('source.portee', name, { portee: scope });
  console.log(`source « ${name} » : portée ${scope}`);
}

function sourceList() {
  const rows = db().prepare(
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
  const q = s => db().prepare(s).get();
  console.log('entrées      ', q(`SELECT count(*) n FROM entries WHERE archived=0`).n);
  console.log('liens        ', q(`SELECT count(*) n FROM links`).n);
  console.log('morceaux     ',
    q(`SELECT count(*) n FROM chunks WHERE embedded=1`).n + ' vectorisés · ' +
    q(`SELECT count(*) n FROM chunks WHERE embedded=0`).n + ' en attente · ' +
    q(`SELECT count(*) n FROM chunks WHERE embedded=-1`).n + ' exclus');
  const lv = db().prepare(`SELECT level,count(*) n FROM entries WHERE archived=0 GROUP BY level`).all();
  console.log('niveaux      ', lv.map(r => r.level + ':' + r.n).join(' · ') || '—');
  const fq = db().prepare(`SELECT query_norm,n FROM failed_queries ORDER BY n DESC LIMIT 8`).all();
  if (fq.length) {
    console.log('\nrequêtes sans résultat — ce que la mémoire ne contient pas :');
    for (const r of fq) console.log('  ' + String(r.n).padStart(4) + '  ' + r.query_norm);
  }
}

function promptSet(agent) {
  if (!agent) die('nom d\u2019agent requis');
  const body = require('node:fs').readFileSync(arg('file', '/dev/stdin'), 'utf8');
  const last = db().prepare(`SELECT MAX(version) v FROM prompts WHERE agent=?`).get(agent);
  const v = (last?.v || 0) + 1;
  db().prepare(`INSERT INTO prompts(agent,version,body,created_at) VALUES(?,?,?,?)`)
    .run(agent, v, body, new Date().toISOString());
  trace('prompt.enregistre', agent, { version: v });
  console.log(`prompt « ${agent} » enregistré en version ${v}`);
}

function die(m) { console.error('erreur : ' + m); process.exit(1); }

/* Sur la machine qui garde la clé privée : aucune base ouverte. */
function restaurer(socle, prive, cible) {
  const fs = require('node:fs');
  if (!prive || !cible) die('usage : restaurer <clé-privée.pem> <cible.db> < synapse.sauv');
  if (fs.existsSync(cible)) die(`${cible} existe déjà : la restauration écrit un fichier neuf`);
  let lu;
  try { lu = socle.dechiffrer(fs.readFileSync(0), fs.readFileSync(prive, 'utf8')); } catch (e) { die(`sauvegarde illisible avec cette clé (${e.message})`); }
  if (lu.entete.service !== 'synapse') die(`sauvegarde de ${lu.entete.service}, pas de SYNAPSE`);
  fs.writeFileSync(cible, lu.base, { mode: 0o600, flag: 'wx' });
  process.stderr.write(`Base de SYNAPSE ${lu.entete.version} du ${lu.entete.date} restaurée dans ${cible}.\n`);
}

/* La sauvegarde est chiffrée pour une clé publique dont la clé privée ne
   vit pas sur la machine de SYNAPSE : qui prend la machine ne relit pas
   les sauvegardes. Les secrets scellés (TOTP, jeton Telegram) le restent
   sous SOCLE_CLE. */
async function sauvegarde(socle) {
  const fs = require('node:fs');
  if (process.stdout.isTTY) die('redirige la sortie : node src/cli.js sauvegarde < sauvegarde.pub > synapse.sauv');
  let sortie;
  try { sortie = await socle.sauvegarder(db(), fs.readFileSync(0, 'utf8'), { service: 'synapse', version: require('../package.json').version }); } catch (e) { die(e.message); }
  trace('sauvegarde.faite', null, { octets: sortie.length });
  process.stdout.write(sortie);
}

/* Runbook d'incident : le jeton Telegram oublié, sans la clé (il est
   effacé, pas rescellé). Le révoquer aussi auprès de @BotFather. */
function retirerSecrets() {
  const r = db().prepare(`SELECT v FROM meta WHERE k = 'rangement'`).get();
  let c = {};
  try { c = r ? JSON.parse(r.v) : {}; } catch { c = {}; }
  const retires = c.telegram_token ? ['telegram.jeton'] : [];
  if (retires.length) db().prepare(`UPDATE meta SET v = ? WHERE k = 'rangement'`).run(JSON.stringify({ ...c, telegram_token: '', telegram_actif: false }));
  trace('secrets.retires', 'tous', { retires });
  console.log(retires.length ? `retirés : ${retires.join(', ')} — révoque-le aussi auprès de @BotFather` : 'rien à retirer');
}

function usage() {
  console.log(`SYNAPSE — administration

  source add <nom> [--scope write|read|read+write|incidents|admin] [--channel A|B|C]
  source rotate <nom>
  source list
  source scope <nom> <read|write|read+write>
  simulation purger
  prompt set <agent> --file <chemin>
  stats

  secrets retirer               oublie le jeton Telegram (runbook d'incident)
  sauvegarde < clé-publique.pem > synapse.sauv
  restaurer <clé-privée.pem> <cible.db> < synapse.sauv   (sur une autre machine)

Les comptes humains se gèrent dans l'interface (/compte) ou depuis le Hub.

Exemples
  node src/cli.js source add relay --scope write
  node src/cli.js source add oracle --scope read+write --channel B
  node src/cli.js source add hub --scope read
  node src/cli.js source add triage --scope incidents
  node src/cli.js source list`);
}

async function principal() {
  const socle = await import('../socle/src/index.js');
  if (cmd === 'restaurer') return restaurer(socle, rest[0], rest[1]);
  journal = new socle.Journal(db());
  switch (cmd) {
    case 'source':
      if (rest[0] === 'add')         sourceAdd(rest[1]);
      else if (rest[0] === 'rotate') sourceRotate(rest[1]);
      else if (rest[0] === 'list')   sourceList();
      else if (rest[0] === 'scope')  sourceScope(rest[1], rest[2]);
      else usage();
      break;
    case 'simulation':
      if (rest[0] === 'purger') {
        const r = require('./sources.js').purgerSimulation(db());
        trace('simulation.purgee', null, { supprimees: r.supprimees });
        console.log(`${r.supprimees} entrée(s) simulée(s) supprimée(s)`);
      } else usage();
      break;
    case 'prompt':
      if (rest[0] === 'set') promptSet(rest[1]); else usage();
      break;
    case 'stats': stats(); break;
    case 'secrets':
      if (rest[0] === 'retirer') retirerSecrets(); else usage();
      break;
    case 'sauvegarde': await sauvegarde(socle); break;
    default: usage();
  }
  db().close();
}
principal().catch(e => die(e.message));
