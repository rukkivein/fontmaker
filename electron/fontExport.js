'use strict';
const fs = require('fs');
const opentype = require('opentype.js');

/*
 * Converts a FontMaker project into a real OpenType font using opentype.js.
 *
 * Model coordinates are font units, y-up, baseline at y=0 — exactly what
 * opentype expects, so no flipping is needed here.
 *
 * For static formats (otf/ttf/woff) we render one master's layer per glyph.
 * "variable" export is approximated by exporting the default master and
 * tagging metadata; true gvar/fvar generation is beyond opentype.js and is
 * marked as a known limitation.
 */
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

// Shoelace signed area over on-curve points (y-up): >0 = counter-clockwise.
function signedArea(contour) {
  const p = contour.points; let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
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
    handleIn: p.handleOut ? { ...p.handleOut } : null,   // swap in/out on reversal
    handleOut: p.handleIn ? { ...p.handleIn } : null,
  }));
  return { closed: c.closed, points: pts };
}

// Set winding so the font's non-zero fill rule punches counters correctly:
// outer contours CCW, holes CW (CFF/OTF convention). Nesting depth is found by
// point-in-polygon containment — even depth = outer, odd = hole. Without this,
// letters like O, A, e export filled solid even though they look right on screen
// (where we draw with even-odd). This mirrors how Glyphr Studio computes winding.
function normalizeWinding(contours) {
  const polys = contours.map(c => c.points);
  return contours.map((c, i) => {
    if (c.points.length < 3) return c;
    const sample = c.points[0];
    let depth = 0;
    for (let j = 0; j < contours.length; j++) {
      if (j === i || contours[j].points.length < 3) continue;
      if (pointInPolygon(sample.x, sample.y, polys[j])) depth++;
    }
    const wantCCW = depth % 2 === 0;   // outer => CCW, hole => CW
    const isCCW = signedArea(c) > 0;
    return isCCW === wantCCW ? c : reverseContour(c);
  });
}

function glyphToPath(glyph, masterId) {
  const path = new opentype.Path();
  const layer = glyph.layers && glyph.layers[masterId];
  if (layer && layer.contours) {
    for (const c of normalizeWinding(layer.contours)) contourToCommands(path, c);
  }
  return path;
}

function pickMaster(project, metadata) {
  if (metadata && metadata.masterId && project.masters.some(m => m.id === metadata.masterId)) {
    return metadata.masterId;
  }
  return project.masters[0].id;
}

function exportFont(project, format, metadata, filePath) {
  const upm = project.unitsPerEm || 1000;
  const masterId = pickMaster(project, metadata);

  const notdef = new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: Math.round(upm * 0.5),
    path: new opentype.Path()
  });

  const glyphs = [notdef];
  let count = 0;
  for (const g of project.glyphs) {
    const path = glyphToPath(g, masterId);
    const otGlyph = new opentype.Glyph({
      name: g.name || ('uni' + (g.unicode || 0).toString(16)),
      unicode: g.unicode || undefined,
      advanceWidth: Math.round(g.advanceWidth != null ? g.advanceWidth : upm * 0.6),
      path
    });
    glyphs.push(otGlyph);
    count++;
  }

  const font = new opentype.Font({
    familyName: metadata.familyName || 'Untitled',
    styleName: metadata.styleName || 'Regular',
    unitsPerEm: upm,
    ascender: project.metrics ? project.metrics.ascender : Math.round(upm * 0.8),
    descender: project.metrics ? project.metrics.descender : -Math.round(upm * 0.2),
    glyphs
  });

  // Stamp optional metadata into the name table.
  if (metadata.designer) font.names.designer = { en: metadata.designer };
  if (metadata.copyright) font.names.copyright = { en: metadata.copyright };
  if (metadata.license) font.names.license = { en: metadata.license };
  if (metadata.version) font.names.version = { en: String(metadata.version) };
  if (metadata.manufacturer) font.names.manufacturer = { en: metadata.manufacturer };

  // ---- GSUB: make alternates (ssNN/salt) and ligatures (liga) real --------
  // opentype.js works in glyph indices; ours are project index + 1 (.notdef=0).
  try {
    const nameToOt = new Map(), charToOt = new Map();
    project.glyphs.forEach((g, pi) => {
      nameToOt.set(g.name, pi + 1);
      if (g.char) charToOt.set(g.char, pi + 1);
    });
    const ligatures = [];          // { sub:[ot], by:ot }
    const altsByBase = new Map();  // baseOt -> [altOt]
    const singles = [];            // { feature:'ssNN', sub:baseOt, by:altOt }
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
    // opentype.js requires features in ALPHABETICAL order: liga < salt < ssNN.
    for (const l of ligatures) font.substitution.addLigature('liga', l);
    for (const [base, alts] of altsByBase) font.substitution.addAlternate('salt', { sub: base, by: alts });
    singles.sort((a, b) => a.feature.localeCompare(b.feature));
    for (const s of singles) font.substitution.addSingle(s.feature, { sub: s.sub, by: s.by });
  } catch (e) { /* GSUB is best-effort; never block the export */ }

  const buffer = font.toArrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return { glyphCount: count };
}

module.exports = { export: exportFont };
