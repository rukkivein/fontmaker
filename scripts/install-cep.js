'use strict';
// Copy the CEP extension into the user's CEP extensions folder so Illustrator
// loads it (Window ▸ Extensions ▸ FontMaker). Run `npm run cep:install` after
// `npm run cep:sync`. PlayerDebugMode must be enabled (it is on this machine).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'cep');
const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const DEST = path.join(appData, 'Adobe', 'CEP', 'extensions', 'com.fontmaker.illustrator');

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });

// ── CACHE-BUST ──────────────────────────────────────────────────────────────
// CEF (the Chromium engine inside CEP) caches the panel's <script src="js/main.js">
// AND compiles it into a per-extension "Code Cache". With a STATIC url, reopening the
// panel — or even reinstalling — can keep running the OLD main.js, so a freshly fixed
// build silently doesn't take effect. (This is the #1 reason for "I reopened the panel
// but my fix still isn't there".) Two defences, applied on every install:
//   1) stamp a unique build id onto every local <script src="js/*.js"> url → CEF must
//      re-fetch (works even while Illustrator stays open; just reopen the panel),
//   2) wipe the CEF cache dir for this extension → no stale compiled bytecode either
//      (best-effort: files are locked while Illustrator runs, but (1) still forces it).
const build = Date.now().toString(36);
const idxPath = path.join(DEST, 'index.html');
try {
  let html = fs.readFileSync(idxPath, 'utf8');
  html = html.replace(/(<script\s+src="js\/[^"?]+\.js)(\?v=[^"]*)?"/g, '$1?v=' + build + '"');
  fs.writeFileSync(idxPath, html);
} catch (e) { console.warn('cache-bust stamp failed:', e.message); }

const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const cepCache = path.join(localAppData, 'Temp', 'cep_cache');
let wiped = 0;
try {
  if (fs.existsSync(cepCache)) {
    for (const d of fs.readdirSync(cepCache)) {
      if (d.indexOf('com.fontmaker.illustrator') !== -1) {
        try { fs.rmSync(path.join(cepCache, d), { recursive: true, force: true }); wiped++; } catch (e) { /* locked: Illustrator open */ }
      }
    }
  }
} catch (e) { /* no cache dir yet */ }

console.log('installed CEP extension →', DEST, '(build ' + build + ', cef-cache wiped: ' + wiped + ')');
