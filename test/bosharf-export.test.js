'use strict';
// Integration: the baked bosharf art must build a valid OTF through the SAME
// engine the CEP panel exports with (core/fontEngine), and every undrawn slot
// must come out carrying the placeholder outline — the free-edition guarantee.
const opentype = require('opentype.js');
const fontEngine = require('../core/fontEngine.js');
const { fillEmptyGlyphs } = require('../shared/placeholder.js');
const bosharf = require('../shared/bosharf.json');

let fails = 0;
function ok(c, m) { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; }

const MID = 'm1';
const project = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: MID, name: 'Regular' }],
  glyphs: [
    { name: 'A', char: 'A', unicode: 65, advanceWidth: 600, layers: { [MID]: { contours: [
      { closed: true, points: [
        { x: 100, y: 0, type: 'corner', handleIn: null, handleOut: null },
        { x: 500, y: 0, type: 'corner', handleIn: null, handleOut: null },
        { x: 300, y: 700, type: 'corner', handleIn: null, handleOut: null },
      ] },
    ] } } },
    { name: 'B', char: 'B', unicode: 66, advanceWidth: 600, layers: { [MID]: {} } },   // empty
    { name: 'zero', char: '0', unicode: 48, advanceWidth: 600, layers: { [MID]: {} } }, // empty
  ],
};

ok(bosharf.contours && bosharf.contours.length > 50, 'bosharf.json carries the baked contours');
ok(bosharf.advanceWidth > 0, 'bosharf.json has an advance width');

const n = fillEmptyGlyphs(project, MID, bosharf);
ok(n === 2, 'placeholder filled the 2 undrawn slots (B, 0)');

const built = fontEngine.buildFont(project, 'otf', { familyName: 'AlphaTest', styleName: 'Regular', masterId: MID });
ok(built && built.buffer && built.buffer.byteLength > 0, 'engine produced a non-empty OTF buffer');

const font = opentype.parse(built.buffer);
ok(font.glyphs.length >= 3, 'OTF reloads with the glyph set');
const A = font.charToGlyph('A');
const B = font.charToGlyph('B');
ok(A.path.commands.length > 0, 'drawn A keeps its own outline');
ok(B.path.commands.length > 20, 'undrawn B now carries the bosharf placeholder outline');
ok(B.advanceWidth === bosharf.advanceWidth, 'placeholder B uses the placeholder advance');

console.log(fails ? `\n${fails} test(s) failed` : '\nbosharf export integration OK');
process.exit(fails ? 1 : 0);
