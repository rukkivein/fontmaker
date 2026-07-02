// The Metric ⟷ Optical bake must be IDEMPOTENT: re-applying the same blend (which the
// UI does every drag frame) must NOT drift, and a slow drag must equal a direct jump —
// the class-based baseline guarantees this. Regression guard for the blocker where the
// bake read the LIVE bearing as its origin and collapsed spacing as you dragged.
const o = require('../shared/optimizer.js');
const m = 'm1';
const box = (x0, x1, y0 = 0, y1 = 700) => ({ closed: true, points: [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
const proj = () => ({
  unitsPerEm: 1000, metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: m }], glyphs: [
    { name: 'H', char: 'H', unicode: 72, advanceWidth: 800, layers: { m1: { contours: [box(80, 720)] } } },
    { name: 'I', char: 'I', unicode: 73, advanceWidth: 300, layers: { m1: { contours: [box(40, 160)] } } },
    { name: 'O', char: 'O', unicode: 79, advanceWidth: 1000, layers: { m1: { contours: [box(120, 880)] } } },
    { name: 'A', char: 'A', unicode: 65, advanceWidth: 900, layers: { m1: { contours: [box(60, 840)] } } },
  ],
});
let fails = 0;
const ok = (c, msg) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + msg); if (!c) fails++; };
const adv = (p) => p.glyphs.map((g) => g.advanceWidth).join(',');

// re-apply the same intermediate bearing blend repeatedly → stable
const p = proj(); let first = null;
for (let k = 0; k < 6; k++) { o.bakeMetricOptical(p, m, { tBearing: 0.5 }); const a = adv(p); if (k === 0) first = a; ok(a === first, 're-apply tBearing=0.5 #' + (k + 1) + ' stable (' + a + ')'); }

// slow drag == direct jump (same final value, path-independent)
const pd = proj(); [0.1, 0.25, 0.4, 0.55, 0.6].forEach((t) => o.bakeMetricOptical(pd, m, { tBearing: t }));
const pj = proj(); o.bakeMetricOptical(pj, m, { tBearing: 0.6 });
ok(adv(pd) === adv(pj), 'slow drag to 0.6 == direct jump to 0.6 (' + adv(pj) + ')');

// tBearing=1 is symmetric (each glyph centred in its advance)
const p1 = proj(); o.bakeMetricOptical(p1, m, { tBearing: 1 });
const sym = p1.glyphs.every((g) => { const b = o.bezBounds(g.layers.m1.contours); return Math.abs(b.xMin - (g.advanceWidth - b.xMax)) <= 1; });
ok(sym, 'tBearing=1 is symmetric / centred');

// ALL FOUR axes + tracking together must stay idempotent (the panel re-bakes every drag)
const sb = { H: { recL: 30, recR: 30 }, O: { recL: 50, recR: 50 }, A: { recL: 40, recR: 20 } };
const allOpts = { tBearing: 0.6, aiBearing: 0.5, tKern: 0.7, aiKern: 0.4, track: 80, stdMul: 1.1, optBearings: sb };
const pa = proj(); for (let k = 0; k < 5; k++) o.bakeMetricOptical(pa, m, allOpts);
const pb = proj(); o.bakeMetricOptical(pb, m, allOpts);
ok(adv(pa) === adv(pb), '5× all-axes == 1× (idempotent, ' + adv(pb) + ')');

// AI bearing actually tightens the modelled glyphs vs no-AI; kern table appears with tKern
const noAI = proj(); o.bakeMetricOptical(noAI, m, { tBearing: 1, aiBearing: 0, optBearings: sb });
const yesAI = proj(); o.bakeMetricOptical(yesAI, m, { tBearing: 1, aiBearing: 1, optBearings: sb });
ok(yesAI.glyphs[2].advanceWidth < noAI.glyphs[2].advanceWidth, 'aiBearing tightens O (' + yesAI.glyphs[2].advanceWidth + ' < ' + noAI.glyphs[2].advanceWidth + ')');
const kr = o.bakeMetricOptical(proj(), m, { tKern: 1 });
ok(typeof kr.table === 'object', 'tKern>0 produces a kern table (' + kr.kernPairs + ' pairs)');
const kr0 = o.bakeMetricOptical(proj(), m, { tKern: 0 });
ok(kr0.kernPairs === 0, 'tKern=0 → no kern (metric)');

// static tracking widens both sides by ~track, independent of the blends
const noT = proj(); o.bakeMetricOptical(noT, m, { tBearing: 0.5 });
const wT = proj(); o.bakeMetricOptical(wT, m, { tBearing: 0.5, track: 100 });
ok(wT.glyphs[0].advanceWidth - noT.glyphs[0].advanceWidth === 100, 'track=100 widens advance by exactly 100');

// metricBase: tBearing=0 reproduces the captured DRAWN/hand-edited spacing (no reset to the
// class baseline), and the dials layer on top idempotently.
const base = {}; proj().glyphs.forEach((g) => { const b = o.bezBounds(g.layers.m1.contours); base[g.name] = { lsb: Math.round(b.xMin), rsb: Math.round(g.advanceWidth - b.xMax) }; });
const pm = proj(); o.bakeMetricOptical(pm, m, { tBearing: 0, metricBase: base });
const kept = pm.glyphs.every((g) => { const b = o.bezBounds(g.layers.m1.contours); return Math.abs(b.xMin - base[g.name].lsb) <= 1 && Math.abs((g.advanceWidth - b.xMax) - base[g.name].rsb) <= 1; });
ok(kept, 'metricBase: tBearing=0 preserves the captured spacing (layers, no reset)');
const pm1 = proj(); for (let k = 0; k < 4; k++) o.bakeMetricOptical(pm1, m, { tBearing: 0.5, track: 60, metricBase: base });
const pm2 = proj(); o.bakeMetricOptical(pm2, m, { tBearing: 0.5, track: 60, metricBase: base });
ok(adv(pm1) === adv(pm2), 'metricBase 4×==1× (idempotent layering, ' + adv(pm2) + ')');

console.log(fails ? ('\n' + fails + ' failed') : '\noptbake OK');
process.exit(fails ? 1 : 0);
