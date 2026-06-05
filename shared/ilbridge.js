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

// Convert one Illustrator PathItem to a single contour {closed, points:[...]}.
function contourFromPathItem(pathItem, opts) {
  const flipY = !opts || opts.flipY !== false; // default: flip
  const sy = flipY ? -1 : 1;
  const pp = pathItem.pathPoints;
  const n = pp ? pp.length : 0;
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = pp[i];
    const ax = a.anchor[0], ay = a.anchor[1] * sy;
    const lx = a.leftDirection[0], ly = a.leftDirection[1] * sy;
    const rx = a.rightDirection[0], ry = a.rightDirection[1] * sy;
    const hasIn = Math.abs(lx - ax) > EPS || Math.abs(ly - ay) > EPS;
    const hasOut = Math.abs(rx - ax) > EPS || Math.abs(ry - ay) > EPS;
    points.push({
      x: ax, y: ay,
      type: isSmooth(a) ? 'smooth' : 'corner',
      handleIn: hasIn ? { x: lx, y: ly } : null,
      handleOut: hasOut ? { x: rx, y: ry } : null,
    });
  }
  return { closed: pathItem.closed !== false && n > 1, points };
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

module.exports = { contourFromPathItem, collectPathItems, contoursFromSelection, isSmooth };
