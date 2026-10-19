'use strict';
/* ============================================================
   Reglages persistants, ranges dans la table `meta` qui existe deja.
   Une table de plus pour huit valeurs ne se justifie pas.

   Le jeton Telegram vit ici : c'est un secret, mais un secret que la
   page de parametres doit pouvoir poser sans qu'on edite un .env et
   qu'on redemarre le service. Il est scelle par le coffre du socle
   (SOCLE_CLE) et n'est jamais renvoye par l'API — seulement sa fin,
   « …4f2c ».
   ============================================================ */

const DEFAUTS = {
  seuil_doublon: 0.94,
  espace: '',                  /* vide = tous les espaces */
  reecrire_titres: true,
  plages: [],                  /* [{h,m,jours:[0..6]}] */
  telegram_token: '',
  telegram_chat: '',
  telegram_actif: false
};
const USAGE = 'synapse.telegram';
const LIEN = 'rangement';
let coffre = null;

const TELEGRAM_JETON = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const TELEGRAM_CHAT = /^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/;

function brut(db) {
  const r = db.prepare(`SELECT v FROM meta WHERE k = 'rangement'`).get();
  if (!r) return { ...DEFAUTS };
  try { return { ...DEFAUTS, ...JSON.parse(r.v) }; } catch { return { ...DEFAUTS }; }
}

function poser(db, c) {
  db.prepare(`INSERT INTO meta(k,v) VALUES('rangement',?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(JSON.stringify(c));
}

/* Le jeton en clair, pour qui doit s'en servir (l'envoi Telegram). */
function lit(db) {
  const c = brut(db);
  if (c.telegram_token && coffre) {
    try { c.telegram_token = coffre.ouvre(USAGE, c.telegram_token, LIEN); }
    catch { c.telegram_token = ''; }
  }
  return c;
}

/* Seules les clés connues entrent, chacune à sa forme : un champ inventé
   par l'appelant n'atterrit pas dans la base. */
function ecrit(db, patch) {
  const avant = lit(db);
  const c = { ...avant };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.seuil_doublon !== undefined) c.seuil_doublon = Number(p.seuil_doublon);
  if (p.espace !== undefined) c.espace = /^(|shared|savoir)$/.test(String(p.espace)) ? String(p.espace) : avant.espace;
  if (p.reecrire_titres !== undefined) c.reecrire_titres = p.reecrire_titres === true;
  if (p.telegram_actif !== undefined) c.telegram_actif = p.telegram_actif === true;
  if (p.telegram_chat !== undefined) {
    const chat = String(p.telegram_chat).trim();
    if (chat && !TELEGRAM_CHAT.test(chat)) throw Object.assign(new Error('conversation Telegram : un identifiant numérique ou @nom'), { status: 400 });
    c.telegram_chat = chat;
  }
  if (p.telegram_token !== undefined) {
    const t = String(p.telegram_token).trim();
    if (t && !TELEGRAM_JETON.test(t)) throw Object.assign(new Error('jeton Telegram : la forme donnée par @BotFather'), { status: 400 });
    c.telegram_token = t;
  }
  if (p.plages !== undefined) c.plages = p.plages;
  /* Bornes : une valeur absurde arrivee par l'API ne doit pas pouvoir
     vider la memoire. A 0.88 des notes voisines commencent deja a se
     ressembler ; en dessous, le dedoublonnage devient destructeur. */
  c.seuil_doublon = Math.min(0.99, Math.max(0.88, Number(c.seuil_doublon) || 0.94));
  c.plages = (Array.isArray(c.plages) ? c.plages : []).slice(0, 8).map(x => ({
    h: Math.min(23, Math.max(0, parseInt(x && x.h, 10) || 0)),
    m: Math.min(59, Math.max(0, parseInt(x && x.m, 10) || 0)),
    jours: x && Array.isArray(x.jours) && x.jours.length
      ? [...new Set(x.jours.map(Number).filter(j => Number.isInteger(j) && j >= 0 && j <= 6))].sort()
      : [0, 1, 2, 3, 4, 5, 6]
  }));
  if (c.telegram_token && !coffre) throw new Error('coffre absent : le jeton Telegram ne peut pas être scellé');
  poser(db, { ...c, telegram_token: c.telegram_token ? coffre.scelle(USAGE, c.telegram_token, LIEN) : '' });
  return c;
}

/* Au démarrage : le coffre du socle prend le jeton. Un jeton encore en
   clair (SYNAPSE 1.x) est scellé ; un jeton scellé par la clé remplacée
   (SOCLE_CLE_ANCIENNE, pendant une rotation) est rescellé ; un jeton que
   ni l'une ni l'autre n'ouvre est retiré, à reposer dans les paramètres. */
function sceller(db, c) {
  coffre = c;
  const r = brut(db);
  const t = r.telegram_token;
  if (!t) return { rescelles: 0, retires: 0 };
  let clair = null;
  if (!String(t).startsWith('v1.')) clair = t;
  else {
    try { coffre.ouvre(USAGE, t, LIEN); return { rescelles: 0, retires: 0 }; } catch { /* clé tournée ? */ }
    try { clair = coffre.precedente ? coffre.precedente.ouvre(USAGE, t, LIEN) : null; } catch { clair = null; }
  }
  poser(db, { ...r, telegram_token: clair ? coffre.scelle(USAGE, clair, LIEN) : '' });
  return clair ? { rescelles: 1, retires: 0 } : { rescelles: 0, retires: 1 };
}

/* Le jeton devient une empreinte : un secret affiche dans une page
   finit dans une capture d'ecran. */
function public_(c) {
  return {
    ...c,
    telegram_token: c.telegram_token ? '…' + c.telegram_token.slice(-4) : '',
    telegram_configure: !!(c.telegram_token && c.telegram_chat)
  };
}

module.exports = { lit, ecrit, public_, sceller, DEFAUTS, TELEGRAM_JETON, TELEGRAM_CHAT };
