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
