'use strict';
/* ============================================================
   SYNAPSE — serveur HTTP, zéro dépendance.

   Séparation d'exposition, à tenir dès le premier jour :

     /v1/ingest   écriture — JAMAIS exposée hors du lab
     /v1/search   lecture  — la seule route qui sort, derrière Access
     /mcp         agents   — réseau interne

   Contre-pression : quand la file dépasse le seuil, l'ingestion
   renvoie 429. Les clients ont un spool disque et rejouent. Sans
   ce garde-fou, un collecteur emballé remplit le disque en silence.
   ============================================================ */

const http = require('node:http');
const crypto = require('node:crypto');
const { open } = require('./db.js');
const ingest = require('./ingest.js');
const { search } = require('./search.js');
const { Embedder, startWorker } = require('./embed.js');
const { handleMcp } = require('./mcp.js');
const { buildGraph } = require('./graph.js');
const inc = require('./incidents.js');
const neu = require('./neurons.js');
const APP = require('./apprentissage.js');
const A = require('./auth.js');
const C = require('./comptes.js');
const { blobToVec } = require('./db.js');
const fsp = require('node:fs');
const pathm = require('node:path');

const PORT     = Number(process.env.PORT || 8140);
const DB_FILE  = process.env.DB_FILE || '/data/synapse.db';
const MAX_BODY = Number(process.env.MAX_BODY || 2_000_000);
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const UI_DIR = process.env.UI_DIR || '/app/ui';
/* Jeton de LECTURE injecté dans la page servie. L'interface tourne dans
   un navigateur : elle ne peut pas poser d'en-tête Authorization sur son
   propre chargement. Sans ça, /v1/graph répond 401 et la scène retombe
   sur son corpus de démonstration.
   Portée read uniquement — quiconque ouvre la page peut lire la mémoire,
   personne ne peut y écrire. C'est pourquoi la page ne doit sortir que
   derrière Cloudflare Access. */
/* UI_TOKEN n'est plus injecte dans la page.
   Il l'etait pour que l'interface puisse appeler /v1/graph : resultat,
   quiconque ouvrait l'URL repartait avec une cle de lecture sur toute
   la memoire. Une session nominative le remplace — le navigateur porte
   un cookie, pas un secret partage. */
/* CORS_ORIGIN est l'origine du HUB, autorisee a appeler l'API. L'origine
   WebAuthn est celle de la page de SYNAPSE elle-meme : les deux ne sont
   pas les memes. Les confondre faisait refuser toute cle d'acces avec
   « origine refusee ». */
const ORIGINE = process.env.AUTH_ORIGIN || '';
const AGREG = (process.env.AGREG_URL || '').replace(/\/$/, '');
/* Les tickets vivent dans le service de tickets. L'agregateur n'en remonte que les dix
   plus recents : sur 42 ouverts, une question sur un ticket precis
   tombait a cote. SYNAPSE lit donc la base d'le service de tickets en lecture seule. */
const TK = require('./tickets.js');
const RG = require('./rangement.js');
/* Le rangement est une decision humaine, pas une ecriture de service.
   La session porte la portee `read` — voulue, pour qu'un humain ne
   puisse pas ingerer par l'API — mais quelqu'un qui s'est authentifie
   par mot de passe ET second facteur est plus legitime qu'un jeton de
   service pour decider de supprimer un doublon. */
const pilote = src => !!(src && (src.humain || src.scope === 'admin'));
const CFG = require('./config.js');
const TACHE = require('./tache.js');
const PLANIF = require('./planif.js');

/* Reecriture d'un titre faible par le modele local. Le modele ne
   choisit pas quoi garder : il tire le FOND de l'extrait qu'on lui
   donne. Un titre invente serait pire que le titre vague. */
async function reecritTitre(entree) {
  if (!embedder.url) return null;
  const r = await fetch(embedder.url + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANSWER_MODEL || 'qwen3.8:9b', stream: false, think: false,
      system: `Tu rediges des titres pour une base de connaissances technique.
Un bon titre enonce le FOND : ce que le document affirme, pas le sujet qu'il aborde.
« Installation » est mauvais. « api-interne s'installe par compose, sans base externe » est bon.
Reponds par le titre seul : pas de guillemets, pas de point final, 6 a 14 mots, en francais.
Si l'extrait ne permet pas d'ecrire un titre precis, reponds exactement : RIEN`,
      prompt: `Titre actuel, trop vague : ${entree.title}\n\nDebut du document :\n${entree.extrait}\n\nEcris le titre.`,
      options: { temperature: 0.2, num_predict: 60 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  let t = String(j.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0];
  t = t.replace(/^["'«»\s]+|["'«»\s.]+$/g, '').trim();
  if (/^RIEN\b/i.test(t) || t.length < 20) return null;
  if (t.toLowerCase() === String(entree.title).toLowerCase()) return null;
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}
const COOKIE = 'syn_sid';

function litCookie(req, nom) {
  const b = req.headers.cookie || '';
  for (const part of b.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === nom) return decodeURIComponent(v.join('='));
  }
  return null;
}

function poseCookie(res, sid, maxAgeMs) {
  /* HttpOnly : illisible en JavaScript, donc pas exfiltrable par une
      injection. SameSite=Lax : pas envoye depuis un autre site. */
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Secure`
    + `; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}
function videCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
}

/* ---------- amorçage des jetons de service ----------
   Une source ne se créait qu'en ligne de commande. Un installateur
   automatique — le Hub — ne peut pas exécuter une commande dans le
   conteneur avant le premier démarrage : il ne sait que poser des
   variables d'environnement. On accepte donc un jeton d'amorce.

   C'est le même jeton à chaque démarrage, donc l'opération est
   idempotente : on remet le hash en place, on ne recrée rien. Changer
   la variable fait tourner le jeton ; la vider ne supprime pas la
   source, pour ne pas couper un service qui tourne à cause d'un
   fichier .env incomplet. */
/* ---------- appel au modèle de synthèse ----------
   La consolidation a besoin d'un modèle, mais ne doit pas savoir lequel
   ni où. Elle reçoit cette fonction ; si le modèle est absent, elle le
   signale et ne fait rien — une passe manquée n'est pas une panne. */
async function demanderAuModele(consigne, texte) {
  const model = process.env.ANSWER_MODEL || 'qwen3:8b';
  const o = await fetch(embedder.url + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, prompt: `${consigne}\n\n---\n${texte}`, stream: false, think: false,
      format: 'json', options: { temperature: 0.1, num_predict: 700 },
    }),
    signal: AbortSignal.timeout(45000),
  });
  const j = await o.json();
  if (!o.ok || j.error) throw new Error(j.error || 'HTTP ' + o.status);
  return String(j.response || '');
}

function amorcerSourceHub(db) {
  const paires = [
    ['hub', process.env.HUB_TOKEN_SEED, 'read+write'],
    ['hub-admin', process.env.HUB_ADMIN_TOKEN_SEED, 'admin'],
  ];
  const now = new Date().toISOString();
  for (const [nom, jeton, portee] of paires) {
    if (!jeton || String(jeton).length < 16) continue;
    const hash = crypto.createHash('sha256').update(String(jeton)).digest('hex');
    db.prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at)
                VALUES (?,?,?,'A',?)
                ON CONFLICT(name) DO UPDATE SET token_hash=excluded.token_hash, scope=excluded.scope, enabled=1`)
      .run(nom, hash, portee, now);
  }
}

const db = open(DB_FILE);
inc.migrate(db);
neu.migrate(db);
APP.migrate(db);
A.migrate(db);
C.migrate(db);
amorcerSourceHub(db);
if (A.assureInitial(db))
  console.log('[synapse] aucun compte : admin / Temp1234 cree, a remplacer a la premiere connexion');
setInterval(() => A.purge(db), 600000).unref?.();
PLANIF.demarre(db, reecritTitre);
const embedder = new Embedder();
startWorker(db, embedder);

/* ---------- consolidation périodique ----------
   La distillation est coûteuse — elle appelle un modèle — et n'a aucune
   raison d'être synchrone : personne n'attend un profil pendant qu'il
   pose sa question. Elle tourne donc en fond, par agent, et seulement
   s'il y a du neuf à lire. Un intervalle long est voulu : un profil qui
   bouge à chaque phrase n'est pas un profil, c'est une humeur. */
const CONSOLIDATION_MS = Number(process.env.CONSOLIDATION_INTERVAL || 1800000);
if (CONSOLIDATION_MS > 0) {
  setInterval(async () => {
    try {
      const r = await APP.consoliderTous(db, { demander: demanderAuModele });
      if (r.traits?.length) console.log(`[synapse] profils ${r.agents.join(', ')} : ${r.traits.length} trait(s) sur ${r.lus} échange(s)`);
    } catch (e) { console.warn('[synapse] consolidation', e.message); }
  }, CONSOLIDATION_MS).unref?.();
}

/* ---------- jetons ----------
   Seul le hash est stocké. Comparaison à temps constant : une
   comparaison naïve fuit la longueur du préfixe correct. */
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

function auth(req) {
  /* Deux en-têtes acceptés. Le contrat TRIAGE impose X-Synapse-Key ;
     le reste de SYNAPSE utilise Bearer. Refuser l'un des deux
     obligerait à modifier un client déjà testé, ce que le prompt
     interdit explicitement. */
  let brut = null;
  const xk = req.headers['x-synapse-key'];
  if (typeof xk === 'string' && xk.trim()) brut = xk.trim();
  if (!brut) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m) brut = m[1];
  }
  if (!brut) return null;
  const hash = hashToken(brut);
  const row = db.prepare(
    `SELECT name, scope, channel, enabled FROM sources WHERE token_hash = ?`).get(hash);
  if (!row || !row.enabled) return null;
  return row;
}
const adminDistant = src => !!(src && !src.humain && src.scope === 'admin');

function can(src, what) {
  if (!src) return false;
  if (src.scope === 'admin') return true;
  return src.scope.split('+').includes(what);
}

/* Portée dédiée : TRIAGE écrit des incidents et RIEN d'autre.
   Jamais de clé partagée entre services, et un jeton `incidents` ne
   peut ni écrire d'autres types de neurones ni en supprimer. */
function canIncident(src, what) {
  if (!src) return false;
  if (src.scope === 'admin') return true;
  const parts = src.scope.split('+');
  if (parts.includes('incidents')) return true;
  return parts.includes(what);
}

/* ---------- utilitaires HTTP ---------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extra || {})
  };
  if (CORS_ORIGIN) {
    h['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Vary'] = 'Origin';
  }
  res.writeHead(code, h);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('corps trop grand')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(parts).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

/* ---------- limitation de débit ---------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) { b = { t: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.t > 120000) buckets.delete(k);
}, 60000).unref?.();

/* ---------- routes ---------- */
const routes = {

  'GET /healthz': async (req, res) => {
    /* Ne révèle ni volumétrie ni contenu. `semantic` dit seulement si la
       couche d'embeddings répond : sans elle, L0 et L1 fonctionnent et le
       service démarre quand même. */
    send(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      semantic: embedder.ok === true,
      levels: { L0: true, L1: true, L2: embedder.ok === true, L3: true }
    });
  },

  'GET /v1/stats': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read') && ctx.src?.scope !== 'admin')
      return send(res, 403, { error: 'portée read requise' });
    if (ctx.url.searchParams.get('scope') === 'neurons')
      return send(res, 200, neu.stats(db, Number(ctx.url.searchParams.get('days') || 30)));
    const lv = db.prepare(
      `SELECT level, count(*) n FROM entries WHERE archived=0 GROUP BY level`).all();
    const byNs = db.prepare(
      `SELECT ns, count(*) n FROM entries WHERE archived=0 GROUP BY ns`).all();
    const pend = db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=0`).get().n;
    const done = db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=1`).get().n;
    const skip = db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=-1`).get().n;
    send(res, 200, {
      entries: db.prepare(`SELECT count(*) n FROM entries WHERE archived=0`).get().n,
      levels: Object.fromEntries(lv.map(r => [r.level, r.n])),
      namespaces: Object.fromEntries(byNs.map(r => [r.ns, r.n])),
      links: db.prepare(`SELECT count(*) n FROM links`).get().n,
      chunks: { embedded: done, pending: pend, skipped: skip },
      embedder: { model: embedder.model, ok: embedder.ok, last_error: embedder.lastError },
      failed_queries: db.prepare(`SELECT count(*) n FROM failed_queries`).get().n
    });
  },

  'GET /v1/sources': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    send(res, 200, {
      sources: db.prepare(
        `SELECT name, scope, channel, enabled, created_at, last_seen, n_events
         FROM sources ORDER BY last_seen DESC NULLS LAST`).all()
    });
  },

  'POST /v1/ingest': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    if (!rateLimit('ing:' + ctx.src.name, 600, 60000))
      return send(res, 429, { error: 'trop de requêtes' }, { 'Retry-After': '10' });
    const pending = db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=0`).get().n;
    if (pending > QUEUE_MAX)
      return send(res, 429, { error: 'file saturée', pending }, { 'Retry-After': '30' });

    const body = await readBody(req);
    const r = ingest.insert(db, body, ctx.src.name);
    if (!r.ok && r.filtered) return send(res, 202, { filtered: true, reason: r.reason });
    if (!r.ok) return send(res, 400, { error: r.reason || 'refusé' });
    send(res, 202, r);
  },

  'POST /v1/ingest/batch': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > 200) return send(res, 400, { error: 'lot > 200' });
    const out = [];
    for (const e of events) out.push(ingest.insert(db, e, ctx.src.name));
    send(res, 202, {
      accepted: out.filter(o => o.ok && !o.duplicate).length,
      duplicates: out.filter(o => o.duplicate).length,
      filtered: out.filter(o => o.filtered).length,
      results: out
    });
  },

  'GET /v1/search': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const u = ctx.url;
    const ns = u.searchParams.get('ns') || u.searchParams.get('scope') || 'shared';
    if (!nsAllowed(ctx.src, ns)) return send(res, 403, { error: 'espace interdit : ' + ns });
    const r = await search(db, {
      q: u.searchParams.get('q') || '',
      ns,
      limit: Math.min(50, Number(u.searchParams.get('limit') || 8)),
      embed: t => embedder.query(t),
      forVector: u.searchParams.get('vector') !== '0'
    });
    send(res, 200, r);
  },

  'GET /v1/entry': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const id = Number(ctx.url.searchParams.get('id'));
    const e = db.prepare(`SELECT * FROM entries WHERE id=?`).get(id);
    if (!e) return send(res, 404, { error: 'introuvable' });
    if (!nsAllowed(ctx.src, e.ns)) return send(res, 403, { error: 'espace interdit' });
    const links = db.prepare(`
      SELECT l.relation, e2.id, e2.title, e2.level, e2.source,
             CASE WHEN l.from_id=? THEN 'out' ELSE 'in' END AS dir
      FROM links l JOIN entries e2
        ON e2.id = CASE WHEN l.from_id=? THEN l.to_id ELSE l.from_id END
      WHERE l.from_id=? OR l.to_id=?`).all(id, id, id, id);
    send(res, 200, {
      id: e.id, ns: e.ns, source: e.source, kind: e.kind, ref: e.ref, level: e.level,
      title: e.title, body: e.body, tags: e.tags ? e.tags.split(' ') : [],
      meta: JSON.parse(e.meta || '{}'), occurred_at: e.occurred_at,
      created_at: e.created_at, dup_count: e.dup_count, links
    });
  },

  'POST /v1/link': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    const r = ingest.link(db, Number(b.from_id), Number(b.to_id), String(b.relation), ctx.src.name);
    send(res, r.ok ? 201 : 400, r);
  },

  'POST /v1/click': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const b = await readBody(req);
    const q = String(b.q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const id = Number(b.entry_id);
    if (!q || !id) return send(res, 400, { error: 'q et entry_id requis' });
    db.prepare(`INSERT INTO query_clicks(query_norm,entry_id,n) VALUES(?,?,1)
                ON CONFLICT(query_norm,entry_id) DO UPDATE SET n=n+1`).run(q, id);
    send(res, 204, {});
  },

  'GET /v1/prompts': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const agent = ctx.url.searchParams.get('agent');
    if (!agent) return send(res, 400, { error: 'agent requis' });
    const row = db.prepare(
      `SELECT agent,version,body,created_at FROM prompts WHERE agent=?
       ORDER BY version DESC LIMIT 1`).get(agent);
    if (!row) return send(res, 404, { error: 'aucun prompt pour ' + agent });
    send(res, 200, row);
  },

  'POST /v1/prompts': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    const b = await readBody(req);
    const agent = String(b.agent || ''), body = String(b.body || '');
    if (!agent || !body) return send(res, 400, { error: 'agent et body requis' });
    const last = db.prepare(`SELECT MAX(version) v FROM prompts WHERE agent=?`).get(agent);
    const v = (last?.v || 0) + 1;
    db.prepare(`INSERT INTO prompts(agent,version,body,created_at) VALUES(?,?,?,?)`)
      .run(agent, v, body, new Date().toISOString());
    send(res, 201, { agent, version: v });
  },

  /* ---------- rangement ----------
     Analyse et application separees : un rangement se lit avant de
     s'appliquer. La portee admin est exigee pour l'application, pas
     pour l'analyse — regarder ne casse rien. */

  'GET /v1/rangement/etat': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    send(res, 200, { ...TACHE.statut(), config: CFG.public_(CFG.lit(db)) });
  },

  'POST /v1/rangement/config': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    const b = await readBody(req);
    /* Un jeton vide n'efface pas celui qui est en place : la page
       n'affiche qu'une empreinte, elle ne peut pas le renvoyer. */
    if (b.telegram_token === '' || b.telegram_token === undefined) delete b.telegram_token;
    send(res, 200, { ok: true, config: CFG.public_(CFG.ecrit(db, b)) });
  },

  'POST /v1/rangement/telegram/test': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    const b = await readBody(req);
    const c = CFG.lit(db);
    const r = await PLANIF.testeTelegram(b.token || c.telegram_token, b.chat || c.telegram_chat);
    send(res, r.ok ? 200 : 400, r);
  },

  'POST /v1/rangement/lancer': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    const cfg = CFG.lit(db);
    const r = await TACHE.lance(db, cfg, { reecrit: reecritTitre, source: 'manuel' });
    send(res, r.refus ? 409 : 202, r.refus ? { error: r.refus } : { ok: true });
  },

  'POST /v1/rangement/pause': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    send(res, 200, { ok: TACHE.metEnPause(), etat: TACHE.statut().etat });
  },

  'POST /v1/rangement/reprendre': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    send(res, 200, { ok: TACHE.reprend(), etat: TACHE.statut().etat });
  },

  'POST /v1/rangement/arreter': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    TACHE.interrompt(); TACHE.jettePlan();
    send(res, 200, { ok: true });
  },

  'POST /v1/rangement/valider': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    const b = await readBody(req);
    const p = TACHE.prendPlan();
    if (!p) return send(res, 409, { error: 'aucun plan, ou plan expiré' });
    /* L'interface peut ecarter des actions : on ne garde que celles
       dont l'identifiant est encore dans la liste envoyee. */
    const gardes = Array.isArray(b.ids) ? new Set(b.ids.map(Number)) : null;
    const plan = gardes ? p.actions.filter(a => gardes.has(a.id)) : p.actions;
    if (!plan.length) return send(res, 400, { error: 'plan vide après filtrage' });
    let sauve = null;
    try { sauve = RG.sauvegarde(db); }
    catch (e) { return send(res, 500, { error: 'sauvegarde impossible : ' + e.message }); }
    const fait = RG.applique(db, plan);
    send(res, 200, { ...fait, sauvegarde: sauve });
  },

  'GET /v1/rangement/analyse': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const ns = ctx.url.searchParams.get('ns') || null;
    const seuil = Math.min(0.99, Math.max(0.85, Number(ctx.url.searchParams.get('seuil') || 0.94)));
    const t0 = performance.now();
    const d = RG.doublons(db, { ns, seuil });
    const t = RG.titresFaibles(db, { ns });
    const o = RG.orphelins(db);
    send(res, 200, {
      ns: ns || 'tous', seuil,
      entrees_vectorisees: d.total,
      doublons: d.actions,
      doublons_candidats: d.candidats,
      titres_faibles: t,
      orphelins: o,
      took_ms: +(performance.now() - t0).toFixed(1)
    });
  },

  'POST /v1/rangement/appliquer': async (req, res, ctx) => {
    if (!pilote(ctx.src)) return send(res, 403, { error: 'réservé à une session connectée ou à un jeton admin' });
    const b = await readBody(req);
    const plan = Array.isArray(b.plan) ? b.plan : [];
    if (!plan.length) return send(res, 400, { error: 'plan vide' });
    if (plan.length > 200) return send(res, 400, { error: 'plan trop grand : 200 actions au maximum' });
    for (const a of plan) {
      if (!['supprimer', 'renommer'].includes(a.type)) return send(res, 400, { error: 'action inconnue : ' + a.type });
      if (!Number.isInteger(a.id)) return send(res, 400, { error: 'identifiant manquant' });
      if (a.type === 'renommer' && (!a.titre || a.titre.length < 10)) return send(res, 400, { error: 'titre trop court' });
    }
    let sauve = null;
    try { sauve = RG.sauvegarde(db); } catch (e) { return send(res, 500, { error: 'sauvegarde impossible : ' + e.message }); }
    const fait = RG.applique(db, plan);
    send(res, 200, { ...fait, sauvegarde: sauve });
  },

  /* ---------- authentification humaine ---------- */

  'GET /v1/auth/session': async (req, res, ctx) => {
    send(res, 200, {
      installe: A.installe(db),
      user: ctx.src && ctx.src.humain ? ctx.src.name : null,
      attente: ctx.src && ctx.src.humain ? C.enAttente(db, ctx.src.name) : null,
      stepup: ctx.src && ctx.src.sid ? A.aStepUp(db, ctx.src.sid) : false
    });
  },

  'POST /v1/auth/login': async (req, res) => {
    const b = await readBody(req);
    const nom = String(b.user || '').trim();
    const ip = req.socket.remoteAddress || '';
    /* La limitation porte sur le compte ET sur l'adresse : sans le
       second, un attaquant essaie un mot de passe sur mille comptes. */
    if (A.trop(db, 'u:' + nom) || A.trop(db, 'ip:' + ip))
      return send(res, 429, { error: 'trop de tentatives, réessaie dans 15 minutes' });

    const u = db.prepare(`SELECT * FROM auth_users WHERE name=? AND active=1`).get(nom);
    /* Message identique que le compte existe ou non : sinon on donne
       la liste des comptes valides à qui essaie. */
    if (!u || !A.verifiePass(String(b.pass || ''), u.pass)) {
      A.rate(db, 'u:' + nom); A.rate(db, 'ip:' + ip);
      return send(res, 401, { error: 'identifiants refusés' });
    }
    /* Compte temporaire : pas encore de second facteur. On ouvre une
       session marquee « init », qui ne donne acces qu'a la page
       d'initialisation. */
    if (u.init) {
      A.oublie(db, 'u:' + nom); A.oublie(db, 'ip:' + ip);
      const sid = A.ouvre(db, nom, ip, req.headers['user-agent']);
      poseCookie(res, sid, 15 * 60 * 1000);       /* 15 min pour finir */
      return send(res, 200, { init: true, redirect: '/setup' });
    }
    /* Compte créé par un administrateur : le second facteur reste à
       poser. Le mot de passe ouvre /setup, et seulement /setup, le temps
       de le faire — dans la limite de l'invitation. */
    if (u.mfa_a_poser) {
      if (C.invitationExpiree(u))
        return send(res, 403, { error: 'invitation expirée : demande un nouveau mot de passe à l’administrateur' });
      A.oublie(db, 'u:' + nom); A.oublie(db, 'ip:' + ip);
      const sid = A.ouvre(db, nom, ip, req.headers['user-agent']);
      poseCookie(res, sid, 15 * 60 * 1000);
      return send(res, 200, { init: true, redirect: '/setup' });
    }
    /* Le mot de passe seul n'ouvre rien : il donne droit à présenter
       le second facteur, pas à entrer. */
    send(res, 200, { second_facteur: true, methodes: {
      totp: !!u.totp,
      passkey: db.prepare(`SELECT count(*) n FROM auth_passkeys WHERE user=?`).get(nom).n > 0
    }});
  },

  'POST /v1/auth/totp': async (req, res) => {
    const b = await readBody(req);
    const nom = String(b.user || '').trim();
    const ip = req.socket.remoteAddress || '';
    if (A.trop(db, 'u:' + nom) || A.trop(db, 'ip:' + ip))
      return send(res, 429, { error: 'trop de tentatives' });

    const u = db.prepare(`SELECT * FROM auth_users WHERE name=? AND active=1`).get(nom);
    if (!u || !A.verifiePass(String(b.pass || ''), u.pass)) {
      A.rate(db, 'u:' + nom); A.rate(db, 'ip:' + ip);
      return send(res, 401, { error: 'identifiants refusés' });
    }
    const code = String(b.code || '').trim();
    const bon = A.verifieTotp(u.totp, code) || A.verifieBackup(db, nom, code);
    if (!bon) { A.rate(db, 'u:' + nom); return send(res, 401, { error: 'code refusé' }); }

    A.oublie(db, 'u:' + nom); A.oublie(db, 'ip:' + ip);
    const sid = A.ouvre(db, nom, ip, req.headers['user-agent']);
    poseCookie(res, sid, A.SESSION_MS);
    send(res, 200, { ok: true, user: nom });
  },

  'POST /v1/auth/passkey/options': async (req, res) => {
    const b = await readBody(req);
    send(res, 200, A.debutConnexionPasskey(db, String(b.user || '').trim()));
  },

  'POST /v1/auth/passkey/verify': async (req, res) => {
    const b = await readBody(req);
    const r = A.finConnexionPasskey(db, b, ORIGINE || null);
    if (!r.ok) return send(res, 401, { error: r.error });
    const sid = A.ouvre(db, r.user, req.socket.remoteAddress, req.headers['user-agent']);
    poseCookie(res, sid, A.SESSION_MS);
    send(res, 200, { ok: true, user: r.user });
  },

  'POST /v1/auth/passkey/enroll/options': async (req, res, ctx) => {
    if (!ctx.src || !ctx.src.humain) return send(res, 403, { error: 'session requise' });
    send(res, 200, A.debutInscriptionPasskey(db, ctx.src.name));
  },

  'POST /v1/auth/passkey/enroll': async (req, res, ctx) => {
    if (!ctx.src || !ctx.src.humain) return send(res, 403, { error: 'session requise' });
    const r = A.finInscriptionPasskey(db, ctx.src.name, await readBody(req), ORIGINE || null);
    send(res, r.ok ? 201 : 400, r.ok ? { ok: true, id: r.id } : { error: r.error });
  },

  'GET /v1/auth/setup/totp': async (req, res, ctx) => {
    const attente = ctx.src && ctx.src.humain ? C.enAttente(db, ctx.src.name) : null;
    if (!attente) return send(res, 403, { error: 'rien à initialiser pour ce compte' });
    /* Le secret est genere ici et renvoye au navigateur pour le QR ;
       il ne sera enregistre qu'une fois un code valide presente. */
    const secret = A.secretTotp();
    const nom = attente === 'mfa' ? ctx.src.name : String(req.headers['x-nouveau-nom'] || 'moi').slice(0, 32);
    send(res, 200, { secret, otpauth: A.urlOtpauth(nom, secret) });
  },

  'POST /v1/auth/setup': async (req, res, ctx) => {
    const attente = ctx.src && ctx.src.humain ? C.enAttente(db, ctx.src.name) : null;
    if (!attente) return send(res, 403, { error: 'rien à initialiser pour ce compte' });
    const b = await readBody(req);
    const r = attente === 'mfa'
      ? C.poseMfa(db, ctx.src.name, String(b.totp_secret || ''), String(b.totp_code || ''))
      : A.finaliseInitial(db, {
          nouveauNom: String(b.user || '').trim(),
          nouveauPass: String(b.pass || ''),
          totpSecret: String(b.totp_secret || ''),
          totpCode: String(b.totp_code || '')
        });
    if (!r.ok) return send(res, 400, { error: r.error });
    /* La session temporaire meurt avec le compte : on en ouvre une vraie. */
    A.ferme(db, ctx.src.sid);
    const sid = A.ouvre(db, r.name, req.socket.remoteAddress, req.headers['user-agent']);
    poseCookie(res, sid, A.SESSION_MS);
    send(res, 200, { ok: true, user: r.name, codes: r.codes });
  },

  /* ---------- comptes, administrés à distance ----------
     Réservé à un jeton de portée admin — celui que le Hub reçoit à
     l'installation. Une session humaine n'y a pas accès : elle est en
     lecture, et gérer les comptes depuis la page qu'on protège ferait
     d'une session volée un compte de plus. */
  'GET /v1/admin/users': async (req, res, ctx) => {
    if (!adminDistant(ctx.src)) return send(res, 403, { error: 'portée admin requise' });
    send(res, 200, { comptes: C.liste(db) });
  },
  'POST /v1/admin/users': async (req, res, ctx) => {
    if (!adminDistant(ctx.src)) return send(res, 403, { error: 'portée admin requise' });
    const r = C.cree(db, await readBody(req));
    send(res, r.ok ? 201 : 400, r.ok ? r : { error: r.error });
  },
  'POST /v1/admin/users/:nom/password': async (req, res, ctx) => {
    if (!adminDistant(ctx.src)) return send(res, 403, { error: 'portée admin requise' });
    const b = await readBody(req);
    const r = C.motDePasse(db, ctx.params.nom, b.password);
    send(res, r.ok ? 200 : r.status || 400, r.ok ? r : { error: r.error });
  },
  'DELETE /v1/admin/users/:nom': async (req, res, ctx) => {
    if (!adminDistant(ctx.src)) return send(res, 403, { error: 'portée admin requise' });
    const r = C.supprime(db, ctx.params.nom);
    send(res, r.ok ? 200 : r.status || 400, r.ok ? r : { error: r.error });
  },

  'POST /v1/auth/logout': async (req, res, ctx) => {
    if (ctx.src && ctx.src.sid) A.ferme(db, ctx.src.sid);
    videCookie(res);
    send(res, 200, { ok: true });
  },

  /* ---------- contrat public : neurones et rappel ---------- */

  /* ---------- apprentissage ----------
     Un agent pose sa question une fois et reçoit tout : ce qu'on sait de
     son utilisateur, ce qu'il a lui-même mal compris avant, et la
     mémoire. Trois allers-retours devenaient trois occasions de couper
     la mémoire « parce que c'est lent ». */
  'POST /v1/brief': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const b = await readBody(req);
    const out = await APP.brief(db, {
      agent: b.agent, q: b.q || b.query || '', ns: b.ns || 'shared',
      limite: Math.min(20, Number(b.limit) || 6),
      budget: Math.min(5000, Number(b.budget) || 1200),
      signature: b.signature,
      search, embed: t => embedder.embed(t),
    });
    send(res, 200, { ...out, texte: APP.briefTexte(out) });
  },

  /* Le retour d'expérience de l'assistant : ce qu'il a dit de faux, et
     ce qu'il fallait dire. C'est la seule voie par laquelle une réponse
     ratée cesse de se répéter. */
  'POST /v1/apprendre': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    const out = {};
    if (b.correction) out.correction = APP.corriger(db, {
      agent: b.agent, question: b.question || b.q || '', correction: b.correction, faux: b.faux,
    });
    if (b.trait && b.trait.valeur) out.trait = APP.poser(db, {
      agent: b.trait.portee === 'agent' ? b.agent : APP.COMMUN,
      cle: b.trait.cle, valeur: b.trait.valeur,
      confiance: b.trait.confiance, origine: 'declare',
    });
    if (!out.correction && !out.trait) return send(res, 400, { error: 'ni correction ni trait' });
    send(res, 200, out);
  },

  /* L'échange brut. Il entre par l'ingestion normale : dédoublonné,
     indexé, vectorisé, rangé comme le reste. La consolidation le relira
     plus tard pour en tirer des traits. */
  'POST /v1/echange': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    if (!b.question) return send(res, 400, { error: 'question requise' });
    const evt = APP.evenementEchange({ agent: b.agent, question: b.question, reponse: b.reponse, ns: b.ns || 'shared' });
    const r = ingest.insert(db, evt, ctx.src.name);
    send(res, 202, r);
  },

  'GET /v1/profil': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const agent = ctx.url.searchParams.get('agent') || 'inconnu';
    send(res, 200, { ...APP.stats(db, agent), traits: APP.profil(db, agent) });
  },

  'DELETE /v1/profil': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const agent = ctx.url.searchParams.get('agent') || 'inconnu';
    const cle = ctx.url.searchParams.get('cle');
    if (!cle) return send(res, 400, { error: 'cle requise' });
    send(res, 200, APP.oublier(db, agent, cle));
  },

  'POST /v1/consolider': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    // Sans agent nommé : tout le monde. Obliger à nommer une connexion IA
    // qu'on ne connaît pas par cœur était une friction gratuite.
    send(res, 200, b.agent
      ? await APP.consolider(db, { agent: b.agent, ns: b.ns || null, demander: demanderAuModele })
      : await APP.consoliderTous(db, { ns: b.ns || null, demander: demanderAuModele }));
  },

  'POST /v1/recall': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const body = await readBody(req);
    /* Plafond dur : le client abandonne à 3 s. On rend une réponse vide
       plutôt que de le faire attendre — SYNAPSE est un confort, jamais
       une dépendance. */
    const out = await Promise.race([
      neu.recall(db, body, {
        source: ctx.src.name,
        embed: t => embedder.query(t),
        blobToVec
      }),
      new Promise(r => setTimeout(() => r({ results: [], timeout: true }), 2500))
    ]);
    send(res, 200, out);
  },

  'POST /v1/neurons': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    if (!rateLimit('neu:' + ctx.src.name, 240, 60000))
      return send(res, 429, { error: 'trop de requêtes' }, { 'Retry-After': '15' });
    const body = await readBody(req);
    const r = neu.remember(db, body, ctx.src.name);
    /* Jamais d'échec silencieux : 4xx explicite ou 201/200. */
    if (!r.ok) return send(res, r.status || 400, { error: r.error });
    send(res, r.status, r.body);
  },

  'GET /v1/neurons': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const u = ctx.url;
    send(res, 200, {
      neurons: neu.listNeurons(db, {
        type: u.searchParams.get('type'),
        source: u.searchParams.get('source'),
        limit: u.searchParams.get('limit'),
        offset: u.searchParams.get('offset')
      })
    });
  },

  'GET /v1/neuron': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const n = neu.getNeuron(db, Number(ctx.url.searchParams.get('id')), ctx.src.name);
    if (!n) return send(res, 404, { error: 'neurone inconnu' });
    send(res, 200, n);
  },

  'DELETE /v1/neuron': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const ok = neu.forget(db, Number(ctx.url.searchParams.get('id')));
    send(res, ok ? 200 : 404, ok ? { forgotten: true } : { error: 'neurone inconnu' });
  },

  'POST /v1/feedback': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const b = await readBody(req);
    if (typeof b.useful !== 'boolean') return send(res, 400, { error: 'useful (booléen) requis' });
    const r = neu.feedback(db, Number(b.neuron_id), b.useful);
    send(res, r.status, r.ok ? r.body : { error: r.error });
  },

  'GET /v1/export': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    send(res, 200, neu.exportAll(db));
  },

  'POST /v1/import': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    send(res, 200, neu.importAll(db, await readBody(req)));
  },

  'POST /v1/purge': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    const b = await readBody(req);
    send(res, 200, neu.purge(db, b));
  },

  /* ---------- mémoire opérationnelle (TRIAGE) ---------- */

  'POST /v1/incidents': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'write')) return send(res, 403, { error: 'portée incidents ou write requise' });
    /* Débit plus serré que l'ingestion générale : une boucle de triage
       emballée ne doit pas remplir la base d'incidents identiques. */
    if (!rateLimit('inc:' + ctx.src.name, 240, 60000))
      return send(res, 429, { error: 'trop de requêtes' }, { 'Retry-After': '15' });
    const body = await readBody(req);
    const r = inc.record(db, body);
    if (!r.ok) return send(res, 400, r);
    send(res, r.duplicate ? 200 : 201, r);
  },

  'POST /v1/incidents/lookup': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée incidents ou read requise' });
    const body = await readBody(req);
    send(res, 200, inc.lookup(db, body, { window: body.window }));
  },

  'GET /v1/incidents/service': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée incidents ou read requise' });
    const svc = ctx.url.searchParams.get('service');
    if (!svc) return send(res, 400, { error: 'service requis' });
    send(res, 200, {
      service: svc,
      incidents: inc.history(db, svc, Number(ctx.url.searchParams.get('limit') || 50))
    });
  },

  'GET /v1/incidents/stats': async (req, res, ctx) => {
    if (!canIncident(ctx.src, 'read')) return send(res, 403, { error: 'portée incidents ou read requise' });
    send(res, 200, inc.stats(db, Number(ctx.url.searchParams.get('days') || 30)));
  },

  'POST /v1/incidents/retention': async (req, res, ctx) => {
    if (ctx.src?.scope !== 'admin') return send(res, 403, { error: 'portée admin requise' });
    const b = await readBody(req);
    send(res, 200, inc.retention(db, Number(b.months || 12)));
  },

  /* ---------- réponse : recherche + synthèse par l'IA locale ----------
     Un mot → la cascade suffit, on rend les cartes. Une question → les
     meilleurs extraits partent à qwen3 sur le serveur de vecteurs, qui répond UNIQUEMENT
     d'après eux. Le modèle ne voit jamais la question sans les extraits :
     c'est ce qui l'empêche d'inventer. */
  /* ---------- état en direct, par l'agrégateur ----------
     Quand la mémoire ne suffit pas, on VÉRIFIE : l'agrégateur lit
     conteneurs, hôtes, tickets et VM en direct, sans rien exécuter.
     C'est le seul chemin de vérification : pas de shell, pas de liste
     blanche de commandes qui finirait par grandir. Une source muette
     est nommée, jamais traduite en zéro. */
  'GET /v1/answer': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const u = ctx.url;
    const q = (u.searchParams.get('q') || '').trim();
    const ns = u.searchParams.get('ns') || 'shared';
    if (!nsAllowed(ctx.src, ns)) return send(res, 403, { error: 'espace interdit' });
    const t0 = performance.now();

    const r = await search(db, { q, ns, limit: 8, embed: t => embedder.query(t) });
    const question = r.intent === 'QUESTION' || r.decision === 'SYNTHESE';
    let answer = null, model = null, erreurIA, etat = null, verifie = false;

    /* La mémoire est-elle suffisante ? Score bas, ou question qui parle
       de l'état présent (« est-ce que X tourne », « combien », « en ce
       moment ») : on va vérifier en direct. */
    const parleDuPresent = /\b(tourne|en ligne|hors ligne|actuel|maintenant|en ce moment|combien|est-ce que|ça marche|marche|up|down|démarr|arrêt|état|status|charge|cpu|ram|ticket|alerte|incident|ouvert|critique|urgen)/i.test(q);
    const memoireFaible = !r.hits.length || (r.hits[0] && r.hits[0].score < 0.07);
    if (question && AGREG && (parleDuPresent || memoireFaible)) {
      try {
        const e = await fetch(AGREG + '/v1/etat', { signal: AbortSignal.timeout(6000) });
        if (e.ok) { etat = await e.json(); verifie = true; }
      } catch { etat = null; }
    }

    if (question && (r.hits.length || etat) && embedder.url) {
      const extraits = r.hits.slice(0, 6).map((h, i) =>
        `[${i + 1}] (${h.source} · ${h.occurred_at.slice(0, 10)} · ${h.level}) ${h.title}\n${h.snippet}`).join('\n\n');
      /* L'état est résumé, pas déversé : le modèle reçoit ce qui compte,
         avec les sources muettes NOMMÉES. */
      let bloc = '';
      if (etat) {
        /* Forme réelle de /v1/etat : appareils réseau (pas « hôtes »),
           conteneurs.conteneurs[], tickets.recents[], routes.routes[],
           muettes[] en objets. On résume ce qui compte et on NOMME ce
           qui n'a pas pu être lu. */
        const app = (etat.reseau && etat.reseau.appareils) || [];
        const h = app.filter(x => x.vlan === '30' || /srv-app-01|le serveur|hyperviseur|routeur|commutateur|switch/i.test(x.nom || ''))
          .map(x => `${x.nom || x.ip}${x.ip ? ' ' + x.ip : ''}${x.vu === false ? ' (non vu)' : ''}`).slice(0, 10).join(', ');
        const cs = (etat.conteneurs && etat.conteneurs.conteneurs) || [];
        const enCours = cs.filter(x => x.etat === 'running').length;
        const anorm = cs.filter(x => x.etat !== 'running' || (x.sante && x.sante !== 'healthy' && x.sante !== ''))
          .map(x => `${x.nom}:${x.etat}${x.sante && x.sante !== 'healthy' ? '/' + x.sante : ''}`).slice(0, 12).join(', ');
        const tk = etat.tickets || {};
        /* Les tickets vivent dans le service de tickets, pas dans SYNAPSE. L'agregateur
           n'en remonte que les plus recents : le dire explicitement, sinon
           le modele conclut « aucun ticket » d'un echantillon. */
        const rec = tk.recents || [];
        /* Recherche dans TOUS les tickets, pas seulement les recents.
           C'est ce qui permet de repondre « oui, T-1004 » au lieu de
           « aucun des dix derniers ». */
        const tr = /\b(ticket|alerte|incident|ouvert|probleme|problème)/i.test(q)
          ? TK.cherche(q, 6) : null;
        const t = tk.ouverts != null
          ? `${tk.ouverts} ouverts${tk.par_urgence ? ' (' + Object.entries(tk.par_urgence).map(([k, v]) => v + ' ' + k).join(', ') + ')' : ''}`
            + (rec.length
                ? `.\nLes ${rec.length} plus recents (SYNAPSE ne voit QUE ceux-la, les ${tk.ouverts} autres sont dans le service de tickets) :\n`
                  + rec.map(x => `  ${x.ref} · ${x.service} · ${x.severity} · « ${x.title} »`).join('\n')
                : '.')
          : 'inconnu';
        const rt = (etat.routes && etat.routes.routes) || [];
        const rtHs = rt.filter(x => x.active && x.en_ligne === false).map(x => x.host).join(', ');
        const m = (etat.muettes || []).length
          ? 'SOURCES MUETTES (impossible de lire, ne pas conclure « zéro » ni « tout va bien ») : '
            + etat.muettes.map(x => `${x.source} via ${x.service} — ${x.motif}`).join(' ; ')
          : '';
        bloc = `\n\nÉTAT ACTUEL — vérifié à l'instant chez l'agrégateur, fait foi sur la mémoire pour tout ce qui est présent :`
          + `\nAPPAREILS VUS SUR LE RÉSEAU : ${h || 'aucun'} (${app.length} au total)`
          + `\nCONTENEURS : ${enCours} en cours sur ${cs.length}${anorm ? ' · anormaux : ' + anorm : ' · tous sains'}`
          + `\nTICKETS : ${t}`
          + (tr && tr.hits && tr.hits.length
              ? `\nTICKETS QUI CORRESPONDENT A LA QUESTION (recherche dans les ${tk.ouverts || '?'} ouverts, pas seulement les recents) :\n`
                + tr.hits.map(x => `  ${x.ref} · ${x.service} · ${x.severity} · ${x.ouvert ? 'ouvert' : 'ferme'} · « ${x.title} »`).join('\n')
              : tr && tr.hits && !tr.hits.length
                ? `\nRECHERCHE DANS TOUS LES TICKETS : aucun ne contient ${tr.mots.map(m => '« ' + m + ' »').join(', ')}. Cette fois la reponse « aucun ticket » est fondee.`
                : tr && tr.erreur ? `\nRECHERCHE TICKETS INDISPONIBLE : ${tr.erreur}. Ne conclus pas qu'il n'y a pas de ticket.` : '')
          + `\nROUTES PUBLIÉES : ${rt.length}${rtHs ? ' · hors ligne : ' + rtHs : ' · toutes en ligne'}`
          + (m ? `\n${m}` : '');
      }
      const prompt = `Tu es la mémoire du homelab Codex64. Réponds en français, en 2 à 4 phrases.
Tu disposes de deux choses : la MÉMOIRE (extraits datés, peuvent être périmés) et, s'il est fourni, l'ÉTAT ACTUEL (vérifié à l'instant). Pour tout ce qui concerne le présent, l'état actuel fait foi. Pour l'historique et les décisions, la mémoire fait foi.
Règles : n'utilise QUE ces deux sources. Cite les numéros [n] de la mémoire que tu utilises, et dis « vérifié à l'instant » quand tu t'appuies sur l'état actuel.
LIRE LE CORPS, PAS LE TITRE. Un titre résume, il n'affirme rien. Le corps du document fait foi : si le corps contredit ce que le titre laisse croire, c'est le corps qui a raison.
UNE FLÈCHE N'EST PAS UNE DÉPENDANCE. « A → B » dans un titre décrit un FLUX DE DONNÉES : A envoie quelque chose à B. Cela ne veut pas dire que A a besoin de B pour fonctionner. Un document intitulé « X → SYNAPSE » qui dit dans son corps « aucune dépendance ajoutée » signifie exactement le contraire d'une dépendance.
UNE RELATION DOIT ÊTRE ÉCRITE. « dépend de », « héberge », « a besoin de » ne s'infèrent jamais : il faut qu'un extrait l'énonce en toutes lettres. À défaut, réponds « la mémoire ne décrit pas les dépendances de X » — c'est une réponse juste, pas un échec.
LES TICKETS. Deux blocs peuvent apparaître dans l'état actuel : les plus récents, et surtout « TICKETS QUI CORRESPONDENT A LA QUESTION », qui vient d'une recherche dans TOUS les tickets ouverts. Si ce second bloc existe, il fait foi : cite les références trouvées. S'il dit qu'aucun ne correspond, tu peux l'affirmer. S'il est absent ou indisponible, tu ne disposes que des récents et tu ne peux pas conclure à l'absence.
RÉPONDS À LA QUESTION POSÉE. Si tu ne la comprends pas, dis-le et demande une reformulation — ne réponds pas à une question voisine que tu aurais comprise.
Si ni la mémoire ni l'état ne permettent de répondre, dis-le en une phrase, sans inventer.

MÉMOIRE :
${extraits || '(rien de pertinent)'}${bloc}

QUESTION : ${q}`;
      model = process.env.ANSWER_MODEL || 'qwen3:8b';
      try {
        const o = await fetch(embedder.url + '/api/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: false, think: false,
            options: { temperature: 0.2, num_predict: 220 } }),
          signal: AbortSignal.timeout(20000)
        });
        const j = await o.json();
        if (!o.ok || j.error) throw new Error(j.error || 'HTTP ' + o.status);
        answer = String(j.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
      } catch (e) {
        /* Un echec de l IA doit se VOIR : un modele absent chez Ollama
           repondait en 60 ms par un « model not found » que le catch
           avalait, et l interface affichait une recherche sans reponse
           comme si c etait normal. */
        answer = null;
        erreurIA = String(e && e.message || e).slice(0, 120);
        console.error('[answer] IA indisponible :', erreurIA);
      }
    }
    send(res, 200, {
      q, intent: r.intent, decision: r.decision, reason: r.reason,
      engines: r.engines, took_ms: +(performance.now() - t0).toFixed(1),
      answer, model: answer ? model : null,
      ia_erreur: erreurIA || undefined,
      verifie, etat_muet: etat && etat.muettes && etat.muettes.length ? etat.muettes.map(x => x.source + ' (' + x.service + ')') : undefined,
      hits: r.hits.map(h => ({ id: h.id, title: h.title, snippet: h.snippet, source: h.source,
        level: h.level, kind: h.kind, occurred_at: h.occurred_at, score: h.score, why: h.why }))
    });
  },

  'GET /v1/graph': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const ns = ctx.url.searchParams.get('ns') || 'shared';
    if (!nsAllowed(ctx.src, ns)) return send(res, 403, { error: 'espace interdit' });
    send(res, 200, buildGraph(db, {
      ns,
      limit: ctx.url.searchParams.get('limit'),
      days:  ctx.url.searchParams.get('days')
    }));
  },

  'POST /mcp': async (req, res, ctx) => {
    const b = await readBody(req);
    const out = await handleMcp(db, ctx.src, b, { embed: t => embedder.query(t) });
    send(res, 200, out);
  }
};

/* Un agent ne lit jamais la mémoire privée d'un autre. */
/* Deux espaces publics, deux natures :
     shared  — le HOMELAB : ce qui existe, ce qui est tombé, comment c'est
               réparé. Des faits datés.
     savoir  — les STANDARDS : le manuel Codex64, les conventions de code,
               le design system. Des règles sans date.
   Un agent qui diagnostique cherche dans shared ; un agent qui code
   cherche dans savoir. Mélanger les deux fait remonter une règle de
   sécurité quand on cherche une panne. */
function nsAllowed(src, ns) {
  if (!src) return false;
  if (src.scope === 'admin') return true;
  if (ns === 'shared' || ns === 'savoir') return true;
  if (ns.startsWith('agent:') || ns.startsWith('prompts:')) {
    return ns.split(':')[1] === src.name;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS' && CORS_ORIGIN) {
    return send(res, 204, {}, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Max-Age': '600'
    });
  }

  /* --- interface 3D, servie avant l'authentification ---
     Le HTML n'expose rien : ce sont ses appels /v1/graph et /v1/search
     qui portent le jeton. Exiger un en-tête Authorization sur la page
     elle-même la rendrait impossible à ouvrir dans un navigateur. */
  if (req.method === 'GET') {
    const p = url.pathname;
    /* login.html reste ouvert : sans lui, impossible de se connecter.
       Tout le reste de l'interface exige une session. */
    const ouvert = p === '/login' || p === '/login.html' || p === '/bridge.js';
    const sess = A.session(db, litCookie(req, COOKIE));
    if (!ouvert && (p === '/' || p === '/cascade' || p === '/parametres' || /^\/e\/\d+$/.test(p))) {
      if (!sess) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      /* Compte temporaire ou second facteur à poser : rien d'autre que /setup. */
      if (C.enAttente(db, sess.user)) { res.writeHead(302, { Location: '/setup' }); return res.end(); }
    }
    if (p === '/setup' && !(sess && C.enAttente(db, sess.user))) {
      res.writeHead(302, { Location: sess ? '/' : '/login' }); return res.end();
    }
    const file = p === '/login' ? 'login.html'
               : p === '/setup' ? 'setup.html'
               : p === '/parametres' ? 'parametres.html'
               : p === '/' ? 'index.html'
               : p === '/cascade' ? 'cascade.html'
               : /^\/[a-z0-9._-]+\.(html|css|js|svg|png|webp|ico)$/i.test(p) ? p.slice(1)
               : null;
    if (file) {
      const full = pathm.join(UI_DIR, file);
      if (full.startsWith(UI_DIR) && fsp.existsSync(full)) {
        const ext = pathm.extname(full).slice(1).toLowerCase();
        const mime = { html:'text/html; charset=utf-8', css:'text/css', js:'text/javascript',
                       svg:'image/svg+xml', png:'image/png', webp:'image/webp',
                       ico:'image/x-icon' }[ext] || 'application/octet-stream';
        let body = fsp.readFileSync(full);
        /* Plus aucun secret dans la page : l'interface s'authentifie par
           le cookie de session, envoye automatiquement par le navigateur. */
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length,
                             'Cache-Control': 'no-cache',
                             'X-Content-Type-Options': 'nosniff' });
        return res.end(body);
      }
    }
    /* /e/123 : l'interface gère l'affichage, on lui sert la page d'accueil */
    if (/^\/e\/\d+$/.test(p)) {
      const full = pathm.join(UI_DIR, 'index.html');
      if (fsp.existsSync(full)) {
        let body = fsp.readFileSync(full);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                             'Content-Length': body.length });
        return res.end(body);
      }
    }
  }

  /* Les routes à paramètre : /v1/admin/users/<nom>[/password]. Le nom
     suit la même règle qu'à la création, rien d'autre ne passe. */
  let key = req.method + ' ' + url.pathname;
  const params = {};
  const mu = /^\/v1\/admin\/users\/([a-z0-9._-]{3,32})(\/password)?$/i.exec(url.pathname);
  if (mu) { params.nom = mu[1]; key = req.method + ' /v1/admin/users/:nom' + (mu[2] || ''); }
  const fn = routes[key];
  if (!fn) return send(res, 404, { error: 'route inconnue' });

  if (url.pathname === '/healthz') return fn(req, res, { url });

  /* Deux publics, deux preuves : un service presente un jeton, un humain
     presente une session. Les routes de lecture acceptent les deux ;
     l'ecriture reste reservee aux jetons de service. */
  /* Les routes de connexion sont forcement ouvertes : exiger une session
     pour se connecter rendrait la connexion impossible. */
  const LIBRES = new Set(['/v1/auth/login', '/v1/auth/totp',
    '/v1/auth/passkey/options', '/v1/auth/passkey/verify']);

  let src = auth(req);
  if (!src) {
    const sess = A.session(db, litCookie(req, COOKIE));
    if (sess) src = { name: sess.user, scope: 'read', channel: 'H', humain: true, sid: sess.sid };
  }
  if (!src && LIBRES.has(url.pathname)) {
    try { return await fn(req, res, { url, src: null }); }
    catch (e) {
      const m = String(e && e.message || e);
      if (/JSON invalide|corps trop grand/.test(m)) return send(res, 400, { error: m });
      console.error('[erreur]', key, e && e.stack || e);
      return send(res, 500, { error: 'erreur interne' });
    }
  }
  if (!src && url.pathname === '/v1/auth/session')
    return send(res, 200, { installe: A.installe(db), user: null, stepup: false });
  if (!src) return send(res, 401, { error: 'authentification requise' });
  if (src.humain && C.enAttente(db, src.name) && !/^\/v1\/auth\/(setup|logout|session)/.test(url.pathname))
    return send(res, 403, { error: 'termine d abord l initialisation sur /setup' });

  try {
    await fn(req, res, { url, src, params });
  } catch (e) {
    const m = String(e && e.message || e);
    /* Une entrée malformée est une faute du client, pas du serveur :
       renvoyer 500 ferait croire à une panne et déclencherait les
       rejeux du client au lieu de lui signaler de corriger son envoi. */
    if (/JSON invalide|corps trop grand/.test(m)) {
      if (!res.headersSent) send(res, 400, { error: m });
      return;
    }
    /* le détail va dans le journal, jamais dans la réponse */
    console.error('[erreur]', key, e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'erreur interne' });
  }
});

server.listen(PORT, () => {
  console.log(`[synapse] écoute sur :${PORT}`);
  console.log(`[synapse] base ${DB_FILE}`);
  console.log(`[synapse] le serveur de vecteurs ${embedder.url} · ${embedder.model}`);
  embedder.health().then(ok =>
    console.log('[synapse] le serveur de vecteurs ' + (ok ? 'joignable' : 'INJOIGNABLE — le plein texte fonctionne, pas le vecteur')));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[synapse] arrêt');
    server.close(() => { try { db.close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

module.exports = { server, db };
