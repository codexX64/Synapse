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
const { search, parse: analyseRequete } = require('./search.js');
const { Embedder, startWorker } = require('./embed.js');
const { handleMcp } = require('./mcp.js');
const { buildGraph } = require('./graph.js');
const inc = require('./incidents.js');
const neu = require('./neurons.js');
const APP = require('./apprentissage.js');
const MOI = require('./moi.js');
const CER = require('./cerveaux.js');
const SRC = require('./sources.js');
const LLM = require('./llm.js');
const { migrerComptes } = require('./migration-socle.js');
const { SCHEMAS } = require('./schemas.js');
const ACT = require('./activite.js');
const { blobToVec } = require('./db.js');
const fsp = require('node:fs');
const pathm = require('node:path');

const RACINE = pathm.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
/* Signalement privé d'une faille, sur le dépôt : lu par le mainteneur. */
const CONTACT_SECURITE = 'https://github.com/CodexX64/synapse/security/advisories/new';

const PORT     = Number(process.env.PORT || 8140);
const DB_FILE  = process.env.DB_FILE || '/data/synapse.db';
const MAX_BODY = Number(process.env.MAX_BODY || 2_000_000);
const QUEUE_MAX = Number(process.env.QUEUE_MAX || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const UI_DIR = process.env.UI_DIR || '/app/ui';
const AGREG = (process.env.AGREG_URL || '').replace(/\/$/, '');
/* Les tickets vivent dans le service de tickets. L'agregateur n'en remonte que les dix
   plus recents : sur 42 ouverts, une question sur un ticket precis
   tombait a cote. SYNAPSE lit donc la base du service de tickets en lecture seule. */
const TK = require('./tickets.js');
const RG = require('./rangement.js');
const CFG = require('./config.js');
const TACHE = require('./tache.js');
const PLANIF = require('./planif.js');

/* Reecriture d'un titre faible par le modele local. Le modele ne
   choisit pas quoi garder : il tire le FOND de l'extrait qu'on lui
   donne. Un titre invente serait pire que le titre vague. */
/* Une seule taille de contexte pour tous les appels au modèle. Ollama
   recharge le modèle dès que num_ctx change : des réponses au contexte par
   défaut et des passes de fond à un autre contexte se faisaient recharger
   un 14b à tour de rôle — d'où les délais dépassés. Le défaut d'Ollama
   (2 à 4 k jetons) tronquait en plus, sans le dire, les lots d'échanges. */
const CTX_MODELE = Number(process.env.OLLAMA_NUM_CTX || 8192);
const GARDE = process.env.ANSWER_KEEP_ALIVE || '30m';

async function reecritTitre(entree) {
  let t = (await LLM.genere({
    system: `Tu rediges des titres pour une base de connaissances technique.
Un bon titre enonce le FOND : ce que le document affirme, pas le sujet qu'il aborde.
« Installation » est mauvais. « api-interne s'installe par compose, sans base externe » est bon.
Reponds par le titre seul : pas de guillemets, pas de point final, 6 a 14 mots, en francais.
Si l'extrait ne permet pas d'ecrire un titre precis, reponds exactement : RIEN`,
    prompt: `Titre actuel, trop vague : ${entree.title}\n\nDebut du document :\n${entree.extrait}\n\nEcris le titre.`,
    maxTokens: 60, timeout: 90000,
  })).split('\n')[0];
  t = t.replace(/^["'«»\s]+|["'«»\s.]+$/g, '').trim();
  if (/^RIEN\b/i.test(t) || t.length < 20) return null;
  if (t.toLowerCase() === String(entree.title).toLowerCase()) return null;
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
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
  /* Passe de fond : personne n'attend. Le délai couvre un chargement du
     modèle à froid, pas une réponse lente à une question. */
  return LLM.genere({ prompt: `${consigne}\n\n---\n${texte}`, json: true, temperature: 0.1, maxTokens: 1000,
    timeout: Number(process.env.APPRENTISSAGE_TIMEOUT || 180000) });
}

function amorcerSourceHub(db) {
  const jeton = process.env.HUB_TOKEN_SEED;
  if (jeton && String(jeton).length >= 16) {
    const hash = crypto.createHash('sha256').update(String(jeton)).digest('hex');
    db.prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at)
                VALUES ('hub',?,'read+write','A',?)
                ON CONFLICT(name) DO UPDATE SET token_hash=excluded.token_hash, scope=excluded.scope, enabled=1`)
      .run(hash, new Date().toISOString());
  }
  /* La source « hub-admin » de la 1.x portait le jeton d'administration des
     comptes avec la portée admin sur toute l'API. Ce jeton ne sert plus
     qu'au socle (SOCLE_JETON_ADMIN_HUB) : la source est retirée. */
  const r = db.prepare(`DELETE FROM sources WHERE name = 'hub-admin' AND channel = 'A'`).run();
  if (Number(r.changes)) console.log('[synapse] source « hub-admin » de la 1.x retirée : les comptes se gèrent par le socle.');
}

const db = open(DB_FILE);
inc.migrate(db);
neu.migrate(db);
APP.migrate(db);
ACT.migrate(db);
MOI.migrer(db);
CER.migrate(db);
amorcerSourceHub(db);
setInterval(() => ACT.purge(db), 600000).unref?.();
PLANIF.demarre(db, reecritTitre);
const embedder = new Embedder();
startWorker(db, embedder);

/* ---------- apprentissage de fond ----------
   Titrer les échanges puis en distiller la fiche : deux appels au modèle,
   jamais pendant qu'on pose une question, et jamais deux passes à la fois
   — Ollama n'a qu'un GPU, deux passes simultanées se ralentissent l'une
   l'autre sans rien gagner.

   Une passe part : peu après chaque échange reçu (le temps qu'une rafale
   se termine), toutes les 30 minutes par sécurité, et sur demande depuis
   l'interface. Sans cela, la fiche n'évoluait qu'une fois par demi-heure
   au mieux, et on ne voyait jamais rien bouger. */
const CONSOLIDATION_MS = Number(process.env.CONSOLIDATION_INTERVAL || 1800000);
const APRES_ECHANGE_MS = Number(process.env.APPRENTISSAGE_DELAI || 60000);
/* Après un échange, on titre tout de suite (un appel court) ; la fiche,
   elle, attend d'avoir un peu de matière — relire le modèle sur un seul
   échange coûte autant qu'en relire dix, pour moins de sens. */
const ECHANGES_AVANT_FICHE = Number(process.env.APPRENTISSAGE_LOT || 3);
const enAttenteDeFiche = () => db.prepare(
  `SELECT count(*) n FROM entries e WHERE kind='echange'
     AND id > COALESCE((SELECT c.dernier_id FROM consolidation c WHERE c.agent=json_extract(e.meta,'$.agent')),0)`).get().n;
let passeEnCours = null;
let dernierePasse = null;
let derniereUtile = null;   /* la dernière passe qui a appris quelque chose */
let minuteurEchange = null;
function passeApprentissage(raison) {
  /* Une demande manuelle pendant une passe de fond ne s'y greffe pas :
     elle aurait reçu le résultat d'une passe lancée avant elle (et avant
     une éventuelle remise à zéro). Elle attend son tour. */
  if (passeEnCours && (raison === 'manuel' || raison === 'relecture'))
    return passeEnCours.catch(() => {}).then(() => passeApprentissage(raison));
  if (passeEnCours) return passeEnCours;
  passeEnCours = (async () => {
    const t0 = Date.now();
    const bilan = { raison, titres: 0, lus: 0, traits: [], oublies: [], erreur: null };
    try {
      for (let i = 0; i < 6; i++) {
        const r = await MOI.titrerEchanges(db, { demander: demanderAuModele });
        bilan.titres += r.titres;
        if (r.raison) { bilan.erreur = r.raison; break; }
        if (!r.restants || !r.titres) break;
      }
      if (raison !== 'échange' || enAttenteDeFiche() >= ECHANGES_AVANT_FICHE) {
        /* Par lots : un lot tient dans le contexte ; tout relire en un
           seul appel dépassait le contexte ou le délai. */
        for (let i = 0; i < 8; i++) {
          const c = await APP.consoliderTous(db, { demander: demanderAuModele });
          bilan.lus += c.lus || 0;
          bilan.traits.push(...(c.traits || []));
          bilan.oublies.push(...(c.oublies || []));
          if (c.raison && c.raison !== 'rien de nouveau') { bilan.erreur = bilan.erreur || c.raison; break; }
          if (!c.lus || !enAttenteDeFiche()) break;
        }
      }
      /* Le ménage, quand la fiche a bougé ou qu'on l'a demandé. */
      if (bilan.traits.length || raison === 'manuel' || raison === 'relecture' || raison === 'démarrage') {
        const m = await APP.menage(db, { demander: demanderAuModele });
        bilan.oublies.push(...m.oublies.map(cle => ({ portee: 'commun', cle })));
        bilan.fusions = m.fusions;
        if (m.erreur) bilan.erreur = bilan.erreur || m.erreur;
      }
      /* Une passe demandée à la main se journalise toujours, même vide :
         « rien ne s'est passé » est une réponse, le silence n'en est pas une. */
      if (bilan.titres || bilan.traits.length || bilan.oublies.length || bilan.erreur || raison !== 'périodique')
        console.log(`[synapse] apprentissage (${raison}) : ${bilan.titres} titre(s), ${bilan.traits.length} trait(s), ${bilan.oublies.length} oublié(s), ${(bilan.fusions || []).length} fusion(s) sur ${bilan.lus} échange(s)${bilan.erreur ? ' — ' + bilan.erreur : ''}`);
    } catch (e) {
      bilan.erreur = e.message;
      console.warn('[synapse] apprentissage', e.message);
    }
    dernierePasse = { ...bilan, le: new Date().toISOString(), ms: Date.now() - t0 };
    if (bilan.titres || bilan.traits.length || bilan.oublies.length) derniereUtile = dernierePasse;
    return dernierePasse;
  })().finally(() => { passeEnCours = null; });
  return passeEnCours;
}
function apresEchange() {
  clearTimeout(minuteurEchange);
  minuteurEchange = setTimeout(() => passeApprentissage('échange'), APRES_ECHANGE_MS);
  minuteurEchange.unref?.();
}
if (CONSOLIDATION_MS > 0) setInterval(() => passeApprentissage('périodique'), CONSOLIDATION_MS).unref?.();
/* Au démarrage : rattraper les échanges arrivés titrés par leur question. */
setTimeout(() => passeApprentissage('démarrage'), 30000).unref?.();

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
  if (row) return row.enabled ? row : null;
  return jetonDeCerveau(brut, hash);
}

/* Un jeton de cerveau (cer_<nom>_<hmac>), dérivé par le Hub du jeton qu'il
   a semé ici. Vérifié par le calcul, puis enregistré comme une source
   ordinaire — canal D — pour apparaître, se désactiver et se compter comme
   les autres. Il ne peut pas prendre le nom d'une source qui existe déjà
   sous un autre canal (le Hub, TRIAGE…). */
function jetonDeCerveau(brut, hash) {
  const nom = CER.verifieJeton(process.env.HUB_TOKEN_SEED, brut);
  if (!nom) return null;
  const deja = db.prepare(`SELECT name, channel, enabled FROM sources WHERE name = ?`).get(nom);
  if (deja && deja.channel !== 'D') return null;
  if (deja && !deja.enabled) return null;
  db.prepare(`INSERT INTO sources(name,token_hash,scope,channel,created_at) VALUES (?,?,'read+write','D',?)
              ON CONFLICT(name) DO UPDATE SET token_hash=excluded.token_hash`).run(nom, hash, new Date().toISOString());
  return { name: nom, scope: 'read+write', channel: 'D', enabled: 1 };
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
  /* Une origine déclarée appelle l'API avec un jeton, jamais avec les
     cookies de session : pas d'Allow-Credentials. */
  if (CORS_ORIGIN) {
    h['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    h['Vary'] = 'Origin';
  }
  res.writeHead(code, h);
  res.end(body);
}

/* Le corps est lu par le socle — JSON exigé pour une écriture, taille
   annoncée refusée en 413 avant toute lecture, puis bornée en lisant — à la
   limite de la route (64 Kio par défaut, MAX_BODY pour ce qui porte des
   documents), puis validé contre son schéma (src/schemas.js) : champ
   inconnu, type ou longueur hors bornes → 400. */
const routeDe = new WeakMap();
async function readBody(req) {
  const r = routeDe.get(req) || {};
  const brut = await socle.S.lireCorps(req, { limite: r.grand ? MAX_BODY : r.limite || 64 * 1024 });
  return r.corps ? socle.S.valider(brut, r.corps) : brut;
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
    // Qui écrit ici, combien, depuis quand : des noms et des comptes, jamais un contenu.
    if (ctx.url.searchParams.get('scope') === 'sources')
      return send(res, 200, { sources: SRC.parSource(db) });
    if (ctx.url.searchParams.get('scope') === 'neurons')
      return send(res, 200, neu.stats(db, Number(ctx.url.searchParams.get('days') || 30)));
    /* Ce que l'interface affiche dans son panneau d'instrumentation :
       activité mesurée et apprentissage, rien d'écrit à l'avance. */
    if (ctx.url.searchParams.get('scope') === 'activite')
      return send(res, 200, {
        activite: ACT.resume(db, { jours: Math.min(30, Number(ctx.url.searchParams.get('days') || 7)) }),
        apprentissage: APP.resumeGlobal(db, { limite: 6 }),
        embedder: { model: embedder.model, ok: embedder.ok },
        redacteur: LLM.etat(),
        chunks: {
          embedded: db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=1`).get().n,
          pending: db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=0`).get().n,
        },
        links: db.prepare(`SELECT count(*) n FROM links`).get().n,
      });
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
    const ns = espaceEcrit(ctx.src, body.ns);
    if (!ns) return send(res, 403, { error: 'espace interdit : ' + String(body.ns).slice(0, 80) });
    const r = ingest.insert(db, { ...body, ns }, ctx.src.name);
    if (!r.ok && r.filtered) return send(res, 202, { filtered: true, reason: r.reason });
    if (!r.ok) return send(res, 400, { error: r.reason || 'refusé' });
    send(res, 202, r);
  },

  'POST /v1/ingest/batch': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > 200) return send(res, 400, { error: 'lot > 200' });
    if (!rateLimit('ing:' + ctx.src.name, 600, 60000))
      return send(res, 429, { error: 'trop de requêtes' }, { 'Retry-After': '10' });
    const pending = db.prepare(`SELECT count(*) n FROM chunks WHERE embedded=0`).get().n;
    if (pending > QUEUE_MAX)
      return send(res, 429, { error: 'file saturée', pending }, { 'Retry-After': '30' });
    const out = [];
    for (const e of events) {
      const ns = espaceEcrit(ctx.src, e && e.ns);
      out.push(ns ? ingest.insert(db, { ...e, ns }, ctx.src.name) : { ok: false, reason: 'espace interdit' });
    }
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
    ACT.noter(db, { route: 'search', source: ctx.src.name, compte: ctx.src.compte, q: u.searchParams.get('q') || '',
      ms: r.took_ms, decision: r.decision, arret: ACT.etageDe(r), hits: r.hits.length });
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
    if (!liables(ctx.src, Number(b.from_id), Number(b.to_id))) return send(res, 403, { error: 'espace interdit' });
    const r = ingest.link(db, Number(b.from_id), Number(b.to_id), String(b.relation), ctx.src.name);
    send(res, r.ok ? 201 : 400, r);
  },

  'POST /v1/click': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const b = await readBody(req);
    const q = String(b.q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const id = Number(b.entry_id);
    if (!q || !id) return send(res, 400, { error: 'q et entry_id requis' });
    const e = db.prepare(`SELECT ns FROM entries WHERE id=?`).get(id);
    if (!e || !nsAllowed(ctx.src, e.ns)) return send(res, 404, { error: 'introuvable' });
    db.prepare(`INSERT INTO query_clicks(query_norm,entry_id,n) VALUES(?,?,1)
                ON CONFLICT(query_norm,entry_id) DO UPDATE SET n=n+1`).run(q, id);
    send(res, 204, {});
  },

  'GET /v1/prompts': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const agent = agentDe(ctx.src, ctx.url.searchParams.get('agent'));
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
    exigerHumain(ctx.src, { role: 'admin', renfort: true });
    const b = await readBody(req);
    /* Un jeton vide n'efface pas celui qui est en place : la page
       n'affiche qu'une empreinte, elle ne peut pas le renvoyer. */
    if (b.telegram_token === '' || b.telegram_token === undefined) delete b.telegram_token;
    let c;
    try { c = CFG.ecrit(db, b); } catch (e) { if (e.status === 400) return send(res, 400, { error: e.message }); throw e; }
    journaliser(ctx.src, 'reglages.rangement', 'rangement', { jetonTelegram: b.telegram_token !== undefined });
    send(res, 200, { ok: true, config: CFG.public_(c) });
  },

  'POST /v1/rangement/telegram/test': async (req, res, ctx) => {
    exigerHumain(ctx.src, { role: 'admin' });
    const b = await readBody(req);
    if (b.token && !CFG.TELEGRAM_JETON.test(String(b.token))) return send(res, 400, { error: 'jeton Telegram : la forme donnée par @BotFather' });
    if (b.chat && !CFG.TELEGRAM_CHAT.test(String(b.chat))) return send(res, 400, { error: 'conversation Telegram : un identifiant numérique ou @nom' });
    const c = CFG.lit(db);
    const r = await PLANIF.testeTelegram(b.token || c.telegram_token, b.chat || c.telegram_chat);
    send(res, r.ok ? 200 : 400, r);
  },

  'POST /v1/rangement/lancer': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    const cfg = CFG.lit(db);
    const r = await TACHE.lance(db, cfg, { reecrit: reecritTitre, source: 'manuel' });
    send(res, r.refus ? 409 : 202, r.refus ? { error: r.refus } : { ok: true });
  },

  'POST /v1/rangement/pause': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    send(res, 200, { ok: TACHE.metEnPause(), etat: TACHE.statut().etat });
  },

  'POST /v1/rangement/reprendre': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    send(res, 200, { ok: TACHE.reprend(), etat: TACHE.statut().etat });
  },

  'POST /v1/rangement/arreter': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    TACHE.interrompt(); TACHE.jettePlan();
    send(res, 200, { ok: true });
  },

  'POST /v1/rangement/valider': async (req, res, ctx) => {
    exigerHumain(ctx.src, { renfort: true });
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
    catch (e) { console.error('[rangement] sauvegarde impossible :', e.message); return send(res, 500, { error: 'sauvegarde impossible : rien n’a été appliqué' }); }
    const fait = RG.applique(db, plan);
    send(res, 200, { ...fait, sauvegarde: sauve });
  },

  'GET /v1/rangement/analyse': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const ns = ctx.url.searchParams.get('ns') || null;
    /* Tous les espaces à la fois : une personne connectée ou un jeton admin ;
       un service n'analyse que ceux qu'il lit. */
    if (ns ? !nsAllowed(ctx.src, ns) : !(ctx.src.humain || ctx.src.scope === 'admin'))
      return send(res, 403, { error: 'espace interdit' });
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
    exigerHumain(ctx.src, { renfort: true });
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
    try { sauve = RG.sauvegarde(db); } catch (e) { console.error('[rangement] sauvegarde impossible :', e.message); return send(res, 500, { error: 'sauvegarde impossible : rien n’a été appliqué' }); }
    const fait = RG.applique(db, plan);
    send(res, 200, { ...fait, sauvegarde: sauve });
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
    const agent = agentDe(ctx.src, b.agent);
    const ns = b.ns || 'shared';
    if (!nsAllowed(ctx.src, String(ns))) return send(res, 403, { error: 'espace interdit' });
    const tBrief = performance.now();
    const out = await APP.brief(db, {
      agent, q: b.q || b.query || '', ns,
      limite: Math.min(20, Number(b.limit) || 6),
      budget: Math.min(5000, Number(b.budget) || 1200),
      signature: b.signature,
      search, embed: t => embedder.embed(t),
    });
    /* Les autres cerveaux concernés par la question, avec leur état : un
       service qui ne sait pas répondre sait au moins qui sait. */
    out.cerveaux = CER.pourBrief(db, b.q || b.query || '', [agent, ctx.src.name]);
    ACT.noter(db, { route: 'brief', source: ctx.src.name, compte: ctx.src.compte, q: b.q || b.query || '',
      ms: out.ms != null ? out.ms : performance.now() - tBrief, decision: null,
      arret: (out.memoire || []).length ? 'L1' : 'VIDE',
      hits: (out.memoire || []).length });
    send(res, 200, { ...out, texte: [APP.briefTexte(out), CER.texteBrief(out.cerveaux)].filter(Boolean).join('\n') });
  },

  /* Le retour d'expérience de l'assistant : ce qu'il a dit de faux, et
     ce qu'il fallait dire. C'est la seule voie par laquelle une réponse
     ratée cesse de se répéter. */
  'POST /v1/apprendre': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    const agent = agentDe(ctx.src, b.agent);
    const out = {};
    if (b.correction) out.correction = APP.corriger(db, {
      agent, question: b.question || b.q || '', correction: b.correction, faux: b.faux,
    });
    if (b.trait && b.trait.valeur) out.trait = APP.poser(db, {
      agent: b.trait.portee === 'agent' ? agent : APP.COMMUN,
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
    const ns = espaceEcrit(ctx.src, b.ns);
    if (!ns) return send(res, 403, { error: 'espace interdit' });
    const evt = APP.evenementEchange({ agent: agentDe(ctx.src, b.agent), question: b.question, reponse: b.reponse, ns });
    /* Le Hub envoie l'échange deux fois : à la réponse (« rien n'est encore
       fait »), puis après exécution, avec le résultat réel. La seconde
       version remplace la première au lieu de s'y ajouter, et le titre est
       refait d'après ce qui s'est vraiment passé. */
    const avant = db.prepare(`SELECT id, title FROM entries WHERE kind='echange' AND ref=? AND ns=? AND source=? AND occurred_at >= ? ORDER BY id DESC LIMIT 1`)
      .get(evt.ref, evt.ns, ctx.src.name, new Date(Date.now() - 86400000).toISOString());
    if (avant) {
      MOI.remplaceCorps(db, avant.id, evt.body);
      apresEchange();
      return send(res, 202, { ok: true, id: avant.id, updated: true });
    }
    const r = ingest.insert(db, evt, ctx.src.name);
    if (r.ok && !r.duplicate) apresEchange();
    send(res, 202, r);
  },

  /* ---------- ce que SYNAPSE sait de toi ----------
     La fiche (ce qu'un modèle a compris) et les habitudes (ce que les
     données montrent). Lecture pour toute session ; modifier la fiche
     est un geste humain. */
  /* ---------- cerveaux ----------
     Chaque IA de service a sa fiche ici : ce qu'elle sait, ce qu'elle fait,
     ses règles, son état. Le nom vient toujours du jeton : un service ne
     peut écrire que SA fiche. */
  'GET /v1/cerveaux': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    send(res, 200, { cerveaux: CER.tous(db) });
  },
  'PUT /v1/cerveaux/moi': async (req, res, ctx) => {
    if (ctx.src.humain || !can(ctx.src, 'write')) return send(res, 403, { error: 'réservé aux services (portée write)' });
    const r = CER.inscrire(db, ctx.src.name, await readBody(req));
    send(res, r.ok ? 200 : 400, r.ok ? r : { error: r.raison });
  },
  'PUT /v1/cerveaux/moi/etat': async (req, res, ctx) => {
    if (ctx.src.humain || !can(ctx.src, 'write')) return send(res, 403, { error: 'réservé aux services (portée write)' });
    const b = await readBody(req);
    const r = CER.poserEtat(db, ctx.src.name, b.etat);
    send(res, r.ok ? 200 : 409, r.ok ? r : { error: r.raison });
  },
  'DELETE /v1/cerveaux/moi': async (req, res, ctx) => {
    if (ctx.src.humain || !can(ctx.src, 'write')) return send(res, 403, { error: 'réservé aux services (portée write)' });
    send(res, 200, { retire: CER.retirer(db, ctx.src.name) });
  },
  'POST /v1/cerveaux/orienter': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const b = await readBody(req);
    const t0 = performance.now();
    const r = CER.orienter(db, String(b.q || '').slice(0, 2000), { depuis: ctx.src.name, limite: Math.min(5, Number(b.limite) || 3) });
    ACT.noter(db, { route: 'orienter', source: ctx.src.name, compte: ctx.src.compte, q: String(b.q || ''), ms: performance.now() - t0, decision: null, arret: r.cerveaux.length ? 'L0' : 'VIDE', hits: r.cerveaux.length });
    send(res, 200, r);
  },

  'GET /v1/moi': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const traits = APP.profil(db, APP.COMMUN, { seuil: 0.1 }).filter(t => t.portee === 'commun');
    const agents = db.prepare(
      `SELECT agent, count(*) n, max(maj) maj FROM profil WHERE agent <> ? GROUP BY agent ORDER BY maj DESC`).all(APP.COMMUN);
    send(res, 200, {
      traits,
      agents,
      habitudes: MOI.habitudes(db),
      attente: {
        titres: MOI.aTitrer(db, 1000).length,
        echanges: enAttenteDeFiche(),
      },
      passe: dernierePasse,
      derniereUtile,
      enCours: !!passeEnCours,
    });
  },

  'POST /v1/moi/analyser': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    if (!rateLimit('consolider:' + appelant(ctx.src), 4, 60000))
      return send(res, 429, { error: 'une relecture à la fois : attends une minute' }, { 'Retry-After': '30' });
    const b = await readBody(req);
    /* Tout relire : utile quand la consigne a changé, ou pour repartir
       d'une fiche mal partie. La fiche n'est pas vidée — elle est
       relue, corrigée et élaguée par le modèle. */
    if (b && b.toutRelire) db.prepare(`UPDATE consolidation SET dernier_id=0`).run();
    send(res, 200, await passeApprentissage(b && b.toutRelire ? 'relecture' : 'manuel'));
  },

  /* Corriger une fiche : ce que tu écris devient « déclaré », et aucune
     distillation ne l'écrasera ensuite. */
  'PUT /v1/moi/trait': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    const b = await readBody(req);
    const valeur = String(b.valeur || '').trim();
    if (!b.cle || valeur.length < 3) return send(res, 400, { error: 'clé et valeur requises' });
    const r = APP.poser(db, { agent: APP.COMMUN, cle: b.cle, valeur, confiance: 0.9, origine: 'declare' });
    send(res, 200, r || { error: 'refusé' });
  },

  'DELETE /v1/moi/trait': async (req, res, ctx) => {
    exigerHumain(ctx.src);
    const cle = ctx.url.searchParams.get('cle');
    if (!cle) return send(res, 400, { error: 'cle requise' });
    send(res, 200, APP.oublier(db, APP.COMMUN, cle));
  },

  'GET /v1/profil': async (req, res, ctx) => {
    if (!can(ctx.src, 'read')) return send(res, 403, { error: 'portée read requise' });
    const agent = agentDe(ctx.src, ctx.url.searchParams.get('agent')) || 'inconnu';
    send(res, 200, { ...APP.stats(db, agent), traits: APP.profil(db, agent) });
  },

  'DELETE /v1/profil': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const agent = agentDe(ctx.src, ctx.url.searchParams.get('agent')) || 'inconnu';
    const cle = ctx.url.searchParams.get('cle');
    if (!cle) return send(res, 400, { error: 'cle requise' });
    send(res, 200, APP.oublier(db, agent, cle));
  },

  'POST /v1/consolider': async (req, res, ctx) => {
    if (!can(ctx.src, 'write')) return send(res, 403, { error: 'portée write requise' });
    const b = await readBody(req);
    // Sans agent nommé : tout le monde — pour le Hub ou un jeton admin ; un
    // service ne fait relire que ses propres échanges.
    if (!rateLimit('consolider:' + appelant(ctx.src), 4, 60000))
      return send(res, 429, { error: 'une relecture à la fois : attends une minute' }, { 'Retry-After': '30' });
    const agent = agentDe(ctx.src, b.agent) || (relaiHub(ctx.src) ? null : ctx.src.name);
    if (b.ns && !nsAllowed(ctx.src, String(b.ns))) return send(res, 403, { error: 'espace interdit' });
    send(res, 200, agent
      ? await APP.consolider(db, { agent, ns: b.ns || null, demander: demanderAuModele })
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
    /* Un neurone s'oublie par la source qui l'a écrit, ou par un jeton admin. */
    const n = db.prepare(`SELECT source FROM neurons WHERE id=? AND deleted=0`).get(Number(ctx.url.searchParams.get('id')));
    if (n && n.source !== ctx.src.name && ctx.src.scope !== 'admin') return send(res, 403, { error: 'neurone d’une autre source' });
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
    /* La copie entière des neurones, pour une sauvegarde : la seule liste
       sans page, réservée à la portée admin et à deux par minute. */
    if (!rateLimit('export', 2, 60000)) return send(res, 429, { error: 'trop de requêtes' }, { 'Retry-After': '30' });
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
     meilleurs extraits partent au modèle qui rédige, qui répond UNIQUEMENT
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
    /* Une réponse peut coûter un appel à une IA payante : trente par minute
       et par appelant, et le plafond du jour en plus (llm.js). */
    if (!rateLimit('ia:' + appelant(ctx.src), 30, 60000))
      return send(res, 429, { error: 'trop de questions : attends une minute' }, { 'Retry-After': '30' });
    const u = ctx.url;
    const q = (u.searchParams.get('q') || '').trim();
    const ns = u.searchParams.get('ns') || 'shared';
    if (!nsAllowed(ctx.src, ns)) return send(res, 403, { error: 'espace interdit' });
    const t0 = performance.now();

    /* Un résumé lit plus large qu'une réponse : douze extraits au lieu de huit. */
    const redige = analyseRequete(q).redige;
    const r = await search(db, { q, ns, limit: redige ? 12 : 8, embed: t => embedder.query(t) });
    const question = r.intent === 'QUESTION' || r.decision === 'SYNTHESE';
    let answer = null, model = null, erreurIA, etat = null, verifie = false, prompt = null;
    /* ?stream=1 : les sources partent dès la recherche finie, puis la
       réponse mot à mot. Sans cela, on regardait un écran figé pendant
       toute la génération — dix secondes pour une phrase. */
    const veutFlux = u.searchParams.get('stream') === '1';

    /* La mémoire est-elle suffisante ? Score bas, ou question qui parle
       de l'état présent (« est-ce que X tourne », « combien », « en ce
       moment ») : on va vérifier en direct. */
    const parleDuPresent = /\b(tourne|en ligne|hors ligne|actuel|maintenant|en ce moment|combien|est-ce que|ça marche|marche|up|down|démarr|arrêt|état|status|charge|cpu|ram|ticket|alerte|incident|ouvert|critique|urgen)/i.test(q);
    const memoireFaible = !r.hits.length || (r.hits[0] && r.hits[0].score < 0.07);
    if (question && AGREG && (parleDuPresent || memoireFaible)) {
      try {
        const e = await fetch(AGREG + '/v1/etat', { signal: AbortSignal.timeout(6000) });
        if (e.ok) { etat = await LLM.jsonBorne(e, 2 * 1024 * 1024); verifie = true; }
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
        const h = app.filter(x => /serveur|server|hyperviseur|hypervisor|routeur|router|passerelle|gateway|commutateur|switch/i.test(`${x.nom || ''} ${x.type || ''}`))
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
      prompt = construirePrompt({ q, extraits, bloc, avecEtat: !!etat, present: parleDuPresent, soi: etatDeSoi(), redige });
      model = LLM.etat().modele;
      if (!veutFlux) try {
        answer = (await LLM.genere({ prompt, maxTokens: redige ? MAX_JETONS_RESUME : MAX_JETONS, timeout: LLM.etat().distant ? 45000 : 20000 })) || null;
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
    if (veutFlux) return repondreEnFlux(req, res, ctx, { q, r, t0, prompt, model, verifie, etat });
    const tookAnswer = +(performance.now() - t0).toFixed(1);
    ACT.noter(db, { route: 'answer', source: ctx.src.name, compte: ctx.src.compte, q, ms: tookAnswer, decision: r.decision,
      arret: ACT.etageDe(r, { synthese: !!answer }), hits: r.hits.length });
    send(res, 200, {
      q, intent: r.intent, decision: r.decision, reason: r.reason,
      engines: r.engines, took_ms: tookAnswer,
      arret: ACT.etageDe(r, { synthese: !!answer }),
      answer, model: answer ? model : null,
      ia_erreur: erreurIA || undefined,
      verifie, etat_muet: etat && etat.muettes && etat.muettes.length ? etat.muettes.map(x => x.source + ' (' + x.service + ')') : undefined,
      hits: vueHits(r)
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

/* ---------- réponse en langage naturel ---------- */

/* Le modèle reste chargé une demi-heure : sans cela, Ollama le décharge
   après cinq minutes et la question suivante paie le rechargement. */
const GARDE_MODELE = process.env.ANSWER_KEEP_ALIVE || '30m';
const MAX_JETONS = 180;
/* Un résumé de douze extraits ne tient pas en trois phrases. */
const MAX_JETONS_RESUME = 420;

/* La consigne ne parle d'état en direct que s'il y en a un. Elle disait
   toujours « dis vérifié à l'instant » : sans agrégateur, le modèle
   l'écrivait quand même, et affirmait en direct ce qu'il tirait d'un
   vieux souvenir. */
/* Ce que SYNAPSE sait de lui-même sans rien chercher : quelle IA rédige,
   quels vecteurs. C'est vérifiable à l'instant, et c'est la seule réponse
   juste à « tu utilises quelle IA ? » — la mémoire, elle, ne contient que
   ce qu'on en a DIT, y compris des promesses jamais tenues. */
function etatDeSoi() {
  const r = LLM.etat();
  return `SYNAPSE LUI-MÊME — vérifié à l'instant, fait foi sur la mémoire :`
    + `\n- rédige ses réponses avec ${r.distant ? `${r.fournisseur} (API), modèle ${r.modele}` : `Ollama, modèle ${r.modele}`}${r.repli ? ` (${r.repli})` : ''}`
    + `\n- recherche par vecteurs avec Ollama, modèle ${embedder.model}${embedder.ok ? '' : ' — injoignable en ce moment'}`;
}

function construirePrompt({ q, extraits, bloc, avecEtat, present, soi = '', redige = false }) {
  const regles = [
    redige
      ? 'Tu es la mémoire de l\'infrastructure. On te demande un RÉSUMÉ : réponds en français, sans préambule, en 3 à 6 phrases. Le plus grave d\'abord (critique, puis élevé, puis le reste). Regroupe ce qui se ressemble en une phrase, avec tous ses numéros (« quatre appareils ne répondent plus [1][2][5][6] »). Termine par la période couverte par les extraits.'
      : 'Tu es la mémoire de l\'infrastructure. Réponds en français, en 2 ou 3 phrases, sans préambule.',
    avecEtat
      ? 'Tu disposes de deux sources : la MÉMOIRE (extraits datés, peuvent être périmés) et l\'ÉTAT ACTUEL (vérifié à l\'instant). Pour le présent, l\'état actuel fait foi ; pour l\'historique et les décisions, la mémoire. Dis « vérifié à l\'instant » quand tu t\'appuies sur l\'état actuel.'
      : 'Tu ne disposes QUE de la MÉMOIRE : des extraits datés, qui peuvent être périmés. Tu n\'as AUCUN accès à l\'état en direct : n\'écris jamais « vérifié », « à l\'instant », « actuellement » ni « en ce moment ».',
    !avecEtat && present && !redige
      ? 'La question porte sur l\'état présent : commence par dire que la mémoire ne permet pas de le vérifier en direct, puis donne ce qu\'elle en sait, avec la date de l\'extrait.'
      : '',
    'Cite les numéros [n] des extraits que tu utilises. N\'utilise que ces sources.',
    'LES ÉCHANGES. Un extrait « Question / Réponse » rapporte une conversation : ce qu\'on a demandé et ce que l\'assistant a dit. Seule sa ligne « Résultat » dit ce qui a été fait. Sans elle, ou si elle dit que rien n\'est fait, ne présente JAMAIS l\'action comme faite : dis qu\'elle a été demandée.',
    soi ? 'SUR SYNAPSE LUI-MÊME (son IA, ses vecteurs), le bloc « SYNAPSE LUI-MÊME » est vérifié à l\'instant et fait foi sur tout extrait : tu peux le dire au présent.' : '',
    'LIRE LE CORPS, PAS LE TITRE. Un titre résume, il n\'affirme rien : si le corps contredit le titre, le corps a raison.',
    'UNE FLÈCHE N\'EST PAS UNE DÉPENDANCE. « A → B » décrit un flux de données, pas un besoin de fonctionner.',
    'UNE RELATION DOIT ÊTRE ÉCRITE. « dépend de », « héberge », « a besoin de » ne s\'infèrent jamais : à défaut d\'un extrait qui l\'énonce, dis que la mémoire ne le décrit pas.',
    avecEtat
      ? 'LES TICKETS. Le bloc « TICKETS QUI CORRESPONDENT A LA QUESTION » vient d\'une recherche dans tous les tickets ouverts et fait foi. Sans lui, tu ne connais que les récents et tu ne peux pas conclure à l\'absence.'
      : '',
    'RÉPONDS À LA QUESTION POSÉE. Si tu ne la comprends pas, demande une reformulation.',
    'Si les sources ne permettent pas de répondre, dis-le en une phrase, sans inventer.',
  ].filter(Boolean).join('\n');
  return `${regles}\n\nMÉMOIRE :\n${extraits || '(rien de pertinent)'}${bloc}${soi ? `\n\n${soi}` : ''}\n\nQUESTION : ${q}`;
}

const vueHits = r => r.hits.map(h => ({ id: h.id, title: h.title, snippet: h.snippet, source: h.source,
  level: h.level, kind: h.kind, occurred_at: h.occurred_at, score: h.score, why: h.why }));

async function repondreEnFlux(req, res, ctx, { q, r, t0, prompt, model, verifie, etat }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  const ev = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  ev('sources', {
    q, intent: r.intent, decision: r.decision, reason: r.reason, engines: r.engines,
    recherche_ms: +(performance.now() - t0).toFixed(1), verifie, ia: !!prompt, model: prompt ? model : null,
    etat_muet: etat && etat.muettes && etat.muettes.length ? etat.muettes.map(x => x.source + ' (' + x.service + ')') : undefined,
    hits: vueHits(r),
  });

  let texte = '', erreurIA, coupe = false;
  if (prompt) {
    /* Le client qui ferme l'onglet arrête la génération : inutile de
       faire tourner le GPU pour personne. */
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) { coupe = true; ac.abort(); } });
    try {
      await LLM.flux({ prompt, maxTokens: analyseRequete(q).redige ? MAX_JETONS_RESUME : MAX_JETONS, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(60000)]) },
        t => { texte += t; ev('jeton', { t }); });
    } catch (e) {
      if (coupe) return;
      erreurIA = String(e && e.message || e).slice(0, 120);
      console.error('[answer] IA indisponible :', erreurIA);
    }
  }
  const answer = texte.trim() || null;
  const took = +(performance.now() - t0).toFixed(1);
  const arret = ACT.etageDe(r, { synthese: !!answer });
  ACT.noter(db, { route: 'answer', source: ctx.src.name, compte: ctx.src.compte, q, ms: took, decision: r.decision, arret, hits: r.hits.length });
  ev('fin', { took_ms: took, arret, answer, model: answer ? model : null, ia_erreur: erreurIA });
  res.end();
}

/* Un agent ne lit jamais la mémoire privée d'un autre. */
/* Deux espaces publics, deux natures :
     shared  — l'INFRASTRUCTURE : ce qui existe, ce qui est tombé, comment c'est
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

/* ---------- pages ----------
   L'interface est servie sous /v/<version>/ : une nouvelle version change
   l'adresse de chaque fichier, aucun cache ne garde l'ancien script face à
   la nouvelle page. Les pages de la mémoire exigent une session complète du
   socle ; la porte (connexion, installation, facteurs) et la page du compte
   sont celles du socle, communes à tous les services. */
const PAGES = { '/': 'index.html', '/parametres': 'parametres.html' };
const PAGES_LIBRES = { '/connexion': 'connexion.html', '/compte': 'compte.html' };

async function servirInterface(req, res, url, sctx, nonce) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const S = socle.S;
  const p = url.pathname;
  const page = PAGES[p] || (/^\/e\/\d{1,12}$/.test(p) ? 'index.html' : null);
  if (page) {
    if (sctx.session?.niveau !== 'complet') { res.writeHead(302, { Location: '/connexion', 'Cache-Control': 'no-store' }); res.end(); return true; }
    return S.servirFichier(req, res, UI_DIR, '/' + page, { nonce, gamme: socle.cfg.gamme, version: VERSION });
  }
  if (PAGES_LIBRES[p]) return S.servirFichier(req, res, UI_DIR, '/' + PAGES_LIBRES[p], { nonce, gamme: socle.cfg.gamme, version: VERSION });
  const { chemin, durable } = S.cheminVersionne(p, VERSION);
  const cache = durable ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (chemin.startsWith('/socle/')) return S.servirFichier(req, res, pathm.join(RACINE, 'socle', 'web'), chemin.slice(6), { nonce, cache });
  if (/\.html$/i.test(chemin)) return false;
  return S.servirFichier(req, res, UI_DIR, chemin, { nonce, cache });
}

/* ---------- qui parle ----------
   Un service présente un jeton ; un humain, la session du socle. Un jeton
   présenté et refusé ne retombe jamais sur la session : c'est un essai, il
   est compté et journalisé. La session passe par portail.exiger, qui
   contrôle le niveau (tous les facteurs exigés), l'origine et le jeton
   anti-CSRF de toute écriture. */
const essaisJetons = new Map();
function jetonRefuse(sctx) {
  const t = Date.now(), e = essaisJetons.get(sctx.ip);
  const n = e && t - e.t < 60000 ? e.n + 1 : 1;
  essaisJetons.set(sctx.ip, { t: e && t - e.t < 60000 ? e.t : t, n });
  socle.journal.rare(`jeton:${sctx.ip}`, { action: 'jeton.refuse', ip: sctx.ip, resultat: 'refus' });
}
const jetonsBloques = ip => { const e = essaisJetons.get(ip); return !!(e && Date.now() - e.t < 60000 && e.n >= 20); };
setInterval(() => { const t = Date.now(); for (const [k, e] of essaisJetons) if (t - e.t > 60000) essaisJetons.delete(k); }, 60000).unref?.();

function presenteJeton(req) {
  return !!(req.headers['x-synapse-key'] || /^Bearer\s/i.test(String(req.headers.authorization || '')));
}

function identifier(req, sctx) {
  if (presenteJeton(req)) {
    if (jetonsBloques(sctx.ip)) throw new socle.S.ErreurHttp(429, 'Trop de jetons refusés : réessaie dans une minute.');
    const src = auth(req);
    if (!src) { jetonRefuse(sctx); throw new socle.S.ErreurHttp(401, 'Jeton refusé.'); }
    return src;
  }
  if (!sctx.session) return null;
  const s = socle.portail.exiger(sctx, { role: 'lecture' });
  return { name: s.compteLigne.identifiant, compte: s.compte, scope: 'read', channel: 'H', humain: true, role: s.compteLigne.role, sctx };
}

/* Un geste humain qui demande plus que la lecture : le rôle, et pour ce qui
   détruit ou touche un secret, une authentification de moins de cinq
   minutes (renfort). Un jeton admin de service passe. */
function exigerHumain(src, { role = 'membre', renfort = false } = {}) {
  if (src && !src.humain && src.scope === 'admin') return src;
  if (!src || !src.humain) throw new socle.S.ErreurHttp(403, 'Réservé à une session connectée ou à un jeton admin.');
  socle.portail.exiger(src.sctx, { role, renfort });
  return src;
}

function journaliser(src, action, objet, details) {
  socle.journal.ecrire({ acteur: src?.humain ? src.compte : null, action, objet, ip: src?.sctx?.ip ?? null,
    details: { ...(src && !src.humain ? { source: src.name } : {}), ...(details || {}) } });
}

async function traiter(req, res) {
  const S = socle.S;
  const url = new URL(req.url, 'http://synapse');
  const sctx = socle.portail.contexte(req, res);
  if (!debit.prendre(sctx.ip)) {
    socle.journal.rare(`debit:${sctx.ip}`, { action: 'limite.atteinte', objet: 'requetes', ip: sctx.ip, resultat: 'refus' });
    throw new S.ErreurHttp(429, 'Trop de requêtes.');
  }
  const nonce = S.nonceCsp();
  S.entetesSecurite(res, { secure: sctx.securise, hote: req.headers.host,
    csp: S.politiqueContenu({ nonce, secure: sctx.securise, stylesEnLigne: true }) });

  if (req.method === 'OPTIONS' && CORS_ORIGIN) {
    return send(res, 204, {}, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Synapse-Key',
      'Access-Control-Max-Age': '600'
    });
  }
  if (await socle.portail.traiter(req, res, url, sctx)) return;
  if (await servirInterface(req, res, url, sctx, nonce)) return;

  const key = req.method + ' ' + url.pathname;
  const fn = routes[key];
  if (!fn) {
    /* Chemin connu, méthode non servie : 405 et les méthodes admises. */
    const admises = Object.keys(routes).filter(k => k.slice(k.indexOf(' ') + 1) === url.pathname).map(k => k.slice(0, k.indexOf(' ')));
    if (admises.length) return send(res, 405, { error: 'méthode non admise' }, { Allow: admises.join(', ') });
    return send(res, 404, { error: 'route inconnue' });
  }
  if (url.pathname === '/healthz') return fn(req, res, { url });

  const src = identifier(req, sctx);
  if (!src) return send(res, 401, { error: 'authentification requise' });
  /* Paramètres de requête : déclarés, une fois chacun, typés — après
     l'authentification, pour ne rien dire des routes à un inconnu. */
  const params = {};
  for (const [k, v] of url.searchParams) {
    if (Object.hasOwn(params, k)) throw new S.ErreurHttp(400, `Paramètre répété : « ${String(k).slice(0, 40)} ».`);
    params[k] = v;
  }
  S.valider(params, SCHEMAS[key].requete || {});
  routeDe.set(req, SCHEMAS[key]);
  try {
    await fn(req, res, { url, src });
  } catch (e) {
    /* Une entrée malformée (JSON, taille, schéma) arrive en ErreurHttp : la
       faute du client lui est dite telle quelle. Le reste est une panne :
       le détail va dans le journal, jamais dans la réponse. */
    if (e instanceof S.ErreurHttp) throw e;
    console.error('[erreur]', key, e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'erreur interne' });
  }
}

/* Toute route a son schéma : une route ajoutée sans lui empêche le démarrage. */
for (const k of Object.keys(routes)) if (!SCHEMAS[k]) throw new Error(`schéma manquant pour ${k}`);

let socle = null;
let debit = null;
/* Relier deux entrées : il faut pouvoir écrire dans les deux espaces. */
function liables(src, a, b) {
  const ns = id => (db.prepare(`SELECT ns FROM entries WHERE id=?`).get(id) || {}).ns;
  return [a, b].every(id => { const n = ns(id); return n === undefined || nsAllowed(src, n); });
}

/* Écrire, c'est écrire là où l'on peut lire : un espace commun, ou le sien. */
const ESPACE = /^[a-z][a-z0-9_-]{0,31}(:[A-Za-z0-9._-]{1,64})?$/;
function espaceEcrit(src, ns) {
  const n = ns === undefined || ns === null || ns === '' ? 'shared' : String(ns);
  return ESPACE.test(n) && nsAllowed(src, n) ? n : null;
}

/* L'agent dont on parle : le sien. Seul le Hub, qui relaie ses connexions
   d'IA sous leur nom, un jeton admin ou une personne connectée en
   désignent un autre ; un service ne lit ni n'écrit le profil d'un autre. */
function agentDe(src, demande) {
  const a = demande === undefined || demande === null || demande === '' ? null : String(demande).slice(0, 80);
  if (src.humain || src.scope === 'admin' || (src.name === 'hub' && src.channel === 'A')) return a;
  if (a !== null && a !== src.name) throw new socle.S.ErreurHttp(403, 'Agent d’un autre service : un service ne parle que pour lui.');
  return a;
}
const appelant = src => (src.humain ? 'compte:' + src.compte : 'source:' + src.name);
const relaiHub = src => src.scope === 'admin' || (src.name === 'hub' && src.channel === 'A');

const server = http.createServer((req, res) => {
  if (!socle) { res.writeHead(503, { 'Retry-After': '2' }); return res.end(); }
  return socle.envelopper(async () => {
    try { await traiter(req, res); }
    catch (e) { socle.S.repondreErreur(res, e, { journal: CONSOLE }); }
  })(req, res);
});

const CONSOLE = { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

async function demarrer(env = process.env) {
  const S = await import('../socle/src/index.js');
  const s = await S.demarrerSocle({
    service: { id: 'synapse', nom: 'SYNAPSE', contactSecurite: CONTACT_SECURITE },
    db, dossier: pathm.dirname(DB_FILE), env, log: CONSOLE,
    migrer: ({ comptes, coffre }) => migrerComptes({ db, comptes, coffre, log: CONSOLE }),
  });
  socle = { ...s, S, envelopper: S.envelopper };
  /* Données d'un compte : ses questions (trente jours au plus), rendues à
     sa demande et effacées avec lui. */
  s.portail.exporteur = compte => ({ requetes: ACT.duCompte(db, compte) });
  s.comptes.apresSuppression.push(compte => ACT.oublierCompte(db, compte));
  debit = new S.Debit({ max: 1200 });
  LLM.plafonner({ db, parJour: env.LLM_APPELS_JOUR || 500,
    surAtteint: n => s.journal.ecrire({ acteur: 'système', action: 'ia.plafond_atteint', resultat: 'refus', details: { plafond: n } }) });
  const b = CFG.sceller(db, s.coffre);
  if (b.retires) {
    console.warn('[coffre] jeton Telegram illisible sous SOCLE_CLE comme sous SOCLE_CLE_ANCIENNE, retiré : à reposer dans les paramètres.');
    s.journal.ecrire({ acteur: 'système', action: 'coffre.secrets_retires', resultat: 'erreur', details: { n: b.retires } });
  }
  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  await new Promise(r => server.listen(PORT, env.HOTE || '0.0.0.0', r));
  console.log(`[synapse] ${VERSION} écoute sur :${server.address().port}`);
  console.log(`[synapse] base ${DB_FILE}`);
  console.log(`[synapse] vecteurs ${embedder.url ? 'configurés' : 'non configurés'} · ${embedder.model}`);
  embedder.health().then(ok =>
    console.log('[synapse] vecteurs ' + (ok ? 'joignables' : 'INJOIGNABLES — le plein texte fonctionne, pas le vecteur')));
  return server;
}

const arreter = () => new Promise(r => {
  socle?.arreter();
  server.close(() => { try { db.close(); } catch { /* déjà fermée */ } r(); });
  server.closeAllConnections?.();
});

if (require.main === module) {
  demarrer().catch(e => { console.error(e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n[synapse] arrêt');
      arreter().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { server, db, demarrer, arreter };
