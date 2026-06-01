// Verifies exported fonts carry working GSUB: stylistic alternates (ss01/salt)
// and ligatures (liga), so apps can actually access the extra glyphs.
const opentype = require('opentype.js');
const fontExport = require('../electron/fontExport');
const os = require('os'), path = require('path'), fs = require('fs');

let fails = 0;
const ok = (c, m) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; };

const M = 'm1';
const box = () => ({ contours: [{ closed: true, points: [
  { x: 80, y: 0, type: 'corner', handleIn: null, handleOut: null },
  { x: 520, y: 0, type: 'corner', handleIn: null, handleOut: null },
  { x: 520, y: 700, type: 'corner', handleIn: null, handleOut: null },
  { x: 80, y: 700, type: 'corner', handleIn: null, handleOut: null },
] }] });
const g = (name, char, unicode, extra) => ({ name, char, unicode, advanceWidth: 600, layers: { [M]: box() }, ...extra });

const project = {
  unitsPerEm: 1000, metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: M, name: 'Regular' }],
  glyphs: [
    g('A', 'A', 65), g('A.ss01', null, null, { kind: 'alternate', baseName: 'A' }),
    g('f', 'f', 102), g('i', 'i', 105), g('f_i', null, null, { kind: 'ligature', components: ['f', 'i'] }),
  ],
};

const out = path.join(os.tmpdir(), 'fm_gsub.otf');
fontExport.export(project, 'otf', { familyName: 'GsubTest', styleName: 'Regular' }, out);
const font = opentype.loadSync(out);

ok(!!font.tables.gsub, 'font has a GSUB table');
// Glyph order: A=1, A.ss01=2, f=3, i=4, f_i=5 (after .notdef=0). GSUB works in
// indices (opentype.js doesn't emit a names-bearing post table by default).
const aIdx = font.charToGlyphIndex('A'), fIdx = font.charToGlyphIndex('f'), iIdx = font.charToGlyphIndex('i');
const singles = font.substitution.getSingle('ss01') || [];
ok(singles.some(s => s.sub === aIdx && s.by === 2), 'ss01 maps A → alternate (index 2)');
const salt = font.substitution.getAlternates('salt') || [];
ok(salt.some(s => s.sub === aIdx && s.by.includes(2)), 'salt lists A’s alternate');
const ligs = font.substitution.getLigatures('liga') || [];
ok(ligs.some(l => l.by === 5 && l.sub[0] === fIdx && l.sub[1] === iIdx), 'liga maps f+i → ligature (index 5)');

console.log(fails ? `\n${fails} failed` : '\nGSUB export OK');
process.exit(fails ? 1 : 0);
