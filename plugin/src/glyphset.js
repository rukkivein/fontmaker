'use strict';
// Project model helpers for the UXP plugin. CommonJS + pure (no host APIs) so
// the same code runs in UXP and under Node tests. Mirrors the Electron app's
// project shape (src/js/project.js) and its cap-height assignment logic
// (src/js/workboard.js) closely enough that core/fontEngine.js consumes it.

const UPM = 1000;
const DEFAULT_METRICS = { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 };
const LSB = 60; // left side bearing used when placing a shape

// --- glyph naming (subset of the Adobe Glyph List) -----------------------
const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const PUNCT_NAMES = {
  ' ': 'space', '.': 'period', ',': 'comma', ':': 'colon', ';': 'semicolon',
  '!': 'exclam', '?': 'question', '-': 'hyphen', "'": 'quotesingle', '"': 'quotedbl',
  '(': 'parenleft', ')': 'parenright', '&': 'ampersand', '@': 'at',
};
function glyphName(ch) {
  if (ch >= 'A' && ch <= 'Z') return ch;
  if (ch >= 'a' && ch <= 'z') return ch;
  if (ch >= '0' && ch <= '9') return DIGIT_NAMES[ch.charCodeAt(0) - 48];
  if (PUNCT_NAMES[ch]) return PUNCT_NAMES[ch];
  return 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

// Ordered default character set shown in the panel grid.
function defaultChars() {
  const up = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const lo = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const dg = '0123456789'.split('');
  const pu = '.,:;!?-\'"()&@'.split('');
  return [].concat(up, lo, dg, pu);
}

function emptyLayers(masters) {
  const o = {};
  for (const m of masters) o[m.id] = { contours: [] };
  return o;
}

function createProject(opts) {
  opts = opts || {};
  const masters = (opts.masterNames && opts.masterNames.length ? opts.masterNames : ['Regular'])
    .map((name, i) => ({ id: 'm' + i, name: name }));
  const chars = opts.chars || defaultChars();
  const glyphs = chars.map(ch => ({
    name: glyphName(ch),
    char: ch,
    unicode: ch.codePointAt(0),
    advanceWidth: Math.round(UPM * 0.6),
    layers: emptyLayers(masters),
  }));
  return {
    schema: 1,
    meta: {
      familyName: opts.familyName || 'Untitled', styleName: opts.styleName || 'Regular',
      designer: '', manufacturer: '', version: '1.000', copyright: '', license: '',
    },
    unitsPerEm: UPM,
    metrics: Object.assign({}, DEFAULT_METRICS),
    masters,
    glyphs,
  };
}

// Bounding box of a set of contours (anchors only — adequate for placement).
function contoursBounds(contours) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const c of contours) for (const p of c.points) {
    any = true;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Scale contours to cap height, sit on the baseline, add sidebearings, then
// write the identical outline into EVERY master (variable-compatible start).
// Mirrors workboard.assignShapeToGlyph.
function assignContoursToGlyph(project, contours, glyphIndex) {
  const glyph = project.glyphs[glyphIndex];
  const b = contoursBounds(contours);
  if (!b) return false;
  const target = project.metrics.capHeight;
  const scale = target / Math.max(b.h, 1);
  const tx = (x) => (x - b.minX) * scale + LSB;
  const ty = (y) => (y - b.minY) * scale;
  const place = () => contours.map(c => ({
    closed: c.closed,
    points: c.points.map(p => ({
      x: tx(p.x), y: ty(p.y), type: p.type,
      handleIn: p.handleIn ? { x: tx(p.handleIn.x), y: ty(p.handleIn.y) } : null,
      handleOut: p.handleOut ? { x: tx(p.handleOut.x), y: ty(p.handleOut.y) } : null,
    })),
  }));
  for (const m of project.masters) glyph.layers[m.id] = { contours: place() };
  glyph.advanceWidth = Math.round(b.w * scale + LSB * 2);
  return true;
}

module.exports = {
  UPM, DEFAULT_METRICS, glyphName, defaultChars,
  createProject, contoursBounds, assignContoursToGlyph,
};
