// Une instance de SYNAPSE lancée comme en production (processus séparé, base
// neuve), pour les essais de bout en bout du serveur.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const RACINE = path.resolve(import.meta.dirname, '..');
export const JETON_INSTALLATION = 'jeton-installation-synapse-essai-0001';
export const JETON_HUB = 'jeton-du-hub-pour-les-essais-' + 'x'.repeat(12);
export const JETON_ADMIN_HUB = 'jeton-admin-du-hub-pour-les-essais-' + 'y'.repeat(12);

export async function lancer({ env = {}, dossier = null, preparer = null } = {}) {
  const d = dossier || fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-essai-'));
  const db = path.join(d, 'synapse.db');
  if (preparer) preparer(db);
  const port = 20000 + crypto.randomInt(20000);
  let sortie = '';
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: RACINE, env: {
    PATH: process.env.PATH, PORT: String(port), HOTE: '127.0.0.1', DB_FILE: db, UI_DIR: path.join(RACINE, 'ui'),
    OLLAMA_URL: 'http://127.0.0.1:9', SOCLE_CLE: crypto.randomBytes(32).toString('base64'), SOCLE_JETON_INSTALLATION: JETON_INSTALLATION,
    HUB_TOKEN_SEED: JETON_HUB, SOCLE_JETON_ADMIN_HUB: JETON_ADMIN_HUB, CONSOLIDATION_INTERVAL: '0', ...env,
  } });
  proc.stdout.on('data', x => { sortie += x; }); proc.stderr.on('data', x => { sortie += x; });
  for (let i = 0; i < 150; i++) {
    if ((await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.status, () => 0)) === 200) break;
    if (proc.exitCode !== null) throw new Error('SYNAPSE ne démarre pas :\n' + sortie);
    await new Promise(r => setTimeout(r, 100));
  }
  const arreter = () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGTERM'); });
  return { port, dossier: d, db, proc, sortie: () => sortie, arreter, url: chemin => `http://127.0.0.1:${port}${chemin}` };
}

// Un service : son jeton en Bearer.
export function service(inst, jeton) {
  const req = async (methode, chemin, corps, entetes = {}) => {
    const r = await fetch(inst.url(chemin), { method: methode, headers: { authorization: `Bearer ${jeton}`, ...(corps !== undefined ? { 'content-type': 'application/json' } : {}), ...entetes }, body: corps !== undefined ? JSON.stringify(corps) : undefined });
    const texte = await r.text();
    let json = null; try { json = JSON.parse(texte); } catch { /* non JSON */ }
    return { status: r.status, json, texte, entetes: r.headers };
  };
  return { get: c => req('GET', c), post: (c, b = {}) => req('POST', c, b), put: (c, b = {}) => req('PUT', c, b), del: c => req('DELETE', c), req };
}
