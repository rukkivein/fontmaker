'use strict';
// Capture screenshots of the redesigned UI for visual verification.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 940, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise(r => setTimeout(r, 900));
  const outDir = path.join(__dirname, '_shots');
  fs.mkdirSync(outDir, { recursive: true });

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
  };

  await shot('01-chartboard-dark.png');

  // Open the glyphboard + add a demo shape so we see the editor with grid/ghost.
  await win.webContents.executeJavaScript(`(function(){
    const cell = document.querySelectorAll('.chart-cell')[0];
    cell.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  })()`);
  await new Promise(r => setTimeout(r, 600));
  await shot('02-glyphboard-dark.png');

  // Light theme.
  await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme','light')`);
  await new Promise(r => setTimeout(r, 300));
  await shot('03-glyphboard-light.png');

  console.log('shots written to', outDir);
  app.exit(0);
});
