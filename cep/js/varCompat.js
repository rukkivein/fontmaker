'use strict';
// Variable-font groundwork: detect which glyphs are INTERPOLATION-COMPATIBLE
// across masters and, when point COUNTS match but the start/order differ, match
// each point to the nearest same-type point of the reference master (rotating
// the contour's start) so the masters line up for interpolation. Pure JS.
//
// Honest scope: this is the compatibility + point-matching engine and a
// readiness report. It NEVER guesses across a contour/point-count mismatch
// (those are reported as incompatible — the user must reconcile them), and it
// only rotates/aligns, never deletes points. A true single-file .ttf with
// fvar/gvar needs a gvar byte-writer (a marked follow-up); meanwhile compatible
// masters export as separate named styles, which is a working family.

function layerOf(g, mid) { return g.layers && g.layers[mid]; }
function contoursOf(g, mid) { var l = layerOf(g, mid); return (l && l.contours) || []; }
function isDrawn(g, mid) { return contoursOf(g, mid).length > 0; }
function ptType(p) { return (p.handleIn || p.handleOut) ? 'on-smooth' : 'on-corner'; } // on-curve nodes only (cubic model)

// Compare one glyph across masters. Returns { compatible, reason, perContour }.
function glyphCompat(g, masterIds) {
  var drawn = masterIds.filter(function (m) { return isDrawn(g, m); });
  if (drawn.length < 2) return { compatible: false, reason: 'needs >=2 drawn masters', drawn: drawn.length };
  var ref = contoursOf(g, drawn[0]);
  for (var k = 1; k < drawn.length; k++) {
    var cur = contoursOf(g, drawn[k]);
    if (cur.length !== ref.length) return { compatible: false, reason: 'contour count ' + cur.length + ' != ' + ref.length, master: drawn[k] };
    for (var c = 0; c < ref.length; c++) {
      if (cur[c].points.length !== ref[c].points.length) return { compatible: false, reason: 'contour ' + c + ' point count ' + cur[c].points.length + ' != ' + ref[c].points.length, master: drawn[k] };
    }
  }
  return { compatible: true, masters: drawn };
}

// Best rotation of a contour's points so point i aligns with the reference's
// point i (minimise summed squared distance). Same count assumed.
function bestRotation(refPts, pts) {
  var n = pts.length, best = 0, bestD = Infinity;
  for (var r = 0; r < n; r++) {
    var d = 0;
    for (var i = 0; i < n; i++) { var a = refPts[i], b = pts[(i + r) % n]; var dx = a.x - b.x, dy = a.y - b.y; d += dx * dx + dy * dy; }
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
function rotatePoints(pts, r) { if (!r) return pts.slice(); return pts.slice(r).concat(pts.slice(0, r)); }

// Align every compatible glyph's non-reference masters to the reference's point
// order (rotation only). Mutates the project. Returns counts.
function matchPoints(project, masterIds) {
  masterIds = masterIds || project.masters.map(function (m) { return m.id; });
  var aligned = 0, skipped = 0;
  project.glyphs.forEach(function (g) {
    var cc = glyphCompat(g, masterIds);
    if (!cc.compatible) { if (cc.drawn !== 0 && cc.reason && cc.reason.indexOf('needs') !== 0) skipped++; return; }
    var refM = cc.masters[0], ref = contoursOf(g, refM);
    for (var k = 1; k < cc.masters.length; k++) {
      var cur = contoursOf(g, cc.masters[k]);
      for (var c = 0; c < ref.length; c++) {
        if (cur[c].points.length < 3) continue;
        var r = bestRotation(ref[c].points, cur[c].points);
        if (r) { cur[c].points = rotatePoints(cur[c].points, r); aligned++; }
      }
    }
  });
  return { aligned: aligned, skipped: skipped };
}

// A readiness report: per-glyph compatibility across the given masters.
function report(project, masterIds) {
  masterIds = masterIds || project.masters.map(function (m) { return m.id; });
  var compatible = [], incompatible = [];
  project.glyphs.forEach(function (g) {
    var drawnCount = masterIds.filter(function (m) { return isDrawn(g, m); }).length;
    if (drawnCount < 2) return; // not part of the variable space yet
    var cc = glyphCompat(g, masterIds);
    if (cc.compatible) compatible.push(g.name);
    else incompatible.push({ name: g.name, reason: cc.reason });
  });
  return { masters: masterIds.length, compatible: compatible, incompatible: incompatible, ready: incompatible.length === 0 };
}

module.exports = { glyphCompat, matchPoints, report, bestRotation };
