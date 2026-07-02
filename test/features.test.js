'use strict';
// Locks the shipped edition + its gate. If anyone flips EDITION or loosens a
// premium gate, this fails loudly so a paid feature can't leak into the free
// alpha by accident. Flip to 'pro' deliberately AND update this test together.
const assert = require('assert');
const { EDITION, FEATURES, EDITIONS } = require('../shared/features.js');

let fails = 0;
function ok(cond, msg) { console.log((cond ? '✓' : '✗ FAIL') + ' ' + msg); if (!cond) fails++; }

// Current build is the full PRO edition (alpha was a separate free distribution).
ok(EDITION === 'pro', "active EDITION is 'pro' (full version)");
ok(FEATURES === EDITIONS.pro, 'FEATURES resolves to the pro set');

// Pro unlocks the whole premium surface.
['masters', 'exportTtf', 'exportVariable', 'fontImport', 'accents', 'optimize', 'alternates', 'gridPresets', 'template']
  .forEach((k) => ok(EDITIONS.pro[k] === true, 'pro unlocks "' + k + '"'));
ok(EDITIONS.pro.exportOtf === true, 'pro keeps OTF export on');
ok(EDITIONS.pro.charsets === null, 'pro offers all character sets');
ok(EDITIONS.pro.emptyGlyphArt === null, 'pro exports drawn glyphs only (no placeholder)');

// The alpha SET stays correctly defined (so a future free build is still safe).
['masters', 'exportTtf', 'exportVariable', 'fontImport', 'accents', 'optimize', 'alternates', 'gridPresets', 'template']
  .forEach((k) => ok(EDITIONS.alpha[k] === false, 'alpha set still gates "' + k + '" off'));
ok(EDITIONS.alpha.exportOtf === true, 'alpha set keeps OTF export on (core deliverable)');
ok(Array.isArray(EDITIONS.alpha.charsets) &&
   EDITIONS.alpha.charsets.length === 2 &&
   EDITIONS.alpha.charsets.indexOf('latinUpper') >= 0 &&
   EDITIONS.alpha.charsets.indexOf('coreText') >= 0,
   'alpha set charsets are exactly [latinUpper, coreText]');
ok(EDITIONS.alpha.emptyGlyphArt === 'bosharf', 'alpha set empty-cell art is bosharf');

console.log(fails ? `\n${fails} feature test(s) failed` : '\nAll edition/feature gates verified');
process.exit(fails ? 1 : 0);
