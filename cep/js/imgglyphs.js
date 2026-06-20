'use strict';
// Turn traced contours (image pixel space, Y-down, from imagetrace.js) into an
// ordered set of GLYPHS, guess which character each one is, and seat them into
// font units. Pure JS (no host / no DOM) so the whole pipeline is unit-tested in
// Node; only file-decoding lives in the panel.
//
// The hard part isn't tracing — it's that one glyph is often several disconnected
// blobs: i = stem+dot, ! = bar+dot, = = two bars, every accented letter =
// base+diacritic, a counter = an extra hole. So we (1) cluster blobs into glyphs
// by row then column, (2) auto-detect the sheet's category from glyph stats,
// (3) map glyphs to characters in reading order against the known sheet order,
// (4) seat each glyph on its row baseline at a per-sheet scale (so accents float
// up and descenders drop below, x-height vs cap proportions are preserved).
// Steps 2-4 only produce DEFAULTS — the panel shows them for confirmation.

const LSB = 60; // matches glyphset.js placement side bearing

// ---- small stats helpers -------------------------------------------------
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
// The dominant value: bin the numbers and return the median of the fullest bin.
// Used to find the cap line / x-height line — the height most glyphs share —
// even when taller accented glyphs (each a different height) are mixed in.
function modeApprox(vals, binFrac) {
  if (!vals.length) return 0;
  const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (hi - lo < 1e-6) return vals[0];
  const bin = Math.max(1e-6, (hi - lo) * (binFrac || 0.06));
  const buckets = {};
  for (const v of vals) { const k = Math.round((v - lo) / bin); (buckets[k] = buckets[k] || []).push(v); }
  let bestK = null, bestN = -1;
  for (const k in buckets) { const n = buckets[k].length; if (n > bestN || (n === bestN && +k < +bestK)) { bestN = n; bestK = k; } }
  return median(buckets[bestK]);
}
function bboxOf(contours) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) {
    const b = c.bbox || contourBbox(c);
    if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3];
  }
  return [x0, y0, x1, y1];
}
function contourBbox(c) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of c.points) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

// ---- clustering ----------------------------------------------------------
// Group contours -> glyph clusters. ROWS are detected from the full-size letter
// BODIES ONLY (accents/dots/bars excluded), so a diacritic sitting above a letter
// can no longer bridge two rows — the bug that merged vertically-stacked accented
// caps (À/Ò/Ł) into one glyph. Then each small mark is attached to the base it
// sits on/above; marks with no base (e.g. the two bars of '=') cluster with their
// neighbours. Rows are finally grouped on the BASE extents (accents don't extend
// them), then read left-to-right.
function clusterGlyphs(contours, opts) {
  opts = opts || {};
  const cs = contours.filter(c => c && c.points && c.points.length >= 2)
    .map(c => ({ c, b: c.bbox || contourBbox(c) }));
  if (!cs.length) return [];

  const heights = cs.map(o => o.b[3] - o.b[1]);
  const widths = cs.map(o => o.b[2] - o.b[0]);
  const medW = median(widths) || 1;
  const baseH = percentile(heights, 70) || median(heights) || 1; // ~full-letter height

  // bases = full-size bodies; marks = accents / dots / bars (small)
  const isBase = (o) => (o.b[3] - o.b[1]) >= 0.5 * baseH;
  let bases = cs.filter(isBase);
  let marks = cs.filter((o) => !isBase(o));
  if (!bases.length) { bases = cs.slice(); marks = []; } // an all-small sheet

  const rowTol = (opts.rowTol != null ? opts.rowTol : 0.25) * baseH;
  const xTol = (opts.xTol != null ? opts.xTol : 0.18) * medW;

  // rows from BASES (small gap; accents excluded so they can't bridge rows)
  const byTop = bases.slice().sort((a, b) => a.b[1] - b.b[1]);
  const bands = [];
  for (const o of byTop) {
    const last = bands[bands.length - 1];
    if (last && o.b[1] <= last.bot + rowTol) { last.bot = Math.max(last.bot, o.b[3]); last.items.push(o); }
    else bands.push({ bot: o.b[3], items: [o] });
  }

  // columns within a row -> one base cluster per letter
  const clusters = [];
  const newCluster = (o) => ({ items: [o], left: o.b[0], right: o.b[2], baseTop: o.b[1], baseBot: o.b[3] });
  const extend = (cl, o) => { cl.items.push(o); cl.left = Math.min(cl.left, o.b[0]); cl.right = Math.max(cl.right, o.b[2]); cl.baseTop = Math.min(cl.baseTop, o.b[1]); cl.baseBot = Math.max(cl.baseBot, o.b[3]); };
  for (const band of bands) {
    band.items.sort((a, b) => a.b[0] - b.b[0]);
    let cur = null;
    for (const o of band.items) {
      if (cur && o.b[0] <= cur.right + xTol) extend(cur, o);
      else { cur = newCluster(o); clusters.push(cur); }
    }
  }

  // attach each mark to the base cluster it X-overlaps and sits on/just above
  const leftover = [];
  for (const m of marks) {
    let best = null, bestDy = Infinity;
    for (const cl of clusters) {
      if (Math.min(m.b[2], cl.right) - Math.max(m.b[0], cl.left) <= 0) continue; // need X overlap
      const dy = (m.b[3] <= cl.baseTop) ? (cl.baseTop - m.b[3]) : (m.b[1] >= cl.baseBot ? (m.b[1] - cl.baseBot) : 0);
      if (dy > 0.5 * baseH) continue;
      if (dy < bestDy) { bestDy = dy; best = cl; }
    }
    if (best) best.items.push(m); else leftover.push(m); // mark rides its base; don't extend baseTop/Bot
  }

  // leftover marks with no base (e.g. '=' ':' …): cluster among themselves
  if (leftover.length) {
    leftover.sort((a, b) => a.b[1] - b.b[1]);
    const lb = [];
    for (const o of leftover) {
      const last = lb[lb.length - 1];
      if (last && o.b[1] <= last.bot + 0.5 * baseH) { last.bot = Math.max(last.bot, o.b[3]); last.items.push(o); }
      else lb.push({ bot: o.b[3], items: [o] });
    }
    for (const band of lb) {
      band.items.sort((a, b) => a.b[0] - b.b[0]);
      let cur = null;
      for (const o of band.items) {
        if (cur && o.b[0] <= cur.right + xTol) extend(cur, o);
        else { cur = newCluster(o); clusters.push(cur); }
      }
    }
  }

  // final rows on the BASE extents (accents don't extend them), then left-to-right
  const built = clusters.map((cl) => ({
    contours: cl.items.map((o) => o.c), bbox: bboxOf(cl.items.map((o) => o.c)),
    _bt: cl.baseTop, _bb: cl.baseBot,
  }));
  built.sort((a, b) => a._bt - b._bt);
  let row = -1, rowBot = -Infinity;
  for (const cl of built) {
    if (cl._bt > rowBot) { row++; rowBot = cl._bb; } else rowBot = Math.max(rowBot, cl._bb);
    cl.row = row;
  }
  built.sort((a, b) => (a.row - b.row) || (a.bbox[0] - b.bbox[0]));
  built.forEach((cl) => { delete cl._bt; delete cl._bb; });
  return built;
}

// ---- category detection --------------------------------------------------
// Returns one of 'digits' | 'upper' | 'lower' | 'symbols'. Heuristic; the panel
// lets the user override. Signals: glyph count, height uniformity, how many
// glyphs are "short" (x-height only => lowercase), and how scattered the glyph
// bottoms are within a row (punctuation doesn't share a baseline).
function detectCategory(clusters) {
  const n = clusters.length;
  if (!n) return 'symbols';

  // Per-row baseline, then baseline-relative metrics. These sheets are accent-
  // HEAVY (34–36 accents vs 26 base letters), so raw height stats lie; we measure
  // against the row baseline and the dominant top line instead.
  const rows = {};
  clusters.forEach(c => { (rows[c.row] = rows[c.row] || []).push(c); });
  const baseByRow = {};
  for (const k in rows) baseByRow[k] = median(rows[k].map(c => c.bbox[3]));

  const heights = clusters.map(c => c.bbox[3] - c.bbox[1]);
  const ascents = clusters.map(c => Math.max(1, baseByRow[c.row] - c.bbox[1]));
  const capLine = modeApprox(ascents) || (median(heights) || 1);

  // descenders below the baseline — the decisive lowercase signal (g j p q y þ…);
  // uppercase has essentially none.
  const descRatio = clusters.filter(c => (c.bbox[3] - baseByRow[c.row]) > 0.10 * capLine).length / n;
  // tops sitting well under the dominant line (a weak x-height backup signal).
  const shortTopRatio = ascents.filter(a => a < 0.72 * capLine).length / n;
  // heterogeneity — punctuation mixes tiny dots with tall brackets at scattered
  // heights; letters do not.
  const hi = percentile(heights, 90), lo = Math.max(1, percentile(heights, 10));
  const heightSpread = hi / lo;
  const centerScatter = median(clusters.map(c => Math.abs((c.bbox[1] + c.bbox[3]) / 2 - baseByRow[c.row]))) / capLine;

  // Digits: a small, height-uniform set on one baseline, no descenders.
  if (n <= 12 && descRatio < 0.12 && heightSpread < 1.9) return 'digits';
  // Symbols: very mixed glyph sizes AND scattered vertical positions.
  if (heightSpread > 2.2 && centerScatter > 0.15) return 'symbols';
  // Lowercase: real descenders (or, as a backup, a strong x-height population).
  if (descRatio > 0.07 || shortTopRatio > 0.45) return 'lower';
  // Otherwise uppercase: caps share one baseline + one cap line.
  if (n >= 14) return 'upper';
  return 'symbols';
}

// ---- canonical sheet orders (transcribed from the 4 reference sheets) -----
// Glyphs within a sheet are in normal reading order even when the sheets
// themselves arrive in any order, so detect the category then zip to these.
const SEQ = {
  digits: Array.from('0123456789'),
  upper: Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÙÚÛÜÝŸÞÐŁŠŽ'),
  lower: Array.from('abcdefghijklmnopqrstuvwxyz' + 'àáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿþðłšž' + 'ß'),
  symbols: ['.', ',', ':', ';', '!', '?', "'", '"', '@', '_', '$', '€', '&', '#', '%',
    '+', '-', '×', '÷', '=', '~', '<', '>', '(', ')', '¡', '¿', '«', '»'],
};
const CATEGORY_LABEL = { digits: 'Numbers (0–9)', upper: 'Uppercase A–Z + accents', lower: 'Lowercase a–z + accents', symbols: 'Punctuation & symbols' };

// Map clusters (reading order) -> assignments against a category's sequence.
// Count mismatches are tolerated: the overflow is left unassigned (char:null)
// for the user to fill, and we never crash on a wrong guess.
function mapClusters(clusters, category) {
  const seq = SEQ[category] || [];
  return clusters.map((cl, i) => {
    const ch = i < seq.length ? seq[i] : null;
    return { clusterIndex: i, char: ch, unicode: ch ? ch.codePointAt(0) : null };
  });
}

// Full auto pass for one sheet: cluster -> detect -> map.
function analyzeSheet(contours, opts) {
  const clusters = clusterGlyphs(contours, opts);
  const category = (opts && opts.category) || detectCategory(clusters);
  const mapping = mapClusters(clusters, category);
  return { clusters, category, mapping, expected: SEQ[category] ? SEQ[category].length : 0 };
}

// ---- seating into font units ---------------------------------------------
// Convert a sheet's clusters to font-unit contours (Y-up, baseline=0). Every
// seater shares the SAME geometry — per-row baseline + a single uniform scale S,
// each glyph on its row baseline (accents float up, descenders drop below). Only
// HOW S is chosen differs (whole-sheet category vs per-glyph recognized class);
// seatAt + categoryScale are the shared core so the two paths can never diverge
// geometrically. Returns one entry per cluster: { contours, advanceWidth,
// height, bbox }. Feeds glyphset.setGlyphContours() (already in font units).

// Per-row baseline = median bottom of the row (descenders sit below it).
function rowBaselines(clusters) {
  const rows = {};
  clusters.forEach(c => { (rows[c.row] = rows[c.row] || []).push(c); });
  const rowBase = {};
  for (const k in rows) rowBase[k] = median(rows[k].map(c => c.bbox[3]));
  return rowBase;
}

// Whole-sheet scale from a single category. Reference height is measured ABOVE
// the baseline so descenders/accents don't skew it; the dominant ascent is the
// cap line (upper/digits) or x-height line (lower).
function categoryScale(ascents, category, metrics) {
  let refPx, target;
  if (category === 'lower') { refPx = modeApprox(ascents); target = metrics.xHeight; }
  else if (category === 'symbols') { refPx = percentile(ascents, 75); target = metrics.capHeight; }
  else { refPx = modeApprox(ascents); target = metrics.capHeight; } // digits, upper, default
  return target / Math.max(refPx, 1);
}

function seatAt(clusters, rowBase, S, lsb) {
  return clusters.map(cl => {
    const left = cl.bbox[0];
    const baseY = rowBase[cl.row];
    const mapPt = (x, y) => ({ x: (x - left) * S + lsb, y: (baseY - y) * S });
    const contours = cl.contours.map(c => ({
      closed: c.closed !== false,
      points: c.points.map(p => {
        const A = mapPt(p.x, p.y);
        return {
          x: A.x, y: A.y, type: p.type || 'corner',
          handleIn: p.handleIn ? mapPt(p.handleIn.x, p.handleIn.y) : null,
          handleOut: p.handleOut ? mapPt(p.handleOut.x, p.handleOut.y) : null,
        };
      }),
    }));
    const w = (cl.bbox[2] - cl.bbox[0]) * S;
    return {
      contours,
      advanceWidth: Math.round(w + lsb * 2),
      height: (cl.bbox[3] - cl.bbox[1]) * S,
      bbox: [lsb, 0, lsb + w, 0],
    };
  });
}

// Legacy whole-sheet seater (one category). Kept byte-identical in RESULT — used
// as the fallback when no characters are recognized, and by the unit tests.
function seatClusters(clusters, category, metrics, opts) {
  opts = opts || {};
  const lsb = opts.lsb != null ? opts.lsb : LSB;
  if (!clusters.length) return [];
  const rowBase = rowBaselines(clusters);
  const ascents = clusters.map(c => Math.max(1, rowBase[c.row] - c.bbox[1]));
  return seatAt(clusters, rowBase, categoryScale(ascents, category, metrics), lsb);
}

// Vertical class of a character — ONLY to pick the sheet's scale ANCHOR. Letters
// + digits anchor (a 'cap' = cap line, an 'x' = x-height line); symbols/unknown
// return null and ride the chosen sheet scale + their own traced geometry.
const VLETTER = (function () {
  const m = {};
  const add = (s, cls) => { for (let i = 0; i < s.length; i++) m[s[i]] = cls; };
  add('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'cap');
  add('ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÆÙÚÛÜÝŸÞÐŁŠŽ', 'cap'); // accented caps reach the cap line
  add('bdfhklt', 'asc');                              // ascenders (excluded from anchoring)
  add('aceimnorsuvwxz', 'x');                         // x-height bodies — the lowercase anchor
  add('gjpqy', 'desc');                               // descenders (excluded from anchoring)
  add('àáâãäåæçèéêëìíîïñòóôõöøœùúûüÿšžßıł', 'x');
  add('ýþ', 'desc');
  return m;
})();
function letterClass(ch) {
  if (ch == null) return null;
  if (VLETTER[ch]) return VLETTER[ch];
  try {
    const b = ch.normalize('NFD')[0];
    if (VLETTER[b]) return VLETTER[b];
    if (/[A-Z]/.test(b)) return 'cap';
    if (/[a-z]/.test(b)) return 'x';
  } catch (e) {}
  return null;
}

// Per-glyph seater: choose the sheet scale from the RECOGNIZED characters so a
// MIXED sheet sizes correctly (caps → capHeight, x-height letters → xHeight). When
// no letters are recognized (symbols-only, or the model is unavailable so chars
// are all null), fall back to the legacy per-category rule (opts.fallbackCategory)
// → identical behaviour to seatClusters in those cases. ONLY 'cap' (A–Z, digits,
// accented caps) and 'x' (x-height letters) anchor — symbols never do.
function seatByChar(clusters, chars, metrics, opts) {
  opts = opts || {};
  const lsb = opts.lsb != null ? opts.lsb : LSB;
  if (!clusters.length) return [];
  const rowBase = rowBaselines(clusters);
  const ascents = clusters.map(c => Math.max(1, rowBase[c.row] - c.bbox[1]));
  const caps = [], exes = [];
  for (let i = 0; i < clusters.length; i++) {
    const cl = letterClass(chars && chars[i]);
    if (cl === 'cap') caps.push(ascents[i]);
    else if (cl === 'x') exes.push(ascents[i]);
  }
  let S;
  if (caps.length >= 2) S = metrics.capHeight / Math.max(modeApprox(caps), 1);
  else if (exes.length >= 2) S = metrics.xHeight / Math.max(modeApprox(exes), 1);
  else if (caps.length >= 1) S = metrics.capHeight / Math.max(modeApprox(caps), 1);
  else if (exes.length >= 1) S = metrics.xHeight / Math.max(modeApprox(exes), 1);
  else S = categoryScale(ascents, opts.fallbackCategory || 'upper', metrics); // no letters → legacy
  return seatAt(clusters, rowBase, S, lsb);
}

// Convert paths read from Illustrator's Image Trace (host fmTraceImage) into the
// contour model in IMAGE-PIXEL space (Y-down), so the same cluster/detect/seat
// pipeline applies. Illustrator's DOM is Y-UP (top = larger Y); we flip against
// the traced group's bounds [left, top, right, bottom] so the top of the sheet
// maps to y=0 and rows run downward. Counters arrive as their own sub-paths
// (Illustrator compound paths) and cluster with their parent by X-overlap.
function contoursFromTracePaths(paths, bounds) {
  const left = bounds[0], top = bounds[1];
  const map = (x, y) => ({ x: x - left, y: top - y });
  const out = [];
  (paths || []).forEach(p => {
    const pp = p.pathPoints || [];
    if (pp.length < 2) return;
    const points = pp.map(a => {
      const A = map(a.anchor[0], a.anchor[1]);
      const I = map(a.leftDirection[0], a.leftDirection[1]);
      const O = map(a.rightDirection[0], a.rightDirection[1]);
      const hasIn = Math.abs(I.x - A.x) > 1e-4 || Math.abs(I.y - A.y) > 1e-4;
      const hasOut = Math.abs(O.x - A.x) > 1e-4 || Math.abs(O.y - A.y) > 1e-4;
      const sm = String(a.pointType || '').toLowerCase().indexOf('smooth') !== -1;
      return { x: A.x, y: A.y, type: sm ? 'smooth' : 'corner', handleIn: hasIn ? I : null, handleOut: hasOut ? O : null };
    });
    out.push({ closed: p.closed !== false, isHole: false, points });
  });
  return out;
}

module.exports = {
  LSB, SEQ, CATEGORY_LABEL,
  clusterGlyphs, detectCategory, mapClusters, analyzeSheet,
  seatClusters, seatByChar,
  contoursFromTracePaths,
  // exported for tests
  median, percentile, contourBbox, letterClass,
};
