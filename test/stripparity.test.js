// Python render_strip (ml/train_paragraph.py) <-> JS stripSilhouette (shared/kernvision.js) BYTE
// parity. The paragraph kern model trains on render_strip; the panel feeds stripSilhouette. A
// single-pixel divergence means the model sees a different image in-panel than in training — the
// #1 silent-failure risk for the paragraph model. Fixture dumped from a packed face's profiles.
const kv = require('../shared/kernvision.js');
const fs = require('fs'), path = require('path');
const fx = path.join(__dirname, 'fixtures', 'strip_parity.json');
if (!fs.existsSync(fx)) { console.log('strip-parity SKIP — fixture missing'); process.exit(0); }
const d = JSON.parse(fs.readFileSync(fx, 'utf8'));
const img = kv.stripSilhouette(d.profs, d.seq, d.kerns, d.upm);
let diff = 0, ink = 0;
for (let i = 0; i < d.img.length; i++) { if ((img[i] ? 1 : 0) !== d.img[i]) diff++; ink += d.img[i]; }
const ok = diff === 0 && img.length === d.img.length;
console.log((ok ? '✓' : '✗ FAIL') + ` stripSilhouette == Python render_strip (px=${d.img.length} ink=${ink} diff=${diff})`);
process.exit(ok ? 0 : 1);
