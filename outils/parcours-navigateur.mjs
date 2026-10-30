// Parcours réel de SYNAPSE dans Chromium (clé d'accès virtuelle) contre la
// vitrine (faux Ollama, mémoire remplie), et contrôle de mise en page à
// chaque largeur. Usage :
//   node outils/vitrine.mjs 8140 [gamme] &          (affiche JETON=)
//   node outils/parcours-navigateur.mjs http://localhost:8140 JETON [DOSSIER]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { chevauchements, LARGEURS } from '../socle/essai/mise-en-page.mjs';
import { passerAssistant, ouvrirReglagesService } from '../socle/essai/assistant-navigateur.mjs';

const [base, jeton, sortie = '/tmp/captures-synapse'] = process.argv.slice(2);
fs.mkdirSync(sortie, { recursive: true });
const MDP = 'phrase de passe pour synapse en local';
const navigateur = await chromium.launch();
const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 860 } });
const page = await contexte.newPage();
contexte.setDefaultTimeout(12000);
const erreurs = [];
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push(String(e)));
const cdp = await contexte.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

// Un échec laisse la capture de l'écran où il s'est produit.
process.on('uncaughtException', async e => { console.error(await page.evaluate(() => location.href + ' ' + document.body.innerText.slice(0, 400)).catch(x => String(x))); await page.screenshot({ path: `${sortie}/echec.png` }).catch(() => { /* page fermée */ }); console.error(e); process.exit(2); });
// Ce que le contrôle commun ne voit pas sur une page qui ne défile pas (corps
// en overflow:hidden, panneaux fixes) : un élément coupé par le bord de
// l'écran. Un tiroir fermé, entièrement hors de l'écran, n'en est pas un ;
// une rangée qui défile de côté coupe ses puces exprès.
function horsEcran() {
  const vw = document.documentElement.clientWidth, out = [];
  const vu = el => (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) && el.getBoundingClientRect().width > 0;
  for (const el of document.querySelectorAll('body *')) {
    const utile = ['BUTTON', 'A', 'INPUT', 'SELECT'].includes(el.tagName) || [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!utile || !vu(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left >= -1 && r.right <= vw + 1) continue;
    let excuse = false;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const q = e.getBoundingClientRect();
      if (q.right <= 0 || q.left >= vw) excuse = true;
      else if (getComputedStyle(e).overflowX !== 'visible' && q.left >= -1 && q.right <= vw + 1) excuse = true;
    }
    if (!excuse) out.push({ type: 'hors-ecran', detail: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} « ${el.textContent.trim().slice(0, 30)} » ${Math.round(r.left)}…${Math.round(r.right)} sur ${vw}` });
  }
  return out;
}
const rapport = [];
async function controle(nom, avant = null) {
  for (const w of LARGEURS) {
    await page.setViewportSize({ width: w, height: w < 500 ? 780 : 900 });
    await page.waitForTimeout(260);
    // Changer de largeur peut lancer une transition (le tiroir STATS sort de
    // l'écran sous 860 px) : on contrôle la page posée, pas son mouvement.
    await page.waitForFunction(() => !document.getAnimations().some(a => a instanceof CSSTransition && a.playState === 'running'), null, { timeout: 3000 }).catch(() => { /* transition sans fin : contrôlée telle quelle */ });
    if (avant) await avant(w);
    const defauts = [...await page.evaluate(chevauchements), ...await page.evaluate(horsEcran)];
    // Une valeur absente rendue telle quelle (« null », « undefined », « NaN ») est un défaut d'affichage.
    const brut = await page.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN|Infinity)\b/) || [])[0]);
    if (brut) defauts.push({ type: 'texte-brut', detail: `« ${brut} » affiché` });
    rapport.push({ ecran: nom, largeur: w, defauts });
    if ([360, 768, 1024, 1280].includes(w)) await page.screenshot({ path: `${sortie}/${nom}-${w}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}

await page.goto(base);
await page.getByLabel('Jeton d’installation').waitFor();
await controle('porte');
await page.getByLabel('Jeton d’installation').fill(jeton);
await page.getByLabel('Identifiant').fill('ana');
await page.getByLabel('Mot de passe').fill(MDP);
await page.getByRole('button', { name: 'Créer le compte' }).click();
await page.getByRole('button', { name: /Créer la clé maintenant/ }).click();
await page.getByText('J’ai rangé ces codes en lieu sûr.').click();
await page.getByRole('button', { name: 'Terminer' }).click();
await passerAssistant(page, { controle });
await page.waitForURL(u => new URL(u).pathname === '/', { waitUntil: 'commit' });

// La mémoire : la scène 3D, ses trois vues, l'instrumentation (repliée
// derrière STATS sur un petit écran), la fiche, une question et sa réponse,
// une entrée ouverte depuis les sources, l'espace « savoir ».
const memoire = async () => {
  await page.locator('#veil.off').waitFor({ state: 'attached' });
  await page.locator('#demoTag.live').waitFor();
  await page.waitForTimeout(1200);
};
await memoire();
await controle('memoire');
await controle('memoire-stats', async w => { if (w <= 860 && !(await page.locator('#hud.open').count())) { await page.locator('#hudBtn').click(); await page.waitForTimeout(400); } });
if (await page.locator('#hud.open').count()) await page.locator('#hudBtn').click({ force: true }).catch(() => { /* bouton caché à cette largeur */ });
await page.evaluate(() => document.querySelector('#hud').classList.remove('open'));
for (const [bouton, nom] of [['#vGalaxy', 'memoire-galaxie'], ['#vCard', 'memoire-carte'], ['#vSphere', 'memoire-sphere']]) {
  await page.locator(bouton).click();
  await page.waitForTimeout(1500);
  await controle(nom);
}
await page.locator('#moiBtn').click();
await page.locator('#moi.on').waitFor();
await page.locator('#moiCorps .fiche').first().waitFor();
await controle('fiche');
await page.locator('#moiX').click();
await page.locator('#q').fill('pourquoi la passerelle a-t-elle redémarré ?');
await page.locator('#go').click();
await page.locator('#insp.on .ans').waitFor();
await page.locator('#go:not([disabled])').waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await controle('reponse');
await page.locator('#insp .cx[data-go]').first().click();
await page.locator('#inspCorps h3').first().waitFor();
await page.waitForTimeout(900);
await controle('entree');
await page.locator('#inspClose').click();
await page.locator('#nsSel').selectOption('savoir');
await page.waitForURL(u => new URL(u).search === '?ns=savoir', { waitUntil: 'commit' });
await memoire();
await controle('savoir');

// Paramètres : rangement, réglages, plages, Telegram ; une analyse lancée
// (faux Ollama), une plage ajoutée, et le dialogue de confirmation d'identité.
await page.locator('#paramBtn').click();
await page.waitForURL(u => new URL(u).pathname === '/parametres');
await page.locator('#etatT').filter({ hasNotText: '…' }).waitFor();
await controle('parametres');
await page.locator('#bAjout').click();
await page.locator('#bLancer').click();
await page.locator('#bLancer:not([disabled])').waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await controle('parametres-analyse');
await page.evaluate(() => { document.querySelector('#rfLabel').textContent = 'Mot de passe'; document.querySelector('#renfort').showModal(); });
await page.locator('#renfort[open]').waitFor();
await controle('parametres-renfort');
await page.locator('#renfort').getByRole('button', { name: 'Annuler' }).click();

// Le compte : page Sécurité et page Comptes du socle, dialogue d'invitation.
await page.goto(base + '/compte');
await page.getByRole('heading', { name: 'Sécurité', exact: true }).first().waitFor();
await page.waitForTimeout(400);
await controle('securite');
await page.locator('.top .views').getByRole('button', { name: 'Comptes', exact: true }).click();
await page.getByRole('heading', { name: 'Comptes', exact: true }).first().waitFor();
await page.waitForTimeout(400);
await controle('comptes');
await page.getByRole('button', { name: 'Inviter' }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(300);
await controle('comptes-inviter');
await page.getByRole('dialog').getByRole('button', { name: 'Annuler' }).click();

const defauts = rapport.filter(r => r.defauts.length);
fs.writeFileSync(`${sortie}/rapport.json`, JSON.stringify({ rapport, erreurs }, null, 2));
console.log(`écrans×largeurs contrôlés : ${rapport.length}, avec défauts : ${defauts.length}, erreurs console : ${erreurs.length}`);
for (const r of defauts) for (const d of r.defauts.slice(0, 6)) console.log(`  ${r.ecran} @${r.largeur} — ${d.type} : ${d.detail}`);
for (const e of erreurs) console.log('  console :', e);
await navigateur.close();
process.exit(defauts.length || erreurs.length ? 1 : 0);
