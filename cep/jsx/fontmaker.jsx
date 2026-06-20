/* FontMaker — Illustrator ExtendScript host bridge.
 * The CEP panel cannot touch the Illustrator DOM directly, so it calls these
 * functions via CSInterface.evalScript(). We read the current selection's path
 * geometry and return it as JSON shaped exactly like the objects shared/
 * ilbridge.js expects (anchor / leftDirection / rightDirection / pointType),
 * so the panel reuses the same, already-tested conversion code.
 *
 * ExtendScript has no JSON by default, so we hand-build the string. Coordinates
 * are returned raw (Illustrator is Y-down); ilbridge flips Y on the panel side.
 */

function fmNum(n) {
  // Finite numbers only; guard NaN/Infinity that would break JSON.parse.
  if (n !== n || n === Infinity || n === -Infinity) return '0';
  return String(n);
}
function fmPair(arr) {
  return '[' + fmNum(arr[0]) + ',' + fmNum(arr[1]) + ']';
}
function fmPointType(pt) {
  // PointType.SMOOTH / PointType.CORNER  ->  "smooth" / "corner"
  return (pt === PointType.SMOOTH) ? 'smooth' : 'corner';
}

function fmSerializePath(item) {
  var pts = item.pathPoints;
  var parts = [];
  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];
    parts.push(
      '{"anchor":' + fmPair(p.anchor) +
      ',"leftDirection":' + fmPair(p.leftDirection) +
      ',"rightDirection":' + fmPair(p.rightDirection) +
      ',"pointType":"' + fmPointType(p.pointType) + '"}'
    );
  }
  return '{"closed":' + (item.closed ? 'true' : 'false') +
         ',"pathPoints":[' + parts.join(',') + ']}';
}

// Recursively flatten a page item into PathItems (descend groups & compounds).
function fmCollect(item, out) {
  var t = item.typename;
  if (t === 'PathItem') {
    if (item.pathPoints && item.pathPoints.length >= 2) out.push(item);
  } else if (t === 'CompoundPathItem') {
    var cp = item.pathItems;
    for (var i = 0; i < cp.length; i++) fmCollect(cp[i], out);
  } else if (t === 'GroupItem') {
    var pi = item.pageItems;
    for (var j = 0; j < pi.length; j++) fmCollect(pi[j], out);
  }
  return out;
}

// Public: return the selection's outlines as JSON for the panel.
function fmReadSelection() {
  try {
    if (app.documents.length === 0) return '{"ok":false,"error":"Open a document first"}';
    var doc = app.activeDocument;
    var sel = doc.selection;
    if (!sel || sel.length === 0) return '{"ok":false,"error":"Nothing selected in Illustrator"}';
    var paths = [];
    for (var i = 0; i < sel.length; i++) fmCollect(sel[i], paths);
    if (paths.length === 0) return '{"ok":false,"error":"Selection has no path outlines"}';
    var parts = [];
    for (var k = 0; k < paths.length; k++) parts.push(fmSerializePath(paths[k]));
    return '{"ok":true,"count":' + paths.length + ',"paths":[' + parts.join(',') + ']}';
  } catch (e) {
    return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}';
  }
}

/* ===================== Image Import (Illustrator Image Trace) =============
 * fmPickImages() shows a native multi-select file dialog -> the chosen paths.
 * fmTraceImage({path}) places one sheet in a throwaway document, runs Illustrator's
 * own Image Trace (black & white), expands it to paths, and returns them as the
 * usual {paths, bounds} JSON. Counters come back as real compound-path holes; the
 * panel clusters the paths into glyphs. White/background fills are dropped so the
 * sheet's background never becomes one giant blob (robust even where the v28+
 * ignoreWhite property no longer applies). */

// Is this item a light/white fill (the sheet background, not ink)?
function fmIsLight(item) {
  try {
    if (!item.filled) return false;
    var c = item.fillColor; if (!c) return false;
    var t = c.typename;
    if (t === 'RGBColor') return (c.red + c.green + c.blue) > 660;            // near white
    if (t === 'GrayColor') return c.gray < 40;                               // 0=white,100=black
    if (t === 'CMYKColor') return (c.cyan + c.magenta + c.yellow + c.black) < 12;
  } catch (e) {}
  return false;
}

// Flatten traced art into ink PathItems, skipping white/background fills.
function fmCollectTrace(item, out) {
  var t = item.typename;
  if (t === 'PathItem') {
    if (item.pathPoints && item.pathPoints.length >= 2 && !fmIsLight(item)) out.push(item);
  } else if (t === 'CompoundPathItem') {
    if (fmIsLight(item)) return out;        // a white compound = background, skip whole thing
    var cp = item.pathItems;
    for (var i = 0; i < cp.length; i++) if (cp[i].pathPoints && cp[i].pathPoints.length >= 2) out.push(cp[i]);
  } else if (t === 'GroupItem') {
    var pi = item.pageItems;
    for (var j = 0; j < pi.length; j++) fmCollectTrace(pi[j], out);
  }
  return out;
}

function fmPickImages() {
  try {
    var filt;
    if ($.os && String($.os).toLowerCase().indexOf('windows') !== -1) {
      filt = 'Reference sheets:*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.tif;*.tiff;*.webp';
    } else {
      filt = function (f) { return (f instanceof Folder) || /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(f.name); };
    }
    var sel = File.openDialog('Select 1–4 reference sheets', filt, true);
    if (!sel) return '{"ok":false,"error":"cancelled"}';
    if (!(sel instanceof Array)) sel = [sel];
    var parts = [];
    for (var i = 0; i < sel.length; i++) {
      var fp = String(sel[i].fsName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      parts.push('"' + fp + '"');
    }
    return '{"ok":true,"files":[' + parts.join(',') + ']}';
  } catch (e) {
    return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}';
  }
}

function fmTraceImage(arg) {
  var doc = null;
  try {
    var cfg = eval('(' + arg + ')');
    var f = new File(cfg.path);
    if (!f.exists) return '{"ok":false,"error":"file not found"}';

    doc = app.documents.add(DocumentColorSpace.RGB, 2000, 2000);
    var placed = doc.placedItems.add();
    placed.file = f;
    var imgB = placed.geometricBounds; // full placed-image frame [l,t,r,b] — lets the panel align the trace to the raster preview
    app.redraw();

    var traced = null;
    try { traced = placed.trace(); }
    catch (e1) {
      try { placed.embed(); if (doc.rasterItems.length) traced = doc.rasterItems[0].trace(); } catch (e2) {}
    }
    if (!traced) { doc.close(SaveOptions.DONOTSAVECHANGES); return '{"ok":false,"error":"could not start Image Trace"}'; }

    // Black & white settings (property names vary across versions → all best-effort).
    try {
      var to = traced.tracing.tracingOptions;
      var presets = app.tracingPresetList, chosen = null, i;
      for (i = 0; i < presets.length; i++) {
        var pn = String(presets[i]).toLowerCase();
        if (pn.indexOf('black') !== -1 && pn.indexOf('white') !== -1) { chosen = presets[i]; break; }
      }
      if (chosen) { try { to.loadFromPreset(chosen); } catch (eP) {} }
      try { to.tracingMode = TracingModeType.TRACINGMODEBLACKANDWHITE; } catch (eM) {}
      try { to.threshold = (cfg.threshold != null ? cfg.threshold : 128); } catch (eT) {}
      try { to.pathFidelity = (cfg.paths != null ? cfg.paths : 50); } catch (eF) {}   // Illustrator "Paths"
      try { to.cornerFidelity = (cfg.corners != null ? cfg.corners : 75); } catch (eC) {} // "Corners"
      try { to.noiseFidelity = (cfg.noise != null ? cfg.noise : 25); } catch (eN) {}    // "Noise"
      try { to.fills = true; } catch (eFi) {}
      try { to.strokes = false; } catch (eSt) {}
      try { to.ignoreWhite = true; } catch (eW) {}
    } catch (eOpt) {}
    app.redraw();

    var grp;
    try { grp = traced.tracing.expandTracing(); }
    catch (eExp) { doc.close(SaveOptions.DONOTSAVECHANGES); return '{"ok":false,"error":"expand failed"}'; }

    var b = grp.geometricBounds; // [left, top, right, bottom] (Y-up)
    var paths = [];
    fmCollectTrace(grp, paths);
    var parts = [];
    for (var k = 0; k < paths.length; k++) parts.push(fmSerializePath(paths[k]));
    var bs = '[' + fmNum(b[0]) + ',' + fmNum(b[1]) + ',' + fmNum(b[2]) + ',' + fmNum(b[3]) + ']';
    var ibs = '[' + fmNum(imgB[0]) + ',' + fmNum(imgB[1]) + ',' + fmNum(imgB[2]) + ',' + fmNum(imgB[3]) + ']';

    doc.close(SaveOptions.DONOTSAVECHANGES);
    return '{"ok":true,"bounds":' + bs + ',"imgBounds":' + ibs + ',"count":' + paths.length + ',"paths":[' + parts.join(',') + ']}';
  } catch (e) {
    try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (eC2) {}
    return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}';
  }
}

// Public: minimal probe so the panel can confirm the bridge is alive.
function fmPing() {
  var name = (app.documents.length > 0) ? app.activeDocument.name : '';
  return '{"ok":true,"app":"' + app.name + '","version":"' + app.version + '","doc":"' + name + '"}';
}

/* ===================== Project / artboard generation =====================
 * "Create Font" builds the whole Illustrator project up front: one artboard per
 * glyph, the selected construction grids drawn on a locked reference layer, a
 * low-opacity ghost letter (Arial) to trace, and an unlocked "Artwork" layer to
 * draw on. SCALE maps font units → points so everything is consistent. */
var FM_SCALE = 0.25; // points per font unit (per-glyph editing — comfortable draw size)
// The TEMPLATE sheet uses a much smaller scale: with hundreds of cells the 0.25 sheet
// was ~8000×5000pt and choked low-RAM machines / the GPU. It's all vector, so a
// smaller scale loses no quality — it just makes a far lighter document (~2000–3000pt).
// fmOpenTemplate swaps FM_SCALE to this while building; fmReadTemplate maps back with it.
var FM_TPL_SCALE = 0.1;

function fmColor(g) {
  var c = new RGBColor();
  if (g && g.length === 3) { c.red = g[0]; c.green = g[1]; c.blue = g[2]; }
  else { c.red = g; c.green = g; c.blue = g; }
  return c;
}
function fmStroke(layer, pts, gray, width, dashed) {
  var p = layer.pathItems.add();
  p.setEntirePath(pts);
  p.filled = false; p.stroked = true;
  p.strokeColor = fmColor(gray);
  p.strokeWidth = width || 0.5;
  if (dashed) p.strokeDashes = [3, 3];
  p.name = 'fm-guide';
  return p;
}

function fmHas(grids, kind) { for (var i = 0; i < grids.length; i++) if (grids[i].kind === kind) return grids[i]; return null; }
function fmDrawGrids(layer, grids, M, left, right, bottom) {
  function fy(u) { return bottom + (u - M.descender) * FM_SCALE; }
  var w = right - left, cx = (left + right) / 2, capPx = M.capHeight * FM_SCALE;
  // Each component draws only when its effect is present (Grid tier selection).
  if (fmHas(grids, 'metrics')) {
    fmStroke(layer, [[left, fy(M.descender)], [right, fy(M.descender)]], 205, 0.5);
    fmStroke(layer, [[left, fy(M.ascender)], [right, fy(M.ascender)]], 205, 0.5);
    fmStroke(layer, [[left, fy(M.capHeight)], [right, fy(M.capHeight)]], 190, 0.5);
    fmStroke(layer, [[left, fy(M.xHeight)], [right, fy(M.xHeight)]], 190, 0.5);
    fmStroke(layer, [[left, fy(0)], [right, fy(0)]], 130, 0.75); // baseline
  }
  if (fmHas(grids, 'sidebearings')) {
    fmStroke(layer, [[left, fy(M.descender)], [left, fy(M.ascender)]], 220, 0.4);
    fmStroke(layer, [[right, fy(M.descender)], [right, fy(M.ascender)]], 220, 0.4);
  }
  var em = fmHas(grids, 'emsquare');
  if (em) {
    // centre-aligned (like the designer); with mul=2 every 2nd line from the
    // centre is a thicker, darker major line
    var cell = (em.cell || 62) * FM_SCALE, mul = em.mul || 1;
    var midY = (fy(M.descender) + fy(M.ascender)) / 2, k, q;
    for (k = 0; cx + k * cell < right || cx - k * cell > left; k++) {
      q = (mul === 2 && k % 2 === 0);
      if (cx + k * cell < right) fmStroke(layer, [[cx + k * cell, fy(M.descender)], [cx + k * cell, fy(M.ascender)]], q ? 150 : 230, q ? 0.6 : 0.3);
      if (k > 0 && cx - k * cell > left) fmStroke(layer, [[cx - k * cell, fy(M.descender)], [cx - k * cell, fy(M.ascender)]], q ? 150 : 230, q ? 0.6 : 0.3);
    }
    for (k = 0; midY + k * cell < fy(M.ascender) || midY - k * cell > fy(M.descender); k++) {
      q = (mul === 2 && k % 2 === 0);
      if (midY + k * cell < fy(M.ascender)) fmStroke(layer, [[left, midY + k * cell], [right, midY + k * cell]], q ? 150 : 230, q ? 0.6 : 0.3);
      if (k > 0 && midY - k * cell > fy(M.descender)) fmStroke(layer, [[left, midY - k * cell], [right, midY - k * cell]], q ? 150 : 230, q ? 0.6 : 0.3);
    }
  }
  if (fmHas(grids, 'web')) { // diagonal web: corner X + diagonals to apex & bottom mid
    var b = fy(0), t = fy(M.capHeight);
    fmStroke(layer, [[left, b], [right, t]], 200, 0.3); fmStroke(layer, [[right, b], [left, t]], 200, 0.3);
    fmStroke(layer, [[left, b], [cx, t]], 200, 0.3); fmStroke(layer, [[right, b], [cx, t]], 200, 0.3);
    fmStroke(layer, [[left, t], [cx, b]], 200, 0.3); fmStroke(layer, [[right, t], [cx, b]], 200, 0.3);
  }
  var bn = fmHas(grids, 'broadnib');
  if (bn) {
    var ang = (bn.penAngle || 30) * Math.PI / 180, dy = Math.tan(ang), step = capPx / 3;
    for (var sx = left - w; sx < right + w; sx += step) {
      fmStroke(layer, [[sx, fy(M.descender)], [sx + (fy(M.ascender) - fy(M.descender)) / Math.max(dy, 0.01), fy(M.ascender)]], 224, 0.3);
    }
  }
  var se = fmHas(grids, 'superellipse');
  if (se) {
    var ov = (se.overshoot || 12) * FM_SCALE;
    fmStroke(layer, [[left, fy(0) - ov], [right, fy(0) - ov]], 225, 0.35, true);
    fmStroke(layer, [[left, fy(M.capHeight) + ov], [right, fy(M.capHeight) + ov]], 225, 0.35, true);
    fmStroke(layer, [[left, fy(M.xHeight) + ov], [right, fy(M.xHeight) + ov]], 225, 0.35, true);
  }
  var ci = fmHas(grids, 'circle');
  if (ci) {
    var wf = ci.wf || 0.85;
    fmEllipse(layer, cx, fy(M.capHeight), capPx * wf, capPx);
    fmEllipse(layer, cx, fy(M.capHeight) - capPx * 0.085, capPx * 0.83 * wf, capPx * 0.83); // counter
    fmEllipse(layer, cx, fy(M.xHeight), M.xHeight * FM_SCALE * wf, M.xHeight * FM_SCALE);
  }
  if (fmHas(grids, 'wideEllipse')) fmEllipse(layer, cx, fy(M.capHeight * 0.75), w, capPx / 2);
  if (fmHas(grids, 'stacked')) {
    var r = capPx / 4;
    fmEllipse(layer, cx, fy(M.capHeight), r * 2, r * 2);
    fmEllipse(layer, cx, fy(M.capHeight * 0.75), r * 2, r * 2);
    fmEllipse(layer, cx, fy(M.capHeight * 0.5), r * 2, r * 2);
  }
  // user-designed grid items (panel canvas): font units, x 0..1000 across the
  // glyph box, y -200..800; expand symmetry mirrors here.
  var de = fmHas(grids, 'design');
  if (de) {
    var fx = function (u) { return left + (u / 1000) * w; };
    var items = [];
    for (var di = 0; di < de.items.length; di++) {
      // symmetry is stamped per item at creation time (not a global toggle)
      var it = de.items[di], vs = [it];
      if (it.symY) vs.push(fmMirror(it, true, false));
      if (it.symX) { var n = vs.length; for (var vi = 0; vi < n; vi++) vs.push(fmMirror(vs[vi], false, true)); }
      for (var v = 0; v < vs.length; v++) items.push(vs[v]);
    }
    for (var ii = 0; ii < items.length; ii++) {
      var g2 = items[ii];
      var red = g2.red ? [192, 39, 29] : null; // brand red for flagged items
      if (g2.type === 'circle') {
        var rr = g2.r * FM_SCALE;
        fmEllipse(layer, fx(g2.cx), fy(g2.cy) + rr, rr * 2, rr * 2);
      } else if (g2.type === 'dline') {
        var a2 = g2.angle * Math.PI / 180, ddx = Math.cos(a2), ddy = Math.sin(a2);
        fmStroke(layer, [[fx(g2.cx - 1600 * ddx), fy(g2.cy - 1600 * ddy)], [fx(g2.cx + 1600 * ddx), fy(g2.cy + 1600 * ddy)]], red || 210, 0.35, true);
      } else if (g2.type === 'hline') {
        fmStroke(layer, [[left, fy(g2.y)], [right, fy(g2.y)]], red || 150, 0.6);
      } else if (g2.type === 'vline') {
        fmStroke(layer, [[fx(g2.x), fy(M.descender)], [fx(g2.x), fy(M.ascender)]], red || 150, 0.6);
      }
    }
  }
}
// Mirror a designed grid item about the vertical (x=500) / horizontal (y=300) axis.
function fmMirror(it, vert, horz) {
  var c = {}; for (var k in it) c[k] = it[k];
  if (vert) {
    if (c.cx != null) c.cx = 1000 - c.cx;
    if (c.x != null) c.x = 1000 - c.x;
    if (c.angle != null) c.angle = (180 - c.angle + 360) % 360;
  }
  if (horz) {
    if (c.cy != null) c.cy = 600 - c.cy;
    if (c.y != null) c.y = 600 - c.y;
    if (c.angle != null) c.angle = (360 - c.angle) % 360;
  }
  return c;
}
// Stroked ellipse guide: centered at cx, top at topY, given width & height.
function fmEllipse(layer, cx, topY, width, height) {
  var e = layer.pathItems.ellipse(topY, cx - width / 2, width, height);
  e.filled = false; e.stroked = true; e.strokeColor = fmColor(220); e.strokeWidth = 0.35; e.name = 'fm-guide';
  return e;
}

var FM_DESCENDERS = 'gjpqyµç';
function fmGhostFont(attr) {
  try { attr.textFont = app.textFonts.getByName('ArialMT'); }
  catch (e1) { try { attr.textFont = app.textFonts.getByName('Arial'); } catch (e2) {} }
}
// Calibrate ONCE: (1) a uniform ghost scale from the cap OUTLINE so caps fill the
// cell; (2) the font's type DESCENT — the gap between a text frame's bounds bottom
// (the line/type box, which is CONSTANT for every glyph regardless of accents) and
// the true baseline. Seating by (typeBoxBottom + typeDescent) is accent-proof: a
// cedilla/comma below or an acute/circumflex above never shifts the baseline,
// because the line box itself doesn't move. That fixes the "accented letter sits
// too high" bug (its ink dipped below the baseline, but the line box did not).
function fmGhostCalib(layer, M, upm) {
  var scale = 1, typeDescent = 0;
  try {
    var rf = layer.textFrames.add(); rf.contents = 'H';
    fmGhostFont(rf.textRange.characterAttributes); rf.textRange.characterAttributes.size = upm * FM_SCALE;
    var ol = rf.createOutline(); var gb = ol.geometricBounds, capInk = gb[1] - gb[3]; ol.remove();
    if (capInk > 0) scale = (M.capHeight * FM_SCALE) / capInk;
  } catch (e) {}
  try {
    var nf = layer.textFrames.add(); nf.contents = 'n';
    fmGhostFont(nf.textRange.characterAttributes); nf.textRange.characterAttributes.size = upm * FM_SCALE * scale;
    var typeBottom = nf.geometricBounds[3];          // line/type-box bottom (= baseline - descent)
    var no = nf.createOutline(); var inkBottom = no.geometricBounds[3]; no.remove();  // 'n' is flat → ink bottom = baseline
    typeDescent = inkBottom - typeBottom;            // baseline - (baseline - descent) = descent
  } catch (e) {}
  return { scale: scale, typeDescent: typeDescent };
}
function fmGhost(layer, ch, left, right, bottom, M, upm, cal, yb) {
  if (ch === ' ' || ch === '') return;
  cal = cal || { scale: 1, typeDescent: 0 };
  try {
    var tf = layer.textFrames.add();
    tf.contents = ch;
    var attr = tf.textRange.characterAttributes;
    attr.size = upm * FM_SCALE * cal.scale;   // one uniform calibrated size for every letter
    fmGhostFont(attr);
    // SOLID faint gray, NOT 12% opacity. Transparency forces Illustrator into
    // transparency-group compositing on every redraw; hundreds of transparent
    // ghosts on a big artboard overwhelmed the GPU (display driver TDR — the screen
    // went black every few seconds). A solid light fill looks the same but is cheap.
    attr.fillColor = fmColor(205);
    var typeBottom = tf.geometricBounds[3];     // line-box bottom (fallback only)
    var g = tf.createOutline();                 // real outline (visual + ink bounds)
    g.name = 'fm-ghost';                        // opacity stays 100% — no transparency
    var ink = g.geometricBounds;                // [l, t, r, b] (y up) real ink bounds
    // Seat by the glyph's TRUE ink + Arial's known y-bounds for this char: the ink
    // [ink[3]..ink[1]] corresponds to Arial [yMin..yMax] (em fractions), so the
    // baseline (y=0) sits ink[3] - yMin*k above the ink bottom. This places '_' below
    // the baseline, '-' at mid-height, accents above — exactly, regardless of how the
    // text frame reports its box. Falls back to the line-box estimate if no data.
    var baseline;
    if (yb && yb.length === 2 && (yb[1] - yb[0]) > 0.000001) {
      var k = (ink[1] - ink[3]) / (yb[1] - yb[0]);   // pt per em-fraction
      baseline = ink[3] - yb[0] * k;
    } else {
      baseline = typeBottom + cal.typeDescent;
    }
    var gridBase = bottom + (0 - M.descender) * FM_SCALE;   // baseline grid line = fy(0)
    var cx = left + (right - left) / 2;
    g.translate(cx - (ink[0] + ink[2]) / 2, gridBase - baseline);
  } catch (e) { /* ghost is best-effort (e.g. CJK not in Arial) */ }
}

// Append one artboard (for a new alternate/ligature glyph) with grids + ghost.
function fmAppendArtboard(arg) {
  try {
    if (app.documents.length === 0) return '{"ok":false,"error":"no document"}';
    var cfg = eval('(' + arg + ')');
    var doc = app.activeDocument, M = cfg.metrics, grids = cfg.grids || [];
    var span = (M.ascender - M.descender), AH = span * FM_SCALE, AW = Math.round(AH * 0.72), GAP = Math.round(AH * 0.16), COLS = 8;
    var idx = doc.artboards.length, col = idx % COLS, row = Math.floor(idx / COLS);
    var left = 100 + col * (AW + GAP), top = -100 - row * (AH + GAP), right = left + AW, bottom = top - AH;
    doc.artboards.add([left, top, right, bottom]);
    var ab = doc.artboards[doc.artboards.length - 1];
    try { ab.name = cfg.name; } catch (eN) {}
    var refLayer = null;
    for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === 'Reference (locked)') { refLayer = doc.layers[i]; break; }
    if (refLayer) {
      refLayer.locked = false;
      fmDrawGrids(refLayer, grids, M, left, right, bottom); // grid is the only ghost
      refLayer.locked = true;
    }
    return '{"ok":true,"index":' + idx + '}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// Draw font-unit contours back into Illustrator (inverse of fmReadActive's map):
// docX = left + fx*scale, docY = baseline + fy*scale (Y-up, no flip).
// signed area of a contour's anchor polygon (>0 = counter-clockwise, y-up)
function fmAnchorArea(pts) {
  var a = 0;
  for (var i = 0; i < pts.length; i++) { var p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
// is (x,y) inside the anchor polygon (ray cast)?
function fmPtInPoly(x, y, pts) {
  var inside = false;
  for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    var xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}
// reverse a contour's direction (order + swap in/out handles)
function fmReverseContour(ct) {
  var pts = ct.points, out = [];
  for (var i = pts.length - 1; i >= 0; i--) {
    var s = pts[i];
    out.push({ x: s.x, y: s.y, type: s.type,
      handleIn: s.handleOut ? { x: s.handleOut.x, y: s.handleOut.y } : null,
      handleOut: s.handleIn ? { x: s.handleIn.x, y: s.handleIn.y } : null });
  }
  ct.points = out;
}
// Make windings alternate by nesting depth: outer contours one way, the counters
// nested inside them the other way — so the compound path's non-zero fill turns
// inner contours (O, D, B, A, e, o…) into holes instead of solid fills.
function fmFixWindings(contours) {
  var n = contours.length; if (n < 2) return;
  for (var k = 0; k < n; k++) {
    var pk = contours[k].points; if (!pk || pk.length < 3) continue;
    var p0 = pk[0], depth = 0;
    for (var j = 0; j < n; j++) {
      if (j === k) continue;
      var pj = contours[j].points;
      if (pj && pj.length >= 3 && fmPtInPoly(p0.x, p0.y, pj)) depth++;
    }
    var wantCCW = (depth % 2 === 0), isCCW = fmAnchorArea(pk) > 0;
    if (wantCCW !== isCCW) fmReverseContour(contours[k]);
  }
}
function fmFillPath(p, pts, mx, my) {
  for (var i = 0; i < pts.length; i++) {
    var s = pts[i];
    var pp = p.pathPoints.add();
    pp.anchor = [mx(s.x), my(s.y)];
    pp.leftDirection = s.handleIn ? [mx(s.handleIn.x), my(s.handleIn.y)] : pp.anchor;
    pp.rightDirection = s.handleOut ? [mx(s.handleOut.x), my(s.handleOut.y)] : pp.anchor;
    pp.pointType = (s.type === 'smooth') ? PointType.SMOOTH : PointType.CORNER;
  }
}
function fmDrawContours(layer, contours, left, bottom, M) {
  var baseY = bottom + (0 - M.descender) * FM_SCALE;
  function mx(x) { return left + x * FM_SCALE; }
  function my(y) { return baseY + y * FM_SCALE; }
  var real = [];
  for (var c = 0; c < contours.length; c++) { if (contours[c].points && contours[c].points.length >= 2) real.push(contours[c]); }
  if (!real.length) return;
  // single contour: a plain filled path (no holes possible)
  if (real.length === 1) {
    var p = layer.pathItems.add();
    p.filled = true; p.stroked = false; p.closed = !!real[0].closed; p.fillColor = fmColor(0);
    fmFillPath(p, real[0].points, mx, my);
    return;
  }
  // multiple contours: alternate windings by nesting depth, then draw ONE compound
  // path so inner contours read as holes (O = ring, D = hollow) — not solid fills
  fmFixWindings(real);
  var comp = null;
  try {
    comp = layer.compoundPathItems.add();
    for (var k = 0; k < real.length; k++) {
      var sp = comp.pathItems.add();
      sp.filled = true; sp.stroked = false; sp.closed = !!real[k].closed; sp.fillColor = fmColor(0);
      fmFillPath(sp, real[k].points, mx, my);
    }
  } catch (e) { comp = null; }
  // fallback (older AI / API hiccup): separate filled paths, never error out
  if (!comp || comp.pathItems.length !== real.length) {
    try { if (comp) comp.remove(); } catch (e2) {}
    for (var k2 = 0; k2 < real.length; k2++) {
      var pf = layer.pathItems.add();
      pf.filled = true; pf.stroked = false; pf.closed = !!real[k2].closed; pf.fillColor = fmColor(0);
      fmFillPath(pf, real[k2].points, mx, my);
    }
  }
}

// Open ONE glyph for editing: a single-artboard document with the selected
// grids + ghost (and any existing/dragged artwork), reusing one edit doc so we
// don't spawn a document per click. Edits sync back to the plugin (no file).
// One Illustrator DOCUMENT per glyph (never an extra artboard). Open documents
// are tracked in $.global.fmGlyphDocs by glyph name; clicking the same glyph
// re-activates its project with the user's work untouched.
function fmGlyphDocs() {
  if (!$.global.fmGlyphDocs) $.global.fmGlyphDocs = {};
  return $.global.fmGlyphDocs;
}
function fmDocAlive(doc) {
  try { return !!(doc && doc.name !== undefined && doc.artboards.length >= 0); } catch (e) { return false; }
}
function fmOpenGlyph(arg) {
  try {
    var cfg = eval('(' + arg + ')');
    var M = cfg.metrics, grids = cfg.grids || [];
    var AH = (M.ascender - M.descender) * FM_SCALE;
    var AW = Math.round((cfg.advanceWidth || Math.round((M.ascender - M.descender) * 0.6)) * FM_SCALE);
    var docs = fmGlyphDocs();

    // Already open? Just bring its project forward — keep the work as-is.
    var doc = docs[cfg.name];
    if (fmDocAlive(doc)) {
      app.activeDocument = doc;
      return '{"ok":true,"name":"' + (cfg.name || '') + '","reused":true,"doc":"' + doc.name + '"}';
    }

    // A NEW project for this glyph (one artboard).
    doc = app.documents.add(DocumentColorSpace.RGB, AW + 200, AH + 200);
    docs[cfg.name] = doc;
    var left = 100, top = -100, right = left + AW, bottom = top - AH;
    doc.artboards[0].artboardRect = [left, top, right, bottom];
    try { doc.artboards[0].name = cfg.name; } catch (eN) {}

    var refLayer = doc.layers.add(); refLayer.name = 'Reference (locked)';
    var artLayer = doc.layers.add(); artLayer.name = 'Artwork'; artLayer.zOrder(ZOrderMethod.BRINGTOFRONT);
    for (var li = doc.layers.length - 1; li >= 0; li--) {
      var L = doc.layers[li];
      if (L !== refLayer && L !== artLayer) { try { L.locked = false; L.remove(); } catch (eX) {} }
    }

    // The user's construction grid is the ghost reference (drawn faint by
    // fmDrawGrids) — no Arial ghost letter. The real shape stays solid black.
    fmDrawGrids(refLayer, grids, M, left, right, bottom);
    refLayer.locked = true;

    if (cfg.contours && cfg.contours.length) fmDrawContours(artLayer, cfg.contours, left, bottom, M);
    doc.activeLayer = artLayer;
    try { app.executeMenuCommand('fitall'); } catch (eF) {}
    return '{"ok":true,"name":"' + (cfg.name || '') + '","doc":"' + doc.name + '"}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// Which glyph does the ACTIVE document belong to? ('' if none of ours.)
function fmActiveGlyphName() {
  try {
    var docs = fmGlyphDocs(), act = app.activeDocument;
    for (var k in docs) { if (docs.hasOwnProperty(k) && fmDocAlive(docs[k]) && docs[k] === act) return k; }
  } catch (e) {}
  return '';
}

// Replace the artwork of a glyph's project with the given contours (font
// units) — used when the panel transforms the shape (scaling), so both stay
// identical.
function fmSetArt(arg) {
  try {
    var cfg = eval('(' + arg + ')');
    var docs = fmGlyphDocs(), doc = docs[cfg.name];
    if (!fmDocAlive(doc)) return '{"ok":false,"error":"glyph project is not open"}';
    var layer = null;
    for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === 'Artwork') { layer = doc.layers[i]; break; }
    if (!layer) return '{"ok":false,"error":"no Artwork layer"}';
    for (var j = layer.pageItems.length - 1; j >= 0; j--) { try { layer.pageItems[j].remove(); } catch (e2) {} }
    var r = doc.artboards[0].artboardRect;
    fmDrawContours(layer, cfg.contours || [], r[0], r[3], cfg.metrics);
    return '{"ok":true}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// Translate the artwork of a glyph's project by (dx, dy) points — used when the
// shape is dragged on the panel's canvas, so both stay in sync.
function fmShiftArt(arg) {
  try {
    var cfg = eval('(' + arg + ')');
    var docs = fmGlyphDocs(), doc = docs[cfg.name];
    if (!fmDocAlive(doc)) return '{"ok":false,"error":"glyph project is not open"}';
    var layer = null;
    for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === 'Artwork') { layer = doc.layers[i]; break; }
    if (!layer) return '{"ok":false,"error":"no Artwork layer"}';
    for (var j = 0; j < layer.pageItems.length; j++) layer.pageItems[j].translate(cfg.dx, cfg.dy);
    return '{"ok":true}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// Collect PathItems on a container whose ink center lies inside an artboard rect.
function fmCollectInRect(container, rect, out) {
  var items = container.pageItems;
  for (var i = 0; i < items.length; i++) {
    var it = items[i], t = it.typename;
    if (t === 'GroupItem') { fmCollectInRect(it, rect, out); continue; }
    var bag = [];
    if (t === 'PathItem') bag = [it];
    else if (t === 'CompoundPathItem') { for (var c = 0; c < it.pathItems.length; c++) bag.push(it.pathItems[c]); }
    for (var b = 0; b < bag.length; b++) {
      var p = bag[b];
      if (!p.pathPoints || p.pathPoints.length < 2) continue;
      var gb = p.geometricBounds; // [l,t,r,btm] y-up
      var cx = (gb[0] + gb[2]) / 2, cy = (gb[1] + gb[3]) / 2;
      if (cx >= rect[0] && cx <= rect[2] && cy <= rect[1] && cy >= rect[3]) out.push(p);
    }
  }
}

// Public: read the artwork on the ACTIVE artboard (the glyph being worked on)
// for live sync. Returns the artboard index, its rect, FM_SCALE and the paths.
function fmReadActive() {
  try {
    if (app.documents.length === 0) return '{"ok":false,"error":"no document"}';
    var doc = app.activeDocument;
    // The TEMPLATE is a batch workflow (Open → draw every letter → Import), not live
    // per-glyph sync. Bail instantly here so the 700ms poller doesn't read+serialize
    // the whole sheet's artwork and force Illustrator to flush geometry / redraw a
    // big document on a timer (which, with the GPU already busy, made it stutter).
    for (var ti = 0; ti < doc.layers.length; ti++) if (doc.layers[ti].name.indexOf('Template') === 0) return '{"ok":false,"error":"template"}';
    var idx = doc.artboards.getActiveArtboardIndex();
    var ab = doc.artboards[idx];
    var r = ab.artboardRect;
    var layer = null;
    for (var i = 0; i < doc.layers.length; i++) if (doc.layers[i].name === 'Artwork') { layer = doc.layers[i]; break; }
    var paths = [];
    if (layer) fmCollectInRect(layer, r, paths);
    var parts = [];
    for (var k = 0; k < paths.length; k++) parts.push(fmSerializePath(paths[k]));
    return '{"ok":true,"index":' + idx + ',"scale":' + FM_SCALE +
           ',"glyph":"' + fmActiveGlyphName().replace(/"/g, '\\"') + '"' +
           ',"rect":[' + r[0] + ',' + r[1] + ',' + r[2] + ',' + r[3] + ']' +
           ',"paths":[' + parts.join(',') + ']}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// ===== Fontself-style TEMPLATE: one document with a locked box+grid+ghost per
// glyph (A–Z, a–z, 0–9). The user draws each letter into its box; Import reads
// every box's artwork and maps it to that glyph. Each cell spans descender..
// ascender (height = (asc-desc)*FM_SCALE), so the same baseline mapping that
// fmReadActive/ilbridge.contoursFromArtboard uses works per cell. =====
// tiny set-name caption (e.g. "Latin Uppercase") drawn just above each set; its
// top-left lands at (x, y). Deliberately very small relative to the cells.
function fmLabel(layer, text, x, y, size) {
  try {
    var t = layer.textFrames.add(); t.contents = text;
    var a = t.textRange.characterAttributes; a.size = size; fmGhostFont(a);
    a.fillColor = fmColor(120);
    t.name = 'fm-label';
    var gb = t.geometricBounds;            // [l, t, r, b] — move its top-left to (x, y)
    t.translate(x - gb[0], y - gb[1]);
  } catch (e) {}
}
// A cell spec is either a bare character (string) — the classic per-letter template —
// or an object { ghost, id, w } used for alternates/ligatures: ghost = the faint
// letter(s) to trace, id = the glyph NAME (boxes are matched back by it, not a char
// code, since alternates/ligatures have no unique char), w = width factor (ligatures
// are wider so they fit and aren't clipped on import).
function fmCellSpec(item) {
  if (typeof item === 'string') return { ghost: item, id: '' + item.charCodeAt(0), w: 1 };
  return { ghost: item.ghost != null ? item.ghost : '', id: '' + (item.id != null ? item.id : ''), w: (item.w > 0 ? item.w : 1) };
}
function fmTemplateCells(sets, M) {
  // cell HEIGHT must stay (ascender-descender)*FM_SCALE so the baseline mapping
  // (contoursFromArtboard at FM_SCALE) reads drawn letters at the right size. WIDTH
  // may vary per cell (alternates = 1, ligatures wider) — height is constant.
  var AH = (M.ascender - M.descender) * FM_SCALE;
  var AW = Math.round(AH * 0.81);   // single-letter box width (~13% wider for drawing room)
  var GAP = Math.round(AH * 0.10);
  var GAP_IN = Math.round(AH * 0.07);     // TIGHT gap between wrapped rows of the SAME set
  var GAP_SET = Math.round(AH * 0.34);    // clear gap BETWEEN sets; a new set starts a fresh row
  var LABEL_BAND = Math.round(AH * 0.22);
  var LABEL_SIZE = Math.round(AH * 0.07);
  var MAX_ROW_W = 50 * (AW + GAP);        // wrap a row at ~50 single cells wide (variable widths honoured)
  var MARGIN = Math.round(AH * 0.4);
  var cells = [], labels = [], top = -MARGIN;   // content flows top-left, downward
  for (var s = 0; s < sets.length; s++) {
    var set = sets[s], chs = set.chars || set, n = chs.length;
    labels.push({ name: set.name || '', x: MARGIN, y: top, size: LABEL_SIZE }); // caption in the band
    var rowTop = top - LABEL_BAND, left = MARGIN, rows = 1;
    for (var i = 0; i < n; i++) {
      var sp = fmCellSpec(chs[i]);
      var cw = Math.round(AW * sp.w);
      if (left > MARGIN && (left + cw) > (MARGIN + MAX_ROW_W)) { left = MARGIN; rowTop = rowTop - (AH + GAP_IN); rows++; } // wrap
      cells.push({ ghost: sp.ghost, id: sp.id, left: left, top: rowTop, right: left + cw, bottom: rowTop - AH });
      left = left + cw + GAP;
    }
    top = rowTop - AH - GAP_SET;       // drop below the last row of this set + gap
  }
  return { cells: cells, labels: labels, margin: MARGIN };
}
function fmOpenTemplate(arg) {
  var _savedScale = FM_SCALE; FM_SCALE = FM_TPL_SCALE;   // build the whole sheet at the compact scale
  try {
    var cfg = eval('(' + arg + ')');
    var M = cfg.metrics, grids = cfg.grids || [], sets = cfg.sets || cfg.rows || [], upm = cfg.unitsPerEm || 1000;
    var ybounds = cfg.ybounds || null;   // per-char Arial ink y-bounds for exact ghost seating
    if (!sets.length && cfg.chars && cfg.chars.length) sets = [cfg.chars]; // back-compat
    if (!sets.length) return '{"ok":false,"error":"no characters"}';
    var tc = fmTemplateCells(sets, M), cells = tc.cells, labels = tc.labels, MARGIN = tc.margin;
    if (!cells.length) return '{"ok":false,"error":"no characters"}';
    // The artboard starts at the WORKBOARD's top-left (0,0) and grows right/down to
    // exactly fit the content (cells + captions) with one MARGIN all round — so it
    // always hugs the letters and never spills off the canvas.
    var cR = -1e9, cB = 1e9;
    for (var i = 0; i < cells.length; i++) { var c0 = cells[i]; if (c0.right > cR) cR = c0.right; if (c0.bottom < cB) cB = c0.bottom; }
    var abL = 0, abT = 0, abR = cR + MARGIN, abB = cB - MARGIN;   // top-left corner at the origin
    var doc = app.documents.add(DocumentColorSpace.RGB, Math.max(50, Math.ceil(abR - abL)), Math.max(50, Math.ceil(abT - abB)));
    try { doc.artboards[0].artboardRect = [abL, abT, abR, abB]; } catch (eA) {}
    var tpl = doc.layers.add(); tpl.name = 'Template (locked)';
    var art = doc.layers.add(); art.name = 'Artwork'; art.zOrder(ZOrderMethod.BRINGTOFRONT);
    for (var li = doc.layers.length - 1; li >= 0; li--) { var L = doc.layers[li]; if (L !== tpl && L !== art) { try { L.locked = false; L.remove(); } catch (eX) {} } }
    var gcal = fmGhostCalib(tpl, M, upm);   // one uniform ghost size + baseline calibration for the sheet
    for (var li2 = 0; li2 < labels.length; li2++) { var lb = labels[li2]; if (lb.name) fmLabel(tpl, lb.name, lb.x, lb.y, lb.size); }
    for (var c = 0; c < cells.length; c++) {
      var ce = cells[c];
      var box = tpl.pathItems.rectangle(ce.top, ce.left, ce.right - ce.left, ce.top - ce.bottom);
      box.filled = false; box.stroked = true; box.strokeColor = fmColor(150); box.strokeWidth = 0.5;
      box.name = 'fmcell:' + ce.id;                          // tag the box by glyph id (char code OR glyph name) so Import recovers it
      fmDrawGrids(tpl, grids, M, ce.left, ce.right, ce.bottom); // baseline / cap / x / sidebearings
      var yb = ybounds ? ybounds[ce.id] : null;
      fmGhost(tpl, ce.ghost, ce.left, ce.right, ce.bottom, M, upm, gcal, yb); // faint target letter(s) to trace
    }
    tpl.locked = true;
    doc.activeLayer = art;
    try { app.executeMenuCommand('fitall'); } catch (eF) {}
    return '{"ok":true,"cells":' + cells.length + ',"sets":' + sets.length + ',"doc":"' + String(doc.name).replace(/"/g, '\\"') + '"}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
  finally { FM_SCALE = _savedScale; }
}
// Gather EVERY drawn leaf path on the Artwork layer ONCE, caching each path's bbox
// CENTRE. This is the key to keeping template import fast: geometricBounds is an
// expensive ExtendScript call (it flushes geometry), so we read it once per path
// here instead of once per (box × path) — the old quadratic scan that froze big
// multi-set templates (hundreds of boxes × the drawn paths = tens of thousands of
// geometricBounds reads). Assignment to boxes is then just cheap number compares.
function fmCollectArt(container, out) {
  var items = container.pageItems;
  for (var i = 0; i < items.length; i++) {
    var it = items[i], t = it.typename;
    if (t === 'GroupItem') { fmCollectArt(it, out); continue; }
    var bag = [];
    if (t === 'PathItem') bag = [it];
    else if (t === 'CompoundPathItem') { for (var c = 0; c < it.pathItems.length; c++) bag.push(it.pathItems[c]); }
    for (var b = 0; b < bag.length; b++) {
      var p = bag[b];
      if (!p.pathPoints || p.pathPoints.length < 2) continue;
      var gb = p.geometricBounds;                  // read ONCE per path
      out.push({ p: p, cx: (gb[0] + gb[2]) / 2, cy: (gb[1] + gb[3]) / 2 });
    }
  }
}
function fmReadTemplate() {
  try {
    if (app.documents.length === 0) return '{"ok":false,"error":"no document open"}';
    var doc = app.activeDocument, tpl = null, art = null;
    for (var i = 0; i < doc.layers.length; i++) { var L = doc.layers[i]; if (L.name.indexOf('Template') === 0) tpl = L; else if (L.name === 'Artwork') art = L; }
    if (!tpl) return '{"ok":false,"error":"This document is not a RuneType template (no Template layer)."}';
    var boxes = [];
    (function scan(container) {
      var items = container.pageItems;
      for (var k = 0; k < items.length; k++) { var it = items[k]; if (it.typename === 'GroupItem') { scan(it); continue; } if (it.name && it.name.indexOf('fmcell:') === 0) boxes.push(it); }
    })(tpl);
    var arts = [];
    if (art) fmCollectArt(art, arts);              // ALL drawn paths + centres — bounds read once each
    var parts = [];
    for (var b = 0; b < boxes.length; b++) {
      var bx = boxes[b], id = bx.name.substring(7);  // everything after 'fmcell:' — char code OR glyph name
      if (!id) continue;
      var code = parseInt(id, 10); if (!(code > 0)) code = 0;        // back-compat numeric code for the char template
      var gb = bx.geometricBounds;                 // [l, t, r, btm] (y-up)
      var ps = [];
      for (var a = 0; a < arts.length; a++) {      // assign by centre-in-box — pure arithmetic, no DOM reads
        var ar = arts[a];
        if (ar.cx >= gb[0] && ar.cx <= gb[2] && ar.cy <= gb[1] && ar.cy >= gb[3]) ps.push(fmSerializePath(ar.p));
      }
      if (!ps.length) continue;
      var idEsc = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      parts.push('{"id":"' + idEsc + '","code":' + code + ',"rect":[' + gb[0] + ',' + gb[1] + ',' + gb[2] + ',' + gb[3] + '],"paths":[' + ps.join(',') + ']}');
    }
    return '{"ok":true,"scale":' + FM_TPL_SCALE + ',"cells":[' + parts.join(',') + ']}';   // template was built at FM_TPL_SCALE
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

