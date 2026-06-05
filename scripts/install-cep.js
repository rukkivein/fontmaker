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
console.log('installed CEP extension →', DEST);
