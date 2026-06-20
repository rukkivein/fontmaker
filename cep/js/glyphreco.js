'use strict';
/* Offline glyph recognition for Image Import (CEP panel).
 *
 * Runs the trained MobileNetV3-Small (glyph_int8.onnx, ~6.5MB) via
 * onnxruntime-web (WASM) entirely on-device. Rasterizes a traced glyph's
 * contours to the SAME 96x96 grayscale (white-on-black, bbox-normalized, 10%
 * margin) the model was trained on, runs inference, and returns the most likely
 * character — optionally restricted to the sheet's script (resolves Latin/
 * Cyrillic/Greek homoglyphs like A/А/Α using the sheet category as a prior).
 *
 * SAFE BY DESIGN: if the runtime/model fails to load, every call resolves to
 * null and the caller falls back to positional mapping, so Image Import always
 * works. Inference is single-threaded on the main thread (CEP has no
 * SharedArrayBuffer), so callers process a sheet in CHUNKS to keep the UI alive.
 */
var fs = require('fs');
var IMG = 96, MARGIN = 0.10, SS = 256; // must match ml/render_dataset.py

var _root = null, _ready = null, _failed = false;
var _ort = null, _session = null, _inName = null, _outName = null;
var _labels = null, _cpToIdx = null;

function loadOrtScript(root) {
  return new Promise(function (resolve, reject) {
    if (typeof window !== 'undefined' && window.ort) return resolve(window.ort);
    var s = document.createElement('script');
    s.src = root + '/js/lib/ort/ort.wasm.min.js';
    s.onload = function () { resolve(window.ort); };
    s.onerror = function () { reject(new Error('could not load ort.wasm.min.js')); };
    document.head.appendChild(s);
  });
}

// Lazy one-time init. Returns a promise that resolves when ready, or rejects
// (then _failed stays true and recognize() no-ops).
function init(root) {
  _root = root;
  if (_ready) return _ready;
  _ready = (async function () {
    _ort = await loadOrtScript(root);
    if (!_ort) throw new Error('ort global missing after load');
    var ortDir = root + '/js/lib/ort/';
    _ort.env.wasm.wasmPaths = ortDir;          // for the emscripten .mjs glue
    _ort.env.wasm.numThreads = 1;              // CEP: no SharedArrayBuffer
    _ort.env.wasm.proxy = false;               // Blob worker is CSP-blocked
    try { _ort.env.wasm.simd = true; } catch (e) {}
    // hand the wasm bytes directly so it never needs to fetch() a file:// url
    try {
      var wb = fs.readFileSync(ortDir + 'ort-wasm-simd-threaded.wasm');
      _ort.env.wasm.wasmBinary = wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength);
    } catch (e) { /* fall back to wasmPaths fetch */ }

    _labels = JSON.parse(fs.readFileSync(root + '/js/lib/model/labels.json', 'utf8'));
    _cpToIdx = {};
    for (var i = 0; i < _labels.classes.length; i++) _cpToIdx[_labels.classes[i].cp] = i;

    var mb = fs.readFileSync(root + '/js/lib/model/glyph_int8.onnx');
    var u8 = new Uint8Array(mb.buffer, mb.byteOffset, mb.byteLength);
    _session = await _ort.InferenceSession.create(u8, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    _inName = _session.inputNames[0];
    _outName = _session.outputNames[0];

    // warm up (first run pays the wasm compile cost)
    var warm = new _ort.Tensor('float32', new Float32Array(IMG * IMG), [1, 1, IMG, IMG]);
    await _session.run({ [_inName]: warm });
  })().catch(function (e) { _failed = true; if (window.console) console.error('[glyphreco] init failed:', e); throw e; });
  return _ready;
}

function isAvailable() { return !!_session && !_failed; }

// Rasterize one cluster's contours -> Float32 [IMG*IMG], white ink on black,
// bbox-normalized with MARGIN, centered — matching render_dataset.py exactly.
function rasterize(cluster) {
  var b = cluster.bbox || boundsOf(cluster.contours);
  var bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  var pad = Math.round(IMG * MARGIN), target = IMG - 2 * pad;
  var scale = (SS * (target / IMG)) / Math.max(bw, bh);

  var cv = document.createElement('canvas'); cv.width = SS; cv.height = SS;
  var g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, SS, SS);
  g.save();
  g.translate((SS - bw * scale) / 2 - b[0] * scale, (SS - bh * scale) / 2 - b[1] * scale);
  g.scale(scale, scale);
  var path = new Path2D();
  cluster.contours.forEach(function (c) {
    var pts = c.points; if (!pts || pts.length < 2) return;
    path.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i <= pts.length; i++) {
      var prev = pts[i - 1], cur = pts[i % pts.length];
      if (prev.handleOut || cur.handleIn) {
        var c1 = prev.handleOut || prev, c2 = cur.handleIn || cur;
        path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, cur.x, cur.y);
      } else { path.lineTo(cur.x, cur.y); }
    }
    path.closePath();
  });
  g.fillStyle = '#fff'; g.fill(path, 'evenodd');   // counters become holes
  g.restore();

  var out = document.createElement('canvas'); out.width = IMG; out.height = IMG;
  var o = out.getContext('2d'); o.drawImage(cv, 0, 0, IMG, IMG);
  var d = o.getImageData(0, 0, IMG, IMG).data;
  var f = new Float32Array(IMG * IMG);
  for (var i = 0; i < IMG * IMG; i++) f[i] = d[i * 4] / 255;   // R channel
  return f;
}

function boundsOf(contours) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  contours.forEach(function (c) {
    c.points.forEach(function (p) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    });
  });
  return [x0, y0, x1, y1];
}

// Softmax over the candidate set (whole repertoire if allowedIdx is null) and the
// top-K candidates by logit — partial selection, no full sort of 4796 classes.
function softmaxTop(logits, allowedIdx, k) {
  k = k || 3;
  var idxList = allowedIdx || null;
  var cnt = idxList ? idxList.length : logits.length;
  var mx = -Infinity;
  for (var i = 0; i < cnt; i++) { var ix = idxList ? idxList[i] : i; if (logits[ix] > mx) mx = logits[ix]; }
  var sum = 0;
  for (var j = 0; j < cnt; j++) { var jx = idxList ? idxList[j] : j; sum += Math.exp(logits[jx] - mx); }
  sum = sum || 1;
  var top = [];
  for (var t = 0; t < cnt; t++) {
    var tx = idxList ? idxList[t] : t, v = logits[tx];
    if (top.length < k || v > top[top.length - 1].v) {
      var pos = top.length;
      while (pos > 0 && top[pos - 1].v < v) pos--;
      top.splice(pos, 0, { idx: tx, v: v });
      if (top.length > k) top.pop();
    }
  }
  return top.map(function (e) { return { idx: e.idx, conf: Math.exp(e.v - mx) / sum }; });
}

// Codepoint set -> model class indices (null = whole repertoire). Built ONCE per
// sheet by recognizeSheet so the per-glyph hot path skips the cp->idx mapping.
function cpsToIdx(allowedCps) {
  if (!allowedCps || !allowedCps.length) return null;
  var out = [];
  for (var i = 0; i < allowedCps.length; i++) { var ix = _cpToIdx[allowedCps[i]]; if (ix != null) out.push(ix); }
  return out.length ? out : null;
}

// Recognize one cluster. allowedCps = codepoints to restrict to (or null for the
// whole repertoire); idxList = a precomputed index list (takes precedence, built
// once per sheet). Returns { char, cp, conf, candidates:[{char,cp,conf}×3] }
// (candidates[0] === the top result) or null if the model is unavailable.
async function recognizeOne(cluster, allowedCps, idxList) {
  if (_failed) return null;
  try { await init(_root); } catch (e) { return null; }
  if (!_session) return null;
  var allowedIdx = idxList || cpsToIdx(allowedCps);
  var f = rasterize(cluster);
  var t = new _ort.Tensor('float32', f, [1, 1, IMG, IMG]);
  var res = await _session.run({ [_inName]: t });
  var logits = res[_outName].data;
  var top = softmaxTop(logits, allowedIdx, 3);
  if (!top.length || top[0].idx < 0) return null;
  var candidates = top.map(function (tp) { var cls = _labels.classes[tp.idx]; return { char: cls.char, cp: cls.cp, conf: tp.conf }; });
  var best = candidates[0];
  return { char: best.char, cp: best.cp, conf: best.conf, candidates: candidates };
}

// Recognize a whole sheet in CHUNKS (yields to the UI between chunks so the
// panel never freezes). Builds the candidate index list ONCE. onProgress(done,
// total) is called per chunk.
async function recognizeSheet(clusters, allowedCps, onProgress) {
  var out = new Array(clusters.length);
  if (_failed) return out;
  try { await init(_root); } catch (e) { return out; }
  if (!_session) return out;
  var idxList = cpsToIdx(allowedCps);
  var CHUNK = 8;
  for (var i = 0; i < clusters.length; i += CHUNK) {
    for (var j = i; j < Math.min(i + CHUNK, clusters.length); j++) {
      try { out[j] = await recognizeOne(clusters[j], null, idxList); } catch (e) { out[j] = null; }
    }
    if (onProgress) onProgress(Math.min(i + CHUNK, clusters.length), clusters.length);
    await new Promise(function (r) { setTimeout(r, 0); });   // let the UI breathe
  }
  return out;
}

// Codepoints from the model's repertoire that fall in any [lo,hi] range — lets the
// caller scope recognition to a script (Latin / Arabic / Hiragana / …). Requires
// init() to have loaded the labels; returns null if not ready or nothing matches.
function cpsInRanges(ranges) {
  if (!_labels || !ranges || !ranges.length) return null;
  var out = [];
  for (var i = 0; i < _labels.classes.length; i++) {
    var cp = _labels.classes[i].cp;
    for (var r = 0; r < ranges.length; r++) { if (cp >= ranges[r][0] && cp <= ranges[r][1]) { out.push(cp); break; } }
  }
  return out.length ? out : null;
}

module.exports = { init, isAvailable, recognizeOne, recognizeSheet, cpsInRanges, IMG };
