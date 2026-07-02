'use strict';
// Pure-JS glyf-flavored TrueType writer (opentype.js 1.3.4 only writes CFF/OTTO).
// Converts the project's cubic outlines to TrueType quadratics and serializes a
// valid sfnt (0x00010000) with head/hhea/hmtx/maxp/cmap/name/OS2/post/loca/glyf/gasp.
// No Node fs/Buffer — mirrors core/fontEngine.js so it runs in the panel too.
// Honest scope: NO GSUB/GPOS (ligatures/alternates live only on the CFF path).

// ---- winding (mirrors fontEngine; outer CCW / holes CW). No TT flip pass:
// non-zero rasterizers accept this; verified exact in fontTools. ----
function signedArea(pts) { var a = 0; for (var i = 0; i < pts.length; i++) { var q = pts[(i + 1) % pts.length]; a += pts[i].x * q.y - q.x * pts[i].y; } return a / 2; }
function pointInPoly(x, y, poly) { var inside = false; for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) { var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
function reverse(c) {
  var pts = c.points.slice().reverse().map(function (p) { return { x: p.x, y: p.y, handleIn: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null, handleOut: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null }; });
  return { closed: c.closed, points: pts };
}
// Flatten a contour (incl. bezier curves) to a dense polyline so the nesting test
// follows the real outline, not just anchors — anchor-only polygons sit INSIDE a
// curved contour and made round counters (O, Q) miss nesting and fill solid.
function flattenContour(c) {
  var pts = c.points, n = pts.length, out = [];
  for (var i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (a.handleOut || b.handleIn) {
      var c1 = a.handleOut || a, c2 = b.handleIn || b, STEPS = 8;
      for (var s = 1; s < STEPS; s++) {
        var t = s / STEPS, u = 1 - t;
        out.push({
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
        });
      }
    }
  }
  return out;
}
// A point guaranteed inside the polygon (midpoint of the widest mid-height interior
// span). A boundary anchor — or a big outline's centre — can fall inside a small
// nested contour and flip its winding; a true interior point + the area guard below
// avoid that. Robust for many-counter art and curved counters.
function interiorPoint(poly) {
  var ymin = Infinity, ymax = -Infinity;
  for (var i = 0; i < poly.length; i++) { var y0 = poly[i].y; if (y0 < ymin) ymin = y0; if (y0 > ymax) ymax = y0; }
  var y = (ymin + ymax) / 2, xs = [];
  for (var a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    var yi = poly[a].y, yj = poly[b].y;
    if ((yi > y) !== (yj > y)) xs.push((poly[b].x - poly[a].x) * (y - yi) / (yj - yi) + poly[a].x);
  }
  xs.sort(function (p, q) { return p - q; });
  var bx = null, bw = -1;
  for (var k = 0; k + 1 < xs.length; k += 2) { var w = xs[k + 1] - xs[k]; if (w > bw) { bw = w; bx = (xs[k] + xs[k + 1]) / 2; } }
  if (bx !== null) return { x: bx, y: y };
  var cx = 0, cy = 0; for (var m = 0; m < poly.length; m++) { cx += poly[m].x; cy += poly[m].y; }
  return { x: cx / poly.length, y: cy / poly.length };
}
function normalizeWinding(contours) {
  var polys = contours.map(flattenContour);   // follow the curves, not just anchors
  var areas = polys.map(function (p) { return Math.abs(signedArea(p)); });
  var pts = polys.map(function (p) { return p.length >= 3 ? interiorPoint(p) : null; });
  return contours.map(function (c, i) {
    if (c.points.length < 3 || !pts[i]) return c;
    var ai = areas[i], pi = pts[i], depth = 0;
    for (var j = 0; j < contours.length; j++) {
      if (j === i || contours[j].points.length < 3) continue;
      if (areas[j] > ai && pointInPoly(pi.x, pi.y, polys[j])) depth++;   // only strictly-bigger enclosers
    }
    var wantCCW = depth % 2 === 0;
    return (signedArea(c.points) > 0) === wantCCW ? c : reverse(c);
  });
}

// ---- cubic -> quadratic. Error sampled against the LOCAL sub-curve (the bug
// the reviewer caught: don't close over the original endpoints). ----
function cubicAt(p0, c1, c2, p3, t) { var u = 1 - t; return { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y }; }
function quadAt(p0, cp, p1, t) { var u = 1 - t; return { x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y }; }
function cubicErr(p0, c1, c2, p3) { // single-quad control + max sampled deviation
  var cp = { x: (3 * c1.x - p0.x + 3 * c2.x - p3.x) / 4, y: (3 * c1.y - p0.y + 3 * c2.y - p3.y) / 4 };
  var maxd = 0;
  for (var s = 1; s <= 7; s++) { var t = s / 8; var a = cubicAt(p0, c1, c2, p3, t), b = quadAt(p0, cp, p3, t); var d = Math.hypot(a.x - b.x, a.y - b.y); if (d > maxd) maxd = d; }
  return { cp: cp, err: maxd };
}
function splitCubic(p0, c1, c2, p3) { // de Casteljau at t=0.5
  var m = function (a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  var a = m(p0, c1), b = m(c1, c2), cc = m(c2, p3), d = m(a, b), e = m(b, cc), f = m(d, e);
  return [[p0, a, d, f], [f, e, cc, p3]];
}
function cubicToQuads(p0, c1, c2, p3, tol, depth, out) {
  var r = cubicErr(p0, c1, c2, p3);
  if (r.err <= tol || depth >= 10) { out.push({ cp: r.cp, end: p3 }); return; }
  var h = splitCubic(p0, c1, c2, p3);
  cubicToQuads(h[0][0], h[0][1], h[0][2], h[0][3], tol, depth + 1, out);
  cubicToQuads(h[1][0], h[1][1], h[1][2], h[1][3], tol, depth + 1, out);
}

// contour -> TT points [{x,y,on}] (rounded), implicitly closed (drop dup start)
function contourToTT(c, tol) {
  var p = c.points, n = p.length; if (n < 2) return [];
  var tt = [{ x: p[0].x, y: p[0].y, on: true }];
  var segs = c.closed ? n : n - 1;
  for (var i = 0; i < segs; i++) {
    var a = p[i], b = p[(i + 1) % n];
    var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
    var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
    if (hasO || hasI) {
      var quads = []; cubicToQuads({ x: a.x, y: a.y }, a.handleOut || a, b.handleIn || b, { x: b.x, y: b.y }, tol, 0, quads);
      for (var q = 0; q < quads.length; q++) { tt.push({ x: quads[q].cp.x, y: quads[q].cp.y, on: false }); tt.push({ x: quads[q].end.x, y: quads[q].end.y, on: true }); }
    } else tt.push({ x: b.x, y: b.y, on: true });
  }
  // closed: last on-curve == start; drop it
  if (c.closed && tt.length > 1) { var L = tt[tt.length - 1]; if (L.on && Math.round(L.x) === Math.round(tt[0].x) && Math.round(L.y) === Math.round(tt[0].y)) tt.pop(); }
  for (var k = 0; k < tt.length; k++) { tt[k].x = Math.round(tt[k].x); tt[k].y = Math.round(tt[k].y); }
  return tt;
}

// ---- byte writer ----
function Writer() { this.b = []; }
Writer.prototype.u8 = function (v) { this.b.push(v & 0xff); return this; };
Writer.prototype.u16 = function (v) { this.b.push((v >> 8) & 0xff, v & 0xff); return this; };
Writer.prototype.i16 = function (v) { if (v < 0) v += 0x10000; return this.u16(v); };
Writer.prototype.u32 = function (v) { this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; };
Writer.prototype.tag = function (s) { for (var i = 0; i < 4; i++) this.b.push(s.charCodeAt(i)); return this; };
Writer.prototype.bytes = function (arr) { for (var i = 0; i < arr.length; i++) this.b.push(arr[i] & 0xff); return this; };
Writer.prototype.pad4 = function () { while (this.b.length % 4) this.b.push(0); return this; };
function strUTF16BE(s) { var a = []; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a.push((c >> 8) & 0xff, c & 0xff); } return a; }

// ---- variable-font helpers (fvar / gvar / STAT) ----
function f2dot14(v) { var n = Math.round(v * 16384); if (n < -32768) n = -32768; if (n > 32767) n = 32767; return n; } // F2Dot14 as i16
function fixed(v) { return Math.round(v * 65536) | 0; }                                                              // 16.16 Fixed
function peakVec(n, idx, val) { var a = []; for (var i = 0; i < n; i++) a.push(i === idx ? val : 0); return a; }
// gvar packed deltas: zero-runs (0x80|n), byte-runs (0x00|n), word-runs (0x40|n).
function packDeltas(deltas) {
  var out = [], i = 0, n = deltas.length;
  function zeros(c) { while (c > 0) { var k = c > 64 ? 64 : c; out.push(0x80 | (k - 1)); c -= k; } }
  function asBytes(arr) { var p = 0; while (p < arr.length) { var k = (arr.length - p) > 64 ? 64 : (arr.length - p); out.push((k - 1) & 0x3f); for (var j = 0; j < k; j++) out.push(arr[p + j] & 0xff); p += k; } }
  function asWords(arr) { var p = 0; while (p < arr.length) { var k = (arr.length - p) > 64 ? 64 : (arr.length - p); out.push(0x40 | ((k - 1) & 0x3f)); for (var j = 0; j < k; j++) { var d = arr[p + j]; if (d < 0) d += 0x10000; out.push((d >> 8) & 0xff, d & 0xff); } p += k; } }
  while (i < n) {
    var d = deltas[i];
    if (d === 0) { var j = i; while (j < n && deltas[j] === 0) j++; zeros(j - i); i = j; }
    else { var isW = (d < -128 || d > 127), run = [], j2 = i; while (j2 < n && deltas[j2] !== 0 && ((deltas[j2] < -128 || deltas[j2] > 127) === isW)) { run.push(deltas[j2]); j2++; } if (isW) asWords(run); else asBytes(run); i = j2; }
  }
  return out;
}
// Build gvar from per-glyph TT points + per-glyph advance. tuples = [{peak:[..axisCount..], dim:'x'|'y', factor}].
// Synthetic scaling ⇒ delta = (factor-1)*coord per point + the advance phantom (pp2) for x-scaling.
function buildGvar(perGlyphPoints, advances, axisCount, tuples) {
  var numGlyphs = perGlyphPoints.length, T = tuples.length;
  var glyphTables = [];
  for (var gi = 0; gi < numGlyphs; gi++) {
    var pts = perGlyphPoints[gi], nOut = pts.length;
    if (nOut === 0) { glyphTables.push([]); continue; } // empty outline ⇒ no variation (advance stays)
    var serialized = [0x00]; // shared point numbers: 0x00 = ALL points (incl. 4 phantom points)
    var headers = [];
    for (var ti = 0; ti < T; ti++) {
      var tup = tuples[ti], f1 = tup.factor - 1, dxs = [], dys = [];
      for (var pi = 0; pi < nOut; pi++) { dxs.push(tup.dim === 'x' ? Math.round(pts[pi].x * f1) : 0); dys.push(tup.dim === 'y' ? Math.round(pts[pi].y * f1) : 0); }
      // 4 phantom points: [leftOrigin, advance, topOrigin, bottomAdvance] — only the advance (pp2) moves, for x-scaling
      var advDelta = tup.dim === 'x' ? Math.round(advances[gi] * f1) : 0;
      dxs.push(0, advDelta, 0, 0); dys.push(0, 0, 0, 0);
      var packed = packDeltas(dxs).concat(packDeltas(dys));
      headers.push({ size: packed.length, index: ti });
      serialized = serialized.concat(packed);
    }
    var w = new Writer();
    w.u16(0x8000 | (T & 0x0fff));   // tupleVariationCount: bit15 = shared point numbers
    w.u16(4 + T * 4);               // dataOffset = header(4) + T tupleVariationHeaders(4 each)
    for (var h = 0; h < T; h++) { w.u16(headers[h].size); w.u16(headers[h].index & 0x0fff); } // size + shared-tuple index
    var gt = w.b.concat(serialized);
    while (gt.length % 2) gt.push(0);
    glyphTables.push(gt);
  }
  var headerLen = 20, offsetsLen = (numGlyphs + 1) * 4;
  var sharedTuplesOffset = headerLen + offsetsLen, sharedTuplesLen = T * axisCount * 2;
  var dataArrayOffset = sharedTuplesOffset + sharedTuplesLen;
  var dataOffsets = [0]; for (var g2 = 0; g2 < numGlyphs; g2++) dataOffsets.push(dataOffsets[dataOffsets.length - 1] + glyphTables[g2].length);
  var W = new Writer();
  W.u16(1).u16(0).u16(axisCount).u16(T);
  W.u32(sharedTuplesOffset);
  W.u16(numGlyphs).u16(1);          // glyphCount, flags=1 (u32 offsets)
  W.u32(dataArrayOffset);
  for (var oi = 0; oi < dataOffsets.length; oi++) W.u32(dataOffsets[oi]);
  for (var t2 = 0; t2 < T; t2++) { var pk = tuples[t2].peak; for (var ax = 0; ax < axisCount; ax++) W.i16(f2dot14(pk[ax])); }
  for (var g3 = 0; g3 < numGlyphs; g3++) W.bytes(glyphTables[g3]);
  return W.b;
}
// fvar: axes (min/def/max + name id), no named instances (apps expose the axes directly).
function buildFvar(axes) {
  var w = new Writer();
  w.u16(1).u16(0);                  // version 1.0
  w.u16(16).u16(2);                 // axesArrayOffset=16, reserved=2
  w.u16(axes.length).u16(20);       // axisCount, axisSize=20
  w.u16(0).u16(4 + axes.length * 4);// instanceCount=0, instanceSize (unused)
  for (var i = 0; i < axes.length; i++) {
    var a = axes[i];
    w.tag(a.tag).u32(fixed(a.min) >>> 0).u32(fixed(a.def) >>> 0).u32(fixed(a.max) >>> 0);
    w.u16(0).u16(a.nameID);         // flags, axisNameID
  }
  return w.b;
}
// STAT v1.2 — minimal: the design axes only (no axis-value records), elided fallback = Regular.
function buildSTAT(axes, elidedNameID) {
  var w = new Writer();
  w.u16(1).u16(2);                  // version 1.2
  w.u16(8).u16(axes.length);        // designAxisSize=8, designAxisCount
  w.u32(20);                        // designAxesOffset (after the 20-byte header)
  w.u16(0).u32(0);                  // axisValueCount=0, offsetToAxisValueOffsets=null
  w.u16(elidedNameID || 2);         // elidedFallbackNameID
  for (var i = 0; i < axes.length; i++) { w.tag(axes[i].tag).u16(axes[i].nameID).u16(i); } // tag, nameID, ordering
  return w.b;
}

function buildGlyf(glyphTT) {
  // glyphTT: [{contours:[[{x,y,on}]], adv, name, unicode}] (index 0 = .notdef)
  var glyfParts = [], loca = [0], maxPts = 0, maxCtrs = 0;
  var gXMin = 32767, gYMin = 32767, gXMax = -32768, gYMax = -32768;
  var perGlyphBounds = [], perGlyphPoints = [];   // perGlyphPoints feeds gvar (variable fonts)
  for (var gi = 0; gi < glyphTT.length; gi++) {
    var ctrs = glyphTT[gi].contours.filter(function (c) { return c.length > 0; });
    if (!ctrs.length) { perGlyphBounds.push({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 }); perGlyphPoints.push([]); loca.push(loca[loca.length - 1]); continue; }
    var all = [], ends = [], xMin = 32767, yMin = 32767, xMax = -32768, yMax = -32768;
    for (var ci = 0; ci < ctrs.length; ci++) { for (var pi = 0; pi < ctrs[ci].length; pi++) { var pt = ctrs[ci][pi]; all.push(pt); if (pt.x < xMin) xMin = pt.x; if (pt.x > xMax) xMax = pt.x; if (pt.y < yMin) yMin = pt.y; if (pt.y > yMax) yMax = pt.y; } ends.push(all.length - 1); }
    if (all.length > maxPts) maxPts = all.length; if (ctrs.length > maxCtrs) maxCtrs = ctrs.length;
    perGlyphBounds.push({ xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax }); perGlyphPoints.push(all);
    if (xMin < gXMin) gXMin = xMin; if (yMin < gYMin) gYMin = yMin; if (xMax > gXMax) gXMax = xMax; if (yMax > gYMax) gYMax = yMax;
    var w = new Writer();
    w.i16(ctrs.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    for (var e = 0; e < ends.length; e++) w.u16(ends[e]);
    w.u16(0); // instructionLength
    // flags + delta arrays
    var flags = [], xs = [], ys = [], px = 0, py = 0;
    for (var ai = 0; ai < all.length; ai++) {
      var P = all[ai], dx = P.x - px, dy = P.y - py; px = P.x; py = P.y;
      var f = P.on ? 1 : 0;
      if (dx === 0) f |= 0x10; else if (dx >= -255 && dx <= 255) { f |= 0x02; if (dx > 0) f |= 0x10; xs.push(Math.abs(dx)); } else { xs.push(dx); }
      if (dy === 0) f |= 0x20; else if (dy >= -255 && dy <= 255) { f |= 0x04; if (dy > 0) f |= 0x20; ys.push(Math.abs(dy)); } else { ys.push(dy); }
      flags.push(f);
    }
    for (var fi = 0; fi < flags.length; fi++) w.u8(flags[fi]);
    var xqi = 0; for (var fx = 0; fx < flags.length; fx++) { var ff = flags[fx]; if (ff & 0x02) w.u8(xs[xqi++]); else if (!(ff & 0x10)) { w.i16(xs[xqi++]); } }
    var yqi = 0; for (var fy = 0; fy < flags.length; fy++) { var fg = flags[fy]; if (fg & 0x04) w.u8(ys[yqi++]); else if (!(fg & 0x20)) { w.i16(ys[yqi++]); } }
    while (w.b.length % 2) w.b.push(0);
    glyfParts.push(w.b); loca.push(loca[loca.length - 1] + w.b.length);
  }
  var glyf = []; for (var g = 0; g < glyfParts.length; g++) glyf = glyf.concat(glyfParts[g]);
  if (gXMin > gXMax) { gXMin = gYMin = gXMax = gYMax = 0; }
  return { glyf: glyf, loca: loca, maxPts: maxPts, maxCtrs: maxCtrs, bounds: { xMin: gXMin, yMin: gYMin, xMax: gXMax, yMax: gYMax }, perGlyph: perGlyphBounds, perGlyphPoints: perGlyphPoints };
}

function table(tag, bytes) { return { tag: tag, data: bytes }; }

function buildGlyfFont(project, metadata, masterId) {
  metadata = metadata || {};
  var upm = project.unitsPerEm || 1000;
  masterId = masterId || (metadata.masterId) || (project.masters && project.masters[0] && project.masters[0].id);
  var tol = 1.0;

  // glyph list: .notdef first, then project glyphs (skip non-unicode for cmap)
  var list = [{ name: '.notdef', unicode: 0, adv: Math.round(upm * 0.5), contours: [] }];
  for (var i = 0; i < project.glyphs.length; i++) {
    var g = project.glyphs[i], layer = g.layers && g.layers[masterId];
    // preWound (union-baked placeholder): emit verbatim — its counters are stroke-enclosed
    // and normalizeWinding's depth heuristic would fill them solid. See shared/placeholder.js.
    var ctrs = (layer && layer.contours) ? (layer.preWound ? layer.contours : normalizeWinding(layer.contours)) : [];
    var tt = ctrs.map(function (c) { return contourToTT(c, tol); }).filter(function (a) { return a.length > 0; });
    list.push({ name: g.name || ('uni' + (g.unicode || 0).toString(16)), unicode: g.unicode || 0, adv: Math.round(g.advanceWidth != null ? g.advanceWidth : upm * 0.6), contours: tt });
  }

  var built = buildGlyf(list);
  var numGlyphs = list.length;

  // ---- variable font (synthetic width/height axes): fvar + gvar + STAT ----
  // metadata.variable = { axes: [{ tag, min, def, max, name, dim:'x'|'y' }] }. Each
  // axis scales the default (Regular) outlines linearly along one dim; gvar deltas =
  // (factor-1)*coord, so interpolation is exact. Advance scales via the gvar phantom.
  var vAxes = null, fvarBytes = null, gvarBytes = null, statBytes = null;
  if (metadata.variable && metadata.variable.axes && metadata.variable.axes.length) {
    vAxes = metadata.variable.axes.map(function (a, i) { return { tag: a.tag, min: a.min, def: a.def, max: a.max, name: a.name, dim: a.dim, nameID: 256 + i }; });
    var vAxisCount = vAxes.length, vTuples = [];
    for (var vai = 0; vai < vAxes.length; vai++) {
      var vA = vAxes[vai];
      if (vA.max > vA.def) vTuples.push({ peak: peakVec(vAxisCount, vai, 1), dim: vA.dim, factor: vA.max / vA.def });
      if (vA.min < vA.def) vTuples.push({ peak: peakVec(vAxisCount, vai, -1), dim: vA.dim, factor: vA.min / vA.def });
    }
    if (vTuples.length) {
      var vAdv = []; for (var va = 0; va < list.length; va++) vAdv.push(list[va].adv);
      fvarBytes = buildFvar(vAxes);
      gvarBytes = buildGvar(built.perGlyphPoints, vAdv, vAxisCount, vTuples);
      statBytes = buildSTAT(vAxes, 2);
    } else vAxes = null;
  }

  // ---- cmap (format 4, BMP) ----
  var cmapEntries = []; for (var ci = 0; ci < list.length; ci++) if (list[ci].unicode > 0 && list[ci].unicode <= 0xFFFF) cmapEntries.push({ cp: list[ci].unicode, gid: ci });
  cmapEntries.sort(function (a, b) { return a.cp - b.cp; });
  var segs = [];
  for (var ce = 0; ce < cmapEntries.length;) {
    var startCp = cmapEntries[ce].cp, startGid = cmapEntries[ce].gid, prevCp = startCp, prevGid = startGid, j2 = ce + 1;
    while (j2 < cmapEntries.length && cmapEntries[j2].cp === prevCp + 1 && cmapEntries[j2].gid === prevGid + 1) { prevCp = cmapEntries[j2].cp; prevGid = cmapEntries[j2].gid; j2++; }
    segs.push({ start: startCp, end: prevCp, startGid: startGid }); ce = j2;
  }
  segs.push({ start: 0xffff, end: 0xffff, startGid: 0, terminator: true });
  var segCount = segs.length, sc2 = segCount * 2;
  var searchRange = 2 * Math.pow(2, Math.floor(Math.log(segCount) / Math.LN2)); var entrySelector = Math.floor(Math.log(searchRange / 2) / Math.LN2); var rangeShift = sc2 - searchRange;
  var sub = new Writer();
  sub.u16(4).u16(0).u16(0); // format,length(fill),language
  sub.u16(sc2).u16(searchRange).u16(entrySelector).u16(rangeShift);
  for (var s1 = 0; s1 < segs.length; s1++) sub.u16(segs[s1].end);
  sub.u16(0); // reservedPad
  for (var s2 = 0; s2 < segs.length; s2++) sub.u16(segs[s2].start);
  for (var s3 = 0; s3 < segs.length; s3++) { if (segs[s3].terminator) sub.i16(1); else sub.i16((segs[s3].startGid - segs[s3].start) & 0xffff); } // idDelta
  for (var s4 = 0; s4 < segs.length; s4++) sub.u16(0); // idRangeOffset
  // patch subtable length
  sub.b[2] = (sub.b.length >> 8) & 0xff; sub.b[3] = sub.b.length & 0xff;
  var cmap = new Writer();
  cmap.u16(0).u16(1); // version, numTables
  cmap.u16(3).u16(1).u32(12); // platform 3, enc 1, offset
  cmap.bytes(sub.b);
  var cmapBytes = cmap.b;

  // ---- head ----
  // style flags shared by head.macStyle and OS/2.fsSelection (Bold masters previously
  // shipped as weight 400 + REGULAR, so apps couldn't tell the styles apart)
  var styleItalic = /italic|oblique/i.test(metadata.styleName || '');
  var styleBold = (metadata.weightClass || 400) >= 600 || /bold/i.test(metadata.styleName || '');
  var head = new Writer();
  head.u32(0x00010000).u32(0x00010000).u32(0); // version, fontRevision, checkSumAdjustment(later)
  head.u32(0x5F0F3CF5).u16(0x000B).u16(upm);
  head.u32(0).u32(0).u32(0).u32(0); // created (8), modified (8)
  head.i16(built.bounds.xMin).i16(built.bounds.yMin).i16(built.bounds.xMax).i16(built.bounds.yMax);
  head.u16((styleBold ? 0x0001 : 0) | (styleItalic ? 0x0002 : 0)); // macStyle: bit0 bold, bit1 italic
  head.u16(8); // lowestRecPPEM
  head.i16(2).i16(1).i16(0); // fontDirectionHint, indexToLocFormat=1(long), glyphDataFormat
  var headBytes = head.b;

  // ---- hhea + hmtx ----
  var asc = project.metrics ? project.metrics.ascender : Math.round(upm * 0.8);
  var desc = project.metrics ? project.metrics.descender : -Math.round(upm * 0.2);
  var advMax = 0, minLsb = 32767, minRsb = 32767, xMaxExtent = -32768;
  for (var hi = 0; hi < list.length; hi++) { if (list[hi].adv > advMax) advMax = list[hi].adv; var bb = built.perGlyph[hi]; var lsb = bb.xMin; if (lsb < minLsb) minLsb = lsb; var rsb = list[hi].adv - bb.xMax; if (rsb < minRsb) minRsb = rsb; if (bb.xMax > xMaxExtent) xMaxExtent = bb.xMax; }
  var hhea = new Writer();
  hhea.u32(0x00010000).i16(asc).i16(desc).i16(Math.round(upm * 0.09)); // ascender, descender, lineGap
  hhea.u16(advMax).i16(minLsb === 32767 ? 0 : minLsb).i16(minRsb === 32767 ? 0 : minRsb).i16(xMaxExtent < -32767 ? 0 : xMaxExtent);
  hhea.i16(1).i16(0).i16(0); // caretSlopeRise, caretSlopeRun, caretOffset
  hhea.i16(0).i16(0).i16(0).i16(0); // reserved * 4
  hhea.i16(0).u16(numGlyphs); // metricDataFormat, numberOfHMetrics
  var hheaBytes = hhea.b;
  var hmtx = new Writer(); for (var mi = 0; mi < list.length; mi++) hmtx.u16(list[mi].adv).i16(built.perGlyph[mi].xMin);
  var hmtxBytes = hmtx.b;

  // ---- maxp v1.0 ----
  var maxp = new Writer();
  maxp.u32(0x00010000).u16(numGlyphs).u16(built.maxPts).u16(built.maxCtrs).u16(0).u16(0); // maxPoints, maxContours, maxComposite*
  // maxZones, maxTwilightPoints, maxStorage, maxFunctionDefs, maxInstructionDefs,
  // maxStackElements, maxSizeOfInstructions, maxComponentElements, maxComponentDepth (9)
  maxp.u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  var maxpBytes = maxp.b;

  // ---- OS/2 v4 (96 bytes incl. sFamilyClass) ----
  var firstCp = cmapEntries.length ? cmapEntries[0].cp : 0, lastCp = cmapEntries.length ? cmapEntries[cmapEntries.length - 1].cp : 0;
  var os2 = new Writer();
  os2.u16(4); // version
  os2.i16(Math.round(advMax * 0.5)); // xAvgCharWidth (approx)
  os2.u16(metadata.weightClass || 400).u16(5); // usWeightClass, usWidthClass(medium)
  os2.u16(0); // fsType
  os2.i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.075)).i16(Math.round(upm * 0.7)).i16(Math.round(upm * 0.075)); // subscript X/Y size/offset
  os2.i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.075)).i16(Math.round(upm * 0.7)).i16(Math.round(upm * 0.48)); // superscript
  os2.i16(Math.round(upm * 0.05)).i16(Math.round(upm * 0.26)); // strikeout size, position
  os2.i16(0); // sFamilyClass (the field the reviewer caught)
  os2.bytes([2, 0, 6, 3, 0, 0, 0, 0, 0, 0]); // panose (10)
  os2.u32(0).u32(0).u32(0).u32(0); // ulUnicodeRange1-4
  os2.tag('RNTP'); // achVendID
  os2.u16(((styleItalic ? 0x01 : 0) | (styleBold ? 0x20 : 0)) || 0x40); // fsSelection: ITALIC|BOLD, else REGULAR
  os2.u16(firstCp).u16(lastCp);
  os2.i16(asc).i16(desc).i16(Math.round(upm * 0.09)); // sTypoAscender/Descender/LineGap
  os2.u16(asc).u16(Math.abs(desc)); // usWinAscent/Descent
  os2.u32(1).u32(0); // ulCodePageRange1-2 (Latin1)
  os2.i16(Math.round(project.metrics ? project.metrics.xHeight : upm * 0.5)).i16(Math.round(project.metrics ? project.metrics.capHeight : upm * 0.7)); // sxHeight, sCapHeight
  os2.u16(0).u16(0).u16(400); // usDefaultChar, usBreakChar, usMaxContext
  var os2Bytes = os2.b;

  // ---- post v3 ----
  var post = new Writer();
  post.u32(0x00030000).u32(0).i16(0).i16(0).u16(0).u16(0).u32(0).u32(0).u32(0).u32(0);
  var postBytes = post.b;

  // ---- name ----
  var fam = metadata.familyName || 'Untitled', sty = metadata.styleName || 'Regular';
  var full = sty.toLowerCase() === 'regular' ? fam : fam + ' ' + sty;
  var ps = (fam + '-' + sty).replace(/[^A-Za-z0-9]+/g, '');
  var ver = 'Version ' + (metadata.version || '1.000');
  var records = [[1, fam], [2, sty], [3, ver + ';' + ps], [4, full], [6, ps]];
  if (metadata.designer) records.push([9, metadata.designer]);
  if (metadata.copyright) records.push([0, metadata.copyright]);
  if (metadata.license) records.push([13, metadata.license]);
  if (metadata.manufacturer) records.push([8, metadata.manufacturer]);
  // signature-panel parity with the OTF path (applyNames writes these on OTF)
  if (metadata.trademark) records.push([7, metadata.trademark]);
  if (metadata.description) records.push([10, metadata.description]);
  if (metadata.vendorURL) records.push([11, metadata.vendorURL]);
  if (metadata.designerURL) records.push([12, metadata.designerURL]);
  if (metadata.licenseURL) records.push([14, metadata.licenseURL]);
  records.push([16, fam]); records.push([17, sty]);   // preferredFamily/Subfamily
  if (metadata.sampleText) records.push([19, metadata.sampleText]);
  if (vAxes) for (var vni = 0; vni < vAxes.length; vni++) records.push([vAxes[vni].nameID, vAxes[vni].name]); // axis names for fvar/STAT
  records.sort(function (a, b) { return a[0] - b[0]; });
  var nameHdr = new Writer(); nameHdr.u16(0).u16(records.length).u16(6 + 12 * records.length);
  var storage = [], off = 0, recs = new Writer();
  for (var ri = 0; ri < records.length; ri++) { var bytes = strUTF16BE(String(records[ri][1])); recs.u16(3).u16(1).u16(0x0409).u16(records[ri][0]).u16(bytes.length).u16(off); storage = storage.concat(bytes); off += bytes.length; }
  var nameBytes = nameHdr.b.concat(recs.b).concat(storage);

  // ---- gasp (unhinted: gridfit+grayscale at all sizes) ----
  var gasp = new Writer(); gasp.u16(0).u16(1).u16(0xFFFF).u16(0x000F);
  var gaspBytes = gasp.b;

  // ---- loca (long) ----
  var locaW = new Writer(); for (var li = 0; li < built.loca.length; li++) locaW.u32(built.loca[li]);
  var locaBytes = locaW.b;

  // ---- assemble sfnt ----
  var tables = [
    table('OS/2', os2Bytes), table('cmap', cmapBytes), table('gasp', gaspBytes),
    table('glyf', built.glyf), table('head', headBytes), table('hhea', hheaBytes),
    table('hmtx', hmtxBytes), table('loca', locaBytes), table('maxp', maxpBytes),
    table('name', nameBytes), table('post', postBytes),
  ];
  if (vAxes) { tables.push(table('fvar', fvarBytes)); tables.push(table('gvar', gvarBytes)); tables.push(table('STAT', statBytes)); }
  tables.sort(function (a, b) { return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0; });

  function checksum(bytes) { var sum = 0; for (var i = 0; i < bytes.length; i += 4) { var v = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0); sum = (sum + (v >>> 0)) >>> 0; } return sum >>> 0; }

  var numTables = tables.length;
  var sr = Math.pow(2, Math.floor(Math.log(numTables) / Math.LN2)) * 16, es = Math.floor(Math.log(sr / 16) / Math.LN2), rs = numTables * 16 - sr;
  var head2 = new Writer(); head2.u32(0x00010000).u16(numTables).u16(sr).u16(es).u16(rs);
  var dirLen = 12 + numTables * 16;
  var offset = dirLen, records2 = new Writer(), headTableOffset = -1;
  // table data region (each padded to 4)
  var dataRegion = [], padded = [];
  for (var t = 0; t < tables.length; t++) {
    var tb = tables[t].data.slice(); var realLen = tb.length; while (tb.length % 4) tb.push(0);
    records2.tag(tables[t].tag).u32(checksum(tb)).u32(offset).u32(realLen);
    if (tables[t].tag === 'head') headTableOffset = offset;
    padded.push(tb); offset += tb.length;
  }
  var all2 = head2.b.concat(records2.b);
  for (var pp = 0; pp < padded.length; pp++) all2 = all2.concat(padded[pp]);
  // checkSumAdjustment
  var total = checksum(all2);
  var adj = (0xB1B0AFBA - total) >>> 0;
  var hoff = headTableOffset + 8; // checkSumAdjustment field within head
  all2[hoff] = (adj >>> 24) & 0xff; all2[hoff + 1] = (adj >>> 16) & 0xff; all2[hoff + 2] = (adj >>> 8) & 0xff; all2[hoff + 3] = adj & 0xff;

  var buf = new ArrayBuffer(all2.length), dv = new Uint8Array(buf);
  for (var z = 0; z < all2.length; z++) dv[z] = all2[z];
  return buf;
}

module.exports = { buildGlyfFont, cubicToQuads, normalizeWinding };
