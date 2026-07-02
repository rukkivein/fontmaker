'use strict';
/* Offline kern model for Visual Kern (CEP panel, Track B).
 *
 * Auto-selects whichever model is bundled in js/lib/model/:
 *   - paragraph.onnx  -> the running-strip CONTEXT model (predictParagraph): each gap judged
 *     inside a 6-glyph neighbor window (the user's "learn a paragraph's rhythm" vision).
 *   - kernpair.onnx   -> the pairwise model (predictPair): isolated 2-glyph silhouette.
 * Either way it returns a per-pair PROPOSED kern that main.js seeds into kernvision.buildKernVision,
 * which VERIFIES + refines each in a tight ±0.025em window and guarantees no collision before it
 * ships. The model proposes; the optical scorer confirms.
 *
 * SAFE BY DESIGN: no model bundled / any error -> predict() resolves to {} and Visual Kern falls
 * back to the full kernvision search. Single-thread main-thread WASM (CEP has no SharedArrayBuffer).
 */
var fs = require('fs');
var kernvision = require('./kernvision.js');

var _root = null, _ready = null, _failed = false;
var _ort = null, _session = null, _imgName = null, _ctxName = null, _outName = null, _meta = null, _mode = null;

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

function init(root) {
  _root = root;
  if (_ready) return _ready;
  _ready = (async function () {
    var dir = root + '/js/lib/model/';
    var modelPath, metaPath;
    if (fs.existsSync(dir + 'paragraph.onnx')) { modelPath = dir + 'paragraph.onnx'; metaPath = dir + 'paragraph_meta.json'; _mode = 'paragraph'; }
    else if (fs.existsSync(dir + 'kernpair.onnx')) { modelPath = dir + 'kernpair.onnx'; metaPath = dir + 'kernpair_meta.json'; _mode = 'pair'; }
    else throw new Error('no kern model bundled');
    _ort = await loadOrtScript(root);
    if (!_ort) throw new Error('ort global missing after load');
    var ortDir = root + '/js/lib/ort/';
    _ort.env.wasm.wasmPaths = ortDir;
    _ort.env.wasm.numThreads = 1;
    _ort.env.wasm.proxy = false;
    try { _ort.env.wasm.simd = true; } catch (e) {}
    try {
      var wb = fs.readFileSync(ortDir + 'ort-wasm-simd-threaded.wasm');
      _ort.env.wasm.wasmBinary = wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength);
    } catch (e) {}
    try { _meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { _meta = {}; }
    var mb = fs.readFileSync(modelPath);
    _session = await _ort.InferenceSession.create(new Uint8Array(mb.buffer, mb.byteOffset, mb.byteLength),
      { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    _imgName = _session.inputNames[0]; _ctxName = _session.inputNames[1]; _outName = _session.outputNames[0];
    // warm up at the mode's input shape
    var shp = _mode === 'paragraph' ? [1, 1, kernvision.PARA_HC, kernvision.PARA_WC] : [1, 2, kernvision.KP_HC, kernvision.KP_WC];
    var warmI = new _ort.Tensor('float32', new Float32Array(shp[1] * shp[2] * shp[3]), shp);
    var warmC = new _ort.Tensor('float32', new Float32Array(6), [1, 6]);
    var feed = {}; feed[_imgName] = warmI; feed[_ctxName] = warmC;
    await _session.run(feed);
  })().catch(function (e) { _failed = true; if (window.console) console.error('[kernai] init failed:', e); throw e; });
  return _ready;
}

function isAvailable() { return !!_session && !_failed; }
function mode() { return _mode; }

function isLower(u) { return (u >= 0x61 && u <= 0x7A) ? 1 : 0; }

// shared setup: per-glyph profiles + neutral neighbor + context scalars
function _prep(f, mid, filled) {
  var upm = f.unitsPerEm || 1000, M = f.metrics || {};
  var capH = M.capHeight || Math.round(0.7 * upm), xH = M.xHeight || Math.round(0.5 * upm);
  var weight = (f.meta && (f.meta.weightClass || f.meta.weight)) || 400;
  var width = (f.meta && (f.meta.widthClass || f.meta.width)) || 5;
  var rows = kernvision.modelBandRows(upm);
  var prof = [];                                   // indexed parallel to `filled`
  for (var g = 0; g < filled.length; g++) prof.push(kernvision.glyphProfile(f, mid, filled[g], rows));
  // neutral neighbor index (n / o / H / first present)
  var nb = 0;
  var want = { 'n': 1, 'o': 1, 'H': 1, 'a': 1 };
  for (var k = 0; k < filled.length; k++) { if (want[filled[k].char]) { nb = k; break; } }
  return { upm: upm, capH: capH, xH: xH, weight: weight, width: width, prof: prof, nb: nb,
    ctxBase: [weight / 900, width / 9, capH / upm, capH ? (xH / capH) : 0.5] };
}

async function predict(f, mid, filled, opts) {
  opts = opts || {};
  if (opts.root) _root = opts.root;   // self-seed: callers pass ROOT so init() never runs on a null root
  if (_failed) return {};
  try { await init(_root); } catch (e) { return {}; }
  if (!_session || !filled || filled.length < 2) return {};
  try {
    var P = _prep(f, mid, filled);
    var upm = P.upm, capH = P.capH, kMin = -0.12 * upm, kMax = 0.06 * upm;
    var para = _mode === 'paragraph';
    var H = para ? kernvision.PARA_HC : kernvision.KP_HC, W = para ? kernvision.PARA_WC : kernvision.KP_WC;
    var CHAN = para ? 1 : 2, IMGN = CHAN * H * W, CH = para ? 800 : 1500;
    var pairs = [];
    for (var i = 0; i < filled.length; i++) for (var j = 0; j < filled.length; j++) {
      if (i === j || !P.prof[i] || !P.prof[j]) continue;
      pairs.push([i, j]);
    }
    var out = {};
    for (var c = 0; c < pairs.length; c += CH) {
      var chunk = pairs.slice(c, c + CH), n = chunk.length;
      var imgBuf = new Float32Array(n * IMGN), ctxBuf = new Float32Array(n * 6);
      for (var p = 0; p < n; p++) {
        var i2 = chunk[p][0], j2 = chunk[p][1], sil;
        if (para) {
          // 6-glyph window: [nb, nb, center-left, center-right, nb, nb] at natural advance (all kerns 0)
          sil = kernvision.stripSilhouette(P.prof, [P.nb, P.nb, i2, j2, P.nb, P.nb], [0, 0, 0, 0, 0], upm);
        } else {
          sil = kernvision.pairSilhouette(P.prof[i2], P.prof[j2], P.prof[i2].adv, 0, upm);
        }
        imgBuf.set(sil, p * IMGN);
        var b = p * 6;
        ctxBuf[b] = P.ctxBase[0]; ctxBuf[b + 1] = P.ctxBase[1]; ctxBuf[b + 2] = P.ctxBase[2]; ctxBuf[b + 3] = P.ctxBase[3];
        ctxBuf[b + 4] = isLower(filled[i2].unicode || 0); ctxBuf[b + 5] = isLower(filled[j2].unicode || 0);
      }
      var ti = new _ort.Tensor('float32', imgBuf, [n, CHAN, H, W]);
      var tc = new _ort.Tensor('float32', ctxBuf, [n, 6]);
      var feed = {}; feed[_imgName] = ti; feed[_ctxName] = tc;
      var res = await _session.run(feed);
      var resid = res[_outName].data;
      for (var q = 0; q < n; q++) {
        var v = resid[q] * capH;
        if (v < kMin) v = kMin; else if (v > kMax) v = kMax;
        out[filled[chunk[q][0]].name + ',' + filled[chunk[q][1]].name] = Math.round(v);
      }
    }
    return out;
  } catch (e) {
    if (window.console) console.error('[kernai] predict failed:', e);
    return {};
  }
}

module.exports = { init, isAvailable, mode, predict };
