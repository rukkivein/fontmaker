'use strict';
// Platform-agnostic font generator. Pure JS + opentype.js only — NO Node fs or
// Buffer — so the exact same engine runs in the Electron app AND inside an
// Illustrator UXP plugin. Hosts call buildFont() and write the ArrayBuffer
// using whatever file API they have.
const opentype = require('opentype.js');
const ttfWriter = require('./ttfWriter.js');

function contourToCommands(path, contour) {
  const pts = contour.points;
  if (!pts || pts.length === 0) return;
  path.moveTo(pts[0].x, pts[0].y);
  const n = pts.length;
  const segs = contour.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const hasOut = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
    const hasIn = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
    if (hasOut || hasIn) {
      const c1 = a.handleOut || { x: a.x, y: a.y };
      const c2 = b.handleIn || { x: b.x, y: b.y };
      path.curveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    } else {
      path.lineTo(b.x, b.y);
    }
  }
  if (contour.closed) path.close();
}

function signedArea(contour) {
  const p = contour.points; let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return a / 2;
}
// shoelace over a flattened [{x,y}] polyline (used for nesting area comparisons)
function signedAreaPoly(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return a / 2;
}
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function reverseContour(c) {
  const pts = c.points.slice().reverse().map(p => ({
    x: p.x, y: p.y, type: p.type,
    handleIn: p.handleOut ? { ...p.handleOut } : null,
    handleOut: p.handleIn ? { ...p.handleIn } : null,
  }));
  return { closed: c.closed, points: pts };
}

// Flatten a contour (incl. its bezier curves) to a dense polyline. The nesting test
// MUST follow the real outline: an anchor-only polygon sits INSIDE a curved contour
// (the curve bulges out between anchors), so a large round counter's sample anchor
// could fall in that gap, miss its nesting, and FILL SOLID on export (the O/Q bug).
function flattenContour(c) {
  const pts = c.points, n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x, y: a.y });
    if (a.handleOut || b.handleIn) {
      const c1 = a.handleOut || a, c2 = b.handleIn || b, STEPS = 8;
      for (let s = 1; s < STEPS; s++) {
        const t = s / STEPS, u = 1 - t;
        out.push({
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
        });
      }
    }
  }
  return out;
}
// A point GUARANTEED inside the polygon: the midpoint of the widest interior span on
// the mid-height scanline. A contour's first ANCHOR (the old sample) sits on the
// boundary, where the ray cast is degenerate and — worse — for a big outline the anchor
// or centre can fall inside a SMALL nested contour, inflating its depth and flipping its
// winding. A true interior point + the area guard below kill that.
function interiorPoint(poly) {
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < poly.length; i++) { const y = poly[i].y; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const y = (ymin + ymax) / 2, xs = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].y, yj = poly[j].y;
    if ((yi > y) !== (yj > y)) xs.push((poly[j].x - poly[i].x) * (y - yi) / (yj - yi) + poly[i].x);
  }
  xs.sort((a, b) => a - b);
  let bx = null, bw = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) { const w = xs[k + 1] - xs[k]; if (w > bw) { bw = w; bx = (xs[k] + xs[k + 1]) / 2; } }
  if (bx !== null) return { x: bx, y };
  let cx = 0, cy = 0; for (let i = 0; i < poly.length; i++) { cx += poly[i].x; cy += poly[i].y; }
  return { x: cx / poly.length, y: cy / poly.length };
}
// Outer contours CCW, holes CW (CFF/OTF non-zero fill) so counters punch. Nesting depth
// counts only STRICTLY BIGGER enclosing contours (a contour can't be inside a smaller
// one) tested with a true interior point — robust for many-counter art (the brand mark)
// and curved counters alike.
function normalizeWinding(contours) {
  const polys = contours.map(flattenContour);   // follow the curves, not just anchors
  const areas = polys.map(p => Math.abs(signedAreaPoly(p)));
  const pts = polys.map(p => p.length >= 3 ? interiorPoint(p) : null);
  return contours.map((c, i) => {
    if (c.points.length < 3 || !pts[i]) return c;
    const ai = areas[i], pi = pts[i];
    let depth = 0;
    for (let j = 0; j < contours.length; j++) {
      if (j === i || contours[j].points.length < 3) continue;
      if (areas[j] > ai && pointInPolygon(pi.x, pi.y, polys[j])) depth++;
    }
    const wantCCW = depth % 2 === 0;
    return (signedArea(c) > 0) === wantCCW ? c : reverseContour(c);
  });
}

function glyphToPath(glyph, masterId) {
  const path = new opentype.Path();
  const layer = glyph.layers && glyph.layers[masterId];
  // preWound layers (the union-baked placeholder mark) already carry correct non-zero
  // windings; re-deriving them would fill the mark's many-stroke-enclosed counters solid.
  if (layer && layer.contours) {
    const ctrs = layer.preWound ? layer.contours : normalizeWinding(layer.contours);
    for (const c of ctrs) contourToCommands(path, c);
  }
  return path;
}

function pickMaster(project, metadata) {
  if (metadata && metadata.masterId && project.masters.some(m => m.id === metadata.masterId)) return metadata.masterId;
  return project.masters[0].id;
}

function addGsub(font, project) {
  try {
    const nameToOt = new Map(), charToOt = new Map();
    project.glyphs.forEach((g, pi) => { nameToOt.set(g.name, pi + 1); if (g.char) charToOt.set(g.char, pi + 1); });
    const ligatures = [], altsByBase = new Map(), singles = [];
    project.glyphs.forEach((g, pi) => {
      const ot = pi + 1;
      if (g.kind === 'alternate' && g.baseName && nameToOt.has(g.baseName)) {
        const base = nameToOt.get(g.baseName);
        const ssm = g.name.match(/\.ss(\d+)$/);
        if (ssm) singles.push({ feature: 'ss' + ssm[1], sub: base, by: ot });
        if (!altsByBase.has(base)) altsByBase.set(base, []);
        altsByBase.get(base).push(ot);
      } else if (g.kind === 'ligature' && g.components) {
        const comps = g.components.map(c => charToOt.get(c));
        if (comps.every(x => x != null)) ligatures.push({ sub: comps, by: ot });
      }
    });
    // Features must be added alphabetically: liga < salt < ssNN.
    for (const l of ligatures) font.substitution.addLigature('liga', l);
    for (const [base, alts] of altsByBase) font.substitution.addAlternate('salt', { sub: base, by: alts });
    singles.sort((a, b) => a.feature.localeCompare(b.feature));
    for (const s of singles) font.substitution.addSingle(s.feature, { sub: s.sub, by: s.by });
  } catch (e) { /* GSUB best-effort */ }
}

// Returns { buffer: ArrayBuffer, glyphCount }. Host writes the buffer.
function buildFont(project, format, metadata) {
  const upm = project.unitsPerEm || 1000;
  const masterId = pickMaster(project, metadata);

  // glyf-flavored TrueType goes through the dedicated writer (opentype.js only
  // emits CFF). Note: the TTF path carries no GSUB (ligatures/alternates are
  // CFF-only here).
  if (format === 'ttf') {
    let count = 0; for (const g of project.glyphs) count++;
    return { buffer: ttfWriter.buildGlyfFont(project, metadata, masterId), glyphCount: count };
  }

  const glyphs = [new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: Math.round(upm * 0.5), path: new opentype.Path() })];
  let count = 0;
  for (const g of project.glyphs) {
    glyphs.push(new opentype.Glyph({
      name: g.name || ('uni' + (g.unicode || 0).toString(16)),
      unicode: g.unicode || undefined,
      advanceWidth: Math.round(g.advanceWidth != null ? g.advanceWidth : upm * 0.6),
      path: glyphToPath(g, masterId),
    }));
    count++;
  }

  const font = new opentype.Font({
    familyName: metadata.familyName || 'Untitled',
    styleName: metadata.styleName || 'Regular',
    unitsPerEm: upm,
    ascender: project.metrics ? project.metrics.ascender : Math.round(upm * 0.8),
    descender: project.metrics ? project.metrics.descender : -Math.round(upm * 0.2),
    glyphs,
  });

  if (metadata.designer) font.names.designer = { en: metadata.designer };
  if (metadata.copyright) font.names.copyright = { en: metadata.copyright };
  if (metadata.license) font.names.license = { en: metadata.license };
  if (metadata.version) font.names.version = { en: String(metadata.version) };
  if (metadata.manufacturer) font.names.manufacturer = { en: metadata.manufacturer };

  addGsub(font, project);
  return { buffer: font.toArrayBuffer(), glyphCount: count };
}

module.exports = { buildFont };
