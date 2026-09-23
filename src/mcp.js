'use strict';
/* ============================================================
   MCP — le canal des agents.

   Ce que renvoie SYNAPSE à une IA n'a rien à voir avec ce qu'il
   renvoie au hub. Deux différences qui comptent :

   1. Chaque morceau porte sa DATE et sa SOURCE dans le texte
      lui-même, pas seulement en métadonnée. Sans ça, un modèle
      mélange un fait de mars avec un fait d'août et l'affirme au
      présent — c'est la première cause d'hallucination sur du RAG.

   2. Le champ `enough` dit explicitement si la mémoire contient
      de quoi répondre. Un agent qui sait qu'il n'y a rien répond
      « je ne sais pas » au lieu d'inventer. Peu d'API l'exposent,
      et c'est pourtant le champ le plus utile.

   memory_write est un appel EXPLICITE. Jamais automatique en fin de
   conversation : un modèle reformule, et en trois semaines la base
   est pleine de paraphrases contradictoires.
   ============================================================ */

const { search } = require('./search.js');
const ingest = require('./ingest.js');
const inc = require('./incidents.js');
const neu = require('./neurons.js');
const { blobToVec } = require('./db.js');

const TOOLS = [
  {
    name: 'memory_search',
    description: "Cherche dans la mémoire. DEUX espaces, à ne pas confondre : " +
      "scope 'homelab' = ce qui existe et ce qui est arrivé sur l'infrastructure — " +
      "machines, services, incidents, corrections, faits datés. À utiliser pour " +
      "diagnostiquer, vérifier un état, retrouver une panne. " +
      "scope 'savoir' = les standards de Codex64 — manuel de sécurité, conventions " +
      "de code, design system, règles d'architecture. À utiliser AVANT d'écrire du " +
      "code ou de proposer une conception. " +
      "Une question sur une panne ne va pas dans savoir ; une question de style " +
      "ne va pas dans homelab.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'question ou mots-clés' },
        scope: { type: 'string',
                 enum: ['homelab', 'savoir', 'agent', 'agent+shared', 'shared'],
                 default: 'homelab',
                 description: "'homelab' pour l'infrastructure, 'savoir' pour les standards" },
        limit: { type: 'integer', default: 6, maximum: 20 }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_get',
    description: "Lit une entrée entière et ses liens, à partir de son identifiant.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id']
    }
  },
  {
    name: 'memory_write',
    description: "Consigne une CONCLUSION dans la mémoire. À n'appeler que sur demande explicite " +
      "de l'utilisateur, jamais automatiquement : écrire des reformulations pollue la base.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body:  { type: 'string' },
        tags:  { type: 'array', items: { type: 'string' } },
        scope: { type: 'string', enum: ['agent', 'shared'], default: 'agent' },
        level: { type: 'string', enum: ['L1', 'L2', 'L3'], default: 'L3' }
      },
      required: ['title', 'body']
    }
  },
  {
    name: 'recall',
    description: "Rappelle ce que SYNAPSE sait déjà, AVANT de répondre ou d'agir. " +
      "Chaque résultat porte sa similarité et le niveau qui l'a produit. " +
      "Au-dessus de 0.85 le rappel est considéré comme exact ; en dessous, " +
      "c'est une piste, pas une certitude.",
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string' },
        context: { type: 'object', description: 'alert_key, service, host, signature' },
        limit:   { type: 'integer', default: 3, maximum: 20 },
        min_similarity: { type: 'number', default: 0.5 },
        sources: { type: 'array', items: { type: 'string' },
                   description: '["*"] pour tous les clients, sinon le sien' }
      },
      required: ['query']
    }
  },
  {
    name: 'remember',
    description: "Consigne un neurone. À n'appeler que sur demande explicite : " +
      "écrire automatiquement des reformulations pollue la mémoire.",
    inputSchema: {
      type: 'object',
      properties: {
        neuron:   { type: 'object' },
        synapses: { type: 'array', items: { type: 'object' } }
      },
      required: ['neuron']
    }
  },
  {
    name: 'search_incidents',
    description: "Cherche dans l'historique des pannes d'infrastructure. " +
      "Répond à « qu'est-ce qui est tombé cette semaine sur srv-app-01 » ou " +
      "« est-ce que relay a déjà fait ça ».",
    inputSchema: {
      type: 'object',
      properties: {
        service:   { type: 'string' },
        alert_key: { type: 'string' },
        host:      { type: 'string' },
        since:     { type: 'string', description: 'date ISO, défaut 30 jours' },
        limit:     { type: 'integer', default: 20, maximum: 100 }
      }
    }
  },
  {
    name: 'get_incident_history',
    description: "Historique complet d'un service, du plus récent au plus ancien.",
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string' }, limit: { type: 'integer', default: 30 } },
      required: ['service']
    }
  },
  {
    name: 'get_infra_health_summary',
    description: "Services les plus instables du mois, fixes les plus fiables, " +
      "et fixes en train de se dégrader — ceux qui marchaient et ne marchent plus.",
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', default: 30 } }
    }
  },
  {
    name: 'memory_link',
    description: "Relie deux entrées. Vocabulaire fermé : causes, fixes, supersedes, relates_to, part_of.",
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'integer' },
        to_id: { type: 'integer' },
        relation: { type: 'string', enum: [...ingest.RELATIONS] }
      },
      required: ['from_id', 'to_id', 'relation']
    }
  }
];

function agentNs(src) { return 'agent:' + src.name; }

/* En-tête de provenance collé au texte : c'est lui qui empêche le
   modèle de présenter un fait ancien comme l'état courant. */
function stamp(h) {
  const d = h.occurred_at.slice(0, 10);
  return `[${h.source} · ${d} · ${h.level}] ${h.title}\n${h.snippet}`;
}

async function toolCall(db, src, name, args, ctx) {
  switch (name) {

    case 'memory_search': {
      const scope = args.scope || 'homelab';
      const spaces = scope === 'savoir'  ? ['savoir']
                   : scope === 'shared'  ? ['shared']
                   : scope === 'homelab' ? [agentNs(src), 'shared']
                   : scope === 'agent'   ? [agentNs(src)]
                   : [agentNs(src), 'shared'];
      const limit = Math.min(20, args.limit || 6);
      const all = [];
      for (const ns of spaces) {
        const r = await search(db, { q: args.query, ns, limit, embed: ctx.embed });
        /* la mémoire propre de l'agent prime sur la mémoire commune */
        const w = ns.startsWith('agent:') ? 1.4 : 1.0;
        for (const h of r.hits) all.push({ ...h, score: h.score * w, ns });
      }
      all.sort((a, b) => b.score - a.score);
      const hits = all.slice(0, limit);
      const best = hits.length ? hits[0].score : 0;
      const enough = hits.length > 0 && best * 12 > 0.35;
      return {
        enough,
        espace: scope,
        note: enough ? undefined
          : (scope === 'savoir'
              ? "Aucun standard ne couvre ce point. Ne l'invente pas : dis que la règle n'est pas écrite."
              : "La mémoire ne contient rien d'assez proche. Dis-le plutôt que de supposer."),
        results: hits.map(h => ({
          id: h.id,
          text: stamp(h),
          source: h.source,
          occurred_at: h.occurred_at,
          level: h.level,
          ns: h.ns,
          score: +h.score.toFixed(4),
          why: h.why
        }))
      };
    }

    case 'memory_get': {
      const e = db.prepare(`SELECT * FROM entries WHERE id=?`).get(Number(args.id));
      if (!e) return { error: 'introuvable' };
      if (e.ns !== 'shared' && e.ns !== agentNs(src)) return { error: 'espace interdit' };
      const links = db.prepare(`
        SELECT l.relation, e2.id, e2.title,
               CASE WHEN l.from_id=? THEN 'out' ELSE 'in' END AS dir
        FROM links l JOIN entries e2
          ON e2.id = CASE WHEN l.from_id=? THEN l.to_id ELSE l.from_id END
        WHERE l.from_id=? OR l.to_id=?`).all(e.id, e.id, e.id, e.id);
      return {
        id: e.id, title: e.title, body: e.body, source: e.source,
        occurred_at: e.occurred_at, level: e.level, ns: e.ns,
        tags: e.tags ? e.tags.split(' ') : [], links
      };
    }

    case 'memory_write': {
      const ns = args.scope === 'shared' ? 'shared' : agentNs(src);
      const r = ingest.insert(db, {
        ns,
        kind: 'insight.written',
        level: args.level || 'L3',
        title: args.title,
        body: args.body,
        tags: args.tags || [],
        meta: { written_by: src.name, explicit: true }
      }, src.name);
      if (!r.ok) return { error: r.reason || 'refusé' };
      return { id: r.id, ns, duplicate: !!r.duplicate,
               note: r.duplicate ? 'Ce fait était déjà en mémoire, rien de nouveau écrit.' : undefined };
    }

    case 'memory_link':
      return ingest.link(db, Number(args.from_id), Number(args.to_id),
                         String(args.relation), src.name);

    case 'recall': {
      const r = await neu.recall(db, args, {
        source: src.name, embed: ctx.embed, blobToVec
      });
      return {
        threshold: neu.DECISION_THRESHOLD,
        results: r.results.map(x => ({
          similarity: x.similarity,
          via: x.via,
          /* la date dans le texte : sans elle un modèle présente un
             correctif de mars comme l'état courant */
          text: `[${x.neuron.occurred_at.slice(0,10)} · ${x.via} · ${x.similarity}] ` +
                `${x.neuron.service || x.neuron.type} — ${x.neuron.root_cause || '(sans cause)'} ` +
                `→ ${x.neuron.resolution || '(sans résolution)'} (${x.neuron.outcome || 'n/a'})`,
          neuron: x.neuron
        })),
        note: r.results.length ? undefined
          : "Rien d'assez proche en mémoire. Dis-le plutôt que de supposer."
      };
    }

    case 'remember': {
      const r = neu.remember(db, args, src.name);
      return r.ok ? r.body : { error: r.error };
    }

    case 'search_incidents': {
      const since = args.since ||
        new Date(Date.now() - 30 * 86400000).toISOString();
      const w = ['occurred_at >= ?'], a = [since];
      if (args.service)   { w.push('service = ?');   a.push(args.service); }
      if (args.alert_key) { w.push('alert_key = ?'); a.push(args.alert_key); }
      if (args.host)      { w.push('host = ?');      a.push(args.host); }
      const rows = db.prepare(`
        SELECT alert_key, service, host, symptom, root_cause, resolution,
               outcome, origin, occurred_at
        FROM incidents WHERE ${w.join(' AND ')}
        ORDER BY occurred_at DESC LIMIT ?`)
        .all(...a, Math.min(100, args.limit || 20));
      return {
        found: rows.length,
        /* la date en tête du texte : sans elle un modèle présente une
           panne de mars comme l'état courant */
        incidents: rows.map(r => ({
          text: `[${r.occurred_at.slice(0, 10)} · ${r.service}${r.host ? ' · ' + r.host : ''}] ` +
                `${r.alert_key} — ${r.symptom || '(sans symptôme)'} → ` +
                `${r.resolution || '(aucun fix)'} (${r.outcome})`,
          ...r
        }))
      };
    }

    case 'get_incident_history': {
      if (!args.service) return { error: 'service requis' };
      const rows = inc.history(db, String(args.service), args.limit || 30);
      const s = inc.summarize(rows);
      return {
        service: args.service,
        total: rows.length,
        resume: s ? {
          fix_recommande: s.known_fix,
          a_ne_pas_retenter: s.failed_fixes,
          taux_reussite: s.success_rate,
          dernier: s.last_seen
        } : null,
        incidents: rows.map(r => ({
          text: `[${r.occurred_at.slice(0, 10)}] ${r.alert_key} — ` +
                `${r.resolution || '(aucun fix)'} (${r.outcome})`,
          ...r
        }))
      };
    }

    case 'get_infra_health_summary':
      return inc.stats(db, Number(args.days || 30));

    default:
      return { error: 'outil inconnu : ' + name };
  }
}

/* JSON-RPC 2.0, sous-ensemble MCP. */
async function handleMcp(db, src, msg, ctx) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail  = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (!src) return fail(-32001, 'jeton absent ou invalide');
  if (!msg || msg.jsonrpc !== '2.0') return fail(-32600, 'requête invalide');

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse', version: '1.0.0' }
      });

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const writes = name === 'memory_write' || name === 'memory_link' || name === 'remember';
      const scopes = (src.scope || '').split('+');
      if (writes && !scopes.includes('write') && src.scope !== 'admin')
        return fail(-32003, 'portée write requise');
      if (!writes && !scopes.includes('read') && src.scope !== 'admin')
        return fail(-32003, 'portée read requise');
      const out = await toolCall(db, src, name, args, ctx);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    }

    case 'ping':
      return reply({});

    default:
      return fail(-32601, 'méthode inconnue : ' + msg.method);
  }
}

module.exports = { handleMcp, TOOLS };
