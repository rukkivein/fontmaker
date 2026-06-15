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

// fracTable: {ch:{lsb,rsb}} as a fraction of the em. percent: 0..N (100 = the X
// value as-is). Returns {ch:{lsb,rsb}} in FONT UNITS for this upm at that percent.
function spacingTargets(fracTable, upm, percent) {
  var k = (upm || 1000) * (percent == null ? 100 : percent) / 100, out = {};
  Object.keys(fracTable).forEach(function (ch) {
    out[ch] = { lsb: Math.round(fracTable[ch].lsb * k), rsb: Math.round(fracTable[ch].rsb * k) };
  });
  return out;
}

// Re-space every drawn glyph that has a target: keep its ink and shape exactly, set
// the side bearings to the target (X×percent), recompute the advance. Absolute (not
// cumulative) — applying twice with the same targets is a no-op — and independent of
// the glyph's previous spacing. Returns the number of glyphs touched.
function applyRefSpacing(project, mid, targets, minAdvance) {
  var n = 0, minA = minAdvance || 1;
  project.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'composed') return;   // leave multi-char specials
    var ch = g.char; if (ch == null) return;
    var t = targets[ch]; if (!t) return;
    var l = g.layers && g.layers[mid];
    if (!l || !l.contours || !l.contours.length) return;
    var b = bezBounds(l.contours); if (!isFinite(b.xMin)) return;
    translateX(l.contours, t.lsb - b.xMin);            // ink-left → target LSB (absolute)
    g.advanceWidth = Math.max(minA, Math.round(t.lsb + b.w + t.rsb));
    n++;
  });
  return n;
}

module.exports = { spacingTargets, applyRefSpacing, translateX, bezBounds };
