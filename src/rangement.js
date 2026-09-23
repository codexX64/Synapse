'use strict';
/* ============================================================
   Rangement de la memoire : detecter, proposer, appliquer.

   Deux principes tiennent ce module.

   1. LA DETECTION EST MESUREE, PAS JUGEE. Les quasi-doublons sont
      trouves par similarite cosinus entre vecteurs deja calcules —
      un nombre, verifiable, reproductible. Demander a un modele
      « ces deux notes sont-elles redondantes ? » donnerait une
      reponse differente a chaque appel.

   2. RIEN N'EST APPLIQUE SANS PLAN VALIDE. Le rangement produit une
      liste d'actions ; quelqu'un la lit et l'accepte. Une suppression
      automatique qui se trompe detruit de l'information qu'aucune
      recherche ne retrouvera.

   Une sauvegarde precede toute application.
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

/* ---------- lecture des vecteurs ---------- */
function vecteurs(db, ns) {
  /* Un vecteur par entree : celui de son premier morceau. Comparer
     morceau a morceau ferait remonter des paragraphes voisins dans
     des documents differents, ce qui n'est pas un doublon. */
  const r = db.prepare(`
    SELECT e.id, e.ref, e.title, e.kind, e.source, e.occurred_at, e.ns,
           length(e.body) AS taille, c.vec, c.dim
    FROM entries e
    JOIN chunks c ON c.entry_id = e.id AND c.seq = 0
    WHERE c.embedded = 1 AND c.vec IS NOT NULL ${ns ? 'AND e.ns = ?' : ''}
    ORDER BY e.id`).all(...(ns ? [ns] : []));
  return r.map(x => ({
    ...x,
    v: new Float32Array(x.vec.buffer, x.vec.byteOffset, x.dim)
  }));
}

/* Les vecteurs sont normalises a l'ingestion : le produit scalaire
   EST le cosinus, pas besoin de diviser par les normes. */
function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------- doublons ---------- */
function doublons(db, { ns = null, seuil = 0.94, max = 40 } = {}) {
  const E = vecteurs(db, ns);
  const paires = [];
  for (let i = 0; i < E.length; i++) {
    for (let j = i + 1; j < E.length; j++) {
      if (E[i].dim !== E[j].dim) continue;
      const s = cos(E[i].v, E[j].v);
      if (s < seuil) continue;
      /* On garde la plus longue : elle contient en general la plus
         courte, l'inverse est rare. Le plan indique laquelle part. */
      const [garde, jette] = E[i].taille >= E[j].taille ? [E[i], E[j]] : [E[j], E[i]];
      paires.push({
        similarite: +s.toFixed(4),
        garde: { id: garde.id, ref: garde.ref, title: garde.title, taille: garde.taille },
        jette: { id: jette.id, ref: jette.ref, title: jette.title, taille: jette.taille }
      });
    }
  }
  paires.sort((a, b) => b.similarite - a.similarite);
  /* Une entree ne peut etre jetee qu'une fois, et ne peut pas etre
     jetee si elle est gardee ailleurs : sinon une chaine A~B~C
     supprimerait B ET C en laissant A seul contre deux disparitions. */
  const jetees = new Set(), gardees = new Set();
  const retenues = [];
  for (const p of paires) {
    if (jetees.has(p.jette.id) || jetees.has(p.garde.id)) continue;
    if (gardees.has(p.jette.id)) continue;
    retenues.push(p); jetees.add(p.jette.id); gardees.add(p.garde.id);
    if (retenues.length >= max) break;
  }
  return { total: E.length, candidats: paires.length, actions: retenues };
}

/* ---------- titres faibles ----------
   Un titre issu d'une section markdown decrit le CONTENANT
   (« Ce qui ne va pas », « Installation ») sans dire de quoi il
   parle. Une recherche sur ces titres ne remonte rien d'utile. */
const FAIBLES = [
  /^[a-z0-9-]+ — (ce qu|le principe|installation|configuration|tests?|notes?|resume|résumé|exemples?|usage|utilisation|prerequis|prérequis|contexte|introduction|conclusion|annexes?|divers|autres?)\b/i,
  /^(ce qu|le principe|pourquoi|comment|quoi|installation|configuration)\b/i,
  /^.{0,18}$/                      /* trop court pour situer quoi que ce soit */
];

function titresFaibles(db, { ns = null, max = 25 } = {}) {
  const r = db.prepare(`
    SELECT id, ref, title, substr(body,1,400) AS extrait, kind, source, ns
    FROM entries ${ns ? 'WHERE ns = ?' : ''}
    ORDER BY id DESC`).all(...(ns ? [ns] : []));
  return r.filter(e => FAIBLES.some(re => re.test(e.title))).slice(0, max);
}

/* ---------- orphelins ----------
   Une entree sans vecteur n'est joignable que par le lexical : elle
   existe sans etre vraiment cherchable. */
function orphelins(db) {
  return db.prepare(`
    SELECT e.id, e.ref, e.title,
           (SELECT count(*) FROM chunks c WHERE c.entry_id = e.id) AS morceaux,
           (SELECT count(*) FROM chunks c WHERE c.entry_id = e.id AND c.embedded = 1) AS vectorises
    FROM entries e
    WHERE vectorises = 0
    ORDER BY e.id DESC LIMIT 30`).all();
}

/* ---------- sauvegarde ----------
   VACUUM INTO fait une copie coherente sans arreter le service, la
   ou un cp sur un fichier SQLite ouvert donnerait une base corrompue
   une fois sur dix. */
function sauvegarde(db, dossier = '/data/sauvegardes') {
  fs.mkdirSync(dossier, { recursive: true });
  const nom = path.join(dossier,
    'avant-rangement-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db');
  db.exec(`VACUUM INTO '${nom.replace(/'/g, "''")}'`);
  /* on ne garde que les cinq dernieres : au-dela, c'est le volume qui
     se remplit sans que personne ne les relise jamais */
  const vieilles = fs.readdirSync(dossier)
    .filter(f => f.startsWith('avant-rangement-')).sort().slice(0, -5);
  for (const f of vieilles) { try { fs.unlinkSync(path.join(dossier, f)); } catch {} }
  return { fichier: nom, octets: fs.statSync(nom).size };
}

/* ---------- application ----------
   Tout dans UNE transaction : un rangement a moitie applique laisse
   une memoire dans un etat que personne n'a decide. */
function applique(db, plan) {
  const fait = { supprimees: 0, renommees: 0, erreurs: [] };
  db.exec('BEGIN');
  try {
    for (const a of plan) {
      if (a.type === 'supprimer') {
        const r = db.prepare('DELETE FROM entries WHERE id = ?').run(a.id);
        if (Number(r.changes)) fait.supprimees++;
      } else if (a.type === 'renommer') {
        const r = db.prepare('UPDATE entries SET title = ? WHERE id = ?').run(a.titre, a.id);
        if (Number(r.changes)) fait.renommees++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    fait.erreurs.push(String(e.message).slice(0, 200));
  }
  return fait;
}

module.exports = { doublons, titresFaibles, orphelins, sauvegarde, applique };
