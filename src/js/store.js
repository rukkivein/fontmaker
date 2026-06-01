// Central application store: holds the project + UI state, provides a tiny
// pub/sub, and manages undo/redo via project snapshots.

const listeners = new Set();
const channelListeners = new Map();

const state = {
  project: null,      // the document (masters, glyphs, grid, metrics, meta)
  ui: {
    theme: 'dark',
    glyphboardLight: false,        // dark app, but light glyphboard surface
    activeBoard: 'chartboard',     // which board the user last focused
    visibleBoards: { glyphboard: false, workboard: false, chartboard: true },
    tool: 'position',
    toolState: {},                 // per-tool control values (size, hardness…)
    selectedGlyph: null,           // index into project.glyphs
    activeMasterId: null,          // master being edited
    ghostMasterId: null,           // pane focus inside glyphboard split
    selection: { points: [] },     // [{ci, pi}] contour/point indices
    workSelection: [],             // selected shape ids on workboard
    globals: {
      ghostOn: true,
      gridsOn: true,
      linkMasters: false,
      ghostMasters: {},            // { masterId: bool } show other masters as ghosts
    },
    gridEditMode: false,           // toggled by Tab — lets metric lines move
    layout: { glyph: 1, work: 1, chart: 1 },  // flex weights
    filePath: null,
    dirty: false,
    clipboard: null,
    sources: {},                   // filePath -> { ext, content, shapeIds: [] }
  }
};

let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 80;

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

export const store = {
  get state() { return state; },
  get project() { return state.project; },
  get ui() { return state.ui; },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  on(channel, fn) {
    if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
    channelListeners.get(channel).add(fn);
    return () => channelListeners.get(channel).delete(fn);
  },
  emit(channel, payload) {
    const set = channelListeners.get(channel);
    if (set) for (const fn of set) fn(payload);
  },

  // Notify all generic subscribers to re-render.
  notify(reason = 'change') {
    for (const fn of listeners) fn(reason);
  },

  setProject(project, { filePath = null, markClean = true } = {}) {
    state.project = project;
    state.ui.filePath = filePath;
    state.ui.dirty = !markClean;
    state.ui.activeMasterId = project.masters[0].id;
    undoStack = [];
    redoStack = [];
    this.notify('project');
  },

  // Snapshot current project for undo, then run the mutation.
  commit(label, mutate) {
    if (!state.project) return;
    undoStack.push({ label, snapshot: clone(state.project) });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    mutate(state.project);
    state.ui.dirty = true;
    this.notify('commit');
  },

  // Mutate transiently without pushing undo (used during drags); caller pushes
  // a single undo at gesture start with beginGesture().
  apply(mutate) {
    if (!state.project) return;
    mutate(state.project);
    state.ui.dirty = true;
    this.notify('apply');
  },

  beginGesture(label) {
    if (!state.project) return;
    undoStack.push({ label, snapshot: clone(state.project) });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  },

  undo() {
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    redoStack.push({ label: entry.label, snapshot: clone(state.project) });
    state.project = entry.snapshot;
    this.notify('undo');
  },
  redo() {
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    undoStack.push({ label: entry.label, snapshot: clone(state.project) });
    state.project = entry.snapshot;
    this.notify('redo');
  },
  canUndo() { return undoStack.length > 0; },
  canRedo() { return redoStack.length > 0; },

  setUI(patch) { Object.assign(state.ui, patch); this.notify('ui'); },
};

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}
