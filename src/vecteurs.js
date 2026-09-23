'use strict';
/* ============================================================
   SYNAPSE — index vectoriel en mémoire.

   Le niveau 2 de la cascade lisait tous les morceaux vectorisés de
   l'espace à chaque requête : une ligne SQLite par morceau, un Buffer
   par ligne, un Float32Array construit par-dessus, puis la boucle de
   produit scalaire. Sur dix mille morceaux, l'essentiel du temps
   partait dans la lecture et l'allocation, pas dans le calcul.

   Ici les vecteurs d'un espace tiennent dans UNE Float32Array contiguë.
   La boucle chaude ne fait plus que lire de la mémoire alignée, sans
   allocation ni déréférencement. C'est le même résultat, au même
   arrondi près : les vecteurs sont déjà normalisés à l'écriture, donc
   le cosinus reste un produit scalaire.

   L'index se construit à la demande et se périme sur un compteur :
   inutile de le reconstruire tant que rien n'a été vectorisé. Une
   mémoire qui n'ingère pas ne paie rien du tout.

   Il n'y a pas de budget mémoire à surveiller de près : à 768
   dimensions, dix mille morceaux font trente mégaoctets. Au-delà du
   plafond, l'index se désactive et la recherche reprend le chemin SQL —
   plus lente, jamais fausse.
   ============================================================ */

const { blobToVec } = require('./db.js');

/* 120 000 morceaux à 768 dimensions ≈ 350 Mo. Au-delà, un index en
   mémoire n'est plus le bon outil et il vaut mieux le dire que gonfler
   en silence. */
const MAX_MORCEAUX = 120000;

const caches = new Map();   /* ns → index */

function signature(db, ns) {
  const r = db.prepare(
    `SELECT COUNT(*) n, COALESCE(MAX(c.id),0) m FROM chunks c JOIN entries e ON e.id = c.entry_id
     WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.ns = ?`).get(ns);
  return `${r.n}:${r.m}`;
}

/**
 * L'index de cet espace, construit si besoin.
 *
 * Renvoie null quand il n'y a rien à indexer ou quand l'espace dépasse
 * le plafond : dans les deux cas l'appelant reprend le chemin SQL.
 */
function index(db, ns) {
  const sig = signature(db, ns);
  const cache = caches.get(ns);
  if (cache && cache.sig === sig) return cache.idx;

  const rows = db.prepare(
    `SELECT c.entry_id AS id, c.vec AS v, e.archived AS arch FROM chunks c
     JOIN entries e ON e.id = c.entry_id
     WHERE c.embedded = 1 AND c.vec IS NOT NULL AND e.ns = ?`).all(ns);

  if (!rows.length || rows.length > MAX_MORCEAUX) {
    caches.set(ns, { sig, idx: null });
    return null;
  }

  /* La dimension est celle du premier vecteur. Un modèle d'embeddings
     changé en cours de route laisse des vecteurs d'une autre taille :
     on les écarte, exactement comme le faisait la boucle SQL. */
  const dim = blobToVec(rows[0].v).length;
  const coupe = Math.max(8, Math.min(dim, Math.round(dim / 4)));
  const plat = new Float32Array(rows.length * dim);
  const ids = new Int32Array(rows.length);
  const archive = new Uint8Array(rows.length);
  /* Norme de la QUEUE de chaque vecteur, au-delà de la coupe. Elle sert
     de majorant : c'est ce qui permet d'abandonner un candidat après un
     quart de la boucle sans risquer de rater un meilleur score. */
  const queue = new Float32Array(rows.length);
  let n = 0;
  for (const r of rows) {
    const v = blobToVec(r.v);
    if (v.length !== dim) continue;
    plat.set(v, n * dim);
    ids[n] = r.id;
    archive[n] = r.arch ? 1 : 0;
    let q = 0;
    for (let k = coupe; k < dim; k++) q += v[k] * v[k];
    queue[n] = Math.sqrt(q);
    n++;
  }
  const idx = { dim, coupe, n, plat, ids, archive, queue };
  caches.set(ns, { sig, idx });
  return idx;
}

/**
 * Les meilleures entrées pour ce vecteur de requête.
 *
 * `garde` filtre par identifiant d'entrée : c'est par là que passent les
 * filtres de la requête (source, niveau, date…), évalués une seule fois
 * en SQL plutôt qu'à chaque morceau.
 *
 * Un morceau représente son entrée, et une entrée peut en avoir
 * plusieurs : on garde le meilleur, comme avant. Prendre la somme
 * avantagerait mécaniquement les entrées longues.
 */
function proches(db, ns, qvec, limit, garde = null) {
  const idx = index(db, ns);
  if (!idx || !qvec || qvec.length !== idx.dim) return null;   /* null = pas d'index, reprends le SQL */
  const { dim, coupe, n, plat, ids, archive, queue } = idx;

  /* Norme de la queue de la REQUÊTE, calculée une fois. Le majorant de
     Cauchy-Schwarz dit que ce qui reste à calculer ne peut pas dépasser
     le produit des deux normes de queue. Si le début de la boucle plus
     ce majorant ne bat même pas le pire des candidats déjà retenus, le
     reste de la boucle est du calcul dont on connaît déjà l'issue. */
  let qq = 0;
  for (let k = coupe; k < dim; k++) qq += qvec[k] * qvec[k];
  const normeQueueQ = Math.sqrt(qq);

  /* Le seuil est le plus faible des `limit` meilleurs trouvés jusqu'ici.
     Il monte au fil du balayage, donc l'élagage devient de plus en plus
     efficace : les premiers candidats paient plein tarif, les derniers
     sont écartés en un quart de boucle. */
  const best = new Map();
  let seuil = -Infinity;
  let retenus = [];

  for (let i = 0; i < n; i++) {
    if (archive[i]) continue;
    const id = ids[i];
    if (garde && !garde.has(id)) continue;
    const o = i * dim;

    let dot = 0;
    for (let k = 0; k < coupe; k++) dot += plat[o + k] * qvec[k];

    /* Majorant du score final de ce candidat. */
    if (retenus.length >= limit && dot + queue[i] * normeQueueQ <= seuil) continue;

    for (let k = coupe; k < dim; k++) dot += plat[o + k] * qvec[k];

    const prev = best.get(id);
    if (prev !== undefined && dot <= prev) continue;
    best.set(id, dot);

    /* `retenus` ne sert qu'à tenir le seuil : quelques dizaines
       d'éléments, une insertion triée est plus rapide qu'un tas. */
    if (retenus.length < limit || dot > seuil) {
      retenus.push(dot);
      retenus.sort((a, b) => b - a);
      if (retenus.length > limit) retenus.length = limit;
      seuil = retenus[retenus.length - 1];
    }
  }

  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, s], i) => ({ id, rank: i, raw: s }));
}

/** À appeler quand on sait que l'espace a changé. Sinon la signature suffit. */
function invalider(ns) { if (ns) caches.delete(ns); else caches.clear(); }

function etat() {
  return [...caches.entries()].map(([ns, c]) => ({ ns, morceaux: c.idx?.n || 0, dim: c.idx?.dim || 0, actif: !!c.idx }));
}

module.exports = { proches, index, invalider, etat, MAX_MORCEAUX };
