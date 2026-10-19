// Graphiques communs des services : courbe (aire ou trait, plusieurs séries),
// anneau, jauge, calendrier d'états, barre de capacité, carte en tuiles et
// étincelle. Tout est construit nœud par nœud (createElementNS) : aucun
// balisage injecté, aucune couleur en attribut de style. Les couleurs viennent
// des classes .g-c1 à .g-c6 et .g-ok, .g-degrade, .g-incident, qui lisent les
// jetons de la gamme. Chaque graphique porte un libellé et un tableau lisible
// par un lecteur d'écran.
import { h } from './compte.js';

const NS = 'http://www.w3.org/2000/svg';
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
export const nombre = (v, d = 1) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(v);

function s(tag, attrs = {}, ...enfants) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const e of enfants.flat()) if (e) el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  return el;
}
const borne = (v, a, b) => Math.max(a, Math.min(b, v));
const couleur = i => `g-c${(i % 6) + 1}`;

// Tableau accessible : ce que le graphique dit, en lignes.
function tableau(libelle, lignes) {
  return h('table', { class: 'sr' }, h('caption', { text: libelle }),
    h('tbody', {}, lignes.map(([a, b]) => h('tr', {}, h('th', { scope: 'row', text: a }), h('td', { text: b })))));
}

// Une bulle unique pour toute la page, placée en CSSOM.
let bulle;
function montrerBulle(e, lignes) {
  if (!bulle) { bulle = h('div', { class: 'g-bulle', role: 'tooltip' }); document.body.append(bulle); }
  bulle.replaceChildren(...lignes.map((l, i) => i === 0 ? h('b', { text: l }) : h('div', { text: l })));
  bulle.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - bulle.offsetWidth - 8), y = Math.min(e.clientY + 16, innerHeight - bulle.offsetHeight - 8);
  bulle.style.left = `${Math.max(8, x)}px`;
  bulle.style.top = `${Math.max(8, y)}px`;
}
function cacherBulle() { if (bulle) bulle.hidden = true; }
function infobulle(el, lignes) {
  el.addEventListener('pointermove', e => montrerBulle(e, typeof lignes === 'function' ? lignes() : lignes));
  el.addEventListener('pointerleave', cacherBulle);
}

// Lissage d'une suite de points (Catmull-Rom vers Bézier).
function trace(points) {
  return points.map((p, i, a) => {
    if (!i) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    const p0 = a[i - 2] || a[0], p1 = a[i - 1], p3 = a[i + 1] || p;
    return `C${(p1[0] + (p[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p[1] - p0[1]) / 6).toFixed(1)} ${(p[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  }).join(' ');
}

// Courbe : séries [{ nom, valeurs }], étiquettes de l'axe horizontal (5 à 7),
// format(v) pour les valeurs. Redessinée à la largeur réelle de son conteneur.
export function courbe({ series, etiquettes = [], hauteur = 200, format = v => nf.format(v), max = null, aire = true, libelle = 'Courbe', legende = true, instants = null }) {
  const boite = h('div', { class: 'graphe g-courbe' });
  const masquees = new Set();
  const leg = legende && series.length > 1 ? h('div', { class: 'g-legende' }, series.map((sr, i) => {
    const b = h('button', { type: 'button', 'aria-pressed': 'true' }, h('i', { class: 'g-pastille ' + couleur(i) }), sr.nom);
    b.addEventListener('click', () => { masquees.has(i) ? masquees.delete(i) : masquees.add(i); b.setAttribute('aria-pressed', String(!masquees.has(i))); dessiner(); });
    return b;
  })) : null;
  const zone = h('div', { class: 'g-zone' });
  boite.append(...[leg, zone, tableau(libelle, series.map(sr => [sr.nom, sr.valeurs.map(v => format(v)).join(' ; ')]))].filter(Boolean));
  let largeur = 0;
  function dessiner() {
    const w = Math.max(240, largeur || zone.clientWidth || 600), hh = hauteur;
    const g = 44, d = 8, t = 8, b = 22, pw = w - g - d, ph = hh - t - b;
    const actives = series.map((sr, i) => ({ ...sr, i })).filter(sr => !masquees.has(sr.i) && sr.valeurs.length);
    const haut = max ?? Math.max(1e-9, ...actives.flatMap(sr => sr.valeurs)) * 1.15;
    const n = Math.max(...series.map(sr => sr.valeurs.length), 2);
    const x = j => g + j * pw / (n - 1), y = v => t + ph - borne(v / haut, 0, 1) * ph;
    const svg = s('svg', { viewBox: `0 0 ${w} ${hh}`, width: w, height: hh, role: 'img', 'aria-label': libelle });
    for (let k = 0; k <= 4; k++) {
      const yy = t + k * ph / 4;
      svg.append(s('path', { class: 'g-grille', d: `M${g} ${yy}H${w - d}` }), s('text', { x: g - 6, y: yy + 3.5, 'text-anchor': 'end' }, format(haut * (1 - k / 4))));
    }
    etiquettes.forEach((e, k) => svg.append(s('text', { x: g + k * pw / Math.max(1, etiquettes.length - 1), y: hh - 5, 'text-anchor': k === 0 ? 'start' : k === etiquettes.length - 1 ? 'end' : 'middle' }, e)));
    for (const sr of actives) {
      const pts = sr.valeurs.map((v, j) => [x(j), y(v)]);
      if (aire) svg.append(s('path', { class: 'g-aire ' + couleur(sr.i), d: `${trace(pts)} L${pts.at(-1)[0]},${t + ph} L${pts[0][0]},${t + ph} Z` }));
      svg.append(s('path', { class: 'g-trait ' + couleur(sr.i), d: trace(pts) }));
    }
    const repere = s('g', { class: 'g-repere', visibility: 'hidden' }, s('path', { d: `M0 ${t}V${t + ph}` }), actives.map(sr => s('circle', { r: 3.5, class: couleur(sr.i) })));
    const capte = s('rect', { x: g, y: 0, width: pw, height: t + ph, class: 'g-capte' });
    svg.append(repere, capte);
    capte.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect();
      const j = Math.round(borne((e.clientX - r.left) * w / r.width - g, 0, pw) / pw * (n - 1));
      repere.setAttribute('visibility', 'visible');
      repere.firstChild.setAttribute('transform', `translate(${x(j)} 0)`);
      [...repere.querySelectorAll('circle')].forEach((c, k) => { c.setAttribute('cx', x(j)); c.setAttribute('cy', y(actives[k].valeurs[j] ?? 0)); });
      montrerBulle(e, [instants?.[j] || `Point ${j + 1}`, ...actives.map(sr => `${sr.nom} : ${format(sr.valeurs[j] ?? 0)}`)]);
    });
    capte.addEventListener('pointerleave', () => { repere.setAttribute('visibility', 'hidden'); cacherBulle(); });
    zone.replaceChildren(svg);
  }
  new ResizeObserver(es => { const nw = Math.round(es[0].contentRect.width); if (nw > 0 && Math.abs(nw - largeur) > 2) { largeur = nw; dessiner(); } }).observe(zone);
  dessiner();
  return boite;
}

// Anneau : parts [{ nom, valeur }], un chiffre au centre.
export function anneau({ parts, centre = '', sous = '', libelle = 'Répartition', taille = 150, legende = true }) {
  const total = parts.reduce((a, p) => a + p.valeur, 0) || 1, r = taille * .38, c = 2 * Math.PI * r, m = taille / 2;
  const svg = s('svg', { viewBox: `0 0 ${taille} ${taille}`, width: taille, height: taille, role: 'img', 'aria-label': libelle });
  svg.append(s('circle', { cx: m, cy: m, r, class: 'g-fond-anneau' }));
  let decal = 0;
  parts.forEach((p, i) => {
    const l = p.valeur / total * c;
    if (l <= 0) return;
    const arc = s('circle', { cx: m, cy: m, r, class: 'g-arc ' + (p.classe || couleur(i)), 'stroke-dasharray': `${Math.max(0, l - 1.5)} ${c}`, 'stroke-dashoffset': -decal, transform: `rotate(-90 ${m} ${m})` });
    infobulle(arc, [p.nom, `${nf.format(p.valeur)} (${nf.format(p.valeur / total * 100)} %)`]);
    svg.append(arc);
    decal += l;
  });
  svg.append(s('text', { x: m, y: m + (sous ? 2 : 7), 'text-anchor': 'middle', class: 'g-centre' }, centre));
  if (sous) svg.append(s('text', { x: m, y: m + 18, 'text-anchor': 'middle' }, sous));
  return h('div', { class: 'graphe g-anneau' }, svg,
    legende ? h('div', { class: 'g-legende fixe' }, parts.map((p, i) => h('span', {}, h('i', { class: 'g-pastille ' + (p.classe || couleur(i)) }), `${p.nom} `, h('b', { text: nf.format(p.valeur) })))) : null,
    tableau(libelle, parts.map(p => [p.nom, nf.format(p.valeur)])));
}

// Jauge : une proportion (0 à 100) en arc complet.
export function jauge({ valeur, centre = `${nf.format(valeur)} %`, sous = '', libelle = 'Jauge', taille = 130, etat = 'g-ok' }) {
  const r = taille * .38, c = 2 * Math.PI * r, m = taille / 2;
  const svg = s('svg', { viewBox: `0 0 ${taille} ${taille}`, width: taille, height: taille, role: 'img', 'aria-label': `${libelle} : ${centre}` },
    s('circle', { cx: m, cy: m, r, class: 'g-fond-anneau' }),
    s('circle', { cx: m, cy: m, r, class: 'g-arc ' + etat, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * borne(valeur, 0, 100) / 100} ${c}`, transform: `rotate(-90 ${m} ${m})` }),
    s('text', { x: m, y: m + (sous ? 2 : 7), 'text-anchor': 'middle', class: 'g-centre' }, centre),
    sous ? s('text', { x: m, y: m + 18, 'text-anchor': 'middle' }, sous) : null);
  return h('div', { class: 'graphe g-jauge' }, svg);
}

// Calendrier : cellules [{ etat: 'ok'|'degrade'|'incident'|'vide', titre }]
// rangées en lignes de « colonnes » cellules ; une étiquette par ligne.
// Le dessin suit la largeur offerte, sans dépasser « agrandi » fois sa taille
// naturelle : des cases géantes et des étiquettes énormes n'aident personne.
export function calendrier({ cellules, colonnes, lignes = [], libelle = 'Calendrier', cote = 14, ecart = 3, agrandi = 1.4 }) {
  const rangs = Math.ceil(cellules.length / colonnes), g = lignes.length ? 30 : 0;
  const w = g + colonnes * (cote + ecart) - ecart, hh = rangs * (cote + ecart) - ecart;
  const svg = s('svg', { viewBox: `0 0 ${w} ${hh}`, class: 'g-cal', role: 'img', 'aria-label': libelle, preserveAspectRatio: 'xMinYMin meet' });
  svg.style.maxWidth = `${Math.round(w * agrandi)}px`;
  cellules.forEach((c, i) => {
    const r = s('rect', { x: g + (i % colonnes) * (cote + ecart), y: Math.floor(i / colonnes) * (cote + ecart), width: cote, height: cote, rx: 2, class: 'g-' + (c.etat || 'vide') });
    if (c.titre) infobulle(r, [c.titre]);
    svg.append(r);
  });
  lignes.forEach((l, j) => svg.append(s('text', { x: 0, y: j * (cote + ecart) + cote - 3 }, l)));
  const compte = e => cellules.filter(c => c.etat === e).length;
  return h('div', { class: 'graphe g-calendrier' }, svg,
    tableau(libelle, [['Sans incident', String(compte('ok'))], ['Dégradé', String(compte('degrade'))], ['Incident', String(compte('incident'))]]));
}

// Barre de capacité découpée en cases : opérationnels, dégradés, en incident
// et au repos (arrêtés de leur plein gré), à proportion, sur « cases ».
export function capacite({ ok = 0, degrade = 0, incident = 0, repos = 0, cases = 30, libelle = 'Capacité' }) {
  const total = ok + degrade + incident + repos || 1;
  const part = n => (n ? Math.max(1, Math.round(n / total * cases)) : 0);
  const nI = part(incident), nD = part(degrade), nR = Math.min(part(repos), cases - nI - nD);
  return h('div', { class: 'g-capacite', role: 'img', 'aria-label': `${libelle} : ${ok} opérationnels, ${degrade} dégradés, ${incident} en incident, ${repos} au repos` },
    Array.from({ length: cases }, (_, i) => h('i', { class: i >= cases - nI ? 'g-incident' : i >= cases - nI - nD ? 'g-degrade' : i >= cases - nI - nD - nR ? 'g-vide' : 'g-ok' })));
}

// Carte en tuiles : parts [{ nom, valeur, detail }] côte à côte, à proportion.
export function tuiles({ parts, libelle = 'Répartition', format = v => nf.format(v) }) {
  const total = parts.reduce((a, p) => a + p.valeur, 0) || 1;
  const boite = h('div', { class: 'graphe g-tuiles', role: 'img', 'aria-label': libelle });
  parts.filter(p => p.valeur > 0).forEach((p, i) => {
    const t = h('div', { class: 'g-tuile ' + couleur(i) }, h('b', { text: p.nom }), h('span', { text: format(p.valeur) }));
    t.style.flexGrow = String(p.valeur / total * 100);
    infobulle(t, [p.nom, format(p.valeur), ...(p.detail ? [p.detail] : [])]);
    boite.append(t);
  });
  boite.append(tableau(libelle, parts.map(p => [p.nom, format(p.valeur)])));
  return boite;
}

// Étincelle : une petite courbe sans axe, pour un indicateur.
export function etincelle({ valeurs, largeur = 64, hauteur = 22, classe = 'g-c1' }) {
  if (!valeurs?.length) return null;
  const haut = Math.max(1e-9, ...valeurs), bas = Math.min(...valeurs), et = haut - bas || 1;
  const pts = valeurs.map((v, j) => [1 + j * (largeur - 2) / Math.max(1, valeurs.length - 1), 2 + (1 - (v - bas) / et) * (hauteur - 4)]);
  return s('svg', { viewBox: `0 0 ${largeur} ${hauteur}`, width: largeur, height: hauteur, class: 'g-etincelle', 'aria-hidden': 'true' }, s('path', { class: 'g-trait ' + classe, d: trace(pts) }));
}
