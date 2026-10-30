// Frappe par le service : un texte tapé dans une machine par un transport fourni, à son rythme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Frappes, FRAPPE_MAX } from '../src/frappe.js';

const lien = () => {
  const ev = [], fins = [];
  return { ev, ferme: false, envoyer(e) { ev.push(e); }, fermer() { this.ferme = true; }, surFin(f) { fins.push(f); }, couper() { fins.forEach(f => f()); } };
};
const attendreFin = async (f, cle) => { for (let i = 0; i < 500; i++) { const e = f.etat(cle); if (e.etat !== 'en cours') return e; await new Promise(r => setTimeout(r, 5)); } throw new Error('sans fin'); };

test('frappe : chaque caractère sur sa touche, l’état ne dit que des nombres, le journal non plus', async () => {
  const l = lien(), journal = [];
  const f = new Frappes({ ouvrir: async () => l, journal: x => journal.push(x), attendre: () => Promise.resolve() });
  const e = f.demarrer('vm/1', { texte: 'Aé', disposition: 'fr', par: 'ana', contexte: { vm: 1 } });
  assert.equal(e.etat, 'en cours');
  assert.ok(!JSON.stringify(e).includes('Aé'));
  const fin = await attendreFin(f, 'vm/1');
  assert.equal(fin.etat, 'terminée');
  assert.equal(fin.tapes, 2);
  assert.deepEqual(l.ev.map(x => `${x.bas ? '+' : '-'}${x.code}`).join(' '), '+ShiftLeft +KeyQ -KeyQ -ShiftLeft +Digit2 -Digit2');
  assert.ok(l.ferme);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].vm, 1);
  assert.ok(!JSON.stringify(journal).includes('Aé'), 'jamais le texte au journal');
});

test('frappe : mode « traduit » (le serveur change le caractère en touche), « us » (serveur QWERTY)', async () => {
  const l = lien();
  const f = new Frappes({ ouvrir: async () => l, attendre: () => Promise.resolve() });
  f.demarrer('a', { texte: 'é€', mode: 'traduit' });
  await attendreFin(f, 'a');
  assert.deepEqual(l.ev.map(x => x.keysym), [0xe9, 0xe9, 0x010020ac, 0x010020ac]);
  const l2 = lien();
  const g = new Frappes({ ouvrir: async () => l2, attendre: () => Promise.resolve() });
  g.demarrer('b', { texte: 'a', disposition: 'fr', mode: 'us' });
  await attendreFin(g, 'b');
  assert.equal(l2.ev[0].keysym, 'q'.charCodeAt(0));
});

test('frappe : une à la fois par clé, arrêtée à la demande, coupée sans rien laisser enfoncé, refus', async () => {
  let n = 0;
  const l = lien();
  const lent = new Frappes({ ouvrir: async () => l, attendre: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))) });
  lent.demarrer('x', { texte: 'abc'.repeat(200), disposition: 'us' });
  assert.throws(() => lent.demarrer('x', { texte: 'a', disposition: 'us' }), e => e.status === 409);
  await new Promise(r => setTimeout(r, 20));
  lent.arreter('x');
  const arretee = await attendreFin(lent, 'x');
  assert.equal(arretee.etat, 'arrêtée');
  assert.ok(arretee.tapes < 600);
  const tenues = new Set(); for (const e of l.ev) { if (e.bas) tenues.add(e.code); else tenues.delete(e.code); }
  assert.equal(tenues.size, 0, 'rien ne reste enfoncé');

  const l2 = lien();
  const c = new Frappes({ ouvrir: async () => { n++; return l2; }, attendre: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))) });
  c.demarrer('y', { texte: 'A'.repeat(300), disposition: 'us' });
  await new Promise(r => setTimeout(r, 10));
  l2.couper();
  const coupee = await attendreFin(c, 'y');
  assert.equal(coupee.etat, 'échec');
  assert.match(coupee.message, /fermée/);

  const echec = new Frappes({ ouvrir: async () => { throw new Error('écran indisponible'); }, attendre: () => Promise.resolve() });
  echec.demarrer('z', { texte: 'a', disposition: 'us' });
  assert.equal((await attendreFin(echec, 'z')).etat, 'échec');

  const r = new Frappes({ ouvrir: async () => lien(), simultanees: 1, attendre: ms => new Promise(x => setTimeout(x, 1)) });
  for (const [args, code] of [[{ texte: '', disposition: 'fr' }, 400], [{ texte: 'a', disposition: 'de' }, 400], [{ texte: 'a', disposition: 'fr', mode: 'x' }, 400], [{ texte: 'a'.repeat(FRAPPE_MAX + 1), disposition: 'fr' }, 413]]) {
    assert.throws(() => r.demarrer('k', args), e => e.status === code, JSON.stringify(args).slice(0, 60));
  }
  r.demarrer('k1', { texte: 'abc'.repeat(50), disposition: 'fr' });
  assert.throws(() => r.demarrer('k2', { texte: 'a', disposition: 'fr' }), e => e.status === 429);
  r.arreterTout();
  await attendreFin(r, 'k1');
});
