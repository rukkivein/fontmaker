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
