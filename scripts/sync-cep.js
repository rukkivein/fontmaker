'use strict';
// Sync the portable font core + shared host-bridge modules into the CEP
// extension bundle so the installed extension is self-contained.
//   shared/ilbridge.js  -> cep/js/ilbridge.js   (verbatim)
//   shared/glyphset.js  -> cep/js/glyphset.js   (verbatim)
//   shared/features.js  -> cep/js/features.js   (verbatim — edition gating)
//   core/fontEngine.js  -> cep/js/lib/fontEngine.js  (opentype require → relative)
//   opentype.js dist    -> cep/js/lib/opentype.js
// Run via `npm run cep:sync`. test/cepsync.test.js re-applies this and fails if
// cep/js drifts, so the bundled copies can never silently diverge.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function transformFontEngine(src) {
  return src.replace("require('opentype.js')", "require('./opentype.js')");
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function write(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return content.length;
}

function sync() {
  const out = {};
  out.ilbridge = write('cep/js/ilbridge.js', read('shared/ilbridge.js'));
  out.glyphset = write('cep/js/glyphset.js', read('shared/glyphset.js'));
  out.charsets = write('cep/js/charsets.js', read('shared/charsets.js'));
  out.dna = write('cep/js/dna.js', read('shared/dna.js'));
  out.features = write('cep/js/features.js', read('shared/features.js'));
  out.placeholder = write('cep/js/placeholder.js', read('shared/placeholder.js'));
  out.bosharf = write('cep/js/bosharf.json', read('shared/bosharf.json'));
  out.fontEngine = write('cep/js/lib/fontEngine.js', transformFontEngine(read('core/fontEngine.js')));
  out.ttfWriter = write('cep/js/lib/ttfWriter.js', read('core/ttfWriter.js'));
  out.accentCompose = write('cep/js/accentCompose.js', read('shared/accentCompose.js'));
  out.optimizer = write('cep/js/optimizer.js', read('shared/optimizer.js'));
  out.varCompat = write('cep/js/varCompat.js', read('shared/varCompat.js'));
  out.opentype = write('cep/js/lib/opentype.js', read('node_modules/opentype.js/dist/opentype.js'));
  return out;
}

module.exports = { transformFontEngine, sync };

if (require.main === module) {
  const r = sync();
  console.log('cep/js synced:', JSON.stringify(r));
}
