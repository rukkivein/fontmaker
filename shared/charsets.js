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
function cp(/* ...codepoints */) {
  return Array.prototype.slice.call(arguments).map(u => ({ char: String.fromCodePoint(u), unicode: u }));
}
function ex(arr, drop) { const s = new Set(drop); return arr.filter(g => !s.has(g.unicode)); }

// Common Hanzi subset (~85 most-frequent) — representative, not exhaustive.
const HANZI_COMMON =
  '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对' +
  '能而小多天然方还样想看好但平体高第因主同水力理化外门间什从分性面意美法民政经度等动两长所重';

// ---- Alphabets (multi-select) -------------------------------------------
// `cased` marks sets that honor the uppercase/lowercase-only toggles.
// Standards-grounded character sets, modelled on the Google Fonts glyphset
// hierarchy (Latin Core / Plus, Cyrillic, Greek, Vietnamese, …) and Unicode
// blocks. `cased` marks sets honoring an (optional) upper/lower-only filter.
const ALPHABETS = [
  { key: 'latinUpper', label: 'Latin Uppercase', cased: 'upper',
    desc: 'A–Z · GF Latin Core', glyphs: () => chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ') },
  { key: 'latinLower', label: 'Latin Lowercase', cased: 'lower',
    desc: 'a–z · GF Latin Core', glyphs: () => chars('abcdefghijklmnopqrstuvwxyz') },
  { key: 'latinWest', label: 'Latin Western', desc: 'Western European accents (Latin-1)',
    glyphs: () => ex(range(0x00C0, 0x00FF), [0x00D7, 0x00F7]) },
  { key: 'latinCentral', label: 'Latin Extended-A', desc: 'Central/Eastern European incl. Turkish',
    glyphs: () => range(0x0100, 0x017F) },
  { key: 'latinVietnamese', label: 'Vietnamese', desc: 'Precomposed Vietnamese vowels',
    glyphs: () => range(0x1EA0, 0x1EF9).concat(cp(0x01A0, 0x01A1, 0x01AF, 0x01B0, 0x0110, 0x0111)) },
  { key: 'cyrillic', label: 'Cyrillic', desc: 'Russian & Slavic · GF Cyrillic',
    glyphs: () => range(0x0410, 0x044F).concat(cp(0x0401, 0x0451)) },
  { key: 'greek', label: 'Greek', desc: 'Monotonic Greek · GF Greek',
    glyphs: () => cp(0x0386, 0x0388, 0x0389, 0x038A, 0x038C, 0x038E, 0x038F).concat(ex(range(0x0391, 0x03CE), [0x03A2])) },
  { key: 'arabic', label: 'Arabic', desc: 'Basic Arabic letters',
    glyphs: () => chars('ابتثجحخدذرزسشصضطظعغفقكلمنهوي') },
  { key: 'hebrew', label: 'Hebrew', desc: 'Hebrew alphabet',
    glyphs: () => chars('אבגדהוזחטיכךלמםנןסעפףצץקרשת') },
  { key: 'hiragana', label: 'Japanese (Hiragana)', desc: 'ひらがな',
    glyphs: () => chars('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん') },
  { key: 'katakana', label: 'Japanese (Katakana)', desc: 'カタカナ',
    glyphs: () => chars('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン') },
  { key: 'hanzi', label: 'Chinese (Hanzi)', desc: 'Common Han characters',
    glyphs: () => chars(HANZI_COMMON) },
  { key: 'numbers', label: 'Numbers', desc: '0–9 lining figures',
    glyphs: () => chars('0123456789') },
  { key: 'fractions', label: 'Fractions & Numerals', desc: 'Fractions, super/subscripts · GF Latin Plus',
    glyphs: () => chars('½¼¾').concat(cp(0x2153, 0x2154, 0x215B, 0x215C, 0x215D, 0x215E, 0x2044,
      0x00B9, 0x00B2, 0x00B3, 0x2070, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079))
      .concat(range(0x2080, 0x2089)) },
  { key: 'punct', label: 'Punctuation', desc: 'Punctuation, quotes & dashes',
    glyphs: () => chars('.,;:!?\'"()[]{}-/\\').concat(cp(0x2013, 0x2014, 0x2026, 0x2018, 0x2019,
      0x201C, 0x201D, 0x00AB, 0x00BB, 0x2039, 0x203A, 0x2022, 0x00B7, 0x00A1, 0x00BF), [{ char: ' ', unicode: 32 }]) },
  { key: 'symbols', label: 'Symbols & Currency', desc: 'Currency, ©®™ & reference marks',
    glyphs: () => chars('&@#*').concat(cp(0x0024, 0x20AC, 0x00A3, 0x00A5, 0x00A2, 0x20BA, 0x00A4,
      0x00A9, 0x00AE, 0x2122, 0x00A7, 0x00B6, 0x00B0, 0x2020, 0x2021)) },
  { key: 'math', label: 'Math', desc: 'Operators · GF Latin Plus',
    glyphs: () => chars('+<>=~^|').concat(cp(0x2212, 0x00D7, 0x00F7, 0x2260, 0x00B1, 0x2264, 0x2265,
      0x0025, 0x2030, 0x221A, 0x221E, 0x2248, 0x00B5, 0x03C0)) },
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
