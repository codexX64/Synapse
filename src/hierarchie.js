'use strict';
/* Hiérarchie des cerveaux.

   Un compte possède un arbre : des cerveaux membres (un par IA, un par
   service), groupés en domaines imbricables, chaque domaine ayant son
   cerveau commun, et un cerveau global au sommet. Une entrée est écrite
   une seule fois ; un cerveau est l'ensemble des entrées qui y sont
   présentes (placées dedans, ou remontées depuis un enfant).

   À chaque montée, le tamis du cerveau d'arrivée décide :
     - l'entrée est vue (h_vu) : c'est ce qui permet la convergence ;
     - elle monte si une étiquette la force, ou si son importance passe
       le seuil ; sinon elle reste en bas ;
     - si plusieurs enfants distincts ont vu la même clé (une IP, un VLAN,
       une VM…), le cerveau fait une fiche : commune dans un cerveau de
       domaine, de corrélation dans le global. La fiche cite ses sources
       par des liens, elle ne les copie pas.

   Tout est synchrone et en SQL : le tamis tourne dans la requête
   d'écriture, sans modèle. Une règle qui demanderait un modèle n'a pas
   sa place ici. */

const ingest = require('./ingest');

const COMMUN = '@commun';
const PRINCIPAL = '@principal';
const PROFONDEUR_MAX = 12;

const DEFAUTS = {
  membre: {},
  commun: { seuil: 70, convergence: 2, remontee: 'auto', toujours: ['decision'], jamais: ['simulation'], fenetre_jours: 90, repetition_heures: 24 },
  global: { seuil: 101, convergence: 2, remontee: 'auto', toujours: [], jamais: ['simulation'], fenetre_jours: 180, repetition_heures: 24 },
};
const REMONTEES = new Set(['auto', 'valider', 'coupee']);
const NOM_DOMAINE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;

/* Une source dont le nom dit une IA va dans le domaine IA ; le reste est
   un service. Ce n'est qu'un défaut : un envoi peut nommer son domaine,
   et un humain peut rattacher le cerveau ailleurs. */
const IA_CONNUES = /^(claude|claude-code|ollama|qwen|kimi|moonshot|openai|gpt|chatgpt|gemini|mistral|llama|deepseek|essaim|oracle|nexus|atelier|copilot|cursor)/i;

const maintenant = () => new Date().toISOString();

/* mode et comptes */

function mode(db) {
  const r = db.prepare(`SELECT v FROM meta WHERE k='hierarchie_mode'`).get();
  return r && r.v === 'plusieurs' ? 'plusieurs' : 'un';
}

/* Passer à plusieurs comptes rattache la hiérarchie existante (celle du
   mode un, « @principal ») au compte qui fait le geste : rien ne migre,
   le commun naît vide. Revenir à un seul compte ne supprime rien. */
function changerMode(db, nouveau, compteHumain) {
  if (!['un', 'plusieurs'].includes(nouveau)) throw new Error('mode inconnu');
  db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES('hierarchie_mode',?)`).run(nouveau);
  if (nouveau === 'plusieurs' && compteHumain && !principal(db))
    db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES('hierarchie_principal',?)`).run(String(compteHumain));
  return mode(db);
}
function principal(db) {
  const r = db.prepare(`SELECT v FROM meta WHERE k='hierarchie_principal'`).get();
  return r ? r.v : null;
}

/* Le compte d'un appelant. En mode un, tout va à @principal. En mode
   plusieurs : une personne a le sien (le premier admin garde @principal),
   un jeton de compte porte le compte de qui l'a créé, et un jeton de
   service sans compte écrit au commun — c'est l'infrastructure partagée. */
function compteDe(db, src) {
  if (!src) return null;
  if (mode(db) === 'un') return PRINCIPAL;
  if (src.humain) return String(src.compte) === principal(db) ? PRINCIPAL : String(src.compte);
  if (src.compte) return String(src.compte);
  return COMMUN;
}

/* arbre */

const cerveau = (db, id) => db.prepare(`SELECT * FROM h_cerveaux WHERE id=?`).get(id) || null;
const domaine = (db, id) => db.prepare(`SELECT * FROM h_domaines WHERE id=?`).get(id) || null;

function globalDe(db, compte) {
  let g = db.prepare(`SELECT * FROM h_cerveaux WHERE compte=? AND genre='global'`).get(compte);
  if (!g) {
    db.prepare(`INSERT OR IGNORE INTO h_cerveaux(compte,domaine_id,genre,nom,membre,reglages,cree) VALUES(?,NULL,'global','Global',NULL,'{}',?)`)
      .run(compte, maintenant());
    g = db.prepare(`SELECT * FROM h_cerveaux WHERE compte=? AND genre='global'`).get(compte);
    for (const d of ['IA', 'HomeLab']) domaineChemin(db, compte, d);
  }
  return g;
}

/* « Connaissance/Réseau » crée Connaissance puis Réseau dessous, chacun
   avec son cerveau commun. Idempotent. */
function domaineChemin(db, compte, chemin) {
  const parts = String(chemin || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > 6 || !parts.every(p => NOM_DOMAINE.test(p))) return null;
  let parent = null, d = null;
  for (const nom of parts) {
    d = db.prepare(`SELECT * FROM h_domaines WHERE compte=? AND COALESCE(parent_id,0)=? AND nom=?`).get(compte, parent || 0, nom);
    if (!d) {
      const r = db.prepare(`INSERT INTO h_domaines(compte,parent_id,nom,cree) VALUES(?,?,?,?)`).run(compte, parent, nom, maintenant());
      d = domaine(db, Number(r.lastInsertRowid));
      db.prepare(`INSERT INTO h_cerveaux(compte,domaine_id,genre,nom,membre,reglages,cree) VALUES(?,?,'commun',?,NULL,'{}',?)`)
        .run(compte, d.id, 'Commun ' + nom, maintenant());
    }
    parent = d.id;
  }
  return d;
}

const communDe = (db, domaineId) => db.prepare(`SELECT * FROM h_cerveaux WHERE domaine_id=? AND genre='commun'`).get(domaineId);

function cerveauMembre(db, compte, membre, chemin) {
  globalDe(db, compte);
  const deja = db.prepare(`SELECT * FROM h_cerveaux WHERE compte=? AND genre='membre' AND membre=?`).get(compte, membre);
  if (deja) return deja;
  const d = domaineChemin(db, compte, chemin) || domaineChemin(db, compte, 'HomeLab');
  const r = db.prepare(`INSERT INTO h_cerveaux(compte,domaine_id,genre,nom,membre,reglages,cree) VALUES(?,?,'membre',?,?,'{}',?)`)
    .run(compte, d.id, membre, membre, maintenant());
  return cerveau(db, Number(r.lastInsertRowid));
}

function parentDe(db, c) {
  if (!c || c.genre === 'global') return null;
  if (c.genre === 'membre') return communDe(db, c.domaine_id) || null;
  const d = domaine(db, c.domaine_id);
  if (d && d.parent_id) return communDe(db, d.parent_id) || null;
  return globalDe(db, c.compte);
}

/* Les cerveaux du dessus, du parent direct au global. */
function ascendants(db, c) {
  const out = [];
  for (let p = parentDe(db, c), i = 0; p && i < PROFONDEUR_MAX; p = parentDe(db, p), i++) out.push(p);
  return out;
}

function reglages(c) {
  let r = {};
  try { r = JSON.parse(c.reglages || '{}'); } catch { /* réglages illisibles : on retombe sur les défauts */ }
  return { ...DEFAUTS[c.genre], ...r };
}

/* Ce qu'un humain peut régler : bornes contrôlées ici, pas seulement par
   le schéma de la route, parce que la reprise et les essais écrivent aussi. */
function regler(db, id, demande) {
  const c = cerveau(db, id);
  if (!c) return null;
  const r = reglages(c), o = {};
  if (demande.seuil !== undefined) o.seuil = Math.max(0, Math.min(101, Math.round(Number(demande.seuil))));
  if (demande.convergence !== undefined) o.convergence = Math.max(2, Math.min(20, Math.round(Number(demande.convergence))));
  if (demande.repetition_heures !== undefined) o.repetition_heures = Math.max(0, Math.min(720, Math.round(Number(demande.repetition_heures))));
  if (demande.fenetre_jours !== undefined) o.fenetre_jours = Math.max(1, Math.min(3650, Math.round(Number(demande.fenetre_jours))));
  if (demande.remontee !== undefined) {
    if (!REMONTEES.has(demande.remontee)) throw new Error('remontée : auto, valider ou coupee');
    o.remontee = demande.remontee;
  }
  for (const k of ['toujours', 'jamais']) if (Array.isArray(demande[k])) o[k] = demande[k].map(etiquette).filter(Boolean).slice(0, 30);
  const propres = { ...JSON.parse(c.reglages || '{}'), ...o };
  db.prepare(`UPDATE h_cerveaux SET reglages=? WHERE id=?`).run(JSON.stringify(propres), id);
  return { ...r, ...o };
}

/* étiquettes */

const etiquette = t => String(t || '').toLowerCase().trim().replace(/\s+/g, '-').slice(0, 60);
const slug = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* Les clés sont les entités qu'on sait reconnaître sans modèle. Elles
   servent à la convergence : deux entrées qui partagent une clé parlent
   de la même chose. Les étiquettes libres n'en sont pas — « alerte » ou
   « note » relieraient tout à tout. */
function cles(e, entites) {
  const out = new Set();
  const texte = [e.title, String(e.body || '').slice(0, 4000)].join('\n');
  for (const m of texte.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g))
    if (m[1].split('.').every(o => Number(o) <= 255)) out.add('ip:' + m[1]);
  for (const m of texte.matchAll(/\bvlan\s*[-#:]?\s*(\d{1,4})\b/gi)) out.add('vlan:' + Number(m[1]));
  for (const m of texte.matchAll(/\b(?:vm|vmid|ct|lxc)\s*[-#:]?\s*(\d{2,6})\b/gi)) out.add('vm:' + Number(m[1]));
  for (const m of texte.matchAll(/\bport\s*[:#]?\s*(\d{2,5})\b/gi)) if (Number(m[1]) <= 65535) out.add('port:' + Number(m[1]));
  let meta = {};
  try { meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : (e.meta || {}); } catch { /* méta illisible : pas de clé à en tirer */ }
  if (meta.host) out.add('hote:' + slug(meta.host));
  if (meta.service) out.add('service:' + slug(meta.service));
  if (e.ref && !String(e.ref).startsWith('fiche:')) out.add('ref:' + slug(e.ref));
  for (const x of (Array.isArray(entites) ? entites : [])) { const s = slug(x); if (s) out.add(s.includes(':') ? s : 'e:' + s); }
  return [...out].filter(k => k.length > 3).slice(0, 12);
}

/* La gravité dite par la source (vigie écrit meta.gravite, d'autres
   meta.severity) prime sur le genre. Une étiquette de domaine comme
   « securite » ne dit rien de l'importance : chez vigie, elle est sur
   tout. */
const GRAVITES = { critique: 90, critical: 90, eleve: 70, 'élevé': 70, high: 70, error: 70,
  moyen: 50, moyenne: 50, medium: 50, warning: 50, faible: 30, low: 30, info: 15, debug: 5 };

function importanceDe(e, demandee) {
  if (Number.isFinite(Number(demandee)) && demandee !== null && demandee !== undefined && demandee !== '')
    return Math.max(0, Math.min(100, Math.round(Number(demandee))));
  const k = String(e.kind || ''), tags = ' ' + (e.tags || '') + ' ';
  let meta = {};
  try { meta = typeof e.meta === 'string' ? JSON.parse(e.meta) : (e.meta || {}); } catch { /* méta illisible : pas de gravité */ }
  const grav = GRAVITES[String(meta.gravite || meta.severity || '').toLowerCase()];
  let n = grav ?? ({ L3: 70, L2: 55, L1: 50, L0: 20 }[e.level] ?? 20);
  if (/^decision\./.test(k)) n = Math.max(n, 80);
  if (/^incident\./.test(k) && grav === undefined) n = Math.max(n, 60);
  if (tags.includes(' simulation ')) n = Math.min(n, 5);
  return n;
}

/* Le motif d'une entrée : son genre et son titre, adresses, nombres et
   identifiants neutralisés. « Menace non bloquée : 87.120.84.129 (score
   239) » et « … 87.120.84.248 (score 241) » ont le même motif. */
const crypto = require('node:crypto');
function motifDe(e) {
  const t = String(e.title || '').toLowerCase()
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
  return crypto.createHash('sha1').update(String(e.kind) + '\u001f' + t).digest('hex').slice(0, 20);
}

/* placement et tamis */

const entree = (db, id) => db.prepare(`SELECT id, source, kind, level, title, body, tags, meta, ref, ns, occurred_at FROM entries WHERE id=?`).get(id);

/* Le Hub relaie sous son nom les alertes des autres services (« Alerte
   eleve : <titre> »). Un relais n'est pas une seconde source : le même
   fait vu deux fois ferait une fausse convergence. Une alerte du Hub qui
   reprend mot pour mot le titre d'une entrée d'un autre service, à dix
   minutes près, est rangée chez ce service. */
function origineRelayee(db, e) {
  const m = /^alerte\s+\S+\s*:\s*(.+)$/i.exec(String(e.title || ''));
  const titre = (m ? m[1] : String(e.title || '')).trim();
  if (!titre) return null;
  const t = Date.parse(e.occurred_at);
  const de = new Date(t - 600000).toISOString(), a = new Date(t + 600000).toISOString();
  const r = db.prepare(`SELECT source FROM entries WHERE ns = ? AND occurred_at BETWEEN ? AND ? AND source != ? AND title = ? LIMIT 1`)
    .get(e.ns, de, a, e.source, titre);
  return r ? r.source : null;
}

function placer(db, id, c, importance, lesCles) {
  db.prepare(`INSERT OR IGNORE INTO h_place(entry_id,cerveau_id,importance,place) VALUES(?,?,?,?)`).run(id, c.id, importance, maintenant());
  const ins = db.prepare(`INSERT OR IGNORE INTO h_cles(entry_id,cle) VALUES(?,?)`);
  for (const k of lesCles) ins.run(id, k);
}

/**
 * Range une entrée qui vient d'être écrite : cerveau membre, étiquettes,
 * puis tamis de chaque niveau. `membre` est le nom de l'IA ou du service
 * (par défaut la source), `domaine` un chemin (« Connaissance/Réseau »).
 */
function classer(db, id, { src, membre, domaine: chemin, importance, entites } = {}) {
  if (db.prepare(`SELECT 1 FROM h_place WHERE entry_id=?`).get(id)) return null;
  const e = entree(db, id);
  if (!e || String(e.kind).startsWith('fiche.')) return null;
  const compte = compteDe(db, src) || PRINCIPAL;
  const relais = !membre && src && src.name === 'hub' && /^alert/.test(String(e.kind)) ? origineRelayee(db, e) : null;
  const nom = String(relais || (membre && membre !== 'inconnu' ? membre : (src && src.name) || 'inconnu')).slice(0, 80);
  const dom = chemin || (IA_CONNUES.test(nom) || e.kind === 'echange' ? 'IA' : 'HomeLab');
  const c = cerveauMembre(db, compte, nom, dom);
  const imp = importanceDe(e, importance), k = cles(e, entites);
  const journal = [];
  db.exec('SAVEPOINT classer');
  try {
    placer(db, id, c, imp, k);
    arrivee(db, id, c, 0, journal);
    db.exec('RELEASE classer');
  } catch (err) {
    db.exec('ROLLBACK TO classer'); db.exec('RELEASE classer');
    throw err;
  }
  return { cerveau: c.id, compte, importance: imp, cles: k, remontees: journal };
}

/* L'entrée est désormais présente dans c : on la verse au commun si le
   compte l'a demandé, puis on la présente au niveau du dessus. */
function arrivee(db, id, c, prof, journal) {
  if (prof > PROFONDEUR_MAX) return;
  verser(db, id, c, prof, journal);
  presenter(db, id, c, prof, journal);
}

/* Le cerveau c voit passer l'entrée depuis son enfant origine. */
function voir(db, id, c, origine) {
  const ins = db.prepare(`INSERT OR IGNORE INTO h_vu(entry_id,cerveau_id,origine,vu) VALUES(?,?,?,?)`).run(id, c.id, origine.id, maintenant());
  if (!Number(ins.changes)) return;
  const quand = (db.prepare(`SELECT occurred_at FROM entries WHERE id=?`).get(id) || {}).occurred_at || maintenant();
  const up = db.prepare(`INSERT INTO h_convergence(cerveau_id,cle,origine,dernier) VALUES(?,?,?,?)
    ON CONFLICT(cerveau_id,cle,origine) DO UPDATE SET dernier = max(dernier, excluded.dernier)`);
  for (const { cle } of db.prepare(`SELECT cle FROM h_cles WHERE entry_id=?`).all(id)) up.run(c.id, cle, origine.id, quand);
}

function presenter(db, id, de, prof, journal) {
  const vers = parentDe(db, de);
  if (!vers) return;
  voir(db, id, vers, de);
  const r = reglages(vers);
  const p = db.prepare(`SELECT importance FROM h_place WHERE entry_id=?`).get(id) || { importance: 0 };
  const e = entree(db, id);
  const tags = new Set(String(e.tags || '').split(/\s+/).filter(Boolean));
  const a = l => (l || []).some(t => tags.has(t));
  if (r.remontee !== 'coupee' && !a(r.jamais)) {
    const regle = a(r.toujours) ? 'etiquette' : p.importance >= r.seuil ? 'importance' : null;
    if (regle && repetee(db, e, vers, r)) journal.push({ entree: id, de: de.id, vers: vers.id, regle: 'repetition', statut: 'comptee' });
    else if (regle) {
      const statut = r.remontee === 'valider' ? 'a_valider' : 'faite';
      const ins = db.prepare(`INSERT OR IGNORE INTO h_remontees(entry_id,de_cerveau,vers_cerveau,regle,statut,quand) VALUES(?,?,?,?,?,?)`)
        .run(id, de.id, vers.id, regle, statut, maintenant());
      if (Number(ins.changes)) {
        journal.push({ entree: id, de: de.id, vers: vers.id, regle, statut });
        if (statut === 'faite') arrivee(db, id, vers, prof + 1, journal);
      }
    }
  }
  converger(db, vers, id, r, prof, journal);
}

/* Un motif déjà monté dans ce cerveau depuis moins de repetition_heures
   ne remonte pas : il est compté sur l'entrée qui le représente. La
   période se lit sur la date du fait, pas sur l'horloge : une reprise
   d'un mois d'historique compte comme le mois s'est passé. */
function repetee(db, e, vers, r) {
  if (!r.repetition_heures) return false;
  const m = motifDe(e);
  const quand = e.occurred_at;
  const deja = db.prepare(`SELECT representant, dernier FROM h_motifs WHERE cerveau_id=? AND motif=?`).get(vers.id, m);
  const fenetre = r.repetition_heures * 3600000;
  if (deja && Math.abs(Date.parse(quand) - Date.parse(deja.dernier)) < fenetre) {
    db.prepare(`UPDATE h_motifs SET n = n + 1, dernier = max(dernier, ?) WHERE cerveau_id=? AND motif=?`).run(quand, vers.id, m);
    return true;
  }
  db.prepare(`INSERT INTO h_motifs(cerveau_id,motif,representant,n,dernier) VALUES(?,?,?,1,?)
    ON CONFLICT(cerveau_id,motif) DO UPDATE SET representant=excluded.representant, n=1, dernier=excluded.dernier`).run(vers.id, m, e.id, quand);
  return false;
}

/* Versement au commun : une entrée arrivée dans le commun d'un domaine
   racine d'un compte personnel, si ce compte verse ce domaine, entre
   dans le domaine du même nom du compte commun. */
function verser(db, id, c, prof, journal) {
  if (c.genre !== 'commun' || c.compte === COMMUN || mode(db) !== 'plusieurs') return;
  const d = domaine(db, c.domaine_id);
  if (!d || d.parent_id) return;
  if (!db.prepare(`SELECT 1 FROM h_versements WHERE compte=? AND domaine_id=?`).get(c.compte, d.id)) return;
  globalDe(db, COMMUN);
  const cible = communDe(db, domaineChemin(db, COMMUN, d.nom).id);
  voir(db, id, cible, c);
  const ins = db.prepare(`INSERT OR IGNORE INTO h_remontees(entry_id,de_cerveau,vers_cerveau,regle,statut,quand) VALUES(?,?,?,'versement','faite',?)`)
    .run(id, c.id, cible.id, maintenant());
  if (!Number(ins.changes)) return;
  journal.push({ entree: id, de: c.id, vers: cible.id, regle: 'versement', statut: 'faite' });
  presenter(db, id, cible, prof + 1, journal);
  converger(db, cible, id, reglages(cible), prof, journal);
}

/* convergence et fiches */

/* La convergence part de l'index des clés : une clé ne touche qu'une
   poignée d'entrées, un cerveau commun peut en voir des centaines de
   milliers. Partir du cerveau rendrait chaque écriture proportionnelle à
   sa taille. */
const VUS_PAR_CLE = `FROM h_cles k INDEXED BY idx_h_cles_cle
  JOIN h_vu v ON v.entry_id = k.entry_id AND v.cerveau_id = ?
  JOIN entries e ON e.id = k.entry_id
  WHERE k.cle = ? AND e.archived = 0 AND e.occurred_at >= ?`;
const LIGNES_MAX = 60;

function converger(db, c, id, r, prof, journal) {
  const depuis = new Date(Date.now() - r.fenetre_jours * 86400000).toISOString();
  const lesCles = db.prepare(`SELECT cle FROM h_cles WHERE entry_id=?`).all(id).map(x => x.cle);
  const kind = c.genre === 'global' ? 'fiche.correlation' : 'fiche.commune';
  for (const k of lesCles) {
    const existe = db.prepare(`SELECT 1 FROM entries WHERE ref=? AND kind=?`).get(`fiche:${c.id}:${k}`, kind);
    if (!existe && db.prepare(`SELECT count(*) n FROM h_convergence WHERE cerveau_id=? AND cle=? AND dernier>=?`).get(c.id, k, depuis).n < r.convergence) continue;
    fiche(db, c, k, id, depuis, prof, journal);
  }
}

const ligneDe = (db, entryId, origine) => {
  const e = db.prepare(`SELECT title FROM entries WHERE id=?`).get(entryId);
  const o = db.prepare(`SELECT nom FROM h_cerveaux WHERE id=?`).get(origine);
  return `- ${o ? o.nom : '?'} : ${e ? e.title : '?'} (#${entryId})`;
};

/* Le texte s'allonge, le plein texte suit par ses déclencheurs. Les
   morceaux vectorisés ne sont pas refaits : la fiche parle toujours de la
   même clé, et la revectoriser à chaque ligne coûterait un appel au
   modèle par écriture. */
function reecrire(db, f, ns, kind, ref, titre, corps) {
  db.prepare(`UPDATE entries SET body=?, hash=? WHERE id=?`)
    .run(corps, ingest.hashOf({ ns, source: '@tamis', kind, ref, title: titre, body: corps }), f.id);
}

/* Une fiche cite au plus LIENS_PAR_ORIGINE exemples par origine, les plus
   récents à sa naissance, puis les suivants jusqu'au plafond ; elle compte
   toutes les mentions. Une clé vue des milliers de fois donne une fiche
   lisible, pas une liste de milliers de liens. */
const LIENS_PAR_ORIGINE = 10;

function entete(globale, k, mentions, origines) {
  return `${globale ? 'Plusieurs domaines' : 'Plusieurs sources'} parlent de ${k} : ${mentions} mention(s), ${origines} origine(s).`;
}

function fiche(db, c, k, id, depuis, prof, journal) {
  const globale = c.genre === 'global';
  const kind = globale ? 'fiche.correlation' : 'fiche.commune';
  const relation = globale ? 'correle' : 'consolide';
  const ref = `fiche:${c.id}:${k}`;
  const titre = `${globale ? 'Corrélation' : 'Fiche commune'} · ${k}`;
  const ns = 'h:' + c.compte;
  const origines = () => db.prepare(`SELECT count(*) n FROM h_convergence WHERE cerveau_id=? AND cle=?`).get(c.id, k).n;
  const f = db.prepare(`SELECT id, body FROM entries WHERE ref=? AND kind=?`).get(ref, kind);
  if (f) {
    if (f.id === id) return;
    const v = db.prepare(`SELECT origine FROM h_vu WHERE entry_id=? AND cerveau_id=?`).get(id, c.id);
    if (!v || db.prepare(`SELECT 1 FROM links WHERE from_id=? AND to_id=? AND relation=?`).get(f.id, id, relation)) return;
    db.prepare(`INSERT INTO h_fiches(fiche_id,mentions) VALUES(?,1) ON CONFLICT(fiche_id) DO UPDATE SET mentions = mentions + 1`).run(f.id);
    const mentions = db.prepare(`SELECT mentions FROM h_fiches WHERE fiche_id=?`).get(f.id).mentions;
    const cites = db.prepare(`SELECT count(*) n FROM links l JOIN h_vu w ON w.entry_id = l.to_id AND w.cerveau_id = ?
                              WHERE l.from_id = ? AND l.relation = ? AND w.origine = ?`).get(c.id, f.id, relation, v.origine).n;
    let lignes = f.body.split('\n').slice(1);
    if (cites < LIENS_PAR_ORIGINE) {
      ingest.link(db, f.id, id, relation, '@tamis');
      if (lignes.filter(l => l.startsWith('- ')).length < LIGNES_MAX) lignes = [...lignes, ligneDe(db, id, v.origine)];
    }
    reecrire(db, f, ns, kind, ref, titre, [entete(globale, k, mentions, origines()), ...lignes].join('\n'));
    return;
  }
  const mentions = db.prepare(`SELECT count(*) n ${VUS_PAR_CLE}`).get(c.id, k, depuis).n;
  const vus = db.prepare(`SELECT entry_id, origine FROM (
      SELECT v.entry_id, v.origine, row_number() OVER (PARTITION BY v.origine ORDER BY v.entry_id DESC) rang ${VUS_PAR_CLE})
    WHERE rang <= ${LIENS_PAR_ORIGINE} ORDER BY entry_id`).all(c.id, k, depuis);
  const corps = [entete(globale, k, mentions, origines()), '', ...vus.slice(-LIGNES_MAX).map(v => ligneDe(db, v.entry_id, v.origine))].join('\n');
  const r = ingest.insert(db, { ns, kind, ref, title: titre, body: corps, level: 'L2', tags: ['fiche'] }, '@tamis');
  if (!r.ok || r.duplicate) return;
  db.prepare(`INSERT OR REPLACE INTO h_fiches(fiche_id,mentions) VALUES(?,?)`).run(r.id, mentions);
  const imp = Math.min(100, 10 + Math.max(0, ...vus.map(v =>
    (db.prepare(`SELECT importance FROM h_place WHERE entry_id=?`).get(v.entry_id) || { importance: 0 }).importance)));
  db.prepare(`INSERT OR IGNORE INTO h_place(entry_id,cerveau_id,importance,place) VALUES(?,?,?,?)`).run(r.id, c.id, imp, maintenant());
  db.prepare(`INSERT OR IGNORE INTO h_cles(entry_id,cle) VALUES(?,?)`).run(r.id, k);
  for (const v of vus) ingest.link(db, r.id, v.entry_id, relation, '@tamis');
  journal.push({ fiche: r.id, cerveau: c.id, cle: k, genre: kind });
  arrivee(db, r.id, c, prof + 1, journal);
}

/* validation humaine d'une remontée en attente */
function valider(db, idRemontee, accepter) {
  const r = db.prepare(`SELECT * FROM h_remontees WHERE id=?`).get(idRemontee);
  if (!r || r.statut !== 'a_valider') return null;
  db.prepare(`UPDATE h_remontees SET statut=?, quand=? WHERE id=?`).run(accepter ? 'faite' : 'refusee', maintenant(), r.id);
  const journal = [];
  if (accepter) arrivee(db, r.entry_id, cerveau(db, r.vers_cerveau), 0, journal);
  return { id: r.id, statut: accepter ? 'faite' : 'refusee', remontees: journal };
}

/* accès
   Une personne lit tout son arbre ; en mode plusieurs, le compte commun
   aussi. Une IA ou un service lit son propre cerveau, et seulement les
   fiches des cerveaux au-dessus : la fiche isole, cite, et évite qu'une
   IA reprenne telle quelle l'erreur d'une autre. Dans un projet ouvert,
   les membres lisent les entrées étiquetées du projet chez les autres. */
function acces(db, src, c, agent) {
  if (!src || !c) return null;
  if (!src.humain && src.scope === 'admin') return { tout: true };
  const compte = compteDe(db, src);
  if (src.humain) {
    if (c.compte === compte) return { tout: true };
    if (c.compte === COMMUN && mode(db) === 'plusieurs') return { tout: true };
    return null;
  }
  if (c.compte !== compte) return null;
  const nom = agent || src.name;
  const moi = db.prepare(`SELECT * FROM h_cerveaux WHERE compte=? AND genre='membre' AND membre=?`).get(compte, nom);
  if (!moi) return null;
  if (moi.id === c.id) return { tout: true };
  if (ascendants(db, moi).some(a => a.id === c.id)) return { fiches: true };
  const projets = db.prepare(`
    SELECT p.nom FROM h_projets p
    JOIN h_projet_membres a ON a.projet_id = p.id AND a.cerveau_id = ?
    JOIN h_projet_membres b ON b.projet_id = p.id AND b.cerveau_id = ?
    WHERE p.clos IS NULL`).all(moi.id, c.id).map(p => 'projet:' + slug(p.nom));
  return projets.length ? { projets } : null;
}

/* Les entrées présentes dans un cerveau, filtrées par l'accès. */
function presentes(c, a) {
  const filtre = a.tout ? '1=1'
    : a.fiches ? `e.kind LIKE 'fiche.%'`
    : '(' + a.projets.map(() => `(' ' || e.tags || ' ') LIKE ?`).join(' OR ') + ')';
  const args = a.projets ? a.projets.map(p => `% ${p} %`) : [];
  return {
    sql: `e.archived = 0 AND e.id IN (SELECT entry_id FROM h_place WHERE cerveau_id = ${Number(c.id)}
          UNION SELECT entry_id FROM h_remontees WHERE vers_cerveau = ${Number(c.id)} AND statut = 'faite') AND ${filtre}`,
    args,
  };
}

const ftsQuery = q => String(q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter(t => t.length > 1).slice(0, 12).map(t => '"' + t + '"*').join(' OR ');

/**
 * Cherche dans un cerveau ; sans résultat et si `monter`, recommence au
 * niveau du dessus, jusqu'au global. Chaque réponse dit d'où elle vient.
 */
function chercher(db, src, { cerveau: id, q, agent, monter = true, limit = 20 }) {
  let c = cerveau(db, id);
  if (!c) return { erreur: 404 };
  const chemin = [];
  const fq = ftsQuery(q);
  for (let i = 0; c && i < PROFONDEUR_MAX; c = monter ? parentDe(db, c) : null, i++) {
    const a = acces(db, src, c, agent);
    if (!a) { if (!chemin.length) return { erreur: 403 }; break; }
    chemin.push(c.id);
    const p = presentes(c, a);
    const hits = fq
      ? db.prepare(`SELECT e.id, e.kind, e.title, e.source, e.occurred_at, bm25(fts) s FROM fts JOIN entries e ON e.id = fts.rowid
                    WHERE fts MATCH ? AND ${p.sql} ORDER BY s LIMIT ?`).all(fq, ...p.args, limit)
      : db.prepare(`SELECT e.id, e.kind, e.title, e.source, e.occurred_at FROM entries e WHERE ${p.sql} ORDER BY e.occurred_at DESC LIMIT ?`).all(...p.args, limit);
    if (hits.length) return { cerveau: c.id, nom: c.nom, genre: c.genre, chemin, hits: hits.map(({ s, ...h }) => ({ ...h, cerveau: c.id })) };
  }
  return { cerveau: null, chemin, hits: [] };
}

/* vue de l'arbre, sans contenu */
function arbre(db, compte) {
  const g = globalDe(db, compte);
  const n = id => db.prepare(`SELECT (SELECT count(*) FROM h_place WHERE cerveau_id=?) + (SELECT count(*) FROM h_remontees WHERE vers_cerveau=? AND statut='faite') n`).get(id, id).n;
  const doms = db.prepare(`SELECT * FROM h_domaines WHERE compte=? ORDER BY id`).all(compte);
  const verses = new Set(db.prepare(`SELECT domaine_id FROM h_versements WHERE compte=?`).all(compte).map(x => x.domaine_id));
  return {
    compte, global: { id: g.id, n: n(g.id), reglages: reglages(g) },
    domaines: doms.map(d => {
      const c = communDe(db, d.id);
      return {
        id: d.id, nom: d.nom, parent_id: d.parent_id, verse: verses.has(d.id),
        commun: { id: c.id, n: n(c.id), reglages: reglages(c) },
        membres: db.prepare(`SELECT id, nom, membre FROM h_cerveaux WHERE domaine_id=? AND genre='membre' ORDER BY nom`).all(d.id)
          .map(m => ({ ...m, n: n(m.id) })),
      };
    }),
  };
}

/* Rattacher un cerveau membre à un autre domaine du même compte. Ce qui
   est déjà monté reste où c'est monté ; la suite suit le nouveau chemin. */
function rattacher(db, idCerveau, idDomaine) {
  const c = cerveau(db, idCerveau), d = domaine(db, idDomaine);
  if (!c || !d || c.genre !== 'membre' || c.compte !== d.compte) return null;
  db.prepare(`UPDATE h_cerveaux SET domaine_id=? WHERE id=?`).run(d.id, c.id);
  return cerveau(db, c.id);
}

function creerProjet(db, compte, nom, membres) {
  const ids = [...new Set(membres.map(Number))];
  const ok = ids.length >= 2 && ids.every(i => { const c = cerveau(db, i); return c && c.genre === 'membre' && c.compte === compte; });
  if (!ok) return null;
  const r = db.prepare(`INSERT INTO h_projets(compte,nom,ouvert,clos) VALUES(?,?,?,NULL)`).run(compte, nom, maintenant());
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO h_projet_membres(projet_id,cerveau_id) VALUES(?,?)`);
  for (const i of ids) ins.run(id, i);
  return { id, nom, etiquette: 'projet:' + slug(nom), membres: ids };
}

/* Reprise : les entrées d'avant la hiérarchie sont rangées une fois,
   comme si leur source venait de les écrire. Par lots, derrière un
   curseur gardé en base : un redémarrage reprend où on s'était arrêté, et
   chaque lot ne relit pas ce qui est déjà rangé. */
function reprendre(db, { lot = 500, max = Infinity } = {}) {
  let total = 0;
  const lire = () => Number((db.prepare(`SELECT v FROM meta WHERE k='hierarchie_reprise'`).get() || { v: 0 }).v);
  while (total < max) {
    const depuis = lire();
    const ids = db.prepare(`SELECT id, source, kind, meta, ns FROM entries WHERE id > ? ORDER BY id LIMIT ?`).all(depuis, lot);
    if (!ids.length) break;
    db.exec('BEGIN');
    try {
      for (const e of ids) {
        if (String(e.kind).startsWith('fiche.') || String(e.ns).startsWith('h:')) continue;
        let agent = null;
        try { agent = JSON.parse(e.meta || '{}').agent || null; } catch { /* méta illisible : la source sert de membre */ }
        if (classer(db, e.id, { src: { name: e.source }, membre: e.kind === 'echange' && agent && agent !== 'inconnu' ? agent : undefined })) total++;
      }
      db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES('hierarchie_reprise',?)`).run(String(ids.at(-1).id));
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (ids.length < lot) break;
  }
  return total;
}

/* Ce qui reste à ranger, pour le dire au journal et à /healthz. */
function resteAReprendre(db) {
  const depuis = Number((db.prepare(`SELECT v FROM meta WHERE k='hierarchie_reprise'`).get() || { v: 0 }).v);
  return db.prepare(`SELECT count(*) n FROM entries WHERE id > ?`).get(depuis).n;
}

module.exports = {
  COMMUN, PRINCIPAL, DEFAUTS, mode, changerMode, principal, compteDe, globalDe, domaineChemin, cerveauMembre,
  cerveau, parentDe, ascendants, reglages, regler, cles, importanceDe, motifDe, classer, valider, acces, chercher,
  arbre, rattacher, creerProjet, reprendre, resteAReprendre, slug,
};
