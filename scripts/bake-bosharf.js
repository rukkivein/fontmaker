// Bake shared/bosharf.json from cep/assets/bosharf.svg.
//
// Uses paper.js's SVG importer (paper-jsdom devDep) and — CRUCIALLY — UNIONS the top-level
// <path> elements with a boolean op, EXACTLY how a browser/Illustrator paints them (every path
// is black, painter's algorithm = the geometric UNION of each path's OWN filled region, with its
// OWN fill-rule). The earlier bake FLATTENED every sub-path into a separate contour, which
// destroyed the compound-path COUNTERS (a letter body + its reverse-wound counter live in ONE
// <path>; split apart and re-combined under one winding, the counter filled SOLID — the e/p bug).
// unite() preserves them: the result is clean non-zero geometry (outer CCW + holes CW) with the
// counters intact, byte-for-byte the picture the user sees in their SVG editor.
//
// Transform: fit the art cap-tall + em-wide on the baseline; SVG is y-down → flip to font
// y-up; side bearing 45; upm 1000. Re-run after editing bosharf.svg:  node scripts/bake-bosharf.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const paper = require('paper-jsdom');   // brings its own jsdom window — do NOT stub globals
paper.setup(new paper.Size(2000, 2000));

const svg = fs.readFileSync(path.join(ROOT, 'cep/assets/bosharf.svg'), 'utf8');
const item = paper.project.importSVG(svg, { insert: false, expandShapes: true });
// Collect the TOP-LEVEL paintable items (Path OR CompoundPath) — do NOT recurse into a
// CompoundPath's children, so each <path>'s counters (its inner sub-paths) stay grouped with it.
const items = [];
(function walk(it) {
  if ((it.className === 'Path' || it.className === 'CompoundPath') && it.bounds && it.bounds.width > 0 && it.bounds.height > 0) { items.push(it); return; }
  if (it.children) it.children.forEach(walk);
})(item);
if (!items.length) { console.error('no paths imported from SVG'); process.exit(1); }

// Boolean-union every item (each keeps its own winding/fill-rule) → the painted region WITH counters.
let acc = items[0].clone({ insert: false });
for (let i = 1; i < items.length; i++) {
  let nx = null;
  try { nx = acc.unite(items[i], { insert: false }); } catch (e) { nx = null; }
  if (nx) { try { if (acc && acc.remove) acc.remove(); } catch (e) {} acc = nx; }
}
const subs = (acc.children && acc.children.length ? acc.children : [acc]).filter(function (p) { return p.segments && p.segments.length > 1; });

// paper path → {closed, points:[{x,y,handleIn,handleOut}]} in SVG coords (absolute handles)
const contours = subs.map(function (p) {
  return {
    closed: p.closed !== false,
    points: p.segments.map(function (sg) {
      const pt = sg.point;
      return {
        x: pt.x, y: pt.y, type: 'corner',
        handleIn: sg.handleIn.isZero() ? null : { x: pt.x + sg.handleIn.x, y: pt.y + sg.handleIn.y },
        handleOut: sg.handleOut.isZero() ? null : { x: pt.x + sg.handleOut.x, y: pt.y + sg.handleOut.y },
      };
    }),
  };
});

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const eat = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
contours.forEach(c => c.points.forEach(p => { eat(p.x, p.y); if (p.handleIn) eat(p.handleIn.x, p.handleIn.y); if (p.handleOut) eat(p.handleOut.x, p.handleOut.y); }));
const artW = maxX - minX, artH = maxY - minY;

const TARGET_H = 700, TARGET_W = 920, SIDE = 45;
const s = Math.min(TARGET_H / artH, TARGET_W / artW);
const fx = (x) => +((x - minX) * s + SIDE).toFixed(2);
const fy = (y) => +((maxY - y) * s).toFixed(2);   // SVG y-down → font y-up
const mapPt = (p) => ({ x: fx(p.x), y: fy(p.y), type: p.type, handleIn: p.handleIn ? { x: fx(p.handleIn.x), y: fy(p.handleIn.y) } : null, handleOut: p.handleOut ? { x: fx(p.handleOut.x), y: fy(p.handleOut.y) } : null });
const outContours = contours.map(c => ({ closed: c.closed, points: c.points.map(mapPt) }));
const advanceWidth = Math.round(artW * s + 2 * SIDE);

const json = { source: 'bosharf.svg', upm: 1000, advanceWidth, contours: outContours };
fs.writeFileSync(path.join(ROOT, 'shared/bosharf.json'), JSON.stringify(json));
const sign = (c) => { let a = 0, p = c.points; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a; };
const pos = outContours.filter(c => sign(c) > 0).length, real = outContours.filter(c => Math.abs(sign(c) / 2) > 50).length;
console.log('baked bosharf.json:', outContours.length, 'contours (' + real + ' real-area),', pos, 'CCW /', outContours.length - pos, 'CW, adv', advanceWidth, 'scale', s.toFixed(4));
