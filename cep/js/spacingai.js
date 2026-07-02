'use strict';
/* Offline SIDEBEARING model for the Metric ⟷ Optical bake (CEP panel).
 *
 * Runs the trained SBNet (spacing.onnx, ~4MB, MobileNetV3-Small + 8 context
 * scalars → [residL, residR]) via onnxruntime-web, entirely on-device. For each
 * drawn letter/figure it rasterizes the glyph to the SAME 96×96 raster the
 * recognizer uses (glyphreco.rasterize → byte-parity with the Python training
 * rasterizer), computes the analytic area-margin prior + context features, runs
 * inference, and turns the result into a PER-GLYPH optical RECESSION (font units)
 * fed to optimizer.bakeMetricOptical via opts.optBearings.
 *
 * The model predicts ONLY recession RELATIVE to the font's own typical air (the
 * openness is divided out and re-applied as optHalf in the bake), so a sans-heavy
 * training corpus still teaches the universal "O recedes more than H" that
 * transfers to the user's gothic display faces. See ml/SPACING.md + the memory
 * project-sidebearing-ml.
 *
 * SAFE BY DESIGN: if the runtime/model fails to load, predict() resolves to {} and
 * the bake falls back to uniform optHalf (today's behaviour) — nothing breaks.
 *
 * The pure feature math (areaMarginPrior / contrastFeat / spikinessFeat /
 * priorCapUnits) is a faithful port of ml/render_spacing.py and is exported for
 * the Python↔JS parity gate (test/spacing-parity.test.js).
 */
var fs = require('fs');
// glyphreco.rasterize (Canvas2D) is ASSUMED close to the PIL/LANCZOS training rasterizer
// (the recognizer ships the same path); not pixel-parity-tested. The analytic feature math
// below IS Python↔JS parity-tested (test/spacing-parity.test.js, feature math only).
var glyphreco = require('./glyphreco.js');     // 96×96 white-on-black rasterizer + ort wasm config
var refspace = require('./refspace.js');       // flattenContour → true curve-extrema ink bbox

var IMG = 96, BAND = 0.04, INK01 = 32 / 255;   // ink threshold on a [0,1] raster == Python `>32` on uint8
var TRAIN = (function () {
  var s = '';
  for (var c = 0x41; c <= 0x5A; c++) s += String.fromCharCode(c);
  for (var c2 = 0x61; c2 <= 0x7A; c2++) s += String.fromCharCode(c2);
  for (var c3 = 0x30; c3 <= 0x39; c3++) s += String.fromCharCode(c3);
  return s;                                     // A-Z a-z 0-9 — the model's repertoire
})();
var WEIGHT_BY_TYPE = { thin: 100, extralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, heavy: 900, black: 900 };

// ===== pure feature math (raster = array length n*n, row-major; scale-agnostic) =====

// priorL/priorR in RASTER COLUMNS: distance from the ink bbox edge to where the
// cumulative column-ink mass first reaches BAND of the total (mass, not the extreme
// pixel, so a lone spike barely moves it). Returns {pL, pR, inkw} or null.
function areaMarginPrior(ras, n) {
  var col = new Float64Array(n), tot = 0;
  for (var x = 0; x < n; x++) {
    var s = 0;
    for (var y = 0; y < n; y++) s += ras[y * n + x];
    col[x] = s; tot += s;
  }
  if (tot <= 0) return null;
  var left = -1, right = -1;
  for (var i = 0; i < n; i++) { if (col[i] > 0) { if (left < 0) left = i; right = i; } }
  if (left < 0) return null;
  var thr = BAND * tot;
  var cl = 0, edgeL = left;
  for (var a = left; a <= right; a++) { cl += col[a]; if (cl >= thr) { edgeL = a; break; } }   // searchsorted 'left'
  var cr = 0, edgeR = right;
  for (var b = right; b >= left; b--) { cr += col[b]; if (cr >= thr) { edgeR = b; break; } }
  return { pL: Math.max(0, edgeL - left), pR: Math.max(0, right - edgeR), inkw: right - left + 1 };
}

// vertical-run / horizontal-run through the centre — high for high-contrast faces.
function contrastFeat(ras, n, inkThr) {
  var cx = n >> 1, cy = n >> 1, vr = 0, hr = 0;
  for (var y = 0; y < n; y++) if (ras[y * n + cx] > inkThr) vr++;
  for (var x = 0; x < n; x++) if (ras[cy * n + x] > inkThr) hr++;
  vr = vr || 1; hr = hr || 1;
  var hi = Math.max(vr, hr), lo = Math.max(1, Math.min(vr, hr));
  return Math.min(4, hi / lo);
}

// perimeter² / (4π·area) of the silhouette (1 for a disk; high for spiky).
function spikinessFeat(ras, n, inkThr) {
  var ink = new Uint8Array(n * n), area = 0;
  for (var i = 0; i < n * n; i++) { if (ras[i] > inkThr) { ink[i] = 1; area++; } }
  if (area < 8) return 1.0;
  var p = 0, edge = 0;
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      var idx = y * n + x; if (!ink[idx]) continue;
      var b = (y > 0 && !ink[idx - n]) || (y < n - 1 && !ink[idx + n]) ||
              (x > 0 && !ink[idx - 1]) || (x < n - 1 && !ink[idx + 1]);
      if (b) p++;
      if (b || y === 0 || x === 0) edge++;   // Python also counts top-row/left-col ink as boundary
    }
  }
  var perim = Math.max(edge, p);
  return Math.min(6.0, perim * perim / (4.0 * Math.PI * area));
}

// raster-column prior (pL,pR px, inkw cols) → cap-height-unit prior, using the
// glyph's font-unit ink width and the font's cap height. upm cancels:
//   priorL = pL · iwf / (inkw · capH)      (Python: (pL·(iwf/upm)/inkw)/(capH/upm))
function priorCapUnits(pPx, iwfUnits, inkwCols, capHUnits) {
  return pPx * iwfUnits / (Math.max(1, inkwCols) * capHUnits);
}

// Assemble the 8 context scalars in the model's feat_order.
function buildCtx(priorL, priorR, weight, width, contrast, xHcapH, spik, isLower) {
  return [priorL, priorR, weight / 900, width / 9, contrast, xHcapH, spik, isLower ? 1 : 0];
}

// Font outlines are y-UP (baseline 0, ascender +), but glyphreco.rasterize was
// written for image-traced clusters (y-DOWN) — pass font contours straight in and
// the glyph rasterizes UPSIDE-DOWN, which would feed the model a flipped image and a
// wrong `contrast` feature (the horizontal area-margin prior is flip-immune, which is
// why the math parity test didn't catch it). So negate y before rasterizing.
function flipY(contours) {
  function f(q) { return q ? { x: q.x, y: -q.y } : q; }
  return contours.map(function (c) {
    return { closed: c.closed, isHole: c.isHole, points: c.points.map(function (p) {
      return { x: p.x, y: -p.y, type: p.type, handleIn: f(p.handleIn), handleOut: f(p.handleOut) };
    }) };
  });
}

// TRUE curve-extrema ink bounds (samples the cubics via refspace.flattenContour), matching
// the training rasterizer which crops to actual ink (PIL getbbox / fontTools BoundsPen).
// refspace.bezBounds is handle-INCLUSIVE (control points can exceed the ink) → it would
// over-frame the raster and inflate the prior denominator, diverging from training; use
// this for the rasterize bbox + iwf instead.
function inkBounds(contours) {
  var xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (var i = 0; i < contours.length; i++) {
    var poly = refspace.flattenContour(contours[i]);
    for (var j = 0; j < poly.length; j++) {
      var x = poly[j][0], y = poly[j][1];
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
  }
  return { xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax };
}

// ===== onnxruntime-web session (browser-only; mirrors glyphreco's loader) =====
var _root = null, _ready = null, _failed = false, _ort = null, _session = null;
var _inImg = 'input', _inCtx = 'ctx', _outName = 'resid';   // export names; resolved from the session at init

function loadOrt(root) {
  return new Promise(function (resolve, reject) {
    if (typeof window !== 'undefined' && window.ort) return resolve(window.ort);
    var s = document.createElement('script');
    s.src = root + '/js/lib/ort/ort.wasm.min.js';
    s.onload = function () { resolve(window.ort); };
    s.onerror = function () { reject(new Error('could not load ort.wasm.min.js')); };
    document.head.appendChild(s);
  });
}

function init(root) {
  _root = root;
  if (_ready) return _ready;
  _ready = (async function () {
    _ort = await loadOrt(root);
    if (!_ort) throw new Error('ort global missing');
    var ortDir = root + '/js/lib/ort/';
    _ort.env.wasm.wasmPaths = ortDir;
    _ort.env.wasm.numThreads = 1;
    _ort.env.wasm.proxy = false;
    try { _ort.env.wasm.simd = true; } catch (e) {}
    try {
      var wb = fs.readFileSync(ortDir + 'ort-wasm-simd-threaded.wasm');
      _ort.env.wasm.wasmBinary = wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength);
    } catch (e) {}
    var mb = fs.readFileSync(root + '/js/lib/model/spacing.onnx');
    var u8 = new Uint8Array(mb.buffer, mb.byteOffset, mb.byteLength);
    _session = await _ort.InferenceSession.create(u8, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    // resolve I/O names from the session (export order: [image, ctx] → [resid])
    if (_session.inputNames && _session.inputNames.length >= 2) { _inImg = _session.inputNames[0]; _inCtx = _session.inputNames[1]; }
    if (_session.outputNames && _session.outputNames.length) _outName = _session.outputNames[0];
    // warm up (pays the wasm compile cost once)
    var warm = {};
    warm[_inImg] = new _ort.Tensor('float32', new Float32Array(IMG * IMG), [1, 1, IMG, IMG]);
    warm[_inCtx] = new _ort.Tensor('float32', new Float32Array(8), [1, 8]);
    await _session.run(warm);
  })().catch(function (e) { _failed = true; if (typeof console !== 'undefined') console.error('[spacingai] init failed:', e); throw e; });
  return _ready;
}

function isAvailable() { return !!_session && !_failed; }

// Predict per-glyph optical recession (font units) for every drawn A-Z a-z 0-9.
// Returns { glyphName: {recL, recR} } (recession = how much TIGHTER than the
// typical half-air), or {} if the model is unavailable. opts.weight/opts.width
// override the context weight/width class.
async function predict(project, masterId, opts) {
  opts = opts || {};
  if (opts.root) _root = opts.root;             // self-seed: callers pass ROOT so init() never runs on a null root
  if (_failed) return {};
  try { await init(_root); } catch (e) { return {}; }
  if (!_session) return {};
  var M = project.metrics || {}, upm = project.unitsPerEm || 1000;
  var capH = M.capHeight || Math.round(0.7 * upm);
  var xH = M.xHeight || Math.round(0.5 * upm);
  var weight = opts.weight || 400, width = opts.width || 5;

  // collect drawn letters/figures (skip ligatures/alternates/composed — not the model's job)
  var jobs = [];
  for (var gi = 0; gi < project.glyphs.length; gi++) {
    var g = project.glyphs[gi];
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') continue;
    if (g.char == null || g.char.length !== 1 || TRAIN.indexOf(g.char) < 0) continue;
    var L = g.layers && g.layers[masterId];
    if (!L || !L.contours || !L.contours.length) continue;
    var b = refspace.bezBounds(L.contours);
    if (!isFinite(b.xMin) || b.w <= 0) continue;
    jobs.push({ g: g, contours: L.contours, b: b });
  }
  if (!jobs.length) return {};

  // build batched tensors: rasterize + analytic features per glyph
  var N = jobs.length;
  var imgBuf = new Float32Array(N * IMG * IMG), ctxBuf = new Float32Array(N * 8);
  var meta = [];
  for (var j = 0; j < N; j++) {
    var jb = jobs[j];
    // y-flip → upright in a y-down canvas; frame on the TRUE ink bbox (curve extrema, not
    // handles) so the raster + the prior denominator match the training rasterizer.
    var flipped = flipY(jb.contours);
    var ib = inkBounds(flipped);
    var ras = glyphreco.rasterize({ contours: flipped, bbox: [ib.xMin, ib.yMin, ib.xMax, ib.yMax] });
    imgBuf.set(ras, j * IMG * IMG);
    var iwf = ib.xMax - ib.xMin;                  // true ink width, font units (x is flip-invariant)
    var am = areaMarginPrior(ras, IMG);
    var priorL = 0, priorR = 0;
    if (am) {
      priorL = priorCapUnits(am.pL, iwf, am.inkw, capH);
      priorR = priorCapUnits(am.pR, iwf, am.inkw, capH);
    }
    var ctx = buildCtx(priorL, priorR, weight, width,
      contrastFeat(ras, IMG, INK01), capH ? xH / capH : 0.5, spikinessFeat(ras, IMG, INK01),
      jb.g.char >= 'a' && jb.g.char <= 'z');
    ctxBuf.set(ctx, j * 8);
    meta.push({ name: jb.g.name, priorL: priorL, priorR: priorR });
  }

  var feed = {};
  feed[_inImg] = new _ort.Tensor('float32', imgBuf, [N, 1, IMG, IMG]);
  feed[_inCtx] = new _ort.Tensor('float32', ctxBuf, [N, 8]);
  var res = await _session.run(feed);
  var resid = res[_outName].data;   // Float32 [N*2]

  var out = {};
  for (var k = 0; k < N; k++) {
    var residL = resid[k * 2], residR = resid[k * 2 + 1];
    // Reconstructed TOTAL recession (prior+resid), cap units. Bounded [-0.12, 0.6]: the
    // negative side LETS narrow uprights (I l i J 1) the model wants LOOSER than the typical
    // air actually open (recession<0 → oL=optHalf−recL > optHalf); 0.6 caps an extreme
    // pull-in. (This is the reconstructed target's domain — NOT the train-time resid clamp
    // [-0.6,0.6] in render_spacing.py, which clamps resid alone.)
    var dL = Math.max(-0.12, Math.min(0.6, meta[k].priorL + residL));
    var dR = Math.max(-0.12, Math.min(0.6, meta[k].priorR + residR));
    out[meta[k].name] = { recL: dL * capH, recR: dR * capH };       // → font units (pull-in from optHalf)
  }
  return out;
}

module.exports = {
  init: init, isAvailable: isAvailable, predict: predict,
  // pure math (parity-tested):
  areaMarginPrior: areaMarginPrior, contrastFeat: contrastFeat, spikinessFeat: spikinessFeat,
  priorCapUnits: priorCapUnits, buildCtx: buildCtx, TRAIN: TRAIN, IMG: IMG, BAND: BAND,
};
