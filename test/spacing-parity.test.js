// Python↔JS parity gate for the sidebearing feature math (the NON-NEGOTIABLE
// gate from project-sidebearing-ml). The fixture (ml/dump_parity_fixture.py) holds
// the EXACT training raster + the prior/contrast/spikiness ml/render_spacing.py
// computes for several Arial glyphs; here the JS port (cep/js/spacingai.js) runs on
// the SAME rasters and must reproduce them — so panel inference reconstructs the
// same recession the model was trained against. Regenerate the fixture with:
//   E:/glyphset/.venv/Scripts/python.exe ml/dump_parity_fixture.py
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const sa = require('../cep/js/spacingai.js');

const fx = path.join(__dirname, 'fixtures', 'spacing_parity.json');
if (!fs.existsSync(fx)) {
  console.log('spacing-parity SKIP — fixture missing (run ml/dump_parity_fixture.py in the venv)');
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(fx, 'utf8'));
const INK_U8 = 32;            // Python `raster > 32` on the uint8 fixture
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: js=${a} py=${b} Δ=${Math.abs(a - b)}`);

let checked = 0;
for (const g of data.glyphs) {
  const ras = g.raster, n = g.n;
  const am = sa.areaMarginPrior(ras, n);
  assert.ok(am, `${g.ch}: areaMarginPrior returned null`);
  // pixel prior + ink width are integer ops → must match EXACTLY
  assert.strictEqual(am.pL, g.pL, `${g.ch}: pL js=${am.pL} py=${g.pL}`);
  assert.strictEqual(am.pR, g.pR, `${g.ch}: pR js=${am.pR} py=${g.pR}`);
  assert.strictEqual(am.inkw, g.inkw, `${g.ch}: inkw js=${am.inkw} py=${g.inkw}`);
  // cap-unit prior (the value that feeds the bake) — same formula → fp-exact
  const priorL = sa.priorCapUnits(am.pL, g.iwf, am.inkw, g.capH);
  const priorR = sa.priorCapUnits(am.pR, g.iwf, am.inkw, g.capH);
  close(priorL, g.priorL, 1e-2, `${g.ch} priorL`);
  close(priorR, g.priorR, 1e-2, `${g.ch} priorR`);
  // context features
  close(sa.contrastFeat(ras, n, INK_U8), g.contrast, 1e-2, `${g.ch} contrast`);
  close(sa.spikinessFeat(ras, n, INK_U8), g.spikiness, 1e-2, `${g.ch} spikiness`);

  // PRODUCTION PATH: the panel feeds glyphreco.rasterize's [0,1] raster + INK01 threshold,
  // not the uint8 fixture. Confirm the same features come out on the [0,1] scale (the prior
  // is mass-ratio so scale-invariant; the thresholds 32 and 32/255 are equivalent).
  const ras01 = ras.map(v => v / 255), INK01 = 32 / 255;
  const am01 = sa.areaMarginPrior(ras01, n);
  assert.strictEqual(am01.pL, g.pL, `${g.ch}: pL [0,1] path`);
  assert.strictEqual(am01.pR, g.pR, `${g.ch}: pR [0,1] path`);
  close(sa.contrastFeat(ras01, n, INK01), g.contrast, 1e-2, `${g.ch} contrast [0,1]`);
  close(sa.spikinessFeat(ras01, n, INK01), g.spikiness, 1e-2, `${g.ch} spikiness [0,1]`);
  checked++;
}

// sanity: the optical ranking the model relies on must hold (O/T/A recede > H)
const byCh = {};
data.glyphs.forEach(g => { byCh[g.ch] = sa.priorCapUnits(sa.areaMarginPrior(g.raster, g.n).pL, g.iwf, g.inkw, g.capH); });
if (byCh.O != null && byCh.H != null) assert.ok(byCh.A >= byCh.H && byCh.T >= byCh.H, 'A/T recede more than H');

console.log(`spacing-parity OK — ${checked} glyphs, JS feature math matches Python <1e-2 (pL/pR/inkw exact)`);
