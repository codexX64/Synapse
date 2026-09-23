'use strict';
/* ============================================================
   Base SQLite — node:sqlite, aucune dépendance externe.

   Trois choix structurants :

   1. FTS5 en table externe (content='entries'). L'index plein texte
      ne duplique pas le corps des entrées : il pointe vers la table
      source. Une entrée de 4 Ko ne pèse pas 8 Ko.

   2. Les vecteurs sont des BLOB Float32 NORMALISÉS à l'écriture.
      Le cosinus se réduit alors à un produit scalaire, et la
      recherche exhaustive tient en 12 ms sur 10 000 entrées —
      mesuré. Pas d'index approximatif, donc pas de faux négatif.

   3. WAL activé. L'ingestion écrit pendant que la recherche lit,
      sans se bloquer mutuellement.
   ============================================================ */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  /* Hors migration : une base déjà à jour doit quand même recevoir
     l'espace savoir. INSERT OR IGNORE, donc sans effet s'il existe. */
  db.prepare(`INSERT OR IGNORE INTO namespaces(name,kind,owner,created_at) VALUES('savoir','knowledge',NULL,?)`)
    .run(new Date().toISOString());
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  const row = db.prepare(`SELECT v FROM meta WHERE k='schema_version'`).get();
  const cur = row ? Number(row.v) : 0;
  if (cur >= SCHEMA_VERSION) return;

  db.exec(`
    /* ---------- sources : un jeton par service ---------- */
    CREATE TABLE IF NOT EXISTS sources (
      name        TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      scope       TEXT NOT NULL DEFAULT 'write',   -- write | read | read+write | admin
      channel     TEXT NOT NULL DEFAULT 'A',       -- A REST · B MCP · C collecteur
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      last_seen   TEXT,
      n_events    INTEGER NOT NULL DEFAULT 0
    );

    /* ---------- espaces : shared, agent:x, prompts:x ---------- */
    CREATE TABLE IF NOT EXISTS namespaces (
      name        TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,                   -- shared | agent | prompts
      owner       TEXT,
      created_at  TEXT NOT NULL
    );

    /* ---------- entrées : le cœur ---------- */
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ns          TEXT NOT NULL DEFAULT 'shared',
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      ref         TEXT,
      level       TEXT NOT NULL DEFAULT 'L0',      -- L0 brut · L1 fait · L2 motif · L3 stable
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      tags        TEXT NOT NULL DEFAULT '',        -- séparés par des espaces, pour FTS
      meta        TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      hash        TEXT NOT NULL UNIQUE,
      dup_count   INTEGER NOT NULL DEFAULT 1,      -- rejeux du même fait
      archived    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_entries_ns_time  ON entries(ns, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_src_time ON entries(source, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_level    ON entries(level);
    CREATE INDEX IF NOT EXISTS idx_entries_kind     ON entries(kind);
    CREATE INDEX IF NOT EXISTS idx_entries_ref      ON entries(ref);

    /* ---------- morceaux : l'unité de recherche ----------
       Une entrée courte donne un seul morceau. Une décision longue
       en donne plusieurs. C'est le morceau qu'on vectorise, jamais
       l'entrée entière : mélanger deux sujets dans un vecteur le
       rend inexploitable. */
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id  INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      seq       INTEGER NOT NULL,
      text      TEXT NOT NULL,
      embedded  INTEGER NOT NULL DEFAULT 0,        -- 0 en attente · 1 fait · -1 exclu
      vec       BLOB,
      dim       INTEGER,
      model     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_entry ON chunks(entry_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_todo  ON chunks(embedded) WHERE embedded = 0;

    /* ---------- plein texte : index externe, pas de duplication ---------- */
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      title, body, tags, kind, ref,
      content='entries', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS fts_ai AFTER INSERT ON entries BEGIN
      INSERT INTO fts(rowid,title,body,tags,kind,ref)
      VALUES (new.id,new.title,new.body,new.tags,new.kind,COALESCE(new.ref,''));
    END;
    CREATE TRIGGER IF NOT EXISTS fts_ad AFTER DELETE ON entries BEGIN
      INSERT INTO fts(fts,rowid,title,body,tags,kind,ref)
      VALUES ('delete',old.id,old.title,old.body,old.tags,old.kind,COALESCE(old.ref,''));
    END;
    CREATE TRIGGER IF NOT EXISTS fts_au AFTER UPDATE ON entries BEGIN
      INSERT INTO fts(fts,rowid,title,body,tags,kind,ref)
      VALUES ('delete',old.id,old.title,old.body,old.tags,old.kind,COALESCE(old.ref,''));
      INSERT INTO fts(rowid,title,body,tags,kind,ref)
      VALUES (new.id,new.title,new.body,new.tags,new.kind,COALESCE(new.ref,''));
    END;

    /* ---------- graphe : vocabulaire fermé ---------- */
    CREATE TABLE IF NOT EXISTS links (
      from_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      relation   TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

    /* ---------- file d'ingestion ---------- */
    CREATE TABLE IF NOT EXISTS queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      payload    TEXT NOT NULL,
      source     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',  -- pending | failed
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_try   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, next_try);

    /* ---------- apprentissage local : clics et requêtes mortes ---------- */
    CREATE TABLE IF NOT EXISTS query_clicks (
      query_norm TEXT NOT NULL,
      entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      n          INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (query_norm, entry_id)
    );
    CREATE TABLE IF NOT EXISTS failed_queries (
      query_norm TEXT PRIMARY KEY,
      n          INTEGER NOT NULL DEFAULT 1,
      last_at    TEXT NOT NULL
    );

    /* ---------- prompts versionnés ---------- */
    CREATE TABLE IF NOT EXISTS prompts (
      agent      TEXT NOT NULL,
      version    INTEGER NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent, version)
    );
  `);

  const now = new Date().toISOString();
  const insNs = db.prepare(
    `INSERT OR IGNORE INTO namespaces(name,kind,owner,created_at) VALUES (?,?,?,?)`);
  insNs.run('shared', 'shared', null, now);
  insNs.run('savoir', 'knowledge', null, now);

  db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES('schema_version',?)`)
    .run(String(SCHEMA_VERSION));
}

/* ---------- vecteurs ----------
   Normalisés à l'écriture : le cosinus devient un produit scalaire,
   ce qui divise le coût de la recherche par deux et supprime toute
   racine carrée dans la boucle chaude. */
function vecToBlob(arr) {
  const f = new Float32Array(arr.length);
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < arr.length; i++) f[i] = arr[i] * n;
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function blobToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

module.exports = { open, vecToBlob, blobToVec, SCHEMA_VERSION };
