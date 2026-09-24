'use strict';
/* Le rédacteur : Ollama ou une API compatible OpenAI (Kimi…), mêmes
   appels, même sortie. Serveur factice, aucun réseau. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const LLM = require('./llm.js');

let srv, base, vu = [];
before(async () => {
  srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b || '{}'); vu.push({ url: req.url, auth: req.headers.authorization, body: j });
      if (req.url === '/api/generate') {
        if (j.stream) { res.write(JSON.stringify({ response: 'Bon' }) + '\n'); res.write(JSON.stringify({ response: 'jour<think>x</think>' }) + '\n'); return res.end(); }
        return res.end(JSON.stringify({ response: '<think>plan</think>Réponse ollama' }));
      }
      if (req.url === '/v1/chat/completions') {
        if (req.headers.authorization !== 'Bearer sk-test') { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'Invalid Authentication' } })); }
        if (j.stream) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Sa' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lut' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n'); return res.end();
        }
        return res.end(JSON.stringify({ choices: [{ message: { content: 'Réponse kimi' } }] }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test('ollama par défaut : pensée retirée, contexte et json transmis', async () => {
  const env = { OLLAMA_URL: base, ANSWER_MODEL: 'qwen3:14b' };
  assert.equal(await LLM.genere({ prompt: 'q', json: true, maxTokens: 50 }, env), 'Réponse ollama');
  const b = vu.at(-1).body;
  assert.equal(b.model, 'qwen3:14b'); assert.equal(b.format, 'json'); assert.equal(b.options.num_predict, 50); assert.ok(b.options.num_ctx);
  let t = ''; await LLM.flux({ prompt: 'q' }, x => { t += x; }, env);
  assert.equal(t, 'Bonjour');
  assert.deepEqual(LLM.etat(env), { fournisseur: 'Ollama', modele: 'qwen3:14b', distant: false, repli: null });
});

test('kimi : chat completions, clé en en-tête, flux SSE, json_object', async () => {
  const env = { OLLAMA_URL: base, LLM_FOURNISSEUR: 'kimi', LLM_URL: base + '/v1/', LLM_CLE: 'sk-test' };
  assert.equal(await LLM.genere({ system: 's', prompt: 'q', json: true }, env), 'Réponse kimi');
  const v = vu.at(-1);
  assert.equal(v.auth, 'Bearer sk-test');
  assert.equal(v.body.model, 'kimi-k2-0905-preview', 'modèle par défaut du fournisseur');
  assert.deepEqual(v.body.messages.map(m => m.role), ['system', 'user']);
  assert.deepEqual(v.body.response_format, { type: 'json_object' });
  let t = ''; assert.equal(await LLM.flux({ prompt: 'q' }, x => { t += x; }, env), 'Salut');
  assert.equal(t, 'Salut');
  const e = LLM.etat(env);
  assert.equal(e.fournisseur, 'Kimi'); assert.equal(e.distant, true);
  assert.ok(!JSON.stringify(e).includes('sk-test'), 'la clé ne sort jamais');
  await assert.rejects(LLM.genere({ prompt: 'q' }, { ...env, LLM_CLE: 'mauvaise' }), /Invalid Authentication/);
});

test('kimi choisi sans clé : Ollama répond, et le dit', async () => {
  const env = { OLLAMA_URL: base, ANSWER_MODEL: 'qwen3:14b', LLM_FOURNISSEUR: 'kimi' };
  assert.equal(await LLM.genere({ prompt: 'q' }, env), 'Réponse ollama');
  assert.match(LLM.etat(env).repli, /Kimi.*sans clé/);
  assert.match(LLM.etat({ ...env, LLM_FOURNISSEUR: 'compatible', LLM_CLE: 'k' }).repli, /sans adresse/);
});
