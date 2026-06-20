'use strict';
// Raster glyph sheet -> vector contours, pure JS so it runs in the CEP panel
// (Chromium/Node) AND under Node unit tests. NO Illustrator needed.
//
// Pipeline (tuned for clean type, not photos):
//   threshold (+ auto-polarity)               -> bilevel ink/background
//   imagetracerjs pathscan                    -> raw pixel boundary loops (+holes)
//   RDP simplify                              -> kill pixel stair-steps / speckle
//   corner detection (turn-angle)             -> keep sharp corners sharp
//   Schneider cubic-Bézier fit (per run)      -> smooth, FEW points between corners
//
// imagetracerjs (Unlicense / public domain) is used ONLY for its proven boundary
// scan; its own curve fitter (jaggy, many points) is replaced by the above. That
// is what makes the result both smooth AND low-path while preserving corners —
// the thing Illustrator's scripted Image Trace and raw imagetracer both miss.
//
// Output contours, IMAGE PIXEL space (origin top-left, Y-DOWN):
//   { closed:true, isHole:boolean, bbox:[minX,minY,maxX,maxY],
//     points:[{ x, y, type:'smooth'|'corner', handleIn, handleOut }] }
// handleIn/handleOut are absolute cubic control points, or null (straight/corner).
// Y is flipped to font-up later, per sheet, in imgglyphs.seatClusters().

// sync-cep.js rewrites this require to the bundled copy for the panel.
const ImageTracer = require('imagetracerjs');

// Defaults tuned for PROFESSIONAL geometric outlines: corners detected on the RAW
// boundary FIRST (so they can't be rounded away), stems classified STRAIGHT and
// emitted as exact lines, only genuinely-curved runs spend Béziers. All overridable.
const DEFAULTS = {
  threshold: 128,        // luminance cut (0..255); darker => ink (before auto-polarity)
  autoInvert: true,      // if ink would be the majority, swap (white-on-black sheets)
  pathomit: 8,           // drop boundary loops shorter than this many steps (despeckle)
  minArea: 6,            // drop contours whose bbox area < this (px^2)
  // corner detection runs on the RAW boundary, BEFORE any point is moved
  cornerRadius: 3,       // turn-window radius in boundary points (~px)
  cornerAngle: 62,       // window turn >= this (deg) => a kept hard corner
  minLoopForCorners: 24, // smaller loops (dots/tittles/tiny counters) stay smooth circles
  cornerGuard: 2,        // freeze +/- this many points around a corner when smoothing
  smooth: 1,             // light, CORNER-SAFE boundary smoothing passes (0 = off)
  rdpEps: 1.0,           // gentle simplify — corners are pinned, so no apex is ever lost
  // a run between two corners that barely deviates from its chord => one exact LINE
  // (de-bows stems). Short runs are exempt so real serif brackets keep their curve.
  straightRatio: 0.02,   // max (chord deviation / run length) to call a run straight
  minStraightLen: 10,    // runs shorter than this px are never flattened (serifs)
  fitError: 1.8,         // Schneider max fit error (px) on genuinely curved runs
};

function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

// RGBA -> bilevel ImageData (ink=0, bg=255). Transparent counts as background.
// Auto-polarity: a glyph sheet has ink as the MINORITY; if "dark" pixels are the
// majority the sheet is white-on-black, so flip which side is ink.
function thresholdImageData(imgd, opt) {
  const t = (opt && opt.threshold != null) ? opt.threshold : DEFAULTS.threshold;
  const src = imgd.data, n = imgd.width * imgd.height;
  const dark = new Uint8Array(n);
  let darkCount = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = src[i + 3];
    const L = a < 8 ? 255 : lum(src[i], src[i + 1], src[i + 2]);
    if (L < t) { dark[p] = 1; darkCount++; }
  }
  const invert = (opt && opt.autoInvert !== false) && darkCount > n * 0.5; // ink = light side
  const out = new Uint8ClampedArray(src.length);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const ink = invert ? !dark[p] : !!dark[p];
    const v = ink ? 0 : 255;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return { width: imgd.width, height: imgd.height, data: out };
}

// ---- geometry helpers -----------------------------------------------------
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
// perpendicular distance of p from the infinite line a-b
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

// Ramer–Douglas–Peucker on a CLOSED polygon. Anchors the split at point 0 and
// the farthest point from it, simplifies both arcs, returns kept points in order.
function rdpClosed(pts, eps) {
  const n = pts.length;
  if (n < 4) return pts.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = dist2(pts[i], pts[0]); if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = 1; keep[far % n] = 1;
  const P = (i) => pts[i % n];
  function seg(lo, hi) { // simplify P(lo)..P(hi); endpoints already kept
    if (hi - lo < 2) return;
    const a = P(lo), b = P(hi);
    let dmax = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) { const d = perpDist(P(i), a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps && idx >= 0) { keep[idx % n] = 1; seg(lo, idx); seg(idx, hi); }
  }
  seg(0, far);
  seg(far, n); // wraps: P(n) === pts[0]
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Mark vertices whose turn angle (deviation from straight) >= angleDeg as corners.
function detectCorners(pts, angleDeg) {
  const n = pts.length, corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], v = pts[i], q = pts[(i + 1) % n];
    const ax = v.x - p.x, ay = v.y - p.y, bx = q.x - v.x, by = q.y - v.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) { corner[i] = 1; continue; }
    let c = (ax * bx + ay * by) / (la * lb); c = c < -1 ? -1 : c > 1 ? 1 : c;
    if (Math.acos(c) * 180 / Math.PI >= angleDeg) corner[i] = 1;
  }
  return corner;
}

// Turn angle (deg) at point i measured across a WINDOW of W boundary points on
// each side. Using chords pts[i±W] (not per-edge tangents) averages out the anti-
// alias staircase, so a real 90° corner reads ~90° while 1px jitter reads ~0°.
function windowTurn(pts, i, W) {
  const n = pts.length;
  const a = pts[((i - W) % n + n) % n], b = pts[i], c = pts[(i + W) % n];
  const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return 0;
  let d = (ax * bx + ay * by) / (la * lb); d = d < -1 ? -1 : d > 1 ? 1 : d;
  return Math.acos(d) * 180 / Math.PI;
}

// Detect corners on the RAW boundary (BEFORE any point moves — the single biggest
// fix vs the old order). Two physical scales (W and 2W) catch both tight serif tips
// and broad bowl/stem junctions under one threshold; non-maximum suppression over
// ±W collapses a staircased corner to ONE anchor at its peak. Loops too small to
// hold a meaningful window are left corner-free so dots/tittles stay round.
function detectCornersWin(pts, o) {
  const n = pts.length, corner = new Uint8Array(n);
  if (n < (o.minLoopForCorners || 24)) return corner;
  const W1 = Math.max(2, Math.round(o.cornerRadius || 3)), W2 = W1 * 2;
  const resp = new Float32Array(n);
  // a real corner reads sharp at BOTH the fine and broad scale; staircase jitter
  // spikes only the fine scale and a smooth arc only rises at the broad scale, so
  // MIN of the two rejects both — only concentrated, genuine corners survive.
  for (let i = 0; i < n; i++) resp[i] = Math.min(windowTurn(pts, i, W1), windowTurn(pts, i, W2));
  for (let i = 0; i < n; i++) {
    if (resp[i] < o.cornerAngle) continue;
    let isMax = true;
    for (let k = 1; k <= W1 && isMax; k++) {
      if (resp[(i + k) % n] > resp[i] || resp[((i - k) % n + n) % n] > resp[i]) isMax = false;
    }
    if (isMax) corner[i] = 1;
  }
  return corner;
}

// Corner-SAFE smoothing: melts pixel stairs on the non-corner stretches, but
// freezes a ±guard window around every DETECTED corner (passed in — no longer
// re-derived with a disagreeing test) so the straight edges entering a corner are
// never pulled into a curve. Light kernel; only runs when smooth > 0.
function smoothBoundary(pts, iterations, cornerMask, guard) {
  const n = pts.length;
  if (n < 8 || iterations <= 0) return pts;
  const g = guard == null ? 2 : guard, frozen = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (cornerMask && cornerMask[i]) for (let k = -g; k <= g; k++) frozen[((i + k) % n + n) % n] = 1;
  let cur = pts.map((p) => ({ x: p.x, y: p.y }));
  for (let it = 0; it < iterations; it++) {
    const nxt = new Array(n);
    for (let j = 0; j < n; j++) {
      if (frozen[j]) { nxt[j] = cur[j]; continue; }
      const p = cur[(j - 1 + n) % n], q = cur[(j + 1) % n], s = cur[j];
      nxt[j] = { x: s.x * 0.6 + (p.x + q.x) * 0.2, y: s.y * 0.6 + (p.y + q.y) * 0.2 };
    }
    cur = nxt;
  }
  return cur;
}

// RDP simplify that PINS the detected corners (always kept) and simplifies each
// corner→corner arc independently. Because apexes can't be deleted, eps stays
// gentle and curve detail survives. Returns kept points + per-point corner flags.
function rdpAnchored(pts, eps, cornerMask) {
  const n = pts.length;
  const cornerIdx = [];
  for (let i = 0; i < n; i++) if (cornerMask[i]) cornerIdx.push(i);
  if (cornerIdx.length < 2) {
    const k = rdpClosed(pts, eps);
    return { kept: k, keptCorner: new Array(k.length).fill(0) };
  }
  const keep = new Uint8Array(n);
  cornerIdx.forEach((i) => { keep[i] = 1; });
  const P = (i) => pts[((i % n) + n) % n];
  function seg(lo, hi) {
    if (hi - lo < 2) return;
    const a = P(lo), b = P(hi);
    let dmax = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) { const d = perpDist(P(i), a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps && idx >= 0) { keep[((idx % n) + n) % n] = 1; seg(lo, idx); seg(idx, hi); }
  }
  for (let c = 0; c < cornerIdx.length; c++) {
    const lo = cornerIdx[c], hi = (c + 1 < cornerIdx.length) ? cornerIdx[c + 1] : cornerIdx[0] + n;
    seg(lo, hi);
  }
  const kept = [], keptCorner = [];
  for (let i = 0; i < n; i++) if (keep[i]) { kept.push(pts[i]); keptCorner.push(cornerMask[i] ? 1 : 0); }
  return { kept, keptCorner };
}

// Max perpendicular distance of an interior run from its end-to-end chord.
function maxPerpDev(seq) {
  const a = seq[0], b = seq[seq.length - 1];
  let dmax = 0;
  for (let i = 1; i < seq.length - 1; i++) { const d = perpDist(seq[i], a, b); if (d > dmax) dmax = d; }
  return dmax;
}

// ---- Schneider cubic Bézier fitting (Graphics Gems, "FitCurves") ----------
function v_sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function v_add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function v_scale(a, s) { return { x: a.x * s, y: a.y * s }; }
function v_dot(a, b) { return a.x * b.x + a.y * b.y; }
function v_norm(a) { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; }
function v_neg(a) { return { x: -a.x, y: -a.y }; }

function B0(u) { const t = 1 - u; return t * t * t; }
function B1(u) { const t = 1 - u; return 3 * u * t * t; }
function B2(u) { const t = 1 - u; return 3 * u * u * t; }
function B3(u) { return u * u * u; }

function bezierEval(bez, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * bez[0].x + b * bez[1].x + c * bez[2].x + d * bez[3].x,
    y: a * bez[0].y + b * bez[1].y + c * bez[2].y + d * bez[3].y,
  };
}

function chordLengthParam(pts, lo, hi) {
  const u = [0];
  for (let i = lo + 1; i <= hi; i++) u.push(u[i - 1 - lo] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const last = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= last;
  return u;
}

// Least-squares fit of one cubic to pts[lo..hi] with fixed end tangents.
function generateBezier(pts, lo, hi, u, tHat1, tHat2) {
  const nPts = hi - lo + 1;
  const A = [];
  for (let i = 0; i < nPts; i++) A.push([v_scale(tHat1, B1(u[i])), v_scale(tHat2, B2(u[i]))]);
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  const p0 = pts[lo], p3 = pts[hi];
  for (let i = 0; i < nPts; i++) {
    const a0 = A[i][0], a1 = A[i][1];
    c00 += v_dot(a0, a0); c01 += v_dot(a0, a1); c11 += v_dot(a1, a1);
    const tmp = v_sub(pts[lo + i], v_add(v_scale(p0, B0(u[i]) + B1(u[i])), v_scale(p3, B2(u[i]) + B3(u[i]))));
    x0 += v_dot(a0, tmp); x1 += v_dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alphaR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const eps = 1e-6 * segLen;
  // Clamp handle lengths so the least-squares solve can't overshoot into a wild
  // bulge / a handle that shoots out past the glyph (the "abuk subuk" look). A
  // handle longer than its chord almost always means an over-extrapolated fit.
  const cap = segLen * 1.0;
  if (alphaL > cap) alphaL = cap;
  if (alphaR > cap) alphaR = cap;
  if (alphaL < eps || alphaR < eps) { // fall back to Wu/Barsky heuristic (collinear handles)
    const d = segLen / 3;
    return [p0, v_add(p0, v_scale(tHat1, d)), v_add(p3, v_scale(tHat2, d)), p3];
  }
  return [p0, v_add(p0, v_scale(tHat1, alphaL)), v_add(p3, v_scale(tHat2, alphaR)), p3];
}

function computeMaxError(pts, lo, hi, bez, u) {
  let maxDist = 0, splitI = Math.floor((hi - lo + 1) / 2) + lo;
  for (let i = lo + 1; i < hi; i++) {
    const P = bezierEval(bez, u[i - lo]);
    const d = (P.x - pts[i].x) ** 2 + (P.y - pts[i].y) ** 2;
    if (d > maxDist) { maxDist = d; splitI = i; }
  }
  return { maxErr: maxDist, splitI };
}

function fitCubic(pts, lo, hi, tHat1, tHat2, errorSq, out) {
  if (hi - lo === 1) { // only two points -> straight line, marked straight
    const d = Math.hypot(pts[hi].x - pts[lo].x, pts[hi].y - pts[lo].y) / 3;
    out.push({ bez: [pts[lo], v_add(pts[lo], v_scale(tHat1, d)), v_add(pts[hi], v_scale(tHat2, d)), pts[hi]], straight: true });
    return;
  }
  let u = chordLengthParam(pts, lo, hi);
  let bez = generateBezier(pts, lo, hi, u, tHat1, tHat2);
  let { maxErr, splitI } = computeMaxError(pts, lo, hi, bez, u);
  if (maxErr < errorSq) { out.push({ bez, straight: false }); return; }
  // one round of Newton reparameterisation if we're close
  if (maxErr < errorSq * 16) {
    for (let it = 0; it < 2; it++) {
      u = reparam(pts, lo, hi, u, bez);
      bez = generateBezier(pts, lo, hi, u, tHat1, tHat2);
      const r = computeMaxError(pts, lo, hi, bez, u);
      maxErr = r.maxErr; splitI = r.splitI;
      if (maxErr < errorSq) { out.push({ bez, straight: false }); return; }
    }
  }
  if (splitI <= lo || splitI >= hi) splitI = lo + ((hi - lo) >> 1);
  // If the split point is itself a sharp turn, break SHARP (a real corner inside a
  // run) instead of forcing a smooth tangent across it — kills rounded joins where
  // a corner belongs. Otherwise keep the smooth centre tangent.
  const inD = v_norm(v_sub(pts[splitI], pts[splitI - 1]));
  const outD = v_norm(v_sub(pts[splitI + 1], pts[splitI]));
  let dd = v_dot(inD, outD); dd = dd < -1 ? -1 : dd > 1 ? 1 : dd;
  if (Math.acos(dd) * 180 / Math.PI >= _cornerSplitDeg) {
    fitCubic(pts, lo, splitI, tHat1, v_neg(inD), errorSq, out);
    if (out.length) out[out.length - 1].cornerEnd = true;
    fitCubic(pts, splitI, hi, outD, tHat2, errorSq, out);
  } else {
    const tHatC = v_norm(v_sub(pts[splitI - 1], pts[splitI + 1]));
    fitCubic(pts, lo, splitI, tHat1, tHatC, errorSq, out);
    fitCubic(pts, splitI, hi, v_neg(tHatC), tHat2, errorSq, out);
  }
}
let _cornerSplitDeg = 62; // set per-trace from o.cornerAngle

function reparam(pts, lo, hi, u, bez) {
  const nu = u.slice();
  const d1 = [v_scale(v_sub(bez[1], bez[0]), 3), v_scale(v_sub(bez[2], bez[1]), 3), v_scale(v_sub(bez[3], bez[2]), 3)];
  const d2 = [v_scale(v_sub(d1[1], d1[0]), 2), v_scale(v_sub(d1[2], d1[1]), 2)];
  for (let i = lo + 1; i < hi; i++) {
    const t = u[i - lo];
    const P = bezierEval(bez, t);
    const Q1 = { x: (1 - t) * (1 - t) * d1[0].x + 2 * (1 - t) * t * d1[1].x + t * t * d1[2].x,
                 y: (1 - t) * (1 - t) * d1[0].y + 2 * (1 - t) * t * d1[1].y + t * t * d1[2].y };
    const Q2 = { x: (1 - t) * d2[0].x + t * d2[1].x, y: (1 - t) * d2[0].y + t * d2[1].y };
    const diff = v_sub(P, pts[i]);
    const num = v_dot(diff, Q1);
    const den = v_dot(Q1, Q1) + v_dot(diff, Q2);
    if (Math.abs(den) > 1e-9) nu[i - lo] = t - num / den;
  }
  return nu;
}

// Tangent leaving a break point (start of the next run). Corner: along the first
// edge of the run (independent per side -> sharp). Smooth: the curve's tangent
// through the point (shared with the run ending here -> C1 continuity).
function tangentOut(brk, pts, n) {
  const i = brk.i;
  if (brk.corner) return v_norm(v_sub(pts[(i + 1) % n], pts[i]));
  return v_norm(v_sub(pts[(i + 1) % n], pts[(i - 1 + n) % n]));
}
// Tangent arriving at a break (end of a run), pointing back into the run.
function tangentIn(brk, pts, n) {
  const i = brk.i;
  if (brk.corner) return v_norm(v_sub(pts[(i - 1 + n) % n], pts[i]));
  return v_norm(v_sub(pts[(i - 1 + n) % n], pts[(i + 1) % n])); // = -tangentOut (smooth) -> shared line
}

// Fit a CLOSED, RDP-simplified loop into cubic segments. Breaks at corners
// (sharp) and, if there are fewer than two breaks, at evenly-spaced smooth points
// so no run has coincident endpoints and a circle stays a circle.
function fitClosedLoop(pts, cornerFlags, fitError) {
  const n = pts.length;
  const errSq = fitError * fitError;
  const breaks = [];
  for (let i = 0; i < n; i++) if (cornerFlags[i]) breaks.push({ i: i, corner: true });
  if (breaks.length < 2) { // smooth (or single-corner) loop: add antipodal smooth break(s)
    const base = breaks.length ? breaks[0].i : 0;
    if (!breaks.length) breaks.push({ i: base, corner: false });
    breaks.push({ i: (base + (n >> 1)) % n, corner: false });
  }
  breaks.sort((a, b) => a.i - b.i);
  const B = breaks.length, cubics = [];
  for (let bi = 0; bi < B; bi++) {
    const a = breaks[bi], b = breaks[(bi + 1) % B];
    const idxs = [a.i];
    let i = a.i;
    do { i = (i + 1) % n; idxs.push(i); } while (i !== b.i);
    const seq = idxs.map((k) => pts[k]);
    const m = seq.length;
    if (m < 2) continue;
    const out = [];
    fitCubic(seq, 0, m - 1, tangentOut(a, pts, n), tangentIn(b, pts, n), errSq, out);
    out.forEach((c, k) => cubics.push({ bez: c.bez, straight: c.straight, cornerAnchor: (k === 0 && a.corner) }));
  }
  return cubics;
}

// Like fitClosedLoop, but FIRST classifies each corner→corner run: a run that
// barely deviates from its chord (and is long enough to not be a serif) becomes
// ONE exact straight LINE — dead-straight stems, zero bow, two anchors. Only
// genuinely curved runs spend Béziers. Antipodal (auto-inserted, non-corner)
// breaks are NEVER flattened, so bowls (O/S/D/U) can't grow flat facets.
function classifyAndFit(pts, cornerFlags, o) {
  const n = pts.length, errSq = o.fitError * o.fitError;
  const breaks = [];
  for (let i = 0; i < n; i++) if (cornerFlags[i]) breaks.push({ i: i, corner: true });
  if (breaks.length < 2) {
    const base = breaks.length ? breaks[0].i : 0;
    if (!breaks.length) breaks.push({ i: base, corner: false });
    breaks.push({ i: (base + (n >> 1)) % n, corner: false });
  }
  breaks.sort((a, b) => a.i - b.i);
  const B = breaks.length, cubics = [];
  for (let bi = 0; bi < B; bi++) {
    const a = breaks[bi], b = breaks[(bi + 1) % B];
    const idxs = [a.i]; let i = a.i;
    do { i = (i + 1) % n; idxs.push(i); } while (i !== b.i);
    const seq = idxs.map((k) => pts[k]); const m = seq.length;
    if (m < 2) continue;
    let straight = false;
    if (a.corner && b.corner) { // only between REAL corners, and not serif-short
      const len = Math.hypot(seq[m - 1].x - seq[0].x, seq[m - 1].y - seq[0].y);
      straight = len >= o.minStraightLen && maxPerpDev(seq) <= o.straightRatio * len;
    }
    if (straight) {
      cubics.push({ bez: [seq[0], seq[0], seq[m - 1], seq[m - 1]], straight: true, cornerAnchor: true });
    } else {
      const out = [];
      fitCubic(seq, 0, m - 1, tangentOut(a, pts, n), tangentIn(b, pts, n), errSq, out);
      out.forEach((c, k) => cubics.push({ bez: c.bez, straight: c.straight, cornerAnchor: (k === 0 && a.corner), cornerEnd: c.cornerEnd }));
    }
  }
  return cubics;
}

// Cubic segment list (closed) -> contour points in our anchor/handle format.
function cubicsToPoints(cubics) {
  const m = cubics.length, pts = [];
  if (!m) return pts;
  for (let i = 0; i < m; i++) {
    const cur = cubics[i], prev = cubics[(i - 1 + m) % m];
    const anchor = cur.bez[0];
    const handleOut = cur.straight ? null : cur.bez[1];
    const handleIn = prev.straight ? null : prev.bez[2];
    pts.push({
      x: anchor.x, y: anchor.y,
      handleIn: handleIn, handleOut: handleOut,
      type: ((cur.cornerAnchor || prev.cornerEnd) ? 'corner' : 'smooth'),
    });
  }
  return pts;
}

function dedupConsecutive(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1];
    if (!q || Math.abs(p.x - q.x) > 1e-6 || Math.abs(p.y - q.y) > 1e-6) out.push({ x: p.x, y: p.y });
  }
  // drop a closing duplicate of the start
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) out.pop(); }
  return out;
}

function cubicAt(a, b, c, d, t) { const mt = 1 - t; return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d; }
// extrema of one cubic axis component, in (0,1)
function axisExtrema(a, b, c, d) {
  const vals = [a, d];
  const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = -a + b;
  const roots = [];
  if (Math.abs(A) < 1e-9) { if (Math.abs(B) > 1e-9) roots.push(-C / B); }
  else { const disc = B * B - 4 * A * C; if (disc >= 0) { const s = Math.sqrt(disc); roots.push((-B + s) / (2 * A), (-B - s) / (2 * A)); } }
  for (const t of roots) if (t > 1e-4 && t < 1 - 1e-4) vals.push(cubicAt(a, b, c, d, t));
  return vals;
}

// True bounding box of the contour — includes the bulge of every Bézier segment,
// not just the anchors (a 2-anchor circle's anchors are colinear otherwise).
function bboxOf(pts) {
  const n = pts.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const push = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    push(a.x, a.y);
    if (a.handleOut || b.handleIn) {
      const c1 = a.handleOut || a, c2 = b.handleIn || b;
      for (const v of axisExtrema(a.x, c1.x, c2.x, b.x)) { if (v < x0) x0 = v; if (v > x1) x1 = v; }
      for (const v of axisExtrema(a.y, c1.y, c2.y, b.y)) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
    }
  }
  return [x0, y0, x1, y1];
}

// ImageData -> contours (pixel space, Y-down). opts overrides DEFAULTS; legacy
// opts.trace.pathomit is still honoured.
function traceImageData(imgd, opts) {
  opts = opts || {};
  const o = Object.assign({}, DEFAULTS, opts);
  if (opts.trace && opts.trace.pathomit != null) o.pathomit = opts.trace.pathomit;

  const bw = thresholdImageData(imgd, o);
  const io = ImageTracer.checkoptions({
    numberofcolors: 2, colorsampling: 0, mincolorratio: 0, colorquantcycles: 1,
    pal: [{ r: 255, g: 255, b: 255, a: 255 }, { r: 0, g: 0, b: 0, a: 255 }],
    pathomit: o.pathomit,
  });
  const ii = ImageTracer.colorquantization(bw, io);
  const layers = ImageTracer.layering(ii);
  if (!layers || layers.length < 2) return [];
  const paths = ImageTracer.pathscan(layers[1], io.pathomit); // index 1 = black = ink

  _cornerSplitDeg = o.cornerAngle; // hard-corner split threshold inside fitCubic

  const contours = [];
  for (const p of paths) {
    if (!p.points || p.points.length < 4) continue;
    const raw = dedupConsecutive(p.points);
    if (raw.length < 4) continue;
    // 1) corners on the RAW boundary, BEFORE any point moves (the dominant fix)
    const cmask = detectCornersWin(raw, o);
    // 2) optional corner-SAFE smoothing of the non-corner stretches
    const work = o.smooth > 0 ? smoothBoundary(raw, o.smooth, cmask, o.cornerGuard) : raw;
    // 3) corner-anchored RDP — pins corners, simplifies arcs gently
    const { kept, keptCorner } = rdpAnchored(work, o.rdpEps, cmask);
    if (kept.length < 3) continue;
    // 4) straight runs -> exact lines, curved runs -> minimal Béziers
    const cubics = classifyAndFit(kept, keptCorner, o);
    const points = cubicsToPoints(cubics);
    if (points.length < 2) continue;
    const bbox = bboxOf(points);
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < o.minArea) continue;
    contours.push({ closed: true, isHole: !!p.isholepath, bbox, points });
  }
  return contours;
}

module.exports = {
  DEFAULTS, thresholdImageData,
  rdpClosed, detectCorners, fitClosedLoop, cubicsToPoints, traceImageData, // back-compat
  windowTurn, detectCornersWin, smoothBoundary, rdpAnchored, classifyAndFit, maxPerpDev,
};
