// Ce que le dépôt doit porter pour qu'un clone construise la même image :
// chaque fichier du socle embarqué listé dans ses empreintes est suivi par git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const racine = new URL('..', import.meta.url).pathname;

test('socle embarqué : chaque fichier de ses empreintes est dans le dépôt, aucun ignoré', (t) => {
  let suivis;
  try { suivis = new Set(execFileSync('git', ['ls-files', 'socle'], { cwd: racine, encoding: 'utf8' }).split('\n')); }
  catch { return t.skip('hors d’un dépôt git'); }
  const listes = fs.readFileSync(new URL('../socle/EMPREINTES', import.meta.url), 'utf8').trim().split('\n').map(l => 'socle/' + l.split(/\s+/)[1]);
  const absents = listes.filter(f => !suivis.has(f));
  assert.deepEqual(absents, [], 'fichiers du socle non suivis par git (un clone ne les aurait pas)');
});
