'use strict';
/* ============================================================
   SYNAPSE — l'annuaire des cerveaux.

   SYNAPSE est le cerveau du homelab. Chaque service qui a son IA (le
   Hub, MapMyLAN, et ceux qui viendront) y a un MINI-cerveau : sa fiche
   (ce qu'il sait, ce qu'il fait, ses règles), son état du moment, et —
   par les échanges et le brief qui existaient déjà — ses traits appris.

   Ce module répond à deux questions :

     « qui es-tu ? »      la fiche qu'un cerveau pose sur lui-même ;
     « qui sait ça ? »    orienter : pour une question, les cerveaux dont
                          c'est le périmètre, et si c'est une ACTION, qui
                          a le droit de la faire.

   Il ne fait rien exécuter à personne. Une question hors périmètre
   reçoit le contexte du cerveau concerné ; une action est renvoyée à
   son propriétaire, où l'utilisateur la valide. Un cerveau n'en pilote
   jamais un autre.

   Les jetons. Chaque service installé par le Hub reçoit un jeton de
   cerveau DÉRIVÉ du jeton du Hub : cer_<nom>_<hmac>. SYNAPSE le vérifie
   sans rien stocker d'avance ; il ne vaut que pour ce nom, et changer le
   jeton du Hub les révoque tous d'un coup.
   ============================================================ */

const crypto = require('node:crypto');

const NOM = /^[a-z0-9][a-z0-9-]{1,30}$/;

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cerveaux (
      nom        TEXT PRIMARY KEY,
      titre      TEXT NOT NULL,
      perimetre  TEXT NOT NULL DEFAULT '',
      sait       TEXT NOT NULL DEFAULT '[]',   -- sujets, en JSON
      actions    TEXT NOT NULL DEFAULT '[]',   -- [{ nom, ou }], en JSON
      regles     TEXT NOT NULL DEFAULT '',
      ui         TEXT NOT NULL DEFAULT '',
      etat       TEXT NOT NULL DEFAULT '',
      etat_le    TEXT,
      maj        TEXT NOT NULL
    );
  `);
}

/* ---------- jetons de cerveau ---------- */

const signe = (cle, nom) => crypto.createHmac('sha256', String(cle)).update('cerveau:' + nom).digest('hex');

/** Le jeton d'un cerveau, tel que le Hub le calcule et le passe au service. */
function jetonPour(cle, nom) {
  if (!cle || String(cle).length < 16 || !NOM.test(nom)) return null;
  return `cer_${nom}_${signe(cle, nom)}`;
}

/** Le nom porté par un jeton de cerveau valide, sinon null. Comparaison à temps constant. */
function verifieJeton(cle, brut) {
  if (!cle || String(cle).length < 16) return null;
  const m = /^cer_([a-z0-9][a-z0-9-]{1,30})_([0-9a-f]{64})$/.exec(String(brut || ''));
  if (!m) return null;
  const attendu = Buffer.from(signe(cle, m[1]), 'hex'), recu = Buffer.from(m[2], 'hex');
  return attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu) ? m[1] : null;
}

/* ---------- fiches ---------- */

const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const liste = (v, max, n) => (Array.isArray(v) ? v : []).map(x => texte(x, max)).filter(Boolean).slice(0, n);

function nettoie(fiche) {
  const ui = texte(fiche.ui, 200);
  return {
    titre: texte(fiche.titre, 80),
    perimetre: texte(fiche.perimetre, 800),
    sait: liste(fiche.sait, 48, 60),
    actions: (Array.isArray(fiche.actions) ? fiche.actions : []).slice(0, 20)
      .map(a => ({ nom: texte(a?.nom, 100), ou: texte(a?.ou, 140) })).filter(a => a.nom),
    regles: texte(fiche.regles, 1200),
    ui: /^https?:\/\/[^\s"'<>]+$/.test(ui) ? ui : '',
  };
}

/** Un cerveau pose (ou remplace) sa propre fiche. Le nom vient du jeton, jamais du corps. */
function inscrire(db, nom, fiche) {
  if (!NOM.test(nom)) return { ok: false, raison: 'nom de cerveau invalide' };
  const f = nettoie(fiche || {});
  if (!f.titre) return { ok: false, raison: 'titre requis' };
  db.prepare(`INSERT INTO cerveaux(nom,titre,perimetre,sait,actions,regles,ui,maj)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(nom) DO UPDATE SET titre=excluded.titre, perimetre=excluded.perimetre, sait=excluded.sait,
                actions=excluded.actions, regles=excluded.regles, ui=excluded.ui, maj=excluded.maj`)
    .run(nom, f.titre, f.perimetre, JSON.stringify(f.sait), JSON.stringify(f.actions), f.regles, f.ui, new Date().toISOString());
  return { ok: true, nom };
}

/** L'état du moment : un court résumé que les autres cerveaux liront. Remplacé à chaque envoi. */
function poserEtat(db, nom, etat) {
  const t = texte(etat, 2000);
  const r = db.prepare(`UPDATE cerveaux SET etat=?, etat_le=? WHERE nom=?`).run(t, new Date().toISOString(), nom);
  return r.changes ? { ok: true } : { ok: false, raison: 'fiche absente : inscris-toi d’abord' };
}

const lire = r => r && {
  nom: r.nom, titre: r.titre, perimetre: r.perimetre, sait: JSON.parse(r.sait || '[]'), actions: JSON.parse(r.actions || '[]'),
  regles: r.regles, ui: r.ui, etat: r.etat, etatLe: r.etat_le, maj: r.maj,
};

function tous(db) { return db.prepare(`SELECT * FROM cerveaux ORDER BY nom`).all().map(lire); }
function un(db, nom) { return lire(db.prepare(`SELECT * FROM cerveaux WHERE nom=?`).get(nom)); }
function retirer(db, nom) { return db.prepare(`DELETE FROM cerveaux WHERE nom=?`).run(nom).changes > 0; }

/* ---------- orienter ----------
   Sans modèle : quelques millisecondes, et un résultat qu'on peut
   expliquer (« parce que tu as dit workflow »). Le nom d'un cerveau cité
   pèse le plus ; ses sujets ensuite ; les mots de son périmètre peu. */

const sansAccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VIDES = new Set('les des une un le la de du et ou en sur pour par avec dans que qui quoi est sont mon ma mes ton ta tes son sa ses nous vous ils elles pas plus tout tous cette ces aux au il elle je tu on ce se ne y a'.split(' '));
/* Une racine grossière suffit : « crée », « créer », « créez » et « workflows »
   doivent tomber sur « créer ou modifier un workflow ». */
const racine = m => { let r = m.replace(/s$/, ''); if (r.length > 4) r = r.replace(/(er|ez|e)$/, ''); return r; };
const mots = s => sansAccent(s).split(/[^a-z0-9]+/).filter(m => m.length >= 3 && !VIDES.has(m)).map(racine);

const VERBES_ACTION = /\b(cree|creer|creez|cree-moi|fais|faire|ajoute|ajouter|installe|installer|desinstalle|supprime|supprimer|retire|retirer|lance|lancer|demarre|demarrer|redemarre|redemarrer|arrete|arreter|stoppe|bloque|bloquer|debloque|isole|isoler|active|activer|desactive|desactiver|configure|configurer|modifie|modifier|change|changer|envoie|envoyer|programme|programmer|planifie|planifier|mets|mettre|branche|brancher|relie|relier|connecte|connecter|met a jour|mettre a jour|rename|renomme)\b/;

const estAction = q => VERBES_ACTION.test(sansAccent(q));

function orienter(db, q, { depuis = null, limite = 3 } = {}) {
  const qn = ' ' + sansAccent(q).replace(/[^a-z0-9]+/g, ' ') + ' ';
  const qm = new Set(mots(q));
  const action = estAction(q);
  const out = [];
  for (const c of tous(db)) {
    let score = 0;
    const pourquoi = [];
    const cite = [c.nom, c.titre.split(/[—–:-]/)[0]].map(x => sansAccent(x).trim()).filter(x => x.length >= 3);
    if (cite.some(n => qn.includes(' ' + n + ' '))) { score += 6; pourquoi.push(`nommé (${c.nom})`); }
    for (const s of c.sait) {
      const sn = sansAccent(s).replace(/[^a-z0-9]+/g, ' ').trim();
      if (sn.length >= 3 && qn.includes(' ' + sn + ' ')) { score += sn.includes(' ') ? 3 : 2; pourquoi.push(s); }
    }
    let faibles = 0;
    for (const m of mots(c.perimetre)) if (qm.has(m) && faibles < 3) { faibles++; score += 0.5; }
    let act = null;
    if (action) {
      for (const a of c.actions) {
        const communs = mots(a.nom).filter(m => qm.has(m));
        if (communs.length) { score += 1.5 * communs.length; if (!act || communs.length > act.n) act = { nom: a.nom, ou: a.ou, n: communs.length }; }
      }
    }
    if (score > 0) {
      out.push({ nom: c.nom, titre: c.titre, score: Math.round(score * 10) / 10, pourquoi: [...new Set(pourquoi)].slice(0, 5),
        action: act ? { nom: act.nom, ou: act.ou } : null, ui: c.ui, etat: c.etat, etatLe: c.etatLe, lui: c.nom === depuis });
    }
  }
  out.sort((a, b) => b.score - a.score || a.nom.localeCompare(b.nom));
  return { action, cerveaux: out.slice(0, limite) };
}

/** Pour le brief : les AUTRES cerveaux concernés par la question, avec leur état. */
function pourBrief(db, q, soi) {
  if (!String(q || '').trim()) return [];
  const moi = new Set([].concat(soi || []).filter(Boolean));
  return orienter(db, q, { limite: 4 }).cerveaux.filter(c => !moi.has(c.nom) && c.score >= 2).slice(0, 3);
}

function texteBrief(cerveaux) {
  if (!cerveaux?.length) return '';
  const l = ['Autres cerveaux du homelab concernés par la question (ce sont leurs informations, pas les tiennes — cite-les) :'];
  for (const c of cerveaux) {
    l.push(`- ${c.titre} [${c.nom}]${c.etat ? ` — état ${c.etatLe ? `au ${c.etatLe.slice(0, 16).replace('T', ' ')}` : 'récent'} : ${c.etat.slice(0, 600)}` : ''}`);
    if (c.action) l.push(`  Action « ${c.action.nom} » : c'est lui qui la fait (${c.action.ou || c.titre}). Ne la fais pas : renvoie l'utilisateur vers lui.`);
  }
  return l.join('\n');
}

module.exports = { migrate, jetonPour, verifieJeton, inscrire, poserEtat, tous, un, retirer, orienter, estAction, pourBrief, texteBrief, NOM };
