'use strict';
/* Offline VECTOR REFINER for Image Import (CEP panel).
 *
 * Two tiny ONNX models (refiner_jitter.onnx = smooth design bumps, refiner_quant.onnx
 * = de-pixelate AA + optimise points), trained self-supervised on 16k fonts (see
 * ml/vecai). Each takes a 96x96 glyph image + the contour's anchor points and returns
 * cleaned anchors + Bézier handles. We run it per contour and BLEND with the original
 * by a 0..1 strength, so the panel sliders dial the effect from off to full.
 *
 * SAFE BY DESIGN: if a model can't load, refine() returns the contours unchanged, so
 * Image Import always works. Normalisation matches ml/vecai/diffvec.normalize_contours
 * (fit glyph to a unit box with 0.12 margin; image space y-down, no flip).
 */
var fs = require('fs');
var IMG = 96, MARGIN = 0.12;

var _root = null, _ready = null, _failed = false, _ort = null, _initErr = null;
var _sess = { jitter: null, quant: null };

function loadOrtScript(root) {
  return new Promise(function (resolve, reject) {
    if (typeof window !== 'undefined' && window.ort) return resolve(window.ort);
    var s = document.createElement('script');
    s.src = root + '/js/lib/ort/ort.wasm.min.js';
    s.onload = function () { resolve(window.ort); };
    s.onerror = function () { reject(new Error('ort load failed')); };
    document.head.appendChild(s);
  });
}

function init(root) {
  _root = root;
  if (_ready) return _ready;
  _ready = (async function () {
    _ort = await loadOrtScript(root);
    var dir = root + '/js/lib/ort/';
    // configure like glyphreco (simd=true MUST match the simd-threaded wasm binary);
    // tolerate ort already being initialised by the recognizer.
    try { _ort.env.wasm.wasmPaths = dir; _ort.env.wasm.numThreads = 1; _ort.env.wasm.proxy = false; _ort.env.wasm.simd = true; } catch (e) {}
    try { var wb = fs.readFileSync(dir + 'ort-wasm-simd-threaded.wasm'); _ort.env.wasm.wasmBinary = wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength); } catch (e) {}
    var errs = [];
    for (var i = 0; i < 2; i++) {
      var name = i ? 'quant' : 'jitter';
      try {
        var mb = fs.readFileSync(root + '/js/lib/model/refiner_' + name + '.onnx');
        _sess[name] = await _ort.InferenceSession.create(new Uint8Array(mb.buffer, mb.byteOffset, mb.byteLength), { executionProviders: ['wasm'] });
      } catch (e) { errs.push(name + ': ' + ((e && e.message) || e)); }
    }
    if (!_sess.jitter && !_sess.quant) throw new Error(errs.join(' | ') || 'no refiner models');
  })().catch(function (e) { _failed = true; _initErr = (e && e.message) || String(e); if (window.console) console.error('[vecai] init failed:', e); throw e; });
  return _ready;
}

function isAvailable() { return !_failed && !!(_sess.jitter || _sess.quant); }
function initError() { return _initErr; }

// bbox of a contour's anchor points
function bounds(contours) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  contours.forEach(function (c) { c.points.forEach(function (p) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }); });
  return [x0, y0, x1, y1];
}

// Rasterise the whole glyph (all contours) to a 96x96 ink=1 Float32 in the SAME
// normalised box the model trained on — this is the model's image input.
function rasterize(contours, b) {
  var span = Math.max(b[2] - b[0], b[3] - b[1], 1e-6);
  var scale = (1 - 2 * MARGIN) / span, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  var nx = function (x) { return ((x - cx) * scale + 0.5) * IMG; };
  var ny = function (y) { return ((y - cy) * scale + 0.5) * IMG; };
  var cv = document.createElement('canvas'); cv.width = IMG; cv.height = IMG;
  var g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, IMG, IMG);
  var path = new Path2D();
  contours.forEach(function (c) {
    var pts = c.points; if (!pts || pts.length < 2) return;
    path.moveTo(nx(pts[0].x), ny(pts[0].y));
    for (var i = 1; i <= pts.length; i++) {
      var prev = pts[i - 1], cur = pts[i % pts.length];
      if (prev.handleOut || cur.handleIn) { var c1 = prev.handleOut || prev, c2 = cur.handleIn || cur; path.bezierCurveTo(nx(c1.x), ny(c1.y), nx(c2.x), ny(c2.y), nx(cur.x), ny(cur.y)); }
      else path.lineTo(nx(cur.x), ny(cur.y));
    }
    path.closePath();
  });
  g.fillStyle = '#fff'; g.fill(path, 'evenodd');
  var d = g.getImageData(0, 0, IMG, IMG).data, f = new Float32Array(IMG * IMG);
  for (var k = 0; k < IMG * IMG; k++) f[k] = d[k * 4] / 255;
  return { img: f, scale: scale, cx: cx, cy: cy };
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Refine all contours of a glyph with the chosen model, blended by `strength` (0..1).
// Returns NEW contours (same count/point-count) or the originals on any problem.
async function refineGlyph(contours, mode, strength, session, imgTensorCache) {
  if (!session || strength <= 0) return contours;
  var b = bounds(contours);
  var r = imgTensorCache.r || (imgTensorCache.r = rasterize(contours, b));
  var imgT = imgTensorCache.t || (imgTensorCache.t = new _ort.Tensor('float32', r.img, [1, 1, IMG, IMG]));
  var inName = session.inputNames, outName = session.outputNames;
  var out = [];
  for (var ci = 0; ci < contours.length; ci++) {
    var c = contours[ci], pts = c.points;
    if (!pts || pts.length < 3) { out.push(c); continue; }
    var N = pts.length, anchors = new Float32Array(N * 2);
    for (var i = 0; i < N; i++) { anchors[i * 2] = (pts[i].x - r.cx) * r.scale + 0.5; anchors[i * 2 + 1] = (pts[i].y - r.cy) * r.scale + 0.5; }
    var feeds = {}; feeds[inName[0]] = imgT; feeds[inName[1]] = new _ort.Tensor('float32', anchors, [N, 2]);
    var res;
    try { res = await session.run(feeds); } catch (e) { out.push(c); continue; }
    var A = res[outName[0]].data, Hin = res[outName[1]].data, Hout = res[outName[2]].data;
    var inv = function (vx, vy) { return { x: (vx - 0.5) / r.scale + r.cx, y: (vy - 0.5) / r.scale + r.cy }; };
    var np = [];
    for (var j = 0; j < N; j++) {
      var ma = inv(A[j * 2], A[j * 2 + 1]);
      var mo = inv(A[j * 2] + Hout[j * 2], A[j * 2 + 1] + Hout[j * 2 + 1]);
      var mi = inv(A[j * 2] + Hin[j * 2], A[j * 2 + 1] + Hin[j * 2 + 1]);
      var o = pts[j];
      var x = lerp(o.x, ma.x, strength), y = lerp(o.y, ma.y, strength);
      var oOut = o.handleOut || o, oIn = o.handleIn || o;
      np.push({
        x: x, y: y, type: o.type,
        handleOut: { x: lerp(oOut.x, mo.x, strength), y: lerp(oOut.y, mo.y, strength) },
        handleIn: { x: lerp(oIn.x, mi.x, strength), y: lerp(oIn.y, mi.y, strength) },
      });
    }
    out.push({ closed: c.closed, isHole: c.isHole, bbox: c.bbox, points: np });
  }
  return out;
}

// Public: refine every cluster's contours. opts = { smooth, sharpen } each 0..1
// (smooth = jitter model, sharpen = quant model; applied in sequence). Mutates a
// COPY; returns new clusters. Falls back to the input clusters if unavailable.
async function refine(clusters, opts) {
  opts = opts || {};
  var sm = opts.smooth || 0, sh = opts.sharpen || 0;
  if (sm <= 0 && sh <= 0) return clusters;
  if (_failed) return clusters;
  try { await init(_root); } catch (e) { return clusters; }
  if (!isAvailable()) return clusters;
  var out = [];
  for (var i = 0; i < clusters.length; i++) {
    var cl = clusters[i], contours = cl.contours, cache = {};
    // ORDER: Sharpen (quant) FIRST, then Smooth (jitter) on top — per the user's pipeline.
    if (sh > 0 && _sess.quant) { contours = await refineGlyph(contours, 'quant', sh, _sess.quant, cache); cache = {}; }
    if (sm > 0 && _sess.jitter) { contours = await refineGlyph(contours, 'jitter', sm, _sess.jitter, cache); }
    out.push({ contours: contours, bbox: cl.bbox, row: cl.row });
  }
  return out;
}

// ---- SIMPLIFY: drop redundant anchors after the refine ---------------------
function cubicPt(p0, c1, c2, p3, t) {
  var mt = 1 - t;
  return { x: mt*mt*mt*p0.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*p3.x,
           y: mt*mt*mt*p0.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*p3.y };
}
function sampleCubic(p0, c1, c2, p3, n) { var o = []; for (var s = 0; s <= n; s++) o.push(cubicPt(p0, c1, c2, p3, s / n)); return o; }

// Max deviation if anchor i is removed (its two segments merged into one cubic
// that keeps the OUTER handles). Low deviation => the anchor is redundant.
function removeError(pts, i, n) {
  var prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
  var pOut = prev.handleOut || prev, cIn = cur.handleIn || cur, cOut = cur.handleOut || cur, nIn = next.handleIn || next;
  var orig = sampleCubic(prev, pOut, cIn, cur, 6).concat(sampleCubic(cur, cOut, nIn, next, 6));
  var merged = sampleCubic(prev, pOut, nIn, next, 18);
  var maxd = 0;
  for (var a = 0; a < orig.length; a++) {
    var md = Infinity;
    for (var b = 0; b < merged.length; b++) { var dx = orig[a].x - merged[b].x, dy = orig[a].y - merged[b].y, d = dx * dx + dy * dy; if (d < md) md = d; }
    if (md > maxd) maxd = md;
  }
  return Math.sqrt(maxd);
}

// Turn angle (deg) at point i: 0 = straight, 180 = spike. Big = a real sharp corner.
function turnAngle(pts, i, n) {
  var p = pts[(i - 1 + n) % n], v = pts[i], q = pts[(i + 1) % n];
  var ax = v.x - p.x, ay = v.y - p.y, bx = q.x - v.x, by = q.y - v.y;
  var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return 180;
  var d = (ax * bx + ay * by) / (la * lb); d = d < -1 ? -1 : d > 1 ? 1 : d;
  return Math.acos(d) * 180 / Math.PI;
}

function simplifyContour(c, tol, keepCornerDeg) {
  var pts = c.points.slice();
  if (pts.length <= 4) return c;
  var guard = 0;
  while (pts.length > 4 && guard++ < 300) {
    var n = pts.length, bestErr = Infinity, bestI = -1;
    for (var i = 0; i < n; i++) {
      // keep only SHARP corners; gentle/unnecessary corners get smoothed away too
      if (pts[i].type === 'corner' && turnAngle(pts, i, n) >= keepCornerDeg) continue;
      var e = removeError(pts, i, n);
      if (e < bestErr) { bestErr = e; bestI = i; }
    }
    if (bestI < 0 || bestErr > tol) break;
    pts.splice(bestI, 1);
  }
  return { closed: c.closed, isHole: c.isHole, bbox: c.bbox, points: pts };
}

// Remove redundant points + smooth gentle corners on every glyph. Tolerance scales
// with glyph size and the 0..1 strength; keepCornerDeg rises with strength so more
// of the borderline corners get rounded as the slider goes up.
function simplify(clusters, strength) {
  if (!strength || strength <= 0) return clusters;
  var keepDeg = 40 + 55 * strength;   // higher strength -> smooth gentler corners too
  return clusters.map(function (cl) {
    var b = cl.bbox || bounds(cl.contours);
    var diag = Math.hypot(b[2] - b[0], b[3] - b[1]) || 100;
    var tol = strength * diag * 0.04;
    return { contours: cl.contours.map(function (c) { return simplifyContour(c, tol, keepDeg); }), bbox: cl.bbox, row: cl.row };
  });
}

module.exports = { init, isAvailable, refine, simplify, initError, IMG };
