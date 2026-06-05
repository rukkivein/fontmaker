'use strict';
// Guards the plugin's bundled font core against drift. plugin/lib/fontEngine.js
// must be exactly what scripts/sync-plugin.js produces from core/fontEngine.js,
// and plugin/lib/opentype.js must match the installed dist. If this fails, run
// `npm run plugin:sync` after intentional core changes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transformFontEngine } = require('../scripts/sync-plugin.js');

function ok(cond, msg) { assert.ok(cond, msg); console.log('✓ ' + msg); }

const ROOT = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(ROOT, 'core', 'fontEngine.js'), 'utf8');
const bundled = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'fontEngine.js'), 'utf8');
ok(bundled === transformFontEngine(core),
   'plugin/lib/fontEngine.js is in sync with core/fontEngine.js (run `npm run plugin:sync`)');
ok(bundled.indexOf("require('./opentype.js')") !== -1,
   'bundled engine requires opentype via sibling relative path');

const dist = fs.readFileSync(path.join(ROOT, 'node_modules', 'opentype.js', 'dist', 'opentype.js'), 'utf8');
const ot = fs.readFileSync(path.join(ROOT, 'plugin', 'lib', 'opentype.js'), 'utf8');
ok(ot === dist, 'plugin/lib/opentype.js matches the installed opentype.js dist');

console.log('\nplugin sync OK');
