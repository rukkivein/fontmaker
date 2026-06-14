'use strict';
// Guards the CEP bundle against drift. cep/js/* must be exactly what
// scripts/sync-cep.js produces from the canonical sources. If this fails, run
// `npm run cep:sync` after intentional changes to shared/ or core/.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transformFontEngine } = require('../scripts/sync-cep.js');

function ok(cond, msg) { assert.ok(cond, msg); console.log('✓ ' + msg); }
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

ok(read('cep/js/ilbridge.js') === read('shared/ilbridge.js'),
   'cep/js/ilbridge.js matches shared/ilbridge.js (run `npm run cep:sync`)');
ok(read('cep/js/glyphset.js') === read('shared/glyphset.js'),
   'cep/js/glyphset.js matches shared/glyphset.js');
ok(read('cep/js/charsets.js') === read('shared/charsets.js'),
   'cep/js/charsets.js matches shared/charsets.js');
ok(read('cep/js/dna.js') === read('shared/dna.js'),
   'cep/js/dna.js matches shared/dna.js');
ok(read('cep/js/features.js') === read('shared/features.js'),
   'cep/js/features.js matches shared/features.js (edition gating)');
ok(read('cep/js/placeholder.js') === read('shared/placeholder.js'),
   'cep/js/placeholder.js matches shared/placeholder.js');
ok(read('cep/js/bosharf.json') === read('shared/bosharf.json'),
   'cep/js/bosharf.json matches shared/bosharf.json (empty-glyph art)');
ok(read('cep/js/lib/fontEngine.js') === transformFontEngine(read('core/fontEngine.js')),
   'cep/js/lib/fontEngine.js is in sync with core/fontEngine.js');
ok(read('cep/js/lib/fontEngine.js').indexOf("require('./opentype.js')") !== -1,
   'bundled engine requires opentype via sibling relative path');
ok(read('cep/js/lib/opentype.js') === read('node_modules/opentype.js/dist/opentype.js'),
   'cep/js/lib/opentype.js matches the installed opentype.js dist');

console.log('\nCEP sync OK');
