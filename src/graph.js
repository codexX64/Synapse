'use strict';
/* Le graphe, tel que l'interface 3D en a besoin.

   Deux différences avec /v1/search, qui expliquent pourquoi c'est
   une route à part :

   1. La scène a besoin de TOUT d'un coup — impossible de construire
      une disposition spatiale en paginant. On plafonne donc à un
      nombre de nœuds, en gardant les plus reliés et les plus récents.

   2. L'interface raisonne en TYPES (machine, service, incident…),
      SYNAPSE stocke des KINDS (`container.oom`, `ticket.closed`).
      La correspondance se fait ici, pas côté navigateur : le jour où
      un service invente un nouveau kind, une seule ligne change. */

/* Correspondance kind → type d'affichage.
   L'ordre compte : la première règle qui matche gagne. */
const TYPE_RULES = [
  /* Un échange avec un assistant n'est ni un service ni une note : sans
     sa propre règle, il retombait sur le repli par niveau (L0 → service). */
  [/^echange$/,                                'echange'],
  /* Le SUFFIXE d'abord : `container.oom` est un incident, pas un service.
     Classer sur le seul préfixe rangeait toutes les pannes de conteneur
     avec les déploiements réussis. */
  [/\.(oom|die|failed|unhealthy|down|error|crash|denied|refused)$/, 'incident'],
  [/^(device|client|host|agent)\./,            'machine'],
  [/^(container|deploy|service|scan|stack)\./, 'service'],
  [/^(ticket|project|milestone)\./,            'projet'],
  [/^(vlan|network|topology)\./,               'reseau'],
  [/^(route|cert|dns|tunnel|http)\./,          'reseau'],
  [/^(incident|blocker|alert|finding|oom)\./,  'incident'],
  [/^(pattern|analysis|runbook|procedure)\./,  'procedure'],
  [/^(decision|insight|note|prompt)\./,        'note'],
  [/^(skill|xp)\./,                            'skill'],
  [/^(stock|inventory)\./,                     'stock'],
  [/^(roadmap|plan)\./,                        'roadmap'],
  [/^(ambition|goal)\./,                       'ambition']
];

function typeOf(kind, level, tags = '') {
  /* Les tags priment quand ils sont explicites : une fiche materiel est
     une « machine » meme si elle a ete consignee comme decision, et un
     equipement reseau est du « reseau » meme s'il est arrive par un
     evenement device.*. Sans ca, tout finissait en « note ». */
  const t = ' ' + String(tags || '') + ' ';
  if (/ (switch|commutateur|controleur|passerelle|routeur|vlan|route|dns|tunnel|firewall|pare-feu) /.test(t)) return 'reseau';
  if (/ (fiche|materiel|hote|serveur|hyperviseur|kvm|bmc) /.test(t)) return 'machine';
  if (/ (conteneur|docker|stack|service) /.test(t) && !/ (fiche) /.test(t)) return 'service';
  for (const [re, t2] of TYPE_RULES) if (re.test(kind)) return t2;
  /* Repli sur le niveau : une connaissance stable est une note,
     un événement brut sans règle est un service. */
  return level === 'L3' ? 'note' : level === 'L2' ? 'procedure' : 'service';
}

function buildGraph(db, opts = {}) {
  const ns    = opts.ns || 'shared';
  /* Plafond aligne sur ce que la scene 3D peut porter sans chevauchement :
     ~700 cartes sur une couche, ~1350 sur trois. Au-dela, le bandeau
     dit « N / total » et c est voulu — mieux vaut annoncer une coupe
     que rendre une bouillie. */
  const limit = Math.min(1400, Number(opts.limit || 300));
  const days  = opts.days ? Number(opts.days) : null;

  const args = [ns];
  let where = 'e.archived = 0 AND e.ns = ?';
  /* Les fiches de la hiérarchie vivent dans l'espace du compte : la scène
     de l'infrastructure les montre avec le reste, dans leur cerveau. */
  if (opts.fiches) { where = `e.archived = 0 AND (e.ns = ? OR (e.ns = ? AND e.kind LIKE 'fiche.%'))`; args.push(opts.fiches); }
  if (days) {
    where += ' AND e.occurred_at >= ?';
    args.push(new Date(Date.now() - days * 86400000).toISOString());
  }

  /* Les plus reliés d'abord, puis les plus récents : une scène tronquée
     doit garder les nœuds qui structurent le graphe, pas les derniers
     arrivés au hasard. */
  const COLONNES = `e.id, e.source, e.kind, e.ref, e.level, e.title, e.tags,
           e.occurred_at, e.dup_count,
           (SELECT count(*) FROM links l
             WHERE l.from_id = e.id OR l.to_id = e.id) AS deg`;
  let rows = db.prepare(`
    SELECT ${COLONNES}
    FROM entries e
    WHERE ${where}
    ORDER BY deg DESC, e.occurred_at DESC
    LIMIT ?`).all(...args, limit);

  /* Chaque cerveau a sa part de la scène : ses PAR_CERVEAU entrées les
     plus récentes (placées chez lui ou remontées jusqu'à lui) passent
     avant le reste. Sans cela, une source de 140 000 alertes prend les
     1 400 places et les petits cerveaux s'affichent vides. */
  const hierarchie = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'h_place'`).get();
  if (hierarchie && rows.length) {
    const PAR_CERVEAU = 24;
    const deja = new Set(rows.map(r => r.id)), reserve = [];
    const places = db.prepare(`SELECT p.entry_id id FROM h_place p JOIN entries e ON e.id = p.entry_id
      WHERE p.cerveau_id = ? AND ${where} ORDER BY p.entry_id DESC LIMIT ${PAR_CERVEAU}`);
    const montees = db.prepare(`SELECT r.entry_id id FROM h_remontees r JOIN entries e ON e.id = r.entry_id
      WHERE r.vers_cerveau = ? AND r.statut = 'faite' AND ${where} ORDER BY r.id DESC LIMIT ${PAR_CERVEAU}`);
    for (const { id: c } of db.prepare(`SELECT id FROM h_cerveaux ORDER BY id`).all())
      for (const q of [places, montees])
        for (const { id } of q.all(c, ...args)) if (!deja.has(id)) { deja.add(id); reserve.push(id); }
    if (reserve.length) {
      const ajout = [];
      for (let i = 0; i < reserve.length; i += 500) {
        const lot = reserve.slice(i, i + 500);
        ajout.push(...db.prepare(`SELECT ${COLONNES} FROM entries e WHERE e.id IN (${lot.map(() => '?').join(',')})`).all(...lot));
      }
      const garde = Math.max(0, limit - ajout.length);
      rows = rows.slice(0, garde).concat(ajout.slice(0, limit));
    }
  }

  const keep = new Set(rows.map(r => r.id));

  const nodes = rows.map(r => ({
    id:    'e' + r.id,
    type:  typeOf(r.kind, r.level, r.tags),
    name:  r.title,
    level: r.level,
    d: {
      sub:  r.source + ' · ' + r.kind,
      ref:  r.ref || undefined,
      at:   r.occurred_at,
      deg:  r.deg,
      dup:  r.dup_count > 1 ? r.dup_count : undefined,
      tags: r.tags || undefined
    }
  }));

  /* Les cerveaux où chaque entrée est présente : le sien d'abord, puis
     ceux où elle est remontée. La scène en fait une sphère par cerveau. */
  if (rows.length && hierarchie) {
    const ids = rows.map(r => r.id);
    const ou = new Map(ids.map(id => [id, []]));
    /* par lots : SQLite borne le nombre de paramètres d'une requête */
    for (let i = 0; i < ids.length; i += 500) {
      const lot = ids.slice(i, i + 500), marques = lot.map(() => '?').join(',');
      for (const p of db.prepare(`SELECT entry_id, cerveau_id FROM h_place WHERE entry_id IN (${marques})`).all(...lot)) ou.get(p.entry_id).push(p.cerveau_id);
      for (const r of db.prepare(`SELECT entry_id, vers_cerveau FROM h_remontees WHERE statut = 'faite' AND entry_id IN (${marques}) ORDER BY id`).all(...lot)) ou.get(r.entry_id).push(r.vers_cerveau);
    }
    nodes.forEach((n, i) => { const c = ou.get(rows[i].id); if (c.length) n.d.cerveaux = c; });
  }

  /* Une arête dont un bout est hors du lot casserait la scène. */
  const edges = db.prepare(`
    SELECT from_id, to_id, relation FROM links`).all()
    .filter(l => keep.has(l.from_id) && keep.has(l.to_id))
    .map(l => ['e' + l.from_id, 'e' + l.to_id, l.relation]);

  const counts = {};
  nodes.forEach(n => { counts[n.type] = (counts[n.type] || 0) + 1; });

  const total = db.prepare(
    `SELECT count(*) n FROM entries WHERE archived = 0 AND ns = ?`).get(ns).n;

  return {
    ns,
    nodes, edges,
    counts,
    total,
    truncated: total > nodes.length,
    generated_at: new Date().toISOString()
  };
}

/* Tous les points de la scène, sans carte : chaque entrée une fois dans
   son cerveau (et dans le global), puis une fois de plus dans chaque
   cerveau où elle est remontée. Format en colonnes, sans clé répétée :
   145 000 entrées tiennent dans moins de 2 Mo. Les `g` premiers points
   sont les entrées elles-mêmes, une par une. */
const CACHE_POINTS = new Map();
function buildPoints(db, opts = {}) {
  const ns = opts.ns || 'shared';
  /* Gardé tant que la mémoire n'a pas bougé : même nombre d'entrées vivantes,
     même dernière entrée, même nombre de remontées. */
  const hier = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'h_place'`).get();
  const etat = db.prepare(`SELECT max(id) m, count(*) n FROM entries WHERE archived = 0`).get();
  const cle = [ns, opts.fiches || '', etat.m, etat.n, hier ? db.prepare(`SELECT count(*) n FROM h_remontees WHERE statut = 'faite'`).get().n : 0].join('|');
  const deja = CACHE_POINTS.get(ns + '|' + (opts.fiches || ''));
  if (deja && deja.cle === cle) return deja.valeur;
  const valeur = calculePoints(db, opts, ns);
  CACHE_POINTS.set(ns + '|' + (opts.fiches || ''), { cle, valeur });
  if (CACHE_POINTS.size > 32) CACHE_POINTS.delete(CACHE_POINTS.keys().next().value);
  return valeur;
}
function calculePoints(db, opts, ns) {
  const args = [ns];
  let where = 'e.archived = 0 AND e.ns = ?';
  if (opts.fiches) { where = `e.archived = 0 AND (e.ns = ? OR (e.ns = ? AND e.kind LIKE 'fiche.%'))`; args.push(opts.fiches); }
  const hierarchie = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'h_place'`).get();
  const types = [], idxType = new Map(), cerveaux = [], idxC = new Map();
  const ti = t => { if (!idxType.has(t)) { idxType.set(t, types.length); types.push(t); } return idxType.get(t); };
  /* le type ne dépend que du genre, du niveau et des étiquettes : calculé une fois par combinaison */
  const memo = new Map();
  const typeDe = (k, l, g) => { const m = k + '\u001f' + l + '\u001f' + (g || ''); let v = memo.get(m); if (v === undefined) { v = ti(typeOf(k, l, g)); memo.set(m, v); } return v; };
  const ci = c => { if (c === null || c === undefined) return -1; if (!idxC.has(c)) { idxC.set(c, cerveaux.length); cerveaux.push(c); } return idxC.get(c); };
  const e = [], c = [], t = [];
  const lignes = db.prepare(hierarchie
    ? `SELECT e.id, e.kind, e.level, e.tags, p.cerveau_id c FROM entries e LEFT JOIN h_place p ON p.entry_id = e.id WHERE ${where} ORDER BY e.id`
    : `SELECT e.id, e.kind, e.level, e.tags, NULL c FROM entries e WHERE ${where} ORDER BY e.id`).iterate(...args);
  for (const r of lignes) { e.push(r.id); c.push(ci(r.c)); t.push(typeDe(r.kind, r.level, r.tags)); }
  const g = e.length;
  if (hierarchie) {
    for (const r of db.prepare(`SELECT r.entry_id id, r.vers_cerveau c, e.kind, e.level, e.tags FROM h_remontees r
        JOIN entries e ON e.id = r.entry_id WHERE r.statut = 'faite' AND ${where} ORDER BY r.id`).iterate(...args)) {
      e.push(r.id); c.push(ci(r.c)); t.push(typeDe(r.kind, r.level, r.tags));
    }
  }
  return { ns, g, types, cerveaux, e, c, t, generated_at: new Date().toISOString() };
}

module.exports = { buildGraph, buildPoints, typeOf, TYPE_RULES };
