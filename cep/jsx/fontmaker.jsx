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
    // every designed item is a real element (symmetry already produced real
    // copies in the panel) — draw them straight through
    var items = de.items;
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
function fmGhost(layer, ch, left, right, bottom, M, upm) {
  function fy(u) { return bottom + (u - M.descender) * FM_SCALE; }
  if (ch === ' ' || ch === '') return;
  try {
    var tf = layer.textFrames.add();
    tf.contents = ch;
    var attr = tf.textRange.characterAttributes;
    // Point size = the em in points, so Arial's own cap/x-height land on the
    // grid lines (the grid metrics are chosen to match typical proportions).
    attr.size = upm * FM_SCALE;
    try { attr.textFont = app.textFonts.getByName('ArialMT'); }
    catch (e1) { try { attr.textFont = app.textFonts.getByName('Arial'); } catch (e2) {} }
    tf.opacity = 11;
    tf.name = 'fm-ghost';
    // Align by ink bounds: baseline = bbox bottom for most letters; nudge down
    // by a descender's depth for letters that sit below the baseline.
    var gb = tf.geometricBounds; // [l, t, r, b] (y up)
    var baseY = fy(0);
    var hasDesc = FM_DESCENDERS.indexOf(ch) !== -1;
    var targetBottom = hasDesc ? (baseY - 0.21 * upm * FM_SCALE) : baseY;
    var cx = left + (right - left) / 2;
    var dx = cx - (gb[0] + gb[2]) / 2;
    var dy = targetBottom - gb[3];
    tf.translate(dx, dy);
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
      fmDrawGrids(refLayer, grids, M, left, right, bottom);
      fmGhost(refLayer, cfg.ghost || '', left, right, bottom, M, cfg.unitsPerEm || 1000);
      refLayer.locked = true;
    }
    return '{"ok":true,"index":' + idx + '}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

// Draw font-unit contours back into Illustrator (inverse of fmReadActive's map):
// docX = left + fx*scale, docY = baseline + fy*scale (Y-up, no flip).
function fmDrawContours(layer, contours, left, bottom, M) {
  var baseY = bottom + (0 - M.descender) * FM_SCALE;
  function mx(x) { return left + x * FM_SCALE; }
  function my(y) { return baseY + y * FM_SCALE; }
  for (var c = 0; c < contours.length; c++) {
    var ct = contours[c], pts = ct.points;
    if (!pts || pts.length < 2) continue;
    var p = layer.pathItems.add();
    p.filled = true; p.stroked = false; p.closed = !!ct.closed;
    for (var i = 0; i < pts.length; i++) {
      var s = pts[i];
      var pp = p.pathPoints.add();
      pp.anchor = [mx(s.x), my(s.y)];
      pp.leftDirection = s.handleIn ? [mx(s.handleIn.x), my(s.handleIn.y)] : pp.anchor;
      pp.rightDirection = s.handleOut ? [mx(s.handleOut.x), my(s.handleOut.y)] : pp.anchor;
      pp.pointType = (s.type === 'smooth') ? PointType.SMOOTH : PointType.CORNER;
    }
  }
}

// Open ONE glyph for editing: a single-artboard document with the selected
// grids + ghost (and any existing/dragged artwork), reusing one edit doc so we
// don't spawn a document per click. Edits sync back to the plugin (no file).
function fmOpenGlyph(arg) {
  try {
    var cfg = eval('(' + arg + ')');
    var M = cfg.metrics, grids = cfg.grids || [];
    var AH = (M.ascender - M.descender) * FM_SCALE;
    var AW = Math.round((cfg.advanceWidth || Math.round((M.ascender - M.descender) * 0.6)) * FM_SCALE);

    // REUSE one edit document (never close it — closing the last doc shows the
    // Home screen and hides the panel). If our doc is gone, make a new one.
    var doc = null;
    try { if ($.global.fmEditDoc && $.global.fmEditDoc.name !== undefined) doc = $.global.fmEditDoc; } catch (eR) { doc = null; }
    if (doc) { app.activeDocument = doc; }
    else { doc = app.documents.add(DocumentColorSpace.RGB, AW + 200, AH + 200); $.global.fmEditDoc = doc; }

    // Exactly ONE artboard — never add a new artboard beside an existing one.
    while (doc.artboards.length > 1) { try { doc.artboards.remove(doc.artboards.length - 1); } catch (eA) { break; } }
    var left = 100, top = -100, right = left + AW, bottom = top - AH;
    doc.artboards[0].artboardRect = [left, top, right, bottom];
    try { doc.artboards[0].name = cfg.name; } catch (eN) {}

    // Fresh layers, then drop any leftover layers from the previous glyph.
    var refLayer = doc.layers.add(); refLayer.name = 'Reference (locked)';
    var artLayer = doc.layers.add(); artLayer.name = 'Artwork'; artLayer.zOrder(ZOrderMethod.BRINGTOFRONT);
    for (var li = doc.layers.length - 1; li >= 0; li--) {
      var L = doc.layers[li];
      if (L !== refLayer && L !== artLayer) { try { L.locked = false; L.remove(); } catch (eX) {} }
    }

    fmDrawGrids(refLayer, grids, M, left, right, bottom);
    fmGhost(refLayer, cfg.ghost || cfg.char || '', left, right, bottom, M, cfg.unitsPerEm || 1000);
    refLayer.locked = true;

    if (cfg.contours && cfg.contours.length) fmDrawContours(artLayer, cfg.contours, left, bottom, M);
    doc.activeLayer = artLayer;
    try { app.executeMenuCommand('fitall'); } catch (eF) {}
    return '{"ok":true,"name":"' + (cfg.name || '') + '"}';
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
           ',"rect":[' + r[0] + ',' + r[1] + ',' + r[2] + ',' + r[3] + ']' +
           ',"paths":[' + parts.join(',') + ']}';
  } catch (e) { return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}'; }
}

