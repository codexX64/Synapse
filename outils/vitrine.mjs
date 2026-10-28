// Vitrine locale : SYNAPSE relié à un faux Ollama (celui des essais, en plus
// complet : vecteurs, génération en flux), avec une mémoire déjà remplie par
// le Hub (faits, échanges, corrections, traits, incidents résolus), pour le
// parcours dans le navigateur et les captures. Rien de réel : machines,
// adresses (192.0.2.0/24) et noms sont fictifs.
// Usage : node outils/vitrine.mjs [port] [gamme]
// Le faux Ollama écoute sur le port suivant.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const RACINE = path.resolve(import.meta.dirname, '..');
const [port = '8140', gamme = 'soma', volume = '0'] = process.argv.slice(2);
const portIa = Number(port) + 1;

// Un vecteur tiré des mots : deux textes proches se ressemblent assez pour
// que la recherche par vecteurs ait quelque chose à classer.
function vecteur(texte) {
  const v = new Array(64).fill(0);
  for (const mot of String(texte).toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(m => m.length > 2)) v[crypto.createHash('sha1').update(mot).digest()[0] % 64] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
const REPONSE = 'La passerelle a redémarré cette nuit après une coupure de courant [1]. Le service de supervision est revenu seul ; rien à relancer.';
const ia = http.createServer((req, res) => {
  let corps = '';
  req.on('data', d => { corps += d; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(corps || '{}'); } catch { /* corps vide ou illisible : réponse par défaut */ }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3:8b' }] }));
    if (req.url === '/api/embeddings') return res.end(JSON.stringify({ embedding: vecteur(j.prompt) }));
    if (req.url === '/api/generate') {
      const texte = j.format === 'json' ? '{}' : REPONSE;
      if (!j.stream) return res.end(JSON.stringify({ response: texte, done: true }));
      for (const morceau of texte.match(/.{1,24}/gs)) res.write(JSON.stringify({ response: morceau }) + '\n');
      return res.end(JSON.stringify({ response: '', done: true }) + '\n');
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise(r => ia.listen(portIa, '127.0.0.1', r));

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-vitrine-'));
const JETON_INSTALLATION = crypto.randomBytes(18).toString('base64url');
const JETON_HUB = crypto.randomBytes(24).toString('base64url');
const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: RACINE, stdio: ['ignore', 'pipe', 'pipe'], env: {
  PATH: process.env.PATH, PORT: port, HOTE: '127.0.0.1', DB_FILE: path.join(dossier, 'synapse.db'), UI_DIR: path.join(RACINE, 'ui'),
  OLLAMA_URL: `http://127.0.0.1:${portIa}`, QUEUE_MAX: '100000000', SOCLE_CLE: crypto.randomBytes(32).toString('base64'), SOCLE_JETON_INSTALLATION: JETON_INSTALLATION,
  HUB_TOKEN_SEED: JETON_HUB, CONSOLIDATION_INTERVAL: '0', SOCLE_THEME: gamme,
} });
let sortie = '';
proc.stdout.on('data', x => { sortie += x; });
proc.stderr.on('data', x => { sortie += x; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if ((await fetch(base + '/healthz').then(r => r.status, () => 0)) === 200) break;
  if (proc.exitCode !== null || i > 150) { console.error('SYNAPSE ne démarre pas :\n' + sortie); process.exit(1); }
  await new Promise(r => setTimeout(r, 100));
}
const hub = async (chemin, corps) => {
  const r = await fetch(base + chemin, { method: 'POST', headers: { authorization: `Bearer ${JETON_HUB}`, 'content-type': 'application/json' }, body: JSON.stringify(corps) });
  if (r.status >= 300) throw new Error(`${chemin} : ${r.status} ${await r.text()}`);
  return r.json();
};

// Deux semaines de mémoire : ce que les services ont envoyé, ce que
// l'assistant a appris, une erreur corrigée.
const h = 3600e3, t = Date.now();
const faits = [
  ['device.online', 'Le serveur srv-a est en ligne', 'srv-a (192.0.2.10) répond de nouveau après la maintenance.', 'fiche serveur', 300],
  ['device.online', 'L’hyperviseur hv-1 est en ligne', 'hv-1 porte les machines de supervision et de sauvegarde.', 'fiche hyperviseur', 280],
  ['container.oom', 'Le conteneur indexeur a manqué de mémoire', 'Limite mémoire de 512 Mo atteinte pendant la réindexation.', 'conteneur', 200],
  ['container.started', 'Le conteneur indexeur a redémarré', 'Redémarré avec une limite de 1 Go.', 'conteneur docker', 199],
  ['deploy.success', 'Déploiement de la supervision 4.2', 'Pile supervision déployée en Compose depuis le Hub.', 'service', 150],
  ['network.vlan', 'Le VLAN 20 sépare les invités', 'Les invités sortent par la passerelle, sans accès au reste.', 'vlan', 140],
  ['dns.record', 'Nouvelle entrée DNS pour la supervision', 'supervision.exemple pointe vers le relais.', 'dns', 120],
  ['ticket.closed', 'Ticket fermé : disque plein sur srv-a', 'Journaux tournés, 18 Go libérés.', 'projet', 96],
  ['runbook.saved', 'Procédure : relancer la passerelle', 'Couper, attendre trente secondes, rallumer, vérifier la route par défaut.', 'procedure', 72],
  ['decision.recorded', 'Les sauvegardes partent à 3 h', 'Décision : sauvegarde nocturne à 3 h, conservation de quatorze jours.', 'note', 48],
  ['alert.raised', 'Alerte : passerelle injoignable', 'La passerelle ne répond plus au ping depuis 2 min.', 'alerte', 20],
  ['incident.resolved', 'La passerelle a redémarré cette nuit', 'La passerelle a redémarré cette nuit après une coupure de courant.', 'passerelle', 19],
  ['skill.learned', 'Compose : limites mémoire par service', 'Chaque service de la pile porte sa limite mémoire.', 'skill', 10],
  ['roadmap.item', 'Feuille de route : second hyperviseur', 'Ajouter un second hyperviseur pour la reprise.', 'roadmap', 6],
];
const ids = [];
for (const [kind, title, body, tags, ilYa] of faits) ids.push((await hub('/v1/ingest', { ns: 'shared', kind, title, body, tags, occurred_at: new Date(t - ilYa * h).toISOString() })).id);
for (const [title, body] of [['Manuel : un secret ne va jamais dans le dépôt', 'Les secrets vivent dans le coffre du Hub ou un secret Docker.'], ['Convention : messages de commit en français', 'Une ligne, un sujet par commit.']]) {
  await hub('/v1/ingest', { ns: 'savoir', kind: 'note.standard', title, body, tags: 'standard' });
}
await hub('/v1/link', { from_id: ids[3], to_id: ids[2], relation: 'fixes' });
await hub('/v1/link', { from_id: ids[11], to_id: ids[10], relation: 'fixes' });
await hub('/v1/link', { from_id: ids[2], to_id: ids[1], relation: 'relates_to' });
for (const [question, reponse] of [
  ['pourquoi la passerelle a-t-elle redémarré ?', 'Une coupure de courant cette nuit ; elle est revenue seule.'],
  ['donne-moi la commande pour voir les conteneurs', 'docker ps --format "table {{.Names}}\t{{.Status}}"'],
  ['quand partent les sauvegardes ?', 'Chaque nuit à 3 h, gardées quatorze jours.'],
]) await hub('/v1/echange', { agent: 'qwen3-8b', question, reponse, ns: 'shared' });
await hub('/v1/apprendre', { agent: 'qwen3-8b', question: 'quel modèle utiliser pour le triage', correction: 'Ne jamais inventer un nom de modèle : lire la liste du service.', faux: 'llama-9000' });
await hub('/v1/apprendre', { agent: 'qwen3-8b', trait: { portee: 'commun', cle: 'format_commandes', valeur: 'Donne les commandes groupées en un seul bloc à coller.', confiance: 0.82 } });
await hub('/v1/apprendre', { agent: 'qwen3-8b', trait: { portee: 'commun', cle: 'langue', valeur: 'Répond en français, sans détour.', confiance: 0.9 } });
await hub('/v1/neurons', { neuron: { type: 'incident_resolution', alert_key: 'passerelle.down', host: 'passerelle', service: 'reseau', signature: 'passerelle injoignable', root_cause: 'Coupure de courant.', resolution: 'Attendre le retour du courant, vérifier la route par défaut.', outcome: 'resolved' } });

// La hiérarchie des cerveaux : des IA et des services qui écrivent sous
// leur propre nom (jetons de cerveau), deux domaines de connaissance, des
// faits qui convergent d'une IA à l'autre et d'un domaine à l'autre, une
// rafale d'alertes répétées que le tamis ne fait monter qu'une fois.
const { jetonPour } = createRequire(import.meta.url)('../src/cerveaux.js');
const ecrit = async (nom, corps) => {
  const r = await fetch(base + '/v1/ingest', { method: 'POST', headers: { authorization: `Bearer ${jetonPour(JETON_HUB, nom)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ns: 'shared', ...corps }) });
  if (r.status >= 300) throw new Error(`${nom} : ${r.status} ${await r.text()}`);
};
const quand = ilYa => new Date(t - ilYa * h).toISOString();
for (const [nom, corps] of [
  ['claude-code', { kind: 'note', title: 'La VM 105 (hub) est sur le VLAN 30', body: 'Vue en session de déploiement.', occurred_at: quand(30) }],
  ['claude-code', { kind: 'decision.stockage', title: 'On garde SQLite pour la mémoire', body: 'Un fichier, une sauvegarde, aucune dépendance.', occurred_at: quand(28) }],
  ['claude-code', { kind: 'note', title: 'Le port 8120 sert la mémoire sur la VM 105', body: '', occurred_at: quand(26) }],
  ['kimi', { kind: 'note', title: 'Le VLAN 30 regroupe les serveurs', body: '', occurred_at: quand(25) }],
  ['kimi', { kind: 'note', title: 'Le port 8120 répond en 200 après la mise à jour', body: '', occurred_at: quand(20) }],
  ['ollama', { kind: 'note', title: 'La VM 105 répond en 192.0.2.11', body: '', occurred_at: quand(18) }],
  ['ollama', { kind: 'note', title: 'VLAN 66 réservé au labo', body: '', occurred_at: quand(16) }],
  ['mapmylan', { kind: 'device.seen', title: 'Appareil vu en 192.0.2.11 sur le VLAN 30', body: '', occurred_at: quand(15) }],
  ['proxmox', { kind: 'vm.started', title: 'VM 105 démarrée', body: '', occurred_at: quand(14) }],
  ['proxmox', { kind: 'note', title: 'Port 8120 ouvert sur la VM 105', body: '', occurred_at: quand(13) }],
  ['triage', { kind: 'incident.service', title: 'La mémoire ne répondait plus sur le port 8120', body: 'Relancée, revenue en 40 s.', meta: { gravite: 'eleve' }, occurred_at: quand(12) }],
  ['vigie', { kind: 'security.alert', title: 'Force brute sur 192.0.2.11 : huit refus en trois minutes', body: '', tags: ['securite'], meta: { gravite: 'eleve' }, occurred_at: quand(10) }],
  ['notes-reseau', { kind: 'decision.reseau', title: 'Isoler les objets connectés sur le VLAN 40', body: '', domaine: 'Connaissance/Réseau', occurred_at: quand(9) }],
  ['notes-reseau', { kind: 'note', title: 'Le VLAN 40 ne parle pas au VLAN 30', body: '', domaine: 'Connaissance/Réseau', occurred_at: quand(8) }],
  ['notes-securite', { kind: 'decision.securite', title: 'Fermer le port 23 partout', body: '', domaine: 'Connaissance/Sécurité', occurred_at: quand(7) }],
  ['notes-securite', { kind: 'note', title: 'Le VLAN 40 sort par la passerelle seulement', body: '', domaine: 'Connaissance/Sécurité', occurred_at: quand(6) }],
]) await ecrit(nom, corps);
for (let i = 0; i < 40; i++) await ecrit('vigie', { kind: 'security.alert', title: `Menace extérieure non bloquée : 203.0.113.${10 + i} (score ${200 + i})`, body: '', tags: ['securite'], meta: { gravite: 'eleve' }, occurred_at: quand(5 - i / 20) });

// Volume : N alertes de vigie de plus, par lots de 200, pour voir la scène
// à l'échelle d'une vraie base (outils/vitrine.mjs 8140 soma 40000).
for (let fait = 0; fait < Number(volume); fait += 200) {
  const events = Array.from({ length: Math.min(200, Number(volume) - fait) }, (_, k) => {
    const i = fait + k;
    return { ns: 'shared', kind: 'security.alert', title: `Menace extérieure non bloquée : 198.${51 + Math.floor(i / 62500)}.${Math.floor(i / 250) % 250}.${i % 250} (score ${150 + i % 120})`,
      body: '', tags: ['securite'], meta: { gravite: 'eleve' }, occurred_at: quand(400 - i / 200) };
  });
  /* file de vectorisation pleine (429) : on attend qu'elle se vide, comme un vrai service */
  for (let essai = 0; ; essai++) {
    const r = await fetch(base + '/v1/ingest/batch', { method: 'POST', headers: { authorization: `Bearer ${jetonPour(JETON_HUB, 'vigie')}`, 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
    if (r.status === 429 && essai < 120) { await new Promise(ok => setTimeout(ok, 1000)); continue; }
    if (r.status >= 300) throw new Error(`volume : ${r.status} ${await r.text()}`);
    break;
  }
}

console.log(`SYNAPSE ${gamme} : http://localhost:${port}`);
console.log(`JETON=${JETON_INSTALLATION}`);
const fin = async () => { proc.kill('SIGTERM'); await new Promise(r => proc.exitCode !== null ? r() : proc.on('exit', r)); ia.close(); fs.rmSync(dossier, { recursive: true, force: true }); process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, fin);
proc.on('exit', c => { if (c) { console.error(`SYNAPSE s'est arrêté (${c}) :\n` + sortie.slice(-2000)); process.exit(1); } });
