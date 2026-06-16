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
  { key: 'armenian', label: 'Armenian', desc: 'Armenian alphabet',
    glyphs: () => range(0x0531, 0x0556).concat(range(0x0561, 0x0586)) },
  { key: 'georgian', label: 'Georgian', desc: 'Mkhedruli script',
    glyphs: () => range(0x10D0, 0x10FA) },
  { key: 'thai', label: 'Thai', desc: 'Thai consonants, vowels & tone marks',
    glyphs: () => range(0x0E01, 0x0E3A).concat(range(0x0E40, 0x0E4E)) },
  { key: 'devanagari', label: 'Devanagari', desc: 'Hindi/Marathi base letters & matras',
    glyphs: () => range(0x0905, 0x0939).concat(range(0x093E, 0x094D)) },
  { key: 'hangul', label: 'Korean (Hangul Jamo)', desc: 'Conjoining/compatibility jamo',
    glyphs: () => range(0x3131, 0x3163) },
  { key: 'numbers', label: 'Numbers', desc: '0–9 lining figures',
    glyphs: () => chars('0123456789') },
  { key: 'fractions', label: 'Fractions & Numerals', desc: 'Fractions, super/subscripts · GF Latin Plus',
    glyphs: () => chars('½¼¾').concat(cp(0x2153, 0x2154, 0x215B, 0x215C, 0x215D, 0x215E, 0x2044,
      0x00B9, 0x00B2, 0x00B3, 0x2070, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079))
      .concat(range(0x2080, 0x2089)) },
  { key: 'punct', label: 'Basic Punctuation', desc: 'Everyday marks: . , ? ! ; : ‘ ’ " - ( ) / & @ # + quotes, dashes, space',
    glyphs: () => chars('.,;:!?\'"()-/&@#').concat(cp(0x2013, 0x2014, 0x2026, 0x2018, 0x2019,
      0x201C, 0x201D), [{ char: ' ', unicode: 32 }]) },
  { key: 'punctExtra', label: 'Punctuation Extended', desc: 'Brackets, guillemets, inverted marks & reference dots — the rarer punctuation',
    glyphs: () => chars('[]{}\\_').concat(cp(0x00AB, 0x00BB, 0x2039, 0x203A, 0x2022, 0x00B7, 0x00A1, 0x00BF)) },
  { key: 'symbols', label: 'Symbols & Currency', desc: 'Currency, ©®™ & reference marks',
    glyphs: () => chars('*').concat(cp(0x0024, 0x20AC, 0x00A3, 0x00A5, 0x00A2, 0x20BA, 0x00A4,
      0x00A9, 0x00AE, 0x2122, 0x00A7, 0x00B6, 0x00B0, 0x2020, 0x2021)) },
  { key: 'math', label: 'Math', desc: 'Operators · GF Latin Plus',
    glyphs: () => chars('+<>=~^|').concat(cp(0x2212, 0x00D7, 0x00F7, 0x2260, 0x00B1, 0x2264, 0x2265,
      0x0025, 0x2030, 0x221A, 0x221E, 0x2248, 0x00B5, 0x03C0)) },
];
// Display order: the classic/essential sets first, then by rough popularity.
// Basic Punctuation sits right after Numbers (everyday marks, easy to grab); the
// rarer Punctuation Extended / Symbols / Math come later.
const ORDER = ['latinUpper', 'latinLower', 'latinWest', 'latinCentral', 'numbers', 'punct', 'fractions', 'symbols', 'math', 'punctExtra',
  'cyrillic', 'greek', 'arabic', 'hebrew', 'hanzi', 'hiragana', 'katakana', 'latinVietnamese',
  'devanagari', 'thai', 'hangul', 'armenian', 'georgian'];
ALPHABETS.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
const ALPHABET_BY_KEY = {};
ALPHABETS.forEach(a => { ALPHABET_BY_KEY[a.key] = a; });

// ---- Grid presets (single-select, with purpose notes) -------------------
const PHI = 1.61803398875;
// Standard metrics (UPM 1000), normalized from Arial so the Arial ghost lands
// exactly on the lines: cap 1466/2048→716, x 1062/2048→519, asc 1638/2048→800,
// desc 410/2048→-200. With a ghost drawn at the em size, cap = 0.716·em = 716.
const BASE = { ascender: 800, capHeight: 716, xHeight: 519, baseline: 0, descender: -200 };

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
      out.push({ char: g.char, unicode: g.unicode, alphabet: key });
    }
  }
  return out;
}

// The "classic" sets every common font ships — flagged important in the UI.
const ESSENTIAL = ['latinUpper', 'latinLower', 'latinWest', 'latinCentral', 'numbers', 'punct', 'fractions', 'symbols', 'math', 'punctExtra'];

// Pick a country → auto-select the sets its written language needs (+ the common
// numbers/punctuation/symbols/math every font ships). Picking a country UNIONS
// these into the current selection. Countries are mapped to a script group;
// scripts we don't ship yet fall back to a Latin baseline.
const COMMON = ['numbers', 'fractions', 'punct', 'symbols', 'math'];
const LAT = ['latinUpper', 'latinLower'];
const SCRIPT_SETS = {
  latin: LAT.concat(['latinWest'], COMMON),
  latinCE: LAT.concat(['latinWest', 'latinCentral'], COMMON),
  vietnamese: LAT.concat(['latinWest', 'latinVietnamese'], COMMON),
  cyrillic: ['cyrillic'].concat(LAT, COMMON),
  greek: ['greek'].concat(LAT, COMMON),
  arabic: ['arabic'].concat(COMMON),
  hebrew: ['hebrew'].concat(LAT, COMMON),
  japanese: ['hiragana', 'katakana', 'hanzi'].concat(LAT, COMMON),
  chinese: ['hanzi'].concat(LAT, COMMON),
  korean: ['hangul'].concat(LAT, COMMON),
  devanagari: ['devanagari'].concat(LAT, COMMON),
  thai: ['thai'].concat(LAT, COMMON),
  armenian: ['armenian'].concat(LAT, COMMON),
  georgian: ['georgian'].concat(LAT, COMMON),
};
// country → script group (one entry per country; same-alphabet ones repeat).
const COUNTRY_SCRIPT = {
  // Latin — Western
  'United States': 'latin', 'United Kingdom': 'latin', 'Ireland': 'latin', 'Canada': 'latin',
  'Australia': 'latin', 'New Zealand': 'latin', 'Germany': 'latin', 'France': 'latin',
  'Spain': 'latin', 'Portugal': 'latin', 'Italy': 'latin', 'Netherlands': 'latin',
  'Belgium': 'latin', 'Switzerland': 'latin', 'Austria': 'latin', 'Luxembourg': 'latin',
  'Denmark': 'latin', 'Sweden': 'latin', 'Norway': 'latin', 'Finland': 'latin', 'Iceland': 'latin',
  'Mexico': 'latin', 'Brazil': 'latin', 'Argentina': 'latin', 'Chile': 'latin', 'Colombia': 'latin',
  'Peru': 'latin', 'Venezuela': 'latin', 'Ecuador': 'latin', 'Bolivia': 'latin', 'Uruguay': 'latin',
  'Paraguay': 'latin', 'Cuba': 'latin', 'Indonesia': 'latin', 'Malaysia': 'latin', 'Philippines': 'latin',
  'Nigeria': 'latin', 'Kenya': 'latin', 'South Africa': 'latin', 'Ghana': 'latin', 'Tanzania': 'latin',
  'Uganda': 'latin', 'Ivory Coast': 'latin', 'Cameroon': 'latin', 'Senegal': 'latin', 'Angola': 'latin',
  'Mozambique': 'latin', 'Madagascar': 'latin', 'Botswana': 'latin', 'Namibia': 'latin', 'Rwanda': 'latin',
  // Latin — Central/Eastern European (needs Extended-A)
  'Poland': 'latinCE', 'Czechia': 'latinCE', 'Slovakia': 'latinCE', 'Hungary': 'latinCE',
  'Croatia': 'latinCE', 'Slovenia': 'latinCE', 'Bosnia and Herzegovina': 'latinCE', 'Romania': 'latinCE',
  'Lithuania': 'latinCE', 'Latvia': 'latinCE', 'Estonia': 'latinCE', 'Albania': 'latinCE',
  'Turkey': 'latinCE', 'Azerbaijan': 'latinCE', 'Turkmenistan': 'latinCE', 'Malta': 'latinCE',
  // Vietnamese
  'Vietnam': 'vietnamese',
  // Cyrillic
  'Russia': 'cyrillic', 'Belarus': 'cyrillic', 'Ukraine': 'cyrillic', 'Bulgaria': 'cyrillic',
  'Serbia': 'cyrillic', 'North Macedonia': 'cyrillic', 'Montenegro': 'cyrillic', 'Kazakhstan': 'cyrillic',
  'Kyrgyzstan': 'cyrillic', 'Tajikistan': 'cyrillic', 'Mongolia': 'cyrillic',
  // Greek
  'Greece': 'greek', 'Cyprus': 'greek',
  // Arabic
  'Saudi Arabia': 'arabic', 'Egypt': 'arabic', 'United Arab Emirates': 'arabic', 'Iraq': 'arabic',
  'Iran': 'arabic', 'Jordan': 'arabic', 'Lebanon': 'arabic', 'Syria': 'arabic', 'Kuwait': 'arabic',
  'Qatar': 'arabic', 'Bahrain': 'arabic', 'Oman': 'arabic', 'Yemen': 'arabic', 'Algeria': 'arabic',
  'Morocco': 'arabic', 'Tunisia': 'arabic', 'Libya': 'arabic', 'Sudan': 'arabic',
  'Pakistan': 'arabic', 'Afghanistan': 'arabic',
  // Hebrew
  'Israel': 'hebrew',
  // CJK / Korean
  'China': 'chinese', 'Taiwan': 'chinese', 'Hong Kong': 'chinese', 'Singapore': 'chinese',
  'Japan': 'japanese', 'South Korea': 'korean', 'North Korea': 'korean',
  // Devanagari
  'India': 'devanagari', 'Nepal': 'devanagari',
  // Thai
  'Thailand': 'thai',
  // Caucasus
  'Armenia': 'armenian', 'Georgia': 'georgian',
};
const COUNTRIES = Object.keys(COUNTRY_SCRIPT)
  .sort()
  .map(name => {
    const seen = {}, sets = [];
    SCRIPT_SETS[COUNTRY_SCRIPT[name]].forEach(k => { if (!seen[k]) { seen[k] = 1; sets.push(k); } });
    return { name, sets };
  });

// A short sample of the characters a set brings (shown instead of prose).
function sampleChars(key, n) {
  const a = ALPHABET_BY_KEY[key];
  if (!a) return '';
  n = n || 9;
  const gs = a.glyphs().filter(g => g.unicode !== 32);
  const step = gs.length > n ? Math.floor(gs.length / n) : 1;
  const out = [];
  for (let i = 0; i < gs.length && out.length < n; i += step) out.push(gs[i].char);
  return out.join(' ');
}

module.exports = {
  ALPHABETS, ALPHABET_BY_KEY, GRIDS, GRID_BY_KEY, MASTER_TYPES, ESSENTIAL, COUNTRIES,
  collectGlyphs, sampleChars,
};
