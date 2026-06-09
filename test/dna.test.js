'use strict';
const assert = require('assert');
const dna = require('../shared/dna.js');
function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }

ok(dna.QUICK.length === 10, '10 quick presets');
ok(dna.ADVANCED.length === 12, '12 advanced presets');
// every preset carries every parameter
dna.QUICK.concat(dna.ADVANCED).forEach(p => {
  dna.PARAMS.forEach(k => assert.ok(typeof p.params[k] === 'number', p.name + ' has ' + k));
});
ok(true, 'every preset defines all 17 DNA parameters');
ok(dna.byName('Neo Grotesk').params.geometry === 70, 'byName resolves advanced params');
ok(dna.byName('Clean').params.xHeight === 75, 'byName resolves quick params');
ok(dna.byName('nope').name === dna.QUICK[0].name, 'unknown name falls back to first quick');

// toGrids: metric lines always, plus density/nib/overshoot effects
var g1 = dna.toGrids(dna.byName('Modular').params, 1000);
ok(g1[0].kind === 'metrics', 'metric lines always present');
ok(g1.some(g => g.kind === 'emsquare'), 'high gridDensity → em grid');
var g2 = dna.toGrids(dna.byName('Broad Nib').params, 1000);
ok(g2.some(g => g.kind === 'broadnib'), 'penAngle → broad-nib slants');
ok(g2.some(g => g.kind === 'superellipse'), 'overshoot → overshoot zones');

console.log('\nFont DNA OK');
