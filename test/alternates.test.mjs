// Alternates and ligatures must be created across ALL masters (empty but
// present) so they stay variable-compatible on the same axes as the base.
import { createProject, createAlternate, createLigature } from '../src/js/project.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; };

const project = createProject({
  familyName: 'T', masterNames: ['Light', 'Regular', 'Bold'],
  alphabets: ['latin'], gridPreset: 'standard',
});
const masterIds = project.masters.map(m => m.id);
const ai = project.glyphs.findIndex(g => g.char === 'A');

const idx = createAlternate(project, ai);
const alt = project.glyphs[idx];
ok(alt.name === 'A.ss01', 'alternate named A.ss01');
ok(alt.kind === 'alternate' && alt.ghostFrom === 'A', 'alternate traces base A as ghost');
ok(masterIds.every(m => alt.layers[m] && Array.isArray(alt.layers[m].contours)), 'alternate has a layer in EVERY master (variable-compatible)');
ok(alt.unicode == null, 'alternate has no unicode (accessed via GSUB/name)');

const idx2 = createAlternate(project, ai);
ok(project.glyphs[idx2].name === 'A.ss02', 'second alternate increments to A.ss02');

const fi = project.glyphs.findIndex(g => g.char === 'f');
const li = createLigature(project, 'fi');
const lig = project.glyphs[li];
ok(lig && lig.kind === 'ligature', 'ligature created');
ok(lig.name === 'f_i', 'ligature named from components (f_i)');
ok(masterIds.every(m => lig.layers[m]), 'ligature present in every master');
ok(JSON.stringify(lig.ghostComponents) === JSON.stringify(['f', 'i']), 'ligature ghosts its components');

console.log(fails ? `\n${fails} failed` : '\nAlternates/ligatures OK');
process.exit(fails ? 1 : 0);
