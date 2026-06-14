'use strict';
// Project model helpers for the CEP panel. CommonJS + pure (no host APIs) so the
// same code runs in the panel and under Node tests. Mirrors the Electron app's
// project shape (src/js/project.js) and its cap-height assignment logic
// (src/js/workboard.js) closely enough that core/fontEngine.js consumes it.

const charsets = require('./charsets.js');
const dna = require('./dna.js');

const UPM = 1000;
// Arial-normalized standard metrics (UPM 1000) so the Arial ghost sits exactly
// on the grid lines (cap 716, x 519). See shared/charsets.js BASE.
const DEFAULT_METRICS = { ascender: 800, capHeight: 716, xHeight: 519, baseline: 0, descender: -200 };
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
    alphabet: it.alphabet || 'custom',
    advanceWidth: Math.round(UPM * 0.6),
    layers: emptyLayers(masters),
  }));

  // Ways to define the construction grid:
  //  - gridDesign: a user-designed canvas (circles / dashed lines / square grid
  //    / guides + symmetry) from the panel's grid designer.
  //  - gridComponents: an explicit set of grid components.
  //  - preset / dna: a DNA preset or custom DNA (legacy/programmatic).
  let d, grids, presetLabel, gridComponents = null, gridDesign = null;
  if (opts.gridDesign) {
    gridDesign = opts.gridDesign;
    d = Object.assign({}, dna.BASE, opts.dna || {});
    grids = dna.designToGrids(gridDesign, UPM);
    presetLabel = 'Custom grid';
  } else if (opts.gridComponents) {
    gridComponents = opts.gridComponents.slice();
    d = Object.assign({}, dna.BASE, opts.dna || {});
    grids = dna.componentsToGrids(gridComponents, d, UPM);
    presetLabel = 'Grid';
  } else {
    const presetDef = dna.byName(opts.preset || dna.DEFAULT_PRESET);
    d = Object.assign({}, presetDef.params, opts.dna || {});
    grids = dna.toGrids(d, UPM);
    presetLabel = opts.dna ? 'Custom DNA' : presetDef.name;
  }
  const metrics = Object.assign({}, DEFAULT_METRICS);
  metrics.xHeight = Math.round((d.xHeight / 100) * metrics.capHeight);

  return {
    schema: 1,
    meta: {
      familyName: opts.familyName || 'Untitled', styleName: opts.styleName || 'Regular',
      designer: opts.designer || '', manufacturer: '',
      version: opts.version || '1.000', copyright: '', license: '',
    },
    unitsPerEm: UPM,
    metrics,
    dna: d,
    preset: presetLabel,
    gridComponents,
    gridDesign,
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

// Strip diacritics so a search for "a" also finds à á â ã ä å ā ă ą …
function baseLetter(ch) {
  try { return (ch || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  catch (e) { return ch || ''; }
}
// Does a glyph match a search query? Matches the exact char, the same base
// letter (accents stripped), or the glyph name containing the query.
function glyphMatches(glyph, query) {
  const q = (query || '').trim();
  if (!q) return true;
  if (glyph.char === q) return true;
  const gb = baseLetter(glyph.char).toLowerCase();
  const qb = baseLetter(q).toLowerCase();
  if (gb && gb === qb) return true;
  if ((glyph.name || '').toLowerCase().indexOf(q.toLowerCase()) >= 0) return true;
  return false;
}

module.exports = {
  UPM, DEFAULT_METRICS, glyphName,
  createProject, addMaster, contoursBounds, assignContoursToGlyph,
  setGlyphContours, layerSignature, createAlternate, createLigature,
  baseLetter, glyphMatches, charsets,
};
