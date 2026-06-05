'use strict';
// Bridge: Adobe Illustrator UXP DOM geometry  ->  FontMaker contour model.
//
// Pure JS, no host APIs, no DOM — so it runs identically inside the UXP plugin
// AND under Node for unit tests (mock path items). The Illustrator scripting
// model gives, per PathPoint:
//   anchor          [x, y]   the on-curve point
//   leftDirection   [x, y]   incoming control handle  -> our handleIn
//   rightDirection  [x, y]   outgoing control handle  -> our handleOut
//   pointType       PointType.SMOOTH | PointType.CORNER
// Illustrator's Y axis points DOWN; our font model is Y-UP, so we negate Y.
// (Winding is later re-normalized by the font engine, so the flip is safe.)

const EPS = 1e-4;

function isSmooth(pp) {
  const t = pp && pp.pointType;
  if (t == null) return false;
  return String(t).toLowerCase().indexOf('smooth') !== -1;
}

// Build a contour from Illustrator pathPoints using a coordinate mapper
// mapPt(x, y) -> {x, y}. Keeps anchor/handle logic in one place.
function buildContour(pp, closed, mapPt) {
  const n = pp ? pp.length : 0;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = pp[i];
    const A = mapPt(a.anchor[0], a.anchor[1]);
    const I = mapPt(a.leftDirection[0], a.leftDirection[1]);
    const O = mapPt(a.rightDirection[0], a.rightDirection[1]);
    const hasIn = Math.abs(I.x - A.x) > EPS || Math.abs(I.y - A.y) > EPS;
    const hasOut = Math.abs(O.x - A.x) > EPS || Math.abs(O.y - A.y) > EPS;
    points.push({
      x: A.x, y: A.y, type: isSmooth(a) ? 'smooth' : 'corner',
      handleIn: hasIn ? { x: I.x, y: I.y } : null,
      handleOut: hasOut ? { x: O.x, y: O.y } : null,
    });
  }
  return { closed: closed !== false && n > 1, points };
}

// Convert one Illustrator PathItem to a contour. Y is flipped by default
// (free-floating selection art; later re-scaled to cap height on assign).
function contourFromPathItem(pathItem, opts) {
  const flipY = !opts || opts.flipY !== false;
  const mapPt = (x, y) => ({ x: x, y: flipY ? -y : y });
  return buildContour(pathItem.pathPoints, pathItem.closed !== false, mapPt);
}

// Convert artwork read from a glyph's artboard into font-unit contours, mapping
// directly off the grid (no bbox re-scaling): x from the left edge, y from the
// baseline, using the same FM_SCALE the grid was drawn with. Illustrator
// artboard space is Y-up like the font model, so no flip here.
function contoursFromArtboard(paths, rect, scale, descender) {
  const L = rect[0], B = rect[3];
  const baseY = B + (0 - descender) * scale;
  const mapPt = (x, y) => ({ x: (x - L) / scale, y: (y - baseY) / scale });
  return (paths || [])
    .map(p => buildContour(p.pathPoints, p.closed !== false, mapPt))
    .filter(c => c.points.length >= 2);
}

// Walk a selection (or any container) and gather every PathItem, descending
// through GroupItem (pageItems) and CompoundPathItem (pathItems). Duck-typed so
// it works on real UXP objects and on plain mock objects in tests.
function collectPathItems(node, out) {
  out = out || [];
  if (node == null) return out;
  // Array / array-like selection.
  if (typeof node.length === 'number' && !node.pathPoints && !node.typename) {
    for (let i = 0; i < node.length; i++) collectPathItems(node[i], out);
    return out;
  }
  // A leaf path: has pathPoints and is not itself a compound container.
  if (node.pathPoints && !node.pathItems) { out.push(node); return out; }
  // Container: prefer pageItems (groups), else pathItems (compound paths).
  const kids = node.pageItems || node.pathItems;
  if (kids && typeof kids.length === 'number') {
    for (let i = 0; i < kids.length; i++) collectPathItems(kids[i], out);
  }
  return out;
}

// Selection -> array of contours, ready to hand to assignContoursToGlyph.
function contoursFromSelection(selection, opts) {
  const items = collectPathItems(selection, []);
  const contours = [];
  for (const it of items) {
    const c = contourFromPathItem(it, opts);
    if (c.points.length >= 2) contours.push(c);
  }
  return contours;
}

module.exports = { contourFromPathItem, collectPathItems, contoursFromSelection, contoursFromArtboard, isSmooth };
