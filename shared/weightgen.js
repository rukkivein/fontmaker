'use strict';
// Point-compatible WEIGHT + SLANT variants of a glyph's contours. Every output
// keeps the SAME number of contours, anchors, handles and ordering as the input —
// only the COORDINATES move — so Regular + Bold + Italic come out interpolation-
// compatible variable-font masters by construction (no point-matching, no risk of
// mismatched outlines). Pure geometry, font units (Y-up, baseline = 0); unit-
// tested in test/weightgen.test.js. Reused by the CEP panel via sync-cep.

function norm(x, y) { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; }

function shallow(c, points) {
  const o = {}; for (const k in c) o[k] = c[k]; o.points = points; return o;
}

// ITALIC — horizontal shear about the baseline (y = 0). Affine ⇒ trivially point-
// compatible. Y is font-up, so a higher point shifts further right. angleDeg ~8–14.
function shearContours(contours, angleDeg) {
  const s = Math.tan((angleDeg == null ? 12 : angleDeg) * Math.PI / 180);
  const sh = (p) => p ? { x: p.x + p.y * s, y: p.y } : null;
  return contours.map((c) => shallow(c, c.points.map((p) => ({
    x: p.x + p.y * s, y: p.y, type: p.type,
    handleIn: sh(p.handleIn), handleOut: sh(p.handleOut),
  }))));
}

// Signed area of a contour (shoelace, anchors only). >0 = CCW in font Y-up.
function signedArea(points) {
  let a = 0; const n = points.length;
  for (let i = 0; i < n; i++) { const p = points[i], q = points[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

// BOLD / LIGHT — move every point along its OUTWARD normal by `d` font units
// (negative = lighter). The winding sign (from signed area) makes outer contours
// grow outward and counters shrink, so strokes thicken uniformly. Handles ride
// their anchor's offset, keeping the curve shape; the point structure is identical
// to the input, so the result interpolates against it.
function emboldenContours(contours, d) {
  // ONE global orientation = sign of the largest-area contour (the outer). With
  // the right-hand normal this makes the outer grow outward and every counter
  // shrink (because counters wind opposite the outer) — independent of whether the
  // outline came out CW or CCW from tracing/seating.
  let maxA = 0;
  contours.forEach((c) => { const a = signedArea(c.points); if (Math.abs(a) > Math.abs(maxA)) maxA = a; });
  const sgn = maxA >= 0 ? 1 : -1;
  return contours.map((c) => {
    const pts = c.points, n = pts.length;
    if (n < 2) return c;
    const out = pts.map((p, i) => {
      const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      // tangent = bisector of incoming + outgoing directions (use handles if present)
      const o = norm(p.handleOut ? p.handleOut.x - p.x : next.x - p.x, p.handleOut ? p.handleOut.y - p.y : next.y - p.y);
      const ii = norm(p.handleIn ? p.x - p.handleIn.x : p.x - prev.x, p.handleIn ? p.y - p.handleIn.y : p.y - prev.y);
      const t = norm(o.x + ii.x, o.y + ii.y);
      const nx = t.y * sgn * d, ny = -t.x * sgn * d;   // outward normal × amount
      return {
        x: p.x + nx, y: p.y + ny, type: p.type,
        handleIn: p.handleIn ? { x: p.handleIn.x + nx, y: p.handleIn.y + ny } : null,
        handleOut: p.handleOut ? { x: p.handleOut.x + nx, y: p.handleOut.y + ny } : null,
      };
    });
    return shallow(c, out);
  });
}

// Horizontal ink span of a contour set (for re-deriving advance after embolden).
function inkSpan(contours) {
  let x0 = Infinity, x1 = -Infinity;
  contours.forEach((c) => c.points.forEach((p) => {
    [p, p.handleIn, p.handleOut].forEach((q) => { if (q) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; } });
  }));
  return x0 > x1 ? [0, 0] : [x0, x1];
}

module.exports = { shearContours, emboldenContours, signedArea, inkSpan };
