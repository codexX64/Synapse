// Chaque route du serveur balayée selon une table de droits : sans
// identité, avec un jeton faux, avec le jeton d'un service et avec une
// session humaine en lecture. Une route ajoutée sans place dans la table
// fait échouer l'essai.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lancer, service, JETON_HUB, JETON_INSTALLATION } from './instance.mjs';
import { Client } from '../socle/essai/client.js';
import { adminComplet, membreInvite } from '../socle/essai/inscription.js';

const require = createRequire(import.meta.url);
const { SCHEMAS } = require('../src/schemas.js');
const { jetonPour } = require('../src/cerveaux.js');

// Ce que chaque route exige, au-delà d'une identité.
const ADMIN_JETON = ['GET /v1/sources', 'POST /v1/prompts', 'GET /v1/export', 'POST /v1/import', 'POST /v1/purge', 'POST /v1/incidents/retention'];
const HUMAIN_ADMIN = ['POST /v1/rangement/config', 'POST /v1/rangement/telegram/test', 'PUT /v1/hierarchie/mode'];
const HUMAIN_MEMBRE = ['POST /v1/rangement/lancer', 'POST /v1/rangement/pause', 'POST /v1/rangement/reprendre', 'POST /v1/rangement/arreter',
  'POST /v1/rangement/valider', 'POST /v1/rangement/appliquer', 'POST /v1/moi/analyser', 'PUT /v1/moi/trait', 'DELETE /v1/moi/trait',
  'POST /v1/hierarchie/domaines', 'PUT /v1/hierarchie/reglages', 'PUT /v1/hierarchie/rattacher', 'POST /v1/hierarchie/valider',
  'POST /v1/hierarchie/projets', 'POST /v1/hierarchie/projets/clore', 'PUT /v1/hierarchie/versements', 'POST /v1/hierarchie/jetons'];
// Lues par une personne, même en lecture ; jamais par un service.
const HUMAIN_LECTURE = ['GET /v1/hierarchie/remontees', 'GET /v1/hierarchie/projets'];
const ECRITURE_SERVICE = ['POST /v1/ingest', 'POST /v1/ingest/batch', 'POST /v1/link', 'POST /v1/apprendre', 'POST /v1/echange',
  'PUT /v1/cerveaux/moi', 'PUT /v1/cerveaux/moi/etat', 'DELETE /v1/cerveaux/moi', 'DELETE /v1/profil', 'POST /v1/consolider',
  'POST /v1/neurons', 'DELETE /v1/neuron', 'POST /v1/incidents'];
const LECTURE = ['GET /v1/stats', 'GET /v1/search', 'GET /v1/entry', 'POST /v1/click', 'GET /v1/prompts', 'GET /v1/rangement/etat',
  'GET /v1/rangement/analyse', 'POST /v1/brief', 'GET /v1/cerveaux', 'POST /v1/cerveaux/orienter', 'GET /v1/moi', 'GET /v1/profil',
  'POST /v1/recall', 'GET /v1/neurons', 'GET /v1/neuron', 'POST /v1/feedback', 'POST /v1/incidents/lookup', 'GET /v1/incidents/service',
  'GET /v1/incidents/stats', 'GET /v1/answer', 'GET /v1/graph', 'GET /v1/graph/points', 'POST /mcp', 'GET /v1/hierarchie', 'GET /v1/hierarchie/chercher'];
const PUBLIQUES = ['GET /healthz'];

const inst = await lancer();
after(() => inst.arreter());
const admin = new Client(inst.port);
await adminComplet(admin, { jeton: JETON_INSTALLATION });
const { client: lecteur } = await membreInvite(admin, () => new Client(inst.port), { identifiant: 'lea', role: 'lecture' });
const vigie = service(inst, jetonPour(JETON_HUB, 'vigie'));

// Sans espace, l'analyse du rangement lit tous les espaces : réservé aux humains et à la portée admin.
const PRECISE = { 'GET /v1/rangement/analyse': '/v1/rangement/analyse?ns=shared' };
const appel = (qui, cle) => {
  const [m, c] = cle.split(' ');
  const chemin = PRECISE[cle] || c;
  const corps = ['POST', 'PUT'].includes(m) ? {} : undefined;
  return qui.req(m, chemin, corps);
};
const anonyme = { req: (m, c, b) => fetch(inst.url(c), { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? '{}' : undefined }) };

test('la table couvre chaque route, une fois', () => {
  const table = [...ADMIN_JETON, ...HUMAIN_ADMIN, ...HUMAIN_MEMBRE, ...HUMAIN_LECTURE, ...ECRITURE_SERVICE, ...LECTURE, ...PUBLIQUES];
  assert.equal(new Set(table).size, table.length, 'une route en double dans la table');
  assert.deepEqual([...table].sort(), Object.keys(SCHEMAS).sort());
});

test('sans identité ou avec un jeton faux : 401 partout hors la santé', async () => {
  const faux = service(inst, 'faux_' + 'z'.repeat(30));
  for (const cle of Object.keys(SCHEMAS)) {
    if (PUBLIQUES.includes(cle)) continue;
    assert.equal((await appel(anonyme, cle)).status, 401, cle);
  }
  // Un seul jeton faux : dix bloquent l'adresse, et les essais suivants viennent d'elle.
  assert.equal((await appel(faux, 'GET /v1/stats')).status, 401);
});

test('jeton d\'un service : ni les gestes de la portée admin, ni ceux réservés aux humains', async () => {
  for (const cle of [...ADMIN_JETON, ...HUMAIN_ADMIN, ...HUMAIN_MEMBRE, ...HUMAIN_LECTURE]) assert.equal((await appel(vigie, cle)).status, 403, cle);
  for (const cle of [...ECRITURE_SERVICE, ...LECTURE]) assert.ok(![401, 403].includes((await appel(vigie, cle)).status), cle);
});

test('session humaine en lecture : elle lit, n\'écrit pas dans la mémoire, ne règle ni ne range rien', async () => {
  for (const cle of [...ADMIN_JETON, ...HUMAIN_ADMIN, ...HUMAIN_MEMBRE, ...ECRITURE_SERVICE]) assert.equal((await appel(lecteur, cle)).status, 403, cle);
  for (const cle of HUMAIN_LECTURE) assert.ok(![401, 403].includes((await appel(lecteur, cle)).status), cle);
  for (const cle of LECTURE) {
    if (cle === 'POST /mcp') continue;   // MCP : protocole des services ; une session y lit comme un service en lecture
    assert.ok(![401, 403].includes((await appel(lecteur, cle)).status), cle);
  }
});
