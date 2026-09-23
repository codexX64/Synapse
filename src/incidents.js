'use strict';
/* ============================================================
   Mémoire opérationnelle — extension TRIAGE.

   Ce module n'est pas un journal d'incidents. C'est un cache
   sémantique : son rôle est que TRIAGE appelle le LLM de moins en
   moins souvent à mesure que l'infrastructure vieillit.

   Trois conséquences de conception, qui expliquent la suite :

   1. Les ÉCHECS pèsent autant que les réussites. Savoir que
      `restart_container` n'a PAS réglé un `proxy_502` évite un
      appel LLM et une tentative inutile. `failed_fixes` est le
      champ qui produit l'économie réelle.

   2. Le lookup est sur le CHEMIN CRITIQUE d'une alerte en cours.
      Budget : moins de 100 ms au p95. L0 et L1 sont donc de purs
      lookups indexés, sans aucun calcul. Le L3 textuel a un
      délai dur : dépassé, on rend `match: false` plutôt que de
      faire attendre — un lookup lent est pire qu'un lookup vide,
      puisqu'il coûte le temps ET l'appel LLM.

   3. Le DERNIER résultat pèse plus que l'ancien. `success_rate`
      se calcule sur les N dernières occurrences, jamais sur tout
      l'historique : un fix qui marchait il y a un an mais échoue
      depuis trois mois doit tomber vite.
   ============================================================ */

const crypto = require('node:crypto');

const OUTCOMES = new Set(['resolved', 'failed', 'restored', 'manual']);
const ORIGINS  = new Set(['catalog', 'generated', 'operator']);

const LIM = {
  alert_key: 120, service: 120, host: 120,
  symptom: 2000, root_cause: 2000, resolution: 300,
  command_item: 500, command_len: 40
};

const RATE_WINDOW_DEFAULT = 10;   /* N dernières occurrences pour success_rate */
const L3_TIMEOUT_MS = 35;         /* budget dur du niveau textuel */

/* ---------- migration ---------- */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      signature   TEXT NOT NULL,
      alert_key   TEXT NOT NULL,
      service     TEXT NOT NULL,
      host        TEXT,
      vlan        INTEGER,
      symptom     TEXT NOT NULL DEFAULT '',
      root_cause  TEXT NOT NULL DEFAULT '',
      resolution  TEXT NOT NULL DEFAULT '',
      outcome     TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 1,
      origin      TEXT NOT NULL DEFAULT 'catalog',
      command     TEXT,
      duration_s  REAL,
      cost_usd    REAL,
      occurred_at TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      entry_id    INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      UNIQUE (signature, occurred_at)      -- idempotence exigée par le contrat
    );
    /* L0 : signature seule. L1 : alert_key + service. Les deux doivent
       être de simples parcours d'index, jamais de scan. */
    CREATE INDEX IF NOT EXISTS idx_inc_sig      ON incidents(signature, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inc_key_svc  ON incidents(alert_key, service, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inc_key      ON incidents(alert_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inc_service  ON incidents(service, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inc_time     ON incidents(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inc_origin   ON incidents(origin);

    /* Une signature vue douze fois doit être UN nœud fort, pas douze
       nœuds faibles. Cette table porte le renforcement par récurrence. */
    CREATE TABLE IF NOT EXISTS incident_signatures (
      signature   TEXT PRIMARY KEY,
      alert_key   TEXT NOT NULL,
      service     TEXT NOT NULL,
      host        TEXT,
      occurrences INTEGER NOT NULL DEFAULT 0,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      strength    REAL NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_sig_key ON incident_signatures(alert_key, service);

    /* Synthèse produite par la rétention, une fois les instances
       individuelles supprimées. */
    CREATE TABLE IF NOT EXISTS incident_rollup (
      signature    TEXT PRIMARY KEY,
      alert_key    TEXT NOT NULL,
      service      TEXT NOT NULL,
      host         TEXT,
      occurrences  INTEGER NOT NULL,
      resolved     INTEGER NOT NULL,
      best_fix     TEXT,
      failed_fixes TEXT,
      last_seen    TEXT NOT NULL,
      rolled_at    TEXT NOT NULL
    );
  `);
}

/* ---------- signature ----------
   Doit être STABLE dans le temps : deux incidents identiques à deux mois
   d'écart produisent le même hash. Tout ce qui varie d'une occurrence à
   l'autre est donc écarté — horodatages, identifiants de conteneur, ports
   éphémères, numéros de ticket, durées, tailles. */
function normalizeError(symptom) {
  let s = String(symptom || '').toLowerCase();

  s = s
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][\d:.]+z?\b/g, ' ')      /* horodatages   */
    .replace(/\b[0-9a-f]{12,64}\b/g, ' ')                      /* id conteneur  */
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ' ')              /* adresses IP   */
    .replace(/:(?:[1-9]\d{3,4})\b/g, ' ')                      /* ports         */
    .replace(/\b(?:cht|inc|tkt)-\d+\b/gi, ' ')                 /* tickets       */
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|mb|gb|ko|mo|go)\b/g, ' ') /* durées, tailles */
    .replace(/\b\d{6,}\b/g, ' ')                               /* gros nombres  */
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  /* On garde les motifs qui portent le sens de la panne, y compris les
     codes HTTP : un 502 et un 504 ne sont pas le même incident. */
  const marqueurs = [];
  const m = s.match(/\b[45]\d{2}\b/);
  if (m) marqueurs.push(m[0]);
  for (const mot of ['oom', 'timeout', 'refused', 'unreachable', 'denied',
                     'notfound', 'crash', 'unhealthy', 'exhausted', 'corrupt',
                     'expired', 'conflict', 'locked', 'readonly']) {
    if (s.includes(mot)) marqueurs.push(mot);
  }
  /* À défaut de marqueur connu, les premiers mots significatifs font foi. */
  if (!marqueurs.length) {
    marqueurs.push(...s.split(' ').filter(w => w.length > 3).slice(0, 4));
  }
  return marqueurs.sort().join('|');
}

function signatureOf({ alert_key, service, host, symptom }) {
  return crypto.createHash('sha256')
    .update([
      String(alert_key || '').toLowerCase(),
      String(service   || '').toLowerCase(),
      String(host      || '').toLowerCase(),
      normalizeError(symptom)
    ].join('\u001f'))
    .digest('hex')
    .slice(0, 32);
}

/* ---------- validation ----------
   Le payload vient d'un service qui a lui-même parlé à un LLM : on ne
   fait confiance à aucune longueur ni à aucun type. */
function validate(p) {
  const e = [];
  const txt = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

  if (!p || typeof p !== 'object') return { error: 'payload absent' };
  if (!txt(p.alert_key, LIM.alert_key)) e.push('alert_key requis');
  if (!txt(p.service, LIM.service))     e.push('service requis');
  if (!OUTCOMES.has(p.outcome))         e.push('outcome ∈ ' + [...OUTCOMES].join('|'));
  if (p.origin && !ORIGINS.has(p.origin)) e.push('origin ∈ ' + [...ORIGINS].join('|'));

  let command = null;
  if (p.origin === 'generated') {
    if (!Array.isArray(p.command) || !p.command.length) {
      e.push('command (argv) requis quand origin = generated');
    } else {
      command = p.command.slice(0, LIM.command_len)
                         .map(x => txt(x, LIM.command_item));
    }
  } else if (p.command != null && !Array.isArray(p.command)) {
    e.push('command doit être un tableau argv ou null');
  } else if (Array.isArray(p.command)) {
    command = p.command.slice(0, LIM.command_len).map(x => txt(x, LIM.command_item));
  }

  if (e.length) return { error: e.join(' · ') };

  const at = new Date(p.occurred_at || Date.now());
  return {
    value: {
      alert_key:  txt(p.alert_key, LIM.alert_key),
      service:    txt(p.service, LIM.service),
      host:       txt(p.host, LIM.host) || null,
      vlan:       Number.isFinite(+p.vlan) ? Math.trunc(+p.vlan) : null,
      symptom:    txt(p.symptom, LIM.symptom),
      root_cause: txt(p.root_cause, LIM.root_cause),
      resolution: txt(p.resolution, LIM.resolution),
      outcome:    p.outcome,
      attempts:   Math.max(1, Math.min(999, Math.trunc(+p.attempts || 1))),
      origin:     p.origin || 'catalog',
      command:    command ? JSON.stringify(command) : null,
      duration_s: Number.isFinite(+p.duration_s) ? +p.duration_s : null,
      cost_usd:   Number.isFinite(+p.cost_usd)   ? +p.cost_usd   : null,
      occurred_at: isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString()
    }
  };
}

/* ---------- écriture ---------- */
function record(db, payload, opts = {}) {
  const v = validate(payload);
  if (v.error) return { ok: false, error: v.error };
  const o = v.value;
  const sig = signatureOf(o);
  const now = new Date().toISOString();

  const dup = db.prepare(
    `SELECT id FROM incidents WHERE signature=? AND occurred_at=?`).get(sig, o.occurred_at);
  if (dup) return { ok: true, id: dup.id, signature: sig, duplicate: true };

  const info = db.prepare(`
    INSERT INTO incidents(signature,alert_key,service,host,vlan,symptom,root_cause,
      resolution,outcome,attempts,origin,command,duration_s,cost_usd,occurred_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sig, o.alert_key, o.service, o.host, o.vlan, o.symptom, o.root_cause,
         o.resolution, o.outcome, o.attempts, o.origin, o.command,
         o.duration_s, o.cost_usd, o.occurred_at, now);
  const id = Number(info.lastInsertRowid);

  /* --- renforcement par récurrence, et dépréciation ---
     Une résolution qui marchait et cesse de marcher doit perdre du poids
     tout de suite. Sans ça, SYNAPSE recommanderait éternellement un fix
     devenu obsolète. */
  const delta = o.outcome === 'resolved' ? 0.5 : -0.8;
  db.prepare(`
    INSERT INTO incident_signatures(signature,alert_key,service,host,occurrences,
      first_seen,last_seen,strength)
    VALUES(?,?,?,?,1,?,?,?)
    ON CONFLICT(signature) DO UPDATE SET
      occurrences = occurrences + 1,
      last_seen   = excluded.last_seen,
      strength    = MAX(0.1, MIN(10, strength + ?))`)
    .run(sig, o.alert_key, o.service, o.host, o.occurred_at, o.occurred_at,
         Math.max(0.1, 1 + delta), delta);

  return { ok: true, id, signature: sig, occurrences: occurrencesOf(db, sig) };
}

function occurrencesOf(db, sig) {
  const r = db.prepare(`SELECT occurrences FROM incident_signatures WHERE signature=?`).get(sig);
  return r ? r.occurrences : 1;
}

/* ---------- agrégats d'une population d'incidents ----------
   success_rate sur les N DERNIÈRES occurrences seulement : c'est ce qui
   fait chuter un fix qui se dégrade au lieu de le maintenir à flot avec
   ses réussites d'il y a un an. */
function summarize(rows, n = RATE_WINDOW_DEFAULT) {
  if (!rows.length) return null;
  const recent = rows.slice(0, n);

  const okCount = recent.filter(r => r.outcome === 'resolved').length;

  /* Les lignes arrivent du plus récent au plus ancien : on conserve donc
     l'ordre pour chaque fix, car c'est le DERNIER résultat qui tranche. */
  const parFix = new Map();
  for (const r of recent) {
    if (!r.resolution) continue;
    const e = parFix.get(r.resolution) || { ok: 0, ko: 0, dernier: null };
    r.outcome === 'resolved' ? e.ok++ : e.ko++;
    if (e.dernier === null) e.dernier = r.outcome;   /* premier vu = plus récent */
    parFix.set(r.resolution, e);
  }

  /* Un fix « qui marchait » compte pour rien s'il vient d'échouer deux
     fois. Exiger zéro réussite pour le signaler laissait passer le cas
     le plus courant : la dégradation. On regarde le dernier résultat et
     le taux récent, pas le total historique. */
  const estMort = e => e.dernier !== 'resolved' || (e.ok / (e.ok + e.ko)) < 0.4;

  let best = null, bestScore = -1;
  for (const [fix, e] of parFix) {
    if (estMort(e)) continue;                        /* jamais recommander un fix qui vient d'échouer */
    const score = e.ok / (e.ok + e.ko) + e.ok * 0.01;
    if (score > bestScore) { best = fix; bestScore = score; }
  }

  const failed = [...parFix.entries()]
    .filter(([fix, e]) => estMort(e) && fix !== best)
    .sort((a, b) => b[1].ko - a[1].ko)
    .map(([fix]) => fix);

  const withCause = rows.find(r => r.root_cause);

  return {
    known_cause:  withCause ? withCause.root_cause : null,
    known_fix:    best,
    success_rate: +(okCount / recent.length).toFixed(2),
    occurrences:  rows.length,
    window:       recent.length,
    last_seen:    rows[0].occurred_at,
    failed_fixes: failed
  };
}

/* ---------- cascade ----------
   Du moins cher au plus cher, arrêt au premier niveau exploitable. */
function lookup(db, q, opts = {}) {
  const t0 = performance.now();
  const n = Number(opts.window || RATE_WINDOW_DEFAULT);
  const vide = (why) => ({
    match: false, similarity: 0, level: null, reason: why,
    took_ms: +(performance.now() - t0).toFixed(1)
  });

  if (!q || !q.alert_key || !q.service) return vide('alert_key et service requis');

  const cols = `id,signature,alert_key,service,host,symptom,root_cause,
                resolution,outcome,origin,occurred_at`;
  const rendre = (rows, level, similarity) => {
    const s = summarize(rows, n);
    if (!s) return null;
    return Object.assign({ match: true, similarity, level }, s,
      { took_ms: +(performance.now() - t0).toFixed(1) });
  };

  /* --- L0 : signature identique, lookup indexé pur --- */
  const sig = signatureOf(q);
  let rows = db.prepare(
    `SELECT ${cols} FROM incidents WHERE signature=? ORDER BY occurred_at DESC LIMIT 50`).all(sig);
  if (rows.length) { const r = rendre(rows, 'L0', 1.0); if (r) return r; }

  /* --- L1 : même alerte, même service --- */
  rows = db.prepare(
    `SELECT ${cols} FROM incidents WHERE alert_key=? AND service=?
     ORDER BY occurred_at DESC LIMIT 50`).all(q.alert_key, q.service);
  if (rows.length) { const r = rendre(rows, 'L1', 0.9); if (r) return r; }

  /* --- L2 : même alerte, autre hôte --- */
  rows = db.prepare(
    `SELECT ${cols} FROM incidents WHERE alert_key=? AND (host IS NOT ? OR host IS NULL)
     ORDER BY occurred_at DESC LIMIT 50`).all(q.alert_key, q.host || null);
  if (rows.length) { const r = rendre(rows, 'L2', 0.7); if (r) return r; }

  /* --- L3 : textuel, avec budget dur ---
     Un lookup lent est pire qu'un lookup vide : il coûte le temps ET
     l'appel LLM qui suivra. Au-delà du budget, on rend match:false. */
  if (performance.now() - t0 > L3_TIMEOUT_MS) return vide('budget dépassé avant L3');

  const mots = normalizeError(q.symptom).split('|').filter(w => w.length > 2);
  if (!mots.length) return vide('aucun incident comparable');

  const like = mots.map(() => `(symptom LIKE ? OR root_cause LIKE ?)`).join(' OR ');
  const args = [];
  mots.forEach(w => { args.push('%' + w + '%', '%' + w + '%'); });
  rows = db.prepare(
    `SELECT ${cols} FROM incidents WHERE ${like} ORDER BY occurred_at DESC LIMIT 30`).all(...args);

  if (performance.now() - t0 > L3_TIMEOUT_MS * 2) return vide('L3 trop lent');
  if (!rows.length) return vide('aucun incident comparable');

  /* score = part des marqueurs retrouvés dans le meilleur candidat */
  let meilleur = 0;
  for (const r of rows) {
    const t = (r.symptom + ' ' + r.root_cause).toLowerCase();
    const n2 = mots.filter(w => t.includes(w)).length / mots.length;
    if (n2 > meilleur) meilleur = n2;
  }
  const sim = +(0.3 + meilleur * 0.35).toFixed(2);   /* L3 plafonne sous L2 */
  const r = rendre(rows, 'L3', sim);
  return r || vide('aucun incident comparable');
}

/* ---------- historique et statistiques ---------- */
function history(db, service, limit = 50) {
  return db.prepare(`
    SELECT id,signature,alert_key,service,host,symptom,root_cause,resolution,
           outcome,origin,attempts,duration_s,cost_usd,occurred_at
    FROM incidents WHERE service=? ORDER BY occurred_at DESC LIMIT ?`)
    .all(service, Math.min(500, limit));
}

function stats(db, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const instables = db.prepare(`
    SELECT service, count(*) n,
           SUM(CASE WHEN outcome='resolved' THEN 1 ELSE 0 END) ok,
           MAX(occurred_at) last_seen
    FROM incidents WHERE occurred_at >= ?
    GROUP BY service ORDER BY n DESC LIMIT 15`).all(since);

  const fixes = db.prepare(`
    SELECT resolution, count(*) n,
           SUM(CASE WHEN outcome='resolved' THEN 1 ELSE 0 END) ok
    FROM incidents WHERE occurred_at >= ? AND resolution <> ''
    GROUP BY resolution HAVING n >= 2 ORDER BY n DESC LIMIT 20`).all(since);

  /* Un fix « en dégradation » réussissait avant et échoue maintenant.
     C'est le signal qui justifie d'aller regarder : le taux global ne le
     montre pas, il est encore bon. */
  const moitie = new Date(Date.now() - days * 43200000).toISOString();
  const degradation = db.prepare(`
    SELECT resolution,
      SUM(CASE WHEN occurred_at <  ? AND outcome='resolved' THEN 1 ELSE 0 END) ok_avant,
      SUM(CASE WHEN occurred_at <  ? THEN 1 ELSE 0 END)                        n_avant,
      SUM(CASE WHEN occurred_at >= ? AND outcome='resolved' THEN 1 ELSE 0 END) ok_apres,
      SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END)                        n_apres
    FROM incidents WHERE occurred_at >= ? AND resolution <> ''
    GROUP BY resolution HAVING n_avant >= 2 AND n_apres >= 2`)
    .all(moitie, moitie, moitie, moitie, since)
    .map(r => ({
      resolution: r.resolution,
      avant: +(r.ok_avant / r.n_avant).toFixed(2),
      apres: +(r.ok_apres / r.n_apres).toFixed(2),
      chute: +((r.ok_avant / r.n_avant) - (r.ok_apres / r.n_apres)).toFixed(2)
    }))
    .filter(r => r.chute >= 0.25)
    .sort((a, b) => b.chute - a.chute);

  const eco = db.prepare(`
    SELECT count(*) n, COALESCE(SUM(cost_usd),0) cost
    FROM incidents WHERE occurred_at >= ?`).get(since);

  return {
    days,
    services_instables: instables.map(r => ({
      service: r.service, incidents: r.n,
      success_rate: +(r.ok / r.n).toFixed(2), last_seen: r.last_seen
    })),
    fixes_fiables: fixes.map(r => ({
      resolution: r.resolution, usages: r.n, success_rate: +(r.ok / r.n).toFixed(2)
    })).sort((a, b) => b.success_rate - a.success_rate),
    fixes_en_degradation: degradation,
    total_incidents: eco.n,
    cout_llm_usd: +eco.cost.toFixed(3)
  };
}

/* ---------- rétention ----------
   12 mois en détail, puis synthèse par signature. Les incidents
   `generated` sont conservés indéfiniment : ce sont des commandes ad-hoc
   approuvées à la main, elles ont une valeur d'audit. */
function retention(db, months = 12) {
  const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString();

  const sigs = db.prepare(`
    SELECT DISTINCT signature FROM incidents
    WHERE occurred_at < ? AND origin <> 'generated'`).all(cutoff);

  let rolled = 0, deleted = 0;
  const now = new Date().toISOString();

  for (const { signature } of sigs) {
    const rows = db.prepare(`
      SELECT * FROM incidents WHERE signature=? AND origin <> 'generated'
      ORDER BY occurred_at DESC`).all(signature);
    if (!rows.length) continue;
    const s = summarize(rows, rows.length);

    db.prepare(`
      INSERT INTO incident_rollup(signature,alert_key,service,host,occurrences,
        resolved,best_fix,failed_fixes,last_seen,rolled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(signature) DO UPDATE SET
        occurrences=excluded.occurrences, resolved=excluded.resolved,
        best_fix=excluded.best_fix, failed_fixes=excluded.failed_fixes,
        last_seen=excluded.last_seen, rolled_at=excluded.rolled_at`)
      .run(signature, rows[0].alert_key, rows[0].service, rows[0].host,
           rows.length, rows.filter(r => r.outcome === 'resolved').length,
           s.known_fix, JSON.stringify(s.failed_fixes), rows[0].occurred_at, now);
    rolled++;

    const d = db.prepare(`
      DELETE FROM incidents WHERE signature=? AND occurred_at < ? AND origin <> 'generated'`)
      .run(signature, cutoff);
    deleted += Number(d.changes || 0);
  }
  return { signatures_agregees: rolled, instances_supprimees: deleted, cutoff };
}

module.exports = {
  migrate, record, lookup, history, stats, retention,
  signatureOf, normalizeError, validate, summarize,
  OUTCOMES, ORIGINS, RATE_WINDOW_DEFAULT, L3_TIMEOUT_MS
};
