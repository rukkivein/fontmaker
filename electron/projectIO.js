'use strict';
const fs = require('fs');

// Projects are stored as plain JSON. The renderer owns the schema; the main
// process just persists/reads it. Keeping it text-based makes projects
// diff-able and future-proof.
function save(filePath, project) {
  const payload = JSON.stringify(project, null, 2);
  fs.writeFileSync(filePath, payload, 'utf8');
}

function load(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

module.exports = { save, load };
