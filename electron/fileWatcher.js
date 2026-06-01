'use strict';
const chokidar = require('chokidar');

// Watches imported vector source files. When Illustrator (or anything else)
// re-saves a watched .ai/.svg, we notify the renderer so it can show the
// "source file changed — update?" prompt.
let watcher = null;
let notify = () => {};
const watched = new Set();

function init(cb) {
  notify = cb || (() => {});
  watcher = chokidar.watch([], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  });
  watcher.on('change', (filePath) => notify({ type: 'change', filePath }));
  watcher.on('unlink', (filePath) => notify({ type: 'unlink', filePath }));
}

function watch(filePath) {
  if (!watcher || watched.has(filePath)) return;
  watched.add(filePath);
  watcher.add(filePath);
}

function unwatch(filePath) {
  if (!watcher || !watched.has(filePath)) return;
  watched.delete(filePath);
  watcher.unwatch(filePath);
}

function dispose() {
  if (watcher) { watcher.close(); watcher = null; }
  watched.clear();
}

module.exports = { init, watch, unwatch, dispose };
