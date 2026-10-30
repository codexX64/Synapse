// Frappe d'un texte par le service lui-même, dans une machine distante : sa
// propre connexion à l'écran (VNC), chaque caractère sur les touches qui le
// donnent là-bas (web/clavier.js), à un rythme que la machine suit. Le
// navigateur envoie le texte et peut quitter la page : la frappe continue.
//
// Le transport est celui du service : ouvrir(cible) rend { envoyer(ev),
// fermer(), surFin(fn) }, ev étant { code, xt, keysym, bas }.
//
// Le texte ne vit qu'en mémoire, le temps de la frappe : jamais journalisé,
// jamais rendu par l'état (qui ne dit que des nombres), effacé à la fin.
import { evenementsCaractere, normaliser, dispositionConnue, rythmeFrappe } from '../web/clavier.js';
import { ErreurHttp } from './outils.js';

export const FRAPPE_MAX = 100000;               // caractères
const GARDE_FIN_MS = 10 * 60e3;                 // l'état d'une frappe finie, gardé pour qui revient
const MODES = ['qemu', 'us', 'traduit'];

export class Frappes {
  constructor({ ouvrir, journal = null, simultanees = 4, essais = 2, horloge = Date.now, attendre = ms => new Promise(r => setTimeout(r, ms)) }) {
    Object.assign(this, { ouvrir, journal, simultanees, essais, horloge, attendre });
    this.taches = new Map();
  }

  // L'état public : des nombres et un statut, jamais le texte.
  publique(t) {
    if (!t) return null;
    return { etat: t.etat, total: t.total, tapes: t.tapes, sautes: t.sautes, debut: t.debut, fin: t.fin, msParCaractere: t.ms, par: t.par, message: t.message || '' };
  }

  etat(cle) {
    const t = this.taches.get(cle);
    if (t && t.etat !== 'en cours' && this.horloge() - t.fin > GARDE_FIN_MS) { this.taches.delete(cle); return null; }
    return this.publique(t);
  }

  enCours() { return [...this.taches.values()].filter(t => t.etat === 'en cours').length; }

  /**
   * cle : ce qui ne tape qu'une fois à la fois (une VM, une console) ;
   * cible : passée telle quelle à ouvrir() ; mode : voir web/clavier.js ;
   * min, max : bornes du rythme, en millisecondes par caractère.
   */
  demarrer(cle, { cible, texte, disposition, mode = 'qemu', min = 8, max = 25, par = null, contexte = {} }) {
    if (!MODES.includes(mode)) throw new ErreurHttp(400, 'Mode de frappe inconnu.');
    if (mode !== 'traduit' && !dispositionConnue(disposition)) throw new ErreurHttp(400, 'Disposition du clavier inconnue.');
    const caracteres = [...normaliser(texte)];
    if (!caracteres.length) throw new ErreurHttp(400, 'Rien à taper.');
    if (caracteres.length > FRAPPE_MAX) throw new ErreurHttp(413, `Au plus ${FRAPPE_MAX} caractères par frappe.`);
    if (this.taches.get(cle)?.etat === 'en cours') throw new ErreurHttp(409, 'Une frappe est déjà en cours sur cette machine : arrête-la ou attends qu\'elle finisse.');
    if (this.enCours() >= this.simultanees) throw new ErreurHttp(429, 'Trop de frappes en cours : réessaie quand l\'une d\'elles a fini.');
    const t = { etat: 'en cours', total: caracteres.length, tapes: 0, sautes: 0, debut: this.horloge(), fin: 0, ms: rythmeFrappe(caracteres.length, { min, max }), par, message: '', arret: false };
    this.taches.set(cle, t);
    this.executer(t, { cible, caracteres, disposition, mode, contexte }).catch(() => { /* l'état dit l'échec */ });
    return this.publique(t);
  }

  arreter(cle) {
    const t = this.taches.get(cle);
    if (t?.etat === 'en cours') t.arret = true;
    return this.publique(t);
  }

  // Tout ce qui tape encore s'arrête (service qui s'éteint).
  arreterTout() { for (const t of this.taches.values()) t.arret = true; }

  async executer(t, { cible, caracteres, disposition, mode, contexte }) {
    let lien = null, coupee = false;
    const tenues = new Map();          // touches enfoncées, relâchées quoi qu'il arrive
    try {
      for (let essai = 1; ; essai++) {
        try { lien = await this.ouvrir(cible); break; } catch (e) {
          if (essai >= this.essais || t.arret) throw e;
          await this.attendre(500);
        }
      }
      lien.surFin?.(() => { coupee = true; });
      const envoyer = ev => {
        if (ev.bas) tenues.set(ev.code ?? ev.keysym, ev); else tenues.delete(ev.code ?? ev.keysym);
        lien.envoyer(ev);
      };
      const t0 = this.horloge(), tenue = Math.max(2, Math.floor(t.ms / 3));
      for (let i = 0; i < caracteres.length; i++) {
        if (t.arret || coupee) break;
        const ev = evenementsCaractere(caracteres[i], disposition, { mode });
        if (!ev) { t.sautes++; continue; }
        // Maj et Alt Gr, puis la touche tenue un instant, relâchée, et un
        // instant encore avant la suivante (une touche morte, puis sa lettre).
        for (const e of ev) {
          envoyer(e);
          if (!/^(Shift|Alt)/.test(e.code || '')) await this.attendre(tenue);
        }
        t.tapes++;
        // Le pas du caractère suivant, compté depuis le début (pas de dérive).
        const retard = t0 + (i + 1) * t.ms - this.horloge();
        if (retard > 0) await this.attendre(retard);
      }
      if (coupee && !t.arret && t.tapes + t.sautes < t.total) throw new Error('la connexion à l\'écran s\'est fermée');
      t.etat = t.arret ? 'arrêtée' : 'terminée';
    } catch (e) {
      t.etat = 'échec';
      t.message = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200);
    } finally {
      if (lien && !coupee) {
        for (const ev of [...tenues.values()].reverse()) { try { lien.envoyer({ ...ev, bas: false }); } catch { /* fermée */ } }
        try { lien.fermer(); } catch { /* fermée */ }
      }
      caracteres.length = 0;
      t.fin = this.horloge();
      this.journal?.({ ...this.publique(t), ...contexte });
    }
  }
}
