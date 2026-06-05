'use strict';
// FontMaker UXP panel controller (Adobe Illustrator).
// Drawing happens in Illustrator; this panel assigns selected artwork to glyph
// slots (scaled to cap height, written to every master) and exports a real OTF
// via the shared, host-agnostic core/fontEngine.js.

const { contoursFromSelection } = require('./src/ilbridge.js');
const glyphset = require('./src/glyphset.js');
const { buildFont } = require('./lib/fontEngine.js');

// --- host handles (defensive: Illustrator UXP exposes the DOM a few ways) ----
function getApp() {
  try { const m = require('illustrator'); if (m && m.app) return m.app; } catch (e) {}
  if (typeof app !== 'undefined') return app;                      // global
  if (typeof globalThis !== 'undefined' && globalThis.app) return globalThis.app;
  return null;
}
const uxp = require('uxp');

// --- state -------------------------------------------------------------------
const project = glyphset.createProject({ familyName: 'My Typeface' });
let selectedIndex = -1;

// --- DOM refs ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const statusEl = $('status');
const assignBtn = $('assignBtn');
const assignTarget = $('assignTarget');
const exportBtn = $('exportBtn');
const filledCount = $('filledCount');

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function isFilled(g) {
  const layer = g.layers[project.masters[0].id];
  return !!(layer && layer.contours && layer.contours.length);
}

function refreshCounts() {
  const n = project.glyphs.filter(isFilled).length;
  filledCount.textContent = n + (n === 1 ? ' glyph' : ' glyphs');
  exportBtn.disabled = n === 0;
}

function buildGrid() {
  grid.textContent = '';
  project.glyphs.forEach((g, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = g.char === ' ' ? '␣' : g.char;
    cell.dataset.index = String(i);
    cell.addEventListener('click', () => selectGlyph(i));
    grid.appendChild(cell);
  });
  syncGrid();
}

function syncGrid() {
  const cells = grid.children;
  for (let i = 0; i < cells.length; i++) {
    const g = project.glyphs[i];
    let cls = 'cell';
    if (isFilled(g)) cls += ' filled';
    if (i === selectedIndex) cls += ' selected';
    cells[i].className = cls;
  }
  refreshCounts();
}

function selectGlyph(i) {
  selectedIndex = i;
  const g = project.glyphs[i];
  assignTarget.textContent = g.char === ' ' ? 'space' : g.char;
  assignBtn.disabled = false;
  syncGrid();
}

// --- selection -> glyph ------------------------------------------------------
function readSelectionContours() {
  const a = getApp();
  if (!a) throw new Error('Illustrator DOM not available');
  if (!a.activeDocument) throw new Error('Open a document first');
  const sel = a.activeDocument.selection;
  if (!sel || sel.length === 0) throw new Error('Nothing selected in Illustrator');
  return contoursFromSelection(sel);
}

function onAssign() {
  if (selectedIndex < 0) return;
  try {
    const contours = readSelectionContours();
    if (!contours.length) { setStatus('Selection has no path outlines.', 'err'); return; }
    const ok = glyphset.assignContoursToGlyph(project, contours, selectedIndex);
    if (!ok) { setStatus('Could not place selection.', 'err'); return; }
    const g = project.glyphs[selectedIndex];
    const pts = contours.reduce((n, c) => n + c.points.length, 0);
    setStatus('Assigned ' + contours.length + ' contour(s), ' + pts + ' pts → "' + g.char + '".', 'ok');
    syncGrid();
  } catch (err) {
    setStatus(String(err.message || err), 'err');
  }
}

// --- export ------------------------------------------------------------------
function currentMetadata() {
  return {
    familyName: $('familyName').value.trim() || 'My Typeface',
    styleName: $('styleName').value.trim() || 'Regular',
    designer: $('designer').value.trim(),
    masterId: project.masters[0].id,
    version: '1.000',
  };
}

async function onExport() {
  try {
    const meta = currentMetadata();
    project.meta.familyName = meta.familyName;
    project.meta.styleName = meta.styleName;
    setStatus('Building font…');
    const { buffer, glyphCount } = buildFont(project, 'otf', meta);

    const fs = uxp.storage.localFileSystem;
    const file = await fs.getFileForSaving((meta.familyName.replace(/\s+/g, '') || 'Font') + '.otf', { types: ['otf'] });
    if (!file) { setStatus('Export cancelled.'); return; }
    await file.write(buffer, { format: uxp.storage.formats.binary });
    setStatus('Exported ' + glyphCount + ' glyphs → ' + file.name, 'ok');
  } catch (err) {
    setStatus('Export failed: ' + String(err.message || err), 'err');
  }
}

// --- boot --------------------------------------------------------------------
function boot() {
  buildGrid();
  refreshCounts();
  assignBtn.addEventListener('click', onAssign);
  exportBtn.addEventListener('click', onExport);
  setStatus('Ready. ' + project.glyphs.length + ' slots.');
}

// UXP panel entrypoint registration; fall back to direct boot for plain preview.
try {
  uxp.entrypoints.setup({
    panels: {
      fontmakerPanel: {
        show() { /* panel root already in DOM */ },
        hide() {},
      },
    },
  });
} catch (e) { /* not in UXP host */ }

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
