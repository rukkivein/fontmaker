'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildMenu } = require('./menu');
const projectIO = require('./projectIO');
const fontExport = require('./fontExport');
const fileWatcher = require('./fileWatcher');

const isDev = process.argv.includes('--dev');
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#16171b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform === 'darwin' ? true : true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  buildMenu(mainWindow);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Forward file-change events from the watcher to the renderer.
  fileWatcher.init((evt) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('source:changed', evt);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  fileWatcher.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* ------------------------------------------------------------------ *
 *  IPC: Project save / load
 * ------------------------------------------------------------------ */
ipcMain.handle('project:saveAs', async (_e, project) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project As',
    defaultPath: (project && project.meta && project.meta.familyName ? project.meta.familyName : 'Untitled') + '.fontmaker',
    filters: [{ name: 'FontMaker Project', extensions: ['fontmaker', 'json'] }]
  });
  if (canceled || !filePath) return { ok: false };
  projectIO.save(filePath, project);
  return { ok: true, filePath };
});

ipcMain.handle('project:save', async (_e, { filePath, project }) => {
  if (!filePath) return { ok: false, needPath: true };
  projectIO.save(filePath, project);
  return { ok: true, filePath };
});

ipcMain.handle('project:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    properties: ['openFile'],
    filters: [{ name: 'FontMaker Project', extensions: ['fontmaker', 'json'] }]
  });
  if (canceled || !filePaths.length) return { ok: false };
  const project = projectIO.load(filePaths[0]);
  return { ok: true, filePath: filePaths[0], project };
});

/* ------------------------------------------------------------------ *
 *  IPC: Import vector source (SVG / AI / EPS)
 * ------------------------------------------------------------------ */
ipcMain.handle('source:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Vector Source',
    properties: ['openFile'],
    filters: [
      { name: 'Vector', extensions: ['svg', 'ai', 'eps', 'pdf'] },
      { name: 'SVG', extensions: ['svg'] },
      { name: 'Illustrator', extensions: ['ai'] }
    ]
  });
  if (canceled || !filePaths.length) return { ok: false };
  const filePath = filePaths[0];
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  // Start watching this file for external edits (the "source changed" feature).
  fileWatcher.watch(filePath);
  return { ok: true, filePath, content, ext: path.extname(filePath).toLowerCase() };
});

ipcMain.handle('source:read', async (_e, filePath) => {
  try {
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Re-arm watching for a source (used after a project is re-opened).
ipcMain.handle('source:watch', async (_e, filePath) => {
  fileWatcher.watch(filePath);
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 *  IPC: Font export (OTF / TTF / variable / web)
 * ------------------------------------------------------------------ */
ipcMain.handle('font:export', async (_e, { project, format, metadata }) => {
  const ext = format === 'woff' ? 'woff' : (format === 'ttf' ? 'ttf' : 'otf');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Font',
    defaultPath: (metadata.familyName || 'Untitled') + '.' + ext,
    filters: [{ name: format.toUpperCase(), extensions: [ext] }]
  });
  if (canceled || !filePath) return { ok: false };
  try {
    const result = fontExport.export(project, format, metadata, filePath);
    return { ok: true, filePath, glyphCount: result.glyphCount };
  } catch (err) {
    return { ok: false, error: String(err && err.stack ? err.stack : err) };
  }
});

ipcMain.handle('dialog:message', async (_e, opts) => {
  const res = await dialog.showMessageBox(mainWindow, opts);
  return res;
});
