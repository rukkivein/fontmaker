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

function fmColor(g) { var c = new RGBColor(); c.red = g; c.green = g; c.blue = g; return c; }
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

function fmDrawGrids(layer, grids, M, left, right, bottom) {
  function fy(u) { return bottom + (u - M.descender) * FM_SCALE; }
  var w = right - left;
  // Always: horizontal metric lines (baseline a touch darker).
  fmStroke(layer, [[left, fy(M.descender)], [right, fy(M.descender)]], 205, 0.5);
  fmStroke(layer, [[left, fy(M.ascender)], [right, fy(M.ascender)]], 205, 0.5);
  fmStroke(layer, [[left, fy(M.capHeight)], [right, fy(M.capHeight)]], 190, 0.5);
  fmStroke(layer, [[left, fy(M.xHeight)], [right, fy(M.xHeight)]], 190, 0.5);
  fmStroke(layer, [[left, fy(0)], [right, fy(0)]], 130, 0.75); // baseline
  // Side bearings (light verticals).
  fmStroke(layer, [[left, fy(M.descender)], [left, fy(M.ascender)]], 220, 0.4);
  fmStroke(layer, [[right, fy(M.descender)], [right, fy(M.ascender)]], 220, 0.4);

  for (var gi = 0; gi < grids.length; gi++) {
    var g = grids[gi];
    if (g.kind === 'emsquare') {
      var cell = (g.cell || 62) * FM_SCALE;
      for (var x = left + cell; x < right; x += cell) fmStroke(layer, [[x, fy(M.descender)], [x, fy(M.ascender)]], 230, 0.3);
      for (var y = fy(M.descender) + cell; y < fy(M.ascender); y += cell) fmStroke(layer, [[left, y], [right, y]], 230, 0.3);
    } else if (g.kind === 'broadnib') {
      var ang = (g.penAngle || 30) * Math.PI / 180, dy = Math.tan(ang);
      var step = (M.capHeight) * FM_SCALE / 3;
      for (var sx = left - w; sx < right + w; sx += step) {
        var x1 = sx, y1 = fy(M.descender), x2 = sx + (fy(M.ascender) - fy(M.descender)) / Math.max(dy, 0.01), y2 = fy(M.ascender);
        fmStroke(layer, [[x1, y1], [x2, y2]], 224, 0.3);
      }
    } else if (g.kind === 'golden') {
      var phi = 1.618, px = left + w / phi;
      fmStroke(layer, [[px, fy(M.descender)], [px, fy(M.ascender)]], 218, 0.4);
      fmStroke(layer, [[left + w - w / phi, fy(M.descender)], [left + w - w / phi, fy(M.ascender)]], 224, 0.35);
    } else if (g.kind === 'superellipse') {
      var ov = (g.overshoot || 12) * FM_SCALE;
      fmStroke(layer, [[left, fy(0) - ov], [right, fy(0) - ov]], 225, 0.35, true);
      fmStroke(layer, [[left, fy(M.capHeight) + ov], [right, fy(M.capHeight) + ov]], 225, 0.35, true);
      fmStroke(layer, [[left, fy(M.xHeight) + ov], [right, fy(M.xHeight) + ov]], 225, 0.35, true);
    }
  }
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

