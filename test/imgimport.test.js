'use strict';
// Image-import pipeline (headless, no Illustrator, no PNG files):
//   synthetic ImageData -> imagetrace -> imgglyphs cluster/detect/map/seat
//   -> glyphset.setGlyphContours -> core buildFont -> reload with opentype.
// Proves the pure brain of the "Image Import" feature: the hard cases are blob
// clustering (i=stem+dot, ==two bars, accent=base+mark) and correct seating
// (baseline=0, accents up, descenders down).
const assert = require('assert');
const opentype = require('opentype.js');
const trace = require('../shared/imagetrace.js');
const ig = require('../shared/imgglyphs.js');
const glyphset = require('../shared/glyphset.js');
const { buildFont } = require('../core/fontEngine.js');

function ok(cond, msg) { assert.ok(cond, msg); console.log('✓ ' + msg); }
function approx(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ' (' + Math.round(a) + '≈' + b + ')'); }

// ---- tiny raster helpers --------------------------------------------------
function makeImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = 255; }
  return { width: w, height: h, data };
}
function fill(img, x0, y0, x1, y1, v) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * img.width + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
}
function rectContour(x0, y0, x1, y1, isHole) {
  return {
    closed: true, isHole: !!isHole, bbox: [x0, y0, x1, y1],
    points: [
      { x: x0, y: y0, type: 'corner', handleIn: null, handleOut: null },
      { x: x1, y: y0, type: 'corner', handleIn: null, handleOut: null },
      { x: x1, y: y1, type: 'corner', handleIn: null, handleOut: null },
      { x: x0, y: y1, type: 'corner', handleIn: null, handleOut: null },
    ],
  };
}

// ==== 1. tracing: two separate squares + a square-with-hole ================
(function traceTest() {
  const img = makeImage(120, 60);
  fill(img, 10, 10, 40, 50, 0);   // glyph A
  fill(img, 70, 10, 100, 50, 0);  // glyph B
  fill(img, 78, 22, 92, 38, 255); // counter (hole) inside B
  const contours = trace.traceImageData(img, { trace: { pathomit: 1 } });
  ok(contours.length === 3, 'trace: 2 solids + 1 hole = 3 contours (' + contours.length + ')');
  ok(contours.filter(c => c.isHole).length === 1, 'trace: exactly one hole contour');
  const solid = contours.filter(c => !c.isHole).map(c => c.bbox).sort((a, b) => a[0] - b[0]);
  approx(solid[0][0], 10, 2, 'trace: first solid left edge ≈10');
  approx(solid[1][2], 101, 2, 'trace: second solid right edge ≈101');
})();

// ==== 2. clustering: i(stem+dot), =(two bars), neighbour stay correct ======
(function clusterRowTest() {
  const contours = [
    rectContour(0, 4, 3, 20),    // i stem
    rectContour(0, 0, 3, 2),     // i dot (same column, floats above)
    rectContour(8, 9, 16, 11),   // = top bar
    rectContour(8, 13, 16, 15),  // = bottom bar (same column, stacked)
    rectContour(24, 0, 27, 20),  // l (a separate neighbour)
  ];
  const cl = ig.clusterGlyphs(contours);
  ok(cl.length === 3, 'cluster: i + = + l => 3 glyphs (' + cl.length + ')');
  ok(cl[0].contours.length === 2, 'cluster: i merges stem + dot');
  ok(cl[1].contours.length === 2, 'cluster: = merges both bars');
  ok(cl[2].contours.length === 1, 'cluster: neighbour stays its own glyph');
  ok(cl[0].bbox[0] < cl[1].bbox[0] && cl[1].bbox[0] < cl[2].bbox[0], 'cluster: left-to-right order');
})();

// ==== 3. clustering across rows: accent merges with its base ===============
(function clusterRowsTest() {
  const contours = [
    rectContour(0, 0, 15, 18),    // row1 A
    rectContour(22, 0, 37, 18),   // row1 B
    rectContour(0, 45, 12, 60),   // row2 base (à body)
    rectContour(2, 38, 10, 41),   // row2 accent (floats above base, small Y gap)
    rectContour(22, 45, 34, 60),  // row2 second letter
  ];
  const cl = ig.clusterGlyphs(contours);
  ok(cl.length === 4, 'cluster: 2 rows × 2 glyphs = 4 (' + cl.length + ')');
  const r0 = cl.filter(c => c.row === cl[0].row), r1 = cl.filter(c => c.row !== cl[0].row);
  ok(r0.length === 2 && r1.length === 2, 'cluster: split into two rows of 2');
  const accented = cl.find(c => c.contours.length === 2);
  ok(accented && accented.row !== cl[0].row, 'cluster: accent+base merged into one row-2 glyph');
  ok(accented.bbox[1] < 45, 'cluster: merged glyph bbox includes the accent above (top<45)');
})();

// ==== 3b. stacked ACCENTED CAPS must NOT merge (rows from bases, not accents) =
(function stackedAccentTest() {
  // 3 cols × 3 rows of accented caps: each cell = a 40-tall base + an 8-tall accent
  // above it, with TIGHT row spacing so the old "accent bridges rows" bug would
  // chain all three rows into one band and merge each column into one glyph.
  const cs = [];
  [0, 60, 120].forEach((ry) => [0, 60, 120].forEach((cx) => {
    cs.push(rectContour(cx, ry + 12, cx + 40, ry + 52));   // base
    cs.push(rectContour(cx + 10, ry, cx + 30, ry + 7));     // accent above
  }));
  const cl = ig.clusterGlyphs(cs);
  ok(cl.length === 9, 'cluster: 9 stacked accented caps stay 9 separate glyphs (' + cl.length + ')');
  ok(cl.every((c) => c.contours.length === 2), 'cluster: each accented cap keeps base+accent (2 contours)');
  ok(new Set(cl.map((c) => c.row)).size === 3, 'cluster: detected as 3 rows, not 1');
})();

// ==== 4. category detection ================================================
(function detectTest() {
  const mk = (bbs) => bbs.map(b => ({ bbox: b, row: 0, contours: [rectContour(b[0], b[1], b[2], b[3])] }));
  // digits: 10 uniform, one baseline
  const digits = mk(Array.from({ length: 10 }, (_, i) => [i * 60, 30, i * 60 + 50, 100]));
  ok(ig.detectCategory(digits) === 'digits', 'detect: 10 uniform on baseline => digits');
  // uppercase: caps on one baseline + a few accented caps poking higher, no descenders
  const upper = mk(Array.from({ length: 30 }, (_, i) => i < 26
    ? [i * 60, 30, i * 60 + 50, 100]        // plain caps (top 30)
    : [i * 60, 12, i * 60 + 50, 100]));      // accented caps (taller, still on baseline)
  ok(ig.detectCategory(upper) === 'upper', 'detect: caps + accents, no descenders => upper');
  // lowercase: x-height bodies + ascenders + real descenders below the baseline
  const lower = mk(Array.from({ length: 24 }, (_, i) =>
    i < 10 ? [i * 60, 50, i * 60 + 40, 100]        // x-height (a c e m n o…)
      : i < 18 ? [i * 60, 20, i * 60 + 40, 100]     // ascenders (b d h k l…)
        : [i * 60, 50, i * 60 + 40, 125]));          // descenders (g j p q y) — below baseline
  ok(ig.detectCategory(lower) === 'lower', 'detect: descenders below baseline => lower');
  // symbols: tiny dots + tall brackets at scattered heights (heterogeneous)
  const sym = mk([[0, 90, 12, 100], [20, 95, 32, 120], [40, 50, 50, 100], [60, 30, 70, 100],
    [80, 25, 95, 110], [110, 30, 125, 105], [140, 60, 165, 68], [180, 20, 192, 45],
    [210, 30, 230, 100], [250, 30, 280, 100]]);
  ok(ig.detectCategory(sym) === 'symbols', 'detect: mixed sizes + scattered => symbols');
})();

// ==== 5. canonical sequences + mapping =====================================
(function mapTest() {
  ok(ig.SEQ.digits.length === 10, 'seq: digits = 10');
  ok(ig.SEQ.upper.length === 60, 'seq: upper = 26 + 34 accents = 60 (' + ig.SEQ.upper.length + ')');
  ok(ig.SEQ.lower.length === 62, 'seq: lower = 26 + 36 accents = 62 (' + ig.SEQ.lower.length + ')');
  ok(ig.SEQ.symbols.length === 29, 'seq: symbols = 29 (' + ig.SEQ.symbols.length + ')');
  const clusters = Array.from({ length: 10 }, (_, i) => ({ bbox: [i, 0, i + 1, 1], row: 0, contours: [] }));
  const m = ig.mapClusters(clusters, 'digits');
  ok(m[0].char === '0' && m[9].char === '9', 'map: digits => 0..9 in reading order');
  ok(m[5].unicode === '5'.codePointAt(0), 'map: carries unicode');
  // overflow tolerated
  const extra = ig.mapClusters(Array.from({ length: 12 }, (_, i) => ({ bbox: [i, 0, i + 1, 1], row: 0, contours: [] })), 'digits');
  ok(extra[10].char === null && extra[11].char === null, 'map: extra clusters left unassigned (no crash)');
})();

// ==== 6. seating: scale to metrics, baseline=0, accent up, descender down ===
(function seatTest() {
  const metrics = glyphset.DEFAULT_METRICS; // capHeight 716, xHeight 519, descender -200
  // Uppercase row: two plain caps on the baseline (bottom=70) + one glyph whose
  // tail drops below the baseline. 3 glyphs => median baseline is a stable 70.
  const cap = rectContour(0, 0, 40, 70);
  const cap2 = rectContour(60, 0, 100, 70);
  const withTail = { closed: true, isHole: false, bbox: [120, 0, 160, 85], points: [
    { x: 120, y: 0, type: 'corner', handleIn: null, handleOut: null },   // top at cap line
    { x: 160, y: 0, type: 'corner', handleIn: null, handleOut: null },
    { x: 160, y: 85, type: 'corner', handleIn: null, handleOut: null },  // tail below baseline (>70)
    { x: 120, y: 85, type: 'corner', handleIn: null, handleOut: null },
  ] };
  const clusters = ig.clusterGlyphs([cap, cap2, withTail]);
  const seated = ig.seatClusters(clusters, 'upper', metrics);
  const capSeat = seated[0];
  approx(capSeat.height, metrics.capHeight, 2, 'seat: cap glyph scaled to cap height');
  const capYs = capSeat.contours[0].points.map(p => p.y);
  approx(Math.min(...capYs), 0, 2, 'seat: cap glyph bottom sits on baseline (y≈0)');
  ok(Math.max(...capYs) > 0, 'seat: cap glyph extends upward (y>0)');
  const tailYs = seated[2].contours[0].points.map(p => p.y);
  ok(Math.min(...tailYs) < -1, 'seat: descender tail goes below baseline (y<0)');
  ok(seated[0].advanceWidth > 0, 'seat: positive advance width');
})();

// ==== 6b. seatByChar: per-glyph scale anchor + legacy fallbacks =============
(function seatByCharTest() {
  const metrics = glyphset.DEFAULT_METRICS;
  // three caps on one baseline → capHeight, identical to seatClusters('upper').
  const caps = ig.clusterGlyphs([rectContour(0, 0, 40, 70), rectContour(60, 0, 100, 70), rectContour(120, 0, 160, 70)]);
  const byChar = ig.seatByChar(caps, ['A', 'B', 'C'], metrics);
  const byCat = ig.seatClusters(caps, 'upper', metrics);
  approx(byChar[0].height, byCat[0].height, 0.5, 'seatByChar: caps == seatClusters(upper) height');
  approx(byChar[0].height, metrics.capHeight, 2, 'seatByChar: cap scaled to capHeight');

  // symbols-only must REPRODUCE the legacy symbols scale (percentile→capHeight).
  const syms = ig.clusterGlyphs([rectContour(0, 80, 8, 92), rectContour(20, 40, 30, 92), rectContour(50, 30, 70, 92)]);
  const sBy = ig.seatByChar(syms, ['.', '!', '?'], metrics, { fallbackCategory: 'symbols' });
  const sCat = ig.seatClusters(syms, 'symbols', metrics);
  approx(sBy[2].height, sCat[2].height, 0.5, 'seatByChar: symbols-only == legacy symbols scale');

  // model-off (all chars null) must REPRODUCE the legacy lower scale.
  const xs = ig.clusterGlyphs([rectContour(0, 40, 30, 70), rectContour(40, 40, 70, 70), rectContour(80, 40, 110, 70)]);
  const nBy = ig.seatByChar(xs, [null, null, null], metrics, { fallbackCategory: 'lower' });
  const nCat = ig.seatClusters(xs, 'lower', metrics);
  approx(nBy[0].height, nCat[0].height, 0.5, 'seatByChar: all-null == legacy lower scale');

  // mixed sheet: caps present → anchor on caps; the x-height glyph stays shorter.
  const mixed = ig.clusterGlyphs([rectContour(0, 0, 40, 70), rectContour(60, 30, 90, 70)]);
  const mBy = ig.seatByChar(mixed, ['A', 'a'], metrics);
  approx(mBy[0].height, metrics.capHeight, 2, 'seatByChar: mixed anchors on caps (cap=capHeight)');
  ok(mBy[1].height < metrics.capHeight * 0.95, 'seatByChar: mixed x-height glyph stays shorter than cap');

  // class table sanity
  ok(ig.letterClass('A') === 'cap' && ig.letterClass('a') === 'x' && ig.letterClass('À') === 'cap'
    && ig.letterClass('ñ') === 'x' && ig.letterClass('5') === 'cap' && ig.letterClass('!') === null,
    'letterClass: A/a/À/ñ/5/! classified correctly');
})();

// ==== 7. full chain into a real OTF ========================================
(function endToEndTest() {
  const img = makeImage(180, 80);
  fill(img, 10, 15, 45, 65, 0);    // "0"
  fill(img, 70, 15, 105, 65, 0);   // "1"
  fill(img, 130, 15, 165, 65, 0);  // "2"
  const contours = trace.traceImageData(img, { trace: { pathomit: 1 } });
  const sheet = ig.analyzeSheet(contours);
  ok(sheet.category === 'digits' || sheet.clusters.length === 3, 'e2e: 3 digit blobs found');
  ok(sheet.clusters.length === 3, 'e2e: clustered into 3 glyphs');

  const project = glyphset.createProject({ alphabets: ['numbers'] });
  const seated = ig.seatClusters(sheet.clusters, 'digits', project.metrics);
  const mid = project.masters[0].id;
  let filled = 0;
  sheet.mapping.forEach((m, i) => {
    if (m.char == null) return;
    const gi = project.glyphs.findIndex(g => g.char === m.char);
    if (gi < 0) return;
    if (glyphset.setGlyphContours(project, gi, mid, seated[i].contours, seated[i].advanceWidth)) filled++;
  });
  ok(filled === 3, 'e2e: filled 3 glyph slots (0,1,2)');

  const built = buildFont(project, 'otf', { familyName: 'ImgImportTest', masterId: mid });
  ok(built.buffer && built.buffer.byteLength > 0, 'e2e: built a real OTF (' + built.buffer.byteLength + ' bytes)');
  const font = opentype.parse(built.buffer);
  const zero = font.charToGlyph('0');
  ok(zero && zero.path.commands.length > 0, 'e2e: reloaded OTF has a drawn "0" (' + zero.path.commands.length + ' cmds)');
})();

// ==== 8. Illustrator trace paths -> pixel-space contours (Y flip) ===========
(function traceConvertTest() {
  function ap(x, y, type) { return { anchor: [x, y], leftDirection: [x, y], rightDirection: [x, y], pointType: type || 'corner' }; }
  function path(pts) { return { closed: true, pathPoints: pts }; }
  const bounds = [0, 100, 60, 0]; // left, top, right, bottom — Illustrator Y-UP (top=100)
  const topGlyph = path([ap(10, 90), ap(50, 90), ap(50, 70), ap(10, 70)]);  // high on the sheet
  const botGlyph = path([ap(10, 30), ap(50, 30), ap(50, 10), ap(10, 10)]);  // low on the sheet
  const cs = ig.contoursFromTracePaths([topGlyph, botGlyph], bounds);
  ok(cs.length === 2, 'trace-convert: 2 contours');
  ok(cs[0].points[0].x === 10 && cs[0].points[0].y === 10, 'trace-convert: top-of-sheet glyph flips to small pixel-Y (y=10)');
  const b0 = ig.contourBbox(cs[0]), b1 = ig.contourBbox(cs[1]);
  ok(b0[1] < b1[1], 'trace-convert: top glyph has smaller pixel-Y than the lower one (Y-down)');
  const clusters = ig.clusterGlyphs(cs);
  ok(clusters.length === 2 && clusters[0].bbox[1] < clusters[1].bbox[1], 'trace-convert: clusters ordered top-to-bottom');
})();

console.log('\nImage-import pipeline OK');
