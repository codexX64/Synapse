'use strict';
/* ============================================================
   Ce que chaque service envoie à SYNAPSE, et le ménage des données
   simulées.

   Le tableau par source sert au banc d'essai : qui écrit, combien, depuis
   quand, quels types. Il ne montre que des noms et des comptes, jamais un
   contenu : il se lit avec un jeton de lecture.

   Une entrée étiquetée « simulation » est fausse par construction (le mode
   simulation de MapMyLAN, par exemple) : la purger ne détruit aucun fait.
   ============================================================ */

const SIMULE = `(' ' || tags || ' ') LIKE '% simulation %'`;

function parSource(db) {
  const depuis = new Date(Date.now() - 86400000).toISOString();
  const lignes = db.prepare(`
    SELECT source, count(*) n, max(occurred_at) dernier, max(created_at) recu,
           sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) n24,
           sum(CASE WHEN ${SIMULE} THEN 1 ELSE 0 END) simule
    FROM entries WHERE archived = 0 GROUP BY source ORDER BY recu DESC`).all(depuis);
  const types = db.prepare(`
    SELECT source, kind, count(*) n FROM entries
    WHERE archived = 0 AND created_at >= ? GROUP BY source, kind ORDER BY n DESC`).all(depuis);
  return lignes.map(l => ({
    source: l.source, total: l.n, dernier: l.dernier, recu: l.recu, jour: l.n24, simule: l.simule,
    types: types.filter(t => t.source === l.source).slice(0, 8).map(t => ({ kind: t.kind, n: t.n })),
  }));
}

function purgerSimulation(db) {
  const r = db.prepare(`DELETE FROM entries WHERE ${SIMULE}`).run();
  return { supprimees: Number(r.changes || 0) };
}

module.exports = { parSource, purgerSimulation };
