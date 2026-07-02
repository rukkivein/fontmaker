// Verifies the exporter normalizes contour winding so counters (holes) punch
// correctly. We export an "O" whose outer + inner contours are wound the SAME
// way, then check the produced font has them wound OPPOSITELY (hole present).
const opentype = require('opentype.js');
const fontExport = require('../electron/fontExport');
const os = require('os'), path = require('path'), fs = require('fs');

const m = 'm1';
const sq = (x0, y0, x1, y1) => ({ closed: true, points: [
  { x: x0, y: y0, type: 'corner', handleIn: null, handleOut: null },
  { x: x1, y: y0, type: 'corner', handleIn: null, handleOut: null },
  { x: x1, y: y1, type: 'corner', handleIn: null, handleOut: null },
  { x: x0, y: y1, type: 'corner', handleIn: null, handleOut: null },
] });

const project = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m, name: 'Regular' }],
  glyphs: [{ name: 'O', char: 'O', unicode: 79, advanceWidth: 1000, layers: { [m]: { contours: [
    sq(100, 0, 900, 700),   // outer  (CCW as defined)
    sq(300, 200, 700, 500), // inner  (also CCW — same winding as outer)
  ] } } }],
};

const out = path.join(os.tmpdir(), 'fm_winding.otf');
fontExport.export(project, 'otf', { familyName: 'WindTest', styleName: 'Regular' }, out);
const font = opentype.loadSync(out);
const cmds = font.charToGlyph('O').path.commands;

// Split commands into subpaths and compute each one's signed area.
const subs = [];
let cur = null, sx = 0, sy = 0, px = 0, py = 0;
function area(c) { let a = 0; for (let i = 0; i < c.length; i++) { const q = c[(i + 1) % c.length]; a += c[i].x * q.y - q.x * c[i].y; } return a / 2; }
for (const c of cmds) {
  if (c.type === 'M') { cur = []; subs.push(cur); cur.push({ x: c.x, y: c.y }); sx = px = c.x; sy = py = c.y; }
  else if (c.type === 'L') { cur.push({ x: c.x, y: c.y }); px = c.x; py = c.y; }
  else if (c.type === 'C' || c.type === 'Q') { cur.push({ x: c.x, y: c.y }); px = c.x; py = c.y; }
}
const areas = subs.map(area);
let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + msg); if (!c) fails++; };
ok(subs.length === 2, 'glyph has two contours');
ok(areas[0] * areas[1] < 0, `outer and inner wound oppositely (areas ${areas.map(a => a.toFixed(0)).join(', ')}) → hole punched`);
ok(Math.abs(areas[0]) > Math.abs(areas[1]), 'larger contour is the outer one');

// ---- CURVED O: the real-font bug. The inner counter's FIRST anchor sits at 45°,
// in the outer circle's bezier "bulge" (outside the anchor-only diamond but inside
// the real curve). Anchor-only nesting missed it → counter not reversed → solid O/Q.
// Both contours are wound CCW; a correct exporter still reverses the inner.
const K = 0.5522847498;
function circle(cx, cy, r, rotDeg) {
  const rot = (rotDeg || 0) * Math.PI / 180, pts = [];
  for (let i = 0; i < 4; i++) {
    const ang = rot + i * Math.PI / 2;
    const x = cx + r * Math.cos(ang), y = cy + r * Math.sin(ang);
    const tx = -Math.sin(ang), ty = Math.cos(ang), hl = r * K;
    pts.push({ x, y, type: 'smooth',
      handleIn: { x: x - tx * hl, y: y - ty * hl },
      handleOut: { x: x + tx * hl, y: y + ty * hl } });
  }
  return { closed: true, points: pts };
}
const proj2 = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m, name: 'Regular' }],
  glyphs: [{ name: 'O', char: 'O', unicode: 79, advanceWidth: 1000, layers: { [m]: { contours: [
    circle(500, 350, 320, 0),    // outer (CCW)
    circle(500, 350, 270, 45),   // inner thin ring — first anchor at 45°, in the bulge (CCW)
  ] } } }],
};
const out2 = path.join(os.tmpdir(), 'fm_winding_curved.otf');
fontExport.export(proj2, 'otf', { familyName: 'WindTest2', styleName: 'Regular' }, out2);
const cmds2 = opentype.loadSync(out2).charToGlyph('O').path.commands;
const subs2 = []; let cur2 = null;
for (const c of cmds2) { if (c.type === 'M') { cur2 = [{ x: c.x, y: c.y }]; subs2.push(cur2); } else if (c.x != null) cur2.push({ x: c.x, y: c.y }); }
const a2 = subs2.map(area);
ok(subs2.length === 2, 'curved O has two contours');
ok(a2.length === 2 && a2[0] * a2[1] < 0, `curved O: outer/inner wound oppositely (areas ${a2.map(a => a.toFixed(0)).join(', ')}) → counter punches`);

// AREA-GUARD regression: a BIG solid square whose first anchor (100,100) falls inside a
// SMALL square overlapping its corner. The old nesting test (sample = points[0]) counted
// the small one as an encloser → odd depth → FLIPPED the big outline into a hole. Nesting
// now counts only STRICTLY BIGGER enclosers with a true interior point, so the big square
// stays a solid. (The many-counter brand-mark bug in miniature.)
const proj3 = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m, name: 'Regular' }],
  glyphs: [{ name: 'X', char: 'X', unicode: 88, advanceWidth: 1000, layers: { [m]: { contours: [
    sq(100, 100, 900, 900),   // big solid square (first anchor 100,100)
    sq(50, 50, 200, 200),     // small square overlapping the corner, contains (100,100)
  ] } } }],
};
const out3 = path.join(os.tmpdir(), 'fm_winding_areaguard.otf');
fontExport.export(proj3, 'otf', { familyName: 'WindTest3', styleName: 'Regular' }, out3);
const cmds3 = opentype.loadSync(out3).charToGlyph('X').path.commands;
const subs3 = []; let cur3 = null;
for (const c of cmds3) { if (c.type === 'M') { cur3 = [{ x: c.x, y: c.y }]; subs3.push(cur3); } else if (c.x != null) cur3.push({ x: c.x, y: c.y }); }
const a3 = subs3.map(area);
const big3 = a3.reduce((mx, v) => Math.abs(v) > Math.abs(mx) ? v : mx, 0);
ok(big3 > 0, `area-guard: big square stays a SOLID, not flipped to a hole (area ${big3.toFixed(0)})`);

console.log(fails ? `\n${fails} failed` : '\nWinding export OK');
process.exit(fails ? 1 : 0);
