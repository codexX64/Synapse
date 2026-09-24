'use strict';
/* ============================================================
   Ce que SYNAPSE sait de toi.

   Deux choses que l'historique brut ne donnait pas.

   1. Des titres qui résument. Un échange arrivait titré par la question
      telle qu'elle avait été tapée — « et la tu peux voir si le truc
      marche ? ». Dans une carte, dans la sphère, dans une recherche, ça
      ne dit rien. Une passe de fond relit chaque échange et lui donne un
      titre court tiré de ce qui s'est réellement passé, plus un sujet
      qui sert à voir de quoi tu parles le plus.

   2. Des habitudes, mesurées. Les fiches du profil sont ce qu'un modèle
      a compris de toi ; les habitudes sont ce que les horodatages et les
      sujets montrent, sans interprétation. Les heures sont renvoyées
      brutes : c'est le navigateur qui les place dans ton fuseau, le
      serveur tourne souvent en UTC.
   ============================================================ */

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const LOT_TITRES = 12;
const ESSAIS_MAX = 3;

const CONSIGNE_TITRES = `Tu ranges les échanges entre un utilisateur et l'assistant de son homelab.
Pour chaque échange, écris :
- "titre" : 3 à 8 mots qui résument ce qui s'est passé ou ce qui a été établi. Pas la question recopiée, pas de point d'interrogation, pas de guillemets. Exemples : « Workflow quarantaine réparé et activé », « Hub joignable par le VPN seulement », « Latence des réponses SYNAPSE réduite ».
- "sujet" : un ou deux mots pour le domaine (Workflows, Réseau, SYNAPSE, Docker, Sécurité, Services…). Reprends un sujet déjà utilisé quand il convient.

Renvoie UNIQUEMENT du JSON : {"echanges":[{"n":1,"titre":"...","sujet":"..."}]}`;

/* Le titre d'origine est la question tronquée : c'est lui qu'on remplace,
   jamais un titre posé à la main ou par le rangement. */
function aTitrer(db, limite = LOT_TITRES) {
  return db.prepare(
    `SELECT id,title,body,meta,occurred_at FROM entries
     WHERE kind='echange' AND archived=0
       AND json_extract(meta,'$.titre') IS NULL
       AND COALESCE(json_extract(meta,'$.titre_essais'),0) < ?
     ORDER BY id DESC LIMIT ?`).all(ESSAIS_MAX, limite);
}

function propre(t) {
  let s = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').split('\n')[0];
  s = s.replace(/^[\s"'«»“”\-–—:]+|[\s"'«»“”.?!:]+$/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 89).trim() + '…' : s;
}

function questionDe(body) {
  const m = /^Question : ([\s\S]*?)\nRéponse :/.exec(String(body || ''));
  return m ? m[1] : '';
}

/* Remplace le titre partout où il sert : l'entrée, et l'en-tête de ses
   morceaux (le titre y est répété pour que chaque morceau garde son
   sujet). Les morceaux repartent à la vectorisation. */
function renomme(db, id, titre, ajout) {
  const e = db.prepare(`SELECT title FROM entries WHERE id=?`).get(id);
  if (!e) return false;
  db.prepare(`UPDATE entries SET title=?, meta=json_patch(COALESCE(meta,'{}'), ?) WHERE id=?`)
    .run(titre, JSON.stringify(ajout), id);
  const morceaux = db.prepare(`SELECT id,text,embedded FROM chunks WHERE entry_id=?`).all(id);
  const maj = db.prepare(`UPDATE chunks SET text=?, embedded=? WHERE id=?`);
  for (const c of morceaux) {
    const t = String(c.text);
    if (!t.startsWith(e.title)) continue;
    maj.run(titre + t.slice(e.title.length), c.embedded === -1 ? -1 : 0, c.id);
  }
  return true;
}

/**
 * Donne un vrai titre aux échanges qui portent encore leur question.
 * `demander(consigne, texte)` renvoie le texte du modèle ; sans lui, rien.
 */
async function titrerEchanges(db, { demander, lot = LOT_TITRES } = {}) {
  const rows = aTitrer(db, lot);
  if (!rows.length) return { titres: 0, restants: 0 };
  if (typeof demander !== 'function') return { titres: 0, restants: rows.length, raison: 'aucun modèle' };

  const sujets = db.prepare(
    `SELECT json_extract(meta,'$.sujet') s, count(*) n FROM entries
     WHERE kind='echange' AND json_extract(meta,'$.sujet') IS NOT NULL
     GROUP BY s ORDER BY n DESC LIMIT 12`).all().map(r => r.s);
  const texte = (sujets.length ? `Sujets déjà utilisés : ${sujets.join(', ')}\n\n` : '')
    + rows.map((r, i) => `[${i + 1}]\n${String(r.body || r.title).slice(0, 900)}`).join('\n\n');

  let brut;
  try { brut = await demander(CONSIGNE_TITRES, texte); }
  catch (e) { return { titres: 0, restants: rows.length, raison: 'modèle indisponible : ' + e.message }; }

  let obj = null;
  try { obj = JSON.parse(brut); } catch {
    const a = String(brut).indexOf('{'), b = String(brut).lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(String(brut).slice(a, b + 1)); } catch { obj = null; } }
  }
  const liste = Array.isArray(obj?.echanges) ? obj.echanges : [];
  let n = 0;
  rows.forEach((r, i) => {
    const it = liste.find(x => Number(x?.n) === i + 1);
    const titre = propre(it?.titre);
    const sujet = propre(it?.sujet).slice(0, 30);
    const q = questionDe(r.body) || r.title;
    /* Un titre qui recopie la question n'apporte rien : on retentera. */
    const nt = norm(titre), nq = norm(q);
    const valable = titre.length >= 8 && nt !== nq && !nq.startsWith(nt) && !/\?$/.test(titre);
    if (!valable) {
      const meta = (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })();
      db.prepare(`UPDATE entries SET meta=json_patch(COALESCE(meta,'{}'), ?) WHERE id=?`)
        .run(JSON.stringify({ titre_essais: (Number(meta.titre_essais) || 0) + 1 }), r.id);
      return;
    }
    renomme(db, r.id, titre, { titre: 'auto', sujet: sujet || null, question: String(q).slice(0, 300) });
    n++;
  });
  return { titres: n, restants: aTitrer(db, 1000).length };
}

/**
 * Tes habitudes, telles que les données les montrent.
 * Les instants sont bruts (ISO) : le navigateur les range par heure et par
 * jour dans ton fuseau.
 */
function habitudes(db, { jours = 90 } = {}) {
  const depuis = new Date(Date.now() - jours * 86400000).toISOString();
  const echanges = db.prepare(
    `SELECT occurred_at t FROM entries WHERE kind='echange' AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 3000`)
    .all(depuis).map(r => r.t);
  let questions = [];
  try {
    questions = db.prepare(
      `SELECT ts t FROM requetes WHERE route='answer' AND ts >= ? ORDER BY ts DESC LIMIT 3000`).all(depuis).map(r => r.t);
  } catch { /* journal d'activité absent */ }
  const sujets = db.prepare(
    `SELECT json_extract(meta,'$.sujet') sujet, count(*) n, max(occurred_at) dernier FROM entries
     WHERE kind='echange' AND occurred_at >= ? AND json_extract(meta,'$.sujet') IS NOT NULL
     GROUP BY lower(json_extract(meta,'$.sujet')) ORDER BY n DESC LIMIT 8`).all(depuis);
  const recents = db.prepare(
    `SELECT id,title,occurred_at,json_extract(meta,'$.sujet') sujet FROM entries
     WHERE kind='echange' AND archived=0 AND json_extract(meta,'$.titre') = 'auto'
     ORDER BY occurred_at DESC LIMIT 6`).all();
  return { jours, moments: [...echanges, ...questions].sort().reverse(), echanges: echanges.length, questions: questions.length, sujets, recents };
}

module.exports = { titrerEchanges, habitudes, aTitrer, renomme, propre, questionDe, CONSIGNE_TITRES };
