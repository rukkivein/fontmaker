'use strict';
// Host-bridge pipeline test (headless, no Illustrator):
//   ExtendScript-shaped selection JSON -> shared/ilbridge.js -> glyphset assign
//   -> core buildFont -> reload with opentype -> assert a real glyph came out.
// The mock objects below have the exact shape jsx/fontmaker.jsx emits, so this
// proves everything the CEP panel relies on, minus the live host + file I/O.
const assert = require('assert');
const opentype = require('opentype.js');
const { contourFromPathItem, collectPathItems, contoursFromSelection, contoursFromArtboard } = require('../shared/ilbridge.js');
const glyphset = require('../shared/glyphset.js');
const { buildFont } = require('../core/fontEngine.js');

function ok(cond, msg) { assert.ok(cond, msg); console.log('✓ ' + msg); }

// A path object exactly as fontmaker.jsx serializes it (Illustrator Y-down).
function pp(anchor, left, right, type) {
  return { anchor, leftDirection: left || anchor, rightDirection: right || anchor, pointType: type || 'corner' };
}
function path(points, closed) { return { closed: closed !== false, pathPoints: points }; }

// A 400x600 rectangle with a couple of bezier handles to exercise mapping.
const rect = path([
  pp([100, 100], null, [160, 100], 'smooth'),
  pp([500, 100]),
  pp([500, 700]),
  pp([100, 700], [100, 640], null, 'smooth'),
], true);

// --- ilbridge: Y flipped, handles mapped ---
const c = contourFromPathItem(rect);
ok(c.points.length === 4, 'contour has 4 points');
ok(c.closed === true, 'contour is closed');
ok(c.points[0].y === -100, 'Y flipped (IL y=100 → model y=-100)');
ok(c.points[0].handleOut && c.points[0].handleOut.x === 160 && c.points[0].handleOut.y === -100,
   'rightDirection → handleOut (flipped Y)');
ok(c.points[0].handleIn === null, 'no leftDirection → handleIn null');
ok(c.points[3].handleIn && c.points[3].handleIn.y === -640, 'leftDirection → handleIn (flipped Y)');

// --- the jsx returns a flat {paths:[...]}; contoursFromSelection consumes it ---
const fromJsx = contoursFromSelection([rect]);
ok(fromJsx.length === 1, 'contoursFromSelection handles the jsx path list');
ok(collectPathItems([rect], []).length === 1, 'collectPathItems treats a path as a leaf');

// --- assign to a glyph, scaled to cap height ---
const project = glyphset.createProject({ familyName: 'BridgeTest' });
const idx = project.glyphs.findIndex(g => g.char === 'A');
ok(idx >= 0, 'project has an A slot');
ok(glyphset.assignContoursToGlyph(project, fromJsx, idx), 'assignContoursToGlyph succeeded');

const layer = project.glyphs[idx].layers[project.masters[0].id];
ok(layer.contours.length === 1, 'A now has 1 contour in master 0');
const ys = layer.contours[0].points.map(p => p.y);
const h = Math.max(...ys) - Math.min(...ys);
ok(Math.abs(h - project.metrics.capHeight) < 1, 'outline scaled to cap height (' + Math.round(h) + ')');
ok(Math.min(...ys) >= -0.5 && Math.min(...ys) <= 0.5, 'outline sits on the baseline');

// --- build a real OTF and reload it ---
const { buffer, glyphCount } = buildFont(project, 'otf', {
  familyName: 'BridgeTest', styleName: 'Regular', masterId: project.masters[0].id,
});
ok(buffer && buffer.byteLength > 0, 'buildFont produced an ArrayBuffer (' + buffer.byteLength + ' bytes)');
ok(glyphCount === project.glyphs.length, 'glyphCount matches project glyph count');

const font = opentype.parse(buffer);
const A = font.charToGlyph('A');
ok(A && A.path.commands.length > 0, 'reloaded font: A has ' + A.path.commands.length + ' path commands');
ok(A.advanceWidth > 0, 'A has a positive advance width (' + A.advanceWidth + ')');

// --- artboard live-sync mapping (Y-up, baseline-relative, no flip) ---
// rect [left, top, right, bottom]; scale 0.25 pt/unit; descender -200.
// baseline doc-Y = bottom + (0 - descender)*scale = 0 + 200*0.25 = 50.
var abRect = [100, 250, 280, 0];
var abPath = { closed: true, pathPoints: [
  pp([100, 50]), pp([250, 50]), pp([250, 225]), pp([100, 225]),
] };
var abContours = contoursFromArtboard([abPath], abRect, 0.25, -200);
ok(abContours.length === 1, 'contoursFromArtboard returns one contour');
var ap = abContours[0].points;
ok(ap[0].x === 0 && ap[0].y === 0, 'artboard origin maps to baseline/left (0,0)');
ok(ap[2].x === 600 && ap[2].y === 700, 'top-right maps to font units (600,700) — Y up, not flipped');

// setGlyphContours writes font-unit contours straight in + sets advance.
var proj2 = glyphset.createProject({ alphabets: ['latinUpper'] });
var ai = proj2.glyphs.findIndex(g => g.char === 'B');
var mid = proj2.masters[0].id;
ok(glyphset.setGlyphContours(proj2, ai, mid, abContours, 700), 'setGlyphContours writes a layer');
ok(proj2.glyphs[ai].layers[mid].contours[0].points[2].y === 700, 'contours stored unscaled');
ok(proj2.glyphs[ai].advanceWidth === 700, 'advance width set');
var sig1 = glyphset.layerSignature(proj2.glyphs[ai], mid);
ok(sig1.length > 0, 'layerSignature non-empty for a filled glyph');
ok(glyphset.layerSignature(proj2.glyphs[proj2.glyphs.findIndex(g => g.char === 'C')], mid) === '', 'empty glyph → empty signature');

console.log('\nHost bridge pipeline OK');
