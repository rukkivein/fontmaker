'use strict';
// UXP plugin pipeline test (headless, no Illustrator):
//   mock Illustrator selection -> ilbridge -> glyphset assign -> core buildFont
//   -> reload with opentype -> assert a real glyph came out.
// Proves everything the plugin relies on works, minus the live host + file I/O.
const assert = require('assert');
const opentype = require('opentype.js');
const { contourFromPathItem, collectPathItems, contoursFromSelection } = require('../plugin/src/ilbridge.js');
const glyphset = require('../plugin/src/glyphset.js');
const { buildFont } = require('../core/fontEngine.js');

function ok(cond, msg) { assert.ok(cond, msg); console.log('✓ ' + msg); }

// --- mock Illustrator DOM objects (Y is DOWN, like Illustrator) --------------
function pathItem(points, closed) {
  return { typename: 'PathItem', closed: closed !== false, pathPoints: points };
}
function pp(anchor, left, right, type) {
  return { anchor, leftDirection: left || anchor, rightDirection: right || anchor, pointType: type || 'PointType.CORNER' };
}
function group(children) { return { typename: 'GroupItem', pageItems: children }; }

// A 400x600 rectangle in Illustrator coords (y-down), one corner carrying a
// bezier handle so we exercise handle mapping.
const rect = pathItem([
  pp([100, 100], null, [160, 100], 'PointType.SMOOTH'), // rightDirection != anchor -> handleOut
  pp([500, 100]),
  pp([500, 700]),
  pp([100, 700], [100, 640], null, 'PointType.SMOOTH'), // leftDirection != anchor -> handleIn
], true);

// --- ilbridge: single contour, Y flipped, handles mapped ---------------------
const c = contourFromPathItem(rect);
ok(c.points.length === 4, 'contour has 4 points');
ok(c.closed === true, 'contour is closed');
ok(c.points[0].y === -100, 'Y flipped (IL y=100 → model y=-100)');
ok(c.points[0].handleOut && c.points[0].handleOut.x === 160 && c.points[0].handleOut.y === -100,
   'rightDirection → handleOut (with flipped Y)');
ok(c.points[0].handleIn === null, 'no leftDirection → handleIn null');
ok(c.points[3].handleIn && c.points[3].handleIn.y === -640, 'leftDirection → handleIn (flipped Y)');

// --- collectPathItems descends groups ---------------------------------------
const sel = [group([rect])];
const items = collectPathItems(sel, []);
ok(items.length === 1, 'collectPathItems descends a GroupItem to its path');
const contours = contoursFromSelection(sel);
ok(contours.length === 1, 'contoursFromSelection returns 1 contour from the group');

// --- assign to a glyph, scaled to cap height ---------------------------------
const project = glyphset.createProject({ familyName: 'BridgeTest' });
const idx = project.glyphs.findIndex(g => g.char === 'A');
ok(idx >= 0, 'project has an A slot');
const assigned = glyphset.assignContoursToGlyph(project, contours, idx);
ok(assigned, 'assignContoursToGlyph succeeded');

const layer = project.glyphs[idx].layers[project.masters[0].id];
ok(layer.contours.length === 1, 'A now has 1 contour in master 0');
const ys = layer.contours[0].points.map(p => p.y);
const h = Math.max(...ys) - Math.min(...ys);
ok(Math.abs(h - project.metrics.capHeight) < 1, 'outline scaled to cap height (' + Math.round(h) + ')');
ok(Math.min(...ys) >= -0.5 && Math.min(...ys) <= 0.5, 'outline sits on the baseline');

// --- build a real OTF and reload it ------------------------------------------
const { buffer, glyphCount } = buildFont(project, 'otf', {
  familyName: 'BridgeTest', styleName: 'Regular', masterId: project.masters[0].id,
});
ok(buffer && buffer.byteLength > 0, 'buildFont produced an ArrayBuffer (' + buffer.byteLength + ' bytes)');
ok(glyphCount === project.glyphs.length, 'glyphCount matches project glyph count');

const font = opentype.parse(buffer);
const A = font.charToGlyph('A');
ok(A && A.path.commands.length > 0, 'reloaded font: A has ' + A.path.commands.length + ' path commands');
ok(A.advanceWidth > 0, 'A has a positive advance width (' + A.advanceWidth + ')');

console.log('\nUXP bridge pipeline OK');
