'use strict';
// Headless smoke test: load the renderer, capture console/errors, verify the
// UI bootstrapped (toolbar + chartboard cells), then quit.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const messages = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    messages.push({ level, message, source: (source || '').split('/').pop(), line });
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.log('RENDER GONE', JSON.stringify(d)); });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  // Give modules a moment to run rAF-based mounts.
  await new Promise(r => setTimeout(r, 900));

  let probe = {};
  try {
    probe = await win.webContents.executeJavaScript(`(function(){
      return {
        toolButtons: document.querySelectorAll('.tool-btn').length,
        chartCells: document.querySelectorAll('.chart-cell').length,
        menuBtns: document.querySelectorAll('.menu-btn').length,
        globalCtls: document.querySelectorAll('#global-controls .icon-toggle').length,
        title: document.title
      };
    })()`);

    // Interaction: open the glyphboard by double-clicking a chart cell.
    await win.webContents.executeJavaScript(`(function(){
      const cell = document.querySelector('.chart-cell');
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 500));
    probe.afterOpen = await win.webContents.executeJavaScript(`(function(){
      const pane = document.querySelector('.glyph-pane canvas');
      return {
        boards: document.querySelectorAll('.board').length,
        glyphPanes: document.querySelectorAll('.glyph-pane').length,
        paneHasSize: !!(pane && pane.width > 0 && pane.height > 0),
        masterTabs: document.querySelectorAll('.board-tab').length
      };
    })()`);
  } catch (err) { probe = { error: String(err), partial: probe }; }

  const errors = messages.filter(m => m.level === 3 /* error */ || /error|exception|failed/i.test(m.message));
  console.log('=== CONSOLE MESSAGES ===');
  for (const m of messages) console.log(`[${m.level}] ${m.source}:${m.line} ${m.message}`);
  console.log('=== PROBE ===');
  console.log(JSON.stringify(probe, null, 2));
  console.log('=== ERROR COUNT ===', errors.length);
  app.exit(errors.length || probe.error ? 1 : 0);
});
