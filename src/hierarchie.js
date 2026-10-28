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
  commun: { seuil: 70, convergence: 2, remontee: 'auto', toujours: ['securite', 'decision'], jamais: ['simulation'], fenetre_jours: 90 },
  global: { seuil: 101, convergence: 2, remontee: 'auto', toujours: [], jamais: ['simulation'], fenetre_jours: 180 },
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

function importanceDe(e, demandee) {
  if (Number.isFinite(Number(demandee)) && demandee !== null && demandee !== undefined && demandee !== '')
    return Math.max(0, Math.min(100, Math.round(Number(demandee))));
  const k = String(e.kind || ''), tags = ' ' + (e.tags || '') + ' ';
  let n = { L3: 70, L2: 55, L1: 50, L0: 20 }[e.level] ?? 20;
  if (/^decision\./.test(k)) n = Math.max(n, 80);
  if (/^incident\./.test(k)) n = Math.max(n, 60);
  if (tags.includes(' securite ')) n = Math.max(n, 90);
  if (tags.includes(' simulation ')) n = Math.min(n, 5);
  return n;
}

/* placement et tamis */

const entree = (db, id) => db.prepare(`SELECT id, kind, level, title, body, tags, meta, ref, ns, occurred_at FROM entries WHERE id=?`).get(id);

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
  const nom = String(membre || (src && src.name) || 'inconnu').slice(0, 80);
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

function presenter(db, id, de, prof, journal) {
  const vers = parentDe(db, de);
  if (!vers) return;
  db.prepare(`INSERT OR IGNORE INTO h_vu(entry_id,cerveau_id,origine,vu) VALUES(?,?,?,?)`).run(id, vers.id, de.id, maintenant());
  const r = reglages(vers);
  const p = db.prepare(`SELECT importance FROM h_place WHERE entry_id=?`).get(id) || { importance: 0 };
  const e = entree(db, id);
  const tags = new Set(String(e.tags || '').split(/\s+/).filter(Boolean));
  const a = l => (l || []).some(t => tags.has(t));
  if (r.remontee !== 'coupee' && !a(r.jamais)) {
    const regle = a(r.toujours) ? 'etiquette' : p.importance >= r.seuil ? 'importance' : null;
    if (regle) {
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
  db.prepare(`INSERT OR IGNORE INTO h_vu(entry_id,cerveau_id,origine,vu) VALUES(?,?,?,?)`).run(id, cible.id, c.id, maintenant());
  const ins = db.prepare(`INSERT OR IGNORE INTO h_remontees(entry_id,de_cerveau,vers_cerveau,regle,statut,quand) VALUES(?,?,?,'versement','faite',?)`)
    .run(id, c.id, cible.id, maintenant());
  if (!Number(ins.changes)) return;
  journal.push({ entree: id, de: c.id, vers: cible.id, regle: 'versement', statut: 'faite' });
  presenter(db, id, cible, prof + 1, journal);
  converger(db, cible, id, reglages(cible), prof, journal);
}

/* convergence et fiches */

function converger(db, c, id, r, prof, journal) {
  const depuis = new Date(Date.now() - r.fenetre_jours * 86400000).toISOString();
  const lesCles = db.prepare(`SELECT cle FROM h_cles WHERE entry_id=?`).all(id).map(x => x.cle);
  for (const k of lesCles) {
    const vus = db.prepare(`
      SELECT v.entry_id, v.origine FROM h_vu v
      JOIN h_cles k ON k.entry_id = v.entry_id AND k.cle = ?
      JOIN entries e ON e.id = v.entry_id
      WHERE v.cerveau_id = ? AND e.archived = 0 AND e.occurred_at >= ?
      ORDER BY v.entry_id LIMIT 200`).all(k, c.id, depuis);
    if (new Set(vus.map(v => v.origine)).size >= r.convergence) fiche(db, c, k, vus, prof, journal);
  }
}

function fiche(db, c, k, vus, prof, journal) {
  const globale = c.genre === 'global';
  const kind = globale ? 'fiche.correlation' : 'fiche.commune';
  const relation = globale ? 'correle' : 'consolide';
  const ref = `fiche:${c.id}:${k}`;
  const nomDe = id => (cerveau(db, id) || {}).nom || '?';
  const lignes = vus.map(v => {
    const e = db.prepare(`SELECT title FROM entries WHERE id=?`).get(v.entry_id);
    return `- ${nomDe(v.origine)} : ${e ? e.title : '?'} (#${v.entry_id})`;
  });
  const titre = `${globale ? 'Corrélation' : 'Fiche commune'} · ${k}`;
  const corps = `${globale ? 'Plusieurs domaines' : 'Plusieurs sources'} parlent de ${k}.\n\n` + lignes.join('\n');
  const ns = 'h:' + c.compte;
  let f = db.prepare(`SELECT id, body FROM entries WHERE ref=? AND kind=?`).get(ref, kind);
  let neuve = false;
  if (!f) {
    const r = ingest.insert(db, { ns, kind, ref, title: titre, body: corps, level: 'L2', tags: ['fiche'] }, '@tamis');
    if (!r.ok) return;
    f = { id: r.id };
    neuve = !r.duplicate;
    const imp = Math.min(100, 10 + Math.max(0, ...vus.map(v => (db.prepare(`SELECT importance FROM h_place WHERE entry_id=?`).get(v.entry_id) || { importance: 0 }).importance)));
    db.prepare(`INSERT OR IGNORE INTO h_place(entry_id,cerveau_id,importance,place) VALUES(?,?,?,?)`).run(f.id, c.id, imp, maintenant());
    db.prepare(`INSERT OR IGNORE INTO h_cles(entry_id,cle) VALUES(?,?)`).run(f.id, k);
  } else if (f.body !== corps) {
    const o = { ns, source: '@tamis', kind, ref, title: titre, body: corps };
    db.prepare(`UPDATE entries SET body=?, hash=? WHERE id=?`).run(corps, ingest.hashOf(o), f.id);
    db.prepare(`DELETE FROM chunks WHERE entry_id=?`).run(f.id);
    const ins = db.prepare(`INSERT INTO chunks(entry_id,seq,text,embedded) VALUES(?,?,?,?)`);
    ingest.chunk({ title: titre, body: corps }).forEach((p, i) => ins.run(f.id, i, p.text, p.embedded));
  }
  for (const v of vus) if (v.entry_id !== f.id) ingest.link(db, f.id, v.entry_id, relation, '@tamis');
  if (neuve) {
    journal.push({ fiche: f.id, cerveau: c.id, cle: k, genre: kind });
    arrivee(db, f.id, c, prof + 1, journal);
  }
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

/* Reprise : les entrées d'avant la hiérarchie sont rangées une fois, au
   démarrage, comme si leur source venait de les écrire. */
function reprendre(db, { lot = 500 } = {}) {
  let total = 0;
  for (;;) {
    const ids = db.prepare(`SELECT e.id, e.source, e.kind, e.meta FROM entries e LEFT JOIN h_place p ON p.entry_id = e.id
                            WHERE p.entry_id IS NULL AND e.kind NOT LIKE 'fiche.%' AND e.ns NOT LIKE 'h:%' ORDER BY e.id LIMIT ?`).all(lot);
    if (!ids.length) break;
    db.exec('BEGIN');
    try {
      for (const e of ids) {
        let agent = null;
        try { agent = JSON.parse(e.meta || '{}').agent || null; } catch { /* méta illisible : la source sert de membre */ }
        classer(db, e.id, { src: { name: e.source }, membre: e.kind === 'echange' && agent ? agent : e.source });
        total++;
      }
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    if (ids.length < lot) break;
  }
  return total;
}

module.exports = {
  COMMUN, PRINCIPAL, DEFAUTS, mode, changerMode, principal, compteDe, globalDe, domaineChemin, cerveauMembre,
  cerveau, parentDe, ascendants, reglages, regler, cles, importanceDe, classer, valider, acces, chercher,
  arbre, rattacher, creerProjet, reprendre, slug,
};
