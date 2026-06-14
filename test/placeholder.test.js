'use strict';
// Verifies empty-glyph placeholder injection: undrawn encoded slots get the art,
// drawn glyphs are untouched, and space / unencoded helpers are left blank.
const assert = require('assert');
const { fillEmptyGlyphs, isEmptyLayer } = require('../shared/placeholder.js');

let fails = 0;
function ok(cond, msg) { console.log((cond ? '✓' : '✗ FAIL') + ' ' + msg); if (!cond) fails++; }

const MID = 'm1';
const art = { advanceWidth: 500, contours: [{ closed: true, points: [
  { x: 0, y: 0, type: 'corner', handleIn: null, handleOut: null },
  { x: 100, y: 0, type: 'corner', handleIn: null, handleOut: null },
  { x: 50, y: 100, type: 'corner', handleIn: null, handleOut: null },
] }] };

const drawn = { x: 1, y: 1 };
const project = { masters: [{ id: MID, name: 'Regular' }], glyphs: [
  { name: 'A', char: 'A', unicode: 65, advanceWidth: 600, layers: { [MID]: { contours: [{ closed: true, points: [drawn, drawn, drawn] }] } } },
  { name: 'B', char: 'B', unicode: 66, advanceWidth: 600, layers: { [MID]: {} } },            // empty → fill
  { name: 'C', char: 'C', unicode: 67, advanceWidth: 600, layers: {} },                       // empty → fill
  { name: 'space', char: ' ', unicode: 32, advanceWidth: 250, layers: {} },                   // skip
  { name: '.notdef', char: null, unicode: null, advanceWidth: 0, layers: {} },                // skip
] };

const n = fillEmptyGlyphs(project, MID, art);
ok(n === 2, 'filled exactly the 2 undrawn encoded slots (B, C)');

const byName = {}; project.glyphs.forEach(g => { byName[g.name] = g; });
ok(byName.A.layers[MID].contours[0].points[0] === drawn, 'drawn glyph A untouched (same ref)');
ok(byName.A.advanceWidth === 600, 'drawn glyph A keeps its advance');
ok(!isEmptyLayer(byName.B, MID) && byName.B.layers[MID].contours.length === 1, 'empty B got placeholder contours');
ok(byName.B.advanceWidth === 500, 'filled B takes the placeholder advance');
ok(byName.B.layers[MID].contours[0].points[0] !== art.contours[0].points[0], 'filled contours are a deep copy, not shared');
ok(isEmptyLayer(byName.space, MID), 'space left blank');
ok(isEmptyLayer(byName['.notdef'], MID), '.notdef left blank');

// no-op safety
ok(fillEmptyGlyphs(project, MID, null) === 0, 'null art is a safe no-op');
ok(fillEmptyGlyphs(project, MID, { contours: [] }) === 0, 'empty art is a safe no-op');

console.log(fails ? `\n${fails} placeholder test(s) failed` : '\nAll placeholder tests passed');
process.exit(fails ? 1 : 0);
