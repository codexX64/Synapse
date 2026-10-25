// Le manifeste du Hub et les schémas des routes : chaque appel que le Hub
// fait à SYNAPSE passe la validation de la route qu'il vise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { valider } from '../socle/src/schema.js';

const require = createRequire(import.meta.url);
const { SCHEMAS } = require('../src/schemas.js');
const manifeste = JSON.parse(fs.readFileSync(new URL('../hub.json', import.meta.url), 'utf8'));

const appels = [];
(function parcourir(o) {
  if (Array.isArray(o)) return o.forEach(parcourir);
  if (!o || typeof o !== 'object') return;
  if (typeof o.path === 'string' && o.path.startsWith('/v1/')) appels.push(o);
  Object.values(o).forEach(parcourir);
})(manifeste);

// Un paramètre rendu par le Hub : « 5 » se lit comme texte, entier ou nombre.
const rendre = v => typeof v === 'string' ? v.replace(/\{\{[^}]+\}\}/g, '5')
  : Array.isArray(v) ? v.map(rendre)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rendre(x)])) : v;

test('chaque appel du manifeste passe le schéma de sa route', () => {
  assert.ok(appels.length >= 8, `${appels.length} appels trouvés`);
  for (const a of appels) {
    const cle = `${a.method || 'GET'} ${a.path}`;
    const s = SCHEMAS[cle];
    assert.ok(s, `route sans schéma : ${cle}`);
    if (a.body !== undefined) assert.doesNotThrow(() => valider(rendre(a.body), s.corps), cle);
    if (a.query !== undefined) assert.doesNotThrow(() => valider(rendre(a.query), s.requete), cle);
  }
});

test('« Retrouver une résolution passée » : la signature donnée par le Hub ramène le correctif', async () => {
  const { lancer, service, JETON_HUB } = await import('./instance.mjs');
  const inst = await lancer();
  try {
    const hub = service(inst, JETON_HUB);
    const n = await hub.post('/v1/neurons', { neuron: { type: 'incident', signature: 'disque-plein-var', service: 'web', root_cause: 'journaux non tournés', resolution: 'rotation des journaux rétablie' } });
    assert.ok([200, 201].includes(n.status), JSON.stringify(n.json));
    const a = appels.find(x => x.path === '/v1/recall');
    const corps = JSON.parse(JSON.stringify(a.body).replaceAll('{{params.signature}}', 'disque-plein-var').replaceAll('{{params.service}}', 'web').replaceAll('{{params.host}}', 'srv-1'));
    const r = await hub.post('/v1/recall', corps);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0]?.neuron.resolution, 'rotation des journaux rétablie', JSON.stringify(r.json));
    assert.equal((await hub.post('/v1/recall', { signature: 'disque-plein-var' })).status, 400, 'l\'ancienne forme à plat est refusée');
  } finally { await inst.arreter(); }
});

test('manifeste : relais de confiance du réseau du Hub par défaut, HTTPS reconnu derrière Relay', () => {
  // Derrière Relay (réseau Docker du Hub), le HTTPS n'est reconnu que si le relais est de confiance.
  const proxys = manifeste.config.find(c => c.key === 'SOCLE_PROXYS').default;
  assert.ok(proxys, 'relais de confiance vide : SYNAPSE se croirait en HTTP derrière Relay');
  const relais = new net.BlockList();
  for (const p of proxys.split(',')) { const [a, l] = p.trim().split('/'); relais.addSubnet(a, Number(l)); }
  assert.ok(relais.check('172.18.0.5') && !relais.check('10.0.0.11'), 'le réseau Docker du Hub, pas le réseau local');
});
