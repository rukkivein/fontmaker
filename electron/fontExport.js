'use strict';
// Electron host wrapper around the portable font engine: build the font, then
// write it with Node's fs. (The UXP plugin uses the same engine with UXP's
// file API instead.)
const fs = require('fs');
const { buildFont } = require('../core/fontEngine');

function exportFont(project, format, metadata, filePath) {
  const { buffer, glyphCount } = buildFont(project, format, metadata);
  fs.writeFileSync(filePath, Buffer.from(buffer));
  return { glyphCount };
}

module.exports = { export: exportFont };
