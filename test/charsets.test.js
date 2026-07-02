'use strict';
// Character sets, case filters, grids and the New-Font project builder.
const assert = require('assert');
const charsets = require('../shared/charsets.js');
const glyphset = require('../shared/glyphset.js');

function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }

// --- alphabets ---
ok(charsets.ALPHABETS.length >= 12, 'has 12+ alphabets (' + charsets.ALPHABETS.length + ')');
ok(charsets.ALPHABET_BY_KEY.latinCentral.glyphs().some(g => g.char === 'ş'),
   'Latin Extended-A includes Turkish ş');
ok(charsets.ALPHABET_BY_KEY.hanzi.glyphs().length > 50, 'Hanzi set is non-trivial');
ok(charsets.ALPHABET_BY_KEY.katakana.glyphs().some(g => g.char === 'ア'), 'Katakana present');

// --- dedupe across sets ---
const merged = charsets.collectGlyphs(['latinUpper', 'latinUpper', 'coreText'], {});
const uniq = new Set(merged.map(g => g.unicode));
ok(merged.length === uniq.size, 'collectGlyphs dedupes by unicode');
ok(merged.length === 26 + charsets.ALPHABET_BY_KEY.coreText.glyphs().length, 'A–Z + Numbers & Punctuation');

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
  alphabets: ['latinUpper', 'coreText'], preset: 'Geometric Sans',
  masterName: 'Thin', masterType: 'Condensed',
});
ok(p.glyphs.length === 26 + charsets.ALPHABET_BY_KEY.coreText.glyphs().length, 'project built A–Z + Numbers & Punctuation');
ok(p.meta.version === '2.000', 'version stored');
ok(p.preset === 'Geometric Sans', 'DNA preset stored');
ok(p.dna && p.dna.geometry === 100, 'DNA params applied (geometry 100)');
ok(p.grids[0].kind === 'metrics', 'metric lines always present in derived grid');
ok(p.masters[0].type === 'Condensed' && p.masters[0].name === 'Thin', 'master name+type set');
ok(p.alphabets.indexOf('latinUpper') >= 0, 'alphabets recorded on project');

// --- DNA derives metrics & grid effects ---
const pg = glyphset.createProject({ alphabets: ['latinUpper'], preset: 'Broad Nib' });
ok(pg.grids.some(g => g.kind === 'broadnib'), 'broad-nib preset adds nib guides');
ok(pg.metrics.xHeight === Math.round(pg.dna.xHeight / 100 * pg.metrics.capHeight), 'x-height derived from DNA');

// --- standards-grounded coverage ---
ok(charsets.ALPHABET_BY_KEY.latinCentral.glyphs().length === 128, 'Latin Extended-A is the full block (128)');
ok(charsets.ALPHABET_BY_KEY.cyrillic.glyphs().some(g => g.char === 'Ё'), 'Cyrillic includes Ё');
ok(charsets.ALPHABET_BY_KEY.greek.glyphs().some(g => g.char === 'Ω'), 'Greek includes Ω');
ok(charsets.ALPHABET_BY_KEY.latinVietnamese.glyphs().some(g => g.char === 'ệ'), 'Vietnamese includes ệ');
// every set must yield a unique, valid glyph list
charsets.ALPHABETS.forEach(a => {
  const gs = a.glyphs();
  const uniq = new Set(gs.map(g => g.unicode));
  assert.ok(gs.length > 0 && uniq.size === gs.length, a.key + ' is non-empty and internally deduped');
});
ok(true, 'all alphabet sets are non-empty and internally deduped');

// --- addMaster fans out empty layers ---
const m2 = glyphset.addMaster(p, 'Wide', 'Extended');
ok(p.masters.length === 2, 'second master added');
ok(p.glyphs.every(g => g.layers[m2.id] && g.layers[m2.id].contours.length === 0),
   'every glyph got an empty layer in the new master');

// --- ids are unique across masters/projects ---
ok(p.masters[0].id !== p.masters[1].id, 'master ids are unique');

// --- glyphs are tagged with their source alphabet (for filtering) ---
const pf = glyphset.createProject({ alphabets: ['latinUpper', 'latinWest', 'coreText'] });
ok(pf.glyphs.find(g => g.char === 'A').alphabet === 'latinUpper', 'A tagged latinUpper');
ok(pf.glyphs.find(g => g.char === 'Ä').alphabet === 'latinWest', 'Ä tagged latinWest');
ok(pf.glyphs.find(g => g.char === '5').alphabet === 'coreText', '5 tagged coreText');

// --- search: similar-letter matching ---
const A = pf.glyphs.find(g => g.char === 'A');
const Adia = pf.glyphs.find(g => g.char === 'Ä');
ok(glyphset.glyphMatches(A, 'a') && glyphset.glyphMatches(Adia, 'a'), '"a" matches A and Ä (base letter)');
ok(!glyphset.glyphMatches(A, 'b'), '"b" does not match A');
ok(glyphset.glyphMatches(A, ''), 'empty query matches everything');
ok(glyphset.baseLetter('ş') === 's', 'baseLetter strips ş → s');

console.log('\ncharsets / New Font project OK');
