// Le compte : moyens de connexion, sessions, alertes et données (page
// « Sécurité » du socle) ; pour un administrateur, les comptes de SYNAPSE,
// leur politique et le journal (page « Comptes » du socle).
import { Api, porte, pageSecurite, pageComptes, h, icone, basculeTheme, appliquerTheme } from './socle/compte.js';

appliquerTheme();
const SERVICE = 'SYNAPSE';
const api = new Api({ surDeconnexion: () => location.reload() });
const session = await porte({ api, service: SERVICE, sousTitre: 'mémoire et apprentissage' });
const admin = session.session.compte.role === 'admin';

const vues = {
  securite: { titre: 'Sécurité', rendre: () => pageSecurite(api, { service: SERVICE, confidentialite: '/confidentialite.txt' }) },
  ...(admin ? { comptes: { titre: 'Comptes', rendre: () => pageComptes(api, { service: SERVICE }) } } : {}),
};
const zone = h('main', { class: 'contenu' });
const onglets = Object.entries(vues).map(([cle, v]) => h('button', { class: 'btn sm flat', type: 'button', dataset: { vue: cle }, onclick: () => montrer(cle) }, v.titre));
function montrer(cle) {
  const v = vues[cle] || vues.securite;
  for (const b of onglets) b.classList.toggle('solid', b.dataset.vue === cle);
  zone.replaceChildren(v.rendre());
  history.replaceState(null, '', '#' + cle);
}
document.body.append(h('div', { class: 'app' },
  h('header', { class: 'barre' },
    h('a', { class: 'btn sm flat', href: '/' }, icone('retour', 14), 'Mémoire'),
    h('nav', { class: 'onglets' }, onglets),
    h('div', { class: 'fin' }, basculeTheme(),
      h('button', { class: 'btn sm flat', type: 'button', onclick: async () => { await api.post('/api/compte/deconnexion'); location.replace('/connexion'); } }, icone('sortie', 14), 'Se déconnecter'))),
  zone));
montrer(location.hash.slice(1));
