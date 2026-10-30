// Assistant de configuration : les réglages qu'un administrateur pose depuis
// l'interface plutôt que dans l'environnement du conteneur.
//
// Chaque service déclare la liste de ses réglages (variable, libellé, aide,
// groupe, version d'apparition). Au premier démarrage, l'assistant les présente
// tous et le service reste fermé tant qu'il n'est pas passé. Après une mise à
// jour, seuls les réglages que l'assistant n'a encore jamais présentés sont
// demandés. Une variable posée dans l'environnement l'emporte toujours et n'est
// pas demandée : le Hub, ou un fichier .env, garde la main.
//
// Les valeurs vivent dans reglages.json, dans le volume de données (0600). Un
// secret y est scellé par la clé maîtresse du socle, lié au nom de sa variable.
import fs from 'node:fs';
import path from 'node:path';
import { Coffre } from './chiffre.js';
import { lireConfig } from './config.js';

const FICHIER = 'reglages.json';
const USAGE = 'reglage';
// Environnement fusionné → ce qui vient vraiment de l'environnement, et d'où.
const ORIGINES = new WeakMap();

// Réglages communs à tous les services, lus par le socle (SPEC_SOCLE).
export const REGLAGES_SOCLE = [
  { env: 'SOCLE_URL_PUBLIQUE', groupe: 'Accès', libelle: 'Adresse publique', exemple: 'https://service.exemple.org',
    aide: 'L’adresse complète par laquelle on ouvre ce service. Les liens des courriels (invitations, alertes) en partent. Vide : l’adresse vue par le navigateur.' },
  { env: 'SOCLE_PROXYS', groupe: 'Accès', libelle: 'Relais de confiance', exemple: '172.16.0.0/12',
    aide: 'Adresses ou plages du relais inverse (Caddy, Traefik, Nginx…) placé devant le service, séparées par des virgules. Lui seul peut dire l’adresse réelle du visiteur. Vide : aucun relais.' },
  { env: 'SOCLE_THEME', groupe: 'Apparence', libelle: 'Gamme de l’interface', aide: 'Couleurs et style de l’interface.',
    noms: { soma: 'SOMA', console: 'Console', exploitation: 'Exploitation', lavande: 'Lavande' } },
  { env: 'SOCLE_SESSION_HEURES', groupe: 'Accès', libelle: 'Durée d’une session (heures)', aide: 'Au-delà, il faut se reconnecter, même en activité.', avance: true },
  { env: 'SOCLE_INACTIVITE_MINUTES', groupe: 'Accès', libelle: 'Déconnexion après inactivité (minutes)', aide: 'Une session sans requête pendant ce temps se ferme.', avance: true },
  { env: 'SOCLE_CONTACT_SECURITE', groupe: 'Accès', libelle: 'Contact pour signaler une faille', exemple: 'mailto:securite@exemple.org',
    aide: 'Publié dans /.well-known/security.txt : une adresse https:// ou mailto: lue par quelqu’un. Vide : pas de security.txt.' },
  { env: 'SOCLE_SMTP_HOTE', groupe: 'Courriels', libelle: 'Serveur SMTP', exemple: 'smtp.exemple.org',
    aide: 'Pour envoyer les alertes de sécurité et les invitations par courriel. Vide : les alertes restent dans chaque compte.' },
  { env: 'SOCLE_SMTP_PORT', groupe: 'Courriels', libelle: 'Port SMTP', exemple: '465', aide: '465 en TLS direct, 587 en STARTTLS.' },
  { env: 'SOCLE_SMTP_SECURITE', groupe: 'Courriels', libelle: 'Chiffrement SMTP', noms: { tls: 'TLS direct', starttls: 'STARTTLS' } },
  { env: 'SOCLE_SMTP_UTILISATEUR', groupe: 'Courriels', libelle: 'Utilisateur SMTP' },
  { env: 'SOCLE_SMTP_MOTDEPASSE', groupe: 'Courriels', libelle: 'Mot de passe SMTP' },
  { env: 'SOCLE_SMTP_DE', groupe: 'Courriels', libelle: 'Adresse d’expédition', exemple: 'alertes@exemple.org' },
];

function brut(env, nom) {
  if (env[nom + '_FILE']) {
    try { return fs.readFileSync(env[nom + '_FILE'], 'utf8').trim(); } catch { return undefined; }
  }
  return env[nom];
}
const presente = (env, nom) => (env[nom] !== undefined && env[nom] !== '') || !!env[nom + '_FILE'];

function lireFichier(dossier) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dossier, FICHIER), 'utf8'));
    return { vus: d.vus && typeof d.vus === 'object' ? d.vus : {}, valeurs: d.valeurs && typeof d.valeurs === 'object' ? d.valeurs : {}, fini: d.fini === true, version: d.version || null };
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${path.join(dossier, FICHIER)} illisible : ${e.message}`);
    return { vus: {}, valeurs: {}, fini: false, version: null };
  }
}

function ecrireFichier(dossier, etat) {
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const cible = path.join(dossier, FICHIER);
  const tmp = cible + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(etat, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, cible);
}

// Le coffre du socle, construit comme demarrerSocle le construit, et seulement
// quand un secret est à lire ou à écrire.
function coffreDe(dossier, env) {
  return new Coffre({ cle: brut(env, 'SOCLE_CLE') || null, ancienne: brut(env, 'SOCLE_CLE_ANCIENNE') || null, fichier: path.join(dossier, 'cles', 'socle.key') });
}

function ouvrirValeur(coffre, nom, v) {
  if (v?.scelle) {
    try { return coffre.ouvre(USAGE, v.scelle, nom); } catch (e) {
      if (!coffre.precedente) throw new Error(`Réglage ${nom} : secret illisible avec la clé maîtresse actuelle.`);
      return coffre.precedente.ouvre(USAGE, v.scelle, nom);
    }
  }
  return typeof v?.clair === 'string' ? v.clair : undefined;
}

// À appeler en tout premier, avant de lire la configuration du service :
// renvoie l'environnement complété des valeurs posées par l'assistant (une
// variable de l'environnement réel n'est jamais remplacée). enPlace : complète
// l'objet reçu lui-même (process.env d'un service qui lit sa configuration au
// chargement de ses modules).
export function appliquerReglages({ dossier, env = process.env, enPlace = false }) {
  const reel = enPlace ? { ...env } : env;
  const etat = lireFichier(dossier);
  const cible = enPlace ? env : { ...env };
  let coffre = null;
  let rescelle = false;
  for (const [nom, v] of Object.entries(etat.valeurs)) {
    if (presente(reel, nom)) continue;
    if (v?.scelle) {
      coffre ??= coffreDe(dossier, reel);
      try { coffre.ouvre(USAGE, v.scelle, nom); } catch { rescelle = true; }
    }
    const clair = ouvrirValeur(coffre, nom, v);
    if (clair !== undefined) cible[nom] = clair;
  }
  // Après une rotation de la clé maîtresse : chaque secret repasse sous la neuve.
  if (rescelle && coffre) {
    for (const [nom, v] of Object.entries(etat.valeurs)) {
      if (v?.scelle) etat.valeurs[nom] = { scelle: coffre.scelle(USAGE, ouvrirValeur(coffre, nom, v), nom) };
    }
    ecrireFichier(dossier, etat);
  }
  ORIGINES.set(cible, { reel, dossier });
  return cible;
}

// Un environnement dérivé (variables ajoutées par le service lui-même, qui
// comptent comme posées dans l'environnement) garde le lien avec son origine.
export function etendreEnv(env, ajouts) {
  const o = ORIGINES.get(env);
  const neuf = { ...env, ...ajouts };
  if (o) ORIGINES.set(neuf, { ...o, reel: { ...o.reel, ...ajouts } });
  return neuf;
}

// Ce qui vient de l'environnement réel, pour un environnement passé par
// appliquerReglages (sinon, tout ce qu'il contient).
export function origineDe(env) { return ORIGINES.get(env) || { reel: env, dossier: null }; }

// Un secret : de type secret, ou déclaré comme tel par le service (clé au format contrôlé).
const estSecret = r => !!r && (r.spec.type === 'secret' || r.secret === true);

const defautTexte = s => s.defaut === undefined || s.defaut === null ? '' : Array.isArray(s.defaut) ? s.defaut.join(',') : String(s.defaut);

const TYPES_TEXTE = new Set(['chaine', 'url', 'liste', 'secret']);

export class Assistant {
  // liste : [{ env, libelle, aide, groupe, depuis, requis, avance, exemple, noms, secret }]
  // specs : objets de lireConfig (SPEC_SOCLE et celui du service), pour le type
  // et la validation de chaque variable. controler(env) : contrôles d'ensemble.
  constructor({ dossier, env, liste, specs, version = null, controler = null, journal = null, redemarrer = null }) {
    const { reel } = origineDe(env);
    this.dossier = dossier;
    this.reel = reel;
    this.env = env;
    this.version = version;
    this.controler = controler;
    this.journal = journal;
    this.redemarrer = redemarrer;
    this.redemarrageRequis = false;
    const parEnv = new Map();
    for (const spec of specs) for (const s of Object.values(spec)) if (s.env) parEnv.set(s.env, s);
    const vus = new Set();
    this.liste = [];
    for (const r of liste) {
      if (vus.has(r.env)) continue;
      const spec = parEnv.get(r.env);
      if (!spec) throw new Error(`Assistant : ${r.env} n’est déclaré dans aucune configuration.`);
      vus.add(r.env);
      this.liste.push({ ...r, spec });
    }
    this.specs = specs;
  }

  etat() { return (this.cache ??= lireFichier(this.dossier)); }
  duMilieu(nom) { return presente(this.reel, nom); }

  // Réglages jamais présentés (et pas posés dans l'environnement).
  enAttente(etat = this.etat()) {
    return this.liste.filter(r => !this.duMilieu(r.env) && !Object.hasOwn(etat.vus, r.env));
  }

  // L'assistant doit passer : première configuration jamais terminée, ou
  // réglages nouveaux depuis la dernière fois.
  aFaire(etat = this.etat()) {
    const attente = this.enAttente(etat);
    return { doit: !etat.fini || attente.length > 0, premiere: !etat.fini, nouveaux: attente.length };
  }

  resume() {
    const a = this.aFaire();
    return a.doit ? { ...a, redemarrage: this.redemarrageRequis } : (this.redemarrageRequis ? { doit: false, redemarrage: true } : null);
  }

  // Pour l'écran : jamais la valeur d'un secret, seulement s'il est posé.
  public() {
    const etat = this.etat();
    const attente = new Set(this.enAttente(etat).map(r => r.env));
    return {
      premiere: !etat.fini, version: this.version, redemarrage: this.redemarrageRequis,
      reglages: this.liste.map(r => {
        const s = r.spec, secret = estSecret(r);
        const source = this.duMilieu(r.env) ? 'environnement' : Object.hasOwn(etat.valeurs, r.env) ? 'assistant' : 'defaut';
        // Ce qui est enregistré, même pas encore appliqué (redémarrage à venir).
        const actuel = source === 'environnement' ? brut(this.reel, r.env) : source === 'assistant' ? etat.valeurs[r.env]?.clair : undefined;
        const valeur = secret ? undefined : (actuel ?? defautTexte(s));
        return {
          env: r.env, libelle: r.libelle, aide: r.aide || '', groupe: r.groupe || 'Réglages', depuis: r.depuis || null,
          exemple: r.exemple || '', avance: !!r.avance, requis: !!r.requis, nouveau: attente.has(r.env),
          type: secret ? 'secret' : (s.type === 'choix' ? 'choix' : s.type === 'booleen' ? 'booleen' : s.type === 'entier' ? 'entier' : TYPES_TEXTE.has(s.type) ? s.type : 'chaine'),
          ...(s.type === 'choix' ? { parmi: s.parmi.filter(v => v !== '' || !r.requis).map(v => ({ valeur: v, nom: r.noms?.[v] ?? (v === '' ? '—' : v) })) } : {}),
          ...(s.type === 'entier' ? { min: s.min ?? null, max: s.max ?? null } : {}),
          source, ...(secret ? { pose: source !== 'defaut' } : { valeur }),
        };
      }),
    };
  }

  // valeurs : { VARIABLE: texte } — un texte vide efface (retour au défaut),
  // une variable absente garde sa valeur. Toutes les variables présentées sont
  // marquées vues. Renvoie { redemarrage } quand une valeur effective change.
  poser(valeurs, { acteur = null, ip = null } = {}) {
    const etat = this.etat();
    const parEnv = new Map(this.liste.map(r => [r.env, r]));
    const erreurs = {};
    // La configuration en vigueur après ce changement : l'environnement réel,
    // plus tout ce que l'assistant garde (même pas encore appliqué).
    const candidat = { ...this.reel };
    const gardees = this.claires(etat.valeurs);
    for (const r of this.liste) {
      if (!this.duMilieu(r.env) && Object.hasOwn(etat.valeurs, r.env)) candidat[r.env] = gardees[r.env];
    }
    const nouvelles = { ...etat.valeurs };
    for (const [nom, v] of Object.entries(valeurs)) {
      const r = parEnv.get(nom);
      if (!r) { erreurs[nom] = 'Réglage inconnu.'; continue; }
      if (this.duMilieu(nom)) { erreurs[nom] = 'Fixé dans l’environnement du service : à changer là-bas.'; continue; }
      if (typeof v !== 'string' || v.length > 4000) { erreurs[nom] = 'Texte attendu.'; continue; }
      const t = r.spec.type === 'liste' ? v.split(',').map(x => x.trim()).filter(Boolean).join(',') : v.trim();
      if (t === '') {
        if (r.requis) { erreurs[nom] = 'Obligatoire.'; continue; }
        delete nouvelles[nom]; delete candidat[nom];
        continue;
      }
      try { lireConfig({ x: r.spec }, { [nom]: t }); } catch (e) { erreurs[nom] = (e.erreurs?.[0] || e.message).replace(`${nom} : `, '').replace(`${nom} `, ''); continue; }
      nouvelles[nom] = { clair: t };
      candidat[nom] = t;
    }
    for (const r of this.liste) {
      if (r.requis && !this.duMilieu(r.env) && !candidat[r.env] && defautTexte(r.spec) === '' && !erreurs[r.env]) erreurs[r.env] = 'Obligatoire.';
    }
    if (!Object.keys(erreurs).length) {
      // La configuration complète doit encore se lire, réglages croisés compris.
      try {
        for (const spec of this.specs) lireConfig(spec, candidat);
        this.controler?.(candidat);
      } catch (e) { erreurs._ = (e.erreurs || [e.message]).join(' · '); }
    }
    if (Object.keys(erreurs).length) return { ok: false, erreurs };

    let coffre = null;
    const avant = this.claires(etat.valeurs);
    for (const [nom, v] of Object.entries(nouvelles)) {
      if (v?.clair !== undefined && estSecret(parEnv.get(nom))) {
        coffre ??= coffreDe(this.dossier, this.reel);
        nouvelles[nom] = { scelle: coffre.scelle(USAGE, v.clair, nom) };
      }
    }
    const t = new Date().toISOString();
    const vus = { ...etat.vus };
    for (const r of this.liste) if (!this.duMilieu(r.env) && !Object.hasOwn(vus, r.env)) vus[r.env] = this.version || t;
    ecrireFichier(this.dossier, { v: 1, version: this.version, fini: true, vus, valeurs: nouvelles });
    this.cache = null;
    const apres = this.claires(nouvelles);
    const changes = Object.keys({ ...avant, ...apres }).filter(k => avant[k] !== apres[k]);
    this.journal?.ecrire?.({ acteur, action: 'reglages.poses', ip, details: { variables: changes, premiere: !etat.fini } });
    if (changes.length) {
      this.redemarrageRequis = true;
      if (this.redemarrer) setTimeout(() => this.redemarrer(), 300).unref?.();
    }
    return { ok: true, redemarrage: changes.length > 0, automatique: changes.length > 0 && !!this.redemarrer, changes };
  }

  // Valeurs posées par l'assistant, en clair, pour comparer avant et après.
  claires(valeurs) {
    const out = {};
    let coffre = null;
    for (const r of this.liste) {
      if (this.duMilieu(r.env)) continue;
      if (!Object.hasOwn(valeurs, r.env)) { out[r.env] = defautTexte(r.spec); continue; }
      const v = valeurs[r.env];
      if (v?.scelle) coffre ??= coffreDe(this.dossier, this.reel);
      out[r.env] = ouvrirValeur(coffre, r.env, v) ?? '';
    }
    return out;
  }
}
