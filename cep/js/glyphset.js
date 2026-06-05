'use strict';
// Project model helpers for the CEP panel. CommonJS + pure (no host APIs) so the
// same code runs in the panel and under Node tests. Mirrors the Electron app's
// project shape (src/js/project.js) and its cap-height assignment logic
// (src/js/workboard.js) closely enough that core/fontEngine.js consumes it.

const charsets = require('./charsets.js');

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

const DEFAULT_ALPHABETS = ['latinUpper', 'latinLower', 'numbers', 'punct'];

function emptyLayers(masters) {
  const o = {};
  for (const m of masters) o[m.id] = { contours: [] };
  return o;
}

let _mid = 0;
function makeMaster(name, type) {
  return { id: 'm' + (_mid++), name: name || type || 'Regular', type: type || 'Regular' };
}

// Build a new font from the New Font dialog choices.
//   { familyName, styleName, version, designer, masterName, masterType,
//     alphabets:[keys], upperOnly, lowerOnly, grid:key, chars?(legacy) }
function createProject(opts) {
  opts = opts || {};
  const masters = [makeMaster(opts.masterName, opts.masterType)];

  let items;
  if (opts.chars) {
    items = opts.chars.map(ch => ({ char: ch, unicode: ch.codePointAt(0) }));
  } else {
    const keys = (opts.alphabets && opts.alphabets.length) ? opts.alphabets : DEFAULT_ALPHABETS;
    items = charsets.collectGlyphs(keys, { upperOnly: opts.upperOnly, lowerOnly: opts.lowerOnly });
  }
  const glyphs = items.map(it => ({
    name: glyphName(it.char),
    char: it.char,
    unicode: it.unicode,
    advanceWidth: Math.round(UPM * 0.6),
    layers: emptyLayers(masters),
  }));

  // One or more construction grids may be selected (they can overlay). The
  // first selected grid drives the font's metrics.
  let gridKeys = opts.grids && opts.grids.length ? opts.grids.slice() : (opts.grid ? [opts.grid] : ['metrics']);
  const grids = gridKeys
    .map(k => charsets.GRID_BY_KEY[k])
    .filter(Boolean)
    .map(def => Object.assign({ key: def.key, label: def.label }, def.build(UPM)));
  if (!grids.length) grids.push(Object.assign({ key: 'metrics', label: 'Metrics Grid' }, charsets.GRID_BY_KEY.metrics.build(UPM)));

  return {
    schema: 1,
    meta: {
      familyName: opts.familyName || 'Untitled', styleName: opts.styleName || 'Regular',
      designer: opts.designer || '', manufacturer: '',
      version: opts.version || '1.000', copyright: '', license: '',
    },
    unitsPerEm: UPM,
    metrics: Object.assign({}, grids[0].metrics || DEFAULT_METRICS),
    gridKeys: grids.map(g => g.key),
    grids,
    alphabets: (opts.alphabets && opts.alphabets.length) ? opts.alphabets.slice() : DEFAULT_ALPHABETS.slice(),
    masters,
    glyphs,
  };
}

// Add a master to an existing font: every glyph gets an empty layer in it.
function addMaster(project, name, type) {
  const m = makeMaster(name, type);
  project.masters.push(m);
  for (const g of project.glyphs) g.layers[m.id] = { contours: [] };
  return m;
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
// write the outline. With masterId, only that master's layer is written (so each
// master can be drawn independently); without it, every master gets the same
// outline (a variable-compatible starting point). Mirrors workboard logic.
function assignContoursToGlyph(project, contours, glyphIndex, masterId) {
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
  const targets = masterId ? project.masters.filter(m => m.id === masterId) : project.masters;
  if (masterId && targets.length === 0) return false;
  for (const m of targets) glyph.layers[m.id] = { contours: place() };
  glyph.advanceWidth = Math.round(b.w * scale + LSB * 2);
  return true;
}

// Create a stylistic alternate of a base glyph (e.g. B → B.ss01). Appended at
// the end (so artboard↔glyph indices stay aligned), empty in every master,
// variable-compatible. core/fontEngine emits ssNN + salt GSUB for it.
function createAlternate(project, baseIndex) {
  const base = project.glyphs[baseIndex];
  if (!base) return -1;
  const re = new RegExp('^' + base.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.ss(\\d+)$');
  let max = 0;
  for (const g of project.glyphs) { const m = g.name && g.name.match(re); if (m) max = Math.max(max, +m[1]); }
  const ss = String(max + 1).padStart(2, '0');
  const glyph = {
    name: base.name + '.ss' + ss, char: null, unicode: null,
    advanceWidth: base.advanceWidth, layers: emptyLayers(project.masters),
    kind: 'alternate', baseName: base.name, ghost: base.char,
  };
  project.glyphs.push(glyph);
  return project.glyphs.length - 1;
}

// Create a ligature glyph from a string of characters (e.g. "ft" → f_t). Its
// components are the characters; core/fontEngine emits a liga GSUB rule.
function createLigature(project, str) {
  const comps = Array.from(str).filter(c => c.trim());
  if (comps.length < 2) return -1;
  const name = comps.map(glyphName).join('_');
  const existing = project.glyphs.findIndex(g => g.name === name);
  if (existing >= 0) return existing;
  let adv = 0;
  for (const c of comps) { const g = project.glyphs.find(x => x.char === c); adv += g ? g.advanceWidth : Math.round(UPM * 0.6); }
  const glyph = {
    name, char: null, unicode: null, advanceWidth: adv,
    layers: emptyLayers(project.masters),
    kind: 'ligature', components: comps, ghost: comps.join(''),
  };
  project.glyphs.push(glyph);
  return project.glyphs.length - 1;
}

function cloneContours(contours) {
  return contours.map(c => ({
    closed: c.closed,
    points: c.points.map(p => ({
      x: p.x, y: p.y, type: p.type,
      handleIn: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null,
      handleOut: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null,
    })),
  }));
}

// Write contours that are ALREADY in font units (from artboard live-sync)
// straight into a master's layer, no re-scaling. advanceWidth defaults to the
// artwork's right extent + a small side bearing.
function setGlyphContours(project, glyphIndex, masterId, contours, advanceWidth) {
  const glyph = project.glyphs[glyphIndex];
  if (!glyph || !glyph.layers[masterId]) return false;
  glyph.layers[masterId] = { contours: cloneContours(contours) };
  if (advanceWidth != null) glyph.advanceWidth = Math.round(advanceWidth);
  else { const b = contoursBounds(contours); if (b) glyph.advanceWidth = Math.round(b.maxX + LSB); }
  return true;
}

// A cheap signature of a master layer's geometry, to detect live changes.
function layerSignature(glyph, masterId) {
  const l = glyph.layers[masterId];
  if (!l || !l.contours.length) return '';
  let s = '';
  for (const c of l.contours) {
    s += (c.closed ? 'C' : 'O') + c.points.length + ':';
    for (const p of c.points) s += Math.round(p.x) + ',' + Math.round(p.y) + ';';
  }
  return s;
}

module.exports = {
  UPM, DEFAULT_METRICS, glyphName,
  createProject, addMaster, contoursBounds, assignContoursToGlyph,
  setGlyphContours, layerSignature, createAlternate, createLigature, charsets,
};
