// L'IA qui rédige : plafond du jour pour une API distante, débit par
// appelant, réponses bornées.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { lancer, service, JETON_HUB } from './instance.mjs';

let geante = false, appels = 0;
const faux = http.createServer((req, res) => {
  let corps = '';
  req.on('data', d => { corps += d; });
  req.on('end', () => {
    if (req.url === '/chat/completions') {
      appels++;
      const texte = geante ? 'x'.repeat(2 * 1024 * 1024) : 'La passerelle a redémarré [1].';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: texte } }] }));
    }
    if (req.url === '/api/embeddings') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ embedding: Array(8).fill(0.1) })); }
    if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"models":[]}'); }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => faux.listen(0, '127.0.0.1', r));
const URL_FAUX = `http://127.0.0.1:${faux.address().port}`;
const inst = await lancer({ env: { LLM_FOURNISSEUR: 'compatible', LLM_URL: URL_FAUX, LLM_CLE: 'cle-essai', LLM_MODELE: 'modele-essai', LLM_APPELS_JOUR: '2', OLLAMA_URL: URL_FAUX } });
after(async () => { await inst.arreter(); faux.close(); });
const hub = service(inst, JETON_HUB);
await hub.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 'La passerelle a redémarré cette nuit', body: 'La passerelle a redémarré cette nuit après une coupure de courant.' });
const question = q => hub.get('/v1/answer?q=' + encodeURIComponent(q));

test('IA distante : plafond du jour, puis refus dit et journalisé', async () => {
  const r1 = await question('pourquoi la passerelle a-t-elle redémarré ?');
  assert.equal(r1.status, 200);
  assert.ok(r1.json.answer, JSON.stringify(r1.json));
  await question('quand la passerelle a-t-elle redémarré ?');
  assert.equal(appels, 2);
  const r3 = await question('la passerelle a-t-elle redémarré cette nuit ?');
  assert.equal(r3.json.answer, null);
  assert.match(r3.json.ia_erreur, /plafond du jour/);
  assert.equal(appels, 2, 'le troisième appel ne part pas');
  const db = new DatabaseSync(inst.db, { readOnly: true });
  const lignes = db.prepare("SELECT action FROM socle_journal WHERE action = 'ia.plafond_atteint'").all();
  db.close();
  assert.equal(lignes.length, 1, 'une ligne de journal, pas une par refus');
});

test('IA : trente questions par minute et par appelant', async () => {
  let dernier = 0;
  for (let i = 0; i < 31; i++) dernier = (await question('passerelle')).status;
  assert.equal(dernier, 429);
});

test('IA : une réponse démesurée est abandonnée, pas gardée en mémoire', async () => {
  const autre = await lancer({ env: { LLM_FOURNISSEUR: 'compatible', LLM_URL: URL_FAUX, LLM_CLE: 'cle-essai', LLM_MODELE: 'modele-essai', OLLAMA_URL: URL_FAUX } });
  try {
    const h = service(autre, JETON_HUB);
    await h.post('/v1/ingest', { ns: 'shared', kind: 'note', title: 'La passerelle a redémarré cette nuit', body: 'La passerelle a redémarré cette nuit après une coupure de courant.' });
    geante = true;
    const r = await h.get('/v1/answer?q=' + encodeURIComponent('pourquoi la passerelle a-t-elle redémarré ?'));
    assert.equal(r.status, 200);
    assert.equal(r.json.answer, null);
    assert.match(r.json.ia_erreur, /démesurée/);
  } finally { geante = false; await autre.arreter(); }
});
