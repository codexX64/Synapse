'use strict';
/* ============================================================
   L'activité réelle de SYNAPSE : ce qu'on lui a demandé, en combien
   de temps, et à quel étage de la cascade il a trouvé.

   L'interface affichait des chiffres écrits en dur — 47 requêtes par
   jour, 0,62 s, des taux d'arrêt inventés. Ils viennent maintenant de
   ce journal, alimenté par /v1/search, /v1/answer et /v1/brief.

   Étages, du moins cher au plus cher :
     L0  correspondance franche, la recherche s'arrête tôt
     L1  plein texte seul
     L2  le vecteur a été nécessaire
     L3  une IA a synthétisé la réponse
     VIDE  rien au-dessus du seuil

   Trente jours de rétention : assez pour une moyenne, trop peu pour
   devenir un historique de ce que chacun a cherché.
   ============================================================ */

const RETENTION_JOURS = 30;
const ETAGES = ['L0', 'L1', 'L2', 'L3'];

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requetes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      route    TEXT NOT NULL,
      source   TEXT,
      q        TEXT NOT NULL DEFAULT '',
      ms       REAL NOT NULL DEFAULT 0,
      decision TEXT,
      arret    TEXT NOT NULL,
      hits     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_requetes_ts ON requetes(ts);
  `);
}

/* L'étage auquel une recherche s'est arrêtée, d'après ce qu'elle a
   réellement fait — pas d'après un minutage reconstitué. */
function etageDe(r, { synthese = false } = {}) {
  const e = (r && r.engines) || {};
  const n = (r && r.hits ? r.hits.length : 0);
  if (synthese) return 'L3';
  if (!n) return 'VIDE';
  if (e.early) return 'L0';
  if (e.vector) return 'L2';
  return 'L1';
}

function noter(db, { route, source, q, ms, decision, arret, hits }) {
  try {
    db.prepare(`INSERT INTO requetes(ts,route,source,q,ms,decision,arret,hits)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), String(route), source ? String(source).slice(0, 64) : null,
           String(q || '').slice(0, 200), Number(ms) || 0, decision || null,
           String(arret || 'VIDE'), Number(hits) || 0);
  } catch (e) {
    /* Le journal ne doit jamais faire échouer la requête qu'il observe. */
    console.error('[activite]', e && e.message || e);
  }
}

function purge(db, jours = RETENTION_JOURS) {
  db.prepare(`DELETE FROM requetes WHERE ts < ?`)
    .run(new Date(Date.now() - jours * 86400000).toISOString());
}

function resume(db, { jours = 7 } = {}) {
  const depuis24 = new Date(Date.now() - 86400000).toISOString();
  const depuis = new Date(Date.now() - jours * 86400000).toISOString();
  const jour = db.prepare(`SELECT count(*) n, avg(ms) m FROM requetes WHERE ts >= ?`).get(depuis24);
  const periode = db.prepare(`SELECT count(*) n, avg(ms) m FROM requetes WHERE ts >= ?`).get(depuis);
  const parEtage = Object.fromEntries(
    db.prepare(`SELECT arret, count(*) n FROM requetes WHERE ts >= ? GROUP BY arret`).all(depuis)
      .map(r => [r.arret, r.n]));
  /* Les questions humaines récentes, sans doublon : ce sont elles qui
     servent de raccourcis dans la barre, à la place d'exemples inventés. */
  const recentes = db.prepare(
    `SELECT q, max(ts) t FROM requetes
     WHERE route = 'answer' AND length(q) >= 3 AND ts >= ?
     GROUP BY lower(q) ORDER BY t DESC LIMIT 6`).all(depuis).map(r => r.q);
  return {
    jours,
    requetes_24h: jour.n,
    ms_moyen_24h: jour.m == null ? null : Math.round(jour.m),
    requetes_periode: periode.n,
    ms_moyen_periode: periode.m == null ? null : Math.round(periode.m),
    etages: Object.fromEntries([...ETAGES, 'VIDE'].map(k => [k, parEtage[k] || 0])),
    recentes,
  };
}

module.exports = { migrate, noter, purge, resume, etageDe, ETAGES, RETENTION_JOURS };
