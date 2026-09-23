'use strict';
/* ============================================================
   Vectorisation — le serveur de vecteurs (Ollama), hors du chemin d'écriture.

   Deux règles :

   1. Une panne d'Ollama ne doit JAMAIS arrêter l'ingestion. Les
      morceaux restent à embedded=0 et seront repris au prochain
      passage. Entre-temps l'entrée est déjà cherchable en plein texte.

   2. Le vecteur d'une requête est mis en cache. C'est le seul vrai
      goulot de la recherche : 200 à 400 ms là où tout le reste tient
      en 35 ms. Une requête déjà vue doit coûter zéro.
   ============================================================ */

const crypto = require('node:crypto');
const { vecToBlob } = require('./db.js');

class Embedder {
  constructor(opts = {}) {
    this.url    = opts.url   || process.env.OLLAMA_URL   || 'http://le serveur de vecteurs:11434';
    this.model  = opts.model || process.env.EMBED_MODEL  || 'nomic-embed-text';
    this.timeout = Number(opts.timeout || process.env.EMBED_TIMEOUT || 8000);
    this.cache  = new Map();
    this.cacheMax = 2000;
    this.ok = null;                 /* null = jamais testé */
    this.lastError = null;
  }

  async raw(text) {
    const ctl = AbortSignal.timeout(this.timeout);
    const r = await fetch(this.url + '/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: ctl
    });
    if (!r.ok) throw new Error('ollama ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j.embedding)) throw new Error('réponse sans embedding');
    this.ok = true; this.lastError = null;
    return j.embedding;
  }

  /* Vecteur d'une requête : mis en cache, normalisé, prêt pour le produit scalaire. */
  async query(text) {
    const key = crypto.createHash('sha1').update(this.model + '\u001f' + text).digest('hex');
    const hit = this.cache.get(key);
    if (hit) return hit;
    let v;
    try { v = await this.raw(text); }
    catch (e) { this.ok = false; this.lastError = String(e.message || e); throw e; }
    const f = new Float32Array(v.length);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = n > 0 ? 1 / Math.sqrt(n) : 0;
    for (let i = 0; i < v.length; i++) f[i] = v[i] * n;
    if (this.cache.size >= this.cacheMax) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, f);
    return f;
  }

  async health() {
    try {
      const r = await fetch(this.url + '/api/tags', { signal: AbortSignal.timeout(2000) });
      this.ok = r.ok;
      return r.ok;
    } catch (e) { this.ok = false; this.lastError = String(e.message || e); return false; }
  }
}

/* ---------- worker ----------
   Reprend les morceaux en attente par petits lots. Un échec ne
   consomme pas le morceau : il repassera. */
function startWorker(db, embedder, opts = {}) {
  const every = Number(opts.every || process.env.EMBED_INTERVAL || 4000);
  const batch = Number(opts.batch || process.env.EMBED_BATCH || 8);
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const rows = db.prepare(
        `SELECT id, text FROM chunks WHERE embedded = 0 ORDER BY id LIMIT ?`).all(batch);
      if (!rows.length) return;
      const upd = db.prepare(
        `UPDATE chunks SET vec=?, dim=?, model=?, embedded=1 WHERE id=?`);
      for (const row of rows) {
        try {
          const v = await embedder.raw(row.text);
          upd.run(vecToBlob(v), v.length, embedder.model, row.id);
        } catch {
          return;                  /* le serveur de vecteurs indisponible : on réessaiera au prochain tour */
        }
      }
    } finally { running = false; }
  }

  const t = setInterval(tick, every);
  if (t.unref) t.unref();
  tick();
  return { stop: () => clearInterval(t), tick };
}

module.exports = { Embedder, startWorker };
