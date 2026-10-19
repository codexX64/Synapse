// Exercice du runbook d'incident (SECURITY.md, « Incident runbook ») sur une
// instance lancée comme en production : chaque geste de confinement et de
// reprise est joué par son vrai chemin, et son effet vérifié. Une vingtaine
// de secondes.
//   node outils/exercice-incident.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const RACINE = path.resolve(import.meta.dirname, '..');
const { Client, connexion } = await import(`${RACINE}/socle/essai/client.js`);
const { adminComplet, membreInvite, MDP_ESSAI } = await import(`${RACINE}/socle/essai/inscription.js`);

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'exercice-incident-')), BASE = path.join(D, 'data', 'synapse.db');
const PORT = 19000 + crypto.randomInt(1000), INSTALLATION = crypto.randomBytes(24).toString('base64url');
const CLE1 = crypto.randomBytes(32).toString('base64'), CLE2 = crypto.randomBytes(32).toString('base64');
const HUB1 = crypto.randomBytes(24).toString('base64url'), HUB2 = crypto.randomBytes(24).toString('base64url');
const JETON_TG = '123456789:' + 'A'.repeat(35);
const rapport = [];
let proc, sortie = '';
const fin = code => { try { proc?.kill('SIGKILL'); } catch { /* déjà arrêté */ } fs.rmSync(D, { recursive: true, force: true }); process.exit(code); };
const note = (ok, quoi) => { rapport.push(`${ok ? 'OK ' : 'ÉCHEC'} ${quoi}`); if (!ok) { console.log(rapport.join('\n')); console.log(sortie.slice(-2000)); fin(1); } };
const cli = (args, entree) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.js', ...args], { cwd: RACINE, env: { PATH: process.env.PATH, DB_FILE: BASE }, input: entree });

async function demarrer(env) {
  sortie = '';
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: RACINE, env: {
    PATH: process.env.PATH, PORT: String(PORT), HOTE: '127.0.0.1', DB_FILE: BASE, UI_DIR: path.join(RACINE, 'ui'), OLLAMA_URL: 'http://127.0.0.1:9',
    SOCLE_JETON_INSTALLATION: INSTALLATION, CONSOLIDATION_INTERVAL: '0', ...env,
  } });
  proc.stdout.on('data', d => { sortie += d; }); proc.stderr.on('data', d => { sortie += d; });
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`).then(x => x.status, () => 0)) === 200) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
const arreter = () => new Promise(r => { proc.on('exit', r); proc.kill('SIGTERM'); });
const jeton = j => ({ entetes: { authorization: `Bearer ${j}` }, origine: null });
const telegram = async c => (await c.get('/v1/rangement/etat')).json?.config?.telegram_token;

note(await demarrer({ HUB_TOKEN_SEED: HUB1, SOCLE_CLE: CLE1 }), 'démarrage : jeton du Hub n° 1, clé maîtresse n° 1');
const admin = new Client(PORT);
const { auth } = await adminComplet(admin, { jeton: INSTALLATION });
const { client: membre, compteId } = await membreInvite(admin, () => new Client(PORT), { identifiant: 'bruno' });
note((await admin.post('/v1/rangement/config', { telegram_token: JETON_TG, telegram_chat: '-100123' })).status === 200, 'Telegram relié, jeton scellé');
const note1 = await new Client(PORT).req('POST', '/v1/ingest', { ns: 'shared', kind: 'note', title: 'Onduleur remplacé', body: 'Remplacé avant l’incident.' }, jeton(HUB1));
note(note1.status === 202, 'le Hub écrit une note dans la mémoire');

// 1. Détecter
note((await membre.post('/v1/rangement/config', { telegram_chat: '-100999' })).status === 403, 'un geste interdit (réglages par un membre) est refusé');
const journal = (await admin.get('/api/compte/admin/journal')).json;
note(journal.lignes.some(l => l.action === 'acces.refuse') && journal.integrite.ok, 'détecter : le refus est au journal, chaîne intacte');
// 2. Fermer toutes les sessions sauf la sienne
note((await admin.post('/api/compte/admin/sessions/fermer-tout')).status === 200, 'toutes les sessions fermées');
note((await membre.get('/v1/stats')).status === 401 && (await admin.get('/v1/stats')).status === 200, 'la session du membre est morte, pas celle de l’administrateur');
// 3. Tourner le jeton du Hub et la clé maîtresse
await arreter();
note(await demarrer({ HUB_TOKEN_SEED: HUB2, SOCLE_CLE: CLE2, SOCLE_CLE_ANCIENNE: CLE1 }), 'redéploiement : jeton du Hub n° 2, clé n° 2 (n° 1 en ancienne)');
note((await new Client(PORT).req('GET', '/v1/stats', undefined, jeton(HUB1))).status === 401 && (await new Client(PORT).req('GET', '/v1/stats', undefined, jeton(HUB2))).status === 200, 'l’ancien jeton du Hub ne vaut plus rien, le nouveau ouvre');
await arreter();
note(await demarrer({ HUB_TOKEN_SEED: HUB2, SOCLE_CLE: CLE2 }), 'redémarrage sous la seule clé n° 2');
const a2 = new Client(PORT);
const o2 = await a2.post('/api/compte/connexion/cle/options');
note((await a2.post('/api/compte/connexion/cle', { reponse: auth.signer(o2.json, a2.origine) })).json?.niveau === 'complet', 'l’administrateur se reconnecte avec sa clé d’accès');
note(await telegram(a2) === '…' + JETON_TG.slice(-4), 'le jeton Telegram, rescellé sous la clé n° 2, se lit encore');
// 4. Retirer les secrets (le jeton se révoque aussi chez @BotFather)
const retrait = cli(['secrets', 'retirer']);
note(retrait.status === 0 && /telegram\.jeton/.test(String(retrait.stdout)), 'secrets retirés en ligne de commande, service en marche');
note(await telegram(a2) === '', 'plus aucune notification ne part avec l’ancien jeton Telegram');
// 5. Forcer un nouveau mot de passe
const reinit = await a2.post(`/api/compte/admin/comptes/${compteId}/reinit`);
note(reinit.status === 200, 'lien de réinitialisation émis pour le membre');
const nouveau = MDP_ESSAI + ' après incident';
note((await new Client(PORT).post('/api/compte/jeton', { usage: 'reinit', jeton: reinit.json.lien.split('#reinit=')[1], motDePasse: nouveau })).status === 200, 'le membre pose un nouveau mot de passe');
note((await connexion(new Client(PORT), 'bruno', MDP_ESSAI + ' bruno')).status === 401, 'l’ancien mot de passe ne vaut plus rien');
note((await connexion(new Client(PORT), 'bruno', nouveau)).json?.etape === 'second', 'le nouveau ouvre, et le second facteur reste exigé');
// 6. Restaurer depuis une sauvegarde
const paire = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const sauv = cli(['sauvegarde'], paire.publicKey);
note(sauv.status === 0 && sauv.stdout.length > 0, 'sauvegarde chiffrée tirée pendant que le service tourne');
note((await a2.get('/api/compte/admin/journal')).json.lignes.some(l => l.action === 'sauvegarde.faite'), 'la sauvegarde est inscrite au journal');
await arreter();
const prive = path.join(D, 'prive.pem'), restauree = path.join(D, 'restauree.db');
fs.writeFileSync(prive, paire.privateKey);
note(cli(['restaurer', prive, restauree], sauv.stdout).status === 0, 'restaurée ailleurs avec la clé privée seule');
const brut = new DatabaseSync(restauree, { readOnly: true });
const totp = brut.prepare('SELECT totp FROM socle_comptes WHERE totp IS NOT NULL').all();
note(totp.length === 2 && totp.every(l => l.totp.startsWith('v1.')), 'secrets TOTP toujours scellés dans la copie');
brut.close();
for (const f of ['synapse.db', 'synapse.db-wal', 'synapse.db-shm']) fs.rmSync(path.join(path.dirname(BASE), f), { force: true });
fs.copyFileSync(restauree, BASE);
fs.chmodSync(BASE, 0o600);
note(await demarrer({ HUB_TOKEN_SEED: HUB2, SOCLE_CLE: CLE2 }), 'redémarrage sur la base restaurée');
const c = new Client(PORT);
const o3 = await c.post('/api/compte/connexion/cle/options');
note((await c.post('/api/compte/connexion/cle', { reponse: auth.signer(o3.json, c.origine) })).json?.niveau === 'complet', 'l’administrateur se reconnecte sur la base restaurée');
note((await new Client(PORT).req('GET', '/v1/entry?id=' + note1.json.id, undefined, jeton(HUB2))).json?.title === 'Onduleur remplacé', 'la mémoire est revenue');
// 7. Vérifier la chaîne du journal
const apres = (await c.get('/api/compte/admin/journal')).json;
note(apres.integrite.ok && ['sessions.toutes_fermees', 'secrets.retires', 'compte.reinit_emis'].every(a => apres.lignes.some(l => l.action === a)), 'base restaurée : chaîne du journal intacte, chaque geste d’avant la sauvegarde inscrit');
await arreter();
console.log(`Exercice du runbook d'incident, ${new Date().toISOString()}\n${rapport.join('\n')}\n${rapport.length} vérifications réussies.`);
fin(0);
