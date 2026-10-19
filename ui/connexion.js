// Porte de SYNAPSE : installation, connexion, second facteur et inscription
// des facteurs exigés passent par la porte du socle, commune à tous les
// services. Une fois la session complète, retour à la mémoire.
import { Api, porte, appliquerTheme } from './socle/compte.js';

appliquerTheme();
const api = new Api({ surDeconnexion: () => location.reload() });
await porte({ api, service: 'SYNAPSE', sousTitre: 'mémoire et apprentissage' });
location.replace('/');
