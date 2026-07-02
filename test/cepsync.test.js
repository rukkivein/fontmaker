'use strict';
// Guards the CEP bundle against drift. cep/js/* must be exactly what
// scripts/sync-cep.js produces from the canonical sources. If this fails, run
// `npm run cep:sync` after intentional changes to shared/ or core/.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transformFontEngine, transformImageTrace } = require('../scripts/sync-cep.js');

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
ok(read('cep/js/refspace.js') === read('shared/refspace.js'),
   'cep/js/refspace.js matches shared/refspace.js (Arial+Times X spacing)');
ok(read('cep/js/lib/opentype.js') === read('node_modules/opentype.js/dist/opentype.js'),
   'cep/js/lib/opentype.js matches the installed opentype.js dist');
ok(read('cep/js/imgglyphs.js') === read('shared/imgglyphs.js'),
   'cep/js/imgglyphs.js matches shared/imgglyphs.js (image-import geometry)');
ok(read('cep/js/imagetrace.js') === transformImageTrace(read('shared/imagetrace.js')),
   'cep/js/imagetrace.js is in sync with shared/imagetrace.js');
ok(read('cep/js/potrace.js') === read('shared/potrace.js'),
   'cep/js/potrace.js matches shared/potrace.js (clean-room tracer)');
ok(read('cep/js/markgen.js') === read('shared/markgen.js'),
   'cep/js/markgen.js matches shared/markgen.js (diacritic mark synthesis)');
ok(read('cep/js/optimizer.js') === read('shared/optimizer.js'),
   'cep/js/optimizer.js matches shared/optimizer.js (spacing/kern engine)');
ok(read('cep/js/kernvision.js') === read('shared/kernvision.js'),
   'cep/js/kernvision.js matches shared/kernvision.js (Visual Kern, Track A)');
ok(read('cep/js/imagetrace.js').indexOf("require('./lib/imagetracer.js')") !== -1,
   'bundled imagetrace requires imagetracerjs via sibling relative path');
ok(read('cep/js/lib/imagetracer.js') === read('node_modules/imagetracerjs/imagetracer_v1.2.6.js'),
   'cep/js/lib/imagetracer.js matches the installed imagetracerjs');

console.log('\nCEP sync OK');
