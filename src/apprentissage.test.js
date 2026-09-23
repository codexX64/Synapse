'use strict';
/* Tests de l'apprentissage : profil distillé, corrections, briefing.
   Base en mémoire, aucun modèle appelé — la consolidation reçoit une
   fausse fonction de synthèse, ce qui permet de tester l'extraction de
   traits sans dépendre d'un Ollama qui tourne. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const APP = require('./apprentissage.js');

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT, source TEXT, kind TEXT, ref TEXT,
    level TEXT, title TEXT, body TEXT, tags TEXT, meta TEXT DEFAULT '{}',
    occurred_at TEXT, created_at TEXT, hash TEXT, dup_count INTEGER DEFAULT 1, archived INTEGER DEFAULT 0)`);
  APP.migrate(db);
  return db;
}

const jours = n => new Date(Date.now() - n * 86400000).toISOString();

test('profil : commun et agent ne se mélangent jamais', () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'langue', valeur: 'Réponds en français.', confiance: 0.9 });
  APP.poser(db, { agent: 'kimi', cle: 'angle_mort', valeur: 'Tu confonds les ports du Hub.', confiance: 0.6 });
  APP.poser(db, { agent: 'qwen', cle: 'angle_mort', valeur: 'Tu inventes des noms de modèles.', confiance: 0.6 });

  const kimi = APP.profil(db, 'kimi');
  const qwen = APP.profil(db, 'qwen');

  // Le trait commun est vu par les deux : un fait ne change pas de modèle.
  assert.ok(kimi.some(t => t.portee === 'commun' && /français/.test(t.valeur)));
  assert.ok(qwen.some(t => t.portee === 'commun' && /français/.test(t.valeur)));

  // La leçon de l'un n'atteint jamais l'autre.
  assert.ok(kimi.some(t => t.portee === 'agent' && /ports/.test(t.valeur)));
  assert.ok(!qwen.some(t => /ports/.test(t.valeur)));
  assert.ok(qwen.some(t => t.portee === 'agent' && /noms de modèles/.test(t.valeur)));

  // Le commun passe en premier : il prime sur la béquille du modèle.
  assert.equal(kimi[0].portee, 'commun');
});

test('profil : confirmer renforce, contredire remplace sans effacer d’un coup', () => {
  const db = base();
  APP.poser(db, { agent: 'k', cle: 'editeur', valeur: 'Il utilise neovim.', confiance: 0.5 });
  const c1 = APP.profil(db, 'k')[0].confiance;
  const r = APP.poser(db, { agent: 'k', cle: 'editeur', valeur: 'il utilise Neovim', confiance: 0.5 });
  assert.equal(r.etat, 'confirme');
  assert.ok(APP.profil(db, 'k')[0].confiance > c1, 'une confirmation renforce');
  assert.ok(APP.profil(db, 'k')[0].confiance < 1, 'jamais la certitude');

  const r2 = APP.poser(db, { agent: 'k', cle: 'editeur', valeur: 'Il est passé à Zed.', confiance: 0.9 });
  assert.equal(r2.etat, 'remplace');
  const t = APP.profil(db, 'k')[0];
  assert.match(t.valeur, /Zed/);
  assert.ok(t.confiance <= 0.7, 'une observation isolée ne devient pas une certitude');
});

test('profil : ce que l’utilisateur a déclaré résiste à ce que le modèle devine', () => {
  const db = base();
  APP.poser(db, { agent: 'k', cle: 'ton', valeur: 'Il veut des réponses courtes.', origine: 'declare', confiance: 0.9 });
  const r = APP.poser(db, { agent: 'k', cle: 'ton', valeur: 'Il aime les explications longues.', origine: 'distille', confiance: 0.9 });
  assert.equal(r.etat, 'garde');
  assert.match(APP.profil(db, 'k')[0].valeur, /courtes/);
});

test('profil : un trait distillé s’efface avec le temps, un trait déclaré non', () => {
  const db = base();
  APP.poser(db, { agent: 'k', cle: 'vieux', valeur: 'Préférence de mars.', confiance: 0.6 });
  APP.poser(db, { agent: 'k', cle: 'dit', valeur: 'Dit explicitement.', confiance: 0.6, origine: 'declare' });
  db.prepare(`UPDATE profil SET maj=? WHERE agent='k'`).run(jours(720));

  const vus = APP.profil(db, 'k').map(t => t.cle);
  assert.ok(!vus.includes('vieux'), 'deux ans sans confirmation : oublié');
  assert.ok(vus.includes('dit'), 'ce qui a été dit ne s’use pas');
});

test('profil : le plafond jette les traits les plus faibles, pas les plus forts', () => {
  const db = base();
  for (let i = 0; i < APP.MAX_TRAITS + 6; i++) {
    APP.poser(db, { agent: 'k', cle: `t${i}`, valeur: `trait ${i}`, confiance: i === 0 ? 0.95 : 0.2 });
  }
  const n = db.prepare(`SELECT COUNT(*) c FROM profil WHERE agent='k'`).get().c;
  assert.ok(n <= APP.MAX_TRAITS);
  assert.ok(db.prepare(`SELECT 1 FROM profil WHERE agent='k' AND cle='t0'`).get(), 'le trait sûr survit');
});

test('corrections : comptées et non dupliquées, retrouvées sur une question proche', () => {
  const db = base();
  APP.corriger(db, { agent: 'k', question: 'quel modèle pour le triage des alertes', correction: 'qwen3:14b, jamais un nom inventé', faux: 'llama3' });
  const c = APP.corriger(db, { agent: 'k', question: 'Quel modèle pour le triage des alertes ?', correction: 'qwen3:14b, jamais un nom inventé' });
  assert.equal(c.n, 2, 'la même correction compte au lieu de se dupliquer');

  const proches = APP.correctionsPour(db, 'k', 'quel modèle choisir pour le triage des alertes');
  assert.equal(proches.length, 1);
  assert.match(proches[0].correction, /qwen3:14b/);

  // Hors sujet : mieux vaut rien qu'une correction qui déroute.
  assert.deepEqual(APP.correctionsPour(db, 'k', 'comment sauvegarder la base postgres'), []);
  // Et jamais celles d'un autre modèle.
  assert.deepEqual(APP.correctionsPour(db, 'autre', 'quel modèle pour le triage des alertes'), []);
});

test('briefing : profil, corrections et mémoire en un appel, avec le texte prêt', async () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'format', valeur: 'Donne les commandes en un seul bloc.', confiance: 0.8 });
  APP.corriger(db, { agent: 'k', question: 'quel modèle', correction: 'Lire la liste du service.' });

  const b = await APP.brief(db, {
    agent: 'k', q: 'quel modèle pour le triage',
    search: async () => ({ hits: [{ title: 'Modèles disponibles', snippet: 'qwen3:14b', level: 'L1', occurred_at: jours(2), score: 0.7 }] }),
  });

  assert.equal(b.agent, 'k');
  assert.equal(b.profil.length, 1);
  assert.equal(b.corrections.length, 1);
  assert.equal(b.memoire.length, 1);
  assert.equal(b.tronque, false);

  const texte = APP.briefTexte(b);
  assert.match(texte, /un seul bloc/);
  assert.match(texte, /Lire la liste du service/);
});

test('briefing : une mémoire lente est absente, jamais attendue', async () => {
  const db = base();
  const b = await APP.brief(db, {
    agent: 'k', q: 'une question', budget: 30,
    search: () => new Promise(r => setTimeout(() => r({ hits: [{ title: 'trop tard' }] }), 400)),
  });
  assert.equal(b.tronque, true);
  assert.deepEqual(b.memoire, []);
  assert.ok(b.ms < 300, 'le budget est tenu');
});

test('briefing : une recherche en panne ne casse pas le briefing', async () => {
  const db = base();
  APP.poser(db, { agent: APP.COMMUN, cle: 'x', valeur: 'Un trait.', confiance: 0.8 });
  const b = await APP.brief(db, { agent: 'k', q: 'question', search: async () => { throw new Error('hors service'); } });
  assert.deepEqual(b.memoire, []);
  assert.equal(b.profil.length, 1, 'le profil reste servi');
});

test('extraction : le JSON encadré de prose est récupéré, le reste est écarté', () => {
  const ok = APP.extraireTraits('Voici :\n```json\n{"traits":[{"portee":"commun","cle":"langue","valeur":"Réponds en français.","confiance":0.9}]}\n```\nVoilà.');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].cle, 'langue');

  assert.deepEqual(APP.extraireTraits('je ne sais pas'), []);
  assert.deepEqual(APP.extraireTraits('{"traits":[{"cle":"","valeur":"vide"}]}'), []);
  // Une portée inconnue retombe sur le commun plutôt que d'être perdue.
  assert.equal(APP.extraireTraits('{"traits":[{"portee":"nimporte","cle":"a","valeur":"b"}]}')[0].portee, 'commun');
});

test('consolidation : les échanges deviennent des traits, et ne sont relus qu’une fois', async () => {
  const db = base();
  const ins = db.prepare(`INSERT INTO entries(ns,source,kind,level,title,body,tags,meta,occurred_at,created_at,hash)
                          VALUES ('shared','hub','echange','L0',?,?,'echange','{"agent":"k"}',?,?,?)`);
  for (let i = 0; i < 3; i++) ins.run(`question ${i}`, `Question : q${i}\nRéponse : r${i}`, jours(i), jours(i), `h${i}`);

  let appels = 0;
  const demander = async () => {
    appels++;
    return JSON.stringify({ traits: [
      { portee: 'commun', cle: 'format_commandes', valeur: 'Donne les commandes en un seul bloc.', confiance: 0.7 },
      { portee: 'agent', cle: 'angle_mort', valeur: 'Tu pars à côté sur les questions de ports.', confiance: 0.5 },
    ] });
  };

  const r1 = await APP.consolider(db, { agent: 'k', demander });
  assert.equal(r1.lus, 3);
  assert.equal(r1.traits.length, 2);

  // Le trait commun est visible par un autre modèle, pas la leçon.
  assert.ok(APP.profil(db, 'autre').some(t => /un seul bloc/.test(t.valeur)));
  assert.ok(!APP.profil(db, 'autre').some(t => /ports/.test(t.valeur)));

  // Rien de neuf : le modèle n'est même pas appelé.
  const r2 = await APP.consolider(db, { agent: 'k', demander });
  assert.equal(r2.lus, 0);
  assert.equal(appels, 1, 'la même fournée n’est pas relue');
});

test('consolidation : sans modèle, elle le dit et ne perd rien', async () => {
  const db = base();
  db.prepare(`INSERT INTO entries(ns,source,kind,level,title,body,tags,meta,occurred_at,created_at,hash)
              VALUES ('shared','hub','echange','L0','q','b','echange','{"agent":"k"}',?,?,'h')`).run(jours(0), jours(0));
  const r = await APP.consolider(db, { agent: 'k', demander: null });
  assert.equal(r.lus, 0);
  assert.match(r.raison, /aucun modèle/);
  // Le repère n'a pas bougé : la fournée sera relue quand un modèle existera.
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM consolidation`).get().c, 0);
});

test('consolidation : un modèle en panne ne fait pas sauter la fournée', async () => {
  const db = base();
  db.prepare(`INSERT INTO entries(ns,source,kind,level,title,body,tags,meta,occurred_at,created_at,hash)
              VALUES ('shared','hub','echange','L0','q','b','echange','{"agent":"k"}',?,?,'h')`).run(jours(0), jours(0));
  const r = await APP.consolider(db, { agent: 'k', demander: async () => { throw new Error('injoignable'); } });
  assert.match(r.raison, /injoignable/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM consolidation`).get().c, 0, 'la fournée sera reprise');
});

test('échange : l’événement respecte le contrat d’ingestion', () => {
  const e = APP.evenementEchange({ agent: 'Qwen 3 — cortex', question: 'comment relancer le hub', reponse: 'docker compose up -d' });
  assert.equal(e.kind, 'echange');
  assert.ok(Array.isArray(e.tags), 'les étiquettes sont un tableau, pas une chaîne');
  assert.ok(e.tags.includes('agent:qwen-3-cortex'));
  assert.ok(e.title.length && e.title.length <= 160);
  assert.match(e.body, /Question :/);
  assert.match(e.body, /Réponse :/);
});

test('nom d’agent : deux écritures du même modèle donnent le même espace', () => {
  assert.equal(APP.agentId('Qwen3 : 14b'), APP.agentId('qwen3-14b'));
  assert.equal(APP.agentId(''), 'inconnu');
  assert.equal(APP.agentId(null), 'inconnu');
});
