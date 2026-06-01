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
console.log(fails ? `\n${fails} failed` : '\nWinding export OK');
process.exit(fails ? 1 : 0);
