'use strict';
// RuneType's little built-in optimizer — a pure, offline rule+stats engine (no
// network) that reasons about glyph CLASS to set spacing/advance, tracking and
// optical kerning, and to normalize the font for consistency. Operates on the
// project model in place (font units, y-up; handleIn/Out are absolute control
// points, matching core/fontEngine.js).

function layerOf(g, mid) { return g.layers && g.layers[mid]; }
function drawn(g, mid) { var l = layerOf(g, mid); return !!(l && l.contours && l.contours.length); }

// bbox over on-curve points AND non-null handles (handles can exceed extrema)
function bezBounds(contours) {
  var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (var i = 0; i < contours.length; i++) {
    var pts = contours[i].points;
    for (var j = 0; j < pts.length; j++) {
      var p = pts[j], cand = [[p.x, p.y]];
      if (p.handleIn) cand.push([p.handleIn.x, p.handleIn.y]);
      if (p.handleOut) cand.push([p.handleOut.x, p.handleOut.y]);
      for (var k = 0; k < cand.length; k++) {
        var x = cand[k][0], y = cand[k][1];
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
    }
  }
  return { xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax, w: xMax - xMin, h: yMax - yMin };
}
function translateX(contours, dx) {
  if (!dx) return;
  contours.forEach(function (c) { c.points.forEach(function (p) { p.x += dx; if (p.handleIn) p.handleIn.x += dx; if (p.handleOut) p.handleOut.x += dx; }); });
}
function median(a) { a = a.filter(function (v) { return v != null && isFinite(v); }).sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : null; }

// === Robust optical close-approach. A pair's kern is driven by how close the two ink PROFILES
// come across the cap band. Using the single TIGHTEST scan height makes ONE protruding terminal
// or serif spike (C's beak, B's swash) a phantom collision the kerner then over-separates → the
// exported "too much space after C / B" the user saw. Take a LOW PERCENTILE (p15) of the
// per-height gaps instead: it discards the worst ~1/7 of contact heights (the spikes) while still
// catching pairs that are tight across a real band (AV / To / WA stay snug). A render judge panel
// picked p15 over min / 3rd / p20 (p20 began colliding dense verticals). ONE source of truth —
// every kern path (optimizeKerning, bakeMetricOptical, the live tester's opticalKern) consumes
// robustGap + kernTarget, so the in-program preview and the exported font agree.
var KERN_GAP_PCTILE = 0.15;
function robustGap(gaps) {
  if (!gaps || !gaps.length) return Infinity;
  var s = gaps.slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(KERN_GAP_PCTILE * (s.length - 1))];
}
// All per-height profile gaps for the ordered pair (gL then gR), using gL's CURRENT advance.
function pairGaps(flatsL, advL, flatsR, ref) {
  var out = [];
  for (var s = 0; s <= 22; s++) {
    var y = 5 + (ref.capHeight - 10) * s / 22;
    var pl = profileAt(flatsL, y, 'R'), pr = profileAt(flatsR, y, 'L');
    if (pl == null || pr == null) continue;
    out.push((advL - pl) + pr);
  }
  return out;
}

// Reference metrics derived from the drawn glyphs (with sane fallbacks).
function buildRef(project, mid) {
  var upm = project.unitsPerEm || 1000;
  function geo(g) { return drawn(g, mid) ? bezBounds(layerOf(g, mid).contours) : null; }
  function yMaxOf(ch) { var g = project.glyphs.find(function (x) { return x.char === ch; }); var b = g && geo(g); return b ? b.yMax : null; }
  var cap = median('ABDEFHKLMNPRT'.split('').map(yMaxOf)) || (project.metrics ? project.metrics.capHeight : Math.round(0.716 * upm));
  var xh = median('acemnorsuvwxz'.split('').map(yMaxOf)) || (project.metrics ? project.metrics.xHeight : Math.round(0.5 * upm));
  // dominant stem ≈ narrowest drawn-glyph ink width among I/l/i (fallback 8% em)
  var stems = ['I', 'l', 'i', 'H', 'T'].map(function (ch) { var g = project.glyphs.find(function (x) { return x.char === ch; }); var b = g && geo(g); return b && b.w > 0 ? b.w : null; }).filter(Boolean);
  var stem = stems.length ? Math.min.apply(null, stems) : Math.round(0.08 * upm);
  if (stem > 0.18 * upm) stem = Math.round(0.09 * upm); // a wide 'I' isn't a stem
  return { upm: upm, capHeight: cap, xHeight: xh, stem: stem, SB_base: Math.round(1.05 * stem) };
}

var ROUND = 'oOcCeGQSUu0', NARROW = 'IiljJ1!|', WIDE = 'WMm', DIAG = 'AVWXYKvwxyk';
function classify(g, geo, ref) {
  var u = g.unicode || 0, ch = g.char || '';
  var cls = 'DEFAULT';
  if (u >= 0x41 && u <= 0x5A) cls = 'UPPER';
  else if (u >= 0x61 && u <= 0x7A) cls = geo.yMax >= ref.xHeight + 0.12 * ref.upm ? 'ASCENDER' : (geo.yMin <= -0.04 * ref.upm ? 'DESCENDER' : 'LOWERCASE');
  else if (u >= 0x30 && u <= 0x39) cls = 'FIGURE';
  if ('.,:;\'"!?'.indexOf(ch) >= 0) cls = 'PUNCT_CENTERED';
  if (geo.w < 0.18 * ref.upm && geo.h > 0.5 * ref.upm) cls = 'NARROW';
  if (geo.w > 0.72 * ref.upm) cls = 'WIDE';
  var round = ROUND.indexOf(ch) >= 0, diag = DIAG.indexOf(ch) >= 0;
  return { cls: cls, roundL: round, roundR: round, diagL: diag, diagR: diag };
}
function sbTargets(c, geo, ref) {
  var SB = ref.SB_base;
  var K = { UPPER: 1.0, LOWERCASE: 0.92, ASCENDER: 0.92, DESCENDER: 0.92, NARROW: 1.5, WIDE: 0.5, FIGURE: 0.95, DEFAULT: 1.0, PUNCT_CENTERED: 0 };
  if (c.cls === 'PUNCT_CENTERED') {
    var adv = Math.round(0.3 * ref.upm), lsb = Math.round((adv - geo.w) / 2);
    return { lsb: lsb, rsb: adv - geo.w - lsb };
  }
  var kL = K[c.cls] != null ? K[c.cls] : 1, kR = kL;
  if (c.roundL) kL = 0.62; if (c.diagL) kL = 0.55;
  if (c.roundR) kR = 0.62; if (c.diagR) kR = 0.55;
  return { lsb: Math.round(SB * kL), rsb: Math.round(SB * kR) };
}

// === public: optimize SPACING (sidebearings + advance) for one or all glyphs.
function optimizeSpacing(project, mid, onlyIndex) {
  var ref = buildRef(project, mid), n = 0;
  project.glyphs.forEach(function (g, i) {
    if (onlyIndex != null && i !== onlyIndex) return;
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return; // leave specials
    if (!drawn(g, mid)) return;
    var b = bezBounds(layerOf(g, mid).contours);
    if (!isFinite(b.xMin)) return;
    var c = classify(g, b, ref), t = sbTargets(c, b, ref);
    translateX(layerOf(g, mid).contours, Math.round(t.lsb - b.xMin));
    g.advanceWidth = Math.round(t.lsb + b.w + t.rsb);
    n++;
  });
  return { count: n, ref: ref };
}

// === optical pair kerning from outline side-profiles (returns a kern table).
function flatten(contours) {
  var segs = [];
  contours.forEach(function (c) {
    var p = c.points, m = p.length; if (m < 2) return;
    var cnt = c.closed ? m : m - 1;
    for (var i = 0; i < cnt; i++) {
      var a = p[i], b = p[(i + 1) % m];
      var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasO || hasI) {
        var c1 = a.handleOut || a, c2 = b.handleIn || b, px = a.x, py = a.y;
        for (var s = 1; s <= 8; s++) { var t = s / 8, u = 1 - t; var x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x; var y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y; segs.push([px, py, x, y]); px = x; py = y; }
      } else segs.push([a.x, a.y, b.x, b.y]);
    }
  });
  return segs;
}
function profileAt(segs, y, side) {
  var v = side === 'L' ? Infinity : -Infinity, hit = false;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i], y1 = s[1], y2 = s[3];
    if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
      var x = (y2 === y1) ? s[0] : s[0] + (s[2] - s[0]) * (y - y1) / (y2 - y1);
      hit = true; if (side === 'L') { if (x < v) v = x; } else if (x > v) v = x;
    }
  }
  return hit ? v : null;
}
// The font's own "typical pair gap" = median(LSB)+median(RSB) of the filled glyphs,
// clamped to [6%,14%] em. ONE source of truth so the tester preview == the bake.
// (bezBounds returns xMin/xMax — the old code read minX/maxX = undefined → NaN → the
// target silently fell to the 8.5% fallback; fixed here.)
function fontAirTargetUnits(project, mid, ref) {
  ref = ref || buildRef(project, mid);
  var filled = project.glyphs.filter(function (g) { return drawn(g, mid) && g.char && (g.unicode >= 0x21); });
  var sides = filled.map(function (g) { var b = bezBounds(layerOf(g, mid).contours); return { l: Math.max(0, b.xMin), r: Math.max(0, g.advanceWidth - b.xMax) }; });
  var target = (median(sides.map(function (s) { return s.l; })) || 0) + (median(sides.map(function (s) { return s.r; })) || 0);
  return Math.max(0.06 * ref.upm, Math.min(0.14 * ref.upm, target || 0.085 * ref.upm));
}
// The font's typical optical pair gap = MEDIAN over all filled ordered pairs of robustGap.
// Straight pairs land near it → ~0 kern; only genuinely tight/loose pairs get a value. The live
// tester (opticalKern) calls this so its optical preview aims at the SAME target the export bake
// uses — preview == export. (Falls back to the bbox air target if there are too few pairs.)
function kernTarget(project, mid) {
  var ref = buildRef(project, mid);
  var filled = project.glyphs.filter(function (g) { return drawn(g, mid) && g.char && (g.unicode >= 0x21); });
  var flats = {}; filled.forEach(function (g) { flats[g.name] = flatten(layerOf(g, mid).contours); });
  var mgs = [];
  for (var a = 0; a < filled.length; a++) for (var b = 0; b < filled.length; b++) {
    var mg = robustGap(pairGaps(flats[filled[a].name], filled[a].advanceWidth, flats[filled[b].name], ref));
    if (mg < Infinity) mgs.push(mg);
  }
  return median(mgs) || fontAirTargetUnits(project, mid, ref);
}
function optimizeKerning(project, mid) {
  var ref = buildRef(project, mid);
  var filled = project.glyphs.filter(function (g) { return drawn(g, mid) && g.char && (g.unicode >= 0x21); });
  var flats = {}; filled.forEach(function (g) { flats[g.name] = flatten(layerOf(g, mid).contours); });
  // PASS 1 — every pair's robust optical closest-approach (p15 over the scan heights — see robustGap).
  var gaps = [];
  for (var a = 0; a < filled.length; a++) {
    for (var b = 0; b < filled.length; b++) {
      var gL = filled[a], gR = filled[b];
      var mg = robustGap(pairGaps(flats[gL.name], gL.advanceWidth, flats[gR.name], ref));
      if (mg < Infinity) gaps.push({ key: gL.name + ',' + gR.name, mg: mg });
    }
  }
  // The kern TARGET is the MEDIAN of those SAME robust gaps — the font's typical optical pair gap.
  // (Measured the SAME way as each pair's gap, so straight pairs land ~0 and only genuinely
  // tight/loose pairs kern. robustGap replaced the raw min so a lone terminal spike on C/B no
  // longer reads as a collision and over-separates the pair.)
  var target = median(gaps.map(function (g) { return g.mg; })) || fontAirTargetUnits(project, mid, ref);
  var table = {}, pairs = 0;
  gaps.forEach(function (g) {
    var v = Math.round(Math.max(-0.12 * ref.upm, Math.min(0.06 * ref.upm, target - g.mg)));
    if (Math.abs(v) >= 12) { table[g.key] = v; pairs++; }
  });
  return { table: table, pairs: pairs };
}

// === Metric ⟷ Optical bake. t in [0,1]: 0 = a clean METRIC baseline, 1 = optical (every
// glyph centred with a symmetric air/2 bearing). The metric baseline AND the air target are
// CLASS-BASED (sbTargets / median) — pure functions of each glyph's INK SHAPE, independent of
// its current POSITION — and every glyph is re-seated to an ABSOLUTE target. That makes the
// bake IDEMPOTENT: re-applying the same t (which happens every drag frame) is a no-op, with
// ZERO drift. (The earlier version read the LIVE bearing as the origin, so it re-baked on top
// of its own output and collapsed toward optHalf as you dragged — the blocker bug.) The bbox
// edge is the spike, so spike pairs land at `air` while recessed/round/diagonal bodies open
// more for free. stdMul = the Standard %. Channel B adds the residual optical pair kern,
// measured AFTER the bearings (no double-count), scaled by t. Never resizes a glyph.
// opts.optBearings (optional) = { glyphName: { recL, recR } } per-side optical RECESSION
// in FONT UNITS (how much TIGHTER than optHalf each side should sit), supplied by the
// sidebearing ML model. The bake applies oL = max(floor, round(optHalf - recL)) so the
// Standard (stdMul) scaling stays on optHalf while the shape-driven recession composes on
// top. NOTE: the field is a RECESSION, not a final bearing — passing {oL,oR} would read as
// recL=0 → silent uniform. When absent every glyph uses the uniform optHalf, so the bake is
// BYTE-IDENTICAL to today with no model — a backward-compatible seam.
// Bake spacing + kerning. FOUR independent axes (the panel exposes one slider each),
// all idempotent (absolute re-seat from the class-based metric baseline):
//   opts.tBearing  0..1  side-bearing blend: 0 = metric (class baseline), 1 = optical
//   opts.aiBearing 0..1  how much the trained side-bearing model shapes the OPTICAL target
//                        (0 = uniform optHalf for every glyph, 1 = full per-glyph recession)
//   opts.tKern     0..1  KERNING blend (Photoshop mechanic): 0 = metric (font's own pairs,
//                        i.e. none here → 0), 1 = full shape-based optical pair kern
//   opts.aiKern    0..1  how much the model's per-glyph recession refines the optical kern
//                        (0 = pure geometric profile kern, 1 = + model-informed tightening)
//   opts.track     units static tracking, applied LAST + independently (half each side)
//   opts.stdMul    Standard multiplier on the air target (scales optHalf)
//   opts.optBearings { name:{recL,recR} } the model's per-glyph recession (font units)
// No opts ⇒ everything 0 ⇒ the class-based metric spacing, no kern — a stable baseline.
function bakeMetricOptical(project, mid, opts) {
  opts = opts || {};
  var clamp01 = function (v) { return Math.max(0, Math.min(1, v || 0)); };
  var tB = clamp01(opts.tBearing), aB = clamp01(opts.aiBearing);
  var tK = clamp01(opts.tKern), aK = clamp01(opts.aiKern);
  var stdMul = opts.stdMul == null ? 1 : opts.stdMul;
  var sbModel = opts.optBearings, mBase = opts.metricBase;
  var ref = buildRef(project, mid);
  // The METRIC baseline (what tBearing=0 reproduces). By default it's the class-based
  // sbTargets (a pure function of the ink shape → idempotent). When opts.metricBase is
  // supplied (the panel captures the glyph's DRAWN/hand-edited spacing once), tBearing=0
  // reproduces THAT instead — so the optical/AI/kern/track dials LAYER on top of the user's
  // own spacing rather than resetting it to the algorithmic baseline. Air = median of
  // whichever baseline is in play.
  var items = [], ls = [], rs = [];
  project.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return;
    if (!drawn(g, mid)) return;
    var cs = layerOf(g, mid).contours, b = bezBounds(cs);
    if (!isFinite(b.xMin)) return;
    var cl = classify(g, b, ref), sb = sbTargets(cl, b, ref);
    var pun = cl.cls === 'PUNCT_CENTERED';                    // keep punctuation centred in its slot
    var base = (mBase && mBase[g.name]) ? mBase[g.name] : sb;
    items.push({ g: g, cs: cs, b: b, mlsb: base.lsb, mrsb: base.rsb, pun: pun });
    if (!pun) { ls.push(base.lsb); rs.push(base.rsb); }
  });
  var airBase = (median(ls) || 0) + (median(rs) || 0);
  var air = Math.max(0.06 * ref.upm, Math.min(0.14 * ref.upm, airBase || 0.085 * ref.upm)) * stdMul;
  var optHalf = Math.round(air / 2), spaced = 0, floor = Math.round(0.02 * ref.upm);
  var half = Math.round((opts.track || 0) / 2);
  items.forEach(function (it) {
    // optical bearing target: uniform optHalf, pulled in by aiBearing × the model recession
    var recL = 0, recR = 0;
    if (sbModel && !it.pun && sbModel[it.g.name]) { var m = sbModel[it.g.name]; recL = m.recL || 0; recR = m.recR || 0; }
    var oL = Math.max(floor, Math.round(optHalf - aB * recL));
    var oR = Math.max(floor, Math.round(optHalf - aB * recR));
    // metric → optical blend by tBearing, then static tracking (independent final layer)
    var sbL = (it.pun ? it.mlsb : Math.round(it.mlsb + tB * (oL - it.mlsb))) + half;
    var sbR = (it.pun ? it.mrsb : Math.round(it.mrsb + tB * (oR - it.mrsb))) + half;
    translateX(it.cs, sbL - it.b.xMin);                       // absolute re-seat → idempotent
    it.g.advanceWidth = Math.round(sbL + it.b.w + sbR);
    spaced++;
  });
  // KERNING (Photoshop optical = shape-based pair gaps). tK gates it; aiKern adds the
  // model's per-glyph optical tightening on top of the geometric profile kern.
  var table = {}, pairs = 0;
  if (tK > 0) {
    var filled = project.glyphs.filter(function (g) { return drawn(g, mid) && g.char && (g.unicode >= 0x21); });
    var flats = {}; filled.forEach(function (g) { flats[g.name] = flatten(layerOf(g, mid).contours); });
    // PASS 1 — every pair's ROBUST profile closest-approach (p15 over scan heights — see robustGap;
    // uses the just-baked advances). Raw min made a lone terminal spike (C/B) a phantom collision.
    var gaps = [];
    for (var a = 0; a < filled.length; a++) {
      for (var bi = 0; bi < filled.length; bi++) {
        var gL = filled[a], gR = filled[bi];
        var mg = robustGap(pairGaps(flats[gL.name], gL.advanceWidth, flats[gR.name], ref));
        if (mg < Infinity) gaps.push({ L: gL, R: gR, mg: mg });
      }
    }
    // Kern relative to the MEDIAN robust gap (the font's typical optical pair gap), measured the SAME
    // way as each pair's gap → balanced kerns (≈ half +, half −, mean ≈ 0), and no single-terminal
    // spike over-separates open letters (C/G/B). Matches optimizeKerning + the live opticalKern.
    var tgt = median(gaps.map(function (g) { return g.mg; })) || air;
    gaps.forEach(function (gp) {
      var vGeo = Math.max(-0.12 * ref.upm, Math.min(0.06 * ref.upm, tgt - gp.mg));   // geometric optical
      // model nudge: a receding right-edge of L / left-edge of R lets the pair tuck closer
      var vAi = 0;
      if (sbModel) {
        var mL = sbModel[gp.L.name], mR = sbModel[gp.R.name];
        vAi = -0.25 * (((mL && mL.recR) || 0) + ((mR && mR.recL) || 0));
      }
      var v = Math.round(tK * (vGeo + aK * vAi));
      if (Math.abs(v) >= 12) { table[gp.L.name + ',' + gp.R.name] = v; pairs++; }
    });
  }
  return { spaced: spaced, kernPairs: pairs, table: table };
}

// === one pass: spacing + kerning. tracking is applied separately (live).
function optimizeAll(project, mid) {
  var sp = optimizeSpacing(project, mid);
  var kn = optimizeKerning(project, mid);
  project.kerning = kn.table;
  return { spaced: sp.count, kernPairs: kn.pairs, ref: sp.ref };
}

module.exports = { buildRef, classify, sbTargets, optimizeSpacing, optimizeKerning, optimizeAll, bezBounds, fontAirTargetUnits, bakeMetricOptical, robustGap, kernTarget, flatten };
