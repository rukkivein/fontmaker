import { store, uid } from './store.js';
import { createProject, deletePointsAllMasters } from './project.js';
import { ALPHABET_ANCHOR } from './data.js';
import { buildMenubar } from './menus.js';
import { buildToolbar, selectTool } from './toolbar.js';
import { refreshControlPanel } from './controlpanel.js';
import { layout } from './layout.js';
import { glyphboard } from './glyphboard.js';
import { workboard, ensureWork } from './workboard.js';
import { chartboard } from './chartboard.js';
import { initTestbar, renderTestbar } from './testbar.js';
import { parseSVG } from './svgimport.js';
import { newProjectDialog, exportDialog, findGlyphDialog, infoDialog } from './modals.js';
import { toast, prompt } from './toast.js';

const hasNative = typeof window.fm !== 'undefined';

// --------------------------------------------------------------------------
// Bootstrapping
// --------------------------------------------------------------------------
function boot() {
  applyTheme(store.ui.theme);
  buildMenubar(dispatch);
  buildToolbar();
  initTestbar();
  layout.mount(document.getElementById('boards'));

  // Start with a ready-to-use Latin project so the studio isn't empty.
  setupProject(createProject({
    familyName: 'My Typeface',
    masterNames: ['Regular', 'Bold'],
    alphabets: ['latin'],
    gridPreset: 'standard',
  }));

  wireGlobalEvents();
  wireStore();

  if (hasNative) {
    window.fm.onMenu(dispatch);
    window.fm.onSourceChanged(onSourceChanged);
  }
}

function setupProject(project, filePath = null) {
  store.setProject(project, { filePath, markClean: true });
  ensureWork(project);
  // Open the alphabet's anchor glyph by default.
  const anchorChar = ALPHABET_ANCHOR[project.alphabets[0]] || 'A';
  const idx = project.glyphs.findIndex(g => g.char === anchorChar);
  store.ui.selectedGlyph = idx >= 0 ? idx : 0;
  store.ui.activeMasterId = project.masters[0].id;
  store.ui.ghostMasterId = project.masters[0].id;
  glyphboard.openMasters = [project.masters[0].id];
  store.ui.visibleBoards = { glyphboard: false, workboard: false, chartboard: true };
  store.ui.activeBoard = 'chartboard';
  layout.render();
  refreshControlPanel();
  setTitle();
}

// --------------------------------------------------------------------------
// Action dispatcher (shared by native menu, in-app menu and shortcuts)
// --------------------------------------------------------------------------
function dispatch(action) {
  switch (action) {
    case 'file:new': return newProjectDialog(opts => setupProject(createProject(opts)));
    case 'file:open': return openProject();
    case 'file:save': return saveProject(false);
    case 'file:saveAs': return saveProject(true);
    case 'file:import': return importSource();
    case 'file:export': return exportDialog(doExport);

    case 'edit:undo': store.undo(); afterEdit(true); return;
    case 'edit:redo': store.redo(); afterEdit(true); return;
    case 'edit:cut': return clipboardOp('cut');
    case 'edit:copy': return clipboardOp('copy');
    case 'edit:paste': return clipboardOp('paste');
    case 'edit:selectAll': return selectAll();
    case 'edit:deselect': store.ui.selection.points = []; store.ui.workSelection = []; glyphboard.requestDraw(); store.notify('ui'); return;
    case 'edit:findGlyph': return findGlyphDialog(openGlyph);

    case 'window:glyphboard': return toggleBoard('glyphboard');
    case 'window:workboard': return toggleBoard('workboard');
    case 'window:chartboard': return toggleBoard('chartboard');
    case 'window:toggleTheme': return toggleTheme();
    case 'window:glyphboardLight': {
      store.ui.glyphboardLight = !store.ui.glyphboardLight;
      layout.render(); glyphboard.requestDraw();
      toast(store.ui.glyphboardLight ? 'Glyphboard: light surface' : 'Glyphboard: dark surface');
      return;
    }

    case 'help:shortcuts': return infoDialog('Keyboard Shortcuts', SHORTCUTS_HTML);
    case 'help:about': return infoDialog('About FontMaker',
      'A glyph-based type design studio.<br>Photoshop-like workflow · Illustrator-style paths · real OpenType export.<br><br>Prototype build.');
  }
}

// --------------------------------------------------------------------------
// File / project operations
// --------------------------------------------------------------------------
async function openProject() {
  if (!hasNative) return toast('Open requires the desktop app');
  const res = await window.fm.project.open();
  if (res.ok) {
    setupProject(res.project, res.filePath);
    // Re-arm "source changed" watching for any vector sources this project used.
    const sources = new Set((res.project.work?.shapes || []).map(s => s.source).filter(Boolean));
    for (const sp of sources) window.fm.source.watch(sp);
    toast('Opened ' + baseName(res.filePath));
  }
}

async function saveProject(forceDialog) {
  if (!hasNative) return toast('Save requires the desktop app');
  const fp = store.ui.filePath;
  if (forceDialog || !fp) {
    const res = await window.fm.project.saveAs(store.project);
    if (res.ok) { store.ui.filePath = res.filePath; store.ui.dirty = false; setTitle(); toast('Saved ' + baseName(res.filePath)); }
  } else {
    await window.fm.project.save(fp, store.project);
    store.ui.dirty = false; setTitle(); toast('Saved');
  }
}

async function importSource() {
  if (!hasNative) return toast('Import requires the desktop app');
  const res = await window.fm.source.import();
  if (!res.ok) return;
  const n = applyVector(res);
  if (!n) return;
  // Reveal the workboard so the import is visible.
  store.ui.visibleBoards.workboard = true;
  store.ui.activeBoard = 'workboard';
  layout.render();
  requestAnimationFrame(() => workboard.fitToShapes());
  toast(`Imported ${baseName(res.filePath)} — ${n} shape${n === 1 ? '' : 's'}. Break Apart, then drag onto a glyph →`, { timeout: 4000 });
}

// Unifies .ai/.pdf/.eps (already parsed to shapes in the main process) and
// .svg (parsed here). Replaces any prior shapes from the same source so the
// "source changed → update" flow swaps cleanly.
function applyVector(res) {
  let shapes = res.shapes;
  if (!shapes) { try { shapes = parseSVG(res.content || ''); } catch { shapes = []; } }
  if (!shapes || !shapes.length) {
    const isAi = ['.ai', '.eps', '.pdf'].includes(res.ext);
    infoDialog('Couldn’t read vectors', isAi
      ? `No readable paths were found in this file. If it’s an older or flattened export, try re-saving from Illustrator with <b>Create PDF Compatible File</b> on, or export <b>SVG</b>.`
      : `No shapes found in this file.`);
    return 0;
  }
  store.commit('Import source', (p) => {
    const work = ensureWork(p);
    work.shapes = work.shapes.filter(s => s.source !== res.filePath);
    for (const s of shapes) { s.source = res.filePath; if (!s.id) s.id = uid('shape'); work.shapes.push(s); }
  });
  return shapes.length;
}

async function doExport({ format, metadata }) {
  if (!hasNative) return toast('Export requires the desktop app');
  const res = await window.fm.font.export(store.project, format, metadata);
  if (res.ok) toast(`Exported ${res.glyphCount} glyphs → ${baseName(res.filePath)}`, { timeout: 4000 });
  else if (res.error) { infoDialog('Export failed', '<pre style="white-space:pre-wrap">' + res.error + '</pre>'); }
}

// The "source file changed — update?" feature.
function onSourceChanged({ type, filePath }) {
  if (type === 'unlink') return;
  prompt(`Source changed: ${baseName(filePath)} — update?`, [
    { label: 'Ignore' },
    { label: 'Update', primary: true, onClick: async () => {
      const res = await window.fm.source.reimport(filePath);
      if (res.ok) {
        const n = applyVector(res);
        if (!store.ui.visibleBoards.workboard) { store.ui.visibleBoards.workboard = true; layout.render(); }
        else workboard.draw();
        if (n) toast(`Source updated — ${n} shape${n === 1 ? '' : 's'}`);
      }
    } },
  ]);
}

// --------------------------------------------------------------------------
// Editing helpers
// --------------------------------------------------------------------------
function selectAll() {
  if (store.ui.activeBoard === 'workboard') {
    store.ui.workSelection = ensureWork(store.project).shapes.map(s => s.id);
    workboard.draw();
  } else if (store.ui.activeBoard === 'glyphboard') {
    const glyph = store.project.glyphs[store.ui.selectedGlyph];
    if (!glyph) return;
    const layer = glyph.layers[store.ui.activeMasterId];
    const all = [];
    layer.contours.forEach((c, ci) => c.points.forEach((_, pi) => all.push({ ci, pi })));
    store.ui.selection.points = all;
    glyphboard.requestDraw();
  }
  store.notify('ui');
}

function clipboardOp(kind) {
  if (store.ui.activeBoard !== 'glyphboard') return;
  const glyph = store.project.glyphs[store.ui.selectedGlyph];
  if (!glyph) return;
  const layer = glyph.layers[store.ui.activeMasterId];
  if (kind === 'paste') {
    if (!store.ui.clipboard) return;
    store.commit('Paste', () => {
      for (const c of store.ui.clipboard) {
        const copy = JSON.parse(JSON.stringify(c));
        for (const p of copy.points) { p.x += 30; p.y -= 30; if (p.handleIn){p.handleIn.x+=30;p.handleIn.y-=30;} if (p.handleOut){p.handleOut.x+=30;p.handleOut.y-=30;} }
        layer.contours.push(copy);
      }
    });
    afterEdit(true);
    return;
  }
  // copy/cut whole contours that have any selected point (simple heuristic).
  const sel = store.ui.selection.points;
  const ciSet = new Set(sel.map(s => s.ci));
  const contours = (ciSet.size ? [...ciSet] : layer.contours.map((_, i) => i)).map(ci => layer.contours[ci]);
  store.ui.clipboard = JSON.parse(JSON.stringify(contours));
  if (kind === 'cut') {
    store.commit('Cut', () => {
      const keep = [...ciSet].sort((a, b) => b - a);
      for (const ci of keep) layer.contours.splice(ci, 1);
    });
    store.ui.selection.points = [];
    afterEdit(true);
  }
  toast(kind === 'cut' ? 'Cut' : 'Copied');
}

function openGlyph(idx) {
  store.ui.selectedGlyph = idx;
  if (!store.ui.visibleBoards.glyphboard) store.ui.visibleBoards.glyphboard = true;
  store.ui.activeBoard = 'glyphboard';
  glyphboard.openMasters = [store.ui.activeMasterId];
  layout.render();
  refreshControlPanel();
}

// --------------------------------------------------------------------------
// Window / view
// --------------------------------------------------------------------------
function toggleBoard(id) {
  store.ui.visibleBoards[id] = !store.ui.visibleBoards[id];
  if (store.ui.visibleBoards[id]) store.ui.activeBoard = id;
  layout.render();
}

function toggleTheme() {
  store.ui.theme = store.ui.theme === 'dark' ? 'light' : 'dark';
  applyTheme(store.ui.theme);
  glyphboard.requestDraw(); workboard.draw && workboard.draw(); chartboard.renderAll && chartboard.renderAll();
}
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }

function setTitle() {
  const fp = store.ui.filePath;
  document.title = 'FontMaker — ' + (store.project ? store.project.meta.familyName : 'Untitled') +
    (fp ? ' (' + baseName(fp) + ')' : '') + (store.ui.dirty ? ' •' : '');
}

// --------------------------------------------------------------------------
// Store reactions & global events
// --------------------------------------------------------------------------
function afterEdit(full) {
  glyphboard.requestDraw();
  if (full) { if (store.ui.visibleBoards.chartboard) chartboard.renderAll(); renderTestbar(); }
  setTitle();
}

function wireStore() {
  store.on('open-glyphboard', openGlyph);
  store.on('select-glyph', () => { glyphboard.requestDraw(); rebuildGlyphHead(); renderTestbar(); });
  store.on('focus-changed', () => { layout.markActive(); refreshControlPanel(); });
  store.on('assign', () => { chartboard.renderAll(); renderTestbar(); });

  store.subscribe((reason) => {
    if (reason === 'apply') { glyphboard.requestDraw(); return; }
    if (reason === 'ui') return; // handled by callers
    if (['commit', 'undo', 'redo', 'edit'].includes(reason)) afterEdit(true);
    if (reason === 'project') { setTitle(); }
  });
}

function rebuildGlyphHead() {
  // Cheapest correct approach: re-render layout heads only when needed.
  if (store.ui.visibleBoards.glyphboard) layout.render();
}

function wireGlobalEvents() {
  window.addEventListener('resize', () => layout.resizeAll());

  window.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
    if (e.code === 'Space' && !typing) { store._space = true; }
    // Hold Tab to make grid lines editable (release to lock). Not a toggle.
    if (e.key === 'Tab' && !typing) {
      e.preventDefault();
      if (!store.ui.gridEditMode) { store.ui.gridEditMode = true; glyphboard.requestDraw(); }
    }
    if (e.key === 'Escape') { store.ui.selection.points = []; store.ui.workSelection = []; glyphboard.requestDraw(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) { deleteSelection(); e.preventDefault(); }

    // Tool shortcuts (single keys), Photoshop-style.
    if (!typing && !e.metaKey && !e.ctrlKey) {
      const map = { v: 'position', a: 'point', m: 'area', b: 'brush', p: 'pinmesh', s: 'simplify', u: 'addshape', c: 'axis' };
      if (map[e.key]) selectTool(map[e.key]);
    }

    // The app owns all shortcuts (no native menu). Skip while editing text so
    // inputs keep normal copy/paste/select behavior.
    if ((e.metaKey || e.ctrlKey) && !typing) {
      const k = e.key.toLowerCase();
      const combo = { z: e.shiftKey ? 'edit:redo' : 'edit:undo', y: 'edit:redo', s: e.shiftKey ? 'file:saveAs' : 'file:save',
        o: 'file:open', n: 'file:new', e: 'file:export', i: 'file:import', a: 'edit:selectAll', d: 'edit:deselect',
        f: 'edit:findGlyph', c: 'edit:copy', x: 'edit:cut', v: 'edit:paste' };
      if (combo[k]) { e.preventDefault(); dispatch(combo[k]); }
      const num = { '1': 'window:glyphboard', '2': 'window:workboard', '3': 'window:chartboard' };
      if (num[e.key]) { e.preventDefault(); dispatch(num[e.key]); }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') store._space = false;
    if (e.key === 'Tab' && store.ui.gridEditMode) { store.ui.gridEditMode = false; glyphboard.requestDraw(); }
  });
  // Releasing Tab outside focus (e.g. window blur) should also lock the grid.
  window.addEventListener('blur', () => { if (store.ui.gridEditMode) { store.ui.gridEditMode = false; glyphboard.requestDraw(); } });
}

function deleteSelection() {
  if (store.ui.activeBoard === 'workboard') {
    if (!store.ui.workSelection.length) return;
    store.commit('Delete shapes', (p) => {
      const work = ensureWork(p);
      work.shapes = work.shapes.filter(s => !store.ui.workSelection.includes(s.id));
    });
    store.ui.workSelection = []; workboard.draw(); return;
  }
  const sel = store.ui.selection.points.slice();
  if (!sel.length) return;
  // Deleting points is structural → remove the matching points from every
  // master so layers stay interpolation-compatible.
  store.commit('Delete points', (p) => deletePointsAllMasters(p, store.ui.selectedGlyph, sel));
  store.ui.selection.points = [];
  afterEdit(true);
}

function baseName(p) { return p ? p.split(/[\\/]/).pop() : ''; }

const SHORTCUTS_HTML = `
  <b>Tools</b>: V Position · A Point · M Area · B Brush · P Pin Mesh · S Simplify · U Add Shape · C Axis<br>
  <b>Alt-click</b> outline (Point/Axis): insert a point — added to <i>all masters</i> at the matching spot<br>
  <b>Tab</b>: toggle grid edit mode · <b>Esc</b>: deselect · <b>Del</b>: delete selection (from all masters)<br>
  <b>Space-drag</b>: pan · <b>Ctrl/⌘ + wheel</b>: zoom<br>
  <b>⌘1/2/3</b>: Glyphboard / Workboard / Chartboard · <b>⌘F</b>: find glyph<br>
  <b>⌘S</b> save · <b>⇧⌘S</b> save as · <b>⌘E</b> export · <b>⌘Z/Y</b> undo/redo`;

boot();
