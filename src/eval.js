'use strict';
/* ============================================================
   Banc d'évaluation.

   Sans ce fichier, tout réglage du scoring se fait au ressenti : on
   change un poids, on tape trois requêtes, on trouve ça « mieux », et
   on découvre trois semaines plus tard qu'on a cassé autre chose.

   Deux métriques suffisent :
     recall@5  la bonne réponse est-elle dans les cinq premiers
     MRR       à quel rang exactement (1 = premier, 0.5 = deuxième…)

   À relancer après CHAQUE changement : poids, modèle d'embedding,
   règle de filtrage, constante RRF. C'est lui qui dit si tu as gagné
   ou perdu, pas l'impression du moment.

   Usage :
     node src/eval.js                 (attend eval.json à la racine)
     node src/eval.js mon-jeu.json
   ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db.js');
const { search } = require('./search.js');
const { Embedder } = require('./embed.js');

const DB_FILE = process.env.DB_FILE || '/data/synapse.db';
const FILE = process.argv[2] || path.join(__dirname, '..', 'eval.json');

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error('jeu de test introuvable : ' + FILE);
    process.exit(1);
  }
  const cases = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const db = open(DB_FILE);
  const embedder = new Embedder();
  const vecOk = await embedder.health();
  if (!vecOk) console.log('le serveur de vecteurs injoignable : évaluation du LEXICAL SEUL\n');

  let hit5 = 0, mrrSum = 0, missing = 0;
  const fails = [];

  for (const c of cases) {
    const r = await search(db, {
      q: c.q, ns: c.ns || 'shared', limit: 10,
      embed: vecOk ? (t => embedder.query(t)) : null
    });
    /* la cible est désignée par une sous-chaîne du titre, stable dans le temps
       contrairement à un identifiant qui change à chaque réimport */
    const idx = r.hits.findIndex(h =>
      h.title.toLowerCase().includes(String(c.expect).toLowerCase()));
    if (idx === -1) { missing++; fails.push({ q: c.q, got: r.hits.slice(0, 3).map(h => h.title) }); }
    else {
      if (idx < 5) hit5++;
      mrrSum += 1 / (idx + 1);
      if (c.at_rank !== undefined && idx + 1 > c.at_rank)
        fails.push({ q: c.q, want: c.at_rank, got_rank: idx + 1, title: r.hits[idx].title });
    }
  }

  const n = cases.length;
  console.log('cas testés   ' + n);
  console.log('recall@5     ' + (hit5 / n * 100).toFixed(1) + '%   (' + hit5 + '/' + n + ')');
  console.log('MRR          ' + (mrrSum / n).toFixed(3));
  console.log('introuvables ' + missing);

  if (fails.length) {
    console.log('\n--- à regarder ---');
    for (const f of fails.slice(0, 12)) {
      if (f.got) {
        console.log('  ✗ ' + f.q);
        console.log('      attendu « ' + (cases.find(c => c.q === f.q) || {}).expect +' »');
        f.got.forEach((t, i) => console.log('      ' + (i + 1) + '. ' + t.slice(0, 60)));
      } else {
        console.log('  ~ ' + f.q + '  → rang ' + f.got_rank + ', voulu ≤ ' + f.want);
      }
    }
  }
  db.close();
  process.exit(missing > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
