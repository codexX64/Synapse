'use strict';
/* ============================================================
   Tests du contrat public — les 9 points exigés, dans l'ordre.

   Aucun réseau. La couche sémantique est volontairement absente :
   le service doit fonctionner sans elle, c'est le test 8.

   node src/neurons.test.js
   ============================================================ */

const fs = require('node:fs');
const { open } = require('./db.js');
const N = require('./neurons.js');

const FILE = '/tmp/neurons-test.db';
try { for (const s of ['', '-wal', '-shm']) fs.unlinkSync(FILE + s); } catch {}
const db = open(FILE);
N.migrate(db);

let pass = 0, fail = 0;
const t = (nom, cond, detail) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + nom); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + nom + (detail !== undefined ? '  → ' + detail : '')); }
};
const head = s => console.log('\n\x1b[1m' + s + '\x1b[0m');
const iso = d => new Date(Date.now() - d * 86400000).toISOString();
const ctx = s => ({ source: s, embed: null, blobToVec: null });

const ecrire = (src, neuron, synapses) => N.remember(db, { neuron, synapses }, src);

(async () => {

/* ============================================================ */
head('1 · L0 franchit le seuil, L3 jamais');
{
  ecrire('triage', {
    type: 'incident_resolution', alert_key: 'proxy_502', host: 'srv-app-01',
    service: 'serveur-web', signature: 'http_502_upstream',
    root_cause: "conteneur relay tué par l'OOM killer",
    resolution: 'restart_container sur relay', action_id: 'restart_container',
    outcome: 'resolved', occurred_at: iso(2)
  });
  /* un voisin, relié par le même service mais d'une autre signature */
  ecrire('triage', {
    type: 'incident_resolution', alert_key: 'proxy_tls', host: 'srv-app-01',
    service: 'serveur-web', signature: 'tls_handshake_fail',
    root_cause: 'certificat expiré', resolution: 'renew_cert',
    action_id: 'renew_cert', outcome: 'resolved', occurred_at: iso(3)
  });

  const r = await (N.recall(db, {
    query: "502 upstream injoignable sur relay",
    context: { signature: 'http_502_upstream', service: 'serveur-web', alert_key: 'proxy_502' }
  }, ctx('triage')));

  const l0 = r.results.find(x => x.via === 'L0');
  t('un rappel exact atteint au moins 0.85', l0 && l0.similarity >= 0.85,
    l0 && l0.similarity);
  t('le niveau qui a produit le résultat est exposé', !!(l0 && l0.via === 'L0'));

  const l3 = r.results.filter(x => x.via === 'L3');
  t('aucun voisinage L3 ne franchit le seuil',
    l3.every(x => x.similarity < N.DECISION_THRESHOLD),
    l3.map(x => x.similarity).join(','));
  t('les résultats sont triés par similarité décroissante',
    r.results.every((x, i) => i === 0 || r.results[i-1].similarity >= x.similarity));
}

/* ============================================================ */
head('2 · un échec ne franchit jamais le seuil');
{
  ecrire('triage', {
    type: 'incident_resolution', alert_key: 'disk_full', host: 'srv-app-01',
    service: 'supervision', signature: 'disk_full_var',
    root_cause: 'partition /var saturée', resolution: 'clear_cache',
    action_id: 'clear_cache', outcome: 'failed', occurred_at: iso(1)
  });
  const r = await (N.recall(db, {
    query: 'partition saturée',
    context: { signature: 'disk_full_var', service: 'supervision', alert_key: 'disk_full' }
  }, ctx('triage')));
  const x = r.results[0];
  t('un outcome failed est plafonné sous le seuil',
    x && x.similarity < N.DECISION_THRESHOLD, x && `${x.similarity} (${x.neuron.outcome})`);
  t('il remonte quand même, comme information', !!x);
}

/* ============================================================ */
head('3 · idempotence sur 24 h : fusion, pas doublon');
{
  const n = {
    type: 'incident_resolution', alert_key: 'oom_kill', host: 'srv-app-01',
    service: 'supervision', signature: 'oom_scanner',
    root_cause: 'plage de scan trop large', resolution: 'restart + garde /22',
    action_id: 'restart_container', outcome: 'resolved', occurred_at: iso(0)
  };
  const a = ecrire('triage', n);
  const b = ecrire('triage', n);
  t('première écriture : 201', a.status === 201, a.status);
  t('seconde écriture : fusion', b.body.merged_with === a.body.neuron_id,
    JSON.stringify(b.body));
  t('merged_with renseigné', b.body.merged_with !== null);
  t('un seul neurone en base', b.body.neuron_id === a.body.neuron_id);

  const row = db.prepare(`SELECT occurrences FROM neurons WHERE id=?`).get(a.body.neuron_id);
  t('compteur d\'occurrences incrémenté', row.occurrences === 2, row.occurrences);

  /* un outcome différent est un fait différent : pas de fusion */
  const c = ecrire('triage', { ...n, outcome: 'failed' });
  t('un outcome différent crée un neurone distinct',
    c.body.neuron_id !== a.body.neuron_id && c.body.merged_with === null);
}

/* ============================================================ */
head('4 · vieillissement : un neurone de 6 mois est décoté');
{
  ecrire('triage', {
    type: 'incident_resolution', alert_key: 'age_test', service: 'svc_age',
    signature: 'sig_vieux', root_cause: 'cause identique', resolution: 'fix',
    action_id: 'fix', outcome: 'resolved', occurred_at: iso(180)
  });
  ecrire('triage', {
    type: 'incident_resolution', alert_key: 'age_test2', service: 'svc_age2',
    signature: 'sig_recent', root_cause: 'cause identique', resolution: 'fix',
    action_id: 'fix', outcome: 'resolved', occurred_at: iso(1)
  });
  const vieux = await (N.recall(db, { query: 'cause identique',
    context: { signature: 'sig_vieux' } }, ctx('triage')));
  const recent = await (N.recall(db, { query: 'cause identique',
    context: { signature: 'sig_recent' } }, ctx('triage')));

  t('le neurone de 6 mois est décoté',
    vieux.results[0].similarity < recent.results[0].similarity,
    `6 mois = ${vieux.results[0].similarity} · hier = ${recent.results[0].similarity}`);
  t('un correctif de 6 mois ne déclenche plus d\'exécution',
    vieux.results[0].similarity < N.DECISION_THRESHOLD, vieux.results[0].similarity);
  t('un correctif d\'hier le peut encore',
    recent.results[0].similarity >= N.DECISION_THRESHOLD, recent.results[0].similarity);
}

/* ============================================================ */
head('5 · le retour du client fait baisser le rang');
{
  const q = { query: 'cause identique', context: { signature: 'sig_recent' } };
  const avant = (await N.recall(db, q, ctx('triage'))).results[0];
  for (let i = 0; i < 3; i++) N.feedback(db, avant.neuron.id, false);
  const apres = (await N.recall(db, q, ctx('triage'))).results[0];

  t('un rappel jugé inutile descend',
    apres.similarity < avant.similarity,
    `${avant.similarity} → ${apres.similarity}`);
  t('et repasse sous le seuil de décision',
    apres.similarity < N.DECISION_THRESHOLD, apres.similarity);

  N.feedback(db, avant.neuron.id, true);
  const r3 = db.prepare(`SELECT fb_useful,fb_total FROM neurons WHERE id=?`).get(avant.neuron.id);
  t('le compteur distingue utile et total', r3.fb_useful === 1 && r3.fb_total === 4,
    `${r3.fb_useful}/${r3.fb_total}`);
}

/* ============================================================ */
head('6 · cloisonnement entre clients');
{
  ecrire('oracle', {
    type: 'conversation', service: 'chat-service', signature: 'conv_secret',
    root_cause: 'discussion privée oracle', resolution: 'note interne',
    outcome: 'resolved', occurred_at: iso(1)
  });

  const parDefaut = await (N.recall(db,
    { query: 'discussion privée oracle', context: { signature: 'conv_secret' } },
    ctx('triage')));
  t('un client ne voit pas les neurones d\'un autre par défaut',
    parDefaut.results.length === 0, parDefaut.results.length);

  const explicite = await (N.recall(db,
    { query: 'discussion privée oracle', context: { signature: 'conv_secret' },
      sources: ['*'] }, ctx('triage')));
  t('sources:["*"] ouvre explicitement', explicite.results.length > 0);

  const chezLui = await (N.recall(db,
    { query: 'discussion privée oracle', context: { signature: 'conv_secret' } },
    ctx('oracle')));
  t('chaque client voit les siens', chezLui.results.length > 0);
}

/* ============================================================ */
head('7 · le contenu est une donnée, jamais une instruction');
{
  const poison = "'; DROP TABLE neurons; -- {{template}} ${injection} <script>alert(1)</script>";
  const w = ecrire('triage', {
    type: 'incident_resolution', alert_key: 'inject', service: 'svc_x',
    signature: 'sig_inject', root_cause: poison, resolution: poison,
    action_id: 'noop', outcome: 'resolved', occurred_at: iso(1)
  });
  t('écriture acceptée sans rien casser', w.ok === true);

  const encore = db.prepare(`SELECT count(*) n FROM neurons`).get().n;
  t('la table existe toujours', encore > 0, encore);

  const lu = N.getNeuron(db, w.body.neuron_id);
  t('le contenu ressort octet pour octet', lu.root_cause === poison);

  const r = await (N.recall(db, { query: 'DROP TABLE injection',
    context: { signature: 'sig_inject' } }, ctx('triage')));
  t('il est cherchable sans être interprété', r.results.length > 0);
}

/* ============================================================ */
head('8 · le service fonctionne sans couche sémantique');
{
  /* ctx.embed vaut null partout dans ces tests : L2 est donc inactif. */
  const r = await (N.recall(db, {
    query: "502 upstream injoignable",
    context: { signature: 'http_502_upstream' }
  }, ctx('triage')));
  t('L0 répond sans embeddings', r.results.some(x => x.via === 'L0'));

  const lex = await (N.recall(db, { query: 'OOM killer conteneur relay tué' },
    ctx('triage')));
  t('L1 lexical répond sans embeddings', lex.results.some(x => x.via === 'L1'),
    lex.results.map(x => x.via).join(','));
  t('aucun résultat L2 quand la couche est absente',
    !r.results.some(x => x.via === 'L2'));
}

/* ============================================================ */
head('9 · latence : L0 sur 10 000 neurones sous 300 ms');
{
  const services = ['serveur-web','supervision','tickets','collecteur','supervision','stockage'];
  const t0 = Date.now();
  /* Insertion directe, sans passer par remember() : la fusion sur 24 h
     ferait une lecture avant chaque écriture, et surtout elle ramènerait
     10 000 lignes à ~1 200. Or c'est bien la latence de LECTURE sur une
     grande base qu'on veut mesurer, pas celle de l'écriture. */
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO neurons(source,type,alert_key,host,service,signature,root_cause,
      resolution,action_id,outcome,attempts,content,occurred_at,created_at,last_seen_at)
    VALUES('triage','incident_resolution',?,?,?,?,?,?,?,?,1,'{}',?,?,?)`);
  const insL = db.prepare(
    `INSERT OR IGNORE INTO synapse_links(neuron_id,to_type,to_key,weight) VALUES(?,?,?,1)`);
  db.exec('BEGIN');
  for (let i = 0; i < 10000; i++) {
    const svc = services[i % services.length];
    const at = new Date(Date.now() - (i % 200) * 86400000 - i * 997).toISOString();
    const info = ins.run('bulk_' + (i % 60), 'h' + (i % 12), svc, 'sig_bulk_' + i,
      `cause ${i % 90} sur ${svc} upstream injoignable`,
      'fix_' + (i % 25), 'fix_' + (i % 25), i % 5 === 0 ? 'failed' : 'resolved',
      at, now, now);
    const id = Number(info.lastInsertRowid);
    insL.run(id, 'service', svc);
    insL.run(id, 'alert_key', 'bulk_' + (i % 60));
  }
  db.exec('COMMIT');
  const total = db.prepare(`SELECT count(*) n FROM neurons WHERE deleted=0`).get().n;
  console.log(`  ${total} neurones en base, écrits en ${Date.now() - t0} ms`);

  const mesures = [];
  for (let i = 0; i < 200; i++) {
    const a = performance.now();
    await (N.recall(db, {
      query: `cause ${i % 90} upstream injoignable`,
      context: { signature: 'sig_bulk_' + (i * 7 % 10000),
                 alert_key: 'bulk_' + (i % 60),
                 service: services[i % services.length] }
    }, ctx('triage')));
    mesures.push(performance.now() - a);
  }
  mesures.sort((x, y) => x - y);
  const p = q => mesures[Math.floor(mesures.length * q)];
  console.log(`  p50 ${p(.5).toFixed(1)} ms · p95 ${p(.95).toFixed(1)} ms · p99 ${p(.99).toFixed(1)} ms · max ${mesures[mesures.length-1].toFixed(1)} ms`);
  t('p95 sous 300 ms (cible)', p(.95) < 300, p(.95).toFixed(1) + ' ms');
  t('max sous 3 s (plafond dur du client)',
    mesures[mesures.length-1] < 3000, mesures[mesures.length-1].toFixed(1) + ' ms');
}

/* ============================================================ */
head('export, import, purge');
{
  const dump = N.exportAll(db);
  t('export complet', dump.neurons.length > 0 && Array.isArray(dump.synapses));

  const db2 = (() => {
    try { for (const s of ['', '-wal', '-shm']) fs.unlinkSync('/tmp/neurons-imp.db' + s); } catch {}
    const d = open('/tmp/neurons-imp.db'); N.migrate(d); return d;
  })();
  const imp = N.importAll(db2, { version: 1, neurons: dump.neurons.slice(0, 50),
                                 synapses: dump.synapses.slice(0, 100) });
  t('réimport dans une base vierge', imp.ok && imp.neurons === 50, JSON.stringify(imp));
  db2.close();

  const avant = db.prepare(`SELECT count(*) n FROM neurons`).get().n;
  const pu = N.purge(db, { months: 6 });
  const apres = db.prepare(`SELECT count(*) n FROM neurons`).get().n;
  t('la purge supprime les plus anciens', apres < avant, `${avant} → ${apres}`);
}

console.log(`\n${pass} réussis · ${fail} échoués\n`);
db.close();
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
