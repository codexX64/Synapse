// Le compte : moyens de connexion, sessions, alertes et données (page
// « Sécurité » du socle) ; pour un administrateur, les comptes de SYNAPSE,
// leur politique et le journal (page « Comptes » du socle).
import { Api, porte, pageSecurite, pageComptes, h, icone, basculeTheme, appliquerTheme } from './socle/compte.js';
import { logoMarque } from './logo.js';

appliquerTheme();
const SERVICE = 'SYNAPSE';
const api = new Api({ surDeconnexion: () => location.reload() });
const session = await porte({ api, service: SERVICE, marque: logoMarque(20), sousTitre: 'mémoire et apprentissage' });
const admin = session.session.compte.role === 'admin';

const vues = {
  securite: { titre: 'Sécurité', rendre: () => pageSecurite(api, { service: SERVICE, confidentialite: '/confidentialite.txt' }) },
  ...(admin ? { comptes: { titre: 'Comptes', rendre: () => pageComptes(api, { service: SERVICE }) } } : {}),
};
// La coque du socle (.app > .main > .top + .stage) : la zone de travail
// porte ses requêtes de conteneur, la barre du haut reste sur une ligne.
const zone = h('div', { class: 'stage' });
const onglets = Object.entries(vues).map(([cle, v]) => h('button', { class: 'view', type: 'button', dataset: { vue: cle }, onclick: () => montrer(cle) }, v.titre));
function montrer(cle) {
  const v = vues[cle] || vues.securite;
  for (const b of onglets) b.classList.toggle('on', b.dataset.vue === cle);
  zone.replaceChildren(v.rendre());
  zone.scrollTop = 0;
  history.replaceState(null, '', '#' + cle);
}
document.body.append(h('div', { class: 'app' },
  h('main', { class: 'main' },
    h('header', { class: 'top' },
      h('a', { class: 'btn sm flat', href: '/', 'aria-label': 'Mémoire' }, icone('retour', 14), h('span', { class: 'etiquette', text: 'Mémoire' })),
      h('nav', { class: 'views', 'aria-label': 'Pages du compte' }, onglets),
      h('div', { class: 'topright' }, basculeTheme(),
        h('button', { class: 'btn sm flat', type: 'button', 'aria-label': 'Se déconnecter', onclick: async () => { await api.post('/api/compte/deconnexion'); location.replace('/connexion'); } }, icone('sortie', 14), h('span', { class: 'etiquette', text: 'Se déconnecter' })))),
    zone)));
montrer(location.hash.slice(1));
