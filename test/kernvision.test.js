// Visual Kern (Track A) — shared/kernvision.js. Asserts the white-AREA optical kerner:
//   (1) tightens OPEN pairs (A-V wedge) more than STRAIGHT pairs (H-I boxes),
//   (2) makes the per-pair white-area rhythm MORE EVEN (variance drops vs no kern),
//   (3) never ships a collision,
//   (4) is deterministic and scales with the aggressiveness knob,
//   (5) the value it emits is keyed by glyph names 'L,R' — exactly what opticalKern
//       returns FIRST from f.kernOverride, so this table is byte-identical to what
//       exportKernTable / the shipped 'kern' table carry (the preview==export hook).
const kv = require('../shared/kernvision.js');

const m = 'm1';
// straight box (vertical edges)
const box = (x0, x1, y0 = 0, y1 = 700) => ({ closed: true, points: [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
// up-triangle (apex top) — the 'A' shape: narrow at the top, wide at the base
const triUp = (cx, halfBase, y0 = 0, y1 = 700) => ({ closed: true, points: [
  { x: cx, y: y1 }, { x: cx + halfBase, y: y0 }, { x: cx - halfBase, y: y0 }] });
// down-triangle (apex bottom) — the 'V' shape: wide at the top, narrow at the base
const triDn = (cx, halfBase, y0 = 0, y1 = 700) => ({ closed: true, points: [
  { x: cx - halfBase, y: y1 }, { x: cx + halfBase, y: y1 }, { x: cx, y: y0 }] });

const proj = () => ({
  unitsPerEm: 1000, metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m }], glyphs: [
    { name: 'H', char: 'H', unicode: 72, advanceWidth: 800, layers: { m1: { contours: [box(150, 650)] } } },
    { name: 'I', char: 'I', unicode: 73, advanceWidth: 300, layers: { m1: { contours: [box(100, 200)] } } },
    { name: 'A', char: 'A', unicode: 65, advanceWidth: 600, layers: { m1: { contours: [triUp(300, 280)] } } },
    { name: 'V', char: 'V', unicode: 86, advanceWidth: 600, layers: { m1: { contours: [triDn(300, 280)] } } },
    { name: 'o', char: 'o', unicode: 111, advanceWidth: 560, layers: { m1: { contours: [box(60, 500, 0, 500)] } } },
  ],
});

let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + msg); if (!c) fails++; };
const getK = (t) => (L, R) => t[L + ',' + R] || 0;

// --- run the kerner
const p = proj();
const res = kv.buildKernVision(p, m, { aggr: 0.6 });
ok(res && typeof res.table === 'object', 'returns a table (' + res.pairs + ' pairs, target=' + res.target + ')');
ok(res.glyphs === 5, 'saw all 5 filled glyphs');

// (1) open pair tightens more than the straight pair
const av = res.table['A,V'] || 0, hi = res.table['H,I'] || 0, hh = res.table['H,H'] || 0;
ok(av < 0, 'A,V (open wedge) is tightened — negative kern (' + av + ')');
ok(Math.abs(av) > Math.abs(hi), '|A,V| > |H,I| — the open pair kerns harder than the straight one (' + av + ' vs ' + hi + ')');
ok(Math.abs(hh) <= Math.abs(av), 'straight H,H stays calmer than the open A,V (' + hh + ' vs ' + av + ')');

// (2) the white-area rhythm gets MORE EVEN after kerning
const before = kv.evennessReport(p, m, null);
const after = kv.evennessReport(p, m, getK(res.table));
ok(after.variance < before.variance, 'rhythm more even after kern (var ' + Math.round(before.variance) + ' -> ' + Math.round(after.variance) + ')');

// (3) no collisions shipped
ok(after.collisions === 0, 'no colliding pairs in the result (' + after.collisions + ')');

// (4a) deterministic
const res2 = kv.buildKernVision(proj(), m, { aggr: 0.6 });
ok(JSON.stringify(res2.table) === JSON.stringify(res.table), 're-run is deterministic (same table)');

// (4b) aggressiveness scales the correction
const soft = kv.buildKernVision(proj(), m, { aggr: 0.3 });
const hard = kv.buildKernVision(proj(), m, { aggr: 1.0 });
ok(Math.abs(hard.table['A,V'] || 0) > Math.abs(soft.table['A,V'] || 0),
  'aggr 1.0 kerns A,V harder than aggr 0.3 (' + (hard.table['A,V'] || 0) + ' vs ' + (soft.table['A,V'] || 0) + ')');
const off = kv.buildKernVision(proj(), m, { aggr: 0 });
ok(Object.keys(off.table).length === 0, 'aggr 0 applies nothing (empty table)');

// (5) keys are 'L,R' glyph-name pairs (the f.kernOverride contract opticalKern reads)
ok(Object.keys(res.table).every(k => /^[^,]+,[^,]+$/.test(k)), "keys are 'L,R' name pairs");

// (6) pairSilhouette (Track B model input) — parity-shaped 2-ch [2,64,96] with ink in both
const rows = kv.modelBandRows(1000);
const pp = proj();
const Lp = kv.glyphProfile(pp, m, pp.glyphs.find(g => g.name === 'H'), rows);
const Rp = kv.glyphProfile(pp, m, pp.glyphs.find(g => g.name === 'A'), rows);
const sil = kv.pairSilhouette(Lp, Rp, Lp.adv, 0, 1000);
const HW = kv.KP_HC * kv.KP_WC;
ok(sil.length === 2 * HW, 'pairSilhouette is [2,64,96] flat (' + sil.length + ')');
let c0 = 0, c1 = 0; for (let t = 0; t < HW; t++) { c0 += sil[t]; c1 += sil[HW + t]; }
ok(c0 > 0 && c1 > 0, 'both channels carry ink (L=' + c0 + ' R=' + c1 + ')');

// (7) seeds restrict the search around the model proposal — a loose +seed steers A,V looser
const seeded = kv.buildKernVision(proj(), m, { aggr: 0.6, seeds: { 'A,V': 50 } });
ok((seeded.table['A,V'] || 0) > av, 'a loose seed (+50) steers A,V looser than the unseeded search (' + (seeded.table['A,V'] || 0) + ' > ' + av + ')');

// (8) redistributeToBearings PRESERVES total spacing: kern == dR[L] + dL[R] + residual for every pair
const NM = ['H', 'I', 'A', 'V', 'o'];
const full = {};
for (const a of NM) for (const b of NM) { if (a === b) continue; full[a + ',' + b] = res.table[a + ',' + b] || 0; }
const rb = kv.redistributeToBearings(full, NM);
let badRecon = 0, movedBearings = 0;
for (const g of NM) if (rb.bearings[g].dL || rb.bearings[g].dR) movedBearings++;
for (const a of NM) for (const b of NM) {
  if (a === b) continue;
  const recon = rb.bearings[a].dR + rb.bearings[b].dL + rb.residual[a + ',' + b];
  if (Math.abs(full[a + ',' + b] - recon) > 1) badRecon++;
}
ok(badRecon === 0, 'redistributeToBearings preserves total spacing for every pair (kern == dR[L]+dL[R]+residual)');
ok(movedBearings > 0, 'some bearings actually move (the open-pair letters carry a nonzero average, ' + movedBearings + ')');

// (9) ROW-DISJOINT pairs get NO kern: a period (ink 0..120) vs an apostrophe (ink 560..700)
// share no scan rows, so whiteArea is identically 0 over the whole range — the old search
// degenerated to its first candidate (max tightening ~-0.07 em). Must be absent from the table.
const pd = () => ({
  unitsPerEm: 1000, metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m }], glyphs: [
    { name: 'period', char: '.', unicode: 46, advanceWidth: 260, layers: { m1: { contours: [box(70, 190, 0, 120)] } } },
    { name: 'quotesingle', char: "'", unicode: 39, advanceWidth: 260, layers: { m1: { contours: [box(70, 190, 560, 700)] } } },
    { name: 'H2', char: 'H', unicode: 72, advanceWidth: 800, layers: { m1: { contours: [box(150, 650)] } } },
    { name: 'O2', char: 'O', unicode: 79, advanceWidth: 800, layers: { m1: { contours: [box(150, 650, 0, 690)] } } },
  ],
});
const rd = kv.buildKernVision(pd(), m, { aggr: 1.0 });
ok(!('period,quotesingle' in rd.table) && !('quotesingle,period' in rd.table),
  'row-disjoint pair (period vs apostrophe) gets NO kern (' + (rd.table['period,quotesingle'] || 0) + ')');

// (10) DEGENERATE font (raw template import: advance == ink width, every pair collided at
// kern 0) — target must NOT fall back to 0 (max tightening); the search must LOOSEN.
const tight = () => ({
  unitsPerEm: 1000, metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m }], glyphs: [
    { name: 'H', char: 'H', unicode: 72, advanceWidth: 500, layers: { m1: { contours: [box(0, 500)] } } },
    { name: 'I', char: 'I', unicode: 73, advanceWidth: 100, layers: { m1: { contours: [box(0, 100)] } } },
    { name: 'N', char: 'N', unicode: 78, advanceWidth: 520, layers: { m1: { contours: [box(0, 520)] } } },
  ],
});
const dg = kv.buildKernVision(tight(), m, { aggr: 1.0 });
ok(dg.target > 0, 'all-collided font synthesizes a positive air target (' + dg.target + ')');
const dgVals = Object.keys(dg.table).map(k => dg.table[k]);
ok(dgVals.length > 0 && dgVals.every(v => v > 0), 'all-collided font is LOOSENED, not floor-seated (' + dgVals.join(',') + ')');

// (11) aggressiveness never re-enters the collision zone: with touching glyphs the full
// correction is a LOOSEN; scaling it by aggr must not ship a still-colliding kern.
const dgSoft = kv.buildKernVision(tight(), m, { aggr: 0.3 });
const dgRep = kv.evennessReport(tight(), m, getK(dgSoft.table));
ok(dgRep.collisions === 0, 'aggr-scaled loosening still clears the collision floor (collisions=' + dgRep.collisions + ')');

console.log(fails ? ('\n' + fails + ' failed') : '\nkernvision OK');
process.exit(fails ? 1 : 0);
