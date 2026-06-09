'use strict';
// Font DNA — a parameter space that presets live in. Pure data + helpers, used
// by the panel (preset picker) and by the grid the per-glyph artboard draws.
// Two tiers: QUICK (plain-language, for everyone) and ADVANCED (type-historical).
// Every parameter is 0–100 except where noted; presets override a neutral base.

const PARAMS = [
  'xHeight', 'width', 'weight', 'contrast', 'stress', 'penAngle', 'aperture',
  'roundness', 'overshoot', 'terminal', 'serifSize', 'serifBracket', 'geometry',
  'rhythm', 'counterSize', 'modulation', 'gridDensity',
];

// Neutral starting point; presets override a few axes each.
const BASE = {
  xHeight: 70, width: 50, weight: 40, contrast: 10, stress: 0, penAngle: 0,
  aperture: 50, roundness: 50, overshoot: 18, terminal: 20, serifSize: 0,
  serifBracket: 0, geometry: 50, rhythm: 50, counterSize: 50, modulation: 20,
  gridDensity: 50,
};

function dna(overrides) { return Object.assign({}, BASE, overrides || {}); }

// ---- QUICK (basic) presets — plain language ----
const QUICK = [
  { name: 'Clean', similar: 'Inter, Helvetica', params: dna({ xHeight: 75, contrast: 5, roundness: 40, aperture: 60, geometry: 60 }) },
  { name: 'Friendly', similar: 'Nunito, Sofia Pro', params: dna({ xHeight: 75, contrast: 10, roundness: 80, aperture: 80, geometry: 30 }) },
  { name: 'Elegant', similar: 'Didot, Bodoni', params: dna({ xHeight: 65, contrast: 90, roundness: 50, aperture: 40, geometry: 50, modulation: 90, serifSize: 40 }) },
  { name: 'Technical', similar: 'DIN, Eurostile', params: dna({ xHeight: 72, contrast: 0, roundness: 20, aperture: 40, geometry: 90 }) },
  { name: 'Classic', similar: 'Garamond, Caslon', params: dna({ xHeight: 62, contrast: 60, roundness: 55, aperture: 50, geometry: 20, serifSize: 45, serifBracket: 100, rhythm: 80 }) },
  { name: 'Modern', similar: 'Avenir, Neue Haas', params: dna({ xHeight: 70, contrast: 20, roundness: 50, aperture: 60, geometry: 70 }) },
  { name: 'Organic', similar: 'Humanist sans', params: dna({ xHeight: 68, contrast: 35, roundness: 70, aperture: 90, geometry: 10, rhythm: 75 }) },
  { name: 'Bold', similar: 'Heavy grotesk', params: dna({ weight: 80, contrast: 15, width: 60, roundness: 40 }) },
  { name: 'Minimal', similar: 'Geometric', params: dna({ contrast: 0, roundness: 30, aperture: 50, geometry: 80 }) },
  { name: 'Expressive', similar: 'Calligraphic', params: dna({ contrast: 70, roundness: 70, aperture: 85, rhythm: 90, penAngle: 20 }) },
];

// ---- ADVANCED presets — a variable-ready DNA space ----
const ADVANCED = [
  { name: 'Neo Grotesk', params: dna({ xHeight: 74, contrast: 5, penAngle: 0, aperture: 35, roundness: 40, overshoot: 18, terminal: 10, geometry: 70, rhythm: 55, modulation: 20 }) },
  { name: 'Geometric Sans', params: dna({ xHeight: 70, contrast: 0, aperture: 20, roundness: 85, overshoot: 15, terminal: 0, geometry: 100, rhythm: 40, counterSize: 45, modulation: 0, gridDensity: 40 }) },
  { name: 'Humanist Sans', params: dna({ xHeight: 68, width: 52, contrast: 25, stress: 25, penAngle: 8, aperture: 80, roundness: 65, overshoot: 22, terminal: 55, geometry: 30, rhythm: 75, counterSize: 65, modulation: 60, gridDensity: 60 }) },
  { name: 'Old Style Serif', params: dna({ xHeight: 63, contrast: 55, stress: 60, penAngle: 25, aperture: 55, roundness: 55, overshoot: 28, terminal: 70, serifSize: 45, serifBracket: 100, geometry: 10, rhythm: 85, counterSize: 60, modulation: 80, gridDensity: 65 }) },
  { name: 'Transitional Serif', params: dna({ xHeight: 66, contrast: 70, stress: 30, penAngle: 15, aperture: 45, roundness: 50, overshoot: 30, terminal: 55, serifSize: 50, serifBracket: 60, geometry: 30, rhythm: 70, counterSize: 55, modulation: 70, gridDensity: 70 }) },
  { name: 'Didone', params: dna({ xHeight: 68, width: 45, contrast: 100, aperture: 25, roundness: 50, overshoot: 35, terminal: 10, serifSize: 55, serifBracket: 0, geometry: 70, rhythm: 45, counterSize: 40, modulation: 100, gridDensity: 90 }) },
  { name: 'Slab Serif', params: dna({ xHeight: 65, width: 55, weight: 50, contrast: 15, aperture: 45, roundness: 25, overshoot: 18, terminal: 5, serifSize: 100, serifBracket: 10, geometry: 70, rhythm: 55, modulation: 15, gridDensity: 55 }) },
  { name: 'Broad Nib', params: dna({ xHeight: 60, weight: 45, contrast: 75, stress: 70, penAngle: 30, aperture: 50, roundness: 40, overshoot: 20, terminal: 80, geometry: 0, rhythm: 90, counterSize: 55, modulation: 90, gridDensity: 60 }) },
  { name: 'Script', params: dna({ xHeight: 52, width: 55, weight: 45, contrast: 80, stress: 80, penAngle: 35, aperture: 85, roundness: 80, overshoot: 22, terminal: 100, geometry: 0, rhythm: 100, counterSize: 75, modulation: 100, gridDensity: 60 }) },
  { name: 'Textura', params: dna({ xHeight: 55, width: 35, weight: 60, contrast: 90, stress: 90, penAngle: 45, aperture: 5, roundness: 0, overshoot: 10, terminal: 20, geometry: 80, rhythm: 30, counterSize: 15, modulation: 20, gridDensity: 95 }) },
  { name: 'Fraktur', params: dna({ xHeight: 54, width: 35, weight: 60, contrast: 95, stress: 100, penAngle: 45, aperture: 5, roundness: 5, overshoot: 10, terminal: 25, geometry: 85, rhythm: 25, counterSize: 15, modulation: 25, gridDensity: 95 }) },
  { name: 'Modular', params: dna({ xHeight: 70, contrast: 0, aperture: 30, roundness: 20, overshoot: 10, terminal: 0, geometry: 100, rhythm: 20, counterSize: 40, modulation: 0, gridDensity: 100 }) },
];

// ---- GRID tier: composable grid components (multi-select, overlayable) ----
// `rec` = part of a sensible grid for an average sans (shown "Recommended").
const GRID_COMPONENTS = [
  { key: 'metrics', label: 'Metric Lines', desc: 'baseline · x-height · cap · ascender · descender', rec: true },
  { key: 'sidebearings', label: 'Side Bearings', desc: 'left & right margins', rec: true },
  { key: 'emgrid', label: 'Em Grid', desc: 'fine unit grid', rec: true },
  { key: 'circles', label: 'Construction Circles', desc: 'cap & x-height bowls + counters', rec: true },
  { key: 'overshoot', label: 'Overshoot Zones', desc: 'optical overshoot at curves', rec: true },
  { key: 'wideEllipse', label: 'Wide Ellipses', desc: 'centre proportion ellipses', rec: false },
  { key: 'stacked', label: 'Stacked Circles', desc: 'vertical circle stack', rec: false },
  { key: 'web', label: 'Diagonal Web', desc: 'corner & midpoint diagonals', rec: false },
  { key: 'broadnib', label: 'Broad-Nib Slants', desc: 'pen-angle calligraphic guides', rec: false },
];
const RECOMMENDED_GRID = GRID_COMPONENTS.filter(c => c.rec).map(c => c.key);

// Chosen components (+ a DNA for parameters like density/pen angle) -> the grid
// effect objects the artboard/PDF draws.
function componentsToGrids(keys, d, upm) {
  d = d || BASE; upm = upm || 1000;
  const has = (k) => keys.indexOf(k) >= 0;
  const out = [];
  if (has('metrics')) out.push({ kind: 'metrics' });
  if (has('sidebearings')) out.push({ kind: 'sidebearings' });
  if (has('emgrid')) { const div = Math.round(8 + (d.gridDensity / 100) * 24); out.push({ kind: 'emsquare', cell: Math.round(upm / div) }); }
  if (has('circles')) out.push({ kind: 'circle', wf: Math.round((0.78 + (d.width / 100) * 0.32) * 100) / 100 });
  if (has('wideEllipse')) out.push({ kind: 'wideEllipse' });
  if (has('stacked')) out.push({ kind: 'stacked' });
  if (has('web')) out.push({ kind: 'web' });
  if (has('overshoot')) out.push({ kind: 'superellipse', overshoot: Math.round((d.overshoot / 100) * 30) });
  if (has('broadnib') && d.penAngle > 0) out.push({ kind: 'broadnib', penAngle: d.penAngle });
  return out;
}

const DEFAULT_PRESET = 'Clean';
function byName(name) {
  const all = QUICK.concat(ADVANCED);
  for (const p of all) if (p.name === name) return p;
  return QUICK[0];
}

// Turn a DNA into the artboard's construction-grid effects (consumed by the
// jsx grid drawer): always metric lines, plus an em grid (density), broad-nib
// slants (penAngle) and overshoot zones (overshoot).
// DNA -> a sensible set of grid components -> effects (used by Advanced presets).
function toGrids(d, upm) {
  const keys = ['metrics', 'sidebearings', 'emgrid'];
  if (d.roundness > 20) keys.push('circles');
  if (d.overshoot > 0) keys.push('overshoot');
  if (d.penAngle > 0) keys.push('broadnib');
  if (d.geometry >= 70) keys.push('web');
  return componentsToGrids(keys, d, upm);
}

module.exports = {
  PARAMS, BASE, QUICK, ADVANCED, DEFAULT_PRESET,
  GRID_COMPONENTS, RECOMMENDED_GRID, componentsToGrids,
  byName, toGrids, dna,
};
