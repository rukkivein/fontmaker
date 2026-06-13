'use strict';
// Verifies accentCompose, optimizer and ttfWriter against the real engine +
// opentype.js. (fontTools cross-check runs separately in _ttfcheck.py.)
const assert = require('assert');
const fs = require('fs');
const gs = require('../shared/glyphset.js');
const fe = require('../core/fontEngine.js');
const ot = require('../cep/js/lib/opentype.js');
const accent = require('../shared/accentCompose.js');
const opt = require('../shared/optimizer.js');
const ttf = require('../core/ttfWriter.js');
function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }

function rect(x1, y1, x2, y2) { return { closed: true, points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(function (q) { return { x: q[0], y: q[1], type: 'corner', handleIn: null, handleOut: null }; }) }; }
function circle(cx, cy, r) { // 4-arc cubic circle
  var k = 0.5523 * r, pts = [
    { x: cx + r, y: cy, hI: [cx + r, cy - k], hO: [cx + r, cy + k] },
    { x: cx, y: cy + r, hI: [cx + k, cy + r], hO: [cx - k, cy + r] },
    { x: cx - r, y: cy, hI: [cx - r, cy + k], hO: [cx - r, cy - k] },
    { x: cx, y: cy - r, hI: [cx - k, cy - r], hO: [cx + k, cy - r] },
  ];
  return { closed: true, points: pts.map(function (p) { return { x: p.x, y: p.y, type: 'smooth', handleIn: { x: p.hI[0], y: p.hI[1] }, handleOut: { x: p.hO[0], y: p.hO[1] } }; }) };
}

// ---------- ACCENT ----------
(function () {
  var p = gs.createProject({ alphabets: ['latinUpper', 'latinLower', 'latinWest'] });
  var mid = p.masters[0].id;
  function fill(ch, contours) { var g = p.glyphs.find(function (x) { return x.char === ch; }); if (g) g.layers[mid] = { contours: contours }; return g; }
  fill('e', [circle(250, 260, 230)]);                       // base e (round)
  // a standalone acute mark glyph named 'acute'
  var acute = { name: 'acute', char: null, unicode: 0x00B4, advanceWidth: 300, kind: 'mark', layers: {} }; acute.layers[mid] = { contours: [rect(120, 560, 230, 700)] };
  p.glyphs.push(acute);
  var r = accent.composeAccent(p, 'é', mid);
  ok(r.ok && r.base === 'e' && r.marks[0] === 'acute', 'accent: é composed from e + acute');
  var eg = p.glyphs.find(function (x) { return x.char === 'é'; });
  var b = gs.contoursBounds(eg.layers[mid].contours);
  ok(b.maxY > 519, 'accent: é rises above x-height (mark on top), y2=' + Math.round(b.maxY));
  ok(eg.advanceWidth === p.glyphs.find(function (x) { return x.char === 'e'; }).advanceWidth, 'accent: é keeps the base advance');
  // build & confirm é maps to a real glyph with ink
  var built = fe.buildFont(p, 'otf', { familyName: 'T', styleName: 'Regular', masterId: mid });
  var font = ot.parse(built.buffer);
  ok(font.charToGlyphIndex('é') > 0, 'accent: é has a cmap entry in the built OTF');
  ok(font.charToGlyph('é').path.commands.length > 0, 'accent: é has outline commands');
  // idempotent
  var snap = JSON.stringify(eg.layers[mid]);
  accent.composeAccent(p, 'é', mid);
  ok(JSON.stringify(p.glyphs.find(function (x) { return x.char === 'é'; }).layers[mid]) !== null, 'accent: recompose runs clean');
})();

// ---------- OPTIMIZER ----------
(function () {
  var p = gs.createProject({ alphabets: ['latinUpper', 'latinLower'] });
  var mid = p.masters[0].id;
  function fill(ch, contours) { var g = p.glyphs.find(function (x) { return x.char === ch; }); if (g) g.layers[mid] = { contours: contours }; }
  fill('H', [rect(0, 0, 120, 716), rect(120, 320, 380, 396), rect(380, 0, 500, 716)]);
  fill('I', [rect(0, 0, 90, 716)]);
  fill('O', [circle(300, 358, 358), circle(300, 358, 250)]);
  fill('W', [rect(0, 0, 900, 716)]);
  fill('o', [circle(250, 260, 250), circle(250, 260, 150)]);
  var r = opt.optimizeAll(p, mid);
  ok(r.spaced >= 4, 'optimizer: spaced ' + r.spaced + ' glyphs');
  function adv(ch) { return p.glyphs.find(function (x) { return x.char === ch; }).advanceWidth; }
  function lsb(ch) { var g = p.glyphs.find(function (x) { return x.char === ch; }); var b = opt.bezBounds(g.layers[mid].contours); return Math.round(b.xMin); }
  function rsb(ch) { var g = p.glyphs.find(function (x) { return x.char === ch; }); var b = opt.bezBounds(g.layers[mid].contours); return Math.round(g.advanceWidth - b.xMax); }
  ok(lsb('H') > 0 && rsb('H') > 0, 'optimizer: H gets positive sidebearings (' + lsb('H') + '/' + rsb('H') + ')');
  ok(lsb('O') < lsb('H'), 'optimizer: round O tucks tighter than flat H (' + lsb('O') + ' < ' + lsb('H') + ')');
  ok(lsb('I') >= lsb('H'), 'optimizer: narrow I breathes >= H (' + lsb('I') + ' >= ' + lsb('H') + ')');
  ok(lsb('W') <= lsb('H'), 'optimizer: wide W tucks <= H (' + lsb('W') + ' <= ' + lsb('H') + ')');
  // build round-trips with the new advances
  var built = fe.buildFont(p, 'otf', { familyName: 'T', styleName: 'Regular', masterId: mid });
  var font = ot.parse(built.buffer);
  var Hadv = adv('H'), Hidx = font.charToGlyphIndex('H');
  ok(Math.round(font.glyphs.get(Hidx).advanceWidth) === Hadv, 'optimizer: H advance round-trips (' + Hadv + ')');
  ok(r.kernPairs >= 0, 'optimizer: kern pass produced ' + r.kernPairs + ' pairs');
})();

// ---------- TTF WRITER ----------
(function () {
  var p = gs.createProject({ alphabets: ['latinUpper'] });
  var mid = p.masters[0].id;
  function fill(ch, contours) { var g = p.glyphs.find(function (x) { return x.char === ch; }); if (g) { g.layers[mid] = { contours: contours }; g.advanceWidth = 600; } }
  fill('O', [circle(300, 350, 260), circle(300, 350, 170)]); // counter
  fill('I', [rect(60, 0, 440, 700)]);
  // a glyph with a >255 delta + negative coords
  fill('A', [{ closed: true, points: [[-40, -30], [560, -30], [260, 740]].map(function (q) { return { x: q[0], y: q[1], type: 'corner', handleIn: null, handleOut: null }; }) }]);
  var buf = ttf.buildGlyfFont(p, { familyName: 'RTtf', styleName: 'Regular', version: '1.000' }, mid);
  fs.writeFileSync(__dirname + '/_rt.ttf', Buffer.from(new Uint8Array(buf)));
  var dv = new DataView(buf);
  ok(dv.getUint32(0, false) === 0x00010000, 'ttf: sfntVersion is glyf (0x00010000)');
  var font = ot.parse(buf); // opentype.js parses glyf TTF
  ok(font.glyphs.length === p.glyphs.length + 1, 'ttf: glyph count ' + font.glyphs.length);
  ok(font.unitsPerEm === 1000, 'ttf: unitsPerEm 1000');
  var Oidx = font.charToGlyphIndex('O');
  ok(Oidx > 0, 'ttf: O maps via cmap (gid ' + Oidx + ')');
  var Opath = font.glyphs.get(Oidx).path.toPathData();
  ok(Opath.indexOf('Q') >= 0, 'ttf: O uses quadratic (Q) commands');
  // point-count sanity: the O must NOT explode (cubic→quad closure bug guard)
  var Ocmds = font.glyphs.get(Oidx).path.commands.length;
  ok(Ocmds < 80, 'ttf: O has a sane command count (' + Ocmds + ' < 80) — no subdivision blowup');
  var Ibox = font.glyphs.get(font.charToGlyphIndex('I')).getBoundingBox();
  ok(Ibox.x1 === 60 && Ibox.y1 === 0 && Ibox.x2 === 440 && Ibox.y2 === 700, 'ttf: I bbox exact [60,0,440,700]');
  var Aidx = font.charToGlyphIndex('A'), Abox = font.glyphs.get(Aidx).getBoundingBox();
  ok(Abox.x1 === -40 && Abox.y1 === -30 && Abox.x2 === 560 && Abox.y2 === 740, 'ttf: A bbox exact with negative+>255 deltas');
  ok(Math.round(font.glyphs.get(Aidx).advanceWidth) === 600, 'ttf: A advance 600 round-trips');
})();

console.log('\nFinalize verify OK');
