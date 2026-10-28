'use strict';
/* Mesure de la hiérarchie sur une COPIE de base, jamais sur celle d'un
   service en marche : migration v2, reprise complète, puis le coût du
   tamis sur des écritures calquées sur de vraies entrées.

     DB_FILE=/chemin/copie.db node --disable-warning=ExperimentalWarning outils/mesure-hierarchie.js [écritures]

   La copie est modifiée (c'est le but) : la jeter après. */

const fs = require('node:fs');
const { open } = require('../src/db.js');
const ingest = require('../src/ingest.js');
const H = require('../src/hierarchie.js');

const fichier = process.env.DB_FILE;
if (!fichier || !fs.existsSync(fichier)) { console.error('DB_FILE : copie de base introuvable'); process.exit(2); }
const ECRITURES = Number(process.argv[2] || 1000);
const mo = () => (fs.statSync(fichier).size / 1048576).toFixed(0) + ' Mo';
const s = ms => (ms / 1000).toFixed(1) + ' s';

console.log(`base : ${mo()}`);
/* Une copie prise pendant que le service écrit peut être déchirée : on
   la contrôle avant toute mesure plutôt que de mesurer une base abîmée. */
let t = performance.now();
{
  const { DatabaseSync } = require('node:sqlite');
  const brute = new DatabaseSync(fichier);
  const r = brute.prepare('PRAGMA quick_check').get();
  brute.close();
  const verdict = Object.values(r)[0];
  if (verdict !== 'ok') { console.error(`copie abîmée (${verdict}) : recopier, puis relancer`); process.exit(3); }
  console.log(`copie intègre : ${s(performance.now() - t)}`);
}
t = performance.now();
const db = open(fichier);
const version = db.prepare(`SELECT v FROM meta WHERE k='schema_version'`).get().v;
console.log(`ouverture et migration : ${s(performance.now() - t)} · schéma ${version}`);
const n = db.prepare(`SELECT count(*) n FROM entries`).get().n;
console.log(`entrées : ${n}`);
console.table(db.prepare(`SELECT source, count(*) n FROM entries GROUP BY source ORDER BY n DESC LIMIT 12`).all());

t = performance.now();
let total = 0, dernier = performance.now();
for (;;) {
  const k = H.reprendre(db, { lot: 500, max: 500 });
  total += k;
  if (performance.now() - dernier > 15000) { console.log(`  … ${total} rangées, reste ${H.resteAReprendre(db)}`); dernier = performance.now(); }
  if (!H.resteAReprendre(db)) break;
}
const duree = performance.now() - t;
console.log(`reprise : ${total} entrées en ${s(duree)} · ${(duree / Math.max(total, 1)).toFixed(2)} ms par entrée`);

const compte = q => db.prepare(q).get().n;
console.table({
  cerveaux_membres: compte(`SELECT count(*) n FROM h_cerveaux WHERE genre='membre'`),
  domaines: compte(`SELECT count(*) n FROM h_domaines`),
  remontees: compte(`SELECT count(*) n FROM h_remontees`),
  fiches_communes: compte(`SELECT count(*) n FROM entries WHERE kind='fiche.commune'`),
  correlations: compte(`SELECT count(*) n FROM entries WHERE kind='fiche.correlation'`),
  cles_posees: compte(`SELECT count(*) n FROM h_cles`),
});
console.table(db.prepare(`SELECT c.nom cerveau, d.nom domaine, (SELECT count(*) FROM h_place p WHERE p.cerveau_id = c.id) entrees
  FROM h_cerveaux c LEFT JOIN h_domaines d ON d.id = c.domaine_id WHERE c.genre = 'membre' ORDER BY entrees DESC LIMIT 15`).all());
console.table(db.prepare(`SELECT e.title fiche, (SELECT count(*) FROM links l WHERE l.from_id = e.id) sources
  FROM entries e WHERE e.kind LIKE 'fiche.%' ORDER BY sources DESC LIMIT 12`).all());

/* Le tamis à l'écriture : des entrées réelles tirées au hasard, réécrites
   sous un titre neuf pour ne pas tomber sur le dédoublonnage. */
const modeles = db.prepare(`SELECT source, kind, title, body, tags FROM entries
  WHERE kind NOT LIKE 'fiche.%' AND ns NOT LIKE 'h:%' ORDER BY random() LIMIT ?`).all(ECRITURES);
const durees = [];
modeles.forEach((m, i) => {
  const e = ingest.insert(db, { ns: 'shared', kind: m.kind, title: `${m.title} · mesure ${i}`, body: m.body,
    tags: String(m.tags || '').split(' ').filter(Boolean) }, m.source);
  if (!e.ok || e.duplicate) return;
  const t0 = performance.now();
  H.classer(db, e.id, { src: { name: m.source } });
  durees.push(performance.now() - t0);
});
durees.sort((a, b) => a - b);
const p = q => durees.length ? durees[Math.min(durees.length - 1, Math.floor(q * durees.length))].toFixed(2) : '-';
console.log(`tamis à l'écriture (${durees.length}) : p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · p99 ${p(0.99)} ms · max ${durees.length ? durees.at(-1).toFixed(2) : '-'} ms`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log(`base après : ${mo()} · mémoire max : ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} Mo`);
