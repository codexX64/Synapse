// Le logo de SYNAPSE, dans la couleur du texte : la marque de la barre et de
// l'écran de connexion (même tracé que l'icône de l'onglet).
const LOGO_NS = 'http://www.w3.org/2000/svg';
export function logoMarque(taille = 16) {
  const s = document.createElementNS(LOGO_NS, 'svg');
  s.setAttribute('width', taille); s.setAttribute('height', taille);
  s.setAttribute('viewBox', '2 2 252 252'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'logo-marque');
  const p = document.createElementNS(LOGO_NS, 'path');
  p.setAttribute('d', 'M113.9 128A81.2 56 0 1 1 198.32 44.85L152.76 62.99A52.2 36 0 1 0 113.9 128ZM142.1 128A81.2 56 0 1 1 57.68 211.15L103.24 193.01A52.2 36 0 1 0 142.1 128Z');
  p.setAttribute('fill', 'currentColor');
  s.append(p);
  return s;
}
