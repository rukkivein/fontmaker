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

ok(bosharf.contours && bosharf.contours.length > 10, 'bosharf.json carries the baked contours');
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

// COUNTERS MUST SURVIVE TO THE FINAL FONT. The "Rune type" mark is baked as a boolean
// union of the SVG's top-level paths, so its letter counters (R/e/p bowls) ride along as
// reverse-wound (CW, negative-area) sub-contours. Reconstruct B's outline from the built
// OTF and count those holes: the union ships ~99. The OLD bug ran the mark through a
// whole-glyph resolveCrossings ("uniteContours") that collapsed it to ~16 contours / 5
// holes, FILLING the p/e counters solid — exactly what the user saw on OTF export. A high
// hole count is the regression tripwire (fixed ≈99 ⋙ broken ≈5).
function holesOf(glyph) {
  const cs = glyph.path.commands, C = []; let cur = null, px = 0, py = 0;
  const flat = (x1, y1, x2, y2, x, y) => { const S = 6; for (let i = 1; i <= S; i++) { const t = i / S, u = 1 - t; cur.push({ x: u * u * u * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, y: u * u * u * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y }); } px = x; py = y; };
  for (const c of cs) {
    if (c.type === 'M') { if (cur) C.push(cur); cur = [{ x: c.x, y: c.y }]; px = c.x; py = c.y; }
    else if (c.type === 'L') { cur.push({ x: c.x, y: c.y }); px = c.x; py = c.y; }
    else if (c.type === 'C') flat(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else if (c.type === 'Q') { const S = 6; for (let i = 1; i <= S; i++) { const t = i / S, u = 1 - t; cur.push({ x: u * u * px + 2 * u * t * c.x1 + t * t * c.x, y: u * u * py + 2 * u * t * c.y1 + t * t * c.y }); } px = c.x; py = c.y; }
    else if (c.type === 'Z') { if (cur) C.push(cur); cur = null; }
  }
  if (cur) C.push(cur);
  const sa = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; };
  return C.filter(p => sa(p) < 0).length;
}
const holes = holesOf(B);
ok(holes >= 6, 'placeholder counters survive to the OTF (' + holes + ' holes; a counter-filling regression collapses this toward 0)');

console.log(fails ? `\n${fails} test(s) failed` : '\nbosharf export integration OK');
process.exit(fails ? 1 : 0);
