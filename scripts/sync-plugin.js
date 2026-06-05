'use strict';
// Sync the portable font core into the UXP plugin bundle.
//   - copies opentype.js (dist) into plugin/lib/opentype.js
//   - copies core/fontEngine.js into plugin/lib/fontEngine.js, rewriting its
//     module require from the npm name to a sibling relative path so UXP's
//     require() resolves it inside the plugin sandbox.
// Run via `npm run plugin:sync`. The drift test re-applies this transform and
// asserts plugin/lib/fontEngine.js is exactly what this script would produce,
// so the plugin's engine can never silently diverge from core/.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function transformFontEngine(src) {
  return src.replace("require('opentype.js')", "require('./opentype.js')");
}

function sync() {
  const libDir = path.join(ROOT, 'plugin', 'lib');
  fs.mkdirSync(libDir, { recursive: true });

  const ot = fs.readFileSync(path.join(ROOT, 'node_modules', 'opentype.js', 'dist', 'opentype.js'), 'utf8');
  fs.writeFileSync(path.join(libDir, 'opentype.js'), ot);

  const core = fs.readFileSync(path.join(ROOT, 'core', 'fontEngine.js'), 'utf8');
  fs.writeFileSync(path.join(libDir, 'fontEngine.js'), transformFontEngine(core));

  return { opentypeBytes: ot.length, engineBytes: core.length };
}

module.exports = { transformFontEngine, sync };

if (require.main === module) {
  const r = sync();
  console.log('plugin/lib synced: opentype.js', r.opentypeBytes, 'bytes, fontEngine.js', r.engineBytes, 'bytes');
}
