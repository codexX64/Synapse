'use strict';
/* ============================================================
   Le graphe, tel que l'interface 3D en a besoin.

   Deux différences avec /v1/search, qui expliquent pourquoi c'est
   une route à part :

   1. La scène a besoin de TOUT d'un coup — impossible de construire
      une disposition spatiale en paginant. On plafonne donc à un
      nombre de nœuds, en gardant les plus reliés et les plus récents.

   2. L'interface raisonne en TYPES (machine, service, incident…),
      SYNAPSE stocke des KINDS (`container.oom`, `ticket.closed`).
      La correspondance se fait ici, pas côté navigateur : le jour où
      un service invente un nouveau kind, une seule ligne change.
   ============================================================ */

/* Correspondance kind → type d'affichage.
   L'ordre compte : la première règle qui matche gagne. */
const TYPE_RULES = [
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
  if (/ (fiche|materiel|hote|serveur|proxmox|hyperviseur|srv-app-01|le serveur de vecteurs|kvm|bmc) /.test(t)) return 'machine';
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
  if (days) {
    where += ' AND e.occurred_at >= ?';
    args.push(new Date(Date.now() - days * 86400000).toISOString());
  }

  /* Les plus reliés d'abord, puis les plus récents : une scène tronquée
     doit garder les nœuds qui structurent le graphe, pas les derniers
     arrivés au hasard. */
  const rows = db.prepare(`
    SELECT e.id, e.source, e.kind, e.ref, e.level, e.title, e.tags,
           e.occurred_at, e.dup_count,
           (SELECT count(*) FROM links l
             WHERE l.from_id = e.id OR l.to_id = e.id) AS deg
    FROM entries e
    WHERE ${where}
    ORDER BY deg DESC, e.occurred_at DESC
    LIMIT ?`).all(...args, limit);

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

module.exports = { buildGraph, typeOf, TYPE_RULES };
