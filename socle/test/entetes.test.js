import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entetesSecurite, repondreErreur } from '../src/http.js';
import { ErreurHttp } from '../src/outils.js';

const entetes = o => { const h = {}; entetesSecurite({ setHeader: (k, v) => { h[k] = v; } }, o); return h; };

test('HSTS : en HTTPS sur un nom, jamais en clair ni sur localhost', () => {
  assert.match(entetes({ secure: true, hote: 'hub.exemple:8100' })['Strict-Transport-Security'], /max-age=63072000; includeSubDomains/);
  assert.match(entetes({ secure: true })['Strict-Transport-Security'], /max-age/, 'sans hôte connu : comme avant');
  assert.equal(entetes({ secure: false, hote: 'hub.exemple' })['Strict-Transport-Security'], undefined);
  for (const h of ['localhost:8100', '127.0.0.1:8100', '[::1]:8100']) assert.equal(entetes({ secure: true, hote: h })['Strict-Transport-Security'], undefined, h);
});

test('erreurs : 502, 503 et 504 voulus passent avec leur message ; toute autre panne reste un 500 opaque', () => {
  const repondre = e => { const r = { headersSent: false, writeHead(st) { this.st = st; }, end(c) { this.corps = JSON.parse(c); } }; const j = []; repondreErreur(r, e, { journal: { warn: (...a) => j.push(a.join(' ')), error: (...a) => j.push(a.join(' ')) } }); return { ...r, j }; };
  for (const st of [502, 503, 504]) {
    const r = repondre(new ErreurHttp(st, 'Service amont injoignable.'));
    assert.deepEqual([r.st, r.corps.error, r.j.length], [st, 'Service amont injoignable.', 1]);
  }
  const brut = repondre(Object.assign(new Error('/chemin/secret: ECONNREFUSED'), { status: 502 }));
  assert.equal(brut.st, 500);
  assert.doesNotMatch(brut.corps.error, /secret|ECONN/);
  assert.equal(repondre(new ErreurHttp(500, 'détail interne')).corps.error.includes('détail'), false);
});
