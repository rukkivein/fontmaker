'use strict';
// RuneType's little built-in optimizer — a pure, offline rule+stats engine (no
// network) that reasons about glyph CLASS to set spacing/advance, tracking and
// optical kerning, and to normalize the font for consistency. Operates on the
// project model in place (font units, y-up; handleIn/Out are absolute control
// points, matching core/fontEngine.js).

function layerOf(g, mid) { return g.layers && g.layers[mid]; }
function drawn(g, mid) { var l = layerOf(g, mid); return !!(l && l.contours && l.contours.length); }

// bbox over on-curve points AND non-null handles (handles can exceed extrema)
function bezBounds(contours) {
  var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (var i = 0; i < contours.length; i++) {
    var pts = contours[i].points;
    for (var j = 0; j < pts.length; j++) {
      var p = pts[j], cand = [[p.x, p.y]];
      if (p.handleIn) cand.push([p.handleIn.x, p.handleIn.y]);
      if (p.handleOut) cand.push([p.handleOut.x, p.handleOut.y]);
      for (var k = 0; k < cand.length; k++) {
        var x = cand[k][0], y = cand[k][1];
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
    }
  }
  return { xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax, w: xMax - xMin, h: yMax - yMin };
}
function translateX(contours, dx) {
  if (!dx) return;
  contours.forEach(function (c) { c.points.forEach(function (p) { p.x += dx; if (p.handleIn) p.handleIn.x += dx; if (p.handleOut) p.handleOut.x += dx; }); });
}
function median(a) { a = a.filter(function (v) { return v != null && isFinite(v); }).sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : null; }

// Reference metrics derived from the drawn glyphs (with sane fallbacks).
function buildRef(project, mid) {
  var upm = project.unitsPerEm || 1000;
  function geo(g) { return drawn(g, mid) ? bezBounds(layerOf(g, mid).contours) : null; }
  function yMaxOf(ch) { var g = project.glyphs.find(function (x) { return x.char === ch; }); var b = g && geo(g); return b ? b.yMax : null; }
  var cap = median('ABDEFHKLMNPRT'.split('').map(yMaxOf)) || (project.metrics ? project.metrics.capHeight : Math.round(0.716 * upm));
  var xh = median('acemnorsuvwxz'.split('').map(yMaxOf)) || (project.metrics ? project.metrics.xHeight : Math.round(0.5 * upm));
  // dominant stem ≈ narrowest drawn-glyph ink width among I/l/i (fallback 8% em)
  var stems = ['I', 'l', 'i', 'H', 'T'].map(function (ch) { var g = project.glyphs.find(function (x) { return x.char === ch; }); var b = g && geo(g); return b && b.w > 0 ? b.w : null; }).filter(Boolean);
  var stem = stems.length ? Math.min.apply(null, stems) : Math.round(0.08 * upm);
  if (stem > 0.18 * upm) stem = Math.round(0.09 * upm); // a wide 'I' isn't a stem
  return { upm: upm, capHeight: cap, xHeight: xh, stem: stem, SB_base: Math.round(1.05 * stem) };
}

var ROUND = 'oOcCeGQSUu0', NARROW = 'IiljJ1!|', WIDE = 'WMm', DIAG = 'AVWXYKvwxyk';
function classify(g, geo, ref) {
  var u = g.unicode || 0, ch = g.char || '';
  var cls = 'DEFAULT';
  if (u >= 0x41 && u <= 0x5A) cls = 'UPPER';
  else if (u >= 0x61 && u <= 0x7A) cls = geo.yMax >= ref.xHeight + 0.12 * ref.upm ? 'ASCENDER' : (geo.yMin <= -0.04 * ref.upm ? 'DESCENDER' : 'LOWERCASE');
  else if (u >= 0x30 && u <= 0x39) cls = 'FIGURE';
  if ('.,:;\'"!?'.indexOf(ch) >= 0) cls = 'PUNCT_CENTERED';
  if (geo.w < 0.18 * ref.upm && geo.h > 0.5 * ref.upm) cls = 'NARROW';
  if (geo.w > 0.72 * ref.upm) cls = 'WIDE';
  var round = ROUND.indexOf(ch) >= 0, diag = DIAG.indexOf(ch) >= 0;
  return { cls: cls, roundL: round, roundR: round, diagL: diag, diagR: diag };
}
function sbTargets(c, geo, ref) {
  var SB = ref.SB_base;
  var K = { UPPER: 1.0, LOWERCASE: 0.92, ASCENDER: 0.92, DESCENDER: 0.92, NARROW: 1.5, WIDE: 0.5, FIGURE: 0.95, DEFAULT: 1.0, PUNCT_CENTERED: 0 };
  if (c.cls === 'PUNCT_CENTERED') {
    var adv = Math.round(0.3 * ref.upm), lsb = Math.round((adv - geo.w) / 2);
    return { lsb: lsb, rsb: adv - geo.w - lsb };
  }
  var kL = K[c.cls] != null ? K[c.cls] : 1, kR = kL;
  if (c.roundL) kL = 0.62; if (c.diagL) kL = 0.55;
  if (c.roundR) kR = 0.62; if (c.diagR) kR = 0.55;
  return { lsb: Math.round(SB * kL), rsb: Math.round(SB * kR) };
}

// === public: optimize SPACING (sidebearings + advance) for one or all glyphs.
function optimizeSpacing(project, mid, onlyIndex) {
  var ref = buildRef(project, mid), n = 0;
  project.glyphs.forEach(function (g, i) {
    if (onlyIndex != null && i !== onlyIndex) return;
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return; // leave specials
    if (!drawn(g, mid)) return;
    var b = bezBounds(layerOf(g, mid).contours);
    if (!isFinite(b.xMin)) return;
    var c = classify(g, b, ref), t = sbTargets(c, b, ref);
    translateX(layerOf(g, mid).contours, Math.round(t.lsb - b.xMin));
    g.advanceWidth = Math.round(t.lsb + b.w + t.rsb);
    n++;
  });
  return { count: n, ref: ref };
}

// === optical pair kerning from outline side-profiles (returns a kern table).
function flatten(contours) {
  var segs = [];
  contours.forEach(function (c) {
    var p = c.points, m = p.length; if (m < 2) return;
    var cnt = c.closed ? m : m - 1;
    for (var i = 0; i < cnt; i++) {
      var a = p[i], b = p[(i + 1) % m];
      var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasO || hasI) {
        var c1 = a.handleOut || a, c2 = b.handleIn || b, px = a.x, py = a.y;
        for (var s = 1; s <= 8; s++) { var t = s / 8, u = 1 - t; var x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x; var y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y; segs.push([px, py, x, y]); px = x; py = y; }
      } else segs.push([a.x, a.y, b.x, b.y]);
    }
  });
  return segs;
}
function profileAt(segs, y, side) {
  var v = side === 'L' ? Infinity : -Infinity, hit = false;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i], y1 = s[1], y2 = s[3];
    if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
      var x = (y2 === y1) ? s[0] : s[0] + (s[2] - s[0]) * (y - y1) / (y2 - y1);
      hit = true; if (side === 'L') { if (x < v) v = x; } else if (x > v) v = x;
    }
  }
  return hit ? v : null;
}
function optimizeKerning(project, mid) {
  var ref = buildRef(project, mid);
  var filled = project.glyphs.filter(function (g) { return drawn(g, mid) && g.char && (g.unicode >= 0x21); });
  // typical air = median (LSB + RSB) of the filled glyphs
  var sides = filled.map(function (g) { var b = bezBounds(layerOf(g, mid).contours); return { l: Math.max(0, b.minX), r: Math.max(0, g.advanceWidth - b.maxX) }; });
  var target = (median(sides.map(function (s) { return s.l; })) || 0) + (median(sides.map(function (s) { return s.r; })) || 0);
  target = Math.max(0.06 * ref.upm, Math.min(0.14 * ref.upm, target || 0.085 * ref.upm));
  var flats = {}; filled.forEach(function (g) { flats[g.name] = flatten(layerOf(g, mid).contours); });
  var table = {}, pairs = 0;
  for (var a = 0; a < filled.length; a++) {
    for (var b = 0; b < filled.length; b++) {
      var gL = filled[a], gR = filled[b], minGap = Infinity;
      for (var s = 0; s <= 22; s++) {
        var y = 5 + (ref.capHeight - 10) * s / 22;
        var pl = profileAt(flats[gL.name], y, 'R'), pr = profileAt(flats[gR.name], y, 'L');
        if (pl == null || pr == null) continue;
        var gap = (gL.advanceWidth - pl) + pr;
        if (gap < minGap) minGap = gap;
      }
      if (minGap < Infinity) {
        var v = Math.round(Math.max(-0.12 * ref.upm, Math.min(0.06 * ref.upm, target - minGap)));
        if (Math.abs(v) >= 12) { table[gL.name + ',' + gR.name] = v; pairs++; }
      }
    }
  }
  return { table: table, pairs: pairs };
}

// === one pass: spacing + kerning. tracking is applied separately (live).
function optimizeAll(project, mid) {
  var sp = optimizeSpacing(project, mid);
  var kn = optimizeKerning(project, mid);
  project.kerning = kn.table;
  return { spaced: sp.count, kernPairs: kn.pairs, ref: sp.ref };
}

module.exports = { buildRef, classify, sbTargets, optimizeSpacing, optimizeKerning, optimizeAll, bezBounds };
