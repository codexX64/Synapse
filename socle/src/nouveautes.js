// Nouveautés d'une mise à jour : quelques points courts que chaque compte voit
// une fois, à sa première connexion sur la nouvelle version. Un compte qui n'a
// encore rien vu (installation neuve, compte créé depuis) part de la version
// en cours, sans fenêtre.
//
// liste : [{ version: '2.4.0', date: '2026-10-30', points: ['…', '…'] }], la
// plus récente d'abord (le fichier nouveautes.json du service).

import fs from 'node:fs';

// 2.10.0 > 2.9.3 ; une étiquette (-rc.1) passe avant la version finale.
export function comparerVersions(a, b) {
  const p = v => String(v).split('-')[0].split('.').map(n => Number(n) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  }
  const ex = String(a).includes('-'), ey = String(b).includes('-');
  return ex === ey ? 0 : ex ? -1 : 1;
}

const PLAFOND_VERSIONS = 3;
const PLAFOND_POINTS = 8;

export class Nouveautes {
  constructor({ db, version, liste = [] }) {
    this.db = db;
    this.version = version;
    this.liste = (liste || [])
      .filter(n => n && typeof n.version === 'string' && Array.isArray(n.points) && comparerVersions(n.version, version) <= 0)
      .sort((a, b) => comparerVersions(b.version, a.version));
  }

  cle(compte) { return `nouveautes:${compte}`; }

  vue(compte) {
    return this.db.prepare('SELECT valeur FROM socle_reglages WHERE cle = ?').get(this.cle(compte))?.valeur ?? null;
  }

  marquer(compte) {
    this.db.prepare('INSERT INTO socle_reglages(cle, valeur) VALUES(?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur').run(this.cle(compte), this.version);
  }

  // Ce que ce compte n'a pas encore vu, ou null. cree : date de création du
  // compte. Sans trace : un compte récent part de la version en cours ; un
  // compte plus ancien que la fonction (mise à jour qui l'apporte) voit les
  // nouveautés de cette version.
  pour(compte, { cree = 0, maintenant = Date.now() } = {}) {
    if (!this.version || !this.liste.length) return null;
    let vue = this.vue(compte);
    if (vue === null) {
      if (maintenant - cree < 3600e3 || this.liste.length < 2 || comparerVersions(this.liste[0].version, this.version) !== 0) { this.marquer(compte); return null; }
      vue = this.liste[1].version;
    }
    if (comparerVersions(vue, this.version) >= 0) return null;
    const versions = this.liste.filter(n => comparerVersions(n.version, vue) > 0).slice(0, PLAFOND_VERSIONS)
      .map(n => ({ version: n.version, date: n.date || null, points: n.points.slice(0, PLAFOND_POINTS).map(p => String(p).slice(0, 300)) }));
    if (!versions.length) { this.marquer(compte); return null; }
    return { version: this.version, depuis: vue, versions };
  }
}

// Le nouveautes.json d'un service (chemin ou URL de fichier) ; absent ou
// illisible : aucune fenêtre, jamais un arrêt.
export function lireNouveautes(fichier) {
  try { const l = JSON.parse(fs.readFileSync(fichier, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
