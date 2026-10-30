// Point d'entrée du conteneur : le processus lancé supervise SYNAPSE et le
// relance quand l'assistant de configuration a posé de nouveaux réglages.
// L'enfant complète process.env avec ces réglages (l'environnement réel garde
// la main) avant de charger le serveur, qui lit ses variables au chargement.
import path from 'node:path';
import { createRequire } from 'node:module';
import { appliquerReglages, superviser } from '../socle/src/index.js';

if (!superviser()) {
  appliquerReglages({ dossier: path.dirname(process.env.DB_FILE || '/data/synapse.db'), env: process.env, enPlace: true });
  const require = createRequire(import.meta.url);
  const { demarrer, arreter } = require('./server.js');
  demarrer().catch(e => { console.error(e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n[synapse] arrêt');
      arreter().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
