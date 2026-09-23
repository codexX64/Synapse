'use strict';
/* ============================================================
   Ingestion.

   L'ordre des opérations n'est pas négociable :

     filtre → dédup → normalise → écrit L0 → (plus tard) vectorise

   Le filtrage vient EN PREMIER parce que c'est le seul endroit où
   jeter coûte zéro. Une ligne de journal acceptée puis ignorée au
   scoring a déjà consommé une écriture, un vecteur et de l'espace.
   Et surtout : le bruit noie les faits, aucun scoring ne rattrape ça.

   La vectorisation est HORS du chemin d'écriture. Une entrée est
   cherchable en plein texte dès son écriture, et cherchable en
   vecteur quand le serveur de vecteurs a répondu. Bloquer l'écriture sur Ollama
   ferait tomber toute l'ingestion à la première panne du modèle.
   ============================================================ */

const crypto = require('node:crypto');

const LEVELS = new Set(['L0', 'L1', 'L2', 'L3']);
const RELATIONS = new Set(['causes', 'fixes', 'supersedes', 'relates_to', 'part_of']);

/* ---------- filtrage ----------
   Chaque règle correspond à une famille de bruit observée en vrai.
   Renvoie null si l'événement passe, sinon la raison du rejet. */
function reject(evt) {
  const kind = String(evt.kind || '');
  const meta = evt.meta || {};

  if (!kind) return 'kind manquant';
  if (!evt.title || !String(evt.title).trim()) return 'titre vide';

  /* Arrêt propre d'un conteneur : volontaire neuf fois sur dix. */
  if (kind === 'container.die' && String(meta.exitCode) === '0') return 'arrêt propre';

  /* Relevés d'état stables : c'est le gros du flux un contrôleur réseau, et ça ne dit rien. */
  if (kind === 'topology.snapshot' && !meta.changed) return 'relevé sans changement';
  if (kind.endsWith('.unchanged')) return 'aucun changement';

  /* Journaux HTTP : seules les erreurs serveur ont valeur de fait. */
  if (kind === 'http.access') return 'journal d\u2019accès';
  if (kind === 'http.error' && Number(meta.status) < 500) return 'erreur client (4xx)';

  /* Traces de mise au point : volume élevé, valeur nulle au retrieval. */
  const sev = String(meta.severity || '').toLowerCase();
  if (sev === 'debug' || sev === 'trace') return 'niveau debug';

  /* Corps démesuré : c'est un fichier, pas un fait. */
  if (String(evt.body || '').length > 60000) return 'corps > 60 Ko';

  return null;
}

/* ---------- niveau par défaut ----------
   Le niveau dit à quel point l'information est stabilisée. Un service
   qui pousse un événement produit du L0 ; une décision consignée par
   une IA ou par toi est du L3 dès l'écriture. */
function defaultLevel(evt) {
  if (evt.level && LEVELS.has(evt.level)) return evt.level;
  const k = String(evt.kind || '');
  if (/^decision\.|^prompt\.|\.recorded$/.test(k)) return 'L3';
  if (/^pattern\.|^analysis\./.test(k)) return 'L2';
  if (/^incident\.|\.fixed$|\.milestone$|^blocker\./.test(k)) return 'L1';
  return 'L0';
}

/* ---------- hash ----------
   Porte l'identité du FAIT, pas son horodatage : deux envois du même
   fait à deux secondes d'écart sont le même fait. C'est ce qui rend
   le rejeu d'une file locale sans danger. */
function hashOf(o) {
  return crypto.createHash('sha256')
    .update([o.ns, o.source, o.kind, o.ref || '', o.title, o.body].join('\u001f'))
    .digest('hex');
}

/* ---------- découpage ----------
   Un événement court reste entier : le découper produirait des
   fragments sans contexte. Un texte long est coupé aux frontières de
   paragraphe, avec le titre répété en tête de chaque morceau — sinon
   le morceau 3 d'une décision ne contient plus le sujet dont il parle
   et devient impossible à retrouver.

   Les sorties de commande et journaux ne sont PAS vectorisés : les
   plonger dans l'espace sémantique le pollue. Ils restent cherchables
   en plein texte, qui est le bon outil pour eux. */
const MAX_CHUNK = 1200;

function looksLikeLog(text) {
  const lines = text.split('\n');
  if (lines.length < 4) return false;
  let hits = 0;
  for (const l of lines) {
    if (/^\s*(\d{4}-\d\d-\d\d|\[|\{|\$|#|\w+\s+\|)/.test(l)) hits++;
    if (/\b(GET|POST|HTTP\/1|stack trace|at \w+\.)/.test(l)) hits++;
  }
  return hits / lines.length > 0.6;
}

function chunk(entry) {
  const head = entry.title.trim();
  const body = String(entry.body || '').trim();
  const full = body ? head + '\n' + body : head;

  if (looksLikeLog(body)) {
    /* un seul morceau, jamais vectorisé */
    return [{ text: full.slice(0, MAX_CHUNK), embedded: -1 }];
  }
  if (full.length <= MAX_CHUNK) {
    return [{ text: full, embedded: 0 }];
  }

  const paras = body.split(/\n\s*\n/).filter(p => p.trim());
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > MAX_CHUNK) {
      out.push(cur); cur = '';
    }
    if (p.length > MAX_CHUNK) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += MAX_CHUNK) out.push(p.slice(i, i + MAX_CHUNK));
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
  }
  if (cur) out.push(cur);
  /* le titre en tête de chaque morceau : sans lui, un fragment perd son sujet */
  return out.map(t => ({ text: head + '\n' + t, embedded: 0 }));
}

/* ---------- normalisation ---------- */
function normalize(evt, sourceName) {
  const o = {
    ns:     String(evt.ns || 'shared'),
    source: String(evt.source || sourceName),
    kind:   String(evt.kind),
    ref:    evt.ref ? String(evt.ref).slice(0, 120) : null,
    level:  defaultLevel(evt),
    title:  String(evt.title).trim().slice(0, 300),
    body:   String(evt.body || ''),
    tags:   (Array.isArray(evt.tags) ? evt.tags : [])
              .map(t => String(t).toLowerCase().replace(/\s+/g, '-'))
              .filter(Boolean).slice(0, 24).join(' '),
    meta:   JSON.stringify(evt.meta || {}),
    occurred_at: safeDate(evt.occurred_at)
  };
  o.hash = hashOf(o);
  return o;
}

function safeDate(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/* ---------- écriture ---------- */
function insert(db, evt, sourceName) {
  const why = reject(evt);
  if (why) return { ok: false, filtered: true, reason: why };

  const o = normalize(evt, sourceName);
  const now = new Date().toISOString();

  const existing = db.prepare(`SELECT id FROM entries WHERE hash=?`).get(o.hash);
  if (existing) {
    /* Le même fait renvoyé : on compte le rejeu et on garde la première
       date. Renvoyer l'id permet au client de lier malgré tout. */
    db.prepare(`UPDATE entries SET dup_count=dup_count+1 WHERE id=?`).run(existing.id);
    return { ok: true, id: existing.id, duplicate: true };
  }

  const info = db.prepare(`
    INSERT INTO entries(ns,source,kind,ref,level,title,body,tags,meta,occurred_at,created_at,hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(o.ns, o.source, o.kind, o.ref, o.level, o.title, o.body, o.tags, o.meta,
         o.occurred_at, now, o.hash);
  const id = Number(info.lastInsertRowid);

  const parts = chunk(o);
  const ins = db.prepare(`INSERT INTO chunks(entry_id,seq,text,embedded) VALUES(?,?,?,?)`);
  parts.forEach((p, i) => ins.run(id, i, p.text, p.embedded));

  db.prepare(`UPDATE sources SET last_seen=?, n_events=n_events+1 WHERE name=?`)
    .run(now, o.source);

  return { ok: true, id, chunks: parts.length, level: o.level };
}

function link(db, fromId, toId, relation, by) {
  if (!RELATIONS.has(relation)) {
    return { ok: false, error: 'relation hors vocabulaire : ' + [...RELATIONS].join(', ') };
  }
  if (fromId === toId) return { ok: false, error: 'boucle sur soi-même' };
  const has = id => db.prepare(`SELECT 1 FROM entries WHERE id=?`).get(id);
  if (!has(fromId) || !has(toId)) return { ok: false, error: 'entrée inconnue' };
  db.prepare(`INSERT OR IGNORE INTO links(from_id,to_id,relation,created_by,created_at)
              VALUES(?,?,?,?,?)`)
    .run(fromId, toId, relation, by || null, new Date().toISOString());
  return { ok: true };
}

module.exports = { insert, link, reject, chunk, normalize, hashOf,
                   defaultLevel, LEVELS, RELATIONS, looksLikeLog };
