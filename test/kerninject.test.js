// Verify the exported font actually carries the pair-kerning the tester previews.
// Builds an OTF, splices a format-0 'kern' table via kerninject, re-parses with
// opentype.js, and asserts the pairs (and every other table) read back correctly.
const opentype = require('opentype.js');
const fontExport = require('../electron/fontExport');
const { injectKernTable, buildKernFormat0 } = require('../cep/js/kerninject');
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');

const mId = 'm1';
function box(name, ch, uni, adv, x0, x1) {
  return { name, char: ch, unicode: uni, advanceWidth: adv, layers: { [mId]: { contours: [
    { closed: true, points: [
      { x: x0, y: 0, type: 'corner' }, { x: x1, y: 0, type: 'corner' },
      { x: x1, y: 700, type: 'corner' }, { x: x0, y: 700, type: 'corner' },
    ] },
  ] } } };
}
const project = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: mId, name: 'Regular' }],
  glyphs: [ box('A', 'A', 65, 600, 60, 540), box('V', 'V', 86, 600, 60, 540), box('o', 'o', 111, 560, 40, 520) ],
};

const out = path.join(os.tmpdir(), 'fm_kern_test.otf');
fontExport.export(project, 'otf', { familyName: 'KernFam', styleName: 'Regular', version: '1.000' }, out);
const built = fs.readFileSync(out);

// GID order: .notdef=0, A=1, V=2, o=3 → these are the keys kerninject maps.
const kerning = { 'A,V': -140, 'V,A': -90, 'V,o': -55, 'bogus,A': -200 /* unknown name → skipped */ };
const injected = injectKernTable(built.buffer.slice(built.byteOffset, built.byteOffset + built.byteLength), kerning, project.glyphs);

const f = opentype.parse(injected);
assert.strictEqual(f.glyphs.length, 4, 'glyph count preserved through injection');
assert.strictEqual(f.charToGlyph('A').advanceWidth, 600, 'A advance survived');
assert.ok(f.names.fontFamily && f.names.fontFamily.en === 'KernFam', 'name table intact');

const A = f.charToGlyph('A'), V = f.charToGlyph('V'), o = f.charToGlyph('o');
assert.strictEqual(f.getKerningValue(A, V), -140, 'A,V kern read back');
assert.strictEqual(f.getKerningValue(V, A), -90, 'V,A kern read back');
assert.strictEqual(f.getKerningValue(V, o), -55, 'V,o kern read back');
assert.strictEqual(f.getKerningValue(A, o), 0, 'unset pair is zero');

// Pair count: 3 valid pairs (the 'bogus' left name is dropped, not exported).
const pairs = Object.keys(f.kerningPairs || {});
assert.ok(pairs.length === 3, 'exactly 3 pairs exported (unknown glyph dropped), got ' + pairs.length);

// No-op safety: empty/zero kerning returns a still-valid font.
const none = injectKernTable(built.buffer.slice(built.byteOffset, built.byteOffset + built.byteLength), {}, project.glyphs);
assert.ok(opentype.parse(none).glyphs.length === 4, 'empty kerning leaves a valid font');

// Determinism: same input → byte-identical output.
const again = injectKernTable(built.buffer.slice(built.byteOffset, built.byteOffset + built.byteLength), kerning, project.glyphs);
assert.strictEqual(Buffer.from(injected).toString('hex'), Buffer.from(again).toString('hex'), 'injection is deterministic');

// Multi-subtable split: a format-0 subtable's uint16 length caps it at 10920 pairs,
// so >10920 must spill into a second subtable (kern header nTables=2).
const big = [];
for (let i = 0; i < 11000; i++) big.push({ l: 1, r: i + 2, v: -1 });
const kb = buildKernFormat0(big);
const kdv = new DataView(kb.buffer, kb.byteOffset, kb.byteLength);
assert.strictEqual(kdv.getUint16(0), 0, 'kern table version 0');
assert.strictEqual(kdv.getUint16(2), 2, '11000 pairs → 2 subtables');
assert.strictEqual(kdv.getUint16(6), 14 + 10920 * 6, 'first subtable holds the 10920 cap');  // sub len at +4(hdr)+2(ver)
assert.strictEqual(kb.length, 4 + (14 + 10920 * 6) + (14 + 80 * 6), 'total bytes = both subtables');

// TTF path: buildCleanTtf (main.js) splices the same kern table onto the glyf font —
// the ttfWriter GID order matches (.notdef=0, glyphs[i]=i+1), so pairs must read back
// identically from a TTF. (This pins the "TTF exports lost all kerning" fix.)
const fontEngine = require('../core/fontEngine.js');
const ttfBuilt = fontEngine.buildFont(project, 'ttf', { familyName: 'KernFam', styleName: 'Regular', masterId: mId });
const ttfInjected = injectKernTable(ttfBuilt.buffer, kerning, project.glyphs);
const tf = opentype.parse(ttfInjected);
assert.ok(tf.outlinesFormat === 'truetype', 'TTF stays glyf-flavored after injection');
assert.strictEqual(tf.glyphs.length, 4, 'TTF glyph count preserved through injection');
const tA = tf.charToGlyph('A'), tV = tf.charToGlyph('V'), tO = tf.charToGlyph('o');
assert.strictEqual(tf.getKerningValue(tA, tV), -140, 'TTF A,V kern read back');
assert.strictEqual(tf.getKerningValue(tV, tA), -90, 'TTF V,A kern read back');
assert.strictEqual(tf.getKerningValue(tV, tO), -55, 'TTF V,o kern read back');
assert.ok(tA.path.commands.length > 0, 'TTF glyph outlines intact after injection');

console.log('kerninject OK — 3 pairs exported & round-tripped (A,V=-140 V,A=-90 V,o=-55) on BOTH OTF and TTF, tables intact; 11k pairs split into 2 subtables');
