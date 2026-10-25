// Gammes de SOMA : la valeur de SOCLE_THEME, la page rendue avec sa gamme, et
// une gamme Console qui redéfinit chaque jeton de couleur et de police.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lireConfig } from '../src/config.js';
import { SPEC_SOCLE, GAMMES, servirFichier, cheminVersionne } from '../src/index.js';

const WEB = path.resolve(import.meta.dirname, '..', 'web');

function rendre(gamme) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gamme-'));
  fs.writeFileSync(path.join(dossier, 'index.html'), '<html data-gamme="__GAMME__"><script nonce="__NONCE__"></script></html>');
  let corps = '';
  const res = { writeHead() {}, end(b) { corps = String(b ?? ''); } };
  assert.equal(servirFichier({ method: 'GET', headers: {} }, res, dossier, '/index.html', { nonce: 'n0', ...(gamme === undefined ? {} : { gamme }) }), true);
  return corps;
}

test('SOCLE_THEME : soma par défaut, console, exploitation et lavande admises, toute autre valeur arrête le démarrage', () => {
  assert.deepEqual(GAMMES, ['soma', 'console', 'exploitation', 'lavande']);
  assert.equal(lireConfig(SPEC_SOCLE, { SOCLE_THEME: 'lavande' }).gamme, 'lavande');
  assert.equal(lireConfig(SPEC_SOCLE, { SOCLE_THEME: 'exploitation' }).gamme, 'exploitation');
  assert.equal(lireConfig(SPEC_SOCLE, {}).gamme, 'soma');
  assert.equal(lireConfig(SPEC_SOCLE, { SOCLE_THEME: 'console' }).gamme, 'console');
  assert.throws(() => lireConfig(SPEC_SOCLE, { SOCLE_THEME: 'clair' }), /SOCLE_THEME/);
});

test('la page est rendue avec sa gamme ; une gamme inconnue retombe sur SOMA', () => {
  assert.equal(rendre('console'), '<html data-gamme="console"><script nonce="n0"></script></html>');
  assert.match(rendre(undefined), /data-gamme="soma"/);
  assert.match(rendre('"><script>'), /data-gamme="soma"/);
});

test('gamme Console : chaque jeton de SOMA redéfini, polices servies par le socle', () => {
  const css = fs.readFileSync(path.join(WEB, 'soma.css'), 'utf8');
  const bloc = re => (re.exec(css) || [])[1] || '';
  const jetons = b => new Set([...b.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]));
  const soma = jetons(bloc(/\n:root\{([^}]*)\}/));
  const consoleJ = jetons(bloc(/html:root\[data-gamme="console"\]\{([^}]*)\}/));
  const aRedefinir = [...soma].filter(j => !['rail', 'gouttiere', 'courbe', 'ecart'].includes(j));
  assert.ok(aRedefinir.length > 20);
  assert.deepEqual(aRedefinir.filter(j => !consoleJ.has(j)), [], 'jeton de SOMA laissé à sa valeur claire');
  for (const [, f] of css.matchAll(/url\((polices\/[^)]+)\)/g)) assert.ok(fs.existsSync(path.join(WEB, f)), f);
  for (const f of ['OFL-geist-sans.txt', 'OFL-geist-mono.txt']) assert.match(fs.readFileSync(path.join(WEB, 'polices', f), 'utf8'), /SIL Open Font License/);
  // Console claire : la bascule clair ou sombre reste offerte, chaque jeton
  // de couleur est redéfini, accent bleu.
  assert.doesNotMatch(css, /\.bascule-theme\{display:none/);
  const clair = jetons(bloc(/html:root\[data-gamme="console"\]\[data-theme="light"\]\{([^}]*)\}/));
  const couleurs = [...consoleJ].filter(j => !['sans', 'mono', 'r-ctl', 'r-carte', 'grain', 'ecart'].includes(j));
  assert.deepEqual(couleurs.filter(j => !clair.has(j)), [], 'jeton de la Console sombre sans valeur claire');
  assert.match(bloc(/html:root\[data-gamme="console"\]\[data-theme="light"\]\{([^}]*)\}/), /--accent:#2563EB/);
  // Les composants de la Console ne portent plus de couleur en dur : les deux
  // variantes passent par les jetons.
  const composants = css.slice(css.indexOf('/* Composants de la gamme Console')).split('\n').filter(l => l.startsWith('html[data-gamme="console"]'));
  assert.deepEqual(composants.filter(l => /#[0-9A-Fa-f]{3,6}\b|rgba\(/.test(l)), []);
});

test('gamme Exploitation : chaque jeton de SOMA redéfini en clair et en sombre, composants sans couleur en dur', () => {
  const css = fs.readFileSync(path.join(WEB, 'soma.css'), 'utf8');
  const bloc = re => (re.exec(css) || [])[1] || '';
  const jetons = b => new Set([...b.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]));
  const soma = [...jetons(bloc(/\n:root\{([^}]*)\}/))].filter(j => !['rail', 'gouttiere', 'courbe', 'ecart'].includes(j));
  const clair = jetons(bloc(/html:root\[data-gamme="exploitation"\]\{([^}]*)\}/));
  const sombreSysteme = jetons(bloc(/html:root\[data-gamme="exploitation"\]:not\(\[data-theme="light"\]\)\{([^}]*)\}/));
  const sombreChoisi = jetons(bloc(/html:root\[data-gamme="exploitation"\]\[data-theme="dark"\]\{([^}]*)\}/));
  assert.deepEqual(soma.filter(j => !clair.has(j)), [], 'jeton de SOMA laissé à sa valeur');
  const couleurs = [...clair].filter(j => !['sans', 'mono', 'r-ctl', 'r-carte', 'grain', 'ecart'].includes(j));
  assert.deepEqual(couleurs.filter(j => !sombreSysteme.has(j)), [], 'sombre du système incomplet');
  assert.deepEqual(couleurs.filter(j => !sombreChoisi.has(j)), [], 'sombre choisi incomplet');
  assert.equal(bloc(/html:root\[data-gamme="exploitation"\]:not\(\[data-theme="light"\]\)\{([^}]*)\}/).trim(), bloc(/html:root\[data-gamme="exploitation"\]\[data-theme="dark"\]\{([^}]*)\}/).trim(), 'les deux sombres sont le même');
  const composants = css.split('\n').filter(l => /^\s*html\[data-gamme="exploitation"\]/.test(l));
  assert.ok(composants.length > 30);
  assert.deepEqual(composants.filter(l => /#[0-9A-Fa-f]{3,6}\b|rgba\(/.test(l)), []);
});

test('gamme Lavande : chaque jeton de SOMA redéfini en clair et en sombre, composants sans couleur en dur, Poppins servie', () => {
  const css = fs.readFileSync(path.join(WEB, 'soma.css'), 'utf8');
  const bloc = re => (re.exec(css) || [])[1] || '';
  const jetons = b => new Set([...b.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]));
  const soma = [...jetons(bloc(/\n:root\{([^}]*)\}/))].filter(j => !['rail', 'gouttiere', 'courbe', 'ecart'].includes(j));
  const clair = jetons(bloc(/html:root\[data-gamme="lavande"\]\{([^}]*)\}/));
  const sombreSysteme = bloc(/html:root\[data-gamme="lavande"\]:not\(\[data-theme="light"\]\)\{([^}]*)\}/);
  const sombreChoisi = bloc(/html:root\[data-gamme="lavande"\]\[data-theme="dark"\]\{([^}]*)\}/);
  assert.deepEqual(soma.filter(j => !clair.has(j)), [], 'jeton de SOMA laissé à sa valeur');
  const couleurs = [...clair].filter(j => !['sans', 'mono', 'r-ctl', 'r-carte', 'grain', 'ecart'].includes(j));
  assert.deepEqual(couleurs.filter(j => !jetons(sombreSysteme).has(j)), [], 'sombre du système incomplet');
  assert.equal(sombreSysteme.trim(), sombreChoisi.trim(), 'les deux sombres sont le même');
  const composants = css.split('\n').filter(l => /^\s*html\[data-gamme="lavande"\]/.test(l));
  assert.ok(composants.length > 25);
  assert.deepEqual(composants.filter(l => /#[0-9A-Fa-f]{3,6}\b|rgba\(/.test(l)), []);
  for (const w of [300, 400, 500, 600]) for (const p of ['latin', 'latin-ext']) assert.ok(fs.existsSync(path.join(WEB, 'polices', `poppins-${p}-${w}-normal.woff2`)));
  assert.match(fs.readFileSync(path.join(WEB, 'polices', 'OFL-poppins.txt'), 'utf8'), /SIL Open Font License/);
});

test('fichiers sous /v/<version>/ : la page porte sa version, le préfixe est retiré, cache durable pour la version courante seulement', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'version-'));
  fs.writeFileSync(path.join(dossier, 'index.html'), '<script src="/v/__VERSION__/app.js"></script>');
  const page = v => { let corps = ''; servirFichier({ method: 'GET', headers: {} }, { writeHead() {}, end(b) { corps = String(b ?? ''); } }, dossier, '/index.html', { version: v }); return corps; };
  assert.equal(page('1.2.3'), '<script src="/v/1.2.3/app.js"></script>');
  assert.equal(page('"><script>'), '<script src="/v/0/app.js"></script>', 'une version hors format ne s’écrit jamais dans la page');
  assert.deepEqual(cheminVersionne('/v/1.2.3/socle/compte.js', '1.2.3'), { chemin: '/socle/compte.js', durable: true });
  assert.deepEqual(cheminVersionne('/v/1.2.2/app.js', '1.2.3'), { chemin: '/app.js', durable: false }, 'une page gardée en cache reçoit le fichier courant, sans cache durable');
  assert.deepEqual(cheminVersionne('/app.js', '1.2.3'), { chemin: '/app.js', durable: false });
  assert.deepEqual(cheminVersionne('/v/../../etc/passwd', '1.2.3').chemin, '/../etc/passwd', 'le reste passe par servirFichier, qui borne le chemin à sa racine');
});
