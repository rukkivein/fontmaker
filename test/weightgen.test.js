'use strict';
// Proves the point-compatible weight/slant generators: Bold/Italic keep the exact
// same point structure as the source (so they're valid variable masters), and the
// transforms are geometrically right (italic shears about the baseline; bold grows
// outer contours + shrinks counters = thicker ink).
const assert = require('assert');
const wg = require('../shared/weightgen.js');

function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }
function pt(x, y) { return { x, y, type: 'corner', handleIn: null, handleOut: null }; }
// CCW rectangle (font Y-up); pass ccw=false for a CW counter.
function rect(x0, y0, x1, y1, ccw) {
  const p = ccw === false ? [[x0, y0], [x0, y1], [x1, y1], [x1, y0]] : [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { closed: true, isHole: ccw === false, points: p.map((a) => pt(a[0], a[1])) };
}
function sameStructure(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].points.length !== b[i].points.length) return false;
    if (!!a[i].isHole !== !!b[i].isHole) return false;
    for (let j = 0; j < a[i].points.length; j++) {
      if (a[i].points[j].type !== b[i].points[j].type) return false;
      if (!!a[i].points[j].handleIn !== !!b[i].points[j].handleIn) return false;
      if (!!a[i].points[j].handleOut !== !!b[i].points[j].handleOut) return false;
    }
  }
  return true;
}

// ---- ITALIC: shear about baseline, points preserved ----------------------
(function italicTest() {
  const reg = [rect(0, 0, 100, 200, true)];
  const it = wg.shearContours(reg, 12);
  ok(sameStructure(reg, it), 'italic: identical point structure (variable-compatible)');
  const s = Math.tan(12 * Math.PI / 180);
  // baseline corner (y=0) keeps its x; top corner (y=200) shifts right by 200*tan
  const base = it[0].points.find((p) => p.y === 0 && Math.abs(p.x - 0) < 1e-9);
  ok(base && Math.abs(base.x - 0) < 1e-6, 'italic: baseline point keeps x (shear pivots on baseline)');
  const top = it[0].points.find((p) => p.y === 200 && p.x > 100);
  ok(top && Math.abs(top.x - (100 + 200 * s)) < 1e-6, 'italic: top point sheared right by y·tan(θ)');
})();

// ---- BOLD: same points, ink grows ----------------------------------------
(function boldSquareTest() {
  const sq = [rect(0, 0, 100, 100, true)];
  const bold = wg.emboldenContours(sq, 10);
  ok(sameStructure(sq, bold), 'bold: identical point structure');
  const a0 = Math.abs(wg.signedArea(sq[0].points)), a1 = Math.abs(wg.signedArea(bold[0].points));
  ok(a1 > a0, 'bold: outer square area grows (' + Math.round(a0) + '→' + Math.round(a1) + ')');
})();

// ---- BOLD on a ring: outer grows, counter shrinks, net ink up ------------
(function boldRingTest() {
  const ring = [rect(0, 0, 100, 100, true), rect(30, 30, 70, 70, false)];
  const b = wg.emboldenContours(ring, 8);
  ok(sameStructure(ring, b), 'bold ring: structure preserved (outer + hole)');
  const outer0 = Math.abs(wg.signedArea(ring[0].points)), outer1 = Math.abs(wg.signedArea(b[0].points));
  const hole0 = Math.abs(wg.signedArea(ring[1].points)), hole1 = Math.abs(wg.signedArea(b[1].points));
  ok(outer1 > outer0, 'bold ring: outer grows (' + Math.round(outer0) + '→' + Math.round(outer1) + ')');
  ok(hole1 < hole0, 'bold ring: counter shrinks (' + Math.round(hole0) + '→' + Math.round(hole1) + ')');
  ok((outer1 - hole1) > (outer0 - hole0), 'bold ring: net ink area increases (stroke thickens)');
})();

// ---- LIGHT: negative amount thins ink ------------------------------------
(function lightTest() {
  const sq = [rect(0, 0, 100, 100, true)];
  const light = wg.emboldenContours(sq, -8);
  const a0 = Math.abs(wg.signedArea(sq[0].points)), a1 = Math.abs(wg.signedArea(light[0].points));
  ok(a1 < a0, 'light: negative amount shrinks ink (' + Math.round(a0) + '→' + Math.round(a1) + ')');
})();

// ---- curves: handles ride the offset, structure intact -------------------
(function curveTest() {
  const c = {
    closed: true, isHole: false, points: [
      { x: 0, y: 0, type: 'corner', handleIn: null, handleOut: { x: 0, y: 55 } },
      { x: 0, y: 100, type: 'smooth', handleIn: { x: 0, y: 45 }, handleOut: { x: 55, y: 100 } },
      { x: 100, y: 100, type: 'corner', handleIn: { x: 45, y: 100 }, handleOut: null },
      { x: 100, y: 0, type: 'corner', handleIn: null, handleOut: null },
    ],
  };
  const bold = wg.emboldenContours([c], 6);
  ok(sameStructure([c], bold), 'curves: bold keeps handles/anchors structure');
  ok(bold[0].points[0].handleOut && bold[0].points[1].handleIn, 'curves: handles preserved (non-null stay non-null)');
})();

console.log('\nweightgen OK');
