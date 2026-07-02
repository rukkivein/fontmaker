'use strict';
/* Flatten a glyph's drawn contours into clean filled geometry, PRESERVING counters.
 *
 * Takes the paper.js scope as an argument so it can be unit-tested headlessly
 * (test/unite.test.js drives it with paper-jsdom). main.js calls it with getPaper().
 *
 * THE BUG THIS FIXES: the old pairwise "unite if outlines cross, else keep as a
 * compound child" was ORDER-DEPENDENT. When a counter was processed BEFORE a stroke
 * that crosses the outer (an R leg, a Q/R/P tail or junction), the counter got swept
 * into a unite() and FILLED SOLID on export — while O/B/D (no crossing stroke) came
 * out fine, which is exactly the pattern the user saw (O/Q ok-ish, R/P/mark broken).
 *
 * THE FIX: build a CONTAINMENT TREE (order-independent, winding-AGNOSTIC). Each
 * contour's depth = how many OTHER contours strictly enclose it (bigger area, contain
 * an interior point, and don't cross it — two crossing contours can't nest). Then lay
 * the levels down in order: unite the even depths (outer + nested islands), subtract
 * the odd depths (counters). Overlapping same-level strokes get a real non-zero union
 * (no spurious overlap holes); islands floating inside a counter survive.
 */

function contoursToPaper(P, contours) {
  var kids = [];
  contours.forEach(function (c) {
    if (!c.closed || c.points.length < 3) return;
    var segs = c.points.map(function (pt) {
      var hIn = pt.handleIn ? new P.Point(pt.handleIn.x - pt.x, pt.handleIn.y - pt.y) : null;
      var hOut = pt.handleOut ? new P.Point(pt.handleOut.x - pt.x, pt.handleOut.y - pt.y) : null;
      return new P.Segment(new P.Point(pt.x, pt.y), hIn, hOut);
    });
    kids.push(new P.Path({ segments: segs, closed: true, insert: false }));
  });
  return kids;
}

function paperToContours(item) {
  var paths = item.children && item.children.length ? item.children : [item];
  var out = [];
  paths.forEach(function (pp) {
    if (!pp.segments || pp.segments.length < 2) return;
    out.push({
      closed: true,
      points: pp.segments.map(function (sg) {
        return {
          x: Math.round(sg.point.x * 100) / 100, y: Math.round(sg.point.y * 100) / 100, type: 'corner',
          handleIn: sg.handleIn.isZero() ? null : { x: sg.point.x + sg.handleIn.x, y: sg.point.y + sg.handleIn.y },
          handleOut: sg.handleOut.isZero() ? null : { x: sg.point.x + sg.handleOut.x, y: sg.point.y + sg.handleOut.y },
        };
      }),
    });
  });
  return out;
}

function sliverFilter(c) {
  var a = 0, p = c.points;
  for (var i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a / 2) >= 2;
}
// Clean a glyph's contours for export while PRESERVING the user's intended fill — i.e. exactly
// how Illustrator renders them under NON-ZERO winding, which for real drawn glyphs already has
// every counter cut (verified: O/Q/R/g/B/D/8 all read ~25-42% fill = ring, not solid). The old
// nesting/containment analysis RE-DERIVED windings and mis-classified counters formed at the
// JUNCTION of overlapping strokes (B) as solid, FILLING them.
//
// THE BUG IT FIXES: a SELF-INTERSECTING or OVERLAPPING outline renders SOLID / wrong in some
// rasterizers — notably Windows GDI / Word — even though non-zero winding gives a hole.
// resolveCrossings on a FRESH whole-glyph CompoundPath re-traces the exact non-zero region into
// clean, non-overlapping, non-self-intersecting contours: every counter is preserved (it's part
// of the non-zero fill), overlaps/seams are removed (GDI-safe), and no winding is invented.
// Only glyphs that actually have a crossing are rebuilt, so clean glyphs aren't re-traced (a
// fresh path is required — resolveCrossings on a boolean-op result object is a no-op).
function uniteContours(P, contours) {
  if (!P || !contours || !contours.length) return contours;
  try {
    var kids = contoursToPaper(P, contours);
    var n = kids.length;
    if (n === 0) return contours;
    var hasCross = false;
    for (var i = 0; i < n && !hasCross; i++) {
      try { if (kids[i].getCrossings(kids[i]).length) hasCross = true; } catch (e) {}
      for (var j = i + 1; j < n && !hasCross; j++) {
        if (!kids[i].bounds.intersects(kids[j].bounds)) continue;   // cheap bbox reject
        try { if (kids[i].getCrossings(kids[j]).length) hasCross = true; } catch (e) {}
      }
    }
    if (!hasCross) return contours;   // no self/mutual crossing → already GDI-safe, leave untouched
    // resolveCrossings on a FRESH whole-glyph compound (non-zero fill = the user's intent),
    // dropping curve-area slivers; repeat until self-crossing-free (one pass can leave residual
    // crossings + zero-area fragments on tangled outlines). 3 passes clears every real glyph.
    var paths = kids;
    for (var pass = 0; pass < 3; pass++) {
      var cp = new P.CompoundPath({ children: paths.map(function (p) { return p.clone({ insert: false }); }), insert: false });
      var r = (cp.resolveCrossings && cp.resolveCrossings()) || cp;
      var ch = (r.children && r.children.length ? r.children : [r]).filter(function (p) { return p.segments && p.segments.length > 2 && Math.abs(p.area) >= 2; });
      if (!ch.length) break;
      var self = 0; for (var s = 0; s < ch.length; s++) { try { self += ch[s].getCrossings(ch[s]).length; } catch (e) {} }
      paths = ch.map(function (p) { return p.clone({ insert: false }); });
      if (self === 0) break;
    }
    var out = [];
    paths.forEach(function (pp) { out = out.concat(paperToContours(pp)); });
    out = out.filter(sliverFilter);
    return out.length ? out : contours;
  } catch (e) { return contours; }
}

module.exports = { contoursToPaper: contoursToPaper, paperToContours: paperToContours, uniteContours: uniteContours };
