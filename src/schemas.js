'use strict';
/* Ce que chaque route accepte, champ par champ : corps et paramètres
   de requête. Tout champ non déclaré est refusé (400), les types et
   les longueurs sont contrôlés avant que la route ne lise quoi que ce
   soit. Le validateur est celui du socle (socle/src/schema.js).

   Un champ vide ("") vaut absent : le Hub remplit ses gabarits par des
   chaînes, vides quand le paramètre n'a pas été donné. */

const txt = (max, o = {}) => ({ type: 'chaine', max, ...o });
const ent = (min, max, o = {}) => ({ type: 'entier', min, max, ...o });
const nb = (min, max) => ({ type: 'nombre', min, max });
const bool = { type: 'booleen' };
const json = { type: 'json', profondeur: 6 };

const NS = txt(100);
const AGENT = txt(80);
const ID = ent(1, Number.MAX_SAFE_INTEGER);

/* Un événement de la mémoire : ce que ingest.normalize lit. `hash` est
   envoyé par le client fourni (client/) : admis, ignoré — le serveur
   calcule le sien. */
const EVT = {
  ns: NS, source: txt(64), kind: txt(80), ref: txt(200), level: txt(8),
  title: txt(2000), body: txt(1_000_000), tags: json, meta: json, occurred_at: txt(40),
  hash: txt(128),
  domaine: txt(300), importance: ent(0, 100), entites: { type: 'liste', max: 24, de: txt(120) },
};

const NEURONE = {
  type: txt(80), alert_key: txt(200), host: txt(200), service: txt(200), signature: txt(400),
  root_cause: txt(4000), resolution: txt(4000), action_id: txt(200), outcome: txt(40),
  attempts: ent(0, 100000), duration_s: nb(0, 1e9), cost_usd: nb(0, 1e9), content: json, occurred_at: txt(40),
};

const INCIDENT = {
  alert_key: txt(200), service: txt(200), host: txt(200), vlan: { type: 'json' }, symptom: txt(4000),
  root_cause: txt(4000), resolution: txt(4000), outcome: txt(40), attempts: ent(0, 100000),
  origin: txt(40), command: { type: 'liste', max: 64, de: txt(1000) }, duration_s: nb(0, 1e9),
  cost_usd: nb(0, 1e9), occurred_at: txt(40),
};

const AUCUN = {};
/* Taille du corps : 64 Kio par défaut (src/server.js) ; `grand` = MAX_BODY
   (2 Mo par défaut) pour ce qui porte des documents ; sinon `limite`. */
const KIO = 1024;

const SCHEMAS = {
  'GET /healthz': {},
  'GET /v1/stats': { requete: { scope: txt(20, { parmi: ['sources', 'neurons', 'activite'] }), days: ent(1, 3650) } },
  'GET /v1/sources': {},
  'POST /v1/ingest': { grand: true, corps: EVT },
  'POST /v1/ingest/batch': { grand: true, corps: { events: { type: 'liste', max: 200, de: { type: 'objet', champs: EVT } } } },
  'GET /v1/search': { requete: { q: txt(4000), ns: NS, scope: NS, limit: ent(1, 1000), vector: txt(1, { parmi: ['0', '1'] }) } },
  'GET /v1/entry': { requete: { id: ID } },
  'POST /v1/link': { corps: { from_id: { ...ID, requis: true }, to_id: { ...ID, requis: true }, relation: txt(40, { requis: true }) } },
  'POST /v1/click': { corps: { q: txt(4000), entry_id: ID } },
  'GET /v1/prompts': { requete: { agent: AGENT } },
  'POST /v1/prompts': { limite: 512 * KIO, corps: { agent: AGENT, body: txt(100_000) } },
  'GET /v1/rangement/etat': {},
  'POST /v1/rangement/config': { corps: {
    seuil_doublon: nb(0, 1), espace: txt(20), reecrire_titres: bool, telegram_actif: bool,
    telegram_chat: txt(40), telegram_token: txt(100),
    plages: { type: 'liste', max: 8, de: { type: 'objet', champs: { h: ent(0, 23), m: ent(0, 59), jours: { type: 'liste', max: 7, de: ent(0, 6) } } } },
  } },
  'POST /v1/rangement/telegram/test': { corps: { token: txt(100), chat: txt(40) } },
  'POST /v1/rangement/lancer': { corps: AUCUN },
  'POST /v1/rangement/pause': { corps: AUCUN },
  'POST /v1/rangement/reprendre': { corps: AUCUN },
  'POST /v1/rangement/arreter': { corps: AUCUN },
  'POST /v1/rangement/valider': { corps: { ids: { type: 'liste', max: 200, de: ID } } },
  'GET /v1/rangement/analyse': { requete: { ns: NS, seuil: nb(0, 1) } },
  'POST /v1/rangement/appliquer': { limite: 512 * KIO, corps: { plan: { type: 'liste', max: 200, de: { type: 'objet', champs: { type: txt(20), id: ID, titre: txt(300), similarite: nb(0, 1), garde: txt(300), avant: txt(300), apres: txt(300) } } } } },
  'POST /v1/brief': { corps: { agent: AGENT, q: txt(4000), query: txt(4000), ns: NS, limit: ent(1, 1000), budget: nb(0, 1e6), signature: txt(400) } },
  'POST /v1/apprendre': { limite: 128 * KIO, corps: {
    agent: AGENT, question: txt(4000), q: txt(4000), correction: txt(4000), faux: txt(4000),
    trait: { type: 'objet', champs: { cle: txt(80), valeur: txt(1000), portee: txt(10, { parmi: ['agent', 'commun'] }), confiance: nb(0, 1) } },
  } },
  'POST /v1/echange': { limite: 256 * KIO, corps: { agent: AGENT, question: txt(4000), reponse: txt(20_000), ns: NS } },
  'GET /v1/cerveaux': {},
  'PUT /v1/cerveaux/moi': { limite: 128 * KIO, corps: {
    titre: txt(200), perimetre: txt(2000), sait: { type: 'liste', max: 60, de: txt(100) }, regles: txt(3000), ui: txt(300),
    actions: { type: 'liste', max: 20, de: { type: 'objet', champs: { nom: txt(200), ou: txt(300) } } },
  } },
  'PUT /v1/cerveaux/moi/etat': { corps: { etat: txt(4000) } },
  'DELETE /v1/cerveaux/moi': {},
  'POST /v1/cerveaux/orienter': { corps: { q: txt(4000), limite: ent(1, 100) } },
  'GET /v1/moi': {},
  'POST /v1/moi/analyser': { corps: { toutRelire: bool } },
  'PUT /v1/moi/trait': { corps: { cle: txt(80, { requis: true }), valeur: txt(1000, { requis: true }) } },
  'DELETE /v1/moi/trait': { requete: { cle: txt(80) } },
  'GET /v1/profil': { requete: { agent: AGENT } },
  'DELETE /v1/profil': { requete: { agent: AGENT, cle: txt(80) } },
  'POST /v1/consolider': { corps: { agent: AGENT, ns: NS } },
  'POST /v1/recall': { corps: {
    query: txt(4000), context: json, limit: ent(1, 1000), min_similarity: nb(0, 1),
    sources: { type: 'liste', max: 50, de: txt(64) }, levels: { type: 'liste', max: 10, de: txt(20) },
  } },
  'POST /v1/neurons': { limite: 512 * KIO, corps: { neuron: { type: 'objet', champs: NEURONE }, synapses: { type: 'liste', max: 100, de: { type: 'objet', champs: { to_type: txt(40), to_key: txt(400), weight: nb(0, 1000) } } } } },
  'GET /v1/neurons': { requete: { type: txt(80), source: txt(64), limit: ent(1, 1000), offset: ent(0, 1e9) } },
  'GET /v1/neuron': { requete: { id: ID } },
  'DELETE /v1/neuron': { requete: { id: ID } },
  'POST /v1/feedback': { corps: { neuron_id: ID, useful: bool } },
  'GET /v1/export': {},
  'POST /v1/import': { grand: true, corps: { version: ent(0, 100), exported_at: txt(40), neurons: { type: 'liste', max: 100_000, de: json }, synapses: { type: 'liste', max: 1_000_000, de: json } } },
  'POST /v1/purge': { corps: { months: ent(1, 1200), keep_types: { type: 'liste', max: 50, de: txt(80) } } },
  'POST /v1/incidents': { limite: 512 * KIO, corps: INCIDENT },
  'POST /v1/incidents/lookup': { corps: { alert_key: txt(200), service: txt(200), host: txt(200), symptom: txt(4000), window: ent(1, 1e6) } },
  'GET /v1/incidents/service': { requete: { service: txt(200), limit: ent(1, 1000) } },
  'GET /v1/incidents/stats': { requete: { days: ent(1, 3650) } },
  'POST /v1/incidents/retention': { corps: { months: ent(1, 1200) } },
  'GET /v1/answer': { requete: { q: txt(4000), ns: NS, stream: txt(1, { parmi: ['0', '1'] }) } },
  'GET /v1/graph': { requete: { ns: NS, limit: ent(1, 100_000), days: ent(1, 36500) } },
  'GET /v1/hierarchie': {},
  'GET /v1/hierarchie/chercher': { requete: { cerveau: { ...ID, requis: true }, q: txt(4000), agent: AGENT, monter: txt(1, { parmi: ['0', '1'] }), limit: ent(1, 200) } },
  'POST /v1/hierarchie/domaines': { corps: { chemin: txt(300, { requis: true }), compte: txt(80) } },
  'PUT /v1/hierarchie/reglages': { corps: {
    cerveau: { ...ID, requis: true }, seuil: ent(0, 101), convergence: ent(2, 20), fenetre_jours: ent(1, 3650), repetition_heures: ent(0, 720),
    remontee: txt(10, { parmi: ['auto', 'valider', 'coupee'] }),
    toujours: { type: 'liste', max: 30, de: txt(60) }, jamais: { type: 'liste', max: 30, de: txt(60) },
  } },
  'PUT /v1/hierarchie/rattacher': { corps: { cerveau: { ...ID, requis: true }, domaine: { ...ID, requis: true } } },
  'GET /v1/hierarchie/remontees': { requete: { cerveau: ID, statut: txt(10, { parmi: ['faite', 'a_valider', 'refusee'] }), limit: ent(1, 500) } },
  'POST /v1/hierarchie/valider': { corps: { id: { ...ID, requis: true }, accepter: bool } },
  'GET /v1/hierarchie/projets': {},
  'POST /v1/hierarchie/projets': { corps: { nom: txt(60, { requis: true }), membres: { type: 'liste', max: 50, de: ID } } },
  'POST /v1/hierarchie/projets/clore': { corps: { id: { ...ID, requis: true } } },
  'PUT /v1/hierarchie/versements': { corps: { domaine: { ...ID, requis: true }, actif: bool } },
  'PUT /v1/hierarchie/mode': { corps: { mode: txt(10, { requis: true, parmi: ['un', 'plusieurs'] }) } },
  'POST /v1/hierarchie/jetons': { corps: { nom: txt(31, { requis: true }) } },
  'POST /mcp': { grand: true, corps: { jsonrpc: txt(10), id: json, method: txt(100), params: json } },
};

module.exports = { SCHEMAS };
