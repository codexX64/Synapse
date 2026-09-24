'use strict';
/* ============================================================
   SYNAPSE — apprentissage.

   La mémoire répond « qu'est-ce qu'on sait déjà ». Ce module répond à
   une question différente : « qu'est-ce que j'ai appris de celui qui me
   parle, et où me suis-je déjà trompé ».

   Deux portées, et c'est toute la distinction qui compte.

     commun    ce qui est vrai de l'utilisateur, quel que soit le modèle
               qui le lit — sa façon de nommer les choses, ses choix déjà
               faits, ce qu'il refuse. Un fait ne change pas parce qu'on
               change de modèle.

     <agent>   ce qui est vrai de CE modèle-ci — ses angles morts, la
               forme de consigne qui marche avec lui, ses corrections
               passées. Mélanger les leçons de deux modèles les dégrade
               toutes les deux : ce qui rattrape l'un déroute l'autre.

   Le profil n'est pas saisi, il est DISTILLÉ. Les échanges bruts entrent
   par l'ingestion normale, comme n'importe quelle entrée ; une passe de
   consolidation les relit et en extrait des traits courts et durables.
   C'est la différence entre un historique et un apprentissage : l'un
   grossit, l'autre se condense.

   Un trait qui n'est plus reconfirmé s'efface tout seul. Sans cela le
   profil accumulerait pour toujours une préférence énoncée une fois en
   mars, et l'assistant s'y conformerait encore en décembre.
   ============================================================ */

const crypto = require('node:crypto');

const COMMUN = 'commun';

/* Un profil qui ne tient pas dans une consigne système ne sert à rien :
   au-delà, le modèle dilue. Mieux vaut trente traits sûrs que trois
   cents tièdes. */
const MAX_TRAITS = 40;
const MAX_CORRECTIONS = 300;

/* Demi-vie d'un trait non reconfirmé. Six mois : assez long pour qu'une
   préférence stable survive à un été sans usage, assez court pour qu'un
   choix abandonné cesse de peser avant la fin de l'année. */
const DEMI_VIE_JOURS = 180;
const PLANCHER = 0.15;        /* en dessous, le trait est oublié */

const LOT_CONSOLIDATION = 12; /* échanges relus par appel : tient dans 8 k jetons de contexte */

function migrate(db) {
  db.exec(`
    /* ---------- traits appris ----------
       La clé est le SUJET du trait ('langue', 'format_commandes'), pas
       sa valeur. Deux observations sur le même sujet se remplacent au
       lieu de s'empiler : c'est ce qui permet à un avis de changer. */
    CREATE TABLE IF NOT EXISTS profil (
      agent      TEXT NOT NULL,
      cle        TEXT NOT NULL,
      valeur     TEXT NOT NULL,
      confiance  REAL NOT NULL DEFAULT 0.5,
      n          INTEGER NOT NULL DEFAULT 1,
      origine    TEXT NOT NULL DEFAULT 'distille',   -- distille | declare
      exemples   TEXT NOT NULL DEFAULT '',
      cree_le    TEXT NOT NULL,
      maj        TEXT NOT NULL,
      PRIMARY KEY (agent, cle)
    );
    CREATE INDEX IF NOT EXISTS idx_profil_agent ON profil(agent, confiance DESC);

    /* ---------- corrections ----------
       Ce qui a été dit de faux, et ce qu'il fallait dire. Indexé sur la
       question normalisée : la prochaine question qui lui ressemble
       ramène la correction avant que le modèle recommence. */
    CREATE TABLE IF NOT EXISTS corrections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT NOT NULL,
      q_norm     TEXT NOT NULL,
      question   TEXT NOT NULL,
      faux       TEXT NOT NULL DEFAULT '',
      correction TEXT NOT NULL,
      n          INTEGER NOT NULL DEFAULT 1,
      cree_le    TEXT NOT NULL,
      dernier_le TEXT NOT NULL,
      UNIQUE (agent, q_norm, correction)
    );
    CREATE INDEX IF NOT EXISTS idx_corr_agent ON corrections(agent, dernier_le DESC);

    /* ---------- avancement de la consolidation ----------
       Où en est la distillation pour chaque agent. Sans ce repère, la
       passe relirait chaque fois tout l'historique. */
    CREATE TABLE IF NOT EXISTS consolidation (
      agent      TEXT PRIMARY KEY,
      dernier_id INTEGER NOT NULL DEFAULT 0,
      passes     INTEGER NOT NULL DEFAULT 0,
      maj        TEXT
    );
  `);
  /* Ce qu'un trait disait avant, et comment il a bougé : une fiche qui
     change sans dire ce qu'elle a changé ne se relit pas. */
  for (const col of ['precedent TEXT', "etat TEXT NOT NULL DEFAULT 'nouveau'"]) {
    try { db.exec(`ALTER TABLE profil ADD COLUMN ${col}`); } catch { /* déjà là */ }
  }
}

/* ---------- utilitaires ---------- */

const maintenant = () => new Date().toISOString();

function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const txt = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

/* Nom d'agent utilisable comme clé et comme espace. */
function agentId(nom) {
  const n = norm(nom).replace(/\s+/g, '-').slice(0, 40);
  return n || 'inconnu';
}

/**
 * Confiance vue aujourd'hui.
 *
 * Décroissance exponentielle depuis la dernière confirmation. Un trait
 * reconfirmé dix fois repart de haut ; un trait énoncé une fois en
 * passant s'efface en quelques mois. C'est ce qui évite qu'un profil
 * devienne une liste de vieilles humeurs.
 */
function confianceVive(row, now = Date.now()) {
  const jours = Math.max(0, (now - new Date(row.maj).getTime()) / 86400000);
  const usure = Math.pow(0.5, jours / DEMI_VIE_JOURS);
  /* Un trait déclaré explicitement par l'utilisateur ne s'use pas : il
     n'a pas été deviné, il a été dit. */
  return row.origine === 'declare' ? row.confiance : row.confiance * usure;
}

/* ---------- profil ---------- */

/**
 * Les traits vivants d'un agent : le commun d'abord, le sien ensuite.
 *
 * L'ordre compte. Ce qui est vrai de l'utilisateur prime sur ce qui
 * n'est qu'une béquille pour ce modèle-là.
 */
function profil(db, agent, { seuil = PLANCHER } = {}) {
  const a = agentId(agent);
  const rows = db.prepare(
    `SELECT agent,cle,valeur,confiance,n,origine,maj,cree_le,precedent,etat FROM profil
     WHERE agent IN (?,?) ORDER BY agent = ? DESC, confiance DESC`).all(COMMUN, a, COMMUN);
  const now = Date.now();
  return rows.map(r => ({
    portee: r.agent === COMMUN ? 'commun' : 'agent',
    cle: r.cle, valeur: r.valeur, n: r.n, origine: r.origine,
    etat: r.etat || 'nouveau', precedent: r.precedent || null, cree_le: r.cree_le, maj: r.maj,
    confiance: Number(confianceVive(r, now).toFixed(3)),
  })).filter(t => t.confiance >= seuil);
}

/**
 * Pose ou renforce un trait.
 *
 * Même sujet, même valeur : on renforce et on rajeunit. Même sujet,
 * valeur différente : c'est un changement d'avis, et le nouveau gagne —
 * mais en repartant d'une confiance modérée, parce qu'une observation
 * isolée ne doit pas effacer d'un coup dix confirmations.
 */
function poser(db, { agent, cle, valeur, confiance = 0.5, origine = 'distille', exemple = '', evolution = '' }) {
  const a = agentId(agent);
  const k = txt(cle, 60).toLowerCase().replace(/\s+/g, '_');
  const v = txt(valeur, 400);
  if (!k || !v) return null;
  const now = maintenant();
  const ex = db.prepare(`SELECT * FROM profil WHERE agent=? AND cle=?`).get(a, k);

  if (!ex) {
    db.prepare(`INSERT INTO profil(agent,cle,valeur,confiance,n,origine,exemples,cree_le,maj,etat)
                VALUES (?,?,?,?,1,?,?,?,?,'nouveau')`)
      .run(a, k, v, Math.min(0.95, Math.max(0.1, confiance)), origine, txt(exemple, 300), now, now);
    elaguer(db, a);
    return { cle: k, valeur: v, etat: 'nouveau' };
  }

  if (norm(ex.valeur) === norm(v)) {
    /* Confirmation : la confiance monte, sans jamais atteindre 1 — on
       ne devient pas certain d'une observation à force de la répéter. */
    const c = Math.min(0.95, confianceVive(ex) + (1 - confianceVive(ex)) * 0.35);
    db.prepare(`UPDATE profil SET confiance=?, n=n+1, maj=?, origine=?, etat='confirme' WHERE agent=? AND cle=?`)
      .run(c, now, ex.origine === 'declare' ? 'declare' : origine, a, k);
    return { cle: k, valeur: v, etat: 'confirme' };
  }

  /* Un trait DÉCLARÉ ne se fait pas écraser par une distillation : ce
     que l'utilisateur a dit explicitement pèse plus que ce qu'un modèle
     a cru deviner. */
  if (ex.origine === 'declare' && origine !== 'declare') return { cle: k, etat: 'garde' };

  /* Précisé plutôt que contredit : la fiche s'enrichit de ce qu'on vient
     d'apprendre, et garde le crédit de ses confirmations passées. C'est
     le cas courant — on en apprend un peu plus, pas le contraire. */
  if (evolution === 'affine' && origine === ex.origine) {
    const c = Math.min(0.95, Math.max(confianceVive(ex), confiance) + 0.05);
    db.prepare(`UPDATE profil SET valeur=?, confiance=?, n=n+1, precedent=?, etat='affine', exemples=?, maj=? WHERE agent=? AND cle=?`)
      .run(v, c, ex.valeur, txt(exemple, 300), now, a, k);
    return { cle: k, valeur: v, etat: 'affine' };
  }

  db.prepare(`UPDATE profil SET valeur=?, confiance=?, n=1, origine=?, exemples=?, maj=?, precedent=?, etat='remplace' WHERE agent=? AND cle=?`)
    .run(v, Math.min(0.7, Math.max(0.3, confiance)), origine, txt(exemple, 300), now, ex.valeur, a, k);
  return { cle: k, valeur: v, etat: 'remplace' };
}

function oublier(db, agent, cle) {
  const r = db.prepare(`DELETE FROM profil WHERE agent=? AND cle=?`).run(agentId(agent), txt(cle, 60));
  return { oublies: r.changes };
}

/** Au-delà du plafond, on jette les traits les plus faibles et les plus vieux. */
function elaguer(db, agent) {
  const n = db.prepare(`SELECT COUNT(*) c FROM profil WHERE agent=?`).get(agent).c;
  if (n <= MAX_TRAITS) return;
  db.prepare(`DELETE FROM profil WHERE agent=? AND cle IN (
                SELECT cle FROM profil WHERE agent=? ORDER BY confiance ASC, maj ASC LIMIT ?)`)
    .run(agent, agent, n - MAX_TRAITS);
}

/* ---------- corrections ---------- */

/**
 * Enregistre une réponse ratée et ce qu'il fallait dire.
 *
 * La même correction répétée ne crée pas de doublon : elle compte. Une
 * erreur commise trois fois sur la même question doit ressortir plus
 * fort qu'une bourde isolée.
 */
function corriger(db, { agent, question, correction, faux = '' }) {
  const a = agentId(agent);
  const q = txt(question, 500);
  const c = txt(correction, 1000);
  if (!q || !c) return null;
  const qn = norm(q).slice(0, 300);
  const now = maintenant();
  db.prepare(`INSERT INTO corrections(agent,q_norm,question,faux,correction,cree_le,dernier_le)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(agent,q_norm,correction)
              DO UPDATE SET n = n + 1, dernier_le = excluded.dernier_le, faux = excluded.faux`)
    .run(a, qn, q, txt(faux, 1000), c, now, now);
  const trop = db.prepare(`SELECT COUNT(*) c FROM corrections WHERE agent=?`).get(a).c - MAX_CORRECTIONS;
  if (trop > 0) {
    db.prepare(`DELETE FROM corrections WHERE id IN (
                  SELECT id FROM corrections WHERE agent=? ORDER BY n ASC, dernier_le ASC LIMIT ?)`)
      .run(a, trop);
  }
  return db.prepare(`SELECT * FROM corrections WHERE agent=? AND q_norm=? AND correction=?`).get(a, qn, c);
}

/**
 * Les corrections qui concernent cette question.
 *
 * Exactes d'abord — la même question reposée mot pour mot. Puis celles
 * qui partagent assez de mots pour qu'on parle vraisemblablement de la
 * même chose. Le seuil est haut exprès : une correction hors sujet
 * injectée dans la consigne fait plus de dégâts qu'une absence.
 */
function correctionsPour(db, agent, question, { limite = 4 } = {}) {
  const a = agentId(agent);
  const qn = norm(question);
  if (!qn) return [];
  const mots = new Set(qn.split(' ').filter(m => m.length > 3));
  const rows = db.prepare(
    `SELECT question,faux,correction,n,dernier_le,q_norm FROM corrections
     WHERE agent=? ORDER BY dernier_le DESC LIMIT 400`).all(a);
  const notees = [];
  for (const r of rows) {
    if (r.q_norm === qn.slice(0, 300)) { notees.push({ r, s: 1 }); continue; }
    if (!mots.size) continue;
    const autres = new Set(r.q_norm.split(' ').filter(m => m.length > 3));
    if (!autres.size) continue;
    let communs = 0;
    for (const m of mots) if (autres.has(m)) communs++;
    const s = communs / Math.max(mots.size, autres.size);
    if (s >= 0.45) notees.push({ r, s });
  }
  return notees.sort((x, y) => y.s - x.s || y.r.n - x.r.n).slice(0, limite)
    .map(({ r, s }) => ({ question: r.question, faux: r.faux || undefined, correction: r.correction, n: r.n, proximite: Number(s.toFixed(2)) }));
}

/* ---------- briefing ---------- */

/**
 * Tout ce qu'il faut savoir avant de répondre, en un seul appel.
 *
 * Un agent qui interroge séparément la mémoire, le profil et les
 * corrections paie trois allers-retours et doit les orchestrer. Ici il
 * pose une question et reçoit un briefing.
 *
 * Le budget de temps est ferme : ce qui n'a pas répondu à l'échéance est
 * absent du briefing, pas attendu. Une mémoire lente ne doit jamais
 * devenir une conversation lente — c'est exactement ce qui pousse à
 * couper la mémoire.
 */
async function brief(db, opts) {
  const t0 = performance.now();
  const {
    agent = 'inconnu', q = '', ns = 'shared', limite = 6,
    budget = 1200, search = null, embed = null, neurones = null,
  } = opts;

  const traits = profil(db, agent);
  const corr = correctionsPour(db, agent, q);

  /* La recherche est la seule partie coûteuse : c'est la seule qu'on
     borne. Le profil et les corrections sont deux requêtes indexées. */
  let memoire = [];
  let tronque = false;
  if (search && q.trim()) {
    const echeance = new Promise(r => setTimeout(() => r('__delai__'), budget));
    const trouve = search(db, { q, ns, limit: limite, embed })
      .then(r => r.hits || r.results || [])
      .catch(() => []);
    const gagnant = await Promise.race([trouve, echeance]);
    if (gagnant === '__delai__') {
      tronque = true;
      /* On ne jette pas la recherche en cours : elle finira et peuplera
         les caches pour la question suivante. */
    } else {
      memoire = gagnant.map(h => ({
        titre: h.title, extrait: h.snippet || h.body, niveau: h.level, quand: h.occurred_at, score: h.score,
      }));
    }
  }

  let neu = [];
  if (neurones && opts.signature) {
    try { neu = (neurones(db, opts) || []).slice(0, 3); } catch { neu = []; }
  }

  return {
    agent: agentId(agent),
    profil: traits,
    corrections: corr,
    memoire,
    neurones: neu,
    tronque,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * Le briefing en texte, prêt à être collé dans une consigne système.
 *
 * Rendre cette mise en forme ici plutôt que chez chaque client évite
 * qu'ils divergent, et garde la formulation — « c'est l'utilisateur qui
 * l'a dit, pas toi » — au même endroit que la règle qu'elle exprime.
 */
function briefTexte(b) {
  const l = [];
  const commun = b.profil.filter(t => t.portee === 'commun');
  const sien = b.profil.filter(t => t.portee === 'agent');
  if (commun.length) {
    l.push('Ce que tu sais de ton utilisateur :');
    for (const t of commun) l.push(`- ${t.valeur}`);
  }
  if (sien.length) {
    l.push('Ce que tu as appris sur ta propre façon de répondre :');
    for (const t of sien) l.push(`- ${t.valeur}`);
  }
  if (b.corrections.length) {
    l.push('Tu t’es déjà trompé sur des questions proches. Ce qui suit fait foi :');
    for (const c of b.corrections) l.push(`- « ${c.question} » → ${c.correction}`);
  }
  if (b.memoire.length) {
    l.push('Dans la mémoire :');
    for (const m of b.memoire) l.push(`- ${m.titre}${m.extrait ? ` — ${String(m.extrait).slice(0, 200)}` : ''}`);
  }
  return l.join('\n');
}

/* ---------- consolidation ----------
   C'est ici que l'historique devient un apprentissage. */

const CONSIGNE = `Tu lis des échanges entre un utilisateur et un assistant technique qui gère son homelab.
Tu n'y réponds pas : tu apprends à CONNAÎTRE l'utilisateur, et tu tiens sa fiche à jour.

Renvoie UNIQUEMENT du JSON : {"traits":[{"portee":"commun"|"agent","cle":"...","valeur":"...","confiance":0.0-1.0,"evolution":"nouveau"|"affine"|"contredit"}],"oublier":["cle",...]}

Ce qu'on cherche sur l'UTILISATEUR (portee "commun") :
- ses projets en cours et ce qu'il cherche à obtenir avec ;
- sa façon de travailler : tester avant de valider, aller vite, tout automatiser, déléguer à l'IA, vérifier lui-même… ;
- ce qu'il demande souvent, ce qui revient d'un échange à l'autre ;
- ses exigences : forme des réponses, langue, niveau de détail, ce qui l'agace ;
- ses choix techniques déjà faits, ses outils, son matériel, ce qu'il refuse ;
- son niveau technique, par domaine.
Portee "agent" : ce qui est vrai de l'ASSISTANT — une erreur qu'il répète, un sujet où il part à côté.

La fiche actuelle est donnée plus bas. Règles :
- Même sujet qu'une fiche existante : REPRENDS SA CLÉ. "affine" si tu la précises ou l'enrichis (la nouvelle valeur remplace l'ancienne, écris-la complète) ; "contredit" si l'utilisateur a changé d'avis.
- Sujet absent de la fiche : "nouveau", clé courte sans accent ni espace (projets, facon_de_travailler, exigences, outils, niveau_reseau…).
- "valeur" : une ou deux phrases concrètes, à la deuxième personne (« Tu construis… », « Tu préfères… »), avec les vrais noms.
- "confiance" : 0.8 si l'utilisateur l'a dit, 0.5 si c'est une régularité observée sur plusieurs échanges, 0.3 si c'est une impression.
- Ne reformule pas une fiche sans rien y ajouter. N'invente rien.

Ce qui n'est PAS un trait :
- une demande ponctuelle (« répare les 2 workflows », « liste les services ») : c'est une tâche, pas une habitude — sauf si elle revient souvent, et alors écris l'habitude ;
- un jugement sur la personne : orthographe, intelligence, humeur, caractère. Jamais ;
- une généralité vraie de n'importe qui.

"oublier" : les clés de la FICHE ACTUELLE à retirer — une demande ponctuelle, un jugement, un doublon d'une autre clé (outil / outils : garde la meilleure, oublie l'autre), un trait que les échanges démentent.
Au plus 6 traits. Rien à dire → {"traits":[],"oublier":[]}.`;

/**
 * Relit les échanges non encore digérés et en tire des traits.
 *
 * `demander` est une fonction (consigne, texte) → texte, fournie par
 * l'appelant : la consolidation ne connaît ni Ollama ni aucun
 * fournisseur. Sans elle, la passe ne fait rien et le dit — elle ne
 * tombe pas en panne.
 */
async function consolider(db, { agent, demander, ns = null, lot = LOT_CONSOLIDATION }) {
  const a = agentId(agent);
  const etat = db.prepare(`SELECT * FROM consolidation WHERE agent=?`).get(a)
    || { agent: a, dernier_id: 0, passes: 0 };

  /* Les échanges de CET agent, et d'aucun autre. Sans ce filtre, distiller
     le profil de Kimi lui faisait relire les conversations de Qwen — la
     contamination même que la séparation par agent existe pour empêcher. */
  const rows = db.prepare(
    `SELECT id,title,body,occurred_at FROM entries
     WHERE id > ? AND kind = 'echange' AND json_extract(meta,'$.agent') = ? ${ns ? 'AND ns = ?' : ''}
     ORDER BY id ASC LIMIT ?`).all(...(ns ? [etat.dernier_id, a, ns, lot] : [etat.dernier_id, a, lot]));

  if (!rows.length) return { agent: a, lus: 0, traits: [], raison: 'rien de nouveau' };
  if (typeof demander !== 'function') return { agent: a, lus: 0, traits: [], raison: 'aucun modèle de synthèse' };

  const corpus = rows.map((r, i) => `[${i + 1}] ${String(r.occurred_at || '').slice(0, 16).replace('T', ' ')} · ${r.title}\n${String(r.body || '').slice(0, 600)}`).join('\n\n');
  /* La fiche actuelle, pour que le modèle la complète au lieu de repartir
     de zéro à chaque passe : c'est ce qui fait évoluer une fiche plutôt
     que d'en empiler de nouvelles. */
  const fiche = profil(db, a).map(t => `- [${t.portee}] ${t.cle} : ${t.valeur}`).join('\n') || '(vide)';

  let brut;
  try { brut = await demander(CONSIGNE, `FICHE ACTUELLE\n${fiche}\n\nÉCHANGES\n${corpus}`); }
  catch (e) { return { agent: a, lus: 0, traits: [], raison: `modèle indisponible : ${e.message}` }; }

  const traits = extraireTraits(brut);
  /* Le ménage : une fiche qui ne fait que grossir garde ses erreurs de
     jeunesse. Ce qui a été DÉCLARÉ par l'utilisateur ne se retire pas. */
  const oublies = [];
  const presentes = new Set(profil(db, a, { seuil: 0 }).map(t => `${t.portee}|${t.cle}`));
  for (const cle of extraireOublis(brut)) {
    for (const [portee, cible] of [['commun', COMMUN], ['agent', a]]) {
      if (!presentes.has(`${portee}|${cle}`) || traits.some(t => t.cle === cle && t.portee === portee)) continue;
      const r = db.prepare(`DELETE FROM profil WHERE agent=? AND cle=? AND origine <> 'declare'`).run(cible, cle);
      if (r.changes) oublies.push({ portee, cle });
    }
  }
  const poses = [];
  for (const t of traits) {
    const cible = t.portee === 'agent' ? a : COMMUN;
    const r = poser(db, { agent: cible, cle: t.cle, valeur: t.valeur, confiance: t.confiance, origine: 'distille', evolution: t.evolution });
    if (r) poses.push({ portee: t.portee, ...r });
  }

  /* Le repère avance même si le modèle n'a rien trouvé : sinon la même
     fournée serait relue indéfiniment. */
  db.prepare(`INSERT INTO consolidation(agent,dernier_id,passes,maj) VALUES (?,?,?,?)
              ON CONFLICT(agent) DO UPDATE SET dernier_id=excluded.dernier_id, passes=passes+1, maj=excluded.maj`)
    .run(a, rows[rows.length - 1].id, (etat.passes || 0) + 1, maintenant());

  return { agent: a, lus: rows.length, traits: poses, oublies };
}

/**
 * Sort la liste de traits d'une réponse de modèle.
 *
 * Un modèle local encadre volontiers son JSON de prose ou de ```json.
 * Refuser ces réponses reviendrait à ne consolider qu'avec les modèles
 * les plus obéissants ; on récupère donc le premier objet bien formé.
 */
function objetJson(brut) {
  const s = String(brut || '');
  try { return JSON.parse(s.trim()); } catch { /* plus bas */ }
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* */ } }
  return null;
}
function extraireOublis(brut) {
  const o = objetJson(brut);
  return (Array.isArray(o?.oublier) ? o.oublier : []).slice(0, 10)
    .map(c => norm(c).replace(/\s+/g, '_').slice(0, 60)).filter(Boolean);
}

function extraireTraits(brut) {
  const s = String(brut || '');
  let obj = null;
  const direct = s.trim();
  try { obj = JSON.parse(direct); } catch { /* on cherche plus bas */ }
  if (!obj) {
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { try { obj = JSON.parse(s.slice(i, j + 1)); } catch { obj = null; } }
  }
  const liste = Array.isArray(obj?.traits) ? obj.traits : [];
  return liste.slice(0, 6).map(t => ({
    portee: t?.portee === 'agent' ? 'agent' : 'commun',
    evolution: ['affine', 'contredit'].includes(t?.evolution) ? t.evolution : 'nouveau',
    cle: norm(t?.cle).replace(/\s+/g, '_').slice(0, 60),
    valeur: txt(t?.valeur, 400),
    confiance: Math.min(0.95, Math.max(0.1, Number(t?.confiance) || 0.4)),
  })).filter(t => t.cle && t.valeur);
}

/**
 * L'entrée d'échange, prête à être ingérée.
 *
 * Les échanges passent par l'ingestion normale : ils héritent du
 * dédoublonnage, de l'index plein texte, de la vectorisation et du
 * rangement. Une table à part aurait fallu les réimplémenter.
 */
function evenementEchange({ agent, question, reponse, ns = 'shared' }) {
  const q = txt(question, 2000);
  const r = txt(reponse, 4000);
  return {
    ns, kind: 'echange', level: 'L0',
    title: q.slice(0, 160) || 'échange',
    body: `Question : ${q}\nRéponse : ${r}`,
    tags: ['echange', `agent:${agentId(agent)}`],
    ref: `echange:${crypto.createHash('sha256').update(`${agentId(agent)}|${norm(q)}`).digest('hex').slice(0, 16)}`,
    meta: { agent: agentId(agent) },
    occurred_at: maintenant(),
  };
}

/**
 * Les agents qui ont des échanges pas encore digérés.
 *
 * Sans cette liste, consolider obligeait à nommer un agent — donc à
 * connaître par cœur le nom de la connexion IA. Le travail est le même
 * pour tous : autant les trouver.
 */
function agentsEnAttente(db, { limite = 8 } = {}) {
  return db.prepare(
    `SELECT DISTINCT json_extract(e.meta,'$.agent') a FROM entries e
     WHERE e.kind = 'echange'
       AND e.id > COALESCE((SELECT c.dernier_id FROM consolidation c
                            WHERE c.agent = json_extract(e.meta,'$.agent')), 0)
     LIMIT ?`).all(limite).map(r => r.a).filter(Boolean);
}

/**
 * Consolide tout le monde. C'est ce que fait la passe de fond, et c'est ce
 * que doit faire le bouton : rien à saisir.
 */
async function consoliderTous(db, { demander, ns = null } = {}) {
  const agents = agentsEnAttente(db);
  if (!agents.length) return { agents: [], lus: 0, traits: [], raison: 'rien de nouveau' };
  const out = [];
  for (const a of agents) out.push(await consolider(db, { agent: a, demander, ns }));
  return {
    agents: out.map(r => r.agent),
    lus: out.reduce((n, r) => n + r.lus, 0),
    traits: out.flatMap(r => r.traits),
    oublies: out.flatMap(r => r.oublies || []),
    raison: out.find(r => r.raison)?.raison,
  };
}

function stats(db, agent) {
  const a = agentId(agent);
  return {
    agent: a,
    traits_communs: db.prepare(`SELECT COUNT(*) c FROM profil WHERE agent=?`).get(COMMUN).c,
    traits_agent: db.prepare(`SELECT COUNT(*) c FROM profil WHERE agent=?`).get(a).c,
    corrections: db.prepare(`SELECT COUNT(*) c FROM corrections WHERE agent=?`).get(a).c,
    consolidation: db.prepare(`SELECT dernier_id,passes,maj FROM consolidation WHERE agent=?`).get(a) || null,
  };
}

/**
 * Ce que SYNAPSE a appris, tous agents confondus : totaux et derniers
 * événements. C'est ce qu'affiche le panneau « apprentissage » de
 * l'interface, à la place de messages écrits à l'avance.
 */
function resumeGlobal(db, { limite = 6 } = {}) {
  const now = Date.now();
  const traits = db.prepare(
    `SELECT agent,cle,valeur,confiance,n,origine,maj FROM profil ORDER BY maj DESC LIMIT ?`).all(limite)
    .map(r => ({ type: 'trait', agent: r.agent, cle: r.cle, valeur: r.valeur, origine: r.origine, n: r.n,
      confiance: Number(confianceVive(r, now).toFixed(2)), le: r.maj }));
  const corrections = db.prepare(
    `SELECT agent,question,correction,n,dernier_le FROM corrections ORDER BY dernier_le DESC LIMIT ?`).all(limite)
    .map(r => ({ type: 'correction', agent: r.agent, question: r.question, correction: r.correction, n: r.n, le: r.dernier_le }));
  const passes = db.prepare(
    `SELECT agent,passes,maj FROM consolidation WHERE maj IS NOT NULL ORDER BY maj DESC LIMIT ?`).all(limite)
    .map(r => ({ type: 'consolidation', agent: r.agent, passes: r.passes, le: r.maj }));
  const evenements = [...traits, ...corrections, ...passes]
    .sort((a, b) => String(b.le).localeCompare(String(a.le))).slice(0, limite);
  return {
    traits: db.prepare(`SELECT COUNT(*) c FROM profil`).get().c,
    corrections: db.prepare(`SELECT COUNT(*) c FROM corrections`).get().c,
    agents: db.prepare(`SELECT COUNT(DISTINCT agent) c FROM profil WHERE agent <> ?`).get(COMMUN).c,
    echanges: db.prepare(`SELECT COUNT(*) c FROM entries WHERE kind='echange' AND archived=0`).get().c,
    evenements,
  };
}

module.exports = {
  resumeGlobal,
  migrate, profil, poser, oublier, corriger, correctionsPour,
  brief, briefTexte, consolider, consoliderTous, agentsEnAttente, extraireTraits, extraireOublis, evenementEchange, stats,
  agentId, confianceVive, COMMUN, MAX_TRAITS, DEMI_VIE_JOURS,
};
