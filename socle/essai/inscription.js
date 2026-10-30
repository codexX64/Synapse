// Parcours d'inscription prêts à l'emploi pour les tests des services : un
// administrateur complet (mot de passe + clé d'accès + TOTP), un membre invité.
import * as totp from '../src/totp.js';
import { Authentificateur } from './authentificateur.js';

export const MDP_ESSAI = 'phrase de passe pour les essais du service';
export const codeTotp = (secret, t = Date.now(), decalage = 0) => totp.code(secret, totp.pasCourant(t) + decalage);

async function exiger(r, quoi) {
  if (r.status !== 200) throw new Error(`${quoi} : ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

// Première configuration passée avec les valeurs proposées (si le service a un
// assistant) : sans elle, le service reste fermé (428).
export async function terminerAssistant(client, valeurs = {}) {
  const e = await client.get('/api/compte/etat');
  if (!e.json?.assistant?.doit) return null;
  return exiger(await client.post('/api/compte/reglages', { valeurs }), 'assistant de configuration');
}

export async function adminComplet(client, { jeton, identifiant = 'ana', motDePasse = MDP_ESSAI, maintenant = Date.now, terminer = true } = {}) {
  await exiger(await client.post('/api/compte/installation', { jeton, identifiant, motDePasse }), 'installation');
  const auth = new Authentificateur();
  const o = await exiger(await client.post('/api/compte/cles/options'), 'options de clé');
  await exiger(await client.post('/api/compte/cles', { reponse: auth.creer(o.json, client.origine), nom: 'Essai' }), 'clé');
  const t = await exiger(await client.post('/api/compte/totp'), 'totp');
  await exiger(await client.post('/api/compte/totp/confirmer', { code: codeTotp(t.json.secret, maintenant()) }), 'confirmation totp');
  await exiger(await client.post('/api/compte/secours'), 'codes de secours');
  if (terminer) await terminerAssistant(client);
  return { auth, secret: t.json.secret };
}

// L'administrateur doit sortir d'une inscription ou d'un renfort récents.
export async function membreInvite(admin, nouveauClient, { identifiant, role = 'membre', motDePasse = MDP_ESSAI + ' ' + identifiant, maintenant = Date.now } = {}) {
  const r = await exiger(await admin.post('/api/compte/admin/comptes', { identifiant, role }), 'invitation');
  const jeton = r.json.lien.split('#invitation=')[1];
  const client = nouveauClient();
  await exiger(await client.post('/api/compte/jeton', { usage: 'invitation', jeton, motDePasse }), 'acceptation');
  const t = await exiger(await client.post('/api/compte/totp'), 'totp membre');
  await exiger(await client.post('/api/compte/totp/confirmer', { code: codeTotp(t.json.secret, maintenant()) }), 'confirmation totp membre');
  await exiger(await client.post('/api/compte/secours'), 'codes de secours membre');
  return { client, secret: t.json.secret, compteId: r.json.compte.id };
}
