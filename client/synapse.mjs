/* ============================================================
   Client SYNAPSE — version module ES.

   Identique à synapse.js (CommonJS) : mêmes garanties, même
   comportement. Seule la syntaxe d'import/export change.

   À utiliser quand le package.json du projet contient
   "type": "module". Sinon, prendre synapse.js.

   Trois garanties :
     1. JAMAIS bloquant — 2 s d'expiration, aucune exception ne
        remonte à l'appelant.
     2. RIEN N'EST PERDU — un échec écrit l'événement dans un
        spool disque, rejoué au prochain envoi réussi.
     3. IDEMPOTENT — le hash porte l'identité du fait, pas son
        horodatage : un rejeu n'écrit pas deux fois.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CFG = {
  url:    process.env.SYNAPSE_URL    || 'http://synapse:8140',
  token:  process.env.SYNAPSE_TOKEN  || '',
  source: process.env.SYNAPSE_SOURCE || 'inconnu',
  spool:  process.env.SYNAPSE_SPOOL  || '/var/tmp/synapse-spool',
  timeout: 2000,
  maxSpool: 500
};

const enabled = !!CFG.token;
if (!enabled) console.warn('[synapse] SYNAPSE_TOKEN absent — envois désactivés');

/* ---------- spool disque ---------- */
function spoolDir() {
  try { fs.mkdirSync(CFG.spool, { recursive: true }); return true; }
  catch { return false; }
}
function spoolWrite(evt) {
  if (!spoolDir()) return;
  try {
    const f = path.join(CFG.spool, `${Date.now()}-${evt.hash.slice(0, 12)}.json`);
    fs.writeFileSync(f, JSON.stringify(evt));
    const all = fs.readdirSync(CFG.spool).sort();
    if (all.length > CFG.maxSpool) {
      all.slice(0, all.length - CFG.maxSpool)
         .forEach(n => { try { fs.unlinkSync(path.join(CFG.spool, n)); } catch {} });
    }
  } catch {}
}
function spoolRead() {
  try { return fs.readdirSync(CFG.spool).sort().slice(0, 100); }
  catch { return []; }
}

/* ---------- normalisation ---------- */
function build(evt) {
  const o = {
    source:      evt.source || CFG.source,
    kind:        evt.kind,
    ref:         evt.ref || null,
    title:       String(evt.title || '').slice(0, 300),
    body:        String(evt.body || ''),
    tags:        Array.isArray(evt.tags) ? evt.tags.slice(0, 20) : [],
    occurred_at: evt.occurred_at || new Date().toISOString(),
    meta:        evt.meta || {}
  };
  /* Le hash porte l'identité de l'événement, pas sa date : deux envois
     du même fait à deux secondes d'écart sont le même fait. */
  o.hash = crypto.createHash('sha256')
    .update([o.source, o.kind, o.ref || '', o.title, o.body].join('\u001f'))
    .digest('hex');
  return o;
}

/* ---------- transport ---------- */
async function post(pathname, payload) {
  const r = await fetch(CFG.url + pathname, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CFG.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CFG.timeout)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

/** Rejoue le spool. Silencieux : si ça échoue encore, on garde. */
export async function flush() {
  if (!enabled) return 0;
  const files = spoolRead();
  if (!files.length) return 0;
  const batch = [], keep = [];
  for (const n of files) {
    const p = path.join(CFG.spool, n);
    try { batch.push(JSON.parse(fs.readFileSync(p, 'utf8'))); keep.push(p); }
    catch { try { fs.unlinkSync(p); } catch {} }
  }
  if (!batch.length) return 0;
  try {
    await post('/v1/ingest/batch', { events: batch });
    keep.forEach(p => { try { fs.unlinkSync(p); } catch {} });
    return batch.length;
  } catch { return 0; }
}

/**
 * Consigne un événement dans SYNAPSE.
 * Ne rejette jamais. N'attend jamais plus de CFG.timeout.
 *
 *   remember({
 *     kind: 'ticket.closed',
 *     ref:  'CHT-412',
 *     title:'Migration srv-app-01 vers VLAN 30',
 *     body: 'Port 14 tagué Servers, vérifié par ping inter-VLAN.',
 *     tags: ['network','vlan']
 *   });
 */
export function remember(evt) {
  if (!enabled || !evt || !evt.kind) return Promise.resolve(false);
  const o = build(evt);
  return post('/v1/ingest', o)
    .then(() => { flush(); return true; })
    .catch(() => { spoolWrite(o); return false; });
}

/** Version bloquante, pour les scripts one-shot qui vont se terminer. */
export async function rememberSync(evt) {
  const ok = await remember(evt);
  if (!ok) await flush();
  return ok;
}

/** Sonde de disponibilité — pour un healthcheck, pas pour du contrôle de flux. */
export async function ping() {
  try {
    const r = await fetch(CFG.url + '/healthz', { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

/* Rejeu périodique : couvre le cas où le service n'émet plus rien
   pendant que l'arriéré s'accumule. unref pour ne pas retenir Node. */
if (enabled) {
  const t = setInterval(() => { flush(); }, 60000);
  if (t.unref) t.unref();
}

export { CFG };
