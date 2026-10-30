// Parcours de l'assistant de configuration dans un navigateur (Playwright),
// pour les parcours des services : chaque étape est contrôlée (mise en page),
// les valeurs proposées sont gardées, sauf celles données dans `valeurs`
// (libellé → texte).
//   await passerAssistant(page, { controle, valeurs: { 'Adresse publique': 'https://…' } });
export async function passerAssistant(page, { controle = null, valeurs = {}, prefixe = 'assistant' } = {}) {
  const pied = page.locator('.porte .wfoot');
  await page.locator('.porte .assistant-champs').first().waitFor({ timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    for (const [libelle, texte] of Object.entries(valeurs)) {
      const champ = page.locator('.porte').getByLabel(libelle, { exact: false });
      if (await champ.count()) await champ.first().fill(texte);
    }
    if (controle) await controle(`${prefixe}-${i + 1}`);
    const suivant = pied.getByRole('button', { name: 'Suivant' });
    if (!(await suivant.count())) break;
    await suivant.click();
    await page.waitForTimeout(150);
  }
  if (controle) await controle(`${prefixe}-fin`);
  await pied.getByRole('button', { name: /Terminer la configuration|Enregistrer/ }).click();
  // Sans superviseur (vitrine), le service demande un redémarrage à la main.
  const continuer = page.locator('.porte').getByRole('button', { name: 'Continuer' });
  await Promise.race([continuer.waitFor({ timeout: 30000 }).then(async () => { if (controle) await controle(`${prefixe}-redemarrage`); await continuer.click(); }).catch(() => {}),
    page.locator('.porte').waitFor({ state: 'detached', timeout: 30000 })]);
  await page.locator('.porte').waitFor({ state: 'detached', timeout: 30000 });
}

// La fenêtre « Réglages du service » de la page Comptes, ouverte puis refermée.
export async function ouvrirReglagesService(page, { controle = null } = {}) {
  await page.getByRole('button', { name: 'Modifier les réglages' }).click();
  const d = page.getByRole('dialog', { name: 'Réglages du service' });
  await d.waitFor();
  await page.waitForTimeout(250);
  if (controle) await controle('reglages-service');
  await d.getByRole('button', { name: 'Annuler' }).click();
  await d.waitFor({ state: 'detached' });
}
