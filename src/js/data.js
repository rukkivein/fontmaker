// Static data: alphabet/unicode tables, grid presets, default metrics.

export const UPM = 1000;

export const DEFAULT_METRICS = {
  ascender: 800,
  capHeight: 700,
  xHeight: 500,
  baseline: 0,
  descender: -200,
};

// ---- Alphabet definitions ------------------------------------------------
// Each entry: { char, name, unicode }. Kept compact but representative of
// real industry character sets so the chartboard feels production-like.

function range(from, to) {
  const out = [];
  for (let c = from.codePointAt(0); c <= to.codePointAt(0); c++) {
    out.push({ char: String.fromCodePoint(c), unicode: c, name: charName(c) });
  }
  return out;
}
function chars(str) {
  return [...str].map(ch => ({ char: ch, unicode: ch.codePointAt(0), name: charName(ch.codePointAt(0)) }));
}
function charName(cp) {
  const ch = String.fromCodePoint(cp);
  const named = {
    ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar',
    '%': 'percent', '&': 'ampersand', "'": 'quotesingle', '(': 'parenleft', ')': 'parenright',
    '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'hyphen', '.': 'period', '/': 'slash',
    ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question',
    '@': 'at', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum',
    '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde'
  };
  if (named[ch]) return named[ch];
  if (/[A-Z]/.test(ch)) return ch;          // 'A'
  if (/[a-z]/.test(ch)) return ch;          // 'a'
  if (/[0-9]/.test(ch)) return ['zero','one','two','three','four','five','six','seven','eight','nine'][+ch];
  return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0');
}

export const ALPHABETS = {
  latin: {
    label: 'Latin (Basic)',
    glyphs: () => [
      ...chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      ...chars('abcdefghijklmnopqrstuvwxyz'),
      ...chars('0123456789'),
      ...chars('.,:;!?\'"()[]{}-–—/\\&@#%+*=<>'),
      { char: ' ', unicode: 32, name: 'space' },
    ],
  },
  latinExt: {
    label: 'Latin Extended',
    glyphs: () => chars('ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿŠŽšžŸŒœ'),
  },
  cyrillic: {
    label: 'Cyrillic',
    glyphs: () => [...range('А', 'я')],
  },
  greek: {
    label: 'Greek',
    glyphs: () => [...range('Α', 'Ω'), ...range('α', 'ω')],
  },
  arabic: {
    label: 'Arabic',
    glyphs: () => chars('ابتثجحخدذرزسشصضطظعغفقكلمنهوي'),
  },
  hebrew: {
    label: 'Hebrew',
    glyphs: () => chars('אבגדהוזחטיכלמנסעפצקרשת'),
  },
  japanese: {
    label: 'Japanese (Hiragana)',
    glyphs: () => chars('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'),
  },
};

// First "anchor" glyph each alphabet should open on.
export const ALPHABET_ANCHOR = {
  latin: 'A', latinExt: 'À', cyrillic: 'А', greek: 'Α',
  arabic: 'ا', hebrew: 'א', japanese: 'あ',
};

// Strip diacritics to find related glyphs (for Find Glyph suggestions).
export function baseLetter(ch) {
  try { return ch.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  catch { return ch; }
}

// ---- Grid presets --------------------------------------------------------
// A grid is a set of horizontal metric lines plus optional vertical / golden
// / radial guides. Movable only in grid-edit mode (Tab), kept symmetric.
const PHI = 1.61803398875;

export const GRID_PRESETS = {
  standard: {
    label: 'Standard',
    build: (upm) => ({
      metrics: { ...DEFAULT_METRICS },
      verticals: [
        { x: 0, key: 'lsb', label: 'LSB' },
        { x: Math.round(upm * 0.6), key: 'rsb', label: 'RSB' },
      ],
      guides: [],
    }),
  },
  golden: {
    label: 'Golden Ratio',
    build: (upm) => {
      const cap = Math.round(upm * 0.7);
      const xh = Math.round(cap / PHI);
      return {
        metrics: { ascender: Math.round(cap * PHI / 1.2), capHeight: cap, xHeight: xh, baseline: 0, descender: -Math.round(upm * 0.2) },
        verticals: [
          { x: 0, key: 'lsb', label: 'LSB' },
          { x: Math.round(upm * 0.6), key: 'rsb', label: 'RSB' },
          { x: Math.round(upm * 0.6 / PHI), key: 'phi', label: 'φ' },
        ],
        guides: [{ type: 'golden' }],
      };
    },
  },
  modular: {
    label: 'Modular (X-Y-Z)',
    build: (upm) => {
      const unit = Math.round(upm / 12);
      return {
        metrics: { ascender: unit * 9, capHeight: unit * 8, xHeight: unit * 6, baseline: 0, descender: -unit * 2 },
        verticals: [
          { x: 0, key: 'lsb', label: 'LSB' },
          { x: unit * 7, key: 'rsb', label: 'RSB' },
        ],
        guides: [{ type: 'modular', unit }],
      };
    },
  },
  radial: {
    label: 'Radial',
    build: (upm) => ({
      metrics: { ...DEFAULT_METRICS },
      verticals: [{ x: 0, key: 'lsb', label: 'LSB' }, { x: Math.round(upm * 0.6), key: 'rsb', label: 'RSB' }],
      guides: [{ type: 'radial', cx: Math.round(upm * 0.3), cy: Math.round(upm * 0.35), rings: 6 }],
    }),
  },
};
