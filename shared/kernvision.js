'use strict';
// === Visual Kerning Trainer — Track A (offline, no model) ============================
// "Look at the text once and make the gaps FEEL optically equal."
//
// The live opticalKern (main.js) / optimizer.optimizeKerning judge a pair by its
// CLOSEST APPROACH (robustGap = p15 of the per-height profile distance). That is a
// COLLISION metric: great at "do these two touch?", blind to "how much WHITE does the
// eye see between them?". A and V never come close yet read far too open, because the
// eye integrates the whole triangular wedge of white, not the single nearest band.
//
// kernvision judges a pair by its WHITE AREA instead: the per-row gap between the two
// ink profiles, summed over the glyphs' vertical extent — but each row's gap is CLAMPED
// to a max depth so a deep opening (the AV wedge, the white under a T arm) cannot run
// away and over-count. Then it kerns every pair so its clamped white area matches the
// font's TYPICAL pair white (the median over all pairs) — i.e. all the gaps carry the
// same amount of visible air → the rhythm looks even. The depth clamp is exactly what
// lets open pairs (AV / To / Yo / PA) tuck in while straight pairs (HH / nn) stay put.
//
// PURE DATA: no canvas, no model. The white-area integral over the outline profiles is
// the same quantity a pixel count would give, but exact and fast, so this runs in-panel
// in a blink AND is Node-testable. It is the in-program scorer Track B will later be
// trained to imitate (its output is the self-supervised label), and the value it writes
// is what SHIPS — main.js seats it on f.kernOverride, which opticalKern returns first,
// so the tester preview and the exported kern table are byte-identical to it.
//
// Operates on the project model (font units, y-up), reusing optimizer.flatten/buildRef
// so the flattening + reference metrics match the rest of the engine exactly.

var optimizer = require('./optimizer');

function layerOf(g, mid) { return g.layers && g.layers[mid]; }
function drawn(g, mid) { var l = layerOf(g, mid); return !!(l && l.contours && l.contours.length); }
function median(a) {
  a = a.filter(function (v) { return v != null && isFinite(v); }).sort(function (x, y) { return x - y; });
  return a.length ? a[a.length >> 1] : null;
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Per-row ink extents of a flattened glyph: at scan height y, the LEFTMOST (min) and
// RIGHTMOST (max) ink x. null where the glyph has no ink at that row (it is "open" there).
function rowExtent(segs, y) {
  var min = Infinity, max = -Infinity;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i], y1 = s[1], y2 = s[3];
    if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
      var x = (y2 === y1) ? s[0] : s[0] + (s[2] - s[0]) * (y - y1) / (y2 - y1);
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return min > max ? null : { min: min, max: max };
}

// Precompute, for one glyph, the right-edge (of L) and left-edge (of R) profile at each
// sampled row — both are needed because a glyph can be the left OR right member of a pair.
function glyphProfile(project, mid, g, rows) {
  var segs = optimizer.flatten(layerOf(g, mid).contours);
  var right = new Array(rows.length), left = new Array(rows.length);
  for (var r = 0; r < rows.length; r++) {
    var e = rowExtent(segs, rows[r]);
    right[r] = e ? e.max : null;   // rightmost ink of this glyph at row r
    left[r] = e ? e.min : null;    // leftmost  ink of this glyph at row r
  }
  return { name: g.name, adv: g.advanceWidth, right: right, left: left };
}

// The clamped white AREA between L (left) and R (right) when R is shifted by `kern`.
// Returns { area, collided, both } where area is the summed clamped per-row gap, collided
// is true if any row where BOTH glyphs have ink closes below the hard floor (ink touch),
// and both is the count of shared-ink rows (kern-INVARIANT — vertical overlap doesn't move).
function whiteArea(L, R, kern, P) {
  var area = 0, collided = false, n = P.rows.length, both = 0;
  for (var r = 0; r < n; r++) {
    var lr = L.right[r], rl = R.left[r];
    if (lr == null || rl == null) continue;        // only rows where BOTH glyphs have ink:
    both++;                                         // those are the gap kern can actually change.
    var gap = (L.adv + kern + rl) - lr;            // absolute white between the two facing inks
    if (gap < P.floor) collided = true;            // ink touches / overlaps at this row
    area += clamp(gap, 0, P.maxDepth);
    // NOTE: rows where only one glyph has ink (the open space above an 'o' next to a 'T',
    // a cap-height stem facing an x-height letter) are NOT counted — that white is a VERTICAL
    // mismatch kerning cannot fix, and counting it made tall+short pairs over-tighten to the
    // search floor. The eye judges the FACING gap in the overlap band; that is what we equalize.
  }
  return { area: both ? area : 0, collided: collided, both: both };
}

// Search the kern that brings this pair's clamped white area to `target`, never colliding.
// area(kern) is monotonically INCREASING in kern (push R right → more white), so a coarse
// sweep + local refine lands on the crossing; collided candidates are rejected and we fall
// back to the loosest safe kern. Returns the FULL correction (before aggressiveness).
// kLo/kHi (optional) restrict the range — used to VERIFY+refine an AI model's proposal in a
// tight window (Track B seeds Track A) instead of scanning the whole range.
function searchPairKern(L, R, target, P, kLo, kHi) {
  if (kLo == null) kLo = P.kMin;
  if (kHi == null) kHi = P.kMax;
  var best = kHi, bestErr = Infinity, safeMin = kLo;   // default to the loosest (safest) in range
  for (var k = kLo; k <= kHi + 1e-6; k += P.coarse) {
    var w = whiteArea(L, R, k, P);
    if (w.collided) { safeMin = Math.max(safeMin, k + P.coarse); continue; }
    var err = Math.abs(w.area - target);
    if (err < bestErr) { bestErr = err; best = k; }
  }
  var lo = Math.max(safeMin, best - P.coarse), hi = Math.min(kHi, best + P.coarse);
  for (var k2 = lo; k2 <= hi + 1e-6; k2 += P.fine) {
    var w2 = whiteArea(L, R, k2, P);
    if (w2.collided) continue;
    var err2 = Math.abs(w2.area - target);
    if (err2 < bestErr) { bestErr = err2; best = k2; }
  }
  return best;
}

// Build the 2-channel pair SILHOUETTE the Track B model consumes — MUST match Python
// render_pair in ml/train_kernpair.py exactly (HC=64, WC=96, PXEM=56, joint-centered, row
// flipped). L/R are glyphProfile results {left[],right[]} (font units, null = no ink at row);
// returns a Float32Array [2*HC*WC] (ch0 = left glyph, ch1 = right glyph, NCHW).
var KP_HC = 64, KP_WC = 96, KP_PXEM = 56;
function pairSilhouette(L, R, advL, kern, upm) {
  var s = KP_PXEM / upm, H = KP_HC, W = KP_WC;
  var minx = Infinity, maxx = -Infinity, r, a, b;
  for (r = 0; r < H; r++) {
    if (L.left[r] != null) { if (L.left[r] < minx) minx = L.left[r]; if (L.right[r] > maxx) maxx = L.right[r]; }
    if (R.left[r] != null) {
      var rl = R.left[r] + advL + kern, rr = R.right[r] + advL + kern;
      if (rl < minx) minx = rl; if (rr > maxx) maxx = rr;
    }
  }
  var img = new Float32Array(2 * H * W);
  if (!isFinite(minx)) return img;
  var ox = W / 2 - 0.5 * (minx + maxx) * s, ch1 = H * W;
  for (r = 0; r < H; r++) {
    var rr2 = H - 1 - r;
    if (L.left[r] != null && L.right[r] != null) {
      var x0 = Math.trunc(L.left[r] * s + ox), x1 = Math.trunc(L.right[r] * s + ox) + 1;
      x0 = x0 < 0 ? 0 : (x0 > W ? W : x0); x1 = x1 < 0 ? 0 : (x1 > W ? W : x1);
      for (var x = x0; x < x1; x++) img[rr2 * W + x] = 1;
    }
    if (R.left[r] != null && R.right[r] != null) {
      a = R.left[r] + advL + kern; b = R.right[r] + advL + kern;
      var y0 = Math.trunc(a * s + ox), y1 = Math.trunc(b * s + ox) + 1;
      y0 = y0 < 0 ? 0 : (y0 > W ? W : y0); y1 = y1 < 0 ? 0 : (y1 > W ? W : y1);
      for (var x2 = y0; x2 < y1; x2++) img[ch1 + rr2 * W + x2] = 1;
    }
  }
  return img;
}
// the fixed scan band the model + glyphProfile must share (em fractions, 64 rows)
function modelBandRows(upm) {
  var lo = -0.30 * upm, hi = 1.00 * upm, rows = [];
  for (var r = 0; r < KP_HC; r++) rows.push(lo + (hi - lo) * r / (KP_HC - 1));
  return rows;
}

// === PARAGRAPH (running-strip) model input — byte-parity twin of ml/train_paragraph.py
// render_strip. A 6-glyph window (2 neighbors | center pair | 2 neighbors), composited at true
// advances+kerns, centered so the ANALYZED gap (the center pair's pen boundary) sits at W/2.
// Single channel. profs = array of glyphProfile {left[64],right[64],adv} indexed by `seq` values;
// kerns = [k01,k12,kCenter,k34,k45] font units. Returns Float32Array [PARA_HC*PARA_WC].
var PARA_HC = 80, PARA_WC = 192, PARA_PXEM = 48, PARA_CTXN = 2;
function stripSilhouette(profs, seq, kerns, upm) {
  var s = PARA_PXEM / upm, H = PARA_HC, W = PARA_WC, n;
  var penx = [0];
  for (n = 1; n < 6; n++) penx.push(penx[n - 1] + profs[seq[n - 1]].adv + kerns[n - 1]);
  var ox = W / 2 - penx[3] * s, img = new Float32Array(H * W);   // center on the center-pair pen boundary
  for (n = 0; n < 6; n++) {
    var P = profs[seq[n]], px = penx[n];
    for (var r = 0; r < KP_HC; r++) {                            // 64 source rows -> rows 16..79
      var rr = H - 1 - r;
      if (P.left[r] != null && P.right[r] != null) {
        var x0 = Math.trunc((P.left[r] + px) * s + ox), x1 = Math.trunc((P.right[r] + px) * s + ox) + 1;
        x0 = x0 < 0 ? 0 : (x0 > W ? W : x0); x1 = x1 < 0 ? 0 : (x1 > W ? W : x1);
        for (var x = x0; x < x1; x++) img[rr * W + x] = 1;
      }
    }
  }
  return img;
}

// === public: compute a vision-optical kern table for the whole font.
//   opts.aggr        0..1  how much of the full correction to apply (default 0.6)
//   opts.maxDepthFrac      per-row gap clamp as a fraction of em (default 0.33)
//   opts.floorFrac         hard collision floor as a fraction of em (default 0.012)
//   opts.rows              number of vertical scan rows (default 72)
//   opts.thresh            drop |kern| below this many units (default 6)
// Returns { table:{'L,R':units}, target, pairs, glyphs, variance }.
function buildKernVision(project, mid, opts) {
  opts = opts || {};
  var ref = optimizer.buildRef(project, mid);
  var upm = ref.upm;
  var aggr = opts.aggr == null ? 0.6 : clamp(opts.aggr, 0, 1);
  var nRows = opts.rows || 72;
  var thresh = opts.thresh == null ? 6 : opts.thresh;

  var filled = project.glyphs.filter(function (g) {
    return drawn(g, mid) && g.char && (g.unicode >= 0x21) &&
      g.kind !== 'ligature' && g.kind !== 'alternate' && g.kind !== 'composed';
  });
  if (filled.length < 2) return { table: {}, target: 0, pairs: 0, glyphs: filled.length, variance: 0 };

  // vertical band = the union ink extent of the filled glyphs (descender..ascender),
  // padded a hair, sampled at nRows even heights.
  var yLo = Infinity, yHi = -Infinity;
  filled.forEach(function (g) {
    var b = optimizer.bezBounds(layerOf(g, mid).contours);
    if (isFinite(b.yMin) && b.yMin < yLo) yLo = b.yMin;
    if (isFinite(b.yMax) && b.yMax > yHi) yHi = b.yMax;
  });
  if (!isFinite(yLo) || !isFinite(yHi) || yHi <= yLo) { yLo = 0; yHi = ref.capHeight || Math.round(0.7 * upm); }
  var rows = [];
  for (var r = 0; r < nRows; r++) rows.push(yLo + (yHi - yLo) * r / (nRows - 1));

  var P = {
    rows: rows,
    maxDepth: Math.round((opts.maxDepthFrac == null ? 0.33 : opts.maxDepthFrac) * upm),
    floor: Math.round((opts.floorFrac == null ? 0.012 : opts.floorFrac) * upm),
    kMin: -Math.round(0.12 * upm), kMax: Math.round(0.06 * upm),
    coarse: Math.max(2, Math.round(0.01 * upm)), fine: Math.max(1, Math.round(0.002 * upm)),
  };

  // profiles once per glyph (right-edge + left-edge at every row)
  var prof = {};
  filled.forEach(function (g) { prof[g.name] = glyphProfile(project, mid, g, rows); });

  // target = median clamped white area over EVERY ordered pair at zero kern = the font's
  // typical pair white (measured the same way each pair is, so straight pairs land ~0).
  // w0map keeps each pair's kern-0 measurement so the kern loop can skip row-disjoint pairs
  // (both === 0 is kern-invariant) without re-scanning.
  var areas0 = [], boths0 = [], w0map = {};
  for (var a = 0; a < filled.length; a++) for (var b = 0; b < filled.length; b++) {
    if (a === b) continue;
    var w0 = whiteArea(prof[filled[a].name], prof[filled[b].name], 0, P);
    w0map[filled[a].name + ',' + filled[b].name] = w0;
    if (w0.both) boths0.push(w0.both);
    if (w0.area > 0 && !w0.collided) areas0.push(w0.area);
  }
  var target = median(areas0);
  if (!target) {
    // Degenerate font: EVERY ordered pair is collided (or row-disjoint) at kern 0 — e.g. a raw
    // template import whose advances equal the ink width. A zero target would seat every pair
    // just above the collision floor (max tightening); instead synthesize an area-scale target
    // from the font's own air gap × the typical shared-ink row count, so the search LOOSENS
    // the pairs toward sane air.
    var airGap = 0;
    try { airGap = optimizer.fontAirTargetUnits(project, mid) || 0; } catch (e) { airGap = 0; }
    if (!airGap) airGap = Math.round(0.04 * upm);
    target = Math.round(airGap * (median(boths0) || Math.round(nRows / 2)));
  }

  // kern every ordered pair toward the target, scale by aggressiveness, clamp + threshold.
  // opts.seeds (optional) = the Track B model's per-pair proposal {key: units}; when present we
  // only VERIFY+refine in a tight window around it (model proposes, optical scorer confirms +
  // guarantees no collision) instead of the full sweep.
  var seeds = opts.seeds || null, seedW = Math.round(0.025 * upm);
  var table = {}, pairs = 0, resid = [];
  for (var i = 0; i < filled.length; i++) {
    for (var j = 0; j < filled.length; j++) {
      if (i === j) continue;
      var key = filled[i].name + ',' + filled[j].name;
      var L = prof[filled[i].name], R = prof[filled[j].name];
      // Row-disjoint pairs (period vs apostrophe): whiteArea is identically 0 over the whole
      // search range, so the search would degenerate to its first candidate (max tightening).
      // Vertical overlap is kern-invariant → no shared rows at kern 0 means never — skip.
      var w0p = w0map[key];
      if (!w0p || !w0p.both) continue;
      var full;
      if (seeds && seeds[key] != null) {
        var sd = seeds[key];
        full = searchPairKern(L, R, target, P, Math.max(P.kMin, sd - seedW), Math.min(P.kMax, sd + seedW));
        // A bad seed can put the whole verify window inside the collision zone, where the
        // search returns the window edge (still colliding) — fall back to the full sweep.
        if (whiteArea(L, R, full, P).collided) full = searchPairKern(L, R, target, P);
      } else {
        full = searchPairKern(L, R, target, P);
      }
      var v = Math.round(clamp(aggr * full, P.kMin, P.kMax));
      // The search result is collision-safe, but scaling by aggr can pull a LOOSENING
      // correction (needed to clear the collision floor) back INTO the collision zone —
      // walk it back out so the "never ships a collision" contract holds after scaling.
      var wv = whiteArea(L, R, v, P);
      var bumped = false;
      while (wv.collided && v < P.kMax) {
        v += P.fine; bumped = true;
        wv = whiteArea(L, R, v, P);
      }
      // record post-kern evenness residual for the variance report (uses applied v)
      if (wv.area > 0) resid.push(wv.area - target);
      // a collision-clearing bump must ship even below the visibility threshold
      if ((bumped && v !== 0) || Math.abs(v) >= thresh) { table[key] = v; pairs++; }
    }
  }

  // evenness = variance of (white area − target) across pairs AFTER kerning; lower = more even.
  var variance = 0;
  if (resid.length) {
    var m = resid.reduce(function (s, x) { return s + x; }, 0) / resid.length;
    variance = resid.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / resid.length;
  }
  return { table: table, target: target, pairs: pairs, glyphs: filled.length, variance: variance };
}

// Evenness variance of the white-area field for an ARBITRARY kern table (or none) — the
// headless test calls this to assert the rhythm got more even (variance dropped) and that
// no pair collides. `getKern(Lname,Rname)` returns the kern to apply (0 if absent).
function evennessReport(project, mid, getKern, opts) {
  opts = opts || {};
  var ref = optimizer.buildRef(project, mid), upm = ref.upm, nRows = opts.rows || 72;
  var filled = project.glyphs.filter(function (g) {
    return drawn(g, mid) && g.char && (g.unicode >= 0x21) &&
      g.kind !== 'ligature' && g.kind !== 'alternate' && g.kind !== 'composed';
  });
  var yLo = Infinity, yHi = -Infinity;
  filled.forEach(function (g) {
    var b = optimizer.bezBounds(layerOf(g, mid).contours);
    if (isFinite(b.yMin) && b.yMin < yLo) yLo = b.yMin;
    if (isFinite(b.yMax) && b.yMax > yHi) yHi = b.yMax;
  });
  if (yHi <= yLo) { yLo = 0; yHi = ref.capHeight || Math.round(0.7 * upm); }
  var rows = [];
  for (var r = 0; r < nRows; r++) rows.push(yLo + (yHi - yLo) * r / (nRows - 1));
  var P = {
    rows: rows,
    maxDepth: Math.round((opts.maxDepthFrac == null ? 0.33 : opts.maxDepthFrac) * upm),
    floor: Math.round((opts.floorFrac == null ? 0.012 : opts.floorFrac) * upm),
  };
  var prof = {};
  filled.forEach(function (g) { prof[g.name] = glyphProfile(project, mid, g, rows); });
  var areas = [], collisions = 0;
  for (var i = 0; i < filled.length; i++) for (var j = 0; j < filled.length; j++) {
    if (i === j) continue;
    var k = getKern ? (getKern(filled[i].name, filled[j].name) || 0) : 0;
    var w = whiteArea(prof[filled[i].name], prof[filled[j].name], k, P);
    if (w.area > 0) areas.push(w.area);
    if (w.collided) collisions++;
  }
  var m = areas.length ? areas.reduce(function (s, x) { return s + x; }, 0) / areas.length : 0;
  var variance = areas.length ? areas.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / areas.length : 0;
  return { variance: variance, mean: m, collisions: collisions, pairs: areas.length };
}

// === Space-first redistribution: move each glyph's AVERAGE pair-kern into its BEARINGS, leaving
// only the residual (the genuine pair exceptions) as kerning. The professional "space first, kern
// the exceptions" workflow — a two-way decomposition where the sidebearings absorb each letter's
// typical left/right kern and the kern table keeps just the interactions (A-V, T-o…).
//   mu = grand mean of all pair-kerns (a UNIFORM optical tighten/loosen) → split mu/2 into EACH side
//   dR[G] = mean over X of kern(G,X) − mu/2   (G as LEFT member → tightens/loosens G's RIGHT bearing)
//   dL[G] = mean over X of kern(X,G) − mu/2   (G as RIGHT member → G's LEFT bearing)
//   residual(L,R) = kern(L,R) − dR[L] − dL[R]
// This is the standard two-way (row/col) decomposition K = mu + a[L] + b[R] + residual: the bearings
// carry mu+a+b (each letter's optical spacing INCLUDING the uniform component, counted ONCE), and the
// residual centres at ~0 — the genuine pairwise exceptions (A-V, T-o…) both tighter AND looser.
// (The earlier version put rowmean+colmean into the bearings, double-counting mu, which over-tightened
//  every bearing by mu/2 per side and left a +mu offset on every residual → ~every pair looked like an
//  "exception". Now the residual is a true, centred deviation.)  TOTAL SPACING IS EXACTLY PRESERVED.
//   table = FULL {'L,R':units} over all filled ordered pairs (absent = 0). names = glyph names.
//   returns { bearings:{name:{dL,dR}}, residual:{'L,R':units} (all pairs; ~0 ones ride along) }.
function redistributeToBearings(table, names) {
  function mean(a) { if (!a.length) return 0; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  var dR = {}, dL = {}, n, m;
  var all = [];
  for (n = 0; n < names.length; n++) for (m = 0; m < names.length; m++) {
    if (n === m) continue; var k0 = table[names[n] + ',' + names[m]]; all.push(k0 == null ? 0 : k0);
  }
  var half = mean(all) / 2;   // mu/2 — the uniform component pushed equally into both bearings, not the kern
  for (n = 0; n < names.length; n++) {
    var G = names[n], rs = [], ls = [];
    for (m = 0; m < names.length; m++) {
      if (m === n) continue;
      var kr = table[G + ',' + names[m]]; rs.push(kr == null ? 0 : kr);   // G's right side
      var kl = table[names[m] + ',' + G]; ls.push(kl == null ? 0 : kl);   // G's left side
    }
    dR[G] = Math.round(mean(rs) - half); dL[G] = Math.round(mean(ls) - half);
  }
  var bearings = {}, residual = {};
  for (n = 0; n < names.length; n++) bearings[names[n]] = { dL: dL[names[n]] || 0, dR: dR[names[n]] || 0 };
  for (n = 0; n < names.length; n++) for (m = 0; m < names.length; m++) {
    if (n === m) continue;
    var key = names[n] + ',' + names[m];
    var k = table[key]; k = (k == null ? 0 : k);
    residual[key] = Math.round(k - (dR[names[n]] || 0) - (dL[names[m]] || 0));
  }
  return { bearings: bearings, residual: residual };
}

// === PER-GLYPH OPTICAL BEARINGS — "balance each glyph in its box" (the AI Optimization engine).
// The template box's left/right edges are the boundary; the user draws inside it. This positions each
// glyph so its average DEPTH-CAPPED side air is EQUAL across the font: a flat-sided letter (H, I, n)
// sits at the air target, while concave/open sides (round O, the wedge of A/V, the arms of T/L/F) get
// pulled IN by however much they're indented — so the optical rhythm reads even, not the raw geometry.
//   effective side air ≈ sidebearing + average indentation(depth-capped).  We set sidebearing so that
//   every glyph's effective air == target, i.e. sidebearing = target − indentation.
//   target = the MEDIAN of the air the USER already gave (box bearing + indentation) when opts.base is
//   passed → the AI keeps YOUR overall tightness and only evens the rhythm; else the font's air target.
//   opts.base   {name:{lsb,rsb}}  the box/hand placement to anchor the overall level to (recommended)
//   opts.indent {name:{l,r}}      override the geometric indentation (e.g. a trained model's recession)
//   opts.pull   0..1              how fully to equalize (1 = full optical balance, default 1)
// Returns { name:{lsb,rsb} } in font units (floored ≥ a hair so advances never collapse).
function opticalBearings(project, mid, opts) {
  opts = opts || {};
  var ref = optimizer.buildRef(project, mid), upm = ref.upm;
  var filled = project.glyphs.filter(function (g) {
    return drawn(g, mid) && g.char && (g.unicode >= 0x21) &&
      g.kind !== 'ligature' && g.kind !== 'alternate' && g.kind !== 'composed';
  });
  var out = {};
  if (!filled.length) return out;
  function mean(a) { if (!a.length) return 0; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); var h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; }
  var capH = ref.capHeight || Math.round(0.7 * upm);
  var yLo = Math.round(-0.02 * upm), yHi = capH;                 // the rhythm-defining band (baseline→cap)
  var nRows = opts.rows || 56, rows = [];
  for (var r = 0; r < nRows; r++) rows.push(yLo + (yHi - yLo) * r / (nRows - 1));
  var maxDepth = Math.round((opts.maxDepthFrac == null ? 0.22 : opts.maxDepthFrac) * upm);
  var floor = Math.round((opts.floorFrac == null ? 0.012 : opts.floorFrac) * upm);
  var pull = opts.pull == null ? 1 : opts.pull;
  // 1) per-glyph side indentation (depth-capped) — geometric, unless an override is supplied
  var ind = {};
  filled.forEach(function (g) {
    if (opts.indent && opts.indent[g.name]) { ind[g.name] = { l: opts.indent[g.name].l || 0, r: opts.indent[g.name].r || 0 }; return; }
    var segs = optimizer.flatten(layerOf(g, mid).contours);
    var b = optimizer.bezBounds(layerOf(g, mid).contours);
    if (!isFinite(b.xMin)) { ind[g.name] = { l: 0, r: 0 }; return; }
    var li = [], ri = [];
    for (var i = 0; i < rows.length; i++) {
      var e = rowExtent(segs, rows[i]); if (!e) continue;
      li.push(clamp(e.min - b.xMin, 0, maxDepth));               // how far the left ink sits IN from the glyph's left extreme
      ri.push(clamp(b.xMax - e.max, 0, maxDepth));               // …and the right
    }
    ind[g.name] = { l: mean(li), r: mean(ri) };
  });
  // 2) target air = the user's median effective air (keeps YOUR tightness), else the font air target
  var target;
  if (opts.base) {
    var effs = [];
    filled.forEach(function (g) { var bb = opts.base[g.name]; if (bb) { effs.push(bb.lsb + pull * ind[g.name].l); effs.push(bb.rsb + pull * ind[g.name].r); } });
    target = effs.length ? median(effs) : Math.round(optimizer.fontAirTargetUnits(project, mid) / 2);
  } else target = Math.round(optimizer.fontAirTargetUnits(project, mid) / 2);
  // 3) optical bearing = target − indentation (concave sides pull in; flat sides ≈ target)
  filled.forEach(function (g) {
    out[g.name] = { lsb: Math.max(floor, Math.round(target - pull * ind[g.name].l)),
                    rsb: Math.max(floor, Math.round(target - pull * ind[g.name].r)) };
  });
  return out;
}

module.exports = { buildKernVision, evennessReport, whiteArea, searchPairKern, glyphProfile, rowExtent,
  pairSilhouette, modelBandRows, KP_HC: KP_HC, KP_WC: KP_WC, KP_PXEM: KP_PXEM,
  stripSilhouette, PARA_HC: PARA_HC, PARA_WC: PARA_WC, PARA_PXEM: PARA_PXEM, PARA_CTXN: PARA_CTXN,
  redistributeToBearings, opticalBearings };
