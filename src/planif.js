'use strict';
/* ============================================================
   Plages horaires et notification Telegram.

   Le planificateur se reveille chaque minute : sur huit plages au
   maximum, un timer par plage serait plus elegant et plus fragile —
   il faudrait les reprogrammer a chaque changement de reglage, a
   chaque passage a l'heure d'ete, a chaque redemarrage.

   Une analyse declenchee par une plage PROPOSE un plan. Elle ne
   l'applique pas. Un rangement automatique de bout en bout finirait
   par supprimer quelque chose une nuit ou personne ne regarde.
   ============================================================ */

const CFG = require('./config.js');
const T = require('./tache.js');

let dernierDeclenchement = '';   /* AAAA-MM-JJ HH:MM, pour ne pas rejouer */

function doitTourner(cfg, now = new Date()) {
  if (!cfg.plages || !cfg.plages.length) return false;
  const j = now.getDay(), h = now.getHours(), m = now.getMinutes();
  const cle = `${now.toISOString().slice(0, 10)} ${h}:${m}`;
  if (cle === dernierDeclenchement) return false;
  for (const p of cfg.plages) {
    if (p.h === h && p.m === m && p.jours.includes(j)) {
      dernierDeclenchement = cle;
      return true;
    }
  }
  return false;
}

/* ---------- Telegram, facultatif ---------- */
async function previens(cfg, texte, clavier) {
  if (!cfg.telegram_actif || !cfg.telegram_token || !cfg.telegram_chat) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegram_chat, text: texte.slice(0, 4000), parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(clavier ? { reply_markup: { inline_keyboard: clavier } } : {})
      }),
      signal: AbortSignal.timeout(12000)
    });
    const j = await r.json();
    return j.ok ? j.result : { erreur: j.description };
  } catch (e) { return { erreur: String(e.message).slice(0, 120) }; }
}

/* Verifie le jeton ET le chat : un jeton valide avec un mauvais chat
   echoue silencieusement a chaque notification. */
async function testeTelegram(token, chat) {
  try {
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(10000) })).json();
    if (!me.ok) return { ok: false, erreur: me.description || 'jeton refuse' };
    const env = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: 'SYNAPSE — liaison etablie.' }),
      signal: AbortSignal.timeout(10000)
    })).json();
    if (!env.ok) return { ok: false, erreur: 'jeton bon, chat refuse : ' + (env.description || '') };
    return { ok: true, bot: me.result.username };
  } catch (e) { return { ok: false, erreur: String(e.message).slice(0, 120) }; }
}

/* ---------- boucle ---------- */
function demarre(db, reecrit) {
  const tic = async () => {
    try {
      const cfg = CFG.lit(db);
      if (!doitTourner(cfg)) return;
      const r = await T.lance(db, cfg, { reecrit, source: 'planifie' });
      if (r.refus) return;
      /* on attend la fin pour notifier : un message « analyse lancee »
         sans resultat n'apprend rien */
      const attendre = setInterval(async () => {
        const s = T.statut();
        if (s.etat === 'analyse' || s.etat === 'pause') return;
        clearInterval(attendre);
        if (!s.plan || !s.plan.actions) return;    /* rien a ranger : silence */
        await previens(cfg,
          `<b>Rangement propose</b> · ${s.plan.actions} actions\n` +
          `${s.plan.supprimer} doublons, ${s.plan.renommer} titres\n\n` +
          `A valider sur <a href="${process.env.AUTH_ORIGIN || ''}/parametres">la page de parametres</a>.`);
      }, 5000);
    } catch (e) { console.error('[planif]', e.message); }
  };
  const id = setInterval(tic, 60000);
  if (id.unref) id.unref();
  return id;
}

module.exports = { demarre, previens, testeTelegram, doitTourner };
