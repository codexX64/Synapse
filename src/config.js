'use strict';
/* ============================================================
   Reglages persistants, ranges dans la table `meta` qui existe deja.
   Une table de plus pour huit valeurs ne se justifie pas.

   Le jeton Telegram vit ici : c'est un secret, mais un secret que la
   page de parametres doit pouvoir poser sans qu'on edite un .env et
   qu'on redemarre le service. Il n'est jamais renvoye en clair par
   l'API — seulement son empreinte, « …4f2c ».
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

function lit(db) {
  const r = db.prepare(`SELECT v FROM meta WHERE k = 'rangement'`).get();
  if (!r) return { ...DEFAUTS };
  try { return { ...DEFAUTS, ...JSON.parse(r.v) }; } catch { return { ...DEFAUTS }; }
}

function ecrit(db, patch) {
  const c = { ...lit(db), ...patch };
  /* Bornes : une valeur absurde arrivee par l'API ne doit pas pouvoir
     vider la memoire. A 0.88 des notes voisines commencent deja a se
     ressembler ; en dessous, le dedoublonnage devient destructeur. */
  c.seuil_doublon = Math.min(0.99, Math.max(0.88, Number(c.seuil_doublon) || 0.94));
  c.plages = (Array.isArray(c.plages) ? c.plages : []).slice(0, 8).map(p => ({
    h: Math.min(23, Math.max(0, parseInt(p.h, 10) || 0)),
    m: Math.min(59, Math.max(0, parseInt(p.m, 10) || 0)),
    jours: Array.isArray(p.jours) && p.jours.length
      ? [...new Set(p.jours.map(Number).filter(j => j >= 0 && j <= 6))].sort()
      : [0, 1, 2, 3, 4, 5, 6]
  }));
  db.prepare(`INSERT INTO meta(k,v) VALUES('rangement',?)
              ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(JSON.stringify(c));
  return c;
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

module.exports = { lit, ecrit, public_, DEFAUTS };
