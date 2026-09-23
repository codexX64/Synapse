'use strict';
/* ============================================================
   Contrat public SYNAPSE — /v1/recall et /v1/neurons.

   Figé par TRIAGE. Trois règles gouvernent tout ce fichier, dans
   cet ordre de priorité :

   1. NE JAMAIS BLOQUER. SYNAPSE est un confort. Un client qui
      n'obtient rien continue sans mémoire. Aucun chemin ne doit
      pouvoir dépasser le plafond de 3 s.

   2. FAIRE ÉCONOMISER. Un rappel utile évite un appel au modèle.
      C'est la seule raison d'exister de la récupération.

   3. NE PAS MENTIR. Au-dessus de 0.85, TRIAGE EXÉCUTE la
      résolution rappelée sur l'infrastructure. Une similarité
      surévaluée provoque une mauvaise correction. Mieux vaut
      aucun résultat qu'un à-peu-près.

   La troisième règle explique toute la calibration ci-dessous :
   seul un L0 exact, `resolved` et récent peut franchir 0.85.
   Tout le reste est plafonné SOUS le seuil de décision, par
   construction et pas par réglage.
   ============================================================ */

const crypto = require('node:crypto');

/* ---------- calibration ----------
   DECISION_THRESHOLD est le seuil auquel TRIAGE exécute. Les plafonds
   par niveau sont volontairement en dessous : un niveau ne peut pas
   déclencher une action s'il n'a pas identifié l'incident exactement. */
const DECISION_THRESHOLD = 0.85;

const LEVEL = {
  /* L0 — correspondance exacte sur signature, ou alert_key+service.
     Seul niveau autorisé à franchir le seuil. */
  L0: { base: 0.97, cap: 0.99 },
  /* L1 — lexical BM25. Une bonne correspondance textuelle ne prouve
     pas qu'il s'agit du même incident : plafonné sous le seuil. */
  L1: { base: 0.80, cap: 0.84 },
  /* L2 — sémantique. Même raisonnement, et la similarité vectorielle
     est plus permissive encore que le lexical. */
  L2: { base: 0.74, cap: 0.84 },
  /* L3 — voisinage de graphe. Ce n'est pas le même incident, c'est un
     incident lié. Pénalisé fortement : informatif, jamais actionnable. */
  L3: { base: 0.45, cap: 0.60 }
};

/* Un échec n'est pas un correctif. Quel que soit le niveau, un neurone
   dont l'issue n'est pas `resolved` ne peut pas franchir le seuil. */
const NON_RESOLVED_CAP = 0.60;

/* Décote temporelle : période de grâce, puis décroissance exponentielle.

   Une décote pure de demi-vie 90 j faisait tomber un L0 parfait sous le
   seuil de décision au bout de 30 jours — beaucoup trop tôt. Une
   infrastructure ne se refait pas en un mois, et le prompt vise le
   neurone de 8 mois, pas celui du mois dernier.

   Avec 45 j de grâce et 150 j de demi-vie : un correctif de moins de
   ~75 jours peut encore déclencher une exécution, au-delà il est proposé
   mais repasse sous le seuil et demande donc une décision. */
const GRACE_DAYS = 45;
const HALF_LIFE_DAYS = 150;

/* Le retour du client pèse sur les rappels suivants. Un neurone rappelé
   puis jugé inutile doit descendre, sinon on le recommande éternellement. */
const FEEDBACK_PENALTY = 0.25;   /* retiré au maximum, à 100% d'inutilité */
const FEEDBACK_BONUS   = 0.03;   /* ajouté au maximum, plafonné par le cap */

const OUTCOMES = new Set(['resolved', 'restored', 'failed', 'manual']);
const TO_TYPES = new Set(['service', 'host', 'alert_key', 'signature', 'project', 'topic']);

const LIM = {
  key: 160, text: 4000, action: 160, type: 60,
  neuron_bytes: 32000, synapses: 24
};

/* ---------- schéma ---------- */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS neurons (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,              -- client qui a écrit
      type         TEXT NOT NULL,
      alert_key    TEXT, host TEXT, service TEXT, signature TEXT,
      root_cause   TEXT NOT NULL DEFAULT '',
      resolution   TEXT NOT NULL DEFAULT '',
      action_id    TEXT,
      outcome      TEXT,
      attempts     INTEGER NOT NULL DEFAULT 1,
      duration_s   REAL, cost_usd REAL,
      content      TEXT NOT NULL DEFAULT '{}', -- charge libre des autres types
      occurred_at  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrences  INTEGER NOT NULL DEFAULT 1,
      fb_useful    INTEGER NOT NULL DEFAULT 0,
      fb_total     INTEGER NOT NULL DEFAULT 0,
      deleted      INTEGER NOT NULL DEFAULT 0
    );
    /* L0 doit être un parcours d'index, jamais un scan. */
    CREATE INDEX IF NOT EXISTS idx_n_sig  ON neurons(signature, outcome, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_n_ak   ON neurons(alert_key, service, outcome, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_n_src  ON neurons(source, type);
    CREATE INDEX IF NOT EXISTS idx_n_type ON neurons(type, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_n_occ  ON neurons(occurred_at DESC);

    CREATE TABLE IF NOT EXISTS synapse_links (
      neuron_id INTEGER NOT NULL REFERENCES neurons(id) ON DELETE CASCADE,
      to_type   TEXT NOT NULL,
      to_key    TEXT NOT NULL,
      weight    REAL NOT NULL DEFAULT 1,
      PRIMARY KEY (neuron_id, to_type, to_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sl_target ON synapse_links(to_type, to_key);

    /* Index plein texte externe : pas de duplication du corps. */
    CREATE VIRTUAL TABLE IF NOT EXISTS nfts USING fts5(
      root_cause, resolution, action_id,
      content='neurons', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS nfts_ai AFTER INSERT ON neurons BEGIN
      INSERT INTO nfts(rowid,root_cause,resolution,action_id)
      VALUES (new.id,new.root_cause,new.resolution,COALESCE(new.action_id,''));
    END;
    CREATE TRIGGER IF NOT EXISTS nfts_ad AFTER DELETE ON neurons BEGIN
      INSERT INTO nfts(nfts,rowid,root_cause,resolution,action_id)
      VALUES ('delete',old.id,old.root_cause,old.resolution,COALESCE(old.action_id,''));
    END;
    CREATE TRIGGER IF NOT EXISTS nfts_au AFTER UPDATE ON neurons BEGIN
      INSERT INTO nfts(nfts,rowid,root_cause,resolution,action_id)
      VALUES ('delete',old.id,old.root_cause,old.resolution,COALESCE(old.action_id,''));
      INSERT INTO nfts(rowid,root_cause,resolution,action_id)
      VALUES (new.id,new.root_cause,new.resolution,COALESCE(new.action_id,''));
    END;

    /* Vecteurs : optionnels. Sans eux, L2 est simplement désactivé. */
    CREATE TABLE IF NOT EXISTS neuron_vec (
      neuron_id INTEGER PRIMARY KEY REFERENCES neurons(id) ON DELETE CASCADE,
      vec BLOB NOT NULL, dim INTEGER NOT NULL, model TEXT
    );

    CREATE TABLE IF NOT EXISTS recall_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, query_norm TEXT NOT NULL,
      neuron_id INTEGER, level TEXT, similarity REAL,
      took_ms REAL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_at ON recall_log(at DESC);
  `);
}

/* ---------- utilitaires ---------- */
const txt = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* Comparaison à temps constant : une comparaison naïve laisse fuir la
   longueur du préfixe correct, donc la clé, par mesure de temps. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) {
    /* on compare quand même, pour ne pas révéler la longueur */
    crypto.timingSafeEqual(x, x);
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

/* ---------- décote temporelle ----------
   Décroissance exponentielle de demi-vie HALF_LIFE_DAYS, appliquée en
   MULTIPLICATION sur la similarité. Un rappel ancien reste possible,
   mais ne peut plus déclencher d'exécution automatique. */
function ageFactor(occurredAt, now = Date.now()) {
  const days = Math.max(0, (now - new Date(occurredAt).getTime()) / 86400000);
  if (days <= GRACE_DAYS) return 1;
  return Math.pow(0.5, (days - GRACE_DAYS) / HALF_LIFE_DAYS);
}

/* ---------- retour du client ---------- */
function feedbackFactor(row) {
  if (!row.fb_total) return 1;
  const useful = row.fb_useful / row.fb_total;
  /* de 1 - FEEDBACK_PENALTY (jamais utile) à 1 + FEEDBACK_BONUS (toujours) */
  return 1 - FEEDBACK_PENALTY * (1 - useful) + FEEDBACK_BONUS * useful;
}

/* ---------- score final ----------
   Le plafond du niveau est appliqué EN DERNIER : aucun bonus, aucune
   fraîcheur, aucun retour positif ne peut faire franchir à un L1 le
   seuil de décision. C'est la garantie structurelle de la règle 3. */
function score(level, raw, row, now) {
  const cfg = LEVEL[level];
  let s = raw * ageFactor(row.occurred_at, now) * feedbackFactor(row);
  if (row.outcome && row.outcome !== 'resolved') s = Math.min(s, NON_RESOLVED_CAP);
  return +clamp(s, 0, cfg.cap).toFixed(4);
}

/* ---------- validation ---------- */
function validateNeuron(n, sourceName) {
  const e = [];
  if (!n || typeof n !== 'object') return { error: 'neuron absent' };
  if (JSON.stringify(n).length > LIM.neuron_bytes) return { error: 'neurone trop volumineux' };

  const type = txt(n.type, LIM.type);
  if (!type) e.push('type requis');
  if (n.outcome != null && !OUTCOMES.has(n.outcome))
    e.push('outcome ∈ ' + [...OUTCOMES].join('|'));
  if (type === 'incident_resolution') {
    if (!txt(n.signature, LIM.key) && !txt(n.alert_key, LIM.key))
      e.push('signature ou alert_key requis pour incident_resolution');
    if (!n.outcome) e.push('outcome requis pour incident_resolution');
  }
  if (e.length) return { error: e.join(' · ') };

  const at = new Date(n.occurred_at || Date.now());
  return {
    value: {
      source: sourceName,
      type,
      alert_key: txt(n.alert_key, LIM.key) || null,
      host:      txt(n.host, LIM.key) || null,
      service:   txt(n.service, LIM.key) || null,
      signature: txt(n.signature, LIM.key) || null,
      root_cause: txt(n.root_cause, LIM.text),
      resolution: txt(n.resolution, LIM.text),
      action_id:  txt(n.action_id, LIM.action) || null,
      outcome:    n.outcome || null,
      attempts:   clamp(Math.trunc(+n.attempts || 1), 1, 9999),
      duration_s: Number.isFinite(+n.duration_s) ? +n.duration_s : null,
      cost_usd:   Number.isFinite(+n.cost_usd) ? +n.cost_usd : null,
      /* Le contenu vient peut-être d'un modèle : il est stocké comme
         DONNÉE, sérialisé, jamais interprété ni concaténé nulle part. */
      content:    JSON.stringify(n.content && typeof n.content === 'object' ? n.content : {}),
      occurred_at: isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString()
    }
  };
}

/* ---------- écriture ----------
   Idempotence sur 24 h : même signature + même action_id + même outcome
   renforce au lieu de dupliquer. Sans ça, une alerte récurrente noie la
   base et fausse tous les classements. */
const MERGE_WINDOW_MS = 24 * 3600 * 1000;

function remember(db, payload, sourceName) {
  const v = validateNeuron(payload.neuron, sourceName);
  if (v.error) return { ok: false, status: 400, error: v.error };
  const o = v.value;
  const now = new Date().toISOString();

  const since = new Date(Date.now() - MERGE_WINDOW_MS).toISOString();
  const existing = (o.signature || o.alert_key) ? db.prepare(`
    SELECT id, occurrences FROM neurons
    WHERE deleted=0 AND source=? AND type=?
      AND IFNULL(signature,'')=IFNULL(?,'') AND IFNULL(alert_key,'')=IFNULL(?,'')
      AND IFNULL(action_id,'')=IFNULL(?,'') AND IFNULL(outcome,'')=IFNULL(?,'')
      AND last_seen_at >= ?
    ORDER BY last_seen_at DESC LIMIT 1`)
    .get(o.source, o.type, o.signature, o.alert_key, o.action_id, o.outcome, since) : null;

  let id, merged = null;
  if (existing) {
    /* On renforce, et on garde le occurred_at le plus RÉCENT : c'est lui
       qui pilote la décote. Un rejeu de file locale avec une date ancienne
       ne doit pas rajeunir artificiellement le neurone. */
    db.prepare(`
      UPDATE neurons SET occurrences=occurrences+1,
        last_seen_at=?, occurred_at=MAX(occurred_at,?),
        attempts=attempts+?, duration_s=COALESCE(?,duration_s),
        cost_usd=COALESCE(cost_usd,0)+COALESCE(?,0)
      WHERE id=?`)
      .run(now, o.occurred_at, o.attempts, o.duration_s, o.cost_usd, existing.id);
    id = existing.id; merged = existing.id;
  } else {
    const info = db.prepare(`
      INSERT INTO neurons(source,type,alert_key,host,service,signature,root_cause,
        resolution,action_id,outcome,attempts,duration_s,cost_usd,content,
        occurred_at,created_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.source,o.type,o.alert_key,o.host,o.service,o.signature,o.root_cause,
           o.resolution,o.action_id,o.outcome,o.attempts,o.duration_s,o.cost_usd,
           o.content,o.occurred_at,now,now);
    id = Number(info.lastInsertRowid);
  }

  /* --- synapses : renforcées, jamais dupliquées --- */
  const liens = Array.isArray(payload.synapses) ? payload.synapses.slice(0, LIM.synapses) : [];
  /* Les liens structurels sont déduits du neurone lui-même : un client
     qui les oublie ne doit pas perdre la traversée de graphe. */
  for (const [t, k] of [['service', o.service], ['host', o.host],
                        ['alert_key', o.alert_key], ['signature', o.signature]]) {
    if (k && !liens.some(l => l.to_type === t && l.to_key === k)) liens.push({ to_type: t, to_key: k });
  }
  let n = 0;
  const ins = db.prepare(`
    INSERT INTO synapse_links(neuron_id,to_type,to_key,weight) VALUES(?,?,?,1)
    ON CONFLICT(neuron_id,to_type,to_key) DO UPDATE SET weight=MIN(10,weight+0.5)`);
  for (const l of liens) {
    const t = txt(l && l.to_type, 40), k = txt(l && l.to_key, LIM.key);
    if (!t || !k || !TO_TYPES.has(t)) continue;
    ins.run(id, t, k); n++;
  }

  return { ok: true, status: merged ? 200 : 201,
           body: { neuron_id: id, synapses: n, merged_with: merged } };
}

/* ---------- rappel ---------- */
/* Les colonnes doivent être QUALIFIÉES : la table FTS expose elle aussi
   root_cause, resolution et action_id. Sans préfixe, SQLite lève
   « ambiguous column name » — et le try/catch autour de L1 transformait
   cette erreur en « aucun résultat ». Le niveau lexical n'a donc jamais
   fonctionné, sans que rien ne le signale. */
const COLS = `n.id,n.source,n.type,n.alert_key,n.host,n.service,n.signature,
              n.root_cause,n.resolution,n.action_id,n.outcome,n.attempts,
              n.occurred_at,n.last_seen_at,n.occurrences,n.fb_useful,n.fb_total`;

function shape(row, similarity, via) {
  return {
    similarity,
    via,
    neuron: {
      id: row.id, type: row.type,
      root_cause: row.root_cause, resolution: row.resolution,
      action_id: row.action_id, outcome: row.outcome,
      occurred_at: row.occurred_at,
      service: row.service, host: row.host,
      alert_key: row.alert_key, signature: row.signature,
      occurrences: row.occurrences, source: row.source
    }
  };
}

/* Filtre multi-client : par défaut un client ne voit que SES neurones.
   `sources: ["*"]` ouvre à tous, `sources: ["oracle"]` cible. */
function sourceFilter(sources, self) {
  if (Array.isArray(sources) && sources.includes('*')) return { sql: '', args: [] };
  const list = Array.isArray(sources) && sources.length ? sources : [self];
  return { sql: ` AND source IN (${list.map(() => '?').join(',')})`, args: list.map(String) };
}

async function recall(db, req, ctx) {
  const t0 = performance.now();
  const {
    query = '', context = {}, limit = 3, min_similarity = 0.5,
    sources = null, levels = null
  } = req || {};

  const self = ctx.source;
  const now = Date.now();
  const lim = clamp(Math.trunc(+limit || 3), 1, 20);
  const minSim = clamp(+min_similarity || 0, 0, 1);
  const actif = l => !Array.isArray(levels) || levels.includes(l);
  const sf = sourceFilter(sources, self);

  const seen = new Map();   /* id -> meilleur résultat */
  const garder = (row, sim, via) => {
    if (sim < minSim) return;
    const prev = seen.get(row.id);
    if (!prev || sim > prev.similarity) seen.set(row.id, shape(row, sim, via));
  };

  /* --- L0 : exact --- */
  if (actif('L0')) {
    if (context.signature) {
      for (const r of db.prepare(
        `SELECT ${COLS} FROM neurons n WHERE n.deleted=0 AND n.signature=?${sf.sql.replace(/source/g,'n.source')}
         ORDER BY n.last_seen_at DESC LIMIT 20`).all(context.signature, ...sf.args)) {
        garder(r, score('L0', LEVEL.L0.base, r, now), 'L0');
      }
    }
    if (context.alert_key && context.service) {
      for (const r of db.prepare(
        `SELECT ${COLS} FROM neurons n WHERE n.deleted=0 AND n.alert_key=? AND n.service=?${sf.sql.replace(/source/g,'n.source')}
         ORDER BY n.last_seen_at DESC LIMIT 20`).all(context.alert_key, context.service, ...sf.args)) {
        /* léger retrait : moins spécifique qu'une signature identique */
        garder(r, score('L0', LEVEL.L0.base - 0.04, r, now), 'L0');
      }
    }
  }

  /* --- L1 : lexical ---
     La requête est en AND dès qu'il y a plusieurs termes, avec repli sur
     OR si elle ne rend rien. Un OR sur des mots fréquents force BM25 à
     scorer tout l'index : sur 10 000 neurones aux textes voisins, la
     latence passait de 2 ms à plusieurs secondes. Le AND réduit
     l'ensemble candidat avant le classement. */
  if (actif('L1') && query) {
    const toks = norm(query).split(/[^a-z0-9._-]+/).filter(t => t.length > 2).slice(0, 8);
    if (toks.length) {
      const termes = toks.map(t => '"' + t.replace(/"/g, '') + '"*');
      const q = termes.length > 1 ? termes.join(' AND ') : termes[0];
      try {
        /* La sous-requête FTS est MATÉRIALISÉE avant la jointure.
           Écrite à plat, avec un filtre sur n.source, l'optimiseur
           choisissait de parcourir les neurones puis d'interroger FTS
           pour chacun : 31 380 ms sur 10 000 lignes, contre 14 ms ici.
           Le LIMIT interne est large car le filtre par source s'applique
           après : il faut de la marge pour ne pas perdre de résultats. */
        const req = db.prepare(`
          SELECT ${COLS}, f.r AS bm
          FROM (SELECT rowid AS rid, rank AS r FROM nfts
                WHERE nfts MATCH ? ORDER BY rank LIMIT 200) f
          JOIN neurons n ON n.id = f.rid
          WHERE n.deleted=0${sf.sql.replace(/source/g,'n.source')}
          ORDER BY f.r LIMIT 40`);
        let rows = req.all(q, ...sf.args);
        /* repli : le AND était peut-être trop strict */
        if (!rows.length && termes.length > 1) {
          rows = req.all(termes.join(' OR '), ...sf.args);
        }
        /* BM25 est non borné et négatif : on le convertit en rang relatif
           plutôt qu'en valeur absolue, seul moyen d'obtenir une échelle
           stable d'un corpus à l'autre. */
        rows.forEach((r, i) => {
          const rel = 1 - (i / Math.max(rows.length, 8));
          garder(r, score('L1', LEVEL.L1.base * rel, r, now), 'L1');
        });
      } catch (e) {
        /* Une requête FTS mal formée par l'utilisateur est normale et
           silencieuse. Une erreur SQL, elle, est un bug : la masquer a
           déjà coûté un niveau entier de la cascade. */
        if (!/fts5|syntax error|malformed MATCH/i.test(String(e.message)))
          console.error('[recall] L1 :', e.message);
      }
    }
  }

  /* --- L2 : sémantique, seulement si les niveaux précédents n'ont rien
     donné au-dessus du seuil, et seulement si la couche est disponible --- */
  const dejaFort = [...seen.values()].some(r => r.similarity >= DECISION_THRESHOLD);
  if (actif('L2') && !dejaFort && ctx.embed && query) {
    try {
      const qv = await ctx.embed(query);
      const rows = db.prepare(`
        SELECT ${COLS}, v.vec AS vec FROM neuron_vec v
        JOIN neurons n ON n.id=v.neuron_id
        WHERE n.deleted=0${sf.sql.replace(/source/g,'n.source')}`).all(...sf.args);
      for (const r of rows) {
        const f = ctx.blobToVec(r.vec);
        if (f.length !== qv.length) continue;
        let dot = 0;
        for (let i = 0; i < f.length; i++) dot += f[i] * qv[i];
        if (dot <= 0.2) continue;
        garder(r, score('L2', LEVEL.L2.base * dot, r, now), 'L2');
      }
    } catch { /* couche sémantique indisponible : on continue sans */ }
  }

  /* --- L3 : voisinage de graphe, un saut ---
     Ce n'est pas le même incident, c'est un incident lié. Pénalisé, et
     par construction incapable de franchir le seuil de décision. */
  /* La cascade s'arrête au premier niveau exploitable : inutile d'aller
     chercher du voisinage quand un rappel exact a déjà répondu. Sans ce
     garde, L3 tournait à chaque appel et faisait exploser la latence sur
     une grande base — pour des résultats qui n'auraient de toute façon
     jamais dépassé le premier. */
  const dejaExact = [...seen.values()].some(r => r.similarity >= DECISION_THRESHOLD);
  if (actif('L3') && seen.size && !dejaExact) {
    const ids = [...seen.keys()].slice(0, 3);
    const ph = ids.map(() => '?').join(',');
    const cibles = db.prepare(`
      SELECT DISTINCT to_type, to_key FROM synapse_links
      WHERE neuron_id IN (${ph}) LIMIT 6`).all(...ids);
    for (const c of cibles) {
      const rows = db.prepare(`
        SELECT ${COLS} FROM neurons n
        JOIN synapse_links l ON l.neuron_id=n.id
        WHERE l.to_type=? AND l.to_key=? AND n.deleted=0${sf.sql.replace(/source/g, 'n.source')}
        ORDER BY n.last_seen_at DESC LIMIT 10`).all(c.to_type, c.to_key, ...sf.args);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        garder(r, score('L3', LEVEL.L3.base, r, now), 'L3');
      }
    }
  }

  const results = [...seen.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, lim);

  /* Journal : sert au taux de rappel utile et au calibrage. */
  const at = new Date().toISOString();
  const took = +(performance.now() - t0).toFixed(1);
  const log = db.prepare(
    `INSERT INTO recall_log(source,query_norm,neuron_id,level,similarity,took_ms,at)
     VALUES(?,?,?,?,?,?,?)`);
  if (results.length) log.run(self, norm(query).slice(0, 200), results[0].neuron.id,
                              results[0].via, results[0].similarity, took, at);
  else log.run(self, norm(query).slice(0, 200), null, null, null, took, at);

  return { results, took_ms: took, threshold: DECISION_THRESHOLD };
}

/* ---------- retour du client ---------- */
function feedback(db, neuronId, useful) {
  const r = db.prepare(`SELECT id FROM neurons WHERE id=? AND deleted=0`).get(neuronId);
  if (!r) return { ok: false, status: 404, error: 'neurone inconnu' };
  db.prepare(`UPDATE neurons SET fb_total=fb_total+1, fb_useful=fb_useful+? WHERE id=?`)
    .run(useful ? 1 : 0, neuronId);
  const row = db.prepare(`SELECT fb_useful,fb_total FROM neurons WHERE id=?`).get(neuronId);
  return { ok: true, status: 200,
           body: { neuron_id: neuronId, useful_ratio: +(row.fb_useful / row.fb_total).toFixed(2),
                   factor: +feedbackFactor(row).toFixed(3) } };
}

/* ---------- lecture, parcours, oubli ---------- */
function getNeuron(db, id, self) {
  const n = db.prepare(`SELECT * FROM neurons WHERE id=? AND deleted=0`).get(id);
  if (!n) return null;
  const links = db.prepare(
    `SELECT to_type,to_key,weight FROM synapse_links WHERE neuron_id=?`).all(id);
  return {
    id: n.id, source: n.source, type: n.type,
    alert_key: n.alert_key, host: n.host, service: n.service, signature: n.signature,
    root_cause: n.root_cause, resolution: n.resolution, action_id: n.action_id,
    outcome: n.outcome, attempts: n.attempts, duration_s: n.duration_s,
    cost_usd: n.cost_usd, content: JSON.parse(n.content || '{}'),
    occurred_at: n.occurred_at, created_at: n.created_at, last_seen_at: n.last_seen_at,
    occurrences: n.occurrences,
    feedback: { useful: n.fb_useful, total: n.fb_total },
    age_factor: +ageFactor(n.occurred_at).toFixed(3),
    synapses: links
  };
}

function listNeurons(db, { type, source, limit = 50, offset = 0 }) {
  const w = ['deleted=0'], a = [];
  if (type)   { w.push('type=?');   a.push(type); }
  if (source) { w.push('source=?'); a.push(source); }
  return db.prepare(`
    SELECT id,source,type,service,host,alert_key,signature,action_id,outcome,
           occurred_at,occurrences,fb_useful,fb_total
    FROM neurons WHERE ${w.join(' AND ')}
    ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`)
    .all(...a, clamp(Math.trunc(+limit || 50), 1, 500), Math.max(0, +offset || 0));
}

/* Oubli explicite : marquage, pas suppression physique. Une suppression
   franche rendrait irréversible une erreur de manipulation. */
function forget(db, id) {
  const r = db.prepare(`UPDATE neurons SET deleted=1 WHERE id=? AND deleted=0`).run(id);
  return Number(r.changes || 0) > 0;
}

/* ---------- statistiques ---------- */
function stats(db, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const q = s => db.prepare(s);

  const parType = q(`SELECT type, count(*) n FROM neurons WHERE deleted=0 GROUP BY type`).all();
  const parSrc  = q(`SELECT source, count(*) n FROM neurons WHERE deleted=0 GROUP BY source`).all();

  const rec = q(`SELECT count(*) n,
                        SUM(CASE WHEN neuron_id IS NOT NULL THEN 1 ELSE 0 END) hits,
                        AVG(took_ms) avg_ms
                 FROM recall_log WHERE at >= ?`).get(since);

  const lat = q(`SELECT took_ms FROM recall_log WHERE at >= ? ORDER BY took_ms`).all(since)
                .map(r => r.took_ms);
  const p = x => lat.length ? +lat[Math.min(lat.length - 1, Math.floor(lat.length * x))].toFixed(1) : null;

  const fb = q(`SELECT SUM(fb_useful) u, SUM(fb_total) t FROM neurons WHERE deleted=0`).get();
  const parNiveau = q(`SELECT level, count(*) n FROM recall_log
                       WHERE at >= ? AND level IS NOT NULL GROUP BY level`).all(since);

  return {
    days,
    neurons: q(`SELECT count(*) n FROM neurons WHERE deleted=0`).get().n,
    synapses: q(`SELECT count(*) n FROM synapse_links`).get().n,
    by_type: Object.fromEntries(parType.map(r => [r.type, r.n])),
    by_source: Object.fromEntries(parSrc.map(r => [r.source, r.n])),
    recalls: rec.n,
    recall_hit_rate: rec.n ? +(rec.hits / rec.n).toFixed(2) : null,
    by_level: Object.fromEntries(parNiveau.map(r => [r.level, r.n])),
    latency_ms: { p50: p(.5), p95: p(.95), p99: p(.99) },
    /* taux de rappel UTILE : la seule mesure qui dise si la mémoire sert */
    useful_rate: fb.t ? +(fb.u / fb.t).toFixed(2) : null,
    feedback_total: fb.t || 0
  };
}

/* ---------- export, import, purge ---------- */
function exportAll(db) {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    neurons: db.prepare(`SELECT * FROM neurons WHERE deleted=0`).all(),
    synapses: db.prepare(`SELECT * FROM synapse_links`).all()
  };
}

function importAll(db, dump) {
  if (!dump || !Array.isArray(dump.neurons)) return { ok: false, error: 'format invalide' };
  let n = 0, s = 0;
  const insN = db.prepare(`
    INSERT INTO neurons(source,type,alert_key,host,service,signature,root_cause,resolution,
      action_id,outcome,attempts,duration_s,cost_usd,content,occurred_at,created_at,
      last_seen_at,occurrences,fb_useful,fb_total)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insS = db.prepare(`
    INSERT OR IGNORE INTO synapse_links(neuron_id,to_type,to_key,weight) VALUES(?,?,?,?)`);
  const map = new Map();
  for (const x of dump.neurons) {
    const info = insN.run(x.source||'import', x.type||'note', x.alert_key, x.host, x.service,
      x.signature, x.root_cause||'', x.resolution||'', x.action_id, x.outcome,
      x.attempts||1, x.duration_s, x.cost_usd, x.content||'{}',
      x.occurred_at||new Date().toISOString(), x.created_at||new Date().toISOString(),
      x.last_seen_at||new Date().toISOString(), x.occurrences||1, x.fb_useful||0, x.fb_total||0);
    map.set(x.id, Number(info.lastInsertRowid)); n++;
  }
  for (const l of (dump.synapses || [])) {
    const id = map.get(l.neuron_id);
    if (!id) continue;
    insS.run(id, l.to_type, l.to_key, l.weight || 1); s++;
  }
  return { ok: true, neurons: n, synapses: s };
}

function purge(db, { months = 12, keep_types = [] } = {}) {
  const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString();
  const ph = keep_types.length ? ` AND type NOT IN (${keep_types.map(() => '?').join(',')})` : '';
  const r = db.prepare(
    `DELETE FROM neurons WHERE occurred_at < ?${ph}`).run(cutoff, ...keep_types);
  return { deleted: Number(r.changes || 0), cutoff };
}

module.exports = {
  migrate, remember, recall, feedback, getNeuron, listNeurons, forget,
  stats, exportAll, importAll, purge,
  safeEqual, ageFactor, feedbackFactor, score, validateNeuron,
  DECISION_THRESHOLD, LEVEL, HALF_LIFE_DAYS, NON_RESOLVED_CAP,
  MERGE_WINDOW_MS, OUTCOMES, TO_TYPES, GRACE_DAYS
};
