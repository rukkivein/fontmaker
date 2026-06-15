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
var FM_SCALE = 0.25; // points per font unit

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
var FM_ROUND = 'oceasbdgpqOCGSQUJ';   // curved bottoms that dip slightly below the baseline
// Calibrate ONCE, using only ink HEIGHTS (origin-independent — no cross-frame
// position assumptions): (1) a uniform ghost scale from the cap OUTLINE so caps
// land on the cap line; (2) the descender depth ('p' minus 'n') and the round
// overshoot ('o' minus 'n'), used per-letter to recover the true baseline.
function fmGhostCalib(layer, M, upm) {
  var scale = 1, descDepth = 0, ovsht = 0;
  function inkHeight(ch) {
    var f = layer.textFrames.add(); f.contents = ch;
    fmGhostFont(f.textRange.characterAttributes); f.textRange.characterAttributes.size = upm * FM_SCALE * scale;
    var gb = f.geometricBounds; f.remove(); return gb[1] - gb[3];
  }
  try {
    var rf = layer.textFrames.add(); rf.contents = 'H';
    fmGhostFont(rf.textRange.characterAttributes); rf.textRange.characterAttributes.size = upm * FM_SCALE;
    var ol = rf.createOutline(); var gb = ol.geometricBounds, capInk = gb[1] - gb[3]; ol.remove();
    if (capInk > 0) scale = (M.capHeight * FM_SCALE) / capInk;
  } catch (e) {}
  try {
    var nH = inkHeight('n'), pH = inkHeight('p'), oH = inkHeight('o');  // at the calibrated size
    descDepth = Math.max(0, pH - nH);     // 'p' = x-height + descender ; 'n' = x-height
    ovsht = Math.max(0, (oH - nH) / 2);   // 'o' overshoots top AND bottom vs the flat 'n'
  } catch (e) {}
  return { scale: scale, descDepth: descDepth, overshoot: ovsht };
}
function fmGhost(layer, ch, left, right, bottom, M, upm, cal) {
  if (ch === ' ' || ch === '') return;
  cal = cal || { scale: 1, descDepth: 0, overshoot: 0 };
  try {
    var tf = layer.textFrames.add();
    tf.contents = ch;
    var attr = tf.textRange.characterAttributes;
    attr.size = upm * FM_SCALE * cal.scale;   // one uniform calibrated size for every letter
    fmGhostFont(attr);
    tf.opacity = 12;
    tf.name = 'fm-ghost';
    var gb = tf.geometricBounds; // [l, t, r, b] (y up) ink bounds
    var gridBase = bottom + (0 - M.descender) * FM_SCALE;   // the baseline grid line = fy(0)
    // THIS frame's ink-bottom sits `below` units beneath the baseline (descenders
    // deep, round letters a touch); add it back to get the real baseline, then drop
    // that onto the box's baseline grid line. Per-letter → no global drift.
    var below = (FM_DESCENDERS.indexOf(ch) >= 0) ? cal.descDepth : (FM_ROUND.indexOf(ch) >= 0 ? cal.overshoot : 0);
    var dy = gridBase - (gb[3] + below);
    var cx = left + (right - left) / 2;
    tf.translate(cx - (gb[0] + gb[2]) / 2, dy);
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
function fmTemplateCells(sets, M) {
  // cell HEIGHT must stay (ascender-descender)*FM_SCALE so the baseline mapping
  // (contoursFromArtboard at FM_SCALE) reads drawn letters at the right size.
  var AH = (M.ascender - M.descender) * FM_SCALE;
  var AW = Math.round(AH * 0.72);
  var GAP = Math.round(AH * 0.10);
  var GAP_IN = Math.round(AH * 0.07);   // TIGHT gap between wrapped rows of the SAME set
  var GAP_SET = Math.round(AH * 0.30);  // small but clear gap BETWEEN sets (so a 2-row set
  var MAX_COLS = 100;                    //   doesn't blur into a 1-row set); new set = fresh row
  var cells = [], top = 0;
  // ONE block PER SELECTED SET (sets = [[chars of set1], …]). A set wraps to extra
  // rows past MAX_COLS, but a NEW set always starts on a fresh row. Sheet grows down.
  for (var s = 0; s < sets.length; s++) {
    var chs = sets[s], n = chs.length, rowsUsed = Math.max(1, Math.ceil(n / MAX_COLS));
    for (var i = 0; i < n; i++) {
      var col = i % MAX_COLS, ri = (i - col) / MAX_COLS;
      var rowTop = top - ri * (AH + GAP_IN);
      var left = col * (AW + GAP);
      cells.push({ ch: chs[i], left: left, top: rowTop, right: left + AW, bottom: rowTop - AH });
    }
    top -= rowsUsed * AH + (rowsUsed - 1) * GAP_IN + GAP_SET;  // drop below this set, then the set gap
  }
  return cells;
}
function fmOpenTemplate(arg) {
  try {
    var cfg = eval('(' + arg + ')');
    var M = cfg.metrics, grids = cfg.grids || [], sets = cfg.sets || cfg.rows || [], upm = cfg.unitsPerEm || 1000;
    if (!sets.length && cfg.chars && cfg.chars.length) sets = [cfg.chars]; // back-compat
    if (!sets.length) return '{"ok":false,"error":"no characters"}';
    var cells = fmTemplateCells(sets, M);
    if (!cells.length) return '{"ok":false,"error":"no characters"}';
    // the artboard hugs the letters: it always grows to exactly fit the content
    // (one cell-ish margin), and extends downward as more sets/rows are added.
    var cL = 1e9, cR = -1e9, cT = -1e9, cB = 1e9;
    for (var i = 0; i < cells.length; i++) { var c0 = cells[i]; if (c0.left < cL) cL = c0.left; if (c0.right > cR) cR = c0.right; if (c0.top > cT) cT = c0.top; if (c0.bottom < cB) cB = c0.bottom; }
    var pad = Math.round((M.ascender - M.descender) * FM_SCALE * 0.4);
    var abL = cL - pad, abR = cR + pad, abT = cT + pad, abB = cB - pad;
    var doc = app.documents.add(DocumentColorSpace.RGB, Math.max(50, Math.ceil(abR - abL)), Math.max(50, Math.ceil(abT - abB)));
    try { doc.artboards[0].artboardRect = [abL, abT, abR, abB]; } catch (eA) {}
    var tpl = doc.layers.add(); tpl.name = 'Template (locked)';
    var art = doc.layers.add(); art.name = 'Artwork'; art.zOrder(ZOrderMethod.BRINGTOFRONT);
    for (var li = doc.layers.length - 1; li >= 0; li--) { var L = doc.layers[li]; if (L !== tpl && L !== art) { try { L.locked = false; L.remove(); } catch (eX) {} } }
    var gcal = fmGhostCalib(tpl, M, upm);   // one uniform ghost size + baseline calibration for the sheet
    for (var c = 0; c < cells.length; c++) {
      var ce = cells[c];
      var box = tpl.pathItems.rectangle(ce.top, ce.left, ce.right - ce.left, ce.top - ce.bottom);
      box.filled = false; box.stroked = true; box.strokeColor = fmColor(150); box.strokeWidth = 0.5;
      box.name = 'fmcell:' + ce.ch.charCodeAt(0);             // tag the box so Import recovers the glyph
      fmDrawGrids(tpl, grids, M, ce.left, ce.right, ce.bottom); // baseline / cap / x / sidebearings
      fmGhost(tpl, ce.ch, ce.left, ce.right, ce.bottom, M, upm, gcal); // faint target letter to trace
    }
    tpl.locked = true;
    doc.activeLayer = art;
    try { app.executeMenuCommand('fitall'); } catch (eF) {}
    return '{"ok":true,"cells":' + cells.length + ',"rows":' + rows.length + ',"doc":"' + String(doc.name).replace(/"/g, '\\"') + '"}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
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
    var parts = [];
    for (var b = 0; b < boxes.length; b++) {
      var bx = boxes[b], code = parseInt(bx.name.split(':')[1], 10);
      if (!(code > 0)) continue;
      var gb = bx.geometricBounds;                 // [l, t, r, btm] (y-up)
      var paths = [];
      if (art) fmCollectInRect(art, gb, paths);
      if (!paths.length) continue;
      var ps = [];
      for (var p = 0; p < paths.length; p++) ps.push(fmSerializePath(paths[p]));
      parts.push('{"code":' + code + ',"rect":[' + gb[0] + ',' + gb[1] + ',' + gb[2] + ',' + gb[3] + '],"paths":[' + ps.join(',') + ']}');
    }
    return '{"ok":true,"scale":' + FM_SCALE + ',"cells":[' + parts.join(',') + ']}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

