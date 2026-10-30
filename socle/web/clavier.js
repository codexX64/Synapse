// Clavier d'une machine distante : d'un caractère aux touches physiques qui le
// donnent dans sa disposition (AZERTY, QWERTY), et des touches aux messages
// d'un écran distant (VNC). Sans DOM : servi au navigateur (/socle/clavier.js)
// et importé tel quel par un serveur qui tape à la place du navigateur.
//
// Deux façons de désigner une touche à l'autre bout :
//   - « qemu » : le code physique part avec le keysym (touche étendue de QEMU) ;
//     la machine applique sa propre disposition. Le keysym n'y sert qu'à caler
//     Verr. Maj (QEMU compare la casse d'une lettre à l'état de Maj) ;
//   - « us » : un serveur VNC qui ne reçoit que des keysyms et les change en
//     touches comme un clavier QWERTY US (KVM, iDRAC, iLO) : on lui envoie le
//     caractère que la touche voulue porte en QWERTY ;
//   - « traduit » : un serveur VNC qui change lui-même un keysym en touches
//     selon la disposition de sa machine : le caractère part tel quel.

// event.code → code XT (préfixe E0 noté 0xE0xx).
export const XT = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17,
  KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42,
  F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b,
  Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037,
  AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050,
  PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};
// Code envoyé à QEMU : un code étendu E0xx devient xx | 0x80.
export const codeQemu = xt => ((xt >> 8) === 0xe0 && (xt & 0xff) < 0x7f ? (xt & 0xff) | 0x80 : xt);

// Les touches sans caractère : leur keysym X11.
export const KEYSYMS = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52,
  ArrowRight: 0xff53, ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, ContextMenu: 0xff67, NumLock: 0xff7f,
  CapsLock: 0xffe5, ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4, MetaLeft: 0xffeb, MetaRight: 0xffec,
  AltLeft: 0xffe9, AltRight: 0xfe03, PrintScreen: 0xff61, ScrollLock: 0xff14,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 0xffbe + i])),
};
const ALT_DROITE_US = 0xffea;    // Alt_R : la touche Alt Gr pour un serveur qui traduit en QWERTY

// Le keysym d'un caractère : Latin-1 tel quel, le reste en Unicode
// (0x01000000 + point de code) ; retour à la ligne et tabulation par leur touche.
export function keysymCaractere(ch) {
  if (ch === '\n' || ch === '\r') return KEYSYMS.Enter;
  if (ch === '\t') return KEYSYMS.Tab;
  const c = String(ch).codePointAt(0);
  if (c === undefined || c < 0x20 || c === 0x7f) return 0;
  return c < 0x100 ? c : 0x01000000 | c;
}

// Caractère → touches physiques, par disposition. [code, maj, altgr] ; une
// suite pour les touches mortes (^ puis e → ê).
const T = (code, maj = false, altgr = false) => [code, maj, altgr];
function carteUs() {
  const c = {};
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(97 + i), code = `Key${l.toUpperCase()}`; c[l] = [T(code)]; c[l.toUpperCase()] = [T(code, true)]; }
  '0123456789'.split('').forEach(d => { c[d] = [T(`Digit${d}`)]; });
  ')!@#$%^&*('.split('').forEach((x, i) => { c[x] = [T(`Digit${i}`, true)]; });
  for (const [code, bas, haut] of [['Minus', '-', '_'], ['Equal', '=', '+'], ['BracketLeft', '[', '{'], ['BracketRight', ']', '}'], ['Backslash', '\\', '|'], ['Semicolon', ';', ':'], ['Quote', "'", '"'], ['Comma', ',', '<'], ['Period', '.', '>'], ['Slash', '/', '?'], ['Backquote', '`', '~']]) { c[bas] = [T(code)]; c[haut] = [T(code, true)]; }
  return c;
}
function carteFr() {
  const c = {};
  const lettres = { a: 'KeyQ', z: 'KeyW', q: 'KeyA', w: 'KeyZ', m: 'Semicolon' };
  for (let i = 0; i < 26; i++) { const l = String.fromCharCode(97 + i), code = lettres[l] || `Key${l.toUpperCase()}`; c[l] = [T(code)]; c[l.toUpperCase()] = [T(code, true)]; }
  const rang = ['&', 'é', '"', "'", '(', '-', 'è', '_', 'ç', 'à'];
  rang.forEach((x, i) => { const code = `Digit${(i + 1) % 10}`; c[x] = [T(code)]; c[String((i + 1) % 10)] = [T(code, true)]; });
  for (const [code, bas, haut] of [['Minus', ')', '°'], ['Equal', '=', '+'], ['BracketRight', '$', '£'], ['Quote', 'ù', '%'], ['Backslash', '*', 'µ'], ['KeyM', ',', '?'], ['Comma', ';', '.'], ['Period', ':', '/'], ['Slash', '!', '§'], ['IntlBackslash', '<', '>']]) { c[bas] = [T(code)]; c[haut] = [T(code, true)]; }
  c['²'] = [T('Backquote')];
  for (const [code, x] of [['Digit2', '~'], ['Digit3', '#'], ['Digit4', '{'], ['Digit5', '['], ['Digit6', '|'], ['Digit7', '`'], ['Digit8', '\\'], ['Digit9', '^'], ['Digit0', '@'], ['Minus', ']'], ['Equal', '}'], ['KeyE', '€']]) c[x] = [T(code, false, true)];
  for (const [b, v] of [['a', 'â'], ['e', 'ê'], ['i', 'î'], ['o', 'ô'], ['u', 'û']]) c[v] = [T('BracketLeft'), ...c[b]];
  for (const [b, v] of [['a', 'ä'], ['e', 'ë'], ['i', 'ï'], ['o', 'ö'], ['u', 'ü'], ['y', 'ÿ']]) c[v] = [T('BracketLeft', true), ...c[b]];
  return c;
}
const COMMUNES = { ' ': [T('Space')], '\n': [T('Enter')], '\t': [T('Tab')] };
export const DISPOSITIONS = Object.freeze({
  fr: { nom: 'AZERTY (français)', carte: Object.freeze({ ...carteFr(), ...COMMUNES }) },
  us: { nom: 'QWERTY (US)', carte: Object.freeze({ ...carteUs(), ...COMMUNES }) },
});
export const dispositionConnue = d => Object.hasOwn(DISPOSITIONS, d);

// Ce qu'un texte devient avant d'être tapé : fins de ligne unifiées.
export const normaliser = texte => String(texte ?? '').replace(/\r\n?/g, '\n');
// Les touches qui donnent ce caractère dans cette disposition, ou null.
export const appuis = (ch, d) => (dispositionConnue(d) && Object.hasOwn(DISPOSITIONS[d].carte, ch) ? DISPOSITIONS[d].carte[ch] : null);
// Les caractères qu'une disposition ne sait pas taper.
export const intapables = (texte, d) => [...new Set([...normaliser(texte)].filter(ch => !appuis(ch, d)))];

// Le caractère que porte une touche en QWERTY US (avec ou sans Maj), ou null.
const US = new Map();
for (const [ch, suite] of Object.entries(carteUs())) if (suite.length === 1) US.set(`${suite[0][0]}|${suite[0][1] ? 1 : 0}`, ch);
export const caractereUs = (code, maj = false) => (code === 'Space' ? ' ' : US.get(`${code}|${maj ? 1 : 0}`) ?? null);

const keysymTouche = (code, maj) => KEYSYMS[code] ?? (caractereUs(code, maj) !== null ? keysymCaractere(caractereUs(code, maj)) : 0);

/**
 * Les événements qui tapent le caractère `ch` : pour chaque touche de sa suite,
 * Maj et Alt Gr si besoin, la touche, puis les relâchés à rebours. Chaque
 * événement : { code, xt, keysym, bas }. `xt` est le code à donner à QEMU.
 */
export function evenementsCaractere(ch, d, { mode = 'qemu' } = {}) {
  // « traduit » : un serveur VNC qui change lui-même un keysym en touches,
  // selon la disposition de sa machine (bureau Linux, macOS, Windows) : le
  // caractère part tel quel, quelle que soit la disposition.
  if (mode === 'traduit') {
    const ks = keysymCaractere(ch);
    return ks ? [{ code: null, xt: 0, keysym: ks, bas: true }, { code: null, xt: 0, keysym: ks, bas: false }] : null;
  }
  const suite = appuis(ch, d);
  if (!suite) return null;
  const ev = [];
  const pousser = (code, keysym, bas) => ev.push({ code, xt: XT[code] ? codeQemu(XT[code]) : 0, keysym, bas });
  suite.forEach(([code, maj, altgr], j) => {
    const derniere = j === suite.length - 1;
    // QEMU : le keysym du caractère voulu sur la dernière touche (sa casse cale
    // Verr. Maj) ; ailleurs, et pour un serveur QWERTY, celui que la touche porte en US.
    const ks = mode === 'qemu' && derniere && [...ch].length === 1 && ch > ' ' ? keysymCaractere(ch) : keysymTouche(code, maj);
    const altgrKs = mode === 'us' ? ALT_DROITE_US : KEYSYMS.AltRight;
    if (maj) pousser('ShiftLeft', KEYSYMS.ShiftLeft, true);
    if (altgr) pousser('AltRight', altgrKs, true);
    pousser(code, ks, true);
    pousser(code, ks, false);
    if (altgr) pousser('AltRight', altgrKs, false);
    if (maj) pousser('ShiftLeft', KEYSYMS.ShiftLeft, false);
  });
  return ev;
}

/**
 * Le rythme d'une frappe : millisecondes par caractère. Un texte court part au
 * pas d'une frappe humaine rapide ; plus il est long, plus il va vite (la durée
 * croît comme la racine de sa longueur), sans descendre sous `min` — en deçà,
 * la file du clavier de la machine (16 octets en PS/2 dans QEMU) peut déborder
 * et perdre des relâchés.
 */
export function rythmeFrappe(n, { min = 8, max = 25 } = {}) {
  const ms = Math.round(400 / Math.sqrt(Math.max(1, n)));
  return Math.max(min, Math.min(max, ms));
}
