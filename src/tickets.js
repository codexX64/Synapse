'use strict';
/* ============================================================
   Recherche dans les tickets d'le service de tickets.

   L'agregateur ne remonte que les dix plus recents : sur 42 ouverts,
   une question sur un ticket precis tombait systematiquement a cote,
   et le modele repondait « aucun des dix recents ne correspond » —
   exact, mais inutile.

   SYNAPSE lit donc la base d'le service de tickets directement, en LECTURE SEULE,
   comme le fait deja l'agregateur. Aucune ecriture, aucun risque de
   verrou : SQLite en readOnly ne prend pas de lock d'ecriture.

   Le schema d'le service de tickets n'est pas fige : on releve les colonnes au
   demarrage et on construit la requete avec celles qui existent.
   Coder en dur `ref` ou `ticket_id` casserait au premier renommage.
   ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const CHEMIN = process.env.TICKETS_DB || '/tickets/tickets.db';

let db = null, cols = null, erreur = null;

function ouvre() {
  if (db || erreur) return;
  try {
    if (!fs.existsSync(CHEMIN)) { erreur = 'base absente : ' + CHEMIN; return; }
    db = new DatabaseSync(CHEMIN, { readOnly: true });
    cols = new Set(db.prepare('PRAGMA table_info(incidents)').all().map(r => r.name));
    if (!cols.size) { erreur = 'table incidents introuvable'; db.close(); db = null; }
  } catch (e) { erreur = String(e.message).slice(0, 120); }
}

/* Le champ qui porte la reference visible (T-1043) selon le schema. */
function colRef() {
  for (const c of ['ticket_id', 'ref', 'reference', 'numero']) if (cols.has(c)) return c;
  return 'id';
}

/* ---------- recherche ----------
   LIKE plutot que FTS : la table d'le service de tickets n'a pas d'index plein texte,
   et sur quelques centaines de lignes la difference est invisible. */
function cherche(q, limite = 8) {
  ouvre();
  if (!db) return { erreur };

  const mots = String(q).toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(m => m.length >= 4 && !/^(ticket|tickets|ouvert|ouverts|probleme|problème|comme|quoi|pour|avec|dans|cette|celui|concernant)$/.test(m));
  if (!mots.length) return { hits: [], mots: [] };

  const ref = colRef();
  const champs = ['title', 'body', 'summary', 'service', 'alert_key', 'payload_json']
    .filter(c => cols.has(c));
  if (!champs.length) return { erreur: 'aucun champ textuel dans incidents' };

  /* Un ticket qui contient PLUSIEURS des mots cherches remonte avant
     celui qui n'en contient qu'un : sans ce score, « root » seul
     ramenerait tout ce qui mentionne root en passant. */
  const score = mots.map(() =>
    '(' + champs.map(c => `(CASE WHEN lower(COALESCE(${c},'')) LIKE ? THEN 1 ELSE 0 END)`).join(' + ') + ' > 0)'
  ).join(' + ');
  const params = [];
  for (const m of mots) for (const _ of champs) params.push('%' + m + '%');

  const ouvertsSeuls = cols.has('closed_at') ? 'AND closed_at IS NULL' : '';
  const sql = `
    SELECT ${ref} AS ref,
           ${cols.has('service') ? 'service' : "''"} AS service,
           ${cols.has('severity') ? 'severity' : "''"} AS severity,
           ${cols.has('title') ? 'title' : "''"} AS title,
           ${cols.has('created_at') ? 'created_at' : "''"} AS created_at,
           ${cols.has('closed_at') ? '(closed_at IS NULL)' : '1'} AS ouvert,
           (${score}) AS pertinence
    FROM incidents
    WHERE (${score}) > 0
    ORDER BY pertinence DESC, ${cols.has('created_at') ? 'created_at DESC' : 'rowid DESC'}
    LIMIT ?`;

  try {
    /* le score figure deux fois dans la requete : les parametres aussi */
    const r = db.prepare(sql).all(...params, ...params, limite);
    return { hits: r, mots };
  } catch (e) {
    return { erreur: String(e.message).slice(0, 120) };
  }
}

function etat() {
  ouvre();
  if (!db) return { ok: false, erreur };
  try {
    const n = db.prepare(
      `SELECT count(*) n FROM incidents ${cols.has('closed_at') ? 'WHERE closed_at IS NULL' : ''}`).get().n;
    return { ok: true, ouverts: n, colonnes: [...cols].length };
  } catch (e) { return { ok: false, erreur: String(e.message).slice(0, 100) }; }
}

module.exports = { cherche, etat };
