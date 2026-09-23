'use strict';
/* ============================================================
   Banc de test de la mémoire opérationnelle.

   Le test qui décide de tout est le dernier : le lookup est appelé
   AVANT chaque décision de TRIAGE, sur le chemin critique d'une
   alerte en cours. Au-delà de 100 ms au p95, autant appeler le LLM
   directement — la mémoire coûterait plus qu'elle ne rapporte.

   node src/incidents.test.js
   ============================================================ */

const fs = require('node:fs');
const { open } = require('./db.js');
const I = require('./incidents.js');

const FILE = '/tmp/incidents-test.db';
try { for (const s of ['', '-wal', '-shm']) fs.unlinkSync(FILE + s); } catch {}

const db = open(FILE);
I.migrate(db);

let pass = 0, fail = 0;
function t(nom, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + nom); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + nom + (detail ? '  → ' + detail : '')); }
}
const iso = d => new Date(Date.now() - d * 86400000).toISOString();
const head = s => console.log('\n\x1b[1m' + s + '\x1b[0m');

/* ---------- signature ---------- */
head('SIGNATURE — stable dans le temps, discriminante sur la panne');
{
  const base = { alert_key: 'proxy_502', service: 'serveur-web', host: 'srv-app-01' };
  const sig = x => I.signatureOf(x);
  const a = sig({ ...base, symptom: '502 upstream 8110 injoignable' });
  const b = sig({ ...base, symptom: '502 upstream 8110 injoignable à 2026-09-02T21:14:00Z, cid 3f9a1c2e8b7d, 47s' });
  const c = sig({ ...base, symptom: '502 upstream 8877 injoignable, ticket CHT-412' });
  const d = sig({ ...base, symptom: '504 upstream injoignable' });
  const e = sig({ ...base, host: 'srv-data-01', symptom: '502 upstream 8110 injoignable' });

  t('horodatage, id conteneur et durée ignorés', a === b);
  t('port éphémère et numéro de ticket ignorés', a === c);
  t('502 et 504 restent deux incidents distincts', a !== d);
  t('hôte différent, signature différente', a !== e);
}

/* ---------- validation ---------- */
head('VALIDATION — le payload vient d\'un LLM, aucune confiance');
{
  t('alert_key manquant refusé',  !!I.validate({ service: 'x', outcome: 'resolved' }).error);
  t('outcome inconnu refusé',     !!I.validate({ alert_key: 'a', service: 'x', outcome: 'peut-etre' }).error);
  t('origin inconnu refusé',      !!I.validate({ alert_key: 'a', service: 'x', outcome: 'resolved', origin: 'magie' }).error);
  t('generated sans command refusé',
    !!I.validate({ alert_key: 'a', service: 'x', outcome: 'resolved', origin: 'generated' }).error);

  const long = I.validate({ alert_key: 'a', service: 'x', outcome: 'resolved',
                            symptom: 'z'.repeat(99999) });
  t('champ texte démesuré tronqué', !long.error && long.value.symptom.length <= 2000,
    long.error || long.value.symptom.length);

  const argv = I.validate({ alert_key: 'a', service: 'x', outcome: 'resolved',
                            origin: 'generated', command: Array(500).fill('x'.repeat(9999)) });
  const cmd = JSON.parse(argv.value.command);
  t('argv borné en nombre et en longueur', cmd.length <= 40 && cmd[0].length <= 500);
}

/* ---------- idempotence ---------- */
head('IDEMPOTENCE — le rejeu ne duplique pas');
{
  const p = { alert_key: 'test_idem', service: 'svc', host: 'h1',
              symptom: 'panne', resolution: 'fix', outcome: 'resolved',
              occurred_at: iso(5) };
  const a = I.record(db, p), b = I.record(db, p);
  t('deux envois identiques, une seule ligne', a.id === b.id && b.duplicate === true);

  const c = I.record(db, { ...p, occurred_at: iso(4) });
  t('même signature, autre horodatage : nouvelle occurrence', c.id !== a.id);
}

/* ---------- cascade ---------- */
head('CASCADE — chaque niveau rend le bon résultat');
{
  for (const d of [30, 20, 10]) {
    I.record(db, { alert_key: 'casc_a', service: 'svc_a', host: 'h1',
      symptom: '502 upstream injoignable', root_cause: 'conteneur arrêté après OOM',
      resolution: 'restart_container', outcome: 'resolved', occurred_at: iso(d) });
  }
  I.record(db, { alert_key: 'casc_a', service: 'svc_b', host: 'h9',
    symptom: '502 ailleurs', resolution: 'reload', outcome: 'resolved', occurred_at: iso(8) });

  const l0 = I.lookup(db, { alert_key: 'casc_a', service: 'svc_a', host: 'h1',
                            symptom: '502 upstream injoignable' });
  t('L0 sur signature identique, similarité 1.0', l0.level === 'L0' && l0.similarity === 1, l0.level);

  const l1 = I.lookup(db, { alert_key: 'casc_a', service: 'svc_a', host: 'h1',
                            symptom: 'tout autre chose sans marqueur commun' });
  t('L1 sur alert_key + service', l1.level === 'L1' && l1.similarity === 0.9, l1.level);

  const l2 = I.lookup(db, { alert_key: 'casc_a', service: 'svc_inconnu', host: 'h5',
                            symptom: 'autre' });
  t('L2 sur alert_key seul, service différent', l2.level === 'L2', l2.level);

  const vide = I.lookup(db, { alert_key: 'jamais_vu', service: 'nulle_part', symptom: 'rien' });
  t('aucun résultat plutôt qu\'un faux positif', vide.match === false);

  t('cause connue restituée', l0.known_cause === 'conteneur arrêté après OOM');
}

/* ---------- failed_fixes et dépréciation ---------- */
head('DÉPRÉCIATION — le dernier résultat pèse plus que l\'ancien');
{
  const base = { alert_key: 'degrad', service: 'svc_d', host: 'h1',
                 symptom: '502 upstream injoignable', root_cause: 'OOM' };
  /* reload_caddy marchait, puis a cessé. restart_container a pris le relais. */
  for (const [d, res, out] of [[40,'reload_caddy','resolved'], [34,'reload_caddy','resolved'],
                               [24,'reload_caddy','failed'],   [18,'reload_caddy','failed'],
                               [12,'restart_container','resolved'], [6,'restart_container','resolved'],
                               [1,'restart_container','resolved']]) {
    I.record(db, { ...base, resolution: res, outcome: out, occurred_at: iso(d) });
  }
  const r = I.lookup(db, base);

  t('le fix recommandé est celui qui marche AUJOURD\'HUI',
    r.known_fix === 'restart_container', r.known_fix);
  t('un fix qui marchait puis a échoué est signalé',
    r.failed_fixes.includes('reload_caddy'), JSON.stringify(r.failed_fixes));
  t('un fix signalé n\'est jamais recommandé',
    !r.failed_fixes.includes(r.known_fix));

  /* success_rate sur fenêtre glissante, pas sur tout l'historique */
  const court = I.lookup(db, base, { window: 3 });
  const long  = I.lookup(db, base, { window: 50 });
  t('success_rate sur les N dernières, pas sur tout',
    court.success_rate > long.success_rate,
    `fenêtre 3 = ${court.success_rate} · fenêtre 50 = ${long.success_rate}`);
}

/* ---------- renforcement ---------- */
head('RENFORCEMENT — une signature vue N fois est UN nœud fort');
{
  const sig = I.signatureOf({ alert_key: 'degrad', service: 'svc_d', host: 'h1',
                              symptom: '502 upstream injoignable' });
  const row = db.prepare(`SELECT occurrences, strength FROM incident_signatures WHERE signature=?`).get(sig);
  t('occurrences comptées sur une seule ligne', row && row.occurrences === 7, row && row.occurrences);
  t('la force reste bornée', row && row.strength >= 0.1 && row.strength <= 10, row && row.strength);
}

/* ---------- rétention ---------- */
head('RÉTENTION — 12 mois en détail, generated conservé indéfiniment');
{
  I.record(db, { alert_key: 'vieux', service: 'svc_v', host: 'h1', symptom: 'ancienne panne',
    resolution: 'fix_v', outcome: 'resolved', occurred_at: iso(500) });
  I.record(db, { alert_key: 'vieux_gen', service: 'svc_v', host: 'h1', symptom: 'commande ad-hoc',
    resolution: 'script', outcome: 'resolved', origin: 'generated',
    command: ['docker', 'restart', 'relay'], occurred_at: iso(500) });

  const r = I.retention(db, 12);
  const resteCatalog = db.prepare(
    `SELECT count(*) n FROM incidents WHERE alert_key='vieux'`).get().n;
  const resteGen = db.prepare(
    `SELECT count(*) n FROM incidents WHERE alert_key='vieux_gen'`).get().n;
  const rollup = db.prepare(`SELECT count(*) n FROM incident_rollup`).get().n;

  t('instances anciennes supprimées', resteCatalog === 0, resteCatalog);
  t('origin=generated conservé pour l\'audit', resteGen === 1, resteGen);
  t('synthèse écrite avant suppression', rollup > 0, rollup);
}

/* ---------- performance ---------- */
head('PERFORMANCE — chemin critique, budget 100 ms au p95');
{
  const N = 10000;
  const services = ['serveur-web','supervision','tickets','collecteur','supervision','forge','oracle','api-interne'];
  const alertes  = ['proxy_502','oom_kill','disk_full','cert_expired','upstream_down','dns_fail'];
  const fixes    = ['restart_container','reload_caddy','clear_cache','renew_cert','restart_service'];

  const t0 = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    I.record(db, {
      alert_key: alertes[i % alertes.length],
      service:   services[i % services.length],
      host:      'h' + (i % 12),
      symptom:   `${500 + (i % 5)} sur ${services[i % services.length]}, upstream ${8000 + i} injoignable`,
      root_cause: 'cause ' + (i % 40),
      resolution: fixes[i % fixes.length],
      outcome:   i % 4 === 0 ? 'failed' : 'resolved',
      occurred_at: new Date(Date.now() - (i % 300) * 86400000 - i * 1000).toISOString()
    });
  }
  db.exec('COMMIT');
  const total = db.prepare(`SELECT count(*) n FROM incidents`).get().n;
  console.log(`  ${N} incidents insérés en ${Date.now() - t0} ms · ${total} en base`);

  const mesures = [];
  for (let i = 0; i < 600; i++) {
    const q = {
      alert_key: alertes[i % alertes.length],
      service:   services[i % services.length],
      host:      'h' + (i % 12),
      symptom:   `${500 + (i % 5)} sur ${services[i % services.length]}, upstream ${9000 + i} injoignable`
    };
    const a = performance.now();
    I.lookup(db, q);
    mesures.push(performance.now() - a);
  }
  mesures.sort((x, y) => x - y);
  const p = q => mesures[Math.floor(mesures.length * q)];
  console.log(`  p50 ${p(.5).toFixed(1)} ms · p95 ${p(.95).toFixed(1)} ms · p99 ${p(.99).toFixed(1)} ms · max ${mesures[mesures.length-1].toFixed(1)} ms`);
  t('p95 sous 100 ms sur 10 000 incidents', p(.95) < 100, p(.95).toFixed(1) + ' ms');

  /* Le pire cas est celui qui descend jusqu'au L3 textuel. */
  const m3 = [];
  for (let i = 0; i < 120; i++) {
    const a = performance.now();
    I.lookup(db, { alert_key: 'inconnu_' + i, service: 'inconnu_' + i,
                   symptom: 'timeout refused unreachable denied ' + i });
    m3.push(performance.now() - a);
  }
  m3.sort((x, y) => x - y);
  const p95_3 = m3[Math.floor(m3.length * .95)];
  console.log(`  L3 textuel : p95 ${p95_3.toFixed(1)} ms · max ${m3[m3.length-1].toFixed(1)} ms`);
  t('le L3 respecte aussi le budget', p95_3 < 100, p95_3.toFixed(1) + ' ms');
}

/* ---------- statistiques ---------- */
head('STATISTIQUES');
{
  const s = I.stats(db, 30);
  t('services instables classés', Array.isArray(s.services_instables) && s.services_instables.length > 0);
  t('fixes fiables classés', Array.isArray(s.fixes_fiables));
  t('détection des fixes en dégradation', Array.isArray(s.fixes_en_degradation));
}

console.log(`\n${pass} réussis · ${fail} échoués\n`);
db.close();
process.exit(fail ? 1 : 0);
