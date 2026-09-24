'use strict';
/* La fiche : titres tirés du contexte, fiches qui évoluent au lieu de
   s'empiler, habitudes mesurées. Aucun modèle appelé. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const APP = require('./apprentissage.js');
const MOI = require('./moi.js');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT, source TEXT, kind TEXT, ref TEXT,
    level TEXT, title TEXT, body TEXT, tags TEXT, meta TEXT DEFAULT '{}',
    occurred_at TEXT, created_at TEXT, hash TEXT, dup_count INTEGER DEFAULT 1, archived INTEGER DEFAULT 0);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, seq INTEGER, text TEXT, embedded INTEGER DEFAULT 0);`);
  APP.migrate(db);
  return db;
}
function echange(db, q, r, quand = new Date().toISOString()) {
  const e = APP.evenementEchange({ agent: 'qwen', question: q, reponse: r });
  const id = Number(db.prepare(`INSERT INTO entries(ns,source,kind,level,title,body,tags,meta,occurred_at,created_at,hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(e.ns, 'hub', e.kind, e.level, e.title, e.body, e.tags.join(' '), JSON.stringify(e.meta), quand, quand, q).lastInsertRowid);
  db.prepare(`INSERT INTO chunks(entry_id,seq,text,embedded) VALUES (?,0,?,1)`).run(id, e.title + '\n' + e.body);
  return id;
}

test('titres : un résumé du contexte remplace la question, partout', async () => {
  const db = base();
  const a = echange(db, 'et la tu peux voir si le workflow de quarantaine marche ?', 'Réparé : le nœud 4 reçoit {{ $trigger.device }}, workflow activé.');
  const b = echange(db, 'le hub est en ligne ?', 'Oui, 4 services en ligne.');
  let vu = '';
  const demander = async (consigne, texte) => {
    vu = texte;
    return JSON.stringify({ echanges: [
      { n: 1, titre: '« Hub en ligne, 4 services actifs. »', sujet: 'Hub' },
      { n: 2, titre: 'Workflow quarantaine réparé et activé', sujet: 'Workflows' },
    ] });
  };
  const r = await MOI.titrerEchanges(db, { demander });
  assert.equal(r.titres, 2);
  assert.equal(r.restants, 0);
  assert.match(vu, /quarantaine/);
  const ea = db.prepare(`SELECT title, meta FROM entries WHERE id=?`).get(a);
  assert.equal(ea.title, 'Workflow quarantaine réparé et activé');
  const meta = JSON.parse(ea.meta);
  assert.equal(meta.sujet, 'Workflows');
  assert.equal(meta.titre, 'auto');
  assert.match(meta.question, /quarantaine marche/, 'la question d’origine reste consultable');
  assert.equal(meta.agent, 'qwen', 'la méta existante est conservée');
  assert.equal(db.prepare(`SELECT title FROM entries WHERE id=?`).get(b).title, 'Hub en ligne, 4 services actifs', 'guillemets et point retirés');
  const ch = db.prepare(`SELECT text, embedded FROM chunks WHERE entry_id=?`).get(a);
  assert.ok(ch.text.startsWith('Workflow quarantaine réparé'), 'le morceau porte le nouveau titre');
  assert.equal(ch.embedded, 0, 'et repart à la vectorisation');
  // Déjà titrés : rien à refaire, aucun appel.
  let appels = 0;
  assert.equal((await MOI.titrerEchanges(db, { demander: async () => { appels++; return '{}'; } })).titres, 0);
  assert.equal(appels, 0);
});

test('titres : une question recopiée est refusée, retentée, puis abandonnée', async () => {
  const db = base();
  const id = echange(db, 'le hub est en ligne ?', 'Oui.');
  const demander = async () => JSON.stringify({ echanges: [{ n: 1, titre: 'le hub est en ligne ?', sujet: 'Hub' }] });
  for (let i = 0; i < 3; i++) await MOI.titrerEchanges(db, { demander });
  assert.equal(db.prepare(`SELECT title FROM entries WHERE id=?`).get(id).title, 'le hub est en ligne ?');
  assert.equal(MOI.aTitrer(db).length, 0, 'trois échecs : on ne le repropose plus au modèle');
  // Modèle absent : rien ne casse, rien n'est compté comme échec.
  const db2 = base(); echange(db2, 'question', 'réponse');
  const r = await MOI.titrerEchanges(db2, { demander: async () => { throw new Error('injoignable'); } });
  assert.match(r.raison, /injoignable/);
  assert.equal(MOI.aTitrer(db2).length, 1);
});

test('fiche : un trait précisé évolue, garde son historique et son crédit', () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'projets', valeur: 'Tu construis un hub de services.', confiance: 0.5 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'projets', valeur: 'Tu construis un hub de services.', confiance: 0.5 });
  const r = APP.poser(db, { agent: APP.COMMUN, cle: 'projets', valeur: 'Tu construis le Hub et SYNAPSE, testés sur une VM avant la prod.', confiance: 0.5, evolution: 'affine' });
  assert.equal(r.etat, 'affine');
  const [t] = APP.profil(db, 'x');
  assert.equal(t.n, 3, 'les confirmations passées comptent encore');
  assert.equal(t.precedent, 'Tu construis un hub de services.');
  assert.equal(t.etat, 'affine');
  assert.ok(t.confiance >= 0.5);
  const c = APP.poser(db, { agent: APP.COMMUN, cle: 'projets', valeur: 'Tu as abandonné le Hub.', confiance: 0.5, evolution: 'contredit' });
  assert.equal(c.etat, 'remplace');
  assert.equal(APP.profil(db, 'x')[0].n, 1, 'un changement d’avis repart de zéro');
});

test('consolidation : la fiche actuelle est donnée au modèle, qui la complète', async () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'facon_de_travailler', valeur: 'Tu testes avant de valider.', confiance: 0.5 });
  echange(db, 'je fais un test d’abord', 'OK');
  let recu = '';
  const demander = async (c, texte) => {
    recu = texte;
    return JSON.stringify({ traits: [{ portee: 'commun', cle: 'Façon de travailler', valeur: 'Tu testes sur la VM avant tout déploiement, et tu montres les résultats bruts.', confiance: 0.6, evolution: 'affine' }] });
  };
  await APP.consolider(db, { agent: 'qwen', demander });
  assert.match(recu, /FICHE ACTUELLE[\s\S]*facon_de_travailler : Tu testes avant de valider/);
  const t = APP.profil(db, 'qwen').find(x => x.cle === 'facon_de_travailler');
  assert.equal(t.etat, 'affine', 'même clé, même après normalisation du nom');
  assert.match(t.valeur, /VM/);
});

test('habitudes : instants bruts, sujets comptés', () => {
  const db = base();
  const id1 = echange(db, 'a', 'x', '2026-09-20T20:15:00.000Z');
  const id2 = echange(db, 'b', 'y', '2026-09-21T21:00:00.000Z');
  echange(db, 'c', 'z', '2026-09-22T09:00:00.000Z');
  MOI.renomme(db, id1, 'Premier titre utile', { titre: 'auto', sujet: 'Workflows' });
  MOI.renomme(db, id2, 'Second titre utile', { titre: 'auto', sujet: 'workflows' });
  const h = MOI.habitudes(db, { jours: 3650 });
  assert.equal(h.echanges, 3);
  assert.equal(h.moments.length, 3);
  assert.equal(h.sujets.length, 1, 'la casse ne sépare pas un sujet');
  assert.equal(h.sujets[0].n, 2);
  assert.equal(h.recents[0].title, 'Second titre utile');
});

test('consolidation : le modèle fait le ménage, sans toucher à ce qui a été dit', async () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'probleme', valeur: 'Répare les 2 workflows.', confiance: 0.8 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'langue', valeur: 'Français avec des fautes.', confiance: 0.8 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'outil', valeur: 'Tu utilises SYNAPSE.', confiance: 0.8 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'format', valeur: 'Un seul bloc de commandes.', confiance: 0.9, origine: 'declare' });
  echange(db, 'répare les workflows', 'ok');
  const demander = async () => JSON.stringify({
    traits: [{ portee: 'commun', cle: 'outils', valeur: 'Tu utilises SYNAPSE, le Hub et Ollama.', confiance: 0.6, evolution: 'nouveau' },
             { portee: 'commun', cle: 'langue', valeur: 'Tu écris en français.', confiance: 0.8, evolution: 'contredit' }],
    oublier: ['probleme', 'outil', 'format', 'langue', 'inconnue'],
  });
  const r = await APP.consolider(db, { agent: 'qwen', demander });
  const cles = APP.profil(db, 'qwen').map(t => t.cle).sort();
  assert.deepEqual(cles, ['format', 'langue', 'outils'], 'demande ponctuelle et doublon retirés, le déclaré reste');
  assert.deepEqual(r.oublies.map(o => o.cle).sort(), ['outil', 'probleme']);
  assert.equal(APP.profil(db, 'qwen').find(t => t.cle === 'langue').valeur, 'Tu écris en français.', 'un trait réécrit dans la même passe n’est pas oublié');
});

test('ménage : jugements retirés, doublons fusionnés, le déclaré intact', async () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'outil', valeur: 'Tu utilises SYNAPSE.', confiance: 0.8 });
  // outils → rejoint la clé existante au lieu d'en créer une seconde
  const r = APP.poser(db, { agent: APP.COMMUN, cle: 'outils', valeur: 'Tu utilises SYNAPSE et Ollama.', confiance: 0.8 });
  assert.equal(r.cle, 'outil');
  assert.equal(APP.poser(db, { agent: APP.COMMUN, cle: 'langue', valeur: 'Tu écris en français avec des fautes d’orthographe.' }).etat, 'refuse');
  db.prepare(`INSERT INTO profil(agent,cle,valeur,confiance,n,origine,cree_le,maj) VALUES ('commun','ecriture','Beaucoup de fautes de grammaire.',0.8,1,'distille','x','x')`).run();
  APP.poser(db, { agent: APP.COMMUN, cle: 'format_reponse', valeur: 'Réponses courtes.', confiance: 0.7 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'exigences', valeur: 'Tu veux du direct et du visuel.', confiance: 0.7 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'services_installes', valeur: 'Tu veux connaître les services installés.', confiance: 0.8 });
  APP.poser(db, { agent: APP.COMMUN, cle: 'commandes', valeur: 'Un seul bloc.', origine: 'declare', confiance: 0.9 });
  let vu = '';
  const m = await APP.menage(db, { demander: async (c, t) => { vu = t; return JSON.stringify({
    oublier: ['services_installes', 'commandes'],
    fusionner: [{ garder: 'exigences', retirer: ['format_reponse', 'commandes'], valeur: 'Tu veux des réponses courtes, directes et visuelles.' }],
  }); } });
  assert.ok(!/grammaire/.test(vu), 'le jugement est retiré avant même l’appel');
  const cles = APP.profil(db, 'x').map(t => t.cle).sort();
  assert.deepEqual(cles, ['commandes', 'exigences', 'outil']);
  const ex = APP.profil(db, 'x').find(t => t.cle === 'exigences');
  assert.match(ex.valeur, /courtes, directes et visuelles/);
  assert.equal(ex.etat, 'affine');
  assert.deepEqual(m.oublies.sort(), ['ecriture', 'services_installes']);
});

test('échange complété : le résultat réel remplace la promesse, et le titre est à refaire', async () => {
  const db = base();
  const id = echange(db, 'passe synapse sur kimi', 'Je vais modifier la connexion de Synapse.\nRésultat : aucune action — réponse seule, rien n’a été modifié');
  MOI.renomme(db, id, 'Synapse utilise maintenant Kimi via API', { titre: 'auto', sujet: 'SYNAPSE' });
  assert.equal(MOI.aTitrer(db).length, 0);
  MOI.remplaceCorps(db, id, 'Question : passe synapse sur kimi\nRéponse : ok\nRésultat : Modifier les réglages de synapse : appliqué, service relancé');
  const e = db.prepare(`SELECT body, meta FROM entries WHERE id=?`).get(id);
  assert.match(e.body, /appliqué, service relancé/);
  assert.equal(JSON.parse(e.meta).titre, undefined, 'repart au titrage');
  assert.equal(JSON.parse(e.meta).sujet, 'SYNAPSE', 'le reste de la méta est gardé');
  assert.equal(MOI.aTitrer(db).length, 1);
  const ch = db.prepare(`SELECT text, embedded FROM chunks WHERE entry_id=?`).all(id);
  assert.ok(ch.length && ch.every(c => /appliqué/.test(c.text) && c.embedded === 0));
  // La consigne de titrage distingue la demande du fait.
  assert.match(MOI.CONSIGNE_TITRES, /« Résultat » fait foi/);
  assert.match(MOI.CONSIGNE_TITRES, /demandé, non fait/);
});

test('migration : les anciens titres automatiques sont refaits, une seule fois', () => {
  const db = base();
  const a = echange(db, 'q1', 'r1'); const b = echange(db, 'q2', 'r2');
  MOI.renomme(db, a, 'Titre affirmatif douteux', { titre: 'auto' });
  db.prepare(`UPDATE entries SET title='Titre posé à la main' WHERE id=?`).run(b);
  assert.equal(MOI.migrer(db), 1);
  assert.equal(MOI.aTitrer(db).map(r => r.id).sort().join(), [a, b].sort().join(), 'le titre à la main n’avait pas de marque auto : il était déjà à titrer');
  MOI.renomme(db, a, 'Nouveau titre honnête', { titre: 'auto' });
  assert.equal(MOI.migrer(db), 0, 'jamais deux fois');
});
