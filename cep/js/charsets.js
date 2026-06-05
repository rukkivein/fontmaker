'use strict';
// Character sets + grid presets for the New Font dialog. Pure CommonJS so the
// CEP panel and the Node tests share one source of truth. Each alphabet yields
// { char, unicode } items; glyph names are assigned later by glyphset.glyphName.

function range(fromCp, toCp) {
  const out = [];
  for (let c = fromCp; c <= toCp; c++) out.push({ char: String.fromCodePoint(c), unicode: c });
  return out;
}
function chars(str) {
  return Array.from(str).map(ch => ({ char: ch, unicode: ch.codePointAt(0) }));
}

// Common Hanzi subset (~85 most-frequent) — representative, not exhaustive.
const HANZI_COMMON =
  '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对' +
  '能而小多天然方还样想看好但平体高第因主同水力理化外门间什从分性面意美法民政经度等动两长所重';

// ---- Alphabets (multi-select) -------------------------------------------
// `cased` marks sets that honor the uppercase/lowercase-only toggles.
const ALPHABETS = [
  { key: 'latinUpper', label: 'Latin — Uppercase', cased: 'upper',
    note: 'A–Z', glyphs: () => chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ') },
  { key: 'latinLower', label: 'Latin — Lowercase', cased: 'lower',
    note: 'a–z', glyphs: () => chars('abcdefghijklmnopqrstuvwxyz') },
  { key: 'numbers', label: 'Numbers', note: '0–9', glyphs: () => chars('0123456789') },
  { key: 'punct', label: 'Punctuation & Symbols',
    note: '. , : ; ! ? - … & @ …', glyphs: () => [].concat(
      chars('.,:;!?\'"()[]{}-–—/\\&@#%+*=<>'), [{ char: ' ', unicode: 32 }]) },
  { key: 'latinExt', label: 'Latin Extended (incl. Turkish)',
    note: 'şçğıöü àéîõ … ŠŽœ', glyphs: () => chars(
      'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏİĞŞÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïışğñòóôõöøùúûüýÿŠŽšžŸŒœ') },
  { key: 'cyrillic', label: 'Cyrillic (Russian)', note: 'А–я',
    glyphs: () => range('А'.codePointAt(0), 'я'.codePointAt(0)) },
  { key: 'greek', label: 'Greek', note: 'Α–Ω α–ω',
    glyphs: () => [].concat(range('Α'.codePointAt(0), 'Ω'.codePointAt(0)), range('α'.codePointAt(0), 'ω'.codePointAt(0))) },
  { key: 'arabic', label: 'Arabic', note: 'ا ب ت …',
    glyphs: () => chars('ابتثجحخدذرزسشصضطظعغفقكلمنهوي') },
  { key: 'hebrew', label: 'Hebrew', note: 'א ב ג …',
    glyphs: () => chars('אבגדהוזחטיכךלמםנןסעפףצץקרשת') },
  { key: 'hiragana', label: 'Japanese — Hiragana', note: 'あ い う …',
    glyphs: () => chars('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん') },
  { key: 'katakana', label: 'Japanese — Katakana', note: 'ア イ ウ …',
    glyphs: () => chars('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン') },
  { key: 'hanzi', label: 'Chinese — Common Hanzi', note: '~120 most frequent',
    glyphs: () => chars(HANZI_COMMON) },
];
const ALPHABET_BY_KEY = {};
ALPHABETS.forEach(a => { ALPHABET_BY_KEY[a.key] = a; });

// ---- Grid presets (single-select, with purpose notes) -------------------
const PHI = 1.61803398875;
const BASE = { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 };

const GRIDS = [
  { key: 'metrics', label: 'Metrics Grid',
    note: 'Industry-standard horizontal lines: baseline, x-height, cap height, ascender, descender. The default for most text faces.',
    build: (upm) => ({ kind: 'metrics', metrics: Object.assign({}, BASE),
      verticals: [{ x: 0, key: 'lsb' }, { x: Math.round(upm * 0.6), key: 'rsb' }] }) },
  { key: 'emsquare', label: 'Em Square Grid',
    note: 'Uniform UPM subdivisions. Best for geometric, monospaced or pixel-aligned designs where everything snaps to a square unit.',
    build: (upm) => ({ kind: 'emsquare', metrics: Object.assign({}, BASE),
      cell: Math.round(upm / 16), divisions: 16 }) },
  { key: 'golden', label: 'Golden Ratio / Proportional',
    note: 'Heights and widths derived from φ (1.618). For classical, harmonious proportions.',
    build: (upm) => { const cap = Math.round(upm * 0.7), xh = Math.round(cap / PHI);
      return { kind: 'golden', metrics: { ascender: Math.round(cap * PHI / 1.2), capHeight: cap, xHeight: xh, baseline: 0, descender: -Math.round(upm * 0.2) },
        guides: [{ type: 'golden' }] }; } },
  { key: 'broadnib', label: 'Broad Nib Construction',
    note: 'Slanted guide pairs at a fixed pen angle (≈30°). For humanist / calligraphic forms with natural thick–thin contrast.',
    build: (upm) => ({ kind: 'broadnib', metrics: Object.assign({}, BASE),
      penAngle: 30, nibWidth: Math.round(upm * 0.08) }) },
  { key: 'superellipse', label: 'Superellipse / Optical',
    note: 'Superellipse curves plus overshoot zones at baseline/cap/x-height. For optical correction so round glyphs look the right size.',
    build: (upm) => ({ kind: 'superellipse', metrics: Object.assign({}, BASE),
      overshoot: Math.round(upm * 0.012), exponent: 2.6 }) },
];
const GRID_BY_KEY = {};
GRIDS.forEach(g => { GRID_BY_KEY[g.key] = g; });

// Master types offered when adding a master to a font.
const MASTER_TYPES = ['Regular', 'Condensed', 'Extended', 'Italic', 'Bold', 'Optical', 'Other'];

// Resolve a selection of alphabet keys (+ case filter) into a deduped glyph list.
function collectGlyphs(alphabetKeys, opts) {
  opts = opts || {};
  const seen = new Set();
  const out = [];
  for (const key of alphabetKeys) {
    const a = ALPHABET_BY_KEY[key];
    if (!a) continue;
    if (a.cased === 'upper' && opts.lowerOnly) continue;
    if (a.cased === 'lower' && opts.upperOnly) continue;
    for (const g of a.glyphs()) {
      if (seen.has(g.unicode)) continue;
      seen.add(g.unicode);
      out.push(g);
    }
  }
  return out;
}

module.exports = {
  ALPHABETS, ALPHABET_BY_KEY, GRIDS, GRID_BY_KEY, MASTER_TYPES,
  collectGlyphs,
};
