// Clavier d'une machine distante : caractère → touches de sa disposition → événements VNC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPOSITIONS, appuis, intapables, caractereUs, evenementsCaractere, keysymCaractere, rythmeFrappe, normaliser, XT, codeQemu, dispositionConnue } from '../web/clavier.js';

const resume = ev => ev.map(e => `${e.bas ? '+' : '-'}${e.code}`).join(' ');

test('AZERTY : lettres échangées, chiffres sous Maj, Alt Gr et touches mortes', () => {
  assert.deepEqual(appuis('a', 'fr'), [['KeyQ', false, false]]);
  assert.deepEqual(appuis('1', 'fr'), [['Digit1', true, false]]);
  assert.deepEqual(appuis('@', 'fr'), [['Digit0', false, true]]);
  assert.deepEqual(appuis('ê', 'fr'), [['BracketLeft', false, false], ['KeyE', false, false]]);
  assert.deepEqual(appuis('a', 'us'), [['KeyA', false, false]]);
  assert.equal(appuis('é', 'us'), null);
  assert.equal(appuis('constructor', 'fr'), null, 'une clé héritée n’est pas un caractère');
  assert.equal(appuis('a', 'toString'), null);
  assert.ok(!dispositionConnue('__proto__'));
  assert.deepEqual(intapables('déjà vu\r\n', 'us'), ['é', 'à']);
  assert.equal(normaliser('a\r\nb\rc'), 'a\nb\nc');
  for (const d of Object.keys(DISPOSITIONS)) for (const ch of 'azertyuiopqsdfghjklmwxcvbnAZERTY0123456789 \n\t.,;:!?') assert.ok(appuis(ch, d), `${d} ${JSON.stringify(ch)}`);
});

test('événements QEMU : Maj et Alt Gr autour de la touche, keysym du caractère voulu sur la dernière', () => {
  const a = evenementsCaractere('A', 'fr');
  assert.equal(resume(a), '+ShiftLeft +KeyQ -KeyQ -ShiftLeft');
  assert.equal(a[1].keysym, 'A'.charCodeAt(0), 'majuscule : QEMU ne retouche pas Verr. Maj');
  assert.equal(a[1].xt, XT.KeyQ);
  assert.equal(resume(evenementsCaractere('@', 'fr')), '+AltRight +Digit0 -Digit0 -AltRight');
  assert.equal(evenementsCaractere('@', 'fr')[0].xt, codeQemu(0xe038));
  assert.equal(resume(evenementsCaractere('ê', 'fr')), '+BracketLeft -BracketLeft +KeyE -KeyE');
  assert.equal(evenementsCaractere('ê', 'fr')[2].keysym, 0xea);
  assert.equal(evenementsCaractere('\n', 'us')[0].keysym, 0xff0d);
  assert.equal(evenementsCaractere('é', 'us'), null);
});

test('événements « us » : le caractère que la touche porte en QWERTY, pour un serveur qui traduit en US', () => {
  // AZERTY visé, serveur QWERTY : « a » est la touche Q.
  assert.equal(evenementsCaractere('a', 'fr', { mode: 'us' })[0].keysym, 'q'.charCodeAt(0));
  const un = evenementsCaractere('1', 'fr', { mode: 'us' });
  assert.equal(resume(un), '+ShiftLeft +Digit1 -Digit1 -ShiftLeft');
  assert.equal(un[1].keysym, '!'.charCodeAt(0), 'Maj+1 en QWERTY : le serveur tape la touche 1 avec Maj, l’AZERTY donne 1');
  const at = evenementsCaractere('@', 'fr', { mode: 'us' });
  assert.equal(at[0].keysym, 0xffea, 'Alt Gr : Alt droite');
  assert.equal(at[1].keysym, '0'.charCodeAt(0));
  assert.equal(caractereUs('KeyQ', true), 'Q');
  assert.equal(caractereUs('Space'), ' ');
  assert.equal(caractereUs('IntlBackslash'), null);
});

test('keysym d’un caractère et rythme de frappe', () => {
  assert.equal(keysymCaractere('é'), 0xe9);
  assert.equal(keysymCaractere('€'), 0x01000000 | 0x20ac);
  assert.equal(keysymCaractere('\u0007'), 0);
  assert.equal(rythmeFrappe(10), 25);
  assert.ok(rythmeFrappe(1000) < rythmeFrappe(100), 'plus long, plus vite');
  assert.equal(rythmeFrappe(1e6), 8, 'jamais sous le plancher');
  assert.equal(rythmeFrappe(1e6, { min: 25 }), 25);
});
