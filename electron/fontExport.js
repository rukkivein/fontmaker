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

function glyphToPath(glyph, masterId) {
  const path = new opentype.Path();
  const layer = glyph.layers && glyph.layers[masterId];
  if (layer && layer.contours) {
    for (const c of layer.contours) contourToCommands(path, c);
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

  const buffer = font.toArrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return { glyphCount: count };
}

module.exports = { export: exportFont };
