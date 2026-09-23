'use strict';
/* ============================================================
   La tache d'analyse : une seule a la fois, interruptible.

   Pourquoi une tache et pas un appel synchrone : reecrire cinquante
   titres demande au modele local plusieurs minutes. Une requete HTTP
   qui attend tout ce temps expire, et l'interface ne montre rien
   pendant ce temps.

   La tache avance donc en arriere-plan, expose sa progression, et
   s'arrete entre deux etapes quand on lui demande. « Entre deux
   etapes » compte : interrompre au milieu d'un appel au modele
   laisserait une reponse a moitie lue.

   Elle ne MODIFIE rien. Elle produit un plan, que quelqu'un applique.
   ============================================================ */

const RG = require('./rangement.js');

const ETATS = ['repos', 'analyse', 'pause', 'fini', 'erreur'];

let etat = 'repos';
let progression = { etape: '', fait: 0, total: 0 };
let plan = null;          /* { actions, resume, ts, source } */
let arret = false, pause = false;
let derniere = null;      /* { fin, actions, duree, source } */
let erreur = null;

const attend = ms => new Promise(r => setTimeout(r, ms));

/* Pause bloquante : la boucle s'arrete ici tant que l'etat est
   `pause`. Rien ne tourne pendant ce temps — c'est le but. */
async function pointDArret() {
  while (pause && !arret) { etat = 'pause'; await attend(500); }
  if (!arret) etat = 'analyse';
  return !arret;
}

/* ---------- lancement ---------- */
async function lance(db, cfg, { reecrit, source = 'manuel' } = {}) {
  if (etat === 'analyse' || etat === 'pause') return { refus: 'une analyse tourne deja' };
  etat = 'analyse'; arret = false; pause = false; erreur = null; plan = null;
  progression = { etape: 'lecture de la memoire', fait: 0, total: 0 };
  const t0 = Date.now();

  (async () => {
    try {
      const actions = [], resume = [];

      /* --- doublons : mesures, immediat --- */
      progression = { etape: 'recherche des doublons', fait: 0, total: 0 };
      if (!await pointDArret()) return fin(t0, source);
      const d = RG.doublons(db, { ns: cfg.espace || null, seuil: cfg.seuil_doublon });
      for (const p of d.actions) {
        actions.push({ type: 'supprimer', id: p.jette.id });
        resume.push({
          type: 'supprimer', id: p.jette.id,
          titre: p.jette.title, garde: p.garde.title,
          similarite: p.similarite
        });
      }

      /* --- titres : un appel au modele par entree, d'ou la pause --- */
      if (cfg.reecrire_titres && reecrit) {
        const faibles = RG.titresFaibles(db, { ns: cfg.espace || null, max: 40 });
        progression = { etape: 'reecriture des titres', fait: 0, total: faibles.length };
        for (const e of faibles) {
          if (!await pointDArret()) return fin(t0, source, actions, resume);
          let t = null;
          try { t = await reecrit(e); } catch { /* modele muet : on passe */ }
          progression.fait++;
          if (!t) continue;
          actions.push({ type: 'renommer', id: e.id, titre: t });
          resume.push({ type: 'renommer', id: e.id, avant: e.title, apres: t });
        }
      }

      /* --- orphelins : signales, jamais touches --- */
      const orph = RG.orphelins(db);

      plan = { actions, resume, orphelins: orph.length, ts: Date.now(), source,
               candidats: d.candidats, vectorisees: d.total };
      fin(t0, source, actions, resume);
    } catch (e) {
      erreur = String(e.message).slice(0, 200);
      etat = 'erreur';
    }
  })();

  return { lance: true };
}

function fin(t0, source, actions = [], resume = []) {
  if (!plan && actions.length) plan = { actions, resume, ts: Date.now(), source };
  etat = arret ? 'repos' : 'fini';
  derniere = {
    fin: new Date().toISOString(),
    actions: actions.length,
    duree: Math.round((Date.now() - t0) / 1000),
    source, interrompue: arret
  };
  progression = { etape: arret ? 'interrompue' : 'terminee', fait: 0, total: 0 };
}

/* ---------- pilotage ---------- */
function metEnPause() { if (etat === 'analyse') { pause = true; return true; } return false; }
function reprend() { if (etat === 'pause') { pause = false; etat = 'analyse'; return true; } return false; }
function interrompt() { if (etat === 'analyse' || etat === 'pause') { arret = true; pause = false; return true; } return false; }

function statut() {
  return {
    etat, progression, erreur,
    plan: plan ? {
      actions: plan.actions.length,
      supprimer: plan.actions.filter(a => a.type === 'supprimer').length,
      renommer: plan.actions.filter(a => a.type === 'renommer').length,
      orphelins: plan.orphelins || 0,
      candidats: plan.candidats || 0,
      vectorisees: plan.vectorisees || 0,
      source: plan.source, age_s: Math.round((Date.now() - plan.ts) / 1000),
      resume: plan.resume || []
    } : null,
    derniere
  };
}

function prendPlan() {
  const p = plan;
  /* Un plan vieux d'une heure a pu etre invalide par des ecritures
     survenues entre-temps. */
  if (!p || Date.now() - p.ts > 3600000) { plan = null; return null; }
  plan = null;
  return p;
}

function jettePlan() { plan = null; }

module.exports = { lance, metEnPause, reprend, interrompt, statut, prendPlan, jettePlan, ETATS };
