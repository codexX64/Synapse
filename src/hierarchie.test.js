'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('./db');
const ingest = require('./ingest');
const H = require('./hierarchie');

const base = () => open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-h-')), 'h.db'));
const ecrire = (db, source, evt, { src = {}, ...o } = {}) => {
  const r = ingest.insert(db, { ns: 'shared', kind: 'note', ...evt }, source);
  assert.ok(r.ok, JSON.stringify(r));
  return { id: r.id, c: H.classer(db, r.id, { src: { name: source, ...src }, ...o }) };
};
const membre = (db, nom, compte = H.PRINCIPAL) => db.prepare(`SELECT * FROM h_cerveaux WHERE compte=? AND membre=?`).get(compte, nom);
const commun = (db, nom, compte = H.PRINCIPAL) => db.prepare(`SELECT c.* FROM h_cerveaux c JOIN h_domaines d ON d.id=c.domaine_id WHERE c.genre='commun' AND d.nom=? AND c.compte=?`).get(nom, compte);
const fiches = (db, kind) => db.prepare(`SELECT * FROM entries WHERE kind=?`).all(kind);
const liens = (db, id, rel) => db.prepare(`SELECT to_id FROM links WHERE from_id=? AND relation=? ORDER BY to_id`).all(id, rel).map(l => l.to_id);

test('placement : une IA va dans le domaine IA, un service dans HomeLab, chacun son cerveau', () => {
  const db = base();
  const a = ecrire(db, 'claude-code', { title: 'La VM 102 est sur le VLAN 30', body: 'vu en session' });
  const b = ecrire(db, 'proxmox', { title: 'vm 205 démarrée', body: '' });
  assert.equal(membre(db, 'claude-code').domaine_id, commun(db, 'IA').domaine_id);
  assert.equal(membre(db, 'proxmox').domaine_id, commun(db, 'HomeLab').domaine_id);
  assert.deepEqual(a.c.cles.sort(), ['vlan:30', 'vm:102']);
  assert.equal(a.c.importance, 20);
  assert.deepEqual(a.c.remontees, [], 'une note banale reste dans son cerveau');
  assert.equal(b.c.cerveau, membre(db, 'proxmox').id);
  assert.equal(H.classer(db, a.id, { src: { name: 'claude-code' } }), null, 'une entrée se range une seule fois');
});

test('convergence : deux IA sur la même chose font une fiche commune qui cite les deux', () => {
  const db = base();
  const a = ecrire(db, 'claude-code', { title: 'La VM 102 tourne sur le VLAN Ghost', body: 'VLAN 66' });
  assert.equal(fiches(db, 'fiche.commune').length, 0, 'une seule IA : pas de fiche');
  const b = ecrire(db, 'kimi', { title: 'Le pare-feu filtre le VLAN 66', body: '' });
  const f = fiches(db, 'fiche.commune');
  assert.equal(f.length, 1);
  assert.equal(f[0].title, 'Fiche commune · vlan:66');
  assert.deepEqual(liens(db, f[0].id, 'consolide'), [a.id, b.id]);
  assert.match(f[0].body, /claude-code : La VM 102/);
  assert.match(f[0].body, /kimi : Le pare-feu/);
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(f[0].id).cerveau_id, commun(db, 'IA').id);
  // Une troisième IA : la fiche grossit, elle ne se double pas.
  const c = ecrire(db, 'ollama', { title: 'Le VLAN 66 sort par Mullvad', body: '' });
  const f2 = fiches(db, 'fiche.commune');
  assert.equal(f2.length, 1);
  assert.deepEqual(liens(db, f2[0].id, 'consolide'), [a.id, b.id, c.id]);
  assert.match(f2[0].body, /ollama/);
  // Les sources restent dans leur propre cerveau.
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(a.id).cerveau_id, membre(db, 'claude-code').id);
});

test('une même source qui répète ne converge pas avec elle-même', () => {
  const db = base();
  ecrire(db, 'kimi', { title: 'VLAN 40 : caméras', body: '' });
  ecrire(db, 'kimi', { title: 'VLAN 40 : encore les caméras', body: '' });
  assert.equal(fiches(db, 'fiche.commune').length, 0);
});

test('corrélation : une fiche IA et une fiche HomeLab sur la même clé font une fiche dans le global', () => {
  const db = base();
  ecrire(db, 'claude-code', { title: 'IP 10.30.10.11 = VM hub', body: '' });
  ecrire(db, 'kimi', { title: 'Le hub répond sur 10.30.10.11', body: '' });
  ecrire(db, 'proxmox', { title: 'Bail DHCP 10.30.10.11', body: '' });
  assert.equal(fiches(db, 'fiche.correlation').length, 0, 'une seule fiche commune : rien à corréler');
  ecrire(db, 'mapmylan', { title: 'Appareil vu en 10.30.10.11', body: '' });
  const communes = fiches(db, 'fiche.commune');
  assert.equal(communes.length, 2);
  const cor = fiches(db, 'fiche.correlation');
  assert.equal(cor.length, 1);
  assert.equal(cor[0].title, 'Corrélation · ip:10.30.10.11');
  assert.deepEqual(liens(db, cor[0].id, 'correle'), communes.map(f => f.id).sort((x, y) => x - y));
  const g = H.globalDe(db, H.PRINCIPAL);
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(cor[0].id).cerveau_id, g.id);
});

test('tamis : importance, étiquette forcée, étiquette interdite', () => {
  const db = base();
  const d = ecrire(db, 'claude-code', { kind: 'decision.archi', title: 'On garde SQLite', body: '' });
  assert.deepEqual(d.c.remontees.map(r => [r.regle, r.statut]), [['importance', 'faite']], 'une décision monte au commun, pas au global');
  const s = ecrire(db, 'proxmox', { title: 'Port SSH ouvert', body: '', tags: ['decision'] });
  assert.deepEqual(s.c.remontees.map(r => r.regle), ['etiquette']);
  const dom = ecrire(db, 'vigie', { title: 'Note de veille', body: '', tags: ['securite'] });
  assert.deepEqual(dom.c.remontees, [], 'une étiquette de domaine ne force rien');
  const x = ecrire(db, 'proxmox', { kind: 'decision.x', title: 'Décision simulée', body: '', tags: ['simulation'] });
  assert.deepEqual(x.c.remontees, []);
  const forte = ecrire(db, 'kimi', { title: 'Note', body: '' }, { importance: 95 });
  assert.equal(forte.c.importance, 95);
  assert.equal(forte.c.remontees.length, 1);
});

test('remontée à valider : rien ne monte avant le geste humain', () => {
  const db = base();
  H.globalDe(db, H.PRINCIPAL);
  H.regler(db, commun(db, 'IA').id, { remontee: 'valider' });
  const d = ecrire(db, 'kimi', { kind: 'decision.x', title: 'Choix du modèle', body: '' });
  assert.deepEqual(d.c.remontees.map(r => r.statut), ['a_valider']);
  const r = db.prepare(`SELECT id FROM h_remontees WHERE entry_id=?`).get(d.id);
  assert.equal(H.valider(db, r.id, true).statut, 'faite');
  assert.equal(H.valider(db, r.id, true), null, 'déjà tranchée');
  assert.throws(() => H.regler(db, commun(db, 'IA').id, { remontee: 'n-importe' }));
});

test('sous-domaines : Connaissance/Réseau remonte par Connaissance jusqu\'au global', () => {
  const db = base();
  const a = ecrire(db, 'notes-reseau', { tags: ['decision'], title: 'Segmenter les IoT', body: '' }, { domaine: 'Connaissance/Réseau' });
  const reseau = commun(db, 'Réseau'), conn = commun(db, 'Connaissance');
  const dReseau = db.prepare(`SELECT * FROM h_domaines WHERE id=?`).get(reseau.domaine_id);
  assert.equal(dReseau.parent_id, conn.domaine_id);
  assert.equal(H.parentDe(db, reseau).id, conn.id);
  assert.deepEqual(a.c.remontees.map(r => r.vers), [reseau.id, conn.id], 'étiquette forcée à chaque commun ; le global garde son seuil');
  assert.equal(H.domaineChemin(db, H.PRINCIPAL, '../etc'), null, 'un nom de domaine est contrôlé');
});

test('accès : son cerveau en entier, les fiches au-dessus, rien chez une autre IA hors projet', () => {
  const db = base();
  const a = ecrire(db, 'claude-code', { title: 'VLAN 66 pour Arch', body: '', tags: ['projet:hub'] });
  const b = ecrire(db, 'kimi', { title: 'VLAN 66 filtré', body: '', tags: ['projet:hub'] });
  const k2 = ecrire(db, 'kimi', { title: 'Note privée de kimi', body: '' });
  const cc = { name: 'claude-code', scope: 'read+write' };
  assert.deepEqual(H.acces(db, cc, membre(db, 'claude-code')), { tout: true });
  assert.deepEqual(H.acces(db, cc, commun(db, 'IA')), { fiches: true });
  assert.equal(H.acces(db, cc, membre(db, 'kimi')), null);
  const r = H.chercher(db, cc, { cerveau: commun(db, 'IA').id, q: 'vlan', monter: false });
  assert.ok(r.hits.length && r.hits.every(h => h.kind.startsWith('fiche.')), JSON.stringify(r));
  assert.equal(H.chercher(db, cc, { cerveau: membre(db, 'kimi').id, q: 'vlan' }).erreur, 403);
  // Projet partagé : les entrées étiquetées du projet, rien d'autre.
  const p = H.creerProjet(db, H.PRINCIPAL, 'hub', [membre(db, 'claude-code').id, membre(db, 'kimi').id]);
  assert.equal(p.etiquette, 'projet:hub');
  const vue = H.chercher(db, cc, { cerveau: membre(db, 'kimi').id, q: '', monter: false });
  assert.deepEqual(vue.hits.map(h => h.id), [b.id]);
  assert.ok(!vue.hits.some(h => h.id === k2.id));
  db.prepare(`UPDATE h_projets SET clos=? WHERE id=?`).run(new Date().toISOString(), p.id);
  assert.equal(H.acces(db, cc, membre(db, 'kimi')), null, 'projet clos : plus d\'accès croisé');
  assert.ok(a.id);
});

test('recherche qui monte : rien dans son cerveau, trouvé au-dessus', () => {
  const db = base();
  ecrire(db, 'claude-code', { title: 'Rien à voir', body: '' });
  ecrire(db, 'kimi', { title: 'Mullvad sur VLAN 66', body: '' });
  ecrire(db, 'ollama', { title: 'Tor aussi sur VLAN 66', body: '' });
  const r = H.chercher(db, { name: 'claude-code', scope: 'read' }, { cerveau: membre(db, 'claude-code').id, q: 'vlan 66' });
  assert.equal(r.cerveau, commun(db, 'IA').id);
  assert.deepEqual(r.chemin, [membre(db, 'claude-code').id, commun(db, 'IA').id]);
  assert.equal(r.hits[0].kind, 'fiche.commune');
});

test('plusieurs comptes : chacun son arbre, versement choisi au commun, rien par défaut', () => {
  const db = base();
  H.changerMode(db, 'plusieurs', 'compte-ana');
  assert.equal(H.compteDe(db, { humain: true, compte: 'compte-ana' }), H.PRINCIPAL, 'le premier garde la hiérarchie d\'avant');
  assert.equal(H.compteDe(db, { humain: true, compte: 'compte-bruno' }), 'compte-bruno');
  assert.equal(H.compteDe(db, { name: 'proxmox' }), H.COMMUN, 'un service sans compte écrit au commun');
  const bruno = { name: 'kimi-bruno', compte: 'compte-bruno' };
  const d1 = ecrire(db, 'kimi-bruno', { kind: 'decision.x', title: 'Bruno garde Postgres', body: '' }, { src: { compte: 'compte-bruno' } });
  assert.equal(d1.c.compte, 'compte-bruno');
  assert.deepEqual(d1.c.remontees.map(r => r.regle), ['importance'], 'pas de versement sans le choix du compte');
  const ia = db.prepare(`SELECT id FROM h_domaines WHERE compte='compte-bruno' AND nom='IA'`).get();
  db.prepare(`INSERT INTO h_versements(compte,domaine_id) VALUES('compte-bruno',?)`).run(ia.id);
  const d2 = ecrire(db, 'kimi-bruno', { kind: 'decision.y', title: 'Bruno passe à Valkey', body: '' }, { src: { compte: 'compte-bruno' } });
  assert.deepEqual(d2.c.remontees.map(r => r.regle), ['importance', 'versement']);
  assert.equal(d2.c.remontees[1].vers, commun(db, 'IA', H.COMMUN).id);
  // Ana lit le commun, pas l'arbre de Bruno.
  const ana = { humain: true, compte: 'compte-ana' };
  assert.deepEqual(H.acces(db, ana, commun(db, 'IA', H.COMMUN)), { tout: true });
  assert.equal(H.acces(db, ana, membre(db, 'kimi-bruno', 'compte-bruno')), null);
  assert.equal(H.acces(db, bruno, membre(db, 'kimi-bruno', 'compte-bruno')).tout, true);
});

test('reprise : les entrées d\'avant sont rangées une fois, l\'échange suit son IA', () => {
  const db = base();
  const a = ingest.insert(db, { ns: 'shared', kind: 'note', title: 'avant la v3', body: '' }, 'triage');
  const b = ingest.insert(db, { ns: 'shared', kind: 'echange', title: 'échange', body: 'q/r', meta: { agent: 'qwen-3' } }, 'hub');
  assert.equal(H.reprendre(db), 2);
  assert.equal(H.reprendre(db), 0, 'idempotente');
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(a.id).cerveau_id, membre(db, 'triage').id);
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(b.id).cerveau_id, membre(db, 'qwen-3').id);
  assert.equal(membre(db, 'qwen-3').domaine_id, commun(db, 'IA').domaine_id);
});

test('liens de fiche : réservés au tamis', () => {
  const db = base();
  const a = ecrire(db, 'kimi', { title: 'x', body: '' }), b = ecrire(db, 'ollama', { title: 'y', body: '' });
  assert.equal(ingest.link(db, a.id, b.id, 'consolide', 'kimi').ok, false);
  assert.equal(ingest.link(db, a.id, b.id, 'relates_to', 'kimi').ok, true);
});

test('arbre : domaines, communs, membres et compteurs, sans contenu', () => {
  const db = base();
  ecrire(db, 'claude-code', { title: 'VLAN 9', body: '' });
  ecrire(db, 'kimi', { title: 'VLAN 9 aussi', body: '' });
  const t = H.arbre(db, H.PRINCIPAL);
  const ia = t.domaines.find(d => d.nom === 'IA');
  assert.equal(ia.membres.length, 2);
  assert.equal(ia.commun.n, 1, 'la fiche commune');
  assert.equal(t.global.reglages.seuil, 101);
  assert.ok(!JSON.stringify(t).includes('VLAN 9 aussi'), 'pas de contenu dans l\'arbre');
});

test('migration : une base écrite par la 2.0.2 passe en v2 sans rien perdre', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-v1-'));
  // Le db.js de la 2.0.2 tel que publié (copie figée dans test/anciens) :
  // la migration part de ce qui existe vraiment, sans dépendre des étiquettes git.
  const fichier = path.join(dossier, 'v1.db');
  const v1 = require('../test/anciens/db-2.0.2.js').open(fichier);
  const ids = ['VLAN 30 : serveurs', 'VLAN 30 : le NAS', 'décision : SQLite'].map((t, i) =>
    ingest.insert(v1, { ns: 'shared', kind: i === 2 ? 'decision.x' : 'note', title: t, body: '' }, i ? 'kimi' : 'claude-code').id);
  assert.equal(v1.prepare(`SELECT v FROM meta WHERE k='schema_version'`).get().v, '1');
  v1.close();
  const db = open(fichier);
  assert.equal(db.prepare(`SELECT v FROM meta WHERE k='schema_version'`).get().v, '2');
  assert.ok(db.prepare(`PRAGMA table_info(sources)`).all().some(c => c.name === 'compte'));
  assert.equal(db.prepare(`SELECT count(*) n FROM entries`).get().n, 3, 'aucune entrée perdue');
  assert.equal(H.reprendre(db), 3);
  assert.equal(fiches(db, 'fiche.commune').length, 1, 'les deux IA sur le VLAN 30 : une fiche');
  for (const id of ids) assert.ok(db.prepare(`SELECT 1 FROM h_place WHERE entry_id=?`).get(id));
});

test('reprise par lots : le curseur avance, un redémarrage reprend où on s\'était arrêté', () => {
  const db = base();
  for (let i = 0; i < 7; i++) ingest.insert(db, { ns: 'shared', kind: 'note', title: 'avant ' + i, body: '' }, 'triage');
  assert.equal(H.resteAReprendre(db), 7);
  assert.equal(H.reprendre(db, { lot: 3, max: 3 }), 3);
  assert.equal(H.resteAReprendre(db), 4);
  // Une écriture neuve pendant la reprise est rangée tout de suite, et la reprise ne la range pas deux fois.
  const neuve = ecrire(db, 'kimi', { title: 'pendant la reprise', body: '' });
  assert.ok(neuve.c);
  assert.equal(H.reprendre(db, { lot: 3 }), 4);
  assert.equal(H.resteAReprendre(db), 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM h_place`).get().n, 8);
});

test('coût : une clé répétée par une seule source ne rend pas l\'écriture plus chère', () => {
  const db = base();
  const mesure = () => {
    const t = performance.now();
    for (let i = 0; i < 200; i++) ecrire(db, 'triage', { title: `alerte disque ${i}`, body: '', ref: 'disk-full-pve' });
    return (performance.now() - t) / 200;
  };
  const debut = mesure();
  for (let i = 0; i < 3; i++) mesure();
  const fin = mesure();
  assert.ok(fin < Math.max(2, debut * 3), `écriture ${debut.toFixed(2)} ms au début, ${fin.toFixed(2)} ms après 800 répétitions`);
  assert.equal(fiches(db, 'fiche.commune').length, 0, 'une seule source : jamais de fiche');
});

test('gravité : celle dite par la source (gravite ou severity) fixe l\'importance', () => {
  const db = base();
  const g = (meta, kind = 'security.alert') => ecrire(db, 'vigie', { kind, title: 'x ' + JSON.stringify(meta), body: '', meta, tags: ['securite'] }).c.importance;
  assert.equal(g({ gravite: 'critique' }), 90);
  assert.equal(g({ gravite: 'eleve' }), 70);
  assert.equal(g({ severity: 'low' }), 30);
  assert.equal(g({}), 20, 'sans gravité : le niveau L0, pas l\'étiquette securite');
  assert.equal(g({ gravite: 'faible' }, 'incident.security'), 30, 'une gravité dite prime sur le genre incident');
});

test('répétition : la même alerte sous mille adresses monte une fois par période, comptée', () => {
  const db = base();
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  const ecr = (i, h) => ecrire(db, 'vigie', { kind: 'security.alert', tags: ['securite'], meta: { gravite: 'eleve' }, body: '',
    title: `Menace extérieure non bloquée : 87.120.${i % 250}.${i % 200} (score ${200 + i % 50})`,
    occurred_at: new Date(t0 + h * 3600000).toISOString() });
  for (let i = 0; i < 300; i++) ecr(i, i / 100);
  const montees = db.prepare(`SELECT count(*) n FROM h_remontees WHERE regle != 'versement'`).get().n;
  assert.equal(montees, 1, 'un motif, une remontée');
  assert.equal(db.prepare(`SELECT n FROM h_motifs`).get().n, 300);
  ecr(999, 30);
  assert.equal(db.prepare(`SELECT count(*) n FROM h_remontees`).get().n, 2, 'la période passée, le motif remonte à nouveau');
  const autre = ecrire(db, 'vigie', { kind: 'security.alert', tags: ['securite'], meta: { gravite: 'eleve' }, body: '',
    title: 'nas : force brute : huit refus de la même adresse', occurred_at: new Date(t0).toISOString() });
  assert.equal(autre.c.remontees[0].regle, 'importance', 'un autre motif monte');
  assert.notEqual(H.motifDe({ kind: 'a', title: 'web-01 : x' }), H.motifDe({ kind: 'b', title: 'web-01 : x' }));
});

test('fiche bornée : dix exemples par origine, toutes les mentions comptées', () => {
  const db = base();
  for (let i = 0; i < 40; i++) {
    ecrire(db, 'vigie', { title: `balayage ${i} : port 21 ouvert`, body: '' });
    ecrire(db, 'hub', { title: `alerte ${i} : port 21 ouvert`, body: '' });
  }
  const [f] = fiches(db, 'fiche.commune');
  assert.ok(f);
  assert.equal(liens(db, f.id, 'consolide').length, 20, 'dix par origine');
  const fraiche = db.prepare(`SELECT body FROM entries WHERE id=?`).get(f.id).body;
  assert.match(fraiche.split('\n')[0], /port:21 : 80 mention\(s\), 2 origine\(s\)/);
});

test('agent inconnu : le cerveau prend le nom de la source', () => {
  const db = base();
  const r = ingest.insert(db, { ns: 'shared', kind: 'echange', title: 'q', body: 'r', meta: { agent: 'inconnu' } }, 'hub');
  H.reprendre(db);
  assert.equal(db.prepare(`SELECT cerveau_id FROM h_place WHERE entry_id=?`).get(r.id).cerveau_id, membre(db, 'hub').id);
  assert.equal(membre(db, 'inconnu'), undefined);
});

test('relais du Hub : une alerte reprise mot pour mot va chez le service d\'origine, sans fausse convergence', () => {
  const db = base();
  const q = '2026-10-22T10:00:00.000Z';
  for (let i = 0; i < 5; i++) {
    const titre = `Menace extérieure non bloquée : 87.120.84.${100 + i} (score 239)`;
    ecrire(db, 'vigie', { kind: 'security.alert', title: titre, body: '', occurred_at: q });
    ecrire(db, 'hub', { kind: 'alert', title: 'Alerte eleve : ' + titre, body: '', occurred_at: q });
  }
  assert.equal(fiches(db, 'fiche.commune').length, 0, 'le même fait relayé ne converge pas');
  assert.equal(membre(db, 'hub'), undefined, 'les relais sont chez vigie');
  const propre = ecrire(db, 'hub', { kind: 'alert', title: 'Alerte eleve : sauvegarde du NAS en échec', body: '', occurred_at: q });
  assert.equal(propre.c.cerveau, membre(db, 'hub').id, 'une alerte sans original reste au Hub');
});

test('scène : chaque cerveau a sa part, un gros cerveau ne prend pas toutes les places', () => {
  const { buildGraph } = require('./graph');
  const db = base();
  for (let i = 0; i < 300; i++) ecrire(db, 'vigie', { kind: 'security.alert', title: `alerte ${i}`, body: '' });
  const vox = [ecrire(db, 'vox', { title: 'Commande vocale : lumière salon', body: '' }), ecrire(db, 'vox', { title: 'Commande vocale : volets', body: '' })];
  const g = buildGraph(db, { ns: 'shared', limit: 50 });
  assert.ok(g.nodes.length <= 50, 'la limite tient');
  const ids = new Set(g.nodes.map(n => n.id));
  for (const v of vox) assert.ok(ids.has('e' + v.id), 'les entrées de vox sont dans la scène');
  assert.ok(g.nodes.every(n => Array.isArray(n.d.cerveaux) && n.d.cerveaux.length), 'chaque carte sait où elle est');
});
