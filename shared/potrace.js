'use strict';
/*
 * potrace.js — clean-room raster→vector tracer for RuneType Glyphmaker.
 *
 * Goal: pixel-faithful outlines with MINIMAL anchor count, like Illustrator's
 * Image Trace, running purely in JS inside the CEP panel (no Illustrator round
 * trip, no WASM, no GPL code).
 *
 * This is a CLEAN-ROOM implementation written from the mathematics in Selinger's
 * 2003 paper "Potrace: a polygon-based tracing algorithm" plus standard public
 * methods (crack-following boundary trace, least-squares line fit, Schneider
 * cubic fitting). No GPL Potrace source is copied — only the algorithm (which is
 * not copyrightable) informs the design, so RuneType can stay closed-source.
 *
 * Pipeline (each stage is the same idea the research identified as load-bearing):
 *   0 threshold (+optional supersample)         → bilevel bitmap
 *   1 findContours (crack following + holes)     → unit-step pixel-corner loops
 *   2 turnPoints                                 → staircase corners
 *   3 optimalPolygon (non-local DP)              → fewest straight segments  [node min #1]
 *   4 adjustVertices (eigen line-fit + clamp)    → sub-pixel anchors         [fidelity]
 *   5 classifyCorners (alphamax curvature)       → corner vs smooth
 *   6 fitSmoothRuns (Schneider, error-bounded)   → minimal cubics            [node min #2 + fidelity]
 *   7 emit                                       → {closed,isHole,bbox,points:[{x,y,type,handleIn,handleOut}]}
 *
 * Output matches shared/imagetrace.js exactly, so it is a drop-in replacement.
 */

// ============================================================ bitmap + threshold

function Bitmap(w, h) { this.w = w; this.h = h; this.data = new Uint8Array(w * h); }
Bitmap.prototype.at = function (x, y) {
  return (x >= 0 && x < this.w && y >= 0 && y < this.h) ? this.data[y * this.w + x] : 0;
};

// Build a bilevel bitmap from ImageData. lum < threshold ⇒ black (ink) = 1.
// K = integer supersample factor (bilinear) so corners aren't pixel-quantized;
// anchors are scaled back by K at emit. K=1 = no supersample.
function bitmapFromImageData(imgd, threshold, K) {
  K = Math.max(1, K | 0);
  var sw = imgd.width, sh = imgd.height, d = imgd.data;
  function lumAt(x, y) {
    var i = (y * sw + x) * 4, a = d[i + 3] / 255;
    // composite onto white so transparent reads as background
    var r = d[i] * a + 255 * (1 - a), g = d[i + 1] * a + 255 * (1 - a), b = d[i + 2] * a + 255 * (1 - a);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b; // ITU-R BT.709 luma
  }
  if (K === 1) {
    var bm = new Bitmap(sw, sh);
    for (var y = 0; y < sh; y++) for (var x = 0; x < sw; x++) bm.data[y * sw + x] = lumAt(x, y) < threshold ? 1 : 0;
    return bm;
  }
  // bilinear upsample then threshold — gives sub-pixel boundary placement
  var W = sw * K, H = sh * K, bm2 = new Bitmap(W, H);
  for (var Y = 0; Y < H; Y++) {
    var fy = (Y + 0.5) / K - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    var ya = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0, yb = y0 + 1 < 0 ? 0 : y0 + 1 >= sh ? sh - 1 : y0 + 1;
    for (var X = 0; X < W; X++) {
      var fx = (X + 0.5) / K - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      var xa = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0, xb = x0 + 1 < 0 ? 0 : x0 + 1 >= sw ? sw - 1 : x0 + 1;
      var l = lumAt(xa, ya) * (1 - tx) * (1 - ty) + lumAt(xb, ya) * tx * (1 - ty) +
              lumAt(xa, yb) * (1 - tx) * ty + lumAt(xb, yb) * tx * ty;
      bm2.data[Y * W + X] = l < threshold ? 1 : 0;
    }
  }
  return bm2;
}

// ============================================================ 1. crack following

// Trace every black/white boundary as a closed loop of unit pixel-edge steps,
// keeping the black pixel on the LEFT of travel (left-hand wall follower). Each
// loop comes back oriented; signed area tells outer (one sign) from hole (other).
// Directions: 0=+x,1=+y,2=-x,3=-y  (image y-down).
var DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

function findContours(bm) {
  var w = bm.w, h = bm.h;
  function blk(px, py) { return bm.at(px, py); }
  // pixel on the LEFT of the directed edge that STARTS at corner (x,y) heading dir d
  function leftPixel(x, y, d) {
    switch (d) {
      case 0: return blk(x, y - 1);     // +x → left is up
      case 1: return blk(x, y);         // +y → left is +x pixel
      case 2: return blk(x - 1, y);     // -x → left is +y... pixel (x-1,y)
      default: return blk(x - 1, y - 1);// -y → left pixel
    }
  }
  function rightPixel(x, y, d) {
    switch (d) {
      case 0: return blk(x, y);
      case 1: return blk(x - 1, y);
      case 2: return blk(x - 1, y - 1);
      default: return blk(x, y - 1);
    }
  }
  // a directed edge is on the boundary iff black on left and white on right
  function isEdge(x, y, d) { return leftPixel(x, y, d) === 1 && rightPixel(x, y, d) === 0; }

  var seen = new Uint8Array((w + 1) * (h + 1) * 4);
  function eid(x, y, d) { return ((y * (w + 1)) + x) * 4 + d; }
  var contours = [];

  for (var sy = 0; sy <= h; sy++) {
    for (var sx = 0; sx <= w; sx++) {
      for (var sd = 0; sd < 4; sd++) {
        if (!isEdge(sx, sy, sd) || seen[eid(sx, sy, sd)]) continue;
        // walk this loop
        var pts = [];
        var x = sx, y = sy, d = sd, area = 0, guard = 0, maxIter = 8 * (w + 1) * (h + 1) + 16;
        do {
          seen[eid(x, y, d)] = 1;
          pts.push({ x: x, y: y });
          var nx = x + DX[d], ny = y + DY[d];
          area += x * (ny - y) - y * (nx - x); // 2*signed area (shoelace, += x*dy - y*dx)
          x = nx; y = ny;
          // choose next direction: left-hand rule → try left, straight, right, back
          var order = [(d + 3) & 3, d, (d + 1) & 3, (d + 2) & 3];
          var picked = -1;
          for (var oi = 0; oi < 4; oi++) { if (isEdge(x, y, order[oi])) { picked = order[oi]; break; } }
          if (picked < 0) break; // dead end (shouldn't happen on a closed loop)
          d = picked;
          if (++guard > maxIter) break;
        } while (!(x === sx && y === sy && d === sd));
        if (pts.length >= 4) contours.push({ pts: pts, area: area / 2 });
      }
    }
  }
  return contours;
}

// ============================================================ vector helpers
function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function vscale(a, s) { return { x: a.x * s, y: a.y * s }; }
function vdot(a, b) { return a.x * b.x + a.y * b.y; }
function vcross(a, b) { return a.x * b.y - a.y * b.x; }
function vlen(a) { return Math.hypot(a.x, a.y); }
function vnorm(a) { var l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; }
// perpendicular distance of p from the infinite line through a,b
function perpDist(p, a, b) {
  var dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
  if (l < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / l;
}

// ============================================================ 2. turn points
// Keep only points where the unit-step direction changes (staircase corners).
// A straight axis-aligned run collapses to its two ends; a diagonal keeps its
// zig-zag (which the optimal-polygon stage then collapses non-locally).
function turnPoints(pts) {
  var n = pts.length, keepIdx = [];
  for (var i = 0; i < n; i++) {
    var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    var d1x = b.x - a.x, d1y = b.y - a.y, d2x = c.x - b.x, d2y = c.y - b.y;
    if (d1x !== d2x || d1y !== d2y) keepIdx.push(i);
  }
  return keepIdx; // indices into pts
}

// ============================================================ 3. optimal polygon
// Non-local node minimizer: fewest straight segments (primary), least RMS
// deviation (secondary). A segment a→b is admissible iff every intermediate
// turn-point lies within fitTol of the chord — so a noisy-but-straight staircase
// collapses to ONE segment. Closed loop: fix the sharpest vertex, DP around.
function optimalPolygon(T, fitTol) {
  var n = T.length;
  if (n <= 3) { var all = []; for (var q = 0; q < n; q++) all.push(q); return all; }
  // sharpest vertex = smallest interior angle (largest turn) → must be a vertex
  var s = 0, bestTurn = -1;
  for (var i = 0; i < n; i++) {
    var a = T[(i - 1 + n) % n], b = T[i], c = T[(i + 1) % n];
    var t = Math.abs(vcross(vnorm(vsub(b, a)), vnorm(vsub(c, b))));
    if (t > bestTurn) { bestTurn = t; s = i; }
  }
  var U = []; for (var k = 0; k < n; k++) U.push(T[(s + k) % n]);
  U.push(U[0]); // close
  var m = n; // U has m+1 entries, U[m]==U[0]
  function straight(i, j) { // i<j, indices in U
    for (var k = i + 1; k < j; k++) if (perpDist(U[k], U[i], U[j]) > fitTol) return false;
    return true;
  }
  function penalty(i, j) {
    var s2 = 0, c = 0;
    for (var k = i + 1; k < j; k++) { var d = perpDist(U[k], U[i], U[j]); s2 += d * d; c++; }
    var rms = c ? Math.sqrt(s2 / c) : 0;
    return rms * vlen(vsub(U[j], U[i]));
  }
  var seg = new Array(m + 1), pen = new Array(m + 1), prev = new Array(m + 1);
  for (var z = 0; z <= m; z++) { seg[z] = Infinity; pen[z] = Infinity; prev[z] = -1; }
  seg[0] = 0; pen[0] = 0;
  var WMAX = 96; // bound the back-scan so noisy near-collinear edges stay ~O(n·W²), never O(n³) (no UI freeze)
  for (var j = 1; j <= m; j++) {
    for (var ii = Math.max(0, j - WMAX); ii < j; ii++) {
      if (seg[ii] === Infinity) continue;
      if (!straight(ii, j)) continue;
      var sc = seg[ii] + 1, pc = pen[ii] + penalty(ii, j);
      if (sc < seg[j] || (sc === seg[j] && pc < pen[j])) { seg[j] = sc; pen[j] = pc; prev[j] = ii; }
    }
  }
  var chain = [], cur = m;
  while (cur > 0) { chain.push(cur); cur = prev[cur]; if (chain.length > m + 1) break; }
  chain.push(0); chain.reverse(); // U-indices 0..m, with 0 and m the same point
  chain.pop(); // drop duplicate end (m)
  var poly = chain.map(function (u) { return (s + u) % n; }); // back to T indices
  return poly;
}

// ============================================================ 4. adjust vertices
// Least-squares line per polygon edge (larger-eigenvalue eigenvector), anchor =
// intersection of neighbouring edge-lines, clamped ≤ clamp px from the integer
// turn point. Sub-pixel placement ⇒ the outline re-rasterizes onto the input.
function eigenLine(points) {
  var n = points.length, mx = 0, my = 0;
  for (var i = 0; i < n; i++) { mx += points[i].x; my += points[i].y; }
  mx /= n; my /= n;
  var a = 0, b = 0, c = 0;
  for (var k = 0; k < n; k++) { var dx = points[k].x - mx, dy = points[k].y - my; a += dx * dx; b += dx * dy; c += dy * dy; }
  var lambda = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;
  var dir = { x: b, y: lambda - a };
  if (Math.hypot(dir.x, dir.y) < 1e-9) dir = { x: lambda - c, y: b };
  if (Math.hypot(dir.x, dir.y) < 1e-9) dir = { x: 1, y: 0 };
  return { p: { x: mx, y: my }, d: vnorm(dir) };
}
function lineIntersect(L1, L2) {
  var den = vcross(L1.d, L2.d);
  if (Math.abs(den) < 1e-9) return null; // parallel
  var diff = vsub(L2.p, L1.p);
  var t = vcross(diff, L2.d) / den;
  return { x: L1.p.x + L1.d.x * t, y: L1.p.y + L1.d.y * t };
}
function projectOnto(L, q) { var t = vdot(vsub(q, L.p), L.d); return { x: L.p.x + L.d.x * t, y: L.p.y + L.d.y * t }; }
// Anchor = average of the turn point projected onto each neighbouring edge-line.
// At a sharp corner both projections collapse to the lines' intersection (exact
// sub-pixel corner); on a curve they stay on the boundary mid-line, so anchors
// don't drift outward the way a raw tangent-line intersection does. Clamped ≤0.5px.
function adjustVertices(poly, T, tIdx, boundaryPts, clamp, isCorner) {
  var m = poly.length, bn = boundaryPts.length;
  var lines = [];
  for (var e = 0; e < m; e++) {
    var a = poly[e], b = poly[(e + 1) % m], pts = [], n = T.length;
    var k = a; pts.push(T[k]);
    while (k !== b) { k = (k + 1) % n; pts.push(T[k]); }
    lines.push(pts.length >= 2 ? eigenLine(pts) : { p: T[a], d: vnorm(vsub(T[b], T[a])) });
  }
  var V = [];
  for (var v = 0; v < m; v++) {
    var orig = T[poly[v]];
    var L1 = lines[(v - 1 + m) % m], L2 = lines[v];
    var ip = lineIntersect(L1, L2), target, cl;
    // A real CORNER (alphamax-classified): the two straight edges genuinely meet —
    // the intersection is the exact sub-pixel corner; clamp tight. A SMOOTH vertex
    // on a curve: place it on the local boundary mid-line by averaging a small window
    // of boundary points around the turn point (kills the ±0.5px staircase noise and
    // is stable even for short spans, unlike a per-edge line fit).
    if (isCorner[v] && ip && Math.hypot(ip.x - orig.x, ip.y - orig.y) <= clamp) {
      target = ip; cl = clamp;
    } else {
      var bi = tIdx[poly[v]], W = Math.max(2, Math.round(clamp * 4)), sx = 0, sy = 0, cnt = 0;
      for (var w = -W; w <= W; w++) { var bp = boundaryPts[(((bi + w) % bn) + bn) % bn]; sx += bp.x; sy += bp.y; cnt++; }
      target = { x: sx / cnt, y: sy / cnt };
      cl = 2.5 * clamp;
    }
    var nx = Math.max(orig.x - cl, Math.min(orig.x + cl, target.x));
    var ny = Math.max(orig.y - cl, Math.min(orig.y + cl, target.y));
    V.push({ x: nx, y: ny });
  }
  return V;
}

// ============================================================ 5. corner classify
// potrace's normalized curvature: dd = |cross(v_i,v_j,v_k)| / (|dx|+|dy| of v_i..v_k);
// alpha = (dd>1 ? 1-1/dd : 0)/0.75; alpha ≥ alphamax ⇒ CORNER (tangent break).
// Corner iff the TURN angle (deviation from straight) at the vertex ≥ threshold.
// Turn angle is SIZE-INVARIANT — the old potrace curvature metric depended on leg
// length, so short serif legs were mis-tagged smooth and long staircase legs faked
// corners. cornerAngleDeg comes from the Corners slider.
function classifyCorners(V, cornerAngleDeg) {
  var m = V.length, corner = new Array(m);
  var cosT = Math.cos(cornerAngleDeg * Math.PI / 180);
  for (var j = 0; j < m; j++) {
    var i = (j - 1 + m) % m, k = (j + 1) % m;
    var d1 = vnorm(vsub(V[j], V[i])), d2 = vnorm(vsub(V[k], V[j]));
    var dot = d1.x * d2.x + d1.y * d2.y;   // cos(turn): 1=straight, -1=reversal
    corner[j] = dot <= cosT;               // turn ≥ threshold ⇔ cos ≤ cos(threshold)
  }
  return corner;
}

// ============================================================ 6. fit handles
// Schneider single-cubic least-squares: fixed endpoints + tangent directions,
// solve handle lengths to best-fit the boundary points in the span. Pixel-faithful
// without adding nodes. Straight spans emit a line (null handles).
function fitHandles(points, V0, V3, t1, t2, straightTol) {
  // straight test first
  var maxd = 0;
  for (var s = 1; s < points.length - 1; s++) { var dd = perpDist(points[s], V0, V3); if (dd > maxd) maxd = dd; }
  if (maxd <= straightTol) return null; // straight segment

  var n = points.length;
  if (n < 3) { var a0 = vlen(vsub(V3, V0)) / 3; return { cp1: vadd(V0, vscale(t1, a0)), cp2: vadd(V3, vscale(t2, a0)) }; }
  // chord-length parameterization
  var u = new Array(n); u[0] = 0;
  for (var i = 1; i < n; i++) u[i] = u[i - 1] + vlen(vsub(points[i], points[i - 1]));
  var total = u[n - 1] || 1; for (var q = 0; q < n; q++) u[q] /= total;

  var C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
  for (var idx = 0; idx < n; idx++) {
    var t = u[idx], mt = 1 - t;
    var B0 = mt * mt * mt, B1 = 3 * t * mt * mt, B2 = 3 * t * t * mt, B3 = t * t * t;
    var A1 = vscale(t1, B1), A2 = vscale(t2, B2);
    C00 += vdot(A1, A1); C01 += vdot(A1, A2); C11 += vdot(A2, A2);
    var part = vadd(vscale(V0, B0 + B1), vscale(V3, B2 + B3));
    var res = vsub(points[idx], part);
    X0 += vdot(res, A1); X1 += vdot(res, A2);
  }
  var det = C00 * C11 - C01 * C01, a1, a2;
  if (Math.abs(det) < 1e-12) { a1 = a2 = vlen(vsub(V3, V0)) / 3; }
  else { a1 = (X0 * C11 - X1 * C01) / det; a2 = (C00 * X1 - C01 * X0) / det; }
  var fallback = vlen(vsub(V3, V0)) / 3;
  if (!(a1 > 1e-3) || a1 > 3 * fallback * 3) a1 = fallback;
  if (!(a2 > 1e-3) || a2 > 3 * fallback * 3) a2 = fallback;
  return { cp1: vadd(V0, vscale(t1, a1)), cp2: vadd(V3, vscale(t2, a2)) };
}

// ============================================================ trace one contour
function traceContour(boundaryPts, isHole, opts, K) {
  var tIdx = turnPoints(boundaryPts);
  if (tIdx.length < 3) return null;
  var T = tIdx.map(function (i) { return boundaryPts[i]; });
  var poly = optimalPolygon(T, opts.fitTol);
  if (poly.length < 3) {            // degenerate (hairline stroke) — keep the raw turn points so it doesn't vanish
    poly = []; for (var ti = 0; ti < T.length; ti++) poly.push(ti);
  }
  if (poly.length < 3) return null;
  // classify ONCE on the clean integer polygon (angle is size-invariant); carry it
  // through adjust + emit so sharp corners take the intersection branch and aren't rounded.
  var corner = classifyCorners(poly.map(function (i) { return T[i]; }), opts.cornerAngle);
  var V = adjustVertices(poly, T, tIdx, boundaryPts, opts.clamp, corner);
  var m = V.length;

  // forward/backward unit tangents per anchor
  var tanF = [], tanB = [];
  for (var j = 0; j < m; j++) {
    var pp = V[(j - 1 + m) % m], cc = V[j], nn = V[(j + 1) % m];
    if (corner[j]) { tanF.push(vnorm(vsub(nn, cc))); tanB.push(vnorm(vsub(pp, cc))); }
    else { var f = vnorm(vsub(nn, pp)); tanF.push(f); tanB.push(vscale(f, -1)); }
  }

  // map a polygon T-index back to a boundaryPts index
  function bIndexOf(tI) { return tIdx[tI]; }
  var pts = [];
  for (var a = 0; a < m; a++) pts.push({ x: 0, y: 0, type: corner[a] ? 'corner' : 'smooth', handleIn: null, handleOut: null });
  for (var e = 0; e < m; e++) {
    var js = e, je = (e + 1) % m;
    var bi = bIndexOf(poly[js]), bj = bIndexOf(poly[je]);
    var span = []; var bn = boundaryPts.length; var kk = bi; span.push(boundaryPts[kk]);
    while (kk !== bj) { kk = (kk + 1) % bn; span.push(boundaryPts[kk]); }
    var hb = fitHandles(span, V[js], V[je], tanF[js], tanB[je], opts.straightTol);
    if (hb) { pts[js].handleOut = vscale(hb.cp1, 1 / K); pts[je].handleIn = vscale(hb.cp2, 1 / K); }
  }
  // scale anchors back from supersample
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var v = 0; v < m; v++) {
    pts[v].x = V[v].x / K; pts[v].y = V[v].y / K;
    if (pts[v].x < minx) minx = pts[v].x; if (pts[v].x > maxx) maxx = pts[v].x;
    if (pts[v].y < miny) miny = pts[v].y; if (pts[v].y > maxy) maxy = pts[v].y;
  }
  return { closed: true, isHole: isHole, bbox: [minx, miny, maxx, maxy], points: pts };
}

// Signed area from the anchor polygon (sign = winding direction).
function signedAreaAnchors(points) {
  var a = 0, n = points.length;
  for (var i = 0; i < n; i++) { var p = points[i], q = points[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
// Reverse a cubic contour's direction (swap each anchor's in/out handle).
function reverseContour(c) {
  var pts = c.points.slice().reverse();
  for (var i = 0; i < pts.length; i++) { var t = pts[i].handleIn; pts[i].handleIn = pts[i].handleOut; pts[i].handleOut = t; }
  return { closed: c.closed, isHole: c.isHole, bbox: c.bbox, points: pts };
}

// ============================================================ public API
// opts (internal): { threshold, fitTol, alphamax, turdsize, straightTol, clamp, K }
function traceImageData(imgd, opts) {
  opts = opts || {};
  var K = Math.max(1, opts.K || 1);
  var o = {
    fitTol: (opts.fitTol != null ? opts.fitTol : 1.0) * K,
    cornerAngle: opts.cornerAngle != null ? opts.cornerAngle : 75,
    straightTol: (opts.straightTol != null ? opts.straightTol : 0.35) * K,
    clamp: 0.5 * K,
  };
  var threshold = opts.threshold != null ? opts.threshold : 128;
  var turdsize = (opts.turdsize != null ? opts.turdsize : 2) * K * K; // Noise in input px → supersampled area
  var bm = bitmapFromImageData(imgd, threshold, K);
  var raw = findContours(bm);
  var contours = [];
  for (var i = 0; i < raw.length; i++) {
    var c = raw[i];
    if (Math.abs(c.area) <= turdsize) continue;       // despeckle
    var isHole = c.area > 0;                            // outer=neg, hole=pos (our walk convention)
    var tc = traceContour(c.pts, isHole, o, K);
    if (tc) {
      // wind by ROLE — outer CCW (+), hole CW (−) — so NON-ZERO fill (the font + grid
      // + editor all use nonzero) subtracts counters. (Preview also uses even-odd.)
      var want = tc.isHole ? -1 : 1;
      if ((signedAreaAnchors(tc.points) >= 0 ? 1 : -1) !== want) tc = reverseContour(tc);
      contours.push(tc);
    }
  }
  return contours;
}

// Map the 4 Illustrator-style sliders → internal knobs (see research spec).
// threshold 0..255 ; paths 0..100 (hi=follow pixels/more nodes) ; corners 0..100
// (hi=more sharp corners) ; noise px.
function ilToOpts(il) {
  var paths = il.paths != null ? il.paths : 50;
  var corners = il.corners != null ? il.corners : 75;
  // Corners → TURN-ANGLE threshold (deg): 0→120 (rounder), 75→75, 100→50 (more corners).
  var cornerAngle = corners <= 75 ? 120 - (corners / 75) * 45 : 75 - ((corners - 75) / 25) * 25;
  return {
    threshold: il.threshold != null ? il.threshold : 128,
    fitTol: 0.7 + (1 - paths / 100) * 0.9,        // 50→1.15 (sweet spot); hi Paths→tight (more nodes on curves)
    straightTol: 0.25 + (1 - paths / 100) * 0.7,  // hi Paths → keeps gentle curves as curves
    cornerAngle: cornerAngle,
    turdsize: Math.max(1, il.noise != null ? il.noise : 2),  // default LOW so periods/i-dots/tittles survive
    K: il.K || 1,
  };
}

module.exports = {
  Bitmap: Bitmap, bitmapFromImageData: bitmapFromImageData, findContours: findContours,
  turnPoints: turnPoints, optimalPolygon: optimalPolygon, adjustVertices: adjustVertices,
  classifyCorners: classifyCorners, fitHandles: fitHandles, traceContour: traceContour,
  traceImageData: traceImageData, ilToOpts: ilToOpts, _DX: DX, _DY: DY,
};

