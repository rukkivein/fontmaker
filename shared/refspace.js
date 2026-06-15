'use strict';
// Reference spacing ("X value"): derive each letter's side bearings from CLASSIC
// fonts — Arial + Times New Roman — and let ONE percentage dial exaggerate or
// reduce them. The reference is an em-fraction table {ch:{lsb,rsb}} (the average of
// the two classics, as a fraction of the em), built in the host (main.js, via
// opentype on the system font files). This module is the pure, node-testable math:
// scale the fractions to the project's UPM at a given percent, then re-space every
// drawn glyph to exactly that.
//
// Crucially it NEVER reads the user font's own spacing — the applied side bearings
// are always X×percent, so the result can't collapse back to the original font's
// values (the behaviour the user asked for: "never return to the font's value").
// 100% = the Arial+Times consensus; >100% opens it up; <100% tightens it. It only
// moves glyphs horizontally and sets advance widths — it never resizes a glyph.

// Self-contained (no requires) so it loads identically under Node, real CEP, and
// the browser preview stub. bbox over on-curve points AND non-null handles (handles
// can exceed the extrema) — same definition as optimizer.bezBounds.
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
  contours.forEach(function (c) {
    c.points.forEach(function (p) {
      p.x += dx;
      if (p.handleIn) p.handleIn.x += dx;
      if (p.handleOut) p.handleOut.x += dx;
    });
  });
}

// Flatten one contour (cubic segments sampled) to a polygon [[x,y],…] so we can
// measure where the ink mass actually sits.
function flattenContour(c) {
  var pts = c.points, m = pts.length, out = [];
  if (m < 2) return out;
  var n = c.closed ? m : m - 1;
  for (var i = 0; i < n; i++) {
    var a = pts[i], b = pts[(i + 1) % m];
    out.push([a.x, a.y]);
    var c1 = a.handleOut, c2 = b.handleIn;
    if (c1 || c2) {
      var p1 = c1 || a, p2 = c2 || b;
      for (var s = 1; s < 8; s++) {
        var t = s / 8, u = 1 - t;
        out.push([
          u * u * u * a.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * b.x,
          u * u * u * a.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * b.y,
        ]);
      }
    }
  }
  return out;
}
// X of the FILLED area's centroid (holes subtract via opposite winding). This is
// the "ink density" anchor: for a glyph like C (heavy left arc, open right) it lands
// left of the bounding-box centre. null if there's no area.
function areaCentroidX(contours) {
  var A = 0, Cx = 0;
  for (var i = 0; i < contours.length; i++) {
    var poly = flattenContour(contours[i]), m = poly.length; if (m < 3) continue;
    var a = 0, cx = 0;
    for (var j = 0; j < m; j++) {
      var p = poly[j], q = poly[(j + 1) % m];
      var cross = p[0] * q[1] - q[0] * p[1];
      a += cross; cx += (p[0] + q[0]) * cross;
    }
    a *= 0.5; if (a === 0) continue;
    cx /= (6 * a);
    A += a; Cx += cx * a;
  }
  return A === 0 ? null : Cx / A;
}

// fracTable: {ch:{lsb,rsb}} as a fraction of the em. percent: 0..N (100 = the X
// value as-is). Returns {ch:{lsb,rsb}} in FONT UNITS for this upm at that percent.
function spacingTargets(fracTable, upm, percent) {
  var k = (upm || 1000) * (percent == null ? 100 : percent) / 100, out = {};
  Object.keys(fracTable).forEach(function (ch) {
    out[ch] = { lsb: Math.round(fracTable[ch].lsb * k), rsb: Math.round(fracTable[ch].rsb * k) };
  });
  return out;
}

// Re-space every drawn glyph that has a target. Two STACKED corrections, both
// horizontal-only and never resizing:
//   STANDARD  — side bearings = the target (X×percent); advance = lsb+inkW+rsb.
//   OPTICAL   — nudge the ink toward its density (areaCentroidX) by opticalAmount,
//               but ONLY within the bearings the standard pass set, and WITHOUT
//               changing the advance box (so the red/blue lines stay put; the glyph
//               just shifts inside its slot).
// Absolute (not cumulative): applying again with the same args is a no-op, and the
// result never depends on the glyph's previous spacing. Returns glyphs touched.
function applyRefSpacing(project, mid, targets, minAdvance, opticalAmount) {
  var n = 0, minA = minAdvance || 1, opt = opticalAmount || 0;
  project.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'composed') return;   // leave multi-char specials
    var ch = g.char; if (ch == null) return;
    var t = targets[ch]; if (!t) return;
    var l = g.layers && g.layers[mid];
    if (!l || !l.contours || !l.contours.length) return;
    var b = bezBounds(l.contours); if (!isFinite(b.xMin)) return;
    var lsb = t.lsb, rsb = t.rsb;
    var advance = Math.round(lsb + b.w + rsb);         // STANDARD box — optical never changes this
    var dx = 0;
    if (opt) {
      var cx = areaCentroidX(l.contours);
      if (cx != null) {
        dx = opt * (cx - (b.xMin + b.xMax) / 2);       // toward the dense side (C leans left → dx<0)
        if (dx < -lsb) dx = -lsb;                      // stay within the X-set bearings (ink in box)
        if (dx > rsb) dx = rsb;
      }
    }
    translateX(l.contours, (lsb + dx) - b.xMin);       // ink-left = LSB + optical nudge
    g.advanceWidth = Math.max(minA, advance);          // advance independent of dx → box stays put
    n++;
  });
  return n;
}

module.exports = { spacingTargets, applyRefSpacing, translateX, bezBounds, areaCentroidX };
