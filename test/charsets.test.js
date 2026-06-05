'use strict';
// Character sets, case filters, grids and the New-Font project builder.
const assert = require('assert');
const charsets = require('../shared/charsets.js');
const glyphset = require('../shared/glyphset.js');

function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }

// --- alphabets ---
ok(charsets.ALPHABETS.length >= 12, 'has 12+ alphabets (' + charsets.ALPHABETS.length + ')');
ok(charsets.ALPHABET_BY_KEY.latinExt.glyphs().some(g => g.char === 'ş'),
   'Latin Extended includes Turkish ş');
ok(charsets.ALPHABET_BY_KEY.hanzi.glyphs().length > 50, 'Hanzi set is non-trivial');
ok(charsets.ALPHABET_BY_KEY.katakana.glyphs().some(g => g.char === 'ア'), 'Katakana present');

// --- dedupe across sets ---
const merged = charsets.collectGlyphs(['latinUpper', 'latinUpper', 'numbers'], {});
const uniq = new Set(merged.map(g => g.unicode));
ok(merged.length === uniq.size, 'collectGlyphs dedupes by unicode');
ok(merged.length === 26 + 10, 'A–Z + 0–9 = 36 glyphs');

// --- case filters ---
const upperOnly = charsets.collectGlyphs(['latinUpper', 'latinLower'], { upperOnly: true });
ok(upperOnly.every(g => !(g.char >= 'a' && g.char <= 'z')), 'upperOnly drops lowercase');
const lowerOnly = charsets.collectGlyphs(['latinUpper', 'latinLower'], { lowerOnly: true });
ok(lowerOnly.every(g => !(g.char >= 'A' && g.char <= 'Z')), 'lowerOnly drops uppercase');

// --- grids ---
ok(charsets.GRIDS.length === 5, 'exactly 5 grid presets');
ok(charsets.GRIDS.every(g => g.note && g.note.length > 10), 'every grid has a purpose note');
ok(charsets.GRID_BY_KEY.golden.build(1000).metrics.capHeight === 700, 'golden grid builds metrics');

// --- createProject from dialog choices ---
const p = glyphset.createProject({
  familyName: 'Demo', version: '2.000',
  alphabets: ['latinUpper', 'numbers'], grid: 'emsquare',
  masterName: 'Thin', masterType: 'Condensed',
});
ok(p.glyphs.length === 36, 'project built A–Z + 0–9');
ok(p.meta.version === '2.000', 'version stored');
ok(p.gridKeys[0] === 'emsquare', 'grid key stored');
ok(p.grids[0].kind === 'emsquare', 'resolved grid object stored');
ok(p.masters[0].type === 'Condensed' && p.masters[0].name === 'Thin', 'master name+type set');
ok(p.alphabets.indexOf('latinUpper') >= 0, 'alphabets recorded on project');

// --- multiple overlaid grids ---
const pg = glyphset.createProject({ alphabets: ['latinUpper'], grids: ['metrics', 'broadnib', 'golden'] });
ok(pg.grids.length === 3, 'three grids resolved & stored');
ok(pg.gridKeys.join(',') === 'metrics,broadnib,golden', 'grid order preserved');
ok(pg.metrics.capHeight === pg.grids[0].metrics.capHeight, 'metrics come from the first grid');

// --- Latin Extended is comprehensive (multilingual) ---
ok(charsets.ALPHABET_BY_KEY.latinExt.glyphs().length > 180, 'Latin Extended is multilingual (' + charsets.ALPHABET_BY_KEY.latinExt.glyphs().length + ')');

// --- addMaster fans out empty layers ---
const m2 = glyphset.addMaster(p, 'Wide', 'Extended');
ok(p.masters.length === 2, 'second master added');
ok(p.glyphs.every(g => g.layers[m2.id] && g.layers[m2.id].contours.length === 0),
   'every glyph got an empty layer in the new master');

// --- ids are unique across masters/projects ---
ok(p.masters[0].id !== p.masters[1].id, 'master ids are unique');

console.log('\ncharsets / New Font project OK');
