'use strict';
const { Menu } = require('electron');

// Native application menu. Each click forwards a stable action id to the
// renderer, where the actual command lives (keeps one source of truth).
function buildMenu(win) {
  const send = (action) => win.webContents.send('menu:action', action);
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: 'FontMaker',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:saveAs') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('file:import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => send('file:export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('edit:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('edit:redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => send('edit:cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('edit:copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('edit:paste') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('edit:selectAll') },
        { label: 'Deselect', accelerator: 'CmdOrCtrl+D', click: () => send('edit:deselect') },
        { type: 'separator' },
        { label: 'Find Glyph…', accelerator: 'CmdOrCtrl+F', click: () => send('edit:findGlyph') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Glyphboard', accelerator: 'CmdOrCtrl+1', click: () => send('window:glyphboard') },
        { label: 'Workboard', accelerator: 'CmdOrCtrl+2', click: () => send('window:workboard') },
        { label: 'Chartboard', accelerator: 'CmdOrCtrl+3', click: () => send('window:chartboard') },
        { type: 'separator' },
        { label: 'Toggle Theme (Dark/Light)', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('window:toggleTheme') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }] : []),
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => send('help:shortcuts') },
        { label: 'About FontMaker', click: () => send('help:about') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
