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

// --- GRID tier components ---
ok(dna.GRID_COMPONENTS.length === 9, '9 grid components');
ok(dna.RECOMMENDED_GRID.indexOf('metrics') >= 0 && dna.RECOMMENDED_GRID.indexOf('circles') >= 0, 'recommended grid includes metrics & circles');
ok(dna.GRID_COMPONENTS.filter(c => c.rec).length === dna.RECOMMENDED_GRID.length, 'recommended flags match RECOMMENDED_GRID');
var ge = dna.componentsToGrids(['metrics', 'emgrid', 'web'], dna.BASE, 1000);
ok(ge.some(g => g.kind === 'metrics') && ge.some(g => g.kind === 'emsquare') && ge.some(g => g.kind === 'web'),
   'componentsToGrids maps selected components to effects');
ok(!ge.some(g => g.kind === 'circle'), 'unselected components are absent');

// --- user-designed grid (panel canvas) ---
var gd = { items: [{ type: 'circle', cx: 500, cy: 300, r: 200 }, { type: 'dline', cx: 500, cy: 300, angle: 45 }], gridOn: true, gridCell: 60, symX: false, symY: true };
var dg = dna.designToGrids(gd, 1000);
ok(dg.some(g => g.kind === 'emsquare' && g.cell === 60), 'designToGrids: gridOn → emsquare with the chosen cell');
var dd = dg.find(g => g.kind === 'design');
ok(dd && dd.items.length === 2 && dd.symY === true, 'designToGrids: items + symmetry flags pass through');
ok(dna.designToGrids({ items: [], gridOn: false }, 1000).length === 0, 'designToGrids: empty design → no effects');

console.log('\nFont DNA OK');
