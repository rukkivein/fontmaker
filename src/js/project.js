import { UPM, DEFAULT_METRICS, ALPHABETS, GRID_PRESETS } from './data.js';
import { ensureLayer, cubicPoint, makePoint } from './geometry.js';
import { uid } from './store.js';

// Build a brand-new project document from the New Project dialog choices.
export function createProject({ familyName, masterNames, alphabets, gridPreset }) {
  const masters = masterNames.map((name, i) => ({ id: uid('m'), name: name || ('Master ' + (i + 1)) }));
  const gp = GRID_PRESETS[gridPreset] || GRID_PRESETS.standard;
  const grid = { preset: gridPreset, ...gp.build(UPM) };

  // Collect glyphs from each selected alphabet, deduped by unicode.
  const seen = new Set();
  const glyphs = [];
  for (const key of alphabets) {
    const set = ALPHABETS[key];
    if (!set) continue;
    for (const g of set.glyphs()) {
      if (seen.has(g.unicode)) continue;
      seen.add(g.unicode);
      glyphs.push({
        name: g.name,
        char: g.char,
        unicode: g.unicode,
        advanceWidth: Math.round(UPM * 0.6),
        layers: Object.fromEntries(masters.map(m => [m.id, { contours: [] }])),
        grid: null, // per-glyph grid override, lazily created
      });
    }
  }

  return {
    schema: 1,
    meta: {
      familyName: familyName || 'Untitled',
      styleName: 'Regular',
      designer: '',
      manufacturer: '',
      version: '1.000',
      copyright: '',
      license: '',
    },
    unitsPerEm: UPM,
    metrics: { ...DEFAULT_METRICS },
    masters,
    glyphs,
    grid,
    alphabets,
  };
}

export function getGlyph(project, index) {
  return project.glyphs[index];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function emptyLayers(project) { return Object.fromEntries(project.masters.map(m => [m.id, { contours: [] }])); }

// Create a stylistic alternate (X.ssNN) of a base glyph. It is created with
// EMPTY layers in EVERY master, so it is variable-compatible from the start
// (same axes as the base) and shows the base outline as a ghost to trace.
export function createAlternate(project, baseIndex) {
  const base = project.glyphs[baseIndex];
  const baseName = base.name;
  let max = 0;
  const re = new RegExp('^' + escapeRe(baseName) + '\\.ss(\\d+)$');
  for (const g of project.glyphs) { const m = g.name && g.name.match(re); if (m) max = Math.max(max, +m[1]); }
  const ss = String(max + 1).padStart(2, '0');
  const glyph = {
    name: baseName + '.ss' + ss, char: null, unicode: null,
    advanceWidth: base.advanceWidth, layers: emptyLayers(project), grid: null,
    kind: 'alternate', baseName, ghostFrom: baseName,
  };
  // Insert after the base's existing alternates for tidy ordering.
  let pos = baseIndex + 1;
  while (pos < project.glyphs.length && project.glyphs[pos].baseName === baseName) pos++;
  project.glyphs.splice(pos, 0, glyph);
  return pos;
}

// Create a ligature glyph (e.g. f_t) from a string of characters. Empty in all
// masters; shows its component glyphs side-by-side as a ghost.
export function createLigature(project, chars) {
  const comps = [...chars].filter(c => c.trim());
  if (comps.length < 2) return -1;
  const compGlyphs = comps.map(c => project.glyphs.find(g => g.char === c)).filter(Boolean);
  const name = comps.map(c => { const g = project.glyphs.find(x => x.char === c); return g ? g.name : 'uni' + c.codePointAt(0).toString(16); }).join('_');
  if (project.glyphs.some(g => g.name === name)) return project.glyphs.findIndex(g => g.name === name);
  const adv = compGlyphs.reduce((a, g) => a + g.advanceWidth, 0) || Math.round(project.unitsPerEm * 0.8);
  const glyph = {
    name, char: null, unicode: null, advanceWidth: adv, layers: emptyLayers(project), grid: null,
    kind: 'ligature', components: comps, ghostComponents: comps,
  };
  project.glyphs.push(glyph);
  return project.glyphs.length - 1;
}

export function findGlyphByChar(project, ch) {
  return project.glyphs.findIndex(g => g.char === ch);
}

// Insert a new on-curve point on a segment (a..b) of a contour, at param t.
// To keep masters interpolation-compatible, the SAME structural insert is
// applied to every master, using each master's own geometry (computed from
// its cached bezier), so designs are preserved rather than distorted.
export function insertPointAllMasters(project, glyphIndex, ci, segIndex, t) {
  const glyph = project.glyphs[glyphIndex];
  for (const m of project.masters) {
    const layer = ensureLayer(glyph, m.id);
    const contour = layer.contours[ci];
    if (!contour) continue;
    const pts = contour.points, n = pts.length;
    const a = pts[segIndex], b = pts[(segIndex + 1) % n];
    const c1 = a.handleOut || a, c2 = b.handleIn || b;
    const np = cubicPoint(a, c1, c2, b, t);
    const inserted = makePoint(np.x, np.y, 'smooth');
    // de Casteljau split to preserve the curve shape exactly.
    const l1 = lerpPt(a, c1, t), l2 = lerpPt(c1, c2, t), l3 = lerpPt(c2, b, t);
    const m1 = lerpPt(l1, l2, t), m2 = lerpPt(l2, l3, t);
    a.handleOut = { x: l1.x, y: l1.y };
    inserted.handleIn = { x: m1.x, y: m1.y };
    inserted.handleOut = { x: m2.x, y: m2.y };
    b.handleIn = { x: l3.x, y: l3.y };
    contour.points.splice(segIndex + 1, 0, inserted);
  }
}

function lerpPt(p, q, t) { return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; }

// ---- Structural invariant ------------------------------------------------
// All master layers of a glyph must share identical structure (same contour
// count, same point counts, same order) so interpolation/ghosts always work.
// These helpers mutate EVERY master together; geometric (move) edits stay
// per-master. This mirrors how Glyphs/UFO designspace keep layers compatible.

function cloneContour(c) {
  return {
    closed: c.closed,
    points: c.points.map(p => ({
      x: p.x, y: p.y, type: p.type,
      handleIn: p.handleIn ? { ...p.handleIn } : null,
      handleOut: p.handleOut ? { ...p.handleOut } : null,
    })),
  };
}

// Add a contour to all masters (identical geometry; user reshapes per master).
export function addContourAllMasters(project, glyphIndex, contour) {
  const glyph = project.glyphs[glyphIndex];
  for (const m of project.masters) ensureLayer(glyph, m.id).contours.push(cloneContour(contour));
}

// Replace every master's outline with the same set of contours (used when a
// workboard shape is assigned — starts all masters identical & compatible).
export function setLayerAllMasters(project, glyphIndex, contours) {
  const glyph = project.glyphs[glyphIndex];
  for (const m of project.masters) ensureLayer(glyph, m.id).contours = contours.map(cloneContour);
}

// Remove the same point indices from every master, then drop any contour that
// collapses below 2 points (in all masters together).
export function deletePointsAllMasters(project, glyphIndex, removals) {
  const glyph = project.glyphs[glyphIndex];
  const byC = new Map();
  for (const { ci, pi } of removals) { if (!byC.has(ci)) byC.set(ci, new Set()); byC.get(ci).add(pi); }
  for (const m of project.masters) {
    const layer = ensureLayer(glyph, m.id);
    for (const [ci, pis] of byC) {
      const c = layer.contours[ci]; if (!c) continue;
      [...pis].sort((a, b) => b - a).forEach(pi => c.points.splice(pi, 1));
    }
  }
  // Determine which contour indices are now too small (check master 0) and
  // remove that index everywhere to keep structures aligned.
  const ref = ensureLayer(glyph, project.masters[0].id);
  const dropIdx = [];
  ref.contours.forEach((c, ci) => { if (c.points.length < 2) dropIdx.push(ci); });
  dropIdx.sort((a, b) => b - a);
  for (const m of project.masters) {
    const layer = ensureLayer(glyph, m.id);
    for (const ci of dropIdx) layer.contours.splice(ci, 1);
  }
}

// Apply the same geometric delta to linked masters (used when "link masters"
// is on, so an edit in one is mirrored in others).
export function propagateToLinked(project, glyphIndex, sourceMasterId, mutateLayer) {
  const glyph = project.glyphs[glyphIndex];
  for (const m of project.masters) {
    if (m.id === sourceMasterId) continue;
    const layer = ensureLayer(glyph, m.id);
    mutateLayer(layer, m.id);
  }
}
