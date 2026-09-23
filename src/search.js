'use strict';
/* ============================================================
   Recherche hybride.

   Trois moteurs, fusionnés par RRF (Reciprocal Rank Fusion) :

     lexical  BM25 via FTS5   — noms d'hôtes, références, termes exacts
     vecteur  produit scalaire — reformulations, synonymes
     graphe   2 sauts          — le correctif lié à l'incident trouvé

   Le lexical seul rate « pourquoi le switch coupe » → « STP loop ».
   Le vecteur seul rate « CHT-412 ». Les deux ensemble couvrent.

   RRF plutôt qu'une somme pondérée de scores : BM25 et cosinus ne
   vivent pas sur la même échelle et ne sont pas comparables. Le rang,
   lui, l'est toujours. C'est ce qui rend la fusion robuste sans avoir
   à recalibrer des poids à chaque changement de corpus.

   SORTIE ANTICIPÉE : si le lexical donne un premier résultat franc et
   nettement détaché, on ne calcule pas le vecteur de la requête. Sur
   du trafic de homelab — noms de machines, de services, de tickets —
   ça couvre la majorité des requêtes et les ramène à ~10 ms.
   ============================================================ */

const { blobToVec } = require('./db.js');
const VEC = require('./vecteurs.js');

/* K=60 est la valeur de la littérature, calibrée pour fusionner des
   listes de centaines de résultats. Sur des listes de 10, elle produit
   des écarts de 1.6% entre rangs voisins : n'importe quel boost les
   écrase et le classement des moteurs ne sert plus à rien.
   K=12 donne 7% d'écart — assez pour que le rang domine, assez peu
   pour que le niveau et la fraîcheur départagent à rang égal. */
const K_RRF = 12;
const W = { lex: 1.0, vec: 1.0, graph: 0.55 };
/* Bornés sous l'écart entre deux rangs : ils départagent, ils n'inversent pas. */
const LEVEL_BOOST = { L3: 0.055, L2: 0.040, L1: 0.025, L0: 0 };

const STOP = new Set(('le la les de des du un une et ou a au aux en dans sur pour par avec sans ce ' +
  'cette ces que qui quoi est sont ete etre il elle on nous vous ils elles se sa son ses leur leurs ' +
  'plus moins tres bien mal pas ne y d l n s c j m t je tu il').split(' '));

const ASK = /(^|\s)(pourquoi|comment|quand|qui|quoi|quel|quelle|quels|quelles|ou|est-ce|combien|c'est quoi)(\s|$)|\?\s*$/i;

function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function toks(s) {
  return norm(s).split(/[^a-z0-9._-]+/).filter(t => t.length > 1 && !STOP.has(t));
}

/* ---------- analyse de la requête ----------
   Ce qui est reconnu comme filtre ne part pas au scoring : filtrer
   avant de scorer est toujours moins cher, et bien plus précis. */
function parse(raw) {
  const f = { source: null, level: null, kind: null, tag: null, days: null, ref: null, phrase: null };
  let rest = String(raw || '');

  rest = rest.replace(/\bsource:([a-z0-9_.-]+)/gi, (_, v) => { f.source = v.toLowerCase(); return ' '; });
  rest = rest.replace(/\blevel:(l[0-3])/gi,        (_, v) => { f.level = v.toUpperCase();  return ' '; });
  rest = rest.replace(/\bkind:([a-z0-9_.*-]+)/gi,  (_, v) => { f.kind = v.toLowerCase();   return ' '; });
  rest = rest.replace(/\bref:([a-z0-9_.-]+)/gi,    (_, v) => { f.ref = v.toUpperCase();    return ' '; });
  rest = rest.replace(/#([a-z0-9-]+)/gi,           (_, v) => { f.tag = norm(v);            return ' '; });
  rest = rest.replace(/>(\d+)\s*(j|d)\b/gi,        (_, v) => { f.days = parseInt(v, 10);   return ' '; });
  rest = rest.replace(/"([^"]+)"/g,                (_, v) => { f.phrase = v;               return ' '; });

  const text = rest.replace(/\s+/g, ' ').trim();
  const t = toks(text);
  const hasFilter = !!(f.source || f.level || f.kind || f.tag || f.days !== null || f.ref);

  let intent;
  if (!text && hasFilter) intent = 'FILTRE';
  else if (ASK.test(text)) intent = 'QUESTION';
  else if (t.length >= 4) intent = 'QUESTION';
  else if (t.length <= 1) intent = 'NAVIGATION';
  else intent = 'RECHERCHE';

  return { filters: f, text, toks: t, intent, hasFilter, raw };
}

/* ---------- SQL de filtrage, partagé par les trois moteurs ---------- */
function whereClause(p, ns) {
  const w = ['e.archived = 0', 'e.ns = ?'];
  const a = [ns];
  const f = p.filters;
  if (f.source) { w.push('e.source = ?'); a.push(f.source); }
  if (f.level)  { w.push('e.level = ?');  a.push(f.level); }
  if (f.ref)    { w.push('UPPER(e.ref) = ?'); a.push(f.ref); }
  if (f.kind)   { w.push('e.kind LIKE ?'); a.push(f.kind.replace('*', '') + '%'); }
  if (f.tag)    { w.push("(' '||e.tags||' ') LIKE ?"); a.push('% ' + f.tag + ' %'); }
  if (f.days !== null) {
    w.push('e.occurred_at >= ?');
    a.push(new Date(Date.now() - f.days * 86400000).toISOString());
  }
  return { sql: w.join(' AND '), args: a };
}

/* ---------- FTS5 ----------
   La requête est construite en OR de préfixes : une frappe partielle
   ou un pluriel ne doit pas faire chuter le rappel à zéro. */
function ftsQuery(t) {
  return t.map(x => '"' + x.replace(/"/g, '') + '"*').join(' OR ');
}

function lexical(db, p, ns, limit) {
  if (!p.toks.length) return [];
  const { sql, args } = whereClause(p, ns);
  let q = ftsQuery(p.toks);
  if (p.filters.phrase) q = '"' + p.filters.phrase.replace(/"/g, '') + '"';
  try {
    return db.prepare(`
      SELECT e.id, bm25(fts, 8.0, 1.0, 4.0, 2.0, 6.0) AS s
      FROM fts JOIN entries e ON e.id = fts.rowid
      WHERE fts MATCH ? AND ${sql}
      ORDER BY s LIMIT ?`).all(q, ...args, limit)
      .map((r, i) => ({ id: r.id, rank: i, raw: -r.s }));
  } catch {
    return [];                       /* requête FTS mal formée : on n'échoue pas la recherche */
  }
}

/* ---------- filtre seul, sans termes ---------- */
function filterOnly(db, p, ns, limit) {
  const { sql, args } = whereClause(p, ns);
  return db.prepare(`
    SELECT e.id FROM entries e WHERE ${sql}
    ORDER BY e.occurred_at DESC LIMIT ?`).all(...args, limit)
    .map((r, i) => ({ id: r.id, rank: i, raw: 1 }));
}

/* ---------- vecteurs ----------
   Exhaustif, donc exact : aucun faux négatif, contrairement à un index
   approximatif. Mesuré à 12 ms sur 10 000 vecteurs de 768 dimensions,
   ce qui laisse une marge très large à l'échelle d'un homelab. */
function vector(db, qvec, p, ns, limit) {
  if (!qvec) return [];

  /* Chemin rapide : les vecteurs de l'espace tiennent dans un tableau
     contigu déjà en mémoire. Les filtres de la requête sont évalués une
     fois en SQL — sur les entrées, pas sur les morceaux — et servent de
     laissez-passer. L'index rend null quand il n'existe pas : on
     retombe alors sur la lecture SQL, plus lente mais identique. */
  const filtre = filtresActifs(p) ? new Set(idsAutorises(db, p, ns)) : null;
  if (filtre && !filtre.size) return [];
  const rapide = VEC.proches(db, ns, qvec, limit, filtre);
  if (rapide) return rapide;

  const { sql, args } = whereClause(p, ns);
  const rows = db.prepare(`
    SELECT c.entry_id AS id, c.vec AS v
    FROM chunks c JOIN entries e ON e.id = c.entry_id
    WHERE c.embedded = 1 AND c.vec IS NOT NULL AND ${sql}`).all(...args);
  if (!rows.length) return [];

  const dim = qvec.length;
  const best = new Map();
  for (const r of rows) {
    const v = blobToVec(r.v);
    if (v.length !== dim) continue;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += v[i] * qvec[i];
    /* un morceau représente son entrée : on garde le meilleur */
    const prev = best.get(r.id);
    if (prev === undefined || dot > prev) best.set(r.id, dot);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, s], i) => ({ id, rank: i, raw: s }));
}

/* Un filtre au-delà de l'espace lui-même : inutile de lister les
   entrées autorisées quand la requête n'en pose aucun. */
function filtresActifs(p) {
  const f = p.filters;
  return !!(f.source || f.level || f.ref || f.kind || f.tag || f.days !== null);
}
function idsAutorises(db, p, ns) {
  const { sql, args } = whereClause(p, ns);
  return db.prepare(`SELECT e.id FROM entries e WHERE ${sql}`).all(...args).map(r => r.id);
}

/* ---------- graphe ----------
   Les voisins directs des meilleurs résultats. C'est ce qui remonte le
   correctif quand on a trouvé l'incident : une recherche textuelle sur
   « oom » ne trouvera jamais « SIGKILL + garde /22 ». */
function graph(db, seeds, p, ns, limit) {
  if (!seeds.length) return [];
  const ids = seeds.slice(0, 5).map(s => s.id);
  const ph = ids.map(() => '?').join(',');
  const { sql, args } = whereClause(p, ns);
  const rows = db.prepare(`
    SELECT DISTINCT e.id, l.relation FROM links l
    JOIN entries e ON e.id = CASE WHEN l.from_id IN (${ph}) THEN l.to_id ELSE l.from_id END
    WHERE (l.from_id IN (${ph}) OR l.to_id IN (${ph})) AND ${sql}
    LIMIT ?`).all(...ids, ...ids, ...ids, ...args, limit);
  const seen = new Set(ids);
  return rows.filter(r => !seen.has(r.id))
             .map((r, i) => ({ id: r.id, rank: i, raw: 1, relation: r.relation }));
}

/* ---------- fusion ---------- */
function fuse(lists) {
  const acc = new Map();
  for (const { name, items, w } of lists) {
    for (const it of items) {
      let e = acc.get(it.id);
      if (!e) { e = { id: it.id, score: 0, why: [], parts: {} }; acc.set(it.id, e); }
      const c = w / (K_RRF + it.rank + 1);
      e.score += c;
      e.parts[name] = +c.toFixed(4);
      e.why.push(name === 'graph' && it.relation ? 'graphe:' + it.relation : name);
    }
  }
  return [...acc.values()];
}

/* ---------- décision ----------
   C'est la FORME du classement qui parle, pas le score du premier.
   Un top-1 à 0.90 suivi d'un 0.88 est ambigu, pas certain. */
function decide(p, hits, gap) {
  if (!hits.length) return { decision: 'VIDE',
    reason: "Aucune entrée ne contient ces termes dans cet espace." };
  if (p.intent === 'FILTRE') return { decision: 'FILTRE',
    reason: "Requête composée uniquement de filtres : tri chronologique, pas de scoring." };
  if (hits.length === 1) return { decision: 'DIRECT',
    reason: "Un seul résultat correspond : sans concurrent, il n'y a rien à départager." };
  if (gap > 0.30) return { decision: 'DIRECT',
    reason: `Écart de ${Math.round(gap * 100)}% avec le suivant : le premier s'impose nettement.` };
  if (p.intent === 'QUESTION' && hits.length >= 2) return { decision: 'SYNTHESE',
    reason: "Tournure interrogative et plusieurs entrées pertinentes : la réponse est à assembler." };
  const srcs = new Set(hits.slice(0, 5).map(h => h.source));
  if (srcs.size === 1) return { decision: 'BRANCHE',
    reason: `Les meilleurs résultats viennent tous de ${[...srcs][0]} : la requête vise un domaine.` };
  return { decision: 'LISTE',
    reason: `Résultats étalés sur ${srcs.size} sources avec des écarts faibles : aucun ne s'impose.` };
}

/* ---------- entrée principale ---------- */
async function search(db, opts) {
  const t0 = performance.now();
  const {
    q = '', ns = 'shared', limit = 8, scope = null,
    embed = null, forVector = true
  } = opts;

  const p = parse(q);
  const POOL = Math.max(limit * 4, 40);

  /* pas de termes : filtre pur, tri chronologique */
  if (!p.toks.length) {
    const items = filterOnly(db, p, ns, limit);
    const hits = hydrate(db, items.map(i => ({ id: i.id, score: 0.5, why: ['filtre'], parts: {} })));
    return finish(p, hits, t0, null, 'FILTRE',
      "Requête composée uniquement de filtres : tri chronologique, pas de scoring.");
  }

  const lex = lexical(db, p, ns, POOL);

  /* --- sortie anticipée ---
     Le lexical est-il assez franc pour se passer du vecteur ? On compare
     les scores BM25 bruts du premier et du deuxième. Un écart net sur un
     nom propre ne gagne rien à être confirmé par un modèle. */
  let early = false;
  if (lex.length && p.intent !== 'QUESTION') {
    const a = lex[0].raw, b = lex[1] ? lex[1].raw : 0;
    if (a > 0 && (b === 0 || (a - b) / a > 0.45)) early = true;
  }

  let qvec = null;
  if (!early && forVector && embed) {
    try { qvec = await embed(p.text); } catch { qvec = null; }
  }

  const vec = qvec ? vector(db, qvec, p, ns, POOL) : [];
  const gr  = graph(db, lex.length ? lex : vec, p, ns, 12);

  let fused = fuse([
    { name: 'lexical', items: lex, w: W.lex },
    { name: 'vecteur', items: vec, w: W.vec },
    { name: 'graph',   items: gr,  w: W.graph }
  ]);

  fused = hydrate(db, fused);

  /* Boosts appliqués en MULTIPLICATION, jamais en addition.
     L'écart RRF entre deux rangs consécutifs vaut ~2.6e-4. Un boost
     additif de 3.2e-3 pour L3 pesait donc 12 fois cet écart : un
     résultat de rang 5 en L3 passait devant un rang 0 en L1, et le
     classement des moteurs ne servait plus à rien. En multiplicatif,
     le rang reste dominant et le niveau ne fait que départager. */
  const clicks = clickBoost(db, p);
  const now = Date.now();
  for (const h of fused) {
    const age = (now - new Date(h.occurred_at).getTime()) / 86400000;
    let k = 1 + (LEVEL_BOOST[h.level] || 0);
    k += Math.exp(-Math.max(0, age) / 45) * 0.030;
    if (clicks.has(h.id)) { k += 0.060; h.why.push('clics'); }
    h.score *= k;
  }
  fused.sort((a, b) => b.score - a.score);

  const top = fused.slice(0, limit);
  const gap = top.length > 1 && top[0].score > 0
    ? (top[0].score - top[1].score) / top[0].score : (top.length ? 1 : 0);

  const d = decide(p, top, gap);
  if (!top.length) recordFailed(db, p);

  return finish(p, top, t0, gap, d.decision, d.reason, { early, vector: !!qvec });
}

function hydrate(db, items) {
  if (!items.length) return [];
  const ids = items.map(i => i.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, ns, source, kind, ref, level, title, body, tags, meta, occurred_at, dup_count
    FROM entries WHERE id IN (${ph})`).all(...ids);
  const by = new Map(rows.map(r => [r.id, r]));
  return items.map(i => {
    const r = by.get(i.id);
    if (!r) return null;
    return {
      id: r.id, ns: r.ns, source: r.source, kind: r.kind, ref: r.ref, level: r.level,
      title: r.title, snippet: snippet(r.body), tags: r.tags ? r.tags.split(' ') : [],
      meta: safeJson(r.meta), occurred_at: r.occurred_at, dup_count: r.dup_count,
      score: i.score || 0, why: i.why || [], parts: i.parts || {}
    };
  }).filter(Boolean);
}

function snippet(body) {
  const s = String(body || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  return s.length > 260 ? s.slice(0, 257) + '…' : s;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function clickBoost(db, p) {
  const key = norm(p.text);
  const rows = db.prepare(`SELECT entry_id FROM query_clicks WHERE query_norm=? AND n>=2`).all(key);
  return new Set(rows.map(r => r.entry_id));
}
function recordFailed(db, p) {
  const key = norm(p.text);
  if (!key) return;
  db.prepare(`INSERT INTO failed_queries(query_norm,n,last_at) VALUES(?,1,?)
              ON CONFLICT(query_norm) DO UPDATE SET n=n+1, last_at=excluded.last_at`)
    .run(key, new Date().toISOString());
}

function finish(p, hits, t0, gap, decision, reason, flags) {
  const facets = { source: {}, level: {}, kind: {} };
  for (const h of hits) {
    facets.source[h.source] = (facets.source[h.source] || 0) + 1;
    facets.level[h.level] = (facets.level[h.level] || 0) + 1;
    const k = h.kind.split('.')[0];
    facets.kind[k] = (facets.kind[k] || 0) + 1;
  }
  return {
    intent: p.intent,
    decision, reason,
    confidence: hits.length ? +Math.min(1, hits[0].score * 12).toFixed(2) : 0,
    gap: gap === null ? null : +(gap || 0).toFixed(2),
    took_ms: +(performance.now() - t0).toFixed(1),
    filters: p.filters,
    engines: flags || {},
    hits, facets
  };
}

module.exports = { search, parse, norm, toks, decide };
