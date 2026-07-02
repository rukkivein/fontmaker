'use strict';
/* FontMaker CEP panel controller (Adobe Illustrator).
 * Page 1 (New Font): name/version, master type, multi-select character sets
 * (dropdown), and one or more overlaid construction grids. Page 2 (Workspace):
 * a tab per open font, assign selected Illustrator artwork to glyph slots
 * (scaled to cap height), a live font tester, and OTF export. Geometry is read
 * via ExtendScript; CEP runs Node so require/fs/Buffer are native. */

var cs = new CSInterface();
var ROOT = cs.getSystemPath(SystemPath.EXTENSION);
// Build stamp — install-cep.js stamps a ?v=<build> on this script's url to defeat CEF's
// stale-JS cache. Log it (and put it on the <body> as data-build) so a reload can be VERIFIED:
// if the panel still runs old code, this build id won't change. See scripts/install-cep.js.
try {
  var _bm = (document.currentScript && document.currentScript.src || '').match(/[?&]v=([^&]+)/);
  var _build = _bm ? _bm[1] : 'dev';
  console.log('[RuneType] panel build ' + _build);
  var _stampBuild = function () {
    document.body.setAttribute('data-build', _build);
    var t = document.getElementById('buildTag');
    if (t) { t.textContent = 'build ' + _build; t.title = 'Loaded panel build (' + _build + '). It changes on every install — if it does NOT change after you reopen the panel, the panel is still running cached code; close Illustrator fully and reopen.'; }
  };
  if (document.body) _stampBuild();
  else document.addEventListener('DOMContentLoaded', _stampBuild);
} catch (e) {}
var ilbridge = require(ROOT + '/js/ilbridge.js');
var glyphset = require(ROOT + '/js/glyphset.js');
var charsets = require(ROOT + '/js/charsets.js');
var dna = require(ROOT + '/js/dna.js');
var optimizer = require(ROOT + '/js/optimizer.js');
var kernvision = require(ROOT + '/js/kernvision.js');   // Visual Kern (Track A): white-area optical pair kerning → f.kernOverride
var kernai = require(ROOT + '/js/kernai.js');           // Visual Kern (Track B): offline pair-kern model → seeds (fail-soft)
var refspace = require(ROOT + '/js/refspace.js');
var accentCompose = require(ROOT + '/js/accentCompose.js');
var markgen = require(ROOT + '/js/markgen.js');   // synthesize diacritic marks from existing shapes
var varCompat = require(ROOT + '/js/varCompat.js');
var imagetrace = require(ROOT + '/js/imagetrace.js');   // legacy imagetracerjs path (kept for fallback)
var potrace = require(ROOT + '/js/potrace.js');         // clean-room pixel-faithful, minimal-node tracer (primary)
var imgglyphs = require(ROOT + '/js/imgglyphs.js');     // cluster/detect/map/seat traced glyphs
var glyphreco = require(ROOT + '/js/glyphreco.js');     // offline onnxruntime-web glyph recognizer (first-guess)
var vecai = require(ROOT + '/js/vecai.js');             // offline onnxruntime-web vector refiner (smooth/sharpen AIs)
var kerninject = require(ROOT + '/js/kerninject.js');   // splice f.kerning into the exported sfnt as a real 'kern' table
var spacingai = require(ROOT + '/js/spacingai.js');     // offline sidebearing model → per-glyph optical recession for the bake
var unite = require(ROOT + '/js/unite.js');             // containment-tree contour union (preserves counters/holes)
// CEP is a Node-integrated Chromium. onnxruntime-web's wasm glue otherwise detects
// "Node" (process.versions.node && process.type != 'renderer') and tries to
// import('worker_threads') — which fails here, breaking BOTH the recognizer and the
// refiner. Posing as an Electron renderer makes it take the browser path (works,
// single-thread, wasmBinary = no fetch). This is the documented Electron escape hatch.
try { if (typeof process !== 'undefined' && process.type !== 'renderer') process.type = 'renderer'; } catch (e) {}
var FEAT = require(ROOT + '/js/features.js').FEATURES;  // edition gating (alpha/pro)
var placeholder = require(ROOT + '/js/placeholder.js');
var fontEngine = require(ROOT + '/js/lib/fontEngine.js');
var fs = require('fs');
var opentypeLib = null, paperLib = null; // lazy: heavy libs load on first use
function getOpentype() {
  if (!opentypeLib) { try { opentypeLib = require(ROOT + '/js/lib/opentype.js'); } catch (e) {} }
  return opentypeLib;
}
function getPaper() {
  if (!paperLib) {
    try {
      // paper's UMD must take the BROWSER branch (its node branch wants jsdom),
      // so evaluate it with module/exports hidden and window as self.
      var src = fs.readFileSync(ROOT + '/js/lib/paper-core.min.js', 'utf8');
      var nl = String.fromCharCode(10); // real newline: the file may end in a // comment
      var load = new Function('module', 'exports', 'define', 'self', 'window',
        src + nl + 'return (typeof paper !== "undefined" ? paper : self.paper);');
      var paper = load(undefined, undefined, undefined, window, window);
      paperLib = new paper.PaperScope();
      paperLib.setup(new paperLib.Size(1000, 1000));
    } catch (e) { paperLib = null; }
  }
  return paperLib;
}

var fonts = [];          // open fonts (each is a single-master project)
var activeFont = -1;
var selectedSlot = -1;
var openGlyphIndex = -1; // glyph currently open for editing in Illustrator
var searchQuery = '';
var alphaFilters = []; // selected alphabet keys (multi); empty = all
var selSourceContours = null; // the current Illustrator selection, captured live (font units)
var activeMaster = 0;   // index into curFont().masters
var activeSection = 'glyphs'; // glyphs | mod | test
var faceSeq = 0;         // unique @font-face family per rebuild

function $(id) { return document.getElementById(id); }
function show(v) {
  $('view-new').classList.toggle('hidden', v !== 'new');
  $('view-work').classList.toggle('hidden', v !== 'work');
  // The reset rescue button lives in the workspace's top-right; on the home page
  // the masters picker owns that corner, so hide it there to avoid the overlap.
  if ($('resetBtn')) $('resetBtn').classList.toggle('hidden', v !== 'work');
}
function evalScript(code) { return new Promise(function (r) { cs.evalScript(code, function (x) { r(x); }); }); }

// ============ PAGE 1 — New Font (RuneType Glyphmaker) ============
// Holds settings only; nothing is generated until Start Creating.
var draft = null;
function newDraft() {
  // Pre-select the most common Latin basics. The grid starts as a blank canvas
  // the user designs on (circles / dashed lines / square grid / baselines).
  // Basic mode tracks the picked LANGUAGES (langSel) and derives `lang` (the set
  // selection) from them; Advanced mode toggles `lang` directly via the cards.
  var dflt = (charsets.COUNTRIES || []).filter(function (c) { return c.name === 'United States'; })[0];
  var langSel = dflt ? [{ label: dflt.lang, sets: dflt.sets.slice() }] : [];
  var lang = {};
  langSel.forEach(function (L) { L.sets.forEach(function (k) {
    if (FEAT.charsets && FEAT.charsets.indexOf(k) < 0) return; lang[k] = true; }); });
  if (FEAT.charsets && !Object.keys(lang).length) FEAT.charsets.forEach(function (k) { lang[k] = true; });
  return {
    masters: [{ name: 'Regular' }],
    // alpha restricts the offered sets (FEAT.charsets); pro pre-selects the basics
    lang: lang,
    langSel: langSel,
    gridDesign: (function () {
      var pv = gdPresetItems('copyvector');
      return { items: pv.items.map(function (it) { it.symX = !!it.symX; it.symY = !!it.symY; return it; }),
               gridOn: true, gridCell: pv.cell || 50, gridMul: pv.mul || 1, preset: 'copyvector',
               symX: false, symY: false, sel: -1, selGrid: false, selSet: [], undo: [], redo: [] };
    })(),
    toggle: 'lang',
  };
}

function buildPage1() {
  if (!draft) draft = newDraft();
  buildCountries();
  renderMasters(); updateMasterAdd(); setToggle(draft.toggle); renderProfile();
}

// Country dropdown (custom, scrollable) → auto-select that language's sets.
function buildCountries() {
  var list = $('countryList'); list.innerHTML = '';
  charsets.COUNTRIES.forEach(function (c) {
    var it = document.createElement('div'); it.className = 'country-item'; it.textContent = c.name;
    it.addEventListener('click', function () {
      if (appMode === 'basic') {
        addLanguage(c);                      // Basic — stack languages (✕ to remove)
      } else {
        draft.lang = {};                     // Advanced — replace the set selection
        c.sets.forEach(function (k) { draft.lang[k] = true; });
      }
      $('countryList').classList.add('hidden');
      setToggle('lang'); renderProfile();
    });
    list.appendChild(it);
  });
}

// --- Basic-mode language list: draft.langSel (picked languages) drives draft.lang ---
function deriveLangSets() {
  var o = {};
  (draft.langSel || []).forEach(function (L) {
    (L.sets || []).forEach(function (k) {
      if (FEAT.charsets && FEAT.charsets.indexOf(k) < 0) return;   // edition lock
      o[k] = true;
    });
  });
  draft.lang = o;
}
function addLanguage(c) {
  if (!draft.langSel) draft.langSel = [];
  if (draft.langSel.some(function (L) { return L.label === c.lang; })) return;  // dedupe by language
  draft.langSel.push({ label: c.lang, sets: c.sets.slice() });
  deriveLangSets();
}
function removeLanguage(i) {
  if (!draft.langSel) return;
  draft.langSel.splice(i, 1);
  deriveLangSets();
}

// The + is disabled until a non-empty, non-duplicate master name is typed
// (so you can't add a second "Regular" or an empty master).
function updateMasterAdd() {
  if (!FEAT.masters) { $('m-add').disabled = true; return; }   // single-master edition
  var name = $('m-name').value.trim();
  var dup = draft.masters.some(function (m) { return m.name.toLowerCase() === name.toLowerCase(); });
  $('m-add').disabled = !name || dup;
}

// --- masters ---
function renderMasters() {
  var list = $('m-list'); list.innerHTML = '';
  draft.masters.forEach(function (m, i) {
    var row = document.createElement('div'); row.className = 'm-row';
    var nm = document.createElement('span'); nm.textContent = m.name; row.appendChild(nm);
    if (i > 0) {
      var x = document.createElement('button'); x.className = 'm-x'; x.title = 'Remove master';
      x.addEventListener('click', function (e) { e.stopPropagation(); draft.masters.splice(i, 1); renderMasters(); renderProfile(); });
      row.appendChild(x);
    } else { var tag = document.createElement('span'); tag.className = 'm-tag'; tag.textContent = 'default'; row.appendChild(tag); }
    list.appendChild(row);
  });
}
function onAddMaster() {
  if (!FEAT.masters) return;   // single-master edition
  var name = $('m-name').value.trim();
  if (!name) return;
  if (draft.masters.some(function (m) { return m.name.toLowerCase() === name.toLowerCase(); })) return;
  draft.masters.push({ name: name });
  $('m-name').value = '';
  renderMasters(); renderProfile(); updateMasterAdd();
  $('m-list').classList.remove('hidden');
}

// --- the two toggles: Language Support / Style Preset ---
function setToggle(which) {
  draft.toggle = which;
  $('tg-lang').classList.toggle('active', which === 'lang');
  $('tg-grid').classList.toggle('active', which === 'preset');
  $('tg-lang').querySelector('.pill-ar').classList.toggle('flip', which === 'lang');
  $('tg-grid').querySelector('.pill-ar').classList.toggle('flip', which === 'preset');
  $('countryBar').classList.toggle('hidden', which !== 'lang');
  renderRightList(); updatePillLabels();
}
function renderRightList() {
  var box = $('rune-list'); box.innerHTML = '';
  box.classList.toggle('gd-mode', draft.toggle === 'preset'); // designer fills the panel, no scroll
  box.classList.toggle('lang-mode', draft.toggle === 'lang' && appMode === 'basic');
  if (draft.toggle === 'preset') return renderGridDesigner(box, draft.gridDesign, function () { updatePillLabels(); renderProfile(); });
  // BASIC — show the picked LANGUAGES as removable chips (the country picker adds them).
  if (appMode === 'basic') return renderLangChips(box);
  // ADVANCED — multi-select character sets. The edition may LOCK some
  // sets: they stay visible but greyed/non-toggleable (an upsell, not hidden).
  charsets.ALPHABETS.forEach(function (it) {
    var locked = !!FEAT.charsets && FEAT.charsets.indexOf(it.key) < 0;
    var on = !!draft.lang[it.key];
    var essential = charsets.ESSENTIAL.indexOf(it.key) >= 0;
    var row = document.createElement('div');
    row.className = 'rune-item' + (on ? ' on' : '') + (essential ? ' essential' : '') + (locked ? ' locked' : '');
    var rec = locked ? ' <span class="ri-rec ri-pro">Pro</span>' : (essential ? ' <span class="ri-rec">Recommended</span>' : '');
    var txt = document.createElement('div'); txt.className = 'ri-txt';
    txt.innerHTML = '<div class="ri-t">' + it.label + rec + '</div><div class="ri-d chars">' + charsets.sampleChars(it.key, 10) + '</div>';
    var btn = document.createElement('div'); btn.className = 'ri-btn ' + (locked ? 'is-lock' : (on ? 'is-x' : 'is-plus'));
    row.appendChild(txt); row.appendChild(btn);
    if (!locked) row.addEventListener('click', function () { draft.lang[it.key] = !draft.lang[it.key]; renderRightList(); updatePillLabels(); renderProfile(); });
    box.appendChild(row);
  });
}
// Basic mode: the selected-languages list. Pick a country above to add one; the
// ✕ removes it. The underlying character sets are derived in deriveLangSets().
function renderLangChips(box) {
  if (!draft.langSel || !draft.langSel.length) {
    var empty = document.createElement('div'); empty.className = 'lang-empty';
    empty.textContent = 'Pick a country above to add a language.';
    box.appendChild(empty); return;
  }
  draft.langSel.forEach(function (L, i) {
    var row = document.createElement('div'); row.className = 'lang-chip';
    var txt = document.createElement('div'); txt.className = 'lang-txt';
    var nm = document.createElement('div'); nm.className = 'lang-name'; nm.textContent = L.label;
    var sub = document.createElement('div'); sub.className = 'lang-sub';
    var nSets = (L.sets || []).filter(function (k) { return !FEAT.charsets || FEAT.charsets.indexOf(k) >= 0; }).length;
    sub.textContent = nSets + ' character sets';
    txt.appendChild(nm); txt.appendChild(sub);
    var x = document.createElement('button'); x.className = 'lang-x'; x.type = 'button';
    x.title = 'Remove ' + L.label; x.textContent = '✕';
    x.addEventListener('click', function () {
      removeLanguage(i); renderRightList(); updatePillLabels(); renderProfile();
    });
    row.appendChild(txt); row.appendChild(x);
    box.appendChild(row);
  });
}
// ===== GRID DESIGNER — a white mini-A4 canvas the user composes the
// construction grid on: circles, dashed lines (0–360°), a square grid toggle,
// baselines from the bottom/right bars, X/Y symmetry, undo/redo. Items are
// stored in FONT UNITS (x 0..1000 across the em, y -200..800).
var GD_W = 595, GD_H = 842, GD_PX = 36; // mini A4 + canvas padding
// UNIFORM scale (same px per font unit on both axes) so grid cells are always
// SQUARE and angles/circles render true; the em block centres vertically.
var GD_SX = (GD_W - 2 * GD_PX) / 1000, GD_SY = GD_SX;
var GD_PY = (GD_H - 1000 * GD_SY) / 2;
// ---- mathematical grid presets (em: x 0..1000, baseline 0, cap 716, x-height
// 519, cap-box centre (500,358), φ = 1.618) ----
var GD_PHI = 1.61803398875;
var GD_PRESETS = [
  { key: 'xtall', label: 'Tall x-Height' },
  { key: 'xregular', label: 'Regular x-Height' },
  { key: 'xsmall', label: 'Small x-Height' },
  { key: 'calligraphic', label: 'Calligraphic' },
  { key: 'modular', label: 'Modular' },
  { key: 'copyvector', label: 'Paste Vector' },
];
// The three x-height presets share one construction: a SOLID portrait
// rectangle (baseline, cap, sidebearings) with its optical allowance dashed on
// all four sides, plus a SOLID x-height line (the upper/lowercase divide) with
// dashed optical allowance above and below. Only the x-height differs:
// tall lowercase / Arial-standard / small lowercase ("A vs a").
function gdLetterBox(xh) {
  var CAP = 716, OV = 15, L = 60, Rt = 940;
  function dl(cx, cy, a) { return { type: 'dline', cx: cx, cy: cy, angle: a }; }
  function h(y) { return { type: 'hline', y: Math.round(y) }; }
  function v(x) { return { type: 'vline', x: Math.round(x) }; }
  return { grid: true, cell: 50, items: [
    // solid rectangle — the SIDE lines are ONE symmetric red item each (solid +
    // dashed optical): symY keeps left/right mirrored no matter how they move
    h(0), h(CAP),
    { type: 'vline', x: L, symY: true, red: true },
    { type: 'dline', cx: L - OV, cy: 300, angle: 90, symY: true, red: true },
    // top/bottom optical allowance (dashed)
    dl(500, -OV, 0), dl(500, CAP + OV, 0),
    // the uppercase/lowercase divide + its optical allowance
    h(xh), dl(500, xh - OV, 0), dl(500, xh + OV, 0),
  ] };
}
function gdPresetItems(key) {
  // em geometry: x 0..1000, baseline 0, cap 716, x-height 519, centre (500,358)
  var CAP = 716, XH = 519, CY = 358;
  function c(cx, cy, r) { return { type: 'circle', cx: cx, cy: cy, r: Math.round(r) }; }
  function dl(cx, cy, a) { return { type: 'dline', cx: cx, cy: cy, angle: a }; }
  function h(y) { return { type: 'hline', y: Math.round(y) }; }
  function v(x) { return { type: 'vline', x: Math.round(x) }; }
  switch (key) {
    case 'xtall': return gdLetterBox(590);      // big lowercase (x-height 0.82 cap)
    case 'xregular': return gdLetterBox(519);   // Arial-standard x-height
    case 'xsmall': return gdLetterBox(440);     // small lowercase (0.61 cap)
    case 'calligraphic': // 30° broad-nib slant family over the metrics
      return { grid: true, cell: 50, items: [
        h(0), h(XH), h(CAP),
        dl(250, CY, 60), dl(500, CY, 60), dl(750, CY, 60),
      ] };
    case 'modular': // coarse em grid + stacked circles on the centre axis
      return { grid: true, cell: 125, mul: 2, items: [
        v(500), h(CAP / 2),
        c(500, CAP / 4, CAP / 4), c(500, CY, CAP / 4), c(500, 3 * CAP / 4, CAP / 4),
      ] };
    case 'copyvector': // paste-safe area: only baselines carving margins on all four sides
      return { grid: true, cell: 50, items: [h(-100), h(700), v(100), v(900)] };
  }
  return null;
}
function gdXs(fx) { return GD_PX + fx * GD_SX; }
function gdYs(fy) { return GD_PY + (800 - fy) * GD_SY; }
// every grid opens ~30% zoomed out (centred) so the whole glyph and its margins
// are comfortably visible inside the frame, with room before anything clips
var GD_ZOUT = 0.7;
function defaultView() { return { x: (GD_W / 2) * (1 - GD_ZOUT), y: (GD_H / 2) * (1 - GD_ZOUT), s: GD_ZOUT }; }
// the font-unit rectangle currently visible through a view (+ a small margin), so
// grid lines and rulers can be drawn to FILL the frame at any zoom/pan ("infinite")
function viewFontBounds(v) {
  function fxOf(bx) { return (bx - GD_PX) / GD_SX; }
  function fyOf(by) { return 800 - (by - GD_PY) / GD_SY; }
  var x0 = fxOf((0 - v.x) / v.s), x1 = fxOf((GD_W - v.x) / v.s);
  var ya = fyOf((0 - v.y) / v.s), yb = fyOf((GD_H - v.y) / v.s);
  var y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
  var mX = (x1 - x0) * 0.12, mY = (y1 - y0) * 0.12;
  return { x0: x0 - mX, x1: x1 + mX, y0: y0 - mY, y1: y1 + mY };
}
function gdSnap(gd) { return JSON.stringify({ items: gd.items, gridOn: gd.gridOn, gridCell: gd.gridCell, gridMul: gd.gridMul || 1, symX: gd.symX, symY: gd.symY }); }
function gdPush(gd) { gd.undo.push(gdSnap(gd)); if (gd.undo.length > 60) gd.undo.shift(); gd.redo.length = 0; }
function gdRestore(gd, s) { var o = JSON.parse(s); gd.items = o.items; gd.gridOn = o.gridOn; gd.gridCell = o.gridCell; gd.gridMul = o.gridMul || 1; gd.symX = o.symX; gd.symY = o.symY; gd.sel = -1; gd.selGrid = false; gd.selSet = []; }
// Mirror copies of an item under ITS OWN symmetry flags (stamped at creation,
// so turning symmetry off later never removes existing mirrors). Axes: x=500, y=300.
function gdVariants(it) {
  var v = [it];
  function mx(o) { var c = Object.assign({}, o); if (c.cx != null) c.cx = 1000 - c.cx; if (c.x != null) c.x = 1000 - c.x; if (c.angle != null) c.angle = (180 - c.angle + 360) % 360; return c; }
  function my(o) { var c = Object.assign({}, o); if (c.cy != null) c.cy = 600 - c.cy; if (c.y != null) c.y = 600 - c.y; if (c.angle != null) c.angle = (360 - c.angle) % 360; return c; }
  if (it.symY) v.push(mx(it));
  if (it.symX) { var n = v.length; for (var i = 0; i < n; i++) v.push(my(v[i])); }
  return v.slice(1);
}
function gdItemSvg(it, color, width, dash, idx, hit) {
  var sel = idx != null ? (' data-i="' + idx + '"') : '';
  var st;
  if (hit) st = 'fill="none" stroke="#000" stroke-opacity="0" stroke-width="16" pointer-events="stroke"' + sel;
  else st = 'fill="none" stroke="' + color + '" stroke-width="' + width + '"' + (dash ? ' stroke-dasharray="6 5"' : '') + sel;
  if (it.type === 'circle') return '<circle cx="' + gdXs(it.cx) + '" cy="' + gdYs(it.cy) + '" r="' + (it.r * GD_SX) + '" ' + st + '/>';
  if (it.type === 'dline') {
    var a = it.angle * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
    return '<line x1="' + gdXs(it.cx - 1600 * dx) + '" y1="' + gdYs(it.cy - 1600 * dy) + '" x2="' + gdXs(it.cx + 1600 * dx) + '" y2="' + gdYs(it.cy + 1600 * dy) + '" ' + st + '/>';
  }
  if (it.type === 'hline') return '<line x1="' + gdXs(0) + '" y1="' + gdYs(it.y) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(it.y) + '" ' + st + '/>';
  if (it.type === 'vline') return '<line x1="' + gdXs(it.x) + '" y1="' + gdYs(800) + '" x2="' + gdXs(it.x) + '" y2="' + gdYs(-200) + '" ' + st + '/>';
  return '';
}
function gdSelected(gd, i) { return gd.selSet && gd.selSet.indexOf(i) >= 0; }
// The white page is sized from the WINDOW (which never changes between
// sections) with a fixed reserve that already accounts for the toolbar — so it
// is byte-identical on glyphs. and modification., no matter the layout reflow.
// Only ONE pane editor is visible at a time, but its drag needs window-level
// move/up. Register through here so re-renders/section-switches never stack
// duplicate listeners (which would fire a drag several times).
function bindPaneWindow(onMove, onUp, onResize) {
  var h = window.__paneHandlers;
  if (h) {
    if (h.move) window.removeEventListener('mousemove', h.move);
    if (h.up) window.removeEventListener('mouseup', h.up);
    if (h.resize) window.removeEventListener('resize', h.resize);
  }
  window.__paneHandlers = { move: onMove, up: onUp, resize: onResize };
  if (onMove) window.addEventListener('mousemove', onMove);
  if (onUp) window.addEventListener('mouseup', onUp);
  if (onResize) window.addEventListener('resize', onResize);
}
function paneCanvasSize() {
  var H = window.innerHeight - 230;        // header + toolbar + footer + paddings
  var W = window.innerWidth * 0.5 - 56;    // right half, minus pane paddings
  var h = Math.max(180, Math.min(H, W * GD_H / GD_W));
  return { w: Math.round(h * GD_W / GD_H), h: Math.round(h) };
}
function gdView(gd) { if (!gd._view) gd._view = defaultView(); return gd._view; }
function gdShapePath(contours, dx, dy) {
  // glyph contours (font units, y-up) -> designer-space path string
  var d = '';
  contours.forEach(function (c) {
    var pts = c.points; if (!pts.length) return;
    function X(p) { return gdXs(p.x + dx); }
    function Y(p) { return gdYs(p.y + dy); }
    d += 'M' + X(pts[0]).toFixed(2) + ' ' + Y(pts[0]).toFixed(2);
    var segs = c.closed ? pts.length : pts.length - 1;
    for (var i = 0; i < segs; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasO || hasI) {
        var c1 = a.handleOut || a, c2 = b.handleIn || b;
        d += 'C' + gdXs(c1.x + dx).toFixed(2) + ' ' + gdYs(c1.y + dy).toFixed(2) + ' ' +
             gdXs(c2.x + dx).toFixed(2) + ' ' + gdYs(c2.y + dy).toFixed(2) + ' ' +
             gdXs(b.x + dx).toFixed(2) + ' ' + gdYs(b.y + dy).toFixed(2);
      } else d += 'L' + gdXs(b.x + dx).toFixed(2) + ' ' + gdYs(b.y + dy).toFixed(2);
    }
    if (c.closed) d += 'Z';
  });
  return d;
}
function gdShapeBounds(contours, dx, dy) {
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, any = false;
  contours.forEach(function (c) { c.points.forEach(function (p) {
    any = true;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }); });
  if (!any) return null;
  return { minX: minX + (dx || 0), maxX: maxX + (dx || 0), minY: minY + (dy || 0), maxY: maxY + (dy || 0) };
}
function gdScaleContours(contours, ax, ay, sx, sy) {
  return contours.map(function (c) {
    return { closed: c.closed, points: c.points.map(function (p) {
      return {
        x: ax + (p.x - ax) * sx, y: ay + (p.y - ay) * sy, type: p.type,
        handleIn: p.handleIn ? { x: ax + (p.handleIn.x - ax) * sx, y: ay + (p.handleIn.y - ay) * sy } : null,
        handleOut: p.handleOut ? { x: ax + (p.handleOut.x - ax) * sx, y: ay + (p.handleOut.y - ay) * sy } : null,
      };
    }) };
  });
}
function gdRedraw(svg, gd) {
  var v = gdView(gd);
  var vb = viewFontBounds(v);   // visible rect so the grid extends to fill the frame
  // the clip is effectively unbounded now — the grid is meant to run off the page
  var s = '<defs><clipPath id="gdclip"><rect x="-20000" y="-20000" width="40000" height="40000"/></clipPath></defs>';
  // white card fills the frame; the content zooms/pans within it (no dark margin)
  s += '<rect x="0" y="0" width="' + GD_W + '" height="' + GD_H + '" rx="4" fill="#ffffff"/>';
  s += '<g transform="translate(' + v.x + ' ' + v.y + ') scale(' + v.s + ')">';
  s += '<g clip-path="url(#gdclip)">';
  if (gd.gridOn) {
    // centre-aligned grid; with the ×2 coefficient every 2nd line (from the
    // centre out) is drawn twice as thick, in red
    var c = gd.gridCell || 50, mul = gd.gridMul || 1;
    var minor = gd.selGrid ? '#9cc3f0' : '#e2e2e2';
    var gl = function (x1, y1, x2, y2, major) {
      s += '<line x1="' + gdXs(x1) + '" y1="' + gdYs(y1) + '" x2="' + gdXs(x2) + '" y2="' + gdYs(y2) +
           '" stroke="' + (major ? '#c0271d' : minor) + '" stroke-width="' + (major ? 1.4 : 0.7) + '"' + (major ? ' opacity="0.55"' : '') + '/>';
    };
    var k, q;
    // lines run across the whole visible rect (vb) so the grid fills the frame
    for (k = Math.floor((vb.x0 - 500) / c); k <= Math.ceil((vb.x1 - 500) / c); k++) { q = (mul === 2 && k % 2 === 0); gl(500 + k * c, vb.y1, 500 + k * c, vb.y0, q); }
    for (k = Math.floor((vb.y0 - 300) / c); k <= Math.ceil((vb.y1 - 300) / c); k++) { q = (mul === 2 && k % 2 === 0); gl(vb.x0, 300 + k * c, vb.x1, 300 + k * c, q); }
  }
  if (gd.symY) s += '<line x1="' + gdXs(500) + '" y1="' + gdYs(vb.y1) + '" x2="' + gdXs(500) + '" y2="' + gdYs(vb.y0) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
  if (gd.symX) s += '<line x1="' + gdXs(vb.x0) + '" y1="' + gdYs(300) + '" x2="' + gdXs(vb.x1) + '" y2="' + gdYs(300) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
  // ghosts (mirrors) under the originals; thick visible strokes; fat invisible
  // hit layer on top. RED items (e.g. the letterbox side lines) stay red — and
  // their mirrors draw at full strength so both sides read as one pair.
  gd.items.forEach(function (it) {
    gdVariants(it).forEach(function (m) {
      s += gdItemSvg(m, it.red ? '#c0271d' : '#b5b5b5', it.red ? 2.4 : 1.8, it.type === 'dline', null, false);
    });
  });
  gd.items.forEach(function (it, i) {
    var on = gdSelected(gd, i);
    var guide = it.type === 'hline' || it.type === 'vline';
    var col = it.red ? (on ? '#e0392b' : '#c0271d')
            : guide ? (on ? '#0d66d0' : '#1473e6')
            : (on ? '#1473e6' : '#333333');
    s += gdItemSvg(it, col, on ? 3 : 2.4, it.type === 'dline', i, false);
  });
  gd.items.forEach(function (it, i) { s += gdItemSvg(it, null, 0, false, i, true); });
  if (gd._marq) {
    var m = gd._marq, x1 = Math.min(m.x1, m.x2), x2 = Math.max(m.x1, m.x2), y1 = Math.min(m.y1, m.y2), y2 = Math.max(m.y1, m.y2);
    s += '<rect x="' + gdXs(x1) + '" y="' + gdYs(y2) + '" width="' + ((x2 - x1) * GD_SX) + '" height="' + ((y2 - y1) * GD_SY) + '" fill="#1473e6" fill-opacity="0.08" stroke="#1473e6" stroke-width="1" stroke-dasharray="4 3"/>';
  }
  s += '</g>';   // close the em clip — the SHAPE may overflow it (optical protrusion)
  // the glyph's current shape (page 2): solid dark fill, draggable; when
  // selected it gets Illustrator-style transform controls (8 handles)
  if (gd._shape && gd._shape.length) {
    s += '<path d="' + gdShapePath(gd._shape, gd._sdx || 0, gd._sdy || 0) + '" fill="#1d1d1d" fill-rule="nonzero" data-shape="1" style="cursor:move"/>';
    if (gd._shapeSel) {
      var sb = gdShapeBounds(gd._shape, gd._sdx || 0, gd._sdy || 0);
      if (sb) {
        var x1 = gdXs(sb.minX), x2 = gdXs(sb.maxX), yT = gdYs(sb.maxY), yB = gdYs(sb.minY);
        var cxm = (x1 + x2) / 2, cym = (yT + yB) / 2;
        s += '<rect x="' + x1 + '" y="' + yT + '" width="' + (x2 - x1) + '" height="' + (yB - yT) + '" fill="none" stroke="#1473e6" stroke-width="1"/>';
        var H = [
          ['nw', x1, yT, 'nwse-resize'], ['n', cxm, yT, 'ns-resize'], ['ne', x2, yT, 'nesw-resize'],
          ['e', x2, cym, 'ew-resize'], ['se', x2, yB, 'nwse-resize'], ['s', cxm, yB, 'ns-resize'],
          ['sw', x1, yB, 'nesw-resize'], ['w', x1, cym, 'ew-resize'],
        ];
        for (var hi = 0; hi < H.length; hi++) {
          s += '<rect data-h="' + H[hi][0] + '" x="' + (H[hi][1] - 4) + '" y="' + (H[hi][2] - 4) + '" width="8" height="8" fill="#fff" stroke="#1473e6" stroke-width="1.2" style="cursor:' + H[hi][3] + '"/>';
        }
      }
    }
  }
  s += '</g>';   // view transform
  svg.innerHTML = s;
}
// slider <-> single selection
function gdSliderFor(gd) {
  if (gd.selGrid) return Math.round(gd.gridCell - 25);
  if (!gd.selSet || gd.selSet.length !== 1) return null;
  var it = gd.items[gd.selSet[0]];
  if (!it) return null;
  if (it.type === 'circle') return Math.round((it.r - 20) / 480 * 100);
  if (it.type === 'dline') return Math.round(it.angle / 3.6);
  if (it.type === 'hline') return Math.round((800 - it.y) / 10);
  if (it.type === 'vline') return Math.round(it.x / 10);
  return null;
}
function gdApplySlider(gd, v) {
  if (gd.selGrid) { gd.gridCell = Math.round(25 + v); return; }
  if (!gd.selSet || gd.selSet.length !== 1) return;
  var it = gd.items[gd.selSet[0]];
  if (!it) return;
  if (it.type === 'circle') it.r = Math.round(20 + v / 100 * 480);
  else if (it.type === 'dline') it.angle = Math.round(v * 3.6) % 360;
  else if (it.type === 'hline') it.y = Math.round(800 - v * 10);
  else if (it.type === 'vline') it.x = Math.round(v * 10);
}
// does an item touch a marquee rect (font units)?
function gdInRect(it, x1, y1, x2, y2) {
  if (it.type === 'circle') return it.cx + it.r >= x1 && it.cx - it.r <= x2 && it.cy + it.r >= y1 && it.cy - it.r <= y2;
  if (it.type === 'dline') return it.cx >= x1 && it.cx <= x2 && it.cy >= y1 && it.cy <= y2;
  if (it.type === 'hline') return it.y >= y1 && it.y <= y2;
  if (it.type === 'vline') return it.x >= x1 && it.x <= x2;
  return false;
}
function renderGridDesigner(box, gd, onChange) {
  if (!gd.selSet) gd.selSet = [];
  var notify = onChange || function () {};
  var wrap = document.createElement('div'); wrap.className = 'gd-wrap'; wrap.tabIndex = 0;
  wrap.innerHTML =
    '<div class="gd-top">' +
      '<div class="gd-toolcol">' +
        '<div class="gd-tools">' +
          '<button class="gd-tool" data-t="free" title="Freeform: pan the page, zoom with the wheel"><span class="gd-ic-free"></span></button>' +
          '<button class="gd-tool" data-t="circle" title="Add circle"><span class="gd-ic-circle"></span></button>' +
          '<button class="gd-tool" data-t="dline" title="Add dashed line (0-360)"><span class="gd-ic-dline"></span></button>' +
          '<button class="gd-tool" data-t="grid" title="Square grid on/off"><span class="gd-ic-grid"></span></button>' +
        '</div>' +
        '<input class="gd-slider" type="range" min="0" max="100" value="50" disabled title="Size / angle of the selection" />' +
      '</div>' +
      '<span class="gd-preset-caret"><select class="gd-presets" title="Mathematical grid presets"><option value="">Preset…</option>' +
        GD_PRESETS.map(function (p) { return '<option value="' + p.key + '">' + p.label + '</option>'; }).join('') +
      '</select></span>' +
      '<div class="gd-side">' +
        '<button class="gd-sym" data-a="symY" title="Vertical symmetry (applies to newly added items)"></button>' +
        '<button class="gd-sym" data-a="symX" title="Horizontal symmetry (applies to newly added items)"></button>' +
        '<button class="gd-hist" data-a="undo" title="Undo"></button>' +
        '<button class="gd-hist" data-a="redo" title="Redo"></button>' +
      '</div>' +
    '</div>' +
    '<div class="gd-mid">' +
      '<div class="gd-stage">' +
        '<svg class="gd-canvas" viewBox="0 0 ' + GD_W + ' ' + GD_H + '" preserveAspectRatio="xMidYMid meet"></svg>' +
        '<div class="gd-vbar" title="Drag onto the page to drop a vertical guide"></div>' +
        '<div class="gd-hbar" title="Drag onto the page to drop a baseline"></div>' +
      '</div>' +
    '</div>';
  box.appendChild(wrap);
  if (gd.preset) wrap.querySelector('.gd-presets').value = gd.preset;
  // edition gate: disable (don't hide) the one-click mathematical grid presets
  if (!FEAT.gridPresets) { var pcs = wrap.querySelector('.gd-presets'); if (pcs) { pcs.disabled = true; pcs.title = 'Grid presets are a Pro feature'; } }

  var svg = wrap.querySelector('.gd-canvas');
  var slider = wrap.querySelector('.gd-slider');
  // size the A4 to FIT both the available height AND width (reserving room for
  // the right ruler + gaps) — responsive, never scrolls, rulers always visible
  function fit() {
    var sz = paneCanvasSize();
    svg.style.width = sz.w + 'px';
    svg.style.height = sz.h + 'px';
  }
  var gdResize = function () { fit(); };
  function sync() {
    gdRedraw(svg, gd);
    var sv = gdSliderFor(gd);
    slider.disabled = (sv == null);
    if (sv != null) slider.value = Math.max(0, Math.min(100, sv));
    var gbtn = wrap.querySelector('[data-t=grid]');
    gbtn.classList.toggle('active', gd.gridOn);
    gbtn.classList.toggle('mul2', gd.gridOn && (gd.gridMul || 1) === 2);
    wrap.querySelector('[data-a=symY]').classList.toggle('on', gd.symY);
    wrap.querySelector('[data-a=symX]').classList.toggle('on', gd.symX);
    wrap.querySelector('[data-t=free]').classList.toggle('active', gd._tool === 'free');
    notify();
  }
  function addItem(it) {
    // stamp the active symmetry onto the item — its mirrors live with IT
    it.symX = gd.symX; it.symY = gd.symY;
    gdPush(gd); gd.items.push(it); gd.selSet = [gd.items.length - 1]; gd.selGrid = false; sync();
  }
  wrap.querySelector('[data-t=free]').addEventListener('click', function () {
    gd._tool = (gd._tool === 'free') ? null : 'free';
    if (gd._tool !== 'free') { var v = gdView(gd), dv = defaultView(); v.x = dv.x; v.y = dv.y; v.s = dv.s; } // leaving freeform recenters (30% zoom-out)
    sync();
  });
  wrap.querySelector('[data-t=circle]').addEventListener('click', function () { addItem({ type: 'circle', cx: 500, cy: 300, r: 200 }); });
  wrap.querySelector('[data-t=dline]').addEventListener('click', function () { addItem({ type: 'dline', cx: 500, cy: 300, angle: 45 }); });
  wrap.querySelector('[data-t=grid]').addEventListener('click', function () {
    gdPush(gd);
    if (!gd.gridOn) { gd.gridOn = true; gd.gridMul = 1; }        // off -> x1
    else if ((gd.gridMul || 1) === 1) { gd.gridMul = 2; }        // x1  -> x2 (red)
    else { gd.gridOn = false; gd.gridMul = 1; }                  // x2  -> off
    gd.selGrid = gd.gridOn; gd.selSet = [];
    sync();
  });
  // toggling symmetry also (re)stamps every currently SELECTED item, so
  // existing elements join/leave the mirror — new items keep following the mode
  function toggleSym(axis) {
    gd[axis] = !gd[axis];
    if (gd.selSet.length) {
      gdPush(gd);
      gd.selSet.forEach(function (i) { var it = gd.items[i]; if (it) it[axis] = gd[axis]; });
    }
    sync();
  }
  wrap.querySelector('[data-a=symY]').addEventListener('click', function () { toggleSym('symY'); });
  wrap.querySelector('[data-a=symX]').addEventListener('click', function () { toggleSym('symX'); });
  wrap.querySelector('[data-a=undo]').addEventListener('click', function () { if (!gd.undo.length) return; gd.redo.push(gdSnap(gd)); gdRestore(gd, gd.undo.pop()); gd.selSet = []; sync(); });
  wrap.querySelector('[data-a=redo]').addEventListener('click', function () { if (!gd.redo.length) return; gd.undo.push(gdSnap(gd)); gdRestore(gd, gd.redo.pop()); gd.selSet = []; sync(); });
  slider.addEventListener('input', function () { gdApplySlider(gd, +slider.value); gdRedraw(svg, gd); });
  slider.addEventListener('change', function () { gdPush(gd); notify(); });
  // grid presets — mathematically constructed compositions (replace the canvas)
  wrap.querySelector('.gd-presets').addEventListener('change', function () {
    var pr = gdPresetItems(this.value);
    if (!pr) return;
    gdPush(gd);
    gd.preset = this.value;
    gd.items = pr.items.map(function (it) { it.symX = !!it.symX; it.symY = !!it.symY; return it; });
    gd.gridOn = !!pr.grid;
    gd.gridMul = pr.mul || 1;
    if (pr.cell) gd.gridCell = pr.cell;
    gd.selSet = []; gd.selGrid = false;
    sync();
  });
  // mouse wheel nudges the slider (size / angle / cell of the selection)
  var lastWheel = 0;
  wrap.addEventListener('wheel', function (ev) {
    if (gd._tool === 'free') {
      ev.preventDefault();
      var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      var pp = pt.matrixTransform(svg.getScreenCTM().inverse());
      var v = gdView(gd);
      var ns = Math.max(0.5, Math.min(5, v.s * (ev.deltaY > 0 ? 0.9 : 1.1)));
      v.x = pp.x - (pp.x - v.x) * (ns / v.s);
      v.y = pp.y - (pp.y - v.y) * (ns / v.s);
      v.s = ns;
      gdRedraw(svg, gd);
      return;
    }
    if (slider.disabled) return;
    ev.preventDefault();
    var now = Date.now();
    if (now - lastWheel > 400) gdPush(gd); // one undo step per wheel burst
    lastWheel = now;
    var v = Math.max(0, Math.min(100, (+slider.value) + (ev.deltaY > 0 ? -2 : 2)));
    slider.value = v;
    gdApplySlider(gd, v);
    gdRedraw(svg, gd);
  }, { passive: false });

  // ---- pointer interactions: move / marquee / ruler guides (Photoshop-like) ----
  function svgPoint(ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var p = pt.matrixTransform(svg.getScreenCTM().inverse());
    var v = gdView(gd);
    var px = (p.x - v.x) / v.s, py = (p.y - v.y) / v.s;
    return { fx: (px - GD_PX) / GD_SX, fy: 800 - (py - GD_PY) / GD_SY, sx: p.x, sy: p.y };
  }
  var drag = null;
  svg.addEventListener('mousedown', function (ev) {
    ev.preventDefault(); wrap.focus();
    var p = svgPoint(ev);
    if (gd._tool === 'free') {           // freeform: drag pans the page
      var v0 = gdView(gd);
      drag = { mode: 'pan', px: p.sx, py: p.sy, vx: v0.x, vy: v0.y };
      return;
    }
    var hd = ev.target.closest ? ev.target.closest('[data-h]') : null;
    if (hd && gd._shape) {               // transform handle: scale the shape
      var b0 = gdShapeBounds(gd._shape, 0, 0);
      drag = { mode: 'scaleShape', h: hd.getAttribute('data-h'), b: b0, orig: JSON.parse(JSON.stringify(gd._shape)) };
      return;
    }
    var sh = ev.target.closest ? ev.target.closest('[data-shape]') : null;
    if (sh) {                            // click selects (shows controls) + drags
      gd._shapeSel = true;
      drag = { mode: 'shape', sx: p.fx, sy: p.fy };
      gd._sdx = 0; gd._sdy = 0;
      gdRedraw(svg, gd);
      return;
    }
    gd._shapeSel = false;
    var t = ev.target.closest ? ev.target.closest('[data-i]') : null;
    if (t) {
      var i = +t.getAttribute('data-i');
      if (ev.ctrlKey || ev.metaKey) {
        // Ctrl+click: add to / remove from the multi-selection (no drag)
        var pos = gd.selSet.indexOf(i);
        if (pos >= 0) gd.selSet.splice(pos, 1); else gd.selSet.push(i);
        gd.selGrid = false;
        sync();
        return;
      }
      if (!gdSelected(gd, i)) { gd.selSet = [i]; gd.selGrid = false; }
      gdPush(gd);
      drag = { mode: 'move', sx: p.fx, sy: p.fy, orig: gd.selSet.map(function (k) { var o = gd.items[k]; return { i: k, cx: o.cx, cy: o.cy, x: o.x, y: o.y }; }) };
      sync();
    } else {
      gd.selSet = []; gd.selGrid = false;
      drag = { mode: 'marq' };
      gd._marq = { x1: p.fx, y1: p.fy, x2: p.fx, y2: p.fy };
      sync();
    }
  });
  // ruler bars (Photoshop-like): the guide is grabbed at the pointer the moment
  // you press, and follows the drag from there
  function startGuide(ev, type) {
    ev.preventDefault(); wrap.focus();
    var p = svgPoint(ev);
    var it = type === 'vline'
      ? { type: 'vline', x: Math.max(0, Math.min(1000, Math.round(p.fx))) }
      : { type: 'hline', y: Math.max(-200, Math.min(800, Math.round(p.fy))) };
    it.symX = gd.symX; it.symY = gd.symY;
    gdPush(gd); gd.items.push(it);
    gd.selSet = [gd.items.length - 1]; gd.selGrid = false;
    drag = { mode: 'guide', i: gd.items.length - 1 };
    sync();
  }
  wrap.querySelector('.gd-vbar').addEventListener('mousedown', function (ev) { startGuide(ev, 'vline'); });
  wrap.querySelector('.gd-hbar').addEventListener('mousedown', function (ev) { startGuide(ev, 'hline'); });
  function gdMove(ev) {
    if (!drag) return;
    var p = svgPoint(ev);
    if (drag.mode === 'pan') {
      var v1 = gdView(gd);
      v1.x = drag.vx + (p.sx - drag.px); v1.y = drag.vy + (p.sy - drag.py);
      gdRedraw(svg, gd);
      return;
    }
    if (drag.mode === 'shape') {
      gd._sdx = Math.round(p.fx - drag.sx); gd._sdy = Math.round(p.fy - drag.sy);
      gdRedraw(svg, gd);
      return;
    }
    if (drag.mode === 'scaleShape') {
      var b = drag.b, h = drag.h;
      var ax = h.indexOf('w') >= 0 ? b.maxX : (h.indexOf('e') >= 0 ? b.minX : (b.minX + b.maxX) / 2);
      var ay = h.indexOf('s') >= 0 ? b.maxY : (h.indexOf('n') >= 0 ? b.minY : (b.minY + b.maxY) / 2);
      var hx0 = h.indexOf('w') >= 0 ? b.minX : (h.indexOf('e') >= 0 ? b.maxX : null);
      var hy0 = h.indexOf('s') >= 0 ? b.minY : (h.indexOf('n') >= 0 ? b.maxY : null);
      var sx = hx0 != null ? (p.fx - ax) / (hx0 - ax) : null;
      var sy = hy0 != null ? (p.fy - ay) / (hy0 - ay) : null;
      function cl(v2) { return Math.max(0.05, v2); }
      var SX, SY;
      if (ev.shiftKey) {                  // SHIFT: free (each axis on its own)
        SX = sx != null ? cl(sx) : 1;
        SY = sy != null ? cl(sy) : 1;
      } else {                            // default: proportional
        var sP = sx != null && sy != null ? Math.max(Math.abs(sx), Math.abs(sy))
               : sx != null ? Math.abs(sx) : Math.abs(sy);
        SX = SY = cl(sP);
      }
      gd._shape = gdScaleContours(drag.orig, ax, ay, SX, SY);
      gdRedraw(svg, gd);
      return;
    }
    if (drag.mode === 'move') {
      var dx = p.fx - drag.sx, dy = p.fy - drag.sy;
      drag.orig.forEach(function (o) {
        var it = gd.items[o.i]; if (!it) return;
        if (o.cx != null) { it.cx = Math.max(0, Math.min(1000, Math.round(o.cx + dx))); it.cy = Math.max(-200, Math.min(800, Math.round(o.cy + dy))); }
        if (o.x != null) it.x = Math.max(0, Math.min(1000, Math.round(o.x + dx)));
        if (o.y != null) it.y = Math.max(-200, Math.min(800, Math.round(o.y + dy)));
      });
      gdRedraw(svg, gd);
    } else if (drag.mode === 'marq') {
      gd._marq.x2 = p.fx; gd._marq.y2 = p.fy;
      gdRedraw(svg, gd);
    } else if (drag.mode === 'guide') {
      var it = gd.items[drag.i]; if (!it) return;
      if (it.type === 'vline') it.x = Math.max(0, Math.min(1000, Math.round(p.fx)));
      else it.y = Math.max(-200, Math.min(800, Math.round(p.fy)));
      gdRedraw(svg, gd);
    }
  }
  function gdUp() {
    if (!drag) return;
    if (drag.mode === 'marq' && gd._marq) {
      var m = gd._marq, x1 = Math.min(m.x1, m.x2), x2 = Math.max(m.x1, m.x2), y1 = Math.min(m.y1, m.y2), y2 = Math.max(m.y1, m.y2);
      gd.selSet = [];
      gd.items.forEach(function (it, i) { if (gdInRect(it, x1, y1, x2, y2)) gd.selSet.push(i); });
      delete gd._marq;
    } else if (drag.mode === 'shape') {
      var ddx = gd._sdx || 0, ddy = gd._sdy || 0;
      gd._sdx = 0; gd._sdy = 0;
      if ((ddx || ddy) && typeof gd._onShapeMove === 'function') gd._onShapeMove(ddx, ddy);
    } else if (drag.mode === 'scaleShape') {
      if (typeof gd._onShapeScale === 'function') gd._onShapeScale(gd._shape);
    }
    drag = null; sync();
  }
  bindPaneWindow(gdMove, gdUp, gdResize);
  // Delete / Backspace removes the selection
  wrap.addEventListener('keydown', function (ev) {
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && gd.selSet.length) {
      ev.preventDefault();
      gdPush(gd);
      gd.items = gd.items.filter(function (_, i) { return !gdSelected(gd, i); });
      gd.selSet = [];
      sync();
    }
  });
  fit(); sync();
}
function selectedLangLabels() {
  return charsets.ALPHABETS.filter(function (it) { return draft.lang[it.key]; }).map(function (it) { return it.label; });
}
function gridSummary() {
  var gd = draft.gridDesign;
  var n = { circle: 0, dline: 0, hline: 0, vline: 0 };
  gd.items.forEach(function (it) { n[it.type]++; });
  var parts = [];
  if (n.circle) parts.push(n.circle + ' circle' + (n.circle > 1 ? 's' : ''));
  if (n.dline) parts.push(n.dline + ' line' + (n.dline > 1 ? 's' : ''));
  if (n.hline + n.vline) parts.push((n.hline + n.vline) + ' guide' + (n.hline + n.vline > 1 ? 's' : ''));
  if (gd.gridOn) parts.push((gd.gridMul || 1) === 2 ? 'grid \u00d72' : 'grid');
  if (gd.symX || gd.symY) parts.push('symmetry');
  return parts.length ? parts.join(', ') : 'blank';
}
function updatePillLabels() {
  var l = selectedLangLabels();
  $('tg-lang-lbl').textContent = l.length ? l.join(', ') : 'Language Support';
  $('tg-grid-lbl').textContent = 'Grid · ' + gridSummary();
}

// --- profile (responsive: values shrink to never push the actions) ---
function renderProfile() {
  var p = $('profile');
  var fam = ($('nf-family') && $('nf-family').value.trim()) || 'Untitled';
  var masters = draft.masters.map(function (m) { return m.name; }).join(', ');
  var langs = selectedLangLabels().join(', ') || '—';
  p.innerHTML =
    '<div class="p-h">FONT NAME</div><div class="p-v">' + fam + '</div>' +
    '<div class="p-h">MASTERS</div><div class="p-v">' + masters + '</div>' +
    '<div class="p-h">LANGUAGE SUPPORT</div><div class="p-v">' + langs + '</div>' +
    '<div class="p-h">GRID</div><div class="p-v">' + gridSummary() + '</div>';
  fitProfile();
}
function fitProfile() {
  var p = $('profile'); if (!p) return;
  var size = 12;
  p.style.setProperty('--pv', size + 'px');
  while (p.scrollHeight > p.clientHeight && size > 7) { size -= 0.5; p.style.setProperty('--pv', size + 'px'); }
}

// --- Open / Import: load a .runetype project OR an existing .otf/.ttf font INTO
// the panel for editing. The panel READS the file itself (Node fs) — it never
// hands .runetype to the OS/Illustrator (which only shows raw bytes). ---
function pickPath(title, filter) {
  var js = '(function(){var f=File.openDialog(' + JSON.stringify(title) + ',' + JSON.stringify(filter) + ');return f?f.fsName:"";})()';
  return evalScript(js);
}
function baseNameNoExt(p) { var b = String(p || '').replace(/\\/g, '/').split('/').pop(); return b.replace(/\.[^.]+$/, '') || 'Untitled'; }
function openFromPath(path) {
  if (!path) return;
  var low = path.toLowerCase();
  try {
    if (/\.(runetype|json)$/.test(low)) {
      loadProject(JSON.parse(fs.readFileSync(path, 'utf8')), path);
    } else if (/\.(otf|ttf)$/.test(low)) {
      if (!FEAT.fontImport) { setStatus('Importing an existing .otf/.ttf to edit is a Pro feature. Open a .runetype project instead.', 'err'); return; }
      var ot = getOpentype();
      if (!ot) { setStatus('Font engine unavailable.', 'err'); return; }
      var buf = fs.readFileSync(path);
      var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      loadProject(projectFromOpentype(ot.parse(ab), baseNameNoExt(path)), path);
    } else {
      setStatus('Open a .runetype project or an .otf/.ttf font — not .' + low.split('.').pop() + '.', 'err');
    }
  } catch (e) { setStatus('Could not open that file: ' + e.message, 'err'); }
}
function loadProject(proj, path) {
  if (!proj || !proj.glyphs || !proj.glyphs.length || !proj.masters || !proj.masters.length) {
    setStatus('That file is not a valid RuneType project.', 'err'); return;
  }
  proj.kerning = proj.kerning || {};
  proj.meta = proj.meta || { familyName: baseNameNoExt(path), version: '1.000' };
  fonts.push(proj); activeFont = fonts.length - 1;
  selectedSlot = -1; openGlyphIndex = -1; searchQuery = ''; alphaFilters = [];
  activeMaster = 0; lastSig = {}; flatCache = {}; kernCache = {};
  show('work'); renderWorkspace();
  setStatus('Opened "' + (proj.meta.familyName || 'project') + '" — ' + proj.glyphs.filter(isFilled).length + ' drawn glyph(s).', 'ok');
}
// Convert one opentype.js glyph's path (font units, y-UP) to our contour model.
// Quadratics (TTF) are raised to cubics; the trailing point that duplicates the
// contour start (on Z) is merged back so the closing curve keeps its handle.
function contoursFromOTGlyph(g) {
  var cmds = (g.path && g.path.commands) || [];
  var contours = [], cur = null;
  function P(x, y) { return { x: x, y: y, type: 'corner', handleIn: null, handleOut: null }; }
  for (var i = 0; i < cmds.length; i++) {
    var c = cmds[i];
    if (c.type === 'M') { cur = { closed: false, points: [P(c.x, c.y)] }; contours.push(cur); }
    else if (!cur) continue;
    else if (c.type === 'L') { cur.points.push(P(c.x, c.y)); }
    else if (c.type === 'C') {
      var pv = cur.points[cur.points.length - 1]; pv.handleOut = { x: c.x1, y: c.y1 };
      var np = P(c.x, c.y); np.handleIn = { x: c.x2, y: c.y2 }; cur.points.push(np);
    } else if (c.type === 'Q') {
      var pq = cur.points[cur.points.length - 1];
      pq.handleOut = { x: pq.x + 2 / 3 * (c.x1 - pq.x), y: pq.y + 2 / 3 * (c.y1 - pq.y) };
      var nq = P(c.x, c.y); nq.handleIn = { x: c.x + 2 / 3 * (c.x1 - c.x), y: c.y + 2 / 3 * (c.y1 - c.y) }; cur.points.push(nq);
    } else if (c.type === 'Z' && cur) {
      cur.closed = true;
      var lp = cur.points[cur.points.length - 1], fp = cur.points[0];
      if (cur.points.length > 1 && Math.abs(lp.x - fp.x) < 0.01 && Math.abs(lp.y - fp.y) < 0.01) { fp.handleIn = lp.handleIn; cur.points.pop(); }
      cur = null;
    }
  }
  contours.forEach(function (ct) { ct.points.forEach(function (p) { if (p.handleIn && p.handleOut) p.type = 'smooth'; }); });
  return contours.filter(function (ct) { return ct.points.length >= 2; });
}
// Build an editable project from a parsed font. Outlines are scaled to the
// panel's 1000-UPM world; glyphs map onto the standard Latin slots (extras append).
function projectFromOpentype(font, fam) {
  var upm = font.unitsPerEm || 1000, sc = 1000 / upm;
  var proj = glyphset.createProject({ familyName: fam || 'Imported', masterName: 'Regular', masterType: 'Regular', alphabets: ['latinUpper', 'latinLower', 'numbers'] });
  var mid = proj.masters[0].id, os2 = (font.tables && font.tables.os2) || {};
  proj.unitsPerEm = 1000; proj.metrics = proj.metrics || {}; proj.metrics.unitsPerEm = 1000;
  if (font.ascender != null) proj.metrics.ascender = Math.round(font.ascender * sc);
  if (font.descender != null) proj.metrics.descender = Math.round(font.descender * sc);
  if (os2.sCapHeight) proj.metrics.capHeight = Math.round(os2.sCapHeight * sc);
  if (os2.sxHeight) proj.metrics.xHeight = Math.round(os2.sxHeight * sc);
  proj.metrics.baseline = 0;
  var byChar = {}; proj.glyphs.forEach(function (g) { if (g.char != null) byChar[g.char] = g; });
  var nG = font.glyphs.length;
  for (var i = 0; i < nG; i++) {
    var og; try { og = font.glyphs.get(i); } catch (e) { continue; }
    if (!og || og.unicode == null) continue;
    var ch; try { ch = String.fromCodePoint(og.unicode); } catch (e) { continue; }
    var contours = transformContours(contoursFromOTGlyph(og), sc, 0, 0);
    if (!contours.length) continue;
    var adv = Math.round((og.advanceWidth || upm * 0.5) * sc);
    var slot = byChar[ch];
    if (slot) { slot.layers[mid] = { contours: contours }; slot.advanceWidth = adv; }
    else {
      var ng = { name: og.name || ('uni' + og.unicode.toString(16).toUpperCase()), char: ch, unicode: og.unicode, advanceWidth: adv, alphabet: 'latinExtended', layers: {} };
      ng.layers[mid] = { contours: contours }; proj.glyphs.push(ng);
    }
  }
  proj.meta = proj.meta || {}; proj.meta.familyName = fam || ((font.names && font.names.fontFamily && font.names.fontFamily.en) || 'Imported');
  return proj;
}
function onImport() {
  // alpha: only .runetype reopen — opening an existing font to edit is Pro
  if (FEAT.fontImport) pickPath('Open a RuneType project or font to edit', 'Projects & Fonts:*.runetype;*.otf;*.ttf').then(openFromPath);
  else pickPath('Open a RuneType project to edit', 'RuneType Projects:*.runetype').then(openFromPath);
}

// --- Fontself-style template: an Illustrator sheet with a locked box + grid +
// ghost per glyph for the SELECTED character sets. Draw each letter in its box,
// then import all boxes at once — each box's artwork maps to its glyph at the
// drawn size/position (imported exactly as drawn, never re-scaled).
function templateAlphabets() {
  var sel = draft && draft.lang ? Object.keys(draft.lang).filter(function (k) { return draft.lang[k]; }) : [];
  return sel.length ? sel : (FEAT.charsets || ['latinUpper', 'latinLower', 'numbers']);
}
function onOpenTemplate() {
  if (!FEAT.template) return;
  var fam = $('nf-family').value.trim() || 'RuneType';
  var alphabets = templateAlphabets();   // selected set keys, in selection order
  var proj = glyphset.createProject({ familyName: fam, masterName: 'Regular', masterType: 'Regular', alphabets: alphabets });
  // ONE BLOCK PER SELECTED SET (in selection order), each captioned with its set
  // name. The jsx wraps a set past 50 glyphs onto extra rows but always starts a new
  // set on a fresh row; the sheet grows downward as more alphabets are added.
  function setLabel(key) {
    var a = (charsets.ALPHABETS || []).filter(function (it) { return it.key === key; })[0];
    return a && a.label ? a.label : key;
  }
  var sets = [];
  alphabets.forEach(function (key) {
    var chs = [];
    proj.glyphs.forEach(function (g) { if (g.alphabet === key && g.char != null && g.char !== ' ') chs.push(g.char); });
    if (chs.length) sets.push({ name: setLabel(key), chars: chs });
  });
  if (!sets.length) { var all = []; proj.glyphs.forEach(function (g) { if (g.char != null && g.char !== ' ') all.push(g.char); }); if (all.length) sets.push({ name: '', chars: all }); }
  var cfg = { sets: sets, metrics: proj.metrics, unitsPerEm: proj.unitsPerEm, grids: [{ kind: 'metrics' }, { kind: 'sidebearings' }], ybounds: arialGhostBounds(proj) || {} };
  setStatus('Opening template in Illustrator…');
  evalScript('fmOpenTemplate(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Template opened (' + r.cells + ' glyphs, ' + sets.length + ' set' + (sets.length === 1 ? '' : 's') + ') — draw each letter inside its box, then "Import from Template".', 'ok');
    else setStatus('Could not open template: ' + ((r && r.error) || '?'), 'err');
  });
}
function onImportTemplate() {
  if (!FEAT.template) return;
  setStatus('Reading template…');
  evalScript('fmReadTemplate()').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!r || !r.ok) { setStatus('Could not read template: ' + ((r && r.error) || 'open a template first'), 'err'); return; }
    if (!r.cells || !r.cells.length) { setStatus('No drawn letters found in the template boxes.', 'err'); return; }
    var fam = $('nf-family').value.trim() || 'RuneType Sans';
    var proj = glyphset.createProject({ familyName: fam, masterName: 'Regular', masterType: 'Regular', alphabets: templateAlphabets() });
    var mid = proj.masters[0].id, desc = proj.metrics.descender, placed = 0;
    var byChar = {}; proj.glyphs.forEach(function (g, i) { if (g.char != null) byChar[g.char] = i; });
    r.cells.forEach(function (cell) {
      var ch = String.fromCharCode(cell.code), idx = byChar[ch];
      if (idx == null) return;
      var contours = ilbridge.contoursFromArtboard(cell.paths, cell.rect, r.scale, desc);
      if (!contours.length) return;
      // RAW BOX: advance = the TEMPLATE CELL width, glyph kept where it was drawn inside the box — NO
      // auto sidebearing. So every imported letter starts at its box size (I and W both box-wide); the
      // AI does all narrowing/optical work later when you press Optimize. (Was: ink.maxX + 60 auto-fit.)
      var boxW = (cell.rect[2] - cell.rect[0]) / r.scale;
      glyphset.setGlyphContours(proj, idx, mid, contours, boxW);
      placed++;
    });
    if (!placed) { setStatus('No letters could be imported — draw inside the boxes first.', 'err'); return; }
    fonts.push(proj); activeFont = fonts.length - 1;
    selectedSlot = -1; openGlyphIndex = -1; searchQuery = ''; alphaFilters = []; activeMaster = 0; lastSig = {}; flatCache = {}; kernCache = {};
    show('work'); renderWorkspace();
    setStatus('Imported ' + placed + ' letter(s) from the template.', 'ok');
  });
}

// ---- Open Template (workspace) — the CURRENT font as an editable Illustrator
// sheet: every glyph in a box, each pre-filled with its current drawing (not a
// blank sheet). Edit in Illustrator, then re-import. ----------------------------
function onOpenCurrentTemplate() {
  if (!FEAT.template) return;
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  var mid = curMasterId(), em = f.unitsPerEm || 1000;
  function setLabel(key) {
    var a = (charsets.ALPHABETS || []).filter(function (it) { return it.key === key; })[0];
    if (a && a.label) return a.label;
    return key === 'alternate' ? 'Alternates' : key === 'ligature' ? 'Ligatures' : key === 'composed' ? 'Accented' : (key || 'Glyphs');
  }
  // group glyphs by source set (caption), keeping first-seen order
  var order = [], byKey = {}, art = {};
  f.glyphs.forEach(function (g) {
    if (g.char === ' ') return;                               // skip the space
    var key = g.alphabet || g.kind || 'glyphs';
    if (!byKey[key]) { byKey[key] = []; order.push(key); }
    var ghost = g.ghost || (g.char != null ? g.char : (g.components ? g.components.join('') : g.name));
    var ly = g.layers && g.layers[mid];
    var hasArt = !!(ly && ly.contours && ly.contours.length);
    // box WIDTH = the glyph's ADVANCE so a symmetric-spaced glyph sits CENTRED in its
    // box (the box is its spacing slot). Fall back to the ink width when there's no
    // advance yet; ligatures get at least their component count.
    var w = 1;
    if (g.advanceWidth > 0) w = Math.max(1, g.advanceWidth / em);
    else if (hasArt) { var b = glyphset.contoursBounds(ly.contours); if (b) w = Math.max(1, (Math.max(b.maxX, 0) - Math.min(b.minX, 0)) / em); }
    if (g.kind === 'ligature') w = Math.max(w, 1.6, Math.min(3, (g.components || []).length || 2));
    w = Math.min(w, 3.5);
    byKey[key].push({ ghost: ghost, id: g.name, w: w });
    if (hasArt) art[g.name] = ly.contours;                    // pre-fill the box with the drawing
  });
  var sets = order.map(function (key) { return { name: setLabel(key), chars: byKey[key] }; })
    .filter(function (s) { return s.chars.length; });
  if (!sets.length) { setStatus('No glyphs to template yet.', 'err'); return; }
  var cfg = { sets: sets, art: art, metrics: f.metrics, unitsPerEm: f.unitsPerEm,
    grids: [{ kind: 'metrics' }, { kind: 'sidebearings' }], ybounds: arialGhostBounds(f) || {} };
  var nArt = Object.keys(art).length;
  setStatus('Opening the current font as a template…');
  // PERF: the whole font's contours can be multiple MB. Don't marshal that across the
  // evalScript boundary as one giant string — write it to a temp file and pass the path.
  var tmpPath = null;
  try {
    var tdir = cs.getSystemPath(SystemPath.USER_DATA) + '/RuneType';
    if (!fs.existsSync(tdir)) fs.mkdirSync(tdir);
    tmpPath = tdir + '/_template.json';
    fs.writeFileSync(tmpPath, JSON.stringify(cfg));
  } catch (e) { tmpPath = null; }
  var call = tmpPath ? ('fmOpenTemplateFile(' + JSON.stringify(tmpPath) + ')')
                     : ('fmOpenTemplate(' + JSON.stringify(JSON.stringify(cfg)) + ')');
  evalScript(call).then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Template opened — ' + r.cells + ' glyph box(es), ' + nArt + ' pre-filled with your drawing. Edit in Illustrator, then Import.', 'ok');
    else setStatus('Could not open template: ' + ((r && r.error) || '?'), 'err');
  });
}
// Read an Open-Template sheet back into the CURRENT font — every box matched to its
// glyph by NAME, contours mapped at the template scale. The whole font round-trips.
function onImportCurrentTemplate() {
  if (!FEAT.template) return;
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  setStatus('Reading template…');
  evalScript('fmReadTemplate()').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!r || !r.ok) { setStatus('Could not read template: ' + ((r && r.error) || 'open a template first'), 'err'); return; }
    if (!r.cells || !r.cells.length) { setStatus('No drawn glyphs found in the boxes.', 'err'); return; }
    var mid = curMasterId(), desc = f.metrics.descender, placed = 0;
    var byName = {}; f.glyphs.forEach(function (g, i) { byName[g.name] = i; });
    r.cells.forEach(function (cell) {
      var idx = byName[cell.id]; if (idx == null) return;            // match boxes back to glyphs by NAME
      var contours = ilbridge.contoursFromArtboard(cell.paths, cell.rect, r.scale, desc);
      if (!contours.length) return;
      // A round-trip re-import must NOT reset spacing: this template pre-fills EVERY glyph's
      // box with its current art, so every box reads back — resetting each advance to the
      // auto ink-fit (maxX+60) wiped raw-box advances and AI-baked spacing on untouched
      // glyphs. A glyph that already had art keeps its advance (the template's CLAMPED box
      // width is not the advance either); only a previously empty slot gets the auto fit.
      var g = f.glyphs[idx];
      var hadArt = !!(g.layers && g.layers[mid] && g.layers[mid].contours && g.layers[mid].contours.length);
      glyphset.setGlyphContours(f, idx, mid, contours, hadArt ? (g.advanceWidth || null) : null);
      placed++;
    });
    if (!placed) { setStatus('No glyphs imported — draw inside the boxes first.', 'err'); return; }
    lastSig = {}; flatCache = {};
    renderGrid(); updateAssign(); renderRight(); scheduleTester(); autosave();
    setStatus('Imported ' + placed + ' glyph(s) from the template into the font.', 'ok');
  });
}

// ---- Alternates & Ligatures template (workspace) ---------------------------
// Open a template (same cell HEIGHT as the main one) with a box for every alternate
// and ligature in the CURRENT font, ghosted with the base letter / joined letters.
// Boxes are keyed by glyph NAME (alternates/ligatures have no char), and ligatures
// get wider boxes so they fit and aren't clipped on import.
function onOpenAltLigTemplate() {
  if (!FEAT.alternates) return;
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  var alts = [], ligs = [];
  f.glyphs.forEach(function (g) {
    if (g.kind === 'alternate') alts.push({ ghost: g.ghost || '', id: g.name, w: 1 });
    else if (g.kind === 'ligature') ligs.push({ ghost: g.ghost || (g.components || []).join(''), id: g.name, w: Math.max(1.6, Math.min(3, (g.components || []).length || 2)) });
  });
  if (!alts.length && !ligs.length) { setStatus('No alternates or ligatures yet — add them with + Alternate / + Ligature first.', 'err'); return; }
  var sets = [];
  if (alts.length) sets.push({ name: 'Alternates', chars: alts });
  if (ligs.length) sets.push({ name: 'Ligatures', chars: ligs });
  var cfg = { sets: sets, metrics: f.metrics, unitsPerEm: f.unitsPerEm, grids: [{ kind: 'metrics' }, { kind: 'sidebearings' }], ybounds: {} };
  setStatus('Opening alternates/ligatures template in Illustrator…');
  evalScript('fmOpenTemplate(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Template opened (' + r.cells + ' glyph' + (r.cells === 1 ? '' : 's') + ') — draw each inside its box, then "Import Alt/Lig".', 'ok');
    else setStatus('Could not open template: ' + ((r && r.error) || '?'), 'err');
  });
}
function onImportAltLigTemplate() {
  if (!FEAT.alternates) return;
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  setStatus('Reading template…');
  evalScript('fmReadTemplate()').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!r || !r.ok) { setStatus('Could not read template: ' + ((r && r.error) || 'open a template first'), 'err'); return; }
    if (!r.cells || !r.cells.length) { setStatus('No drawn glyphs found in the boxes.', 'err'); return; }
    var mid = curMasterId(), desc = f.metrics.descender, placed = 0;
    var byName = {}; f.glyphs.forEach(function (g, i) { byName[g.name] = i; });
    r.cells.forEach(function (cell) {
      var idx = byName[cell.id]; if (idx == null) return;   // match boxes back to glyphs by NAME
      var contours = ilbridge.contoursFromArtboard(cell.paths, cell.rect, r.scale, desc);
      if (!contours.length) return;
      glyphset.setGlyphContours(f, idx, mid, contours, null); // auto advance from the drawn ink
      placed++;
    });
    if (!placed) { setStatus('No glyphs imported — draw inside the boxes first.', 'err'); return; }
    lastSig = {}; flatCache = {};
    renderGrid(); updateAssign(); renderRight(); scheduleTester(); autosave();
    setStatus('Imported ' + placed + ' alternate/ligature glyph(s) from the template.', 'ok');
  });
}

// --- Build the font from the page-1 draft, then enter the workspace. Shared by
// Start Creating and the page-1 Image Import (which then opens the picker). ---
function createFontFromDraft() {
  var alphabets = Object.keys(draft.lang).filter(function (k) { return draft.lang[k]; });
  if (!alphabets.length) { setToggle('lang'); return false; }
  var m0 = draft.masters[0];
  var opts = {
    familyName: ($('nf-family').value.trim() || 'Untitled'),
    masterName: m0.name, masterType: m0.name, alphabets: alphabets,
    // "Only Uppercase" (Basic) restricts the whole project to caps.
    upperOnly: !!($('onlyUpper') && $('onlyUpper').checked),
  };
  var gd = draft.gridDesign;
  opts.gridDesign = { items: gd.items, gridOn: gd.gridOn, gridCell: gd.gridCell, gridMul: gd.gridMul || 1, symX: gd.symX, symY: gd.symY };
  var project = glyphset.createProject(opts);
  for (var i = 1; i < draft.masters.length; i++) glyphset.addMaster(project, draft.masters[i].name, draft.masters[i].name);
  fonts.push(project); activeFont = fonts.length - 1; selectedSlot = -1; lastSig = {};
  openGlyphIndex = -1; searchQuery = ''; alphaFilters = []; activeMaster = 0;
  draft = null;
  // No document is created here — the plugin just shows the glyphs. A per-glyph
  // artboard opens only when you click a letter (openGlyph).
  show('work'); renderWorkspace();
  return true;
}
function onStartCreating() { createFontFromDraft(); }

// Page-1 Image Import: create the font from the chosen sets, enter the
// workspace, then immediately open the image picker (the rest of the flow —
// trace, review dialog, fill — is the shared onImgFiles/onImgFill path).
function onImgImportPage1() {
  if (!createFontFromDraft()) return;
  onImgImportClick();
}

// ============ PAGE 2 — Workspace ============
var FM_SCALE_PANEL = 0.25; // must match jsx FM_SCALE
function curFont() { return fonts[activeFont]; }
function curMasterId() { return curFont().masters[activeMaster].id; }
function isFilled(g) { var l = g.layers[curMasterId()]; return !!(l && l.contours && l.contours.length); }
// master-explicit twin — isFilled is passed as a callback (some/filter) so it can't take a
// second positional arg (the array index would leak in as `mid`).
function isFilledIn(g, mid) { var l = g.layers[mid]; return !!(l && l.contours && l.contours.length); }
var _toastTimer = null;
function setStatus(m, k) {
  var el = $('status'); if (!el) return;
  el.textContent = m; el.className = 'w-toast show' + (k ? ' ' + k : '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
}
function selGlyph() { return selectedSlot >= 0 ? curFont().glyphs[selectedSlot] : null; }
function glyphLabel(g) { return g.char == null ? g.name : (g.char === ' ' ? '␣' : g.char); }
function escHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Cell label as HTML: alternates show the base with a tiny superscript index
// (A⁰¹, not A.ss01); ligatures show the joined letters (ft, not f_t).
function glyphLabelHtml(g) {
  if (g.kind === 'alternate') {
    var m = (g.name || '').match(/\.ss(\d+)$/);
    return escHtml(g.baseName || g.ghost || '?') + (m ? '<sup class="gl-ss">' + m[1] + '</sup>' : '');
  }
  if (g.kind === 'ligature') return escHtml((g.components || []).join('') || g.ghost || '');
  return escHtml(glyphLabel(g));
}

// ---- top bar: SECTION tabs (glyphs/mod/test/save) + master picker ----
function renderMasterSelect() {
  var sel = $('w-masterSel'); sel.innerHTML = '';
  curFont().masters.forEach(function (m, i) {
    var o = document.createElement('option');
    o.value = i; o.textContent = m.name;
    sel.appendChild(o);
  });
  sel.value = activeMaster;
}
// ---- Basic / Advanced mode (default Basic; toggle sits right of "settings.") ----
var appMode = 'basic';
try { var _sm = window.localStorage && localStorage.getItem('rt-appmode'); if (_sm === 'advanced' || _sm === 'basic') appMode = _sm; } catch (e) {}
function setMode(mode) {
  appMode = (mode === 'advanced') ? 'advanced' : 'basic';
  try { if (window.localStorage) localStorage.setItem('rt-appmode', appMode); } catch (e) {}
  applyMode();
}
function applyMode() {
  var basic = appMode === 'basic';
  document.body.classList.toggle('basic-mode', basic);   // CSS hides .adv-only in Basic
  if ($('modeBasic')) $('modeBasic').classList.toggle('active', basic);
  if ($('modeAdv')) $('modeAdv').classList.toggle('active', !basic);
  // PAGE 1 — Basic keeps the Language Support picker (now a list of languages the
  // country dropdown adds) but drops the Grid/Style preset; Only-Uppercase shows beside it.
  if ($('tg-lang')) $('tg-lang').style.display = '';            // Language Support always visible
  if ($('tg-grid')) $('tg-grid').style.display = basic ? 'none' : '';
  if ($('onlyUpperWrap')) $('onlyUpperWrap').classList.toggle('hidden', !basic);
  if (basic && draft) { draft.toggle = 'lang'; if (draft.langSel) deriveLangSets(); }
  if (draft && typeof setToggle === 'function' && $('tg-lang')) setToggle(draft.toggle);
  // PAGE 2 — accents/alternates are an advanced feature.
  if ($('accentTplBtn')) $('accentTplBtn').disabled = basic;
  if ($('accentImportBtn')) $('accentImportBtn').disabled = basic;
}

function setSection(sec) {
  activeSection = sec;
  $('sec-glyphs').classList.toggle('hidden', sec !== 'glyphs');
  $('sec-mod').classList.toggle('hidden', sec !== 'mod');
  $('sec-test').classList.toggle('hidden', sec !== 'test');
  $('sec-save').classList.toggle('hidden', sec !== 'save');
  // the right pane (designer / metrics) shows everywhere except the full-width
  // save + accent pages; testing. keeps the metrics editor on the right
  $('w-rightPane').classList.toggle('hidden', sec === 'save');
  var tabs = document.querySelectorAll('#w-tabsec .w-stab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-sec') === sec);
  if (sec === 'mod') renderModGrid();
  if (sec === 'test') refreshTester();
  if (sec === 'save') buildSigFields();
  if (sec !== 'save') renderRight();
}
// the right pane follows the section: construction designer or metrics editor
function renderRight() {
  // glyphs. -> construction designer; modification. AND testing. -> the
  // metrics & spacing editor (tune the gaps while you type)
  if (activeSection === 'mod' || activeSection === 'test') renderMetricsEditor();
  else renderWorkDesigner();
}

// ---- per-glyph construction grid (clones the font standard on first edit) ----
function fontGD() {
  var f = curFont();
  if (!f.gridDesign) f.gridDesign = { items: [], gridOn: true, gridCell: 50, gridMul: 1, symX: false, symY: false };
  var gd = f.gridDesign;
  if (!gd.undo) { gd.undo = []; gd.redo = []; gd.selSet = []; gd.sel = -1; gd.selGrid = false; }
  return gd;
}
function glyphGD(g) {
  if (!g.gridDesign) {
    var std = fontGD();
    g.gridDesign = JSON.parse(JSON.stringify({ items: std.items, gridOn: std.gridOn, gridCell: std.gridCell, gridMul: std.gridMul || 1, symX: std.symX, symY: std.symY }));
  }
  var gd = g.gridDesign;
  if (!gd.undo) { gd.undo = []; gd.redo = []; gd.selSet = []; gd.sel = -1; gd.selGrid = false; }
  return gd;
}

// ---- the right-hand designer: selected glyph's grid + its live shape ----
function renderWorkDesigner() {
  var box = $('w-designer'); if (!box) return;
  box.innerHTML = '';
  var g = selGlyph();
  var gd = g ? glyphGD(g) : fontGD();
  if (g) {
    var l = g.layers[curMasterId()];
    gd._shape = (l && l.contours && l.contours.length) ? l.contours : null;
    gd._onShapeMove = function (dx, dy) { shiftGlyphShape(g, dx, dy); };
    gd._onShapeScale = function (contours) { applyShapeContours(g, contours); };
  } else { gd._shape = null; gd._onShapeMove = null; gd._onShapeScale = null; gd._shapeSel = false; }
  renderGridDesigner(box, gd, function () { autosave(); });
}
// Dragging the shape on the canvas moves the real outline — and the artwork in
// the glyph's Illustrator project moves with it.
function shiftGlyphShape(g, dx, dy) {
  var l = g.layers[curMasterId()];
  if (!l || !l.contours || !l.contours.length) return;
  l.contours.forEach(function (c) {
    c.points.forEach(function (pt) {
      pt.x += dx; pt.y += dy;
      if (pt.handleIn) { pt.handleIn.x += dx; pt.handleIn.y += dy; }
      if (pt.handleOut) { pt.handleOut.x += dx; pt.handleOut.y += dy; }
    });
  });
  lastSig[selectedSlot] = glyphset.layerSignature(g, curMasterId());
  evalScript('fmShiftArt(' + JSON.stringify(JSON.stringify({ name: g.name, dx: dx * FM_SCALE_PANEL, dy: dy * FM_SCALE_PANEL })) + ')');
  renderGrid(); scheduleTester(); autosave(); renderRight();
  setStatus('Shape moved ' + dx + ', ' + dy + ' — synced to Illustrator.', 'ok');
}
// Commit a transformed outline (scaling) — the Illustrator artwork is redrawn
// from the same contours so both stay identical.
function applyShapeContours(g, contours) {
  glyphset.setGlyphContours(curFont(), selectedSlot, curMasterId(), contours, g.advanceWidth);
  lastSig[selectedSlot] = glyphset.layerSignature(g, curMasterId());
  evalScript('fmSetArt(' + JSON.stringify(JSON.stringify({ name: g.name, contours: contours, metrics: curFont().metrics })) + ')');
  renderGrid(); scheduleTester(); autosave(); renderRight();
  setStatus('Shape transformed — synced to Illustrator.', 'ok');
}

// Build an SVG path (screen coords, Y-down) from a glyph's contours.
function contoursToSVG(contours) {
  var d = '';
  contours.forEach(function (c) {
    var p = c.points; if (!p.length) return;
    d += 'M' + p[0].x + ' ' + (-p[0].y);
    var segs = c.closed ? p.length : p.length - 1;
    for (var i = 0; i < segs; i++) {
      var a = p[i], b = p[(i + 1) % p.length];
      var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasO || hasI) {
        var c1 = a.handleOut || a, c2 = b.handleIn || b;
        d += 'C' + c1.x + ' ' + (-c1.y) + ' ' + c2.x + ' ' + (-c2.y) + ' ' + b.x + ' ' + (-b.y);
      } else d += 'L' + b.x + ' ' + (-b.y);
    }
    if (c.closed) d += 'Z';
  });
  return d;
}
function glyphThumb(g) {
  var l = g.layers[curMasterId()];
  if (!l || !l.contours) return null;
  var contours = l.contours;
  var b = glyphset.contoursBounds(contours); if (!b) return null;
  // FIXED reference box = the font's em (ascender..descender), centred horizontally
  // on the glyph's ink. Every glyph is drawn at its TRUE relative size, so a '.' is a
  // small dot near the baseline and an 'H' fills the cap height — instead of each
  // shape being blown up to fill the cell.
  var M = (curFont() && curFont().metrics) || {};
  var asc = (M.ascender != null ? M.ascender : 800), desc = (M.descender != null ? M.descender : -200);
  var side = (asc - desc) || 1000;
  var cx = (b.minX + b.maxX) / 2;
  // if the ink is wider/taller than the em, grow the box so it still fits (rare)
  var halfW = Math.max(side / 2, (b.w / 2) + side * 0.06);
  var top = Math.min(-asc, -b.maxY - side * 0.06), bot = Math.max(-desc, -b.minY + side * 0.06);
  var vb = (cx - halfW) + ' ' + top + ' ' + (halfW * 2) + ' ' + (bot - top);
  return '<svg class="thumb" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
         '<path d="' + contoursToSVG(contours) + '" fill="#eaeaee"/></svg>';
}

function glyphVisible(g) {
  if (alphaFilters.length && alphaFilters.indexOf(g.alphabet) < 0) return false;
  return glyphset.glyphMatches(g, searchQuery);
}
// Display order for the grids: keep the array order (indices map to artboards),
// but show each glyph's alternates right AFTER it (A, A.ss01, A.ss02, B…) instead
// of all appended at the very end. Returns array indices (real, unchanged).
function glyphDisplayOrder(f) {
  var altsByBase = {};
  f.glyphs.forEach(function (g, i) { if (g.kind === 'alternate' && g.baseName) (altsByBase[g.baseName] = altsByBase[g.baseName] || []).push(i); });
  var order = [], seen = {};
  f.glyphs.forEach(function (g, i) {
    if (g.kind === 'alternate' && g.baseName) return;        // placed right after its base
    order.push(i); seen[i] = 1;
    (altsByBase[g.name] || []).forEach(function (ai) { order.push(ai); seen[ai] = 1; });
  });
  f.glyphs.forEach(function (g, i) { if (!seen[i]) order.push(i); }); // orphan alternates → append
  return order;
}

// PERF: the glyph grid is the hottest DOM surface. It is rebuilt only on a real
// structural change (filter/search/master/font); the live poll and selection
// clicks update a SINGLE cell via refreshGlyphCell / selectGlyph instead. Handlers
// are delegated ONCE to #grid (not 6 closures per cell), and a DocumentFragment
// batches the layout into one reflow. cellByIndex maps glyph index -> its cell.
var cellByIndex = {};
function glyphCellClass(g, i) {
  var c = 'cell' + (isFilled(g) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '');
  if (g.char == null) c += ' named';
  if (g.kind === 'alternate' || g.kind === 'ligature' || g.kind === 'composed') c += ' altcell';
  return c;
}
function glyphCellHTML(g) {
  return isFilled(g) ? ((glyphThumb(g) || '') + '<span class="lab">' + glyphLabelHtml(g) + '</span>')
                     : glyphLabelHtml(g);
}
function gridCellOf(ev) { var c = ev.target && ev.target.closest ? ev.target.closest('.cell') : null; return c; }
function gridIdxOf(ev) { var c = gridCellOf(ev); return c ? parseInt(c.getAttribute('data-i'), 10) : -1; }
function wireGridDelegation(grid) {
  grid.addEventListener('click', function (ev) { var i = gridIdxOf(ev); if (i >= 0) selectGlyph(i); });
  grid.addEventListener('dblclick', function (ev) { var i = gridIdxOf(ev); if (i < 0) return; ev.preventDefault(); selectGlyph(i); onAssign(); });
  grid.addEventListener('contextmenu', function (ev) { var i = gridIdxOf(ev); if (i >= 0) showGlyphMenu(ev, i); });
  grid.addEventListener('dragover', function (ev) { var c = gridCellOf(ev); if (!c) return; ev.preventDefault(); c.classList.add('drop'); ev.dataTransfer.dropEffect = 'copy'; });
  grid.addEventListener('dragleave', function (ev) { var c = gridCellOf(ev); if (c) c.classList.remove('drop'); });
  grid.addEventListener('drop', function (ev) { var c = gridCellOf(ev); if (!c) return; ev.preventDefault(); c.classList.remove('drop'); var i = parseInt(c.getAttribute('data-i'), 10); selectGlyph(i); onAssign(); });
}
function selectGlyph(i) {
  // move the .selected class without rebuilding the whole grid
  if (cellByIndex[selectedSlot]) cellByIndex[selectedSlot].classList.remove('selected');
  selectedSlot = i;
  if (cellByIndex[i]) cellByIndex[i].classList.add('selected');
  updateAssign(); renderRight();
}
function refreshGlyphCell(i) {       // update ONE cell after a live edit (O(1), no full rebuild)
  var cell = cellByIndex[i]; if (!cell) { renderGrid(); return; }   // not shown → structural rebuild
  var g = curFont().glyphs[i];
  cell.className = glyphCellClass(g, i);
  cell.innerHTML = glyphCellHTML(g);
}
function renderGrid() {
  var grid = $('grid'); if (!grid) return;
  if (!grid._fmWired) { wireGridDelegation(grid); grid._fmWired = true; }   // delegate handlers once
  cellByIndex = {};
  var f = curFont();
  var frag = document.createDocumentFragment();
  glyphDisplayOrder(f).forEach(function (i) {
    var g = f.glyphs[i];
    if (!glyphVisible(g)) return;
    var cell = document.createElement('div');
    cell.className = glyphCellClass(g, i);
    cell.setAttribute('data-i', i);
    cell.title = g.name + ' — double-click to assign the selection · right-click for options · drop a shape';
    cell.innerHTML = glyphCellHTML(g);
    cellByIndex[i] = cell;
    frag.appendChild(cell);
  });
  grid.innerHTML = '';
  grid.appendChild(frag);
}

// ============ IMAGE IMPORT — trace reference sheets, auto-fill the grid ======
// Pick 1–4 raster sheets (numbers / letters / symbols, in any order). Our own
// optimized vectorizer (shared/imagetrace.js — threshold → boundary → RDP →
// corner-detect → smooth Bézier fit) traces each sheet entirely in-panel: smooth,
// low-path, corners preserved, no pixel glitches, and counters (o a 0 8 …) come
// back as real compound-path HOLES. The panel then clusters blobs into glyphs,
// runs the offline AI recognizer + positional fallback, shows a review dialog,
// and seats the chosen glyphs into the active master. All pure JS (unit-tested in
// test/imgimport.test.js).
var imgSheets = []; // [{ name, filter, imgd, traceOpts, category, clusters, mapping, _gen, _nameEl }]
// OPTIONAL manual recognition scope (never auto-detected). Default 'all' = the
// whole Latin+symbol union, so a MIXED sheet (letters + symbols, upper + lower)
// is recognized glyph-by-glyph. Narrow it only when a sheet really is one set.
// Illustrator Image Trace controls (Black & White): Threshold + Paths/Corners/Noise.
// Image Import (image→vector recognition) is PARKED as a demo for now — the
// recognition isn't reliable enough yet, so its entry buttons are hidden and we
// focus on the template workflow. All the code (potrace/vecai/imgglyphs/wizard)
// stays intact; flip this to true to re-enable the feature in the UI.
var IMG_IMPORT_ENABLED = false;

var IMG_TRACE_DEFAULTS = { threshold: 128, paths: 50, corners: 75, noise: 2 };

// One-click style presets for the trace controls (+ K supersample). The first two
// are tuned for the user's reference sheets: a bold solid display serif, and a
// rough brush/calligraphy face.
var IMG_PRESETS = [
  { id: 'clean', name: 'Clean / Solid', tip: 'Bold solid display type — crisp sharp corners, pixel-faithful, minimal nodes (e.g. the blackletter caps sheet).', opts: { threshold: 128, paths: 55, corners: 85, noise: 3, K: 1 } },
  { id: 'brush', name: 'Brush / Calligraphy', tip: 'Rough brush & ink calligraphy — follows organic edges, keeps thin tapers & texture, rounder joins (e.g. the KAGEN sheet). Uses 2× supersampling.', opts: { threshold: 138, paths: 85, corners: 35, noise: 3, K: 2 } },
  { id: 'balanced', name: 'Balanced', tip: 'General-purpose default — good for most clean type.', opts: { threshold: 128, paths: 50, corners: 75, noise: 2, K: 1 } },
  { id: 'geometric', name: 'Geometric', tip: 'Maximum corners, fewest nodes — logos / geometric / monoline letters.', opts: { threshold: 128, paths: 45, corners: 95, noise: 4, K: 1 } },
];

// The 4 controls map onto the clean-room potrace tracer's knobs (see potrace.ilToOpts):
// Paths = fidelity (hi → more nodes hugging pixels), Corners = sharpness (hi → more
// corners, lo → rounder), Noise = drop specks below N px, Threshold = bilevel cutoff.
var IMG_RECO_MIN_CONF = 0.35;

// Per-image SCRIPT scope, chosen in the import wizard. Latin is split into UPPER /
// LOWER (ornate caps and lowercase are best recognized when scoped apart, and the
// positional fallback then uses the right canonical order). Letter/number/symbol
// scopes use the curated SEQ lists; other scripts use Unicode RANGES filtered to
// what the trained model actually covers. So an image is read within its script —
// never confused across scripts.
var IMG_SCOPES = [
  { id: 'latinUpper', label: 'Latin uppercase', seq: 'upper' },
  { id: 'latinLower', label: 'Latin lowercase', seq: 'lower' },
  { id: 'numbers',    label: 'Numbers',          seq: 'digits' },
  { id: 'symbols',    label: 'Symbols & shapes', seq: 'symbols' },
  { id: 'greek',      label: 'Greek',            ranges: [[0x370, 0x3FF]] },
  { id: 'cyrillic',   label: 'Cyrillic',         ranges: [[0x400, 0x4FF]] },
  { id: 'hebrew',     label: 'Hebrew',           ranges: [[0x590, 0x5FF]] },
  { id: 'arabic',     label: 'Arabic',           ranges: [[0x600, 0x6FF]] },
  { id: 'hiragana',   label: 'Hiragana',         ranges: [[0x3040, 0x309F]] },
  { id: 'katakana',   label: 'Katakana',         ranges: [[0x30A0, 0x30FF]] },
  { id: 'han',        label: 'Chinese / Kanji',  ranges: [[0x3400, 0x9FFF]] },
];
function imgScope(id) { for (var i = 0; i < IMG_SCOPES.length; i++) if (IMG_SCOPES[i].id === id) return IMG_SCOPES[i]; return null; }
function imgScopeSeq(id) { var s = imgScope(id); return (s && s.seq) || null; }

// Codepoints the recognizer may pick from for a sheet's chosen script — the SEQ
// list (letters/numbers/symbols) or the model's classes in the script ranges.
// Falls back to the whole Latin+symbol union if unknown / model not loaded yet.
var _imgUnionCps = null;
function imgUnionCps() {
  if (_imgUnionCps) return _imgUnionCps;
  var s = imgglyphs.SEQ, seen = {}, out = [];
  ['digits', 'upper', 'lower', 'symbols'].forEach(function (k) {
    (s[k] || []).forEach(function (c) { var cp = c.codePointAt(0); if (!seen[cp]) { seen[cp] = 1; out.push(cp); } });
  });
  _imgUnionCps = out; return out;
}
function imgAllowedCps(id) {
  var s = imgScope(id);
  if (s) {
    if (s.seq) { var seq = imgglyphs.SEQ[s.seq]; if (seq) return seq.map(function (c) { return c.codePointAt(0); }); }
    if (s.ranges) { var cps = glyphreco.cpsInRanges(s.ranges); if (cps) return cps; }
  }
  return imgUnionCps();
}

// Recognize ONE sheet over its allowed set; overwrite each glyph's guess with the
// AI's confident pick, but KEEP any character the user typed (source:'manual').
// A per-sheet generation token drops a stale async result that lands after a
// newer re-trace. Returns false only if the model was unavailable.
async function recognizeSheetEntry(sheet, label) {
  if (!glyphreco.isAvailable()) {
    try { await glyphreco.init(ROOT); } catch (e) { return false; }
    if (!glyphreco.isAvailable()) return false;
  }
  var gen = sheet._gen, preds;
  try {
    preds = await glyphreco.recognizeSheet(sheet.clusters, imgAllowedCps(sheet.scope), function (done, total) {
      setStatus('Recognizing' + (label ? ' — ' + label : '') + ': ' + done + '/' + total + '…');
    });
  } catch (e) { preds = null; }
  if (sheet._gen !== gen) return true;   // superseded by a newer re-trace; discard
  if (!preds) return false;
  for (var k = 0; k < sheet.clusters.length; k++) {
    var p = preds[k], prev = sheet.mapping[k];
    if (prev && prev.source === 'manual') continue;          // never clobber a user edit
    if (p && p.char != null && p.conf >= IMG_RECO_MIN_CONF) {
      sheet.mapping[k] = { clusterIndex: k, char: p.char, unicode: p.cp, conf: p.conf, source: 'ai', candidates: p.candidates || null };
    }
  }
  return true;
}

// First guess for every sheet — free recognition over the Latin+symbol union (no
// per-sheet category is ever forced). If the model can't load, the positional
// placeholder mapping stays so Image Import still works.
async function recognizeSheets() {
  setStatus('Loading recognition model…');
  try { await glyphreco.init(ROOT); }
  catch (e) { return; }   // model unavailable -> keep placeholder mapping
  if (!glyphreco.isAvailable()) return;
  for (var s = 0; s < imgSheets.length; s++) {
    await recognizeSheetEntry(imgSheets[s], 'sheet ' + (s + 1) + '/' + imgSheets.length);
  }
}

// Open Illustrator's native file picker (host side), then run the per-image wizard.
function onImgImportClick() {
  if (!curFont()) { setStatus('Create or open a font first.', 'err'); return; }
  setStatus('Pick your reference sheets…');
  evalScript('fmPickImages()').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!r || !r.ok) {
      if (r && r.error === 'cancelled') setStatus('');
      else setStatus('Could not open the file picker.', 'err');
      return;
    }
    var files = (r.files || []).slice(0, 4);
    if (!files.length) { setStatus('No images selected.', 'err'); return; }
    startImgWizard(files);
  });
}

// Decode a picked PNG/JPG into ImageData via an offscreen canvas (CEP is
// Chromium → file:// images load and are same-origin, so getImageData isn't
// tainted). Very large sheets are downscaled; glyph detail at ~1800px is plenty
// and it keeps tracing fast.
function loadImageData(path, maxDim) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) { reject(new Error('empty image')); return; }
      var md = maxDim || 1800, scale = Math.min(1, md / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      var g = cv.getContext('2d'); g.drawImage(img, 0, 0, cw, ch);
      try { resolve(g.getImageData(0, 0, cw, ch)); } catch (e) { reject(e); }
    };
    img.onerror = function () { reject(new Error('image load failed')); };
    img.src = 'file:///' + String(path).replace(/\\/g, '/');
  });
}

// ===== Image Import WIZARD — ONE popup per image. Top: vectorization sliders +
// a zoomable, point-level preview (faint original under crisp Bézier outlines +
// anchor/handle dots) so you can see exactly how it vectorized. Bottom: which
// SCRIPT this image holds. Picking a script stores it and advances to the next
// image; after the last, the AI recognizes every glyph within each image's
// script and the review/fill grid opens. No Illustrator anywhere.
var SVGNS = 'http://www.w3.org/2000/svg';
var wiz = null; // { files:[paths], idx, sheets:[sheet|undefined per file] }

function imgdToDataURL(imgd) {
  var cv = document.createElement('canvas'); cv.width = imgd.width; cv.height = imgd.height;
  cv.getContext('2d').putImageData(imgd, 0, 0);
  return cv.toDataURL('image/png');
}
function wizFileName(p) { return String(p).replace(/^.*[\\\/]/, ''); }
function wizStatus(msg, err) { var s = $('wizStatus'); if (s) { s.textContent = msg || ''; s.classList.toggle('err', !!err); } }

function startImgWizard(files) {
  imgSheets = [];
  wiz = { files: files, idx: 0, sheets: new Array(files.length) };
  $('imgWizModal').classList.remove('hidden');
  wizLoad(0);
}

// Build (once) the sheet for image idx — decode + trace + analyze — then render.
function wizLoad(idx) {
  if (!wiz) return;
  wiz.idx = idx;
  var existing = wiz.sheets[idx];
  if (existing) { wizRender(existing); return; }
  var path = wiz.files[idx], nm = wizFileName(path);
  wizStatus('Tracing ' + nm + ' …');
  loadImageData(path).then(function (imgd) {
    if (!wiz) return;
    var sheet = {
      name: nm, scope: null, imgd: imgd, dataURL: imgdToDataURL(imgd), _path: path,
      traceOpts: Object.assign({}, IMG_TRACE_DEFAULTS), _showPts: true,
      _vb: [0, 0, imgd.width, imgd.height],
    };
    wizTrace(sheet);
    wiz.sheets[idx] = sheet;
    wizRender(sheet);
  }, function () { wizStatus('Could not load ' + nm, true); });
}

function wizTrace(sheet) {
  try {
    var contours = potrace.traceImageData(sheet.imgd, potrace.ilToOpts(sheet.traceOpts));
    var a = imgglyphs.analyzeSheet(contours);
    sheet._rawClusters = a.clusters;            // the classical trace (before AI refine)
    sheet.clusters = a.clusters; sheet.category = a.category; sheet.mapping = a.mapping;
  } catch (e) { sheet._rawClusters = sheet._rawClusters || []; sheet.clusters = sheet.clusters || []; sheet.mapping = sheet.mapping || []; }
}

// Apply the two refiner AIs (Smooth=jitter, Sharpen=quant) to the raw trace at the
// sheet's 0..100 strengths, then redraw. Off by default; safe no-op if unavailable.
async function wizApplyAI(sheet) {
  var raw = sheet._rawClusters || sheet.clusters || [];
  var on = !!sheet.aiOn, S = (sheet.aiStrength != null ? sheet.aiStrength : 60) / 100;
  var clusters = raw;
  if (on && S > 0) {
    wizStatus('AI refining…');
    // one strength drives both refiner models (jitter + quant) — see vecai.refine
    try { await vecai.init(ROOT); clusters = await vecai.refine(raw, { smooth: S, sharpen: S }); }
    catch (e) { clusters = raw; }
  }
  sheet.clusters = clusters;
  wizDrawVectors(sheet);
  var off = on && S > 0 && !vecai.isAvailable();
  wizStatus(off ? ('AI refiner off — ' + (vecai.initError() || 'unavailable') + ' (clean trace)') : '', off);
}

function wizRender(sheet) {
  $('wizStep').textContent = 'Image ' + (wiz.idx + 1) + ' of ' + wiz.files.length;
  $('wizName').textContent = sheet.name;
  if ($('wizBackBtn')) $('wizBackBtn').disabled = (wiz.idx === 0);
  wizBuildControls(sheet, $('wizCtl'));
  wizBuildPreview(sheet, $('wizPreview'));
  wizBuildScope(sheet, $('wizScopeBtns'));
  wizStatus('');
}

// TOP — vectorization sliders + Show-points toggle + Fit + a live glyph/point count.
function wizBuildControls(sheet, host) {
  host.innerHTML = '';
  // Preset row — one click sets all 4 controls (+ supersample) for a style.
  var pr = document.createElement('div'); pr.className = 'wiz-presets';
  var plab = document.createElement('span'); plab.className = 'wiz-presets-lab'; plab.textContent = 'Preset:';
  pr.appendChild(plab);
  IMG_PRESETS.forEach(function (ps) {
    var b = document.createElement('button'); b.className = 'rune-btn outline sm2'; b.textContent = ps.name; b.title = ps.tip;
    if (sheet._preset === ps.id) b.classList.add('active');
    b.addEventListener('click', function () {
      sheet.traceOpts = Object.assign({}, ps.opts); sheet._preset = ps.id;
      wizRetrace(sheet);
      wizBuildControls(sheet, host);   // refresh slider positions + active state
    });
    pr.appendChild(b);
  });
  host.appendChild(pr);
  // Illustrator Image Trace controls: Threshold / Paths / Corners / Noise.
  var defs = [
    ['threshold', 'Threshold', 0, 255, 1, '', 'Black/white cutoff — Less ↔ More ink'],
    ['paths', 'Paths', 0, 100, 1, '%', 'Fit — High follows the pixels, Low is smoother'],
    ['corners', 'Corners', 0, 100, 1, '%', 'More = sharper corners; Less smooths unnecessary corners'],
    ['noise', 'Noise', 1, 200, 1, 'px', 'Ignore specks smaller than this'],
  ];
  var timer = null;
  function sched() { if (timer) clearTimeout(timer); timer = setTimeout(function () { wizRetrace(sheet); }, 200); }
  defs.forEach(function (d) {
    var key = d[0], unit = d[5] || '';
    var wrap = document.createElement('span'); wrap.className = 'img-tc'; wrap.title = d[6];
    var lab = document.createElement('span'); lab.className = 'img-tc-lab'; lab.textContent = d[1];
    var rng = document.createElement('input'); rng.type = 'range'; rng.className = 'gd-slider';
    rng.min = d[2]; rng.max = d[3]; rng.step = d[4]; rng.value = sheet.traceOpts[key];
    var val = document.createElement('span'); val.className = 'img-tc-val'; val.textContent = sheet.traceOpts[key] + unit;
    rng.addEventListener('input', function () { sheet.traceOpts[key] = +rng.value; val.textContent = rng.value + unit; sheet._preset = null; sched(); });
    wrap.appendChild(lab); wrap.appendChild(rng); wrap.appendChild(val);
    host.appendChild(wrap);
  });
  // Neural refiner — ONE on/off toggle + ONE strength slider (sits on top of the
  // clean trace, never re-traces). Off by default; the tracer is font-grade alone.
  var aiTimer = null;
  function aiSched() { if (aiTimer) clearTimeout(aiTimer); aiTimer = setTimeout(function () { wizApplyAI(sheet); }, 250); }
  var aiWrap = document.createElement('span'); aiWrap.className = 'img-tc img-ai';
  aiWrap.title = 'Neural refiner: melts residual pixel/AA roughness + optimises points. Off = clean tracer only.';
  var aiTog = document.createElement('label'); aiTog.className = 'wiz-toggle';
  var aiCb = document.createElement('input'); aiCb.type = 'checkbox'; aiCb.checked = !!sheet.aiOn;
  aiTog.appendChild(aiCb); aiTog.appendChild(document.createTextNode(' AI Refine'));
  var aiDef = sheet.aiStrength != null ? sheet.aiStrength : 60;
  var aiRng = document.createElement('input'); aiRng.type = 'range'; aiRng.className = 'gd-slider';
  aiRng.min = 0; aiRng.max = 100; aiRng.step = 5; aiRng.value = aiDef; aiRng.disabled = !sheet.aiOn;
  var aiVal = document.createElement('span'); aiVal.className = 'img-tc-val'; aiVal.textContent = aiDef + '%';
  aiCb.addEventListener('change', function () { sheet.aiOn = aiCb.checked; aiRng.disabled = !aiCb.checked; wizApplyAI(sheet); });
  aiRng.addEventListener('input', function () { sheet.aiStrength = +aiRng.value; aiVal.textContent = aiRng.value + '%'; if (sheet.aiOn) aiSched(); });
  aiWrap.appendChild(aiTog); aiWrap.appendChild(aiRng); aiWrap.appendChild(aiVal);
  host.appendChild(aiWrap);
  var tog = document.createElement('label'); tog.className = 'wiz-toggle'; tog.title = 'Show anchor + handle points';
  var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sheet._showPts !== false;
  cb.addEventListener('change', function () { sheet._showPts = cb.checked; wizDrawVectors(sheet); });
  tog.appendChild(cb); tog.appendChild(document.createTextNode(' Points'));
  host.appendChild(tog);
  var fit = document.createElement('button'); fit.className = 'rune-btn outline sm2'; fit.textContent = 'Fit';
  fit.title = 'Reset zoom'; fit.addEventListener('click', function () {
    sheet._vb = [0, 0, sheet.imgd.width, sheet.imgd.height];
    if (sheet._svg) { sheet._svg.setAttribute('viewBox', sheet._vb.join(' ')); wizScalePoints(sheet); }
  });
  host.appendChild(fit);
  var cnt = document.createElement('span'); cnt.className = 'wiz-count'; sheet._cntEl = cnt;
  host.appendChild(cnt);
  wizUpdateCount(sheet);
}

function wizUpdateCount(sheet) {
  if (!sheet._cntEl) return;
  var n = 0, g = 0;
  (sheet.clusters || []).forEach(function (cl) { g++; cl.contours.forEach(function (c) { n += (c.points || []).length; }); });
  sheet._cntEl.textContent = g + ' glyphs · ' + n + ' points';
}

// MIDDLE — zoomable SVG preview. Faint original raster under crisp vector
// outlines + anchor (corner/smooth) and handle dots. Wheel = zoom to cursor,
// drag = pan, Fit = reset.
function wizBuildPreview(sheet, host) {
  host.innerHTML = '';
  var W = sheet.imgd.width, H = sheet.imgd.height;
  var svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'wiz-svg');
  svg.setAttribute('viewBox', (sheet._vb || [0, 0, W, H]).join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  var im = document.createElementNS(SVGNS, 'image');
  im.setAttribute('href', sheet.dataURL);
  im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', sheet.dataURL);
  im.setAttribute('x', 0); im.setAttribute('y', 0); im.setAttribute('width', W); im.setAttribute('height', H);
  im.setAttribute('class', 'wiz-img');
  svg.appendChild(im);
  var vlayer = document.createElementNS(SVGNS, 'g'); vlayer.setAttribute('class', 'wiz-vec');
  svg.appendChild(vlayer);
  host.appendChild(svg);
  sheet._svg = svg; sheet._vlayer = vlayer;
  wizDrawVectors(sheet);
  wizPanZoom(sheet, svg);
}

function wizPathData(pts) {
  function f(n) { return Math.round(n * 100) / 100; }
  var d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
  for (var i = 1; i <= pts.length; i++) {
    var prev = pts[i - 1], cur = pts[i % pts.length];
    if (prev.handleOut || cur.handleIn) {
      var c1 = prev.handleOut || prev, c2 = cur.handleIn || cur;
      d += 'C' + f(c1.x) + ' ' + f(c1.y) + ' ' + f(c2.x) + ' ' + f(c2.y) + ' ' + f(cur.x) + ' ' + f(cur.y);
    } else { d += 'L' + f(cur.x) + ' ' + f(cur.y); }
  }
  return d + 'Z';
}

function wizDrawVectors(sheet) {
  var g = sheet._vlayer; if (!g) return;
  while (g.firstChild) g.removeChild(g.firstChild);
  var clusters = sheet.clusters || [];
  function C(tag) { return document.createElementNS(SVGNS, tag); }
  // One path per GLYPH (all its contours as sub-paths) with even-odd fill so
  // counters/holes (inside of O, A, e…) punch through instead of filling solid.
  clusters.forEach(function (cl) {
    var d = '';
    cl.contours.forEach(function (c) { var pts = c.points; if (pts && pts.length >= 2) d += wizPathData(pts) + 'Z '; });
    if (!d) return;
    var path = C('path'); path.setAttribute('d', d); path.setAttribute('class', 'wiz-path');
    path.setAttribute('fill-rule', 'evenodd');
    g.appendChild(path);
  });
  if (sheet._showPts !== false) {
    clusters.forEach(function (cl) {
      cl.contours.forEach(function (c) {
        var pts = c.points; if (!pts || pts.length < 2) return;
        pts.forEach(function (p) {
          [p.handleIn, p.handleOut].forEach(function (h) {
            if (!h) return;
            var ln = C('line'); ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); ln.setAttribute('x2', h.x); ln.setAttribute('y2', h.y);
            ln.setAttribute('class', 'wiz-handle'); g.appendChild(ln);
            var hd = C('circle'); hd.setAttribute('cx', h.x); hd.setAttribute('cy', h.y); hd.setAttribute('class', 'wiz-hdot');
            g.appendChild(hd);
          });
        });
        pts.forEach(function (p) {
          var a = C('circle'); a.setAttribute('cx', p.x); a.setAttribute('cy', p.y);
          a.setAttribute('class', 'wiz-anchor ' + (p.type === 'smooth' ? 'sm' : 'cn')); g.appendChild(a);
        });
      });
    });
  }
  wizScalePoints(sheet);   // size the dots to a CONSTANT screen size (not zoom-scaled)
  wizUpdateCount(sheet);
}

// Keep anchor/handle dots a fixed on-screen size at any zoom — radius in user
// units = screen px × (viewBox width / svg pixel width). Without this, dots
// balloon as you zoom in.
function wizScalePoints(sheet) {
  if (!sheet._svg || !sheet._vlayer) return;
  var rect = sheet._svg.getBoundingClientRect();
  var w = rect.width || sheet.imgd.width;
  var scale = sheet._vb[2] / w;
  var rA = (3.6 * scale).toFixed(2), rH = (2.3 * scale).toFixed(2);
  var anchors = sheet._vlayer.querySelectorAll('.wiz-anchor');
  for (var i = 0; i < anchors.length; i++) anchors[i].setAttribute('r', rA);
  var dots = sheet._vlayer.querySelectorAll('.wiz-hdot');
  for (var j = 0; j < dots.length; j++) dots[j].setAttribute('r', rH);
}

function wizPanZoom(sheet, svg) {
  function apply() { svg.setAttribute('viewBox', sheet._vb.join(' ')); wizScalePoints(sheet); }
  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = svg.getBoundingClientRect(); if (!rect.width) return;
    var vb = sheet._vb, W = sheet.imgd.width;
    var cx = vb[0] + (e.clientX - rect.left) / rect.width * vb[2];
    var cy = vb[1] + (e.clientY - rect.top) / rect.height * vb[3];
    var f = e.deltaY < 0 ? 1 / 1.18 : 1.18;
    var nw = vb[2] * f;
    if (nw > W * 2) f = (W * 2) / vb[2]; else if (nw < W / 50) f = (W / 50) / vb[2];
    nw = vb[2] * f; var nh = vb[3] * f;
    sheet._vb = [cx - (cx - vb[0]) * f, cy - (cy - vb[1]) * f, nw, nh];
    apply();
  }, { passive: false });
  var drag = null;
  svg.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, y: e.clientY, vb: sheet._vb.slice() };
    try { svg.setPointerCapture(e.pointerId); } catch (x) {}
    svg.classList.add('grabbing');
  });
  svg.addEventListener('pointermove', function (e) {
    if (!drag) return; var rect = svg.getBoundingClientRect(); if (!rect.width) return;
    var dx = (e.clientX - drag.x) / rect.width * drag.vb[2];
    var dy = (e.clientY - drag.y) / rect.height * drag.vb[3];
    sheet._vb = [drag.vb[0] - dx, drag.vb[1] - dy, drag.vb[2], drag.vb[3]]; apply();
  });
  function end(e) { if (drag) { drag = null; try { svg.releasePointerCapture(e.pointerId); } catch (x) {} svg.classList.remove('grabbing'); } }
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

function wizRetrace(sheet) { wizTrace(sheet); wizApplyAI(sheet); }

// BOTTOM — which SCRIPT this image holds. Clicking one stores it and advances.
function wizBuildScope(sheet, host) {
  host.innerHTML = '';
  IMG_SCOPES.forEach(function (sc) {
    var b = document.createElement('button');
    b.className = 'wiz-scope-btn' + (sheet.scope === sc.id ? ' on' : '');
    b.textContent = sc.label; b.title = 'This image is ' + sc.label + ' — click to continue';
    b.addEventListener('click', function () { wizPickScope(sc.id); });
    host.appendChild(b);
  });
}

function wizPickScope(scope) {
  if (!wiz) return;
  var sheet = wiz.sheets[wiz.idx]; if (!sheet) return;
  sheet.scope = scope;
  if (wiz.idx < wiz.files.length - 1) wizLoad(wiz.idx + 1);
  else wizFinish();
}

function wizBack() { if (wiz && wiz.idx > 0) wizLoad(wiz.idx - 1); }
function wizCancel() { var m = $('imgWizModal'); if (m) m.classList.add('hidden'); wiz = null; setStatus(''); }

// All images scoped → assemble imgSheets, recognize each within its script, open
// the review/fill grid.
function wizFinish() {
  $('imgWizModal').classList.add('hidden');
  imgSheets = [];
  (wiz ? wiz.sheets : []).forEach(function (sheet) {
    if (!sheet || !sheet.clusters || !sheet.clusters.length) return;
    var seqKey = imgScopeSeq(sheet.scope);
    var mapping = seqKey ? imgglyphs.mapClusters(sheet.clusters, seqKey)
      : sheet.clusters.map(function (_, i) { return { clusterIndex: i, char: null, unicode: null }; });
    imgSheets.push({
      name: sheet.name, scope: sheet.scope, imgd: sheet.imgd, traceOpts: sheet.traceOpts,
      category: sheet.category, clusters: sheet.clusters, mapping: mapping, _gen: 0,
    });
  });
  wiz = null;
  if (!imgSheets.length) { setStatus('No glyphs found in those images.', 'err'); return; }
  recognizeSheets().then(openImgModal, openImgModal);
}

// SVG silhouette of one traced cluster (pixel space, Y-down, like SVG — no flip).
function clusterSvg(cl) {
  var b = cl.bbox, pad = 2;
  var bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  function f(n) { return Math.round(n * 10) / 10; }
  var d = '';
  cl.contours.forEach(function (c) {
    var pts = c.points; if (!pts || pts.length < 2) return;
    var x0 = b[0] - pad, y0 = b[1] - pad;
    d += 'M' + f(pts[0].x - x0) + ' ' + f(pts[0].y - y0);
    for (var i = 1; i <= pts.length; i++) {
      var prev = pts[i - 1], cur = pts[i % pts.length];
      if (prev.handleOut || cur.handleIn) {
        var c1 = prev.handleOut || prev, c2 = cur.handleIn || cur;
        d += 'C' + f(c1.x - x0) + ' ' + f(c1.y - y0) + ' ' + f(c2.x - x0) + ' ' + f(c2.y - y0) + ' ' + f(cur.x - x0) + ' ' + f(cur.y - y0);
      } else {
        d += 'L' + f(cur.x - x0) + ' ' + f(cur.y - y0);
      }
    }
    d += 'Z';
  });
  return '<svg viewBox="0 0 ' + f(bw + pad * 2) + ' ' + f(bh + pad * 2) + '" preserveAspectRatio="xMidYMid meet">' +
    '<path d="' + d + '" fill="#141414" fill-rule="evenodd"/></svg>';
}

function updateMergeBtn(sheet) {
  if (!sheet._mergeBtn) return;
  var n = sheet._sel ? Object.keys(sheet._sel).length : 0;
  sheet._mergeBtn.disabled = n < 2;
  sheet._mergeBtn.textContent = n >= 2 ? 'Merge (' + n + ')' : 'Merge';
}

function renderImgThumbs(sheet, box) {
  box.innerHTML = '';
  if (!sheet._sel) sheet._sel = {};
  sheet.clusters.forEach(function (cl, i) {
    var cell = document.createElement('div'); cell.className = 'img-thumb';
    cell.innerHTML = clusterSvg(cl);
    if (sheet._sel[i]) cell.classList.add('sel');
    var inp = document.createElement('input');
    inp.className = 'img-char'; inp.maxLength = 2; inp.spellcheck = false;
    var m = sheet.mapping[i];
    inp.value = (m && m.char != null) ? m.char : '';
    inp.title = (m && m.candidates && m.candidates.length > 1)
      ? 'AI guesses: ' + m.candidates.map(function (c) { return c.char; }).join('  ') + '  — type to override, clear to skip'
      : 'Character for this glyph — clear to skip it';
    if (m && m.source === 'ai') cell.classList.add('ai');
    if (!inp.value) cell.classList.add('unset');
    inp.addEventListener('input', function () {
      var ch = inp.value ? Array.from(inp.value)[0] : null;
      sheet.mapping[i] = { clusterIndex: i, char: ch, unicode: ch ? ch.codePointAt(0) : null, source: 'manual' };
      cell.classList.toggle('unset', !ch);
      cell.classList.remove('ai');
    });
    // click the TILE (not the char box) to select it for merging
    cell.addEventListener('click', function (ev) {
      if (ev.target === inp) return;
      if (sheet._sel[i]) delete sheet._sel[i]; else sheet._sel[i] = true;
      cell.classList.toggle('sel', !!sheet._sel[i]);
      updateMergeBtn(sheet);
    });
    cell.appendChild(inp);
    box.appendChild(cell);
  });
  updateMergeBtn(sheet);
}

// Merge the selected tiles into ONE glyph (e.g. the two marks of a quote the
// recognizer split). Combines their contours + bbox, replaces them at the first
// selected slot, then re-recognizes just the merged glyph within the scope.
function mergeSelected(sheet, thumbs) {
  var sel = Object.keys(sheet._sel || {}).map(Number).sort(function (a, b) { return a - b; });
  if (sel.length < 2) return;
  var selSet = {}; sel.forEach(function (i) { selSet[i] = true; });
  var contours = [], x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, row = Infinity;
  sel.forEach(function (i) {
    var cl = sheet.clusters[i];
    cl.contours.forEach(function (c) { contours.push(c); });
    x0 = Math.min(x0, cl.bbox[0]); y0 = Math.min(y0, cl.bbox[1]);
    x1 = Math.max(x1, cl.bbox[2]); y1 = Math.max(y1, cl.bbox[3]); row = Math.min(row, cl.row);
  });
  var merged = { contours: contours, bbox: [x0, y0, x1, y1], row: row };
  var newClusters = [], newMapping = [];
  for (var i = 0; i < sheet.clusters.length; i++) {
    if (i === sel[0]) { newClusters.push(merged); newMapping.push({ clusterIndex: newClusters.length - 1, char: null, unicode: null }); }
    if (selSet[i]) continue;
    newClusters.push(sheet.clusters[i]);
    var m = sheet.mapping[i] || {};
    newMapping.push({ clusterIndex: newClusters.length - 1, char: (m.char != null ? m.char : null), unicode: (m.unicode != null ? m.unicode : null), source: m.source, conf: m.conf, candidates: m.candidates });
  }
  sheet.clusters = newClusters; sheet.mapping = newMapping; sheet._sel = {};
  updateSheetName(sheet);
  renderImgThumbs(sheet, thumbs);
  if (glyphreco.isAvailable()) {
    var mi = newClusters.indexOf(merged);
    glyphreco.recognizeSheet([merged], imgAllowedCps(sheet.scope)).then(function (preds) {
      var p = preds && preds[0];
      if (p && p.char != null && sheet.clusters[mi] === merged) {
        sheet.mapping[mi] = { clusterIndex: mi, char: p.char, unicode: p.cp, conf: p.conf, source: 'ai', candidates: p.candidates || null };
        renderImgThumbs(sheet, thumbs);
      }
    });
  }
}

function updateSheetName(sheet) {
  if (sheet._nameEl) sheet._nameEl.textContent = sheet.name + ' · ' + sheet.clusters.length + ' glyphs';
}

// Script changed in the review grid: clear non-manual guesses and re-detect
// within the new script (manual edits are kept).
async function reRecognizeSheet(sheet, thumbs) {
  sheet._gen = (sheet._gen || 0) + 1;
  var seqKey = imgScopeSeq(sheet.scope);
  var base = seqKey ? imgglyphs.mapClusters(sheet.clusters, seqKey)
    : sheet.clusters.map(function (_, i) { return { clusterIndex: i, char: null, unicode: null }; });
  sheet.mapping = sheet.mapping.map(function (m, i) { return (m && m.source === 'manual') ? m : base[i]; });
  renderImgThumbs(sheet, thumbs);
  var ok = await recognizeSheetEntry(sheet, sheet.name);
  renderImgThumbs(sheet, thumbs);
  if (!ok) setStatus('Model off — using positional guess for this script.');
}

function openImgModal() {
  var host = $('imgSheets'); if (!host) return;
  host.innerHTML = '';
  imgSheets.forEach(function (sheet) {
    sheet._sel = {};
    var sec = document.createElement('div'); sec.className = 'img-sheet';
    var head = document.createElement('div'); head.className = 'img-sheet-head';
    var name = document.createElement('span'); name.className = 'img-sheet-name';
    sheet._nameEl = name; updateSheetName(sheet);
    var thumbs = document.createElement('div'); thumbs.className = 'img-thumbs';
    // merge: select 2+ tiles, combine into one glyph
    var mergeBtn = document.createElement('button'); mergeBtn.className = 'rune-btn outline sm2 img-merge';
    mergeBtn.textContent = 'Merge'; mergeBtn.disabled = true;
    mergeBtn.title = 'Click 2+ tiles to select them, then Merge into one glyph (e.g. the two marks of a quote).';
    mergeBtn.addEventListener('click', function () { mergeSelected(sheet, thumbs); });
    sheet._mergeBtn = mergeBtn;
    // script scope
    var catWrap = document.createElement('label'); catWrap.className = 'img-catwrap';
    var catLbl = document.createElement('span'); catLbl.className = 'img-catlbl'; catLbl.textContent = 'script';
    var sel = document.createElement('select'); sel.className = 'img-cat';
    sel.title = 'Which script this image is — change it to re-detect the glyphs within a different script.';
    IMG_SCOPES.forEach(function (opt) {
      var o = document.createElement('option'); o.value = opt.id; o.textContent = opt.label;
      if (opt.id === sheet.scope) o.selected = true; sel.appendChild(o);
    });
    sel.addEventListener('change', function () { sheet.scope = sel.value; reRecognizeSheet(sheet, thumbs); });
    catWrap.appendChild(catLbl); catWrap.appendChild(sel);
    var right = document.createElement('div'); right.className = 'img-head-right';
    right.appendChild(mergeBtn); right.appendChild(catWrap);
    head.appendChild(name); head.appendChild(right);
    sec.appendChild(head);
    sec.appendChild(thumbs);
    renderImgThumbs(sheet, thumbs);
    host.appendChild(sec);
  });
  $('imgModal').classList.remove('hidden');
}

function closeImgModal() { var m = $('imgModal'); if (m) m.classList.add('hidden'); imgSheets = []; }

function onImgFill() {
  var f = curFont(); if (!f) { closeImgModal(); return; }
  var mid = curMasterId();
  // Seat each sheet by its glyphs' RECOGNIZED characters (mixed sheets size right);
  // collect candidates per target slot and resolve same-char collisions by keeping
  // the most confident (a hand-typed char always wins).
  var byUnicode = {}; var missing = [], collisions = 0;
  imgSheets.forEach(function (sheet) {
    var chars = sheet.mapping.map(function (m) { return (m && m.char != null) ? m.char : null; });
    var seated = imgglyphs.seatByChar(sheet.clusters, chars, f.metrics, { fallbackCategory: sheet.category });
    sheet.mapping.forEach(function (m, i) {
      if (!m || m.char == null || m.unicode == null) return;
      var gi = f.glyphs.findIndex(function (g) { return g.unicode === m.unicode; });
      if (gi < 0) { missing.push(m.char); return; }
      var s = seated[i]; if (!s) return;
      var conf = (m.source === 'manual') ? 2 : (typeof m.conf === 'number' ? m.conf : 1);
      var prev = byUnicode[m.unicode];
      if (prev) { collisions++; if (conf <= prev.conf) return; }
      byUnicode[m.unicode] = { gi: gi, contours: s.contours, advance: s.advanceWidth, conf: conf };
    });
  });
  var filled = 0;
  Object.keys(byUnicode).forEach(function (u) {
    var e = byUnicode[u];
    if (glyphset.setGlyphContours(f, e.gi, mid, e.contours, e.advance)) filled++;
  });
  // refresh the currently-open Illustrator glyph if it got filled
  if (typeof openGlyphIndex === 'number' && openGlyphIndex >= 0) {
    var og = f.glyphs[openGlyphIndex];
    if (og && isFilled(og)) syncOpenGlyph(og);
  }
  closeImgModal();
  flatCache = {}; kernCache = {};
  renderGrid(); renderModGrid(); renderRight(); renderTesterText(); scheduleTester(); autosave();
  var msg = 'Image import: filled ' + filled + ' glyph' + (filled === 1 ? '' : 's') + '.';
  if (collisions) msg += ' (' + collisions + ' duplicate guess' + (collisions === 1 ? '' : 'es') + ' — kept the most confident.)';
  if (missing.length) {
    var uniq = missing.filter(function (c, i) { return missing.indexOf(c) === i; });
    msg += ' Skipped ' + uniq.length + ' not in this font’s sets (' + uniq.slice(0, 10).join(' ') + (uniq.length > 10 ? '…' : '') + ').';
  }
  setStatus(msg, filled ? 'ok' : 'err');
}

// ---- modification. — only the glyphs that have outlines ----
function renderModGrid() {
  var grid = $('modGrid'); if (!grid) return;
  syncSpaceSliders();   // keep the modification Space slider in sync
  grid.innerHTML = '';
  var f = curFont();
  var shown = 0;
  glyphDisplayOrder(f).forEach(function (i) {
    var g = f.glyphs[i];
    if (!isFilled(g)) return;
    shown++;
    var cell = document.createElement('div');
    cell.className = 'cell filled' + (i === selectedSlot ? ' selected' : '');
    cell.innerHTML = (glyphThumb(g) || '') + '<span class="lab">' + glyphLabelHtml(g) + '</span>';
    cell.title = g.name;
    cell.addEventListener('click', function () {
      selectedSlot = i;
      updateAssign(); renderModGrid(); renderRight();
    });
    cell.addEventListener('contextmenu', function (ev) { showGlyphMenu(ev, i); });
    grid.appendChild(cell);
  });
  if (!shown) grid.innerHTML = '<div class="w-modempty">Nothing placed yet — assign shapes on the glyphs. page first.</div>';
}

// transformContours scales+translates a contour set (used by shiftContoursXY).
function transformContours(contours, sc, x0, y0) {
  return contours.map(function (c) {
    return { closed: c.closed, points: c.points.map(function (pt) {
      return {
        x: pt.x * sc + x0, y: pt.y * sc + y0, type: pt.type,
        handleIn: pt.handleIn ? { x: pt.handleIn.x * sc + x0, y: pt.handleIn.y * sc + y0 } : null,
        handleOut: pt.handleOut ? { x: pt.handleOut.x * sc + x0, y: pt.handleOut.y * sc + y0 } : null,
      };
    }) };
  });
}
function syncOpenGlyph(g) {
  var l = g.layers[curMasterId()];
  evalScript('fmSetArt(' + JSON.stringify(JSON.stringify({ name: g.name, contours: (l && l.contours) || [], metrics: curFont().metrics })) + ')');
}
// The embedded optimizer ("mini AI"): class-aware sidebearings/advance for the
// whole font + optical pair kerning, in one pass. ONLY moves the blue (LSB) and
// red (advance) spacing lines + kern table — it never scales/resizes a glyph.
// One-click Optimize = Analyze → apply its recommended Standard/Optical + run the
// class-aware optimiser + bake optical pair kerning (Auto Kern is merged in here).
function onOptimize() {
  if (!FEAT.optimize) return;
  var f = curFont();
  if (!f.glyphs.some(isFilled)) { setStatus('Draw and assign some glyphs first.', 'err'); return; }
  aiAnalyze();                                  // fills the overlay
  // The old Metric⟷Optical dials (moBlend/moBearingAI/moKern/moKernAI/refSpace) were removed
  // in the UI overhaul — baking through ensureAISpacing here read them all as 0 and silently
  // RESET the font to the metric baseline while the aiOptic/aiAvg sliders still showed 100%.
  // Optimize now drives the current 3-slider pipeline (AI bearing + AI kern + tracking).
  onAIOptimize();
}

// ===== Reference spacing ("X value"): per-letter side bearings averaged from the
// CLASSIC fonts Arial + Times New Roman, dialled by a single % (exaggerate/reduce).
// The reference table is em-fractions so it's UPM-agnostic; the % scales it and we
// re-space every drawn glyph to exactly X×%. It never reads the font's own spacing,
// so it can't fall back to the original values — and it never resizes a glyph.
var _refFracTable; // undefined = not tried yet; null = unavailable; else {ch:{lsb,rsb}}
function refFracTable() {
  if (_refFracTable !== undefined) return _refFracTable;
  _refFracTable = null;
  try {
    var ot = getOpentype(); var fs = require('fs');
    var WIN = (typeof process !== 'undefined' && process.env && process.env.WINDIR) ? process.env.WINDIR : 'C:\\Windows';
    function load(name) {
      var paths = [WIN + '\\Fonts\\' + name, 'C:\\Windows\\Fonts\\' + name];
      for (var i = 0; i < paths.length; i++) {
        try { if (fs.existsSync(paths[i])) { var b = fs.readFileSync(paths[i]); return ot.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } } catch (e) {}
      }
      return null;
    }
    var A = load('arial.ttf'), T = load('times.ttf');
    if (!A && !T) return _refFracTable;
    function fracs(f, ch) {
      if (!f) return null;
      try { var g = f.charToGlyph(ch); if (!g || g.index <= 0 || g.xMax == null) return null; var u = f.unitsPerEm || 2048; return { lsb: g.xMin / u, rsb: (g.advanceWidth - g.xMax) / u }; }
      catch (e) { return null; }
    }
    var tbl = {}, seen = {};
    curFont().glyphs.forEach(function (g) {
      var ch = g.char; if (ch == null || ch === ' ' || seen[ch]) return; seen[ch] = 1;
      var arr = []; var a = fracs(A, ch), t = fracs(T, ch);
      if (a) arr.push(a); if (t) arr.push(t);
      if (!arr.length) return;
      var lsb = 0, rsb = 0; arr.forEach(function (s) { lsb += s.lsb; rsb += s.rsb; });
      tbl[ch] = { lsb: lsb / arr.length, rsb: rsb / arr.length };   // average of the classics
    });
    _refFracTable = Object.keys(tbl).length ? tbl : null;
  } catch (e) { _refFracTable = null; }
  return _refFracTable;
}
// Per-character Arial ink y-bounds (em fractions), keyed by char code, for the
// template ghosts. The JSX seats each ghost using its REAL outline ink + these known
// bounds, so glyphs whose ink is far from the baseline land correctly — '_' below
// the baseline, '-' at mid-height, accents above — instead of all being collapsed by
// the unreliable text-frame line-box.
function arialGhostBounds(proj) {
  try {
    var ot = getOpentype(); var fs = require('fs');
    var WIN = (typeof process !== 'undefined' && process.env && process.env.WINDIR) ? process.env.WINDIR : 'C:\\Windows';
    var paths = [WIN + '\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\arial.ttf'];
    var buf = null;
    for (var i = 0; i < paths.length; i++) { try { if (fs.existsSync(paths[i])) { buf = fs.readFileSync(paths[i]); break; } } catch (e) {} }
    if (!buf) return null;
    var font = ot.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    var u = font.unitsPerEm || 2048, out = {}, seen = {};
    (proj || curFont()).glyphs.forEach(function (g) {
      var ch = g.char; if (ch == null || ch === ' ' || seen[ch]) return; seen[ch] = 1;
      try { var gl = font.charToGlyph(ch); if (gl && gl.index > 0 && gl.yMax != null && gl.yMin != null && gl.yMax > gl.yMin) out['' + ch.charCodeAt(0)] = [gl.yMin / u, gl.yMax / u]; } catch (e) {}
    });
    return out;
  } catch (e) { return null; }
}
function sliderVal(id, dflt) { var el = $(id); var v = el ? parseInt(el.value, 10) : dflt; return isNaN(v) ? dflt : v; }
// (Removed the legacy Arial/Times applyCorrections + scheduleCorrections — superseded by the
// Metric⟷Optical bake. They referenced sliders that no longer exist.)
var _refRAF = 0;   // shared RAF token for scheduleMetricOptical's coalesced live drags
// ===== Metric ⟷ Optical bake: the primary spacing dial. Re-seats every glyph's
// sidebearings from metric (0%) toward optical comfort (100%) + bakes the residual
// optical pair kern. Deterministic (recomputed from the ink each apply) + symmetric.
function applyMetricOptical(commit) {
  if (!FEAT.optimize) return;
  var f = curFont(); if (!f) return;
  if (!f.glyphs.some(isFilled)) { if (commit) setStatus('Draw and assign some glyphs first.', 'err'); return; }
  // LEGACY pipeline guard: its dial sliders were removed from the DOM in the UI overhaul, so
  // sliderVal reads them all as 0 — baking that would be a destructive "reset to metric".
  // Only the optical-bearings mode (which needs just moTrack) still legitimately runs here.
  if (!f.optBearings && !$('moBlend') && !$('moBearingAI') && !$('moKern') && !$('moKernAI')) return;
  function setTxt(id, t) { if ($(id)) $(id).textContent = t; }
  var tB = sliderVal('moBlend', 0), aB = sliderVal('moBearingAI', 0);
  var tK = sliderVal('moKern', 0), aK = sliderVal('moKernAI', 0);
  var std = sliderVal('refSpace', 100), trk = sliderVal('moTrack', 0);
  f.moBlend = tB; f.moBearingAI = aB; f.moKern = tK; f.moKernAI = aK; f.refSpace = std; f.moTrack = trk;
  setTxt('moBlendVal', tB + '%'); setTxt('moBearingAIVal', aB + '%');
  setTxt('moKernVal', tK + '%'); setTxt('moKernAIVal', aK + '%');
  setTxt('refSpaceVal', std + '%'); setTxt('moTrackVal', (trk > 0 ? '+' : '') + trk + '%');
  // OPTICAL BEARINGS mode owns the sidebearings: the Metric⟷Optical/AI bearing dials are
  // overridden; only Tracking acts here (it re-seats every glyph's optical lines proportionally).
  // Kerning still ships live from opticalKern at export, so testing == export holds.
  if (f.optBearings) {
    applyOpticalBearings(f, curMasterId());
    renderRight(); scheduleTester(); if (commit) autosave();
    return true;
  }
  bakeAllOrigins(f);                                   // fold blue-line offsets first
  captureBaseline(f, curMasterId());                   // preserve drawn/hand-edited spacing as the base
  var opts = {
    tBearing: tB / 100, aiBearing: aB / 100, tKern: tK / 100, aiKern: aK / 100,
    track: Math.round(trk / 100 * (f.unitsPerEm || 1000)),   // static tracking, applied LAST + independent
    stdMul: std / 100,
    metricBase: f.spaceBase,                            // dials layer on top of THIS, not the class baseline
  };
  // The model's per-glyph recession feeds BOTH AI sliders. Use the cache when an AI dial is
  // up AND it still matches the current shapes (sbSig is bake-invariant). If it's missing/
  // stale we bake without it now and return aiStale so the caller can refresh it async.
  var aiStale = false;
  if (aB > 0 || aK > 0) {
    if (f._optBearings && f._sbSig === sbSig(f, curMasterId())) opts.optBearings = f._optBearings;
    else aiStale = true;
  }
  var r = optimizer.bakeMetricOptical(f, curMasterId(), opts);
  f.kerning = r.table;
  recordBaked(f, curMasterId());                        // remember what we produced (to detect later hand-edits)
  flatCache = {}; kernCache = {};
  renderRight(); renderFloatTester();                  // cheap live render on drag
  if (commit) {
    f.glyphs.forEach(function (g) { if (isFilled(g)) syncOpenGlyph(g); });
    renderGrid(); renderModGrid(); renderTesterText(); scheduleTester(); autosave();
    var bits = [];
    if (tB) bits.push('bearings ' + tB + '%' + (opts.optBearings && aB ? ' (AI ' + aB + '%)' : ''));
    if (tK) bits.push((r.kernPairs || 0) + ' kern pair' + (r.kernPairs === 1 ? '' : 's') + (opts.optBearings && aK ? ' (AI ' + aK + '%)' : ''));
    if (trk) bits.push('track ' + (trk > 0 ? '+' : '') + trk + '%');
    setStatus(bits.length ? 'Spacing — ' + bits.join(' · ') + '.' : 'Spacing reset to metric.', 'ok');
  }
  return aiStale;
}
// === 3-SLIDER SPACING — the modification panel is just Space + Tracking + AI Optic Optimization.
// AI Optic Optimization (t = aiOptic/100): blends each glyph from its RAW template-box position
// (f.spaceBase, captured by captureBaseline) toward the PARAGRAPH MODEL's per-letter optical bearing
// (f._aiOpt.bearings, from the model's analysis of that letter's combinations) + the residual
// exception kern. 0 = where the shape sits in the template box; 100 = full optimization. Tracking
// adds uniform letterspacing on top. Idempotent — every glyph re-seated to an ABSOLUTE target each
// call. The advances + f.kernOverride it writes are EXACTLY what exports (testing == export).
function seatRaw(f, mid) {
  if (!f.spaceBase) return;
  f.glyphs.forEach(function (g) {
    if (!isFilled(g)) return;
    var base = f.spaceBase[g.name]; if (!base) return;
    var L = g.layers[mid]; var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
    L.contours = shiftContoursXY(L.contours, Math.round(base.lsb) - b.xMin, 0);
    g.advanceWidth = Math.round(base.lsb + (b.xMax - b.xMin) + base.rsb);
  });
}
// === TWO-ENGINE optical optimizer (modification pipeline) =============================
// ensureAIOpt computes, per filled glyph, TWO absolute target bearings (cached by shape signature),
// then RESTORES the glyphs to their box baseline so the cache build never corrupts f.spaceBase:
//   PF — PER-FONT optical ("AI Optimization"): seat every glyph to a UNIFORM optHalf baseline so its
//        bad imported bearing is ignored, then measure THIS font's own optical white-area gaps and
//        derive each letter's optical LSB/RSB from its own shape + ink density. Normalizes imports.
//   AV — TRAINED average ("AI Average"): the sidebearing model (shape-optical bearing) + the paragraph
//        kern model's per-letter average — how the foundry corpus on AVERAGE spaces these letters.
// Plus `residual` = the per-font pair exceptions (AV/To…). applyAIOptic blends box → PF → AV → tracking.
function ensureAIOpt(f) {
  if (!f) return Promise.resolve();
  if (f._aiOptPending) return f._aiOptPending;  // in-flight guard: re-entry joins the running analysis
  var mid = curMasterId(); var sig = sbSig(f, mid);
  if (f._aiOpt && f._aiOptSig === sig) return Promise.resolve();
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilled(g) && g.char && g.unicode >= 0x21) filled.push(g); });
  bakeAllOrigins(f); captureBaseline(f, mid);   // lock in the box baseline BEFORE any scratch seating
  // leave the glyphs exactly where the box baseline says + record it, so applyAIOptic's own
  // captureBaseline sees no change and never mistakes a scratch seating for the user's spacing.
  function done(opt) {
    seatRaw(f, mid); recordBaked(f, mid); flatCache = {}; kernCache = {};
    f._aiOptPending = null;
    // a SHAPE edit that landed mid-predict makes this analysis stale — never stamp it fresh
    if (sbSig(f, mid) === sig) { f._aiOpt = opt; f._aiOptSig = sig; }
  }
  if (filled.length < 2) { done({ bearing: {}, residual: {} }); return Promise.resolve(); }
  var names = filled.map(function (g) { return g.name; });
  var upm = f.unitsPerEm || 1000, floor = Math.round(0.012 * upm);
  var optHalf = Math.round(optimizer.fontAirTargetUnits(f, mid) / 2);
  var weight = (f.meta && (f.meta.weightClass || f.meta.weight)) || 400;
  function seatTo(map) {
    filled.forEach(function (g) {
      var s = map[g.name]; if (!s) return;
      var L = g.layers[mid]; var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
      L.contours = shiftContoursXY(L.contours, Math.round(s.lsb) - b.xMin, 0);
      g.advanceWidth = Math.round(s.lsb + (b.xMax - b.xMin) + s.rsb);
    });
    flatCache = {}; kernCache = {};
    // record the scratch seating so a concurrent captureBaseline (slider drag during the
    // multi-second ONNX predict) sees cur == last and never adopts it as the user's baseline
    recordBaked(f, mid);
  }
  // geometric fallback air = the air you gave your WIDEST glyphs (~20th pct of box bearings), so a
  // box-filling W stays put while a thin I loses its slack — used only if the model is unavailable.
  var base = f.spaceBase || {}, boxAirs = [];
  filled.forEach(function (g) { var bb = base[g.name]; if (bb) { boxAirs.push(bb.lsb); boxAirs.push(bb.rsb); } });
  boxAirs.sort(function (a, b) { return a - b; });
  var airTarget = boxAirs.length ? Math.max(floor, boxAirs[Math.floor(0.2 * (boxAirs.length - 1))]) : optHalf;
  // ENGINE 1 — AI Optimizasyon (bearing): the trained sidebearing model reads THIS font's glyph SHAPES
  // and gives each letter its optical bearing — width-aware (a narrow letter like I gets a small advance,
  // a wide W a large one; round/open letters less air). Font-specific, learned from real fonts. Falls
  // back to a uniform geometric air-fit (box → airTarget) only if the model isn't available.
  var pending = Promise.resolve().then(function () { return spacingai.predict(f, mid, { weight: weight, root: ROOT }); })
    .catch(function () { return {}; }).then(function (rec) {
      rec = rec || {};
      var keys = 0; for (var rk in rec) { if (rec[rk]) keys++; }
      var bearing = {};
      if (keys >= Math.max(2, Math.floor(filled.length * 0.5))) {
        filled.forEach(function (g) { var r = rec[g.name] || {}; bearing[g.name] = { lsb: Math.max(floor, optHalf - Math.round(r.recL || 0)), rsb: Math.max(floor, optHalf - Math.round(r.recR || 0)) }; });
      } else {
        filled.forEach(function (g) { bearing[g.name] = { lsb: airTarget, rsb: airTarget }; });
      }
      // ENGINE 2 — AI Optik (kern): seat to those AI bearings, then the paragraph/optical model finds the
      // remaining PAIRWISE optical corrections (A-V, T-o…) — the genuine kern, decided per THIS font.
      seatTo(bearing);
      return kernai.predict(f, mid, filled, { root: ROOT }).then(function (seeds) {
        var resKV = kernvision.buildKernVision(f, mid, { aggr: 0.8, seeds: seeds || {} });
        var residual = {};
        for (var i = 0; i < filled.length; i++) for (var j = 0; j < filled.length; j++) {
          if (i === j) continue; var key = names[i] + ',' + names[j]; var v = resKV.table[key]; if (v) residual[key] = v;
        }
        done({ bearing: bearing, residual: residual });
      }).catch(function () { done({ bearing: bearing, residual: {} }); });
    }).catch(function () { done({ bearing: {}, residual: {} }); });
  f._aiOptPending = pending;
  return pending;
}
// The "Optik analiz et" button: read this font's shapes (model) for the OPTIC slider, then turn both the
// width-fit and the optical refinement on so the full optimum is visible.
function onAIOptimize() {
  if (!FEAT.optimize) { setStatus('Optimize is off for this build.', 'err'); return; }
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  if (!f.glyphs.some(isFilled)) { setStatus('Draw some glyphs first.', 'err'); return; }
  setStatus('AI Optimize — bu fontun şekillerini okuyor (bearing + optik kern)…');
  f._aiOpt = null; f._aiOptSig = null;                                       // force a fresh per-font analysis
  if ($('aiOptic') && (+($('aiOptic').value) || 0) === 0) { $('aiOptic').value = 100; }   // width fit on
  if ($('aiAvg') && (+($('aiAvg').value) || 0) === 0) { $('aiAvg').value = 100; }          // optical on
  setTimeout(function () { ensureAIOpt(f).then(function () { if (curFont() === f) applyAIOptic(true); }); }, 24);
}
// Apply: box → AI Optimizasyon (sB: each letter's AI optical bearing — narrow letters narrow a lot, wide
// ones little) → AI Optik (sO: leftover pairwise kern) → Tracking (LAST, equal both sides).
function applyAIOptic(commit) {
  if (!FEAT.optimize) return;
  var f = curFont(); if (!f) return;
  if (!f.glyphs.some(isFilled)) return;
  var mid = curMasterId();
  var sB = sliderVal('aiOptic', 0) / 100, sO = sliderVal('aiAvg', 0) / 100, trk = sliderVal('moTrack', 0);
  f.aiOptic = sliderVal('aiOptic', 0); f.aiAvg = sliderVal('aiAvg', 0); f.moTrack = trk;
  if ($('aiOpticVal')) $('aiOpticVal').textContent = f.aiOptic + '%';
  if ($('aiAvgVal')) $('aiAvgVal').textContent = f.aiAvg + '%';
  if ($('moTrackVal')) $('moTrackVal').textContent = (trk > 0 ? '+' : '') + trk + '%';
  // An AI analysis is measuring the SCRATCH-seated glyphs right now — don't fight it (and
  // don't corrupt its measurement) by re-seating mid-predict. The pending run's continuation
  // calls applyAIOptic again with the then-current slider values, so this drag isn't lost.
  if (f._aiOptPending) return;
  // After a .runetype reload the sliders persist but the analysis cache (_aiOpt) is gone —
  // re-analyze first instead of silently re-seating to the box and wiping the saved AI kern.
  if (!f._aiOpt && (sB > 0 || sO > 0)) {
    ensureAIOpt(f).then(function () { if (curFont() === f) applyAIOptic(commit); });
    return;
  }
  bakeAllOrigins(f); captureBaseline(f, mid);
  var ai = f._aiOpt || { bearing: {}, residual: {} };
  var bm = ai.bearing || {};
  var upm = f.unitsPerEm || 1000;
  var half = Math.round(trk / 100 * upm / 2);                            // tracking → equal both sides, LAST
  f.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return;
    if (!isFilled(g)) return;
    var base = f.spaceBase && f.spaceBase[g.name]; if (!base) return;
    var L = g.layers[mid]; var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
    var bg = bm[g.name];
    // BEARING (sB): box → the AI's optical bearing. A thin letter (I) drops from its wide box advance to a
    // small optical one (narrows a lot); a wide letter (W) is already near its bearing → it barely moves.
    var lsb = bg ? (base.lsb + sB * (bg.lsb - base.lsb)) : base.lsb;
    var rsb = bg ? (base.rsb + sB * (bg.rsb - base.rsb)) : base.rsb;
    lsb = Math.round(lsb) + half; rsb = Math.round(rsb) + half;          // tracking added LAST
    L.contours = shiftContoursXY(L.contours, lsb - b.xMin, 0);
    g.advanceWidth = Math.max(1, Math.round(lsb + (b.xMax - b.xMin) + rsb));   // floor so it never collapses
  });
  recordBaked(f, mid);
  // Kern = the pairwise exceptions left over after the optical bearings (A-V / T-o class). Tied to the
  // OPTIC slider (kerning is an optical refinement); drop sub-visual nudges, keep a generous cap.
  var kt = Math.min(sO, 1), ov = {};
  if (ai.residual && kt > 0) {
    var DEAD = Math.round(0.008 * upm);                       // ignore < ~0.8% em (sub-visual)
    var nFilled = 0; f.glyphs.forEach(function (g) { if (isFilled(g) && g.char && g.unicode >= 0x21) nFilled++; });
    var CAP = Math.max(80, Math.min(500, 4 * nFilled));       // generous — only a runaway guard
    var cand = [];
    for (var k in ai.residual) { var v = Math.round(kt * ai.residual[k]); if (Math.abs(v) >= DEAD) cand.push([k, v]); }
    cand.sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); });   // keep the biggest exceptions
    if (cand.length > CAP) cand.length = CAP;
    for (var ci = 0; ci < cand.length; ci++) ov[cand[ci][0]] = cand[ci][1];
  }
  // KERN OWNERSHIP: only touch f.kernOverride when the AI-kern slider owns it. A Tracking
  // nudge with Optik at 0 must not wipe a Visual-Kern table the user baked separately (or a
  // table restored from a saved .runetype). aiKernOwned persists (non-underscore) so a reload
  // still knows who wrote the table.
  if (kt > 0) { f.kernOverride = ov; f.aiKernOwned = true; }
  else if (f.aiKernOwned) { f.kernOverride = {}; f.aiKernOwned = false; }
  flatCache = {}; kernCache = {};
  // Composed accents are skipped by the bake loop above (kind==='composed'), so their metrics
  // stayed frozen at compose time — é/ç/ş drifted apart from their re-baked base e/c/s. On
  // commit, re-derive each self-composed glyph from its RE-BAKED base (composeAccent clones
  // the base's current contours + advance, so it inherits the new spacing; hand-drawn accents
  // are protected by the target-drawn guard because they carry no composedFrom marker).
  if (commit) {
    f.glyphs.forEach(function (g, gi) {
      if (!g.composedFrom || !g.char) return;
      try {
        // refresh lastSig so the live-sync poll doesn't read the recomposition back as a hand edit
        if (accentCompose.composeAccent(f, g.char, mid).ok) lastSig[gi] = glyphset.layerSignature(g, mid);
      } catch (e) {}
    });
  }
  renderRight(); renderFloatTester();
  if (commit) {
    f.glyphs.forEach(function (g) { if (isFilled(g)) syncOpenGlyph(g); });
    renderGrid(); renderModGrid(); renderTesterText(); scheduleTester(); autosave();
    var rk = 0; for (var kk in ov) rk++;
    setStatus('AI Optimizasyon ' + f.aiOptic + '% · Optik ' + f.aiAvg + '%' + (trk ? ' · track ' + (trk > 0 ? '+' : '') + trk + '%' : '') + ' — ' + rk + ' istisna kern.', 'ok');
  }
}
// A bake-INVARIANT signature of the drawn outlines (shape only — width/height/point
// count, NOT position or advance which the bake itself rewrites). Lets the cached AI
// prediction survive slider re-bakes but invalidate when a glyph's SHAPE is edited.
function sbSig(f, mid) {
  var s = 2166136261 >>> 0, n = 0;
  f.glyphs.forEach(function (g) {
    var L = g.layers && g.layers[mid]; if (!L || !L.contours || !L.contours.length) return;
    var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
    var pts = 0; for (var i = 0; i < L.contours.length; i++) pts += (L.contours[i].points ? L.contours[i].points.length : 0);
    var h = (g.name ? g.name.charCodeAt(0) : 0) + pts * 131 + Math.round(b.w) * 7 + Math.round(b.h) * 17 + L.contours.length * 53;
    s = (((s ^ h) >>> 0) * 16777619) >>> 0; n++;
  });
  return n + ':' + (s >>> 0);
}
// The METRIC baseline the spacing dials layer on top of = each glyph's DRAWN / hand-edited
// spacing, captured (and persisted in f.spaceBase) the first time we see it. We re-capture a
// glyph only when its spacing changed since OUR last bake (f._lastBaked) — i.e. the user
// hand-tuned it in the metrics editor or re-drew it — so manual tweaks become the new base
// instead of being wiped. After reload, _lastBaked is empty but spaceBase persists, so we
// keep the saved base (don't re-capture from already-baked spacing).
function captureBaseline(f, mid) {
  f.spaceBase = f.spaceBase || {}; f._lastBaked = f._lastBaked || {};
  f.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return;
    var L = g.layers && g.layers[mid]; if (!L || !L.contours || !L.contours.length) return;
    var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
    var cur = { lsb: Math.round(b.xMin), rsb: Math.round((g.advanceWidth || 0) - b.xMax) };
    var last = f._lastBaked[g.name];
    if (!f.spaceBase[g.name] || (last && (Math.abs(cur.lsb - last.lsb) > 1 || Math.abs(cur.rsb - last.rsb) > 1))) {
      f.spaceBase[g.name] = cur;
    }
  });
}
function recordBaked(f, mid) {
  f._lastBaked = f._lastBaked || {};
  f.glyphs.forEach(function (g) {
    var L = g.layers && g.layers[mid]; if (!L || !L.contours || !L.contours.length) return;
    var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return;
    f._lastBaked[g.name] = { lsb: Math.round(b.xMin), rsb: Math.round((g.advanceWidth || 0) - b.xMax) };
  });
}

// ===== OPTICAL BEARINGS — a symmetric, line-based per-glyph spacing mode (toggle f.optBearings).
// Each glyph stores g.ob = { sym, optL, optR } in FONT UNITS at T-neutral (tracking = 0):
//   sym  = the symmetric METRIC bearing — equal ink margin on BOTH sides, so the blue/red
//          sidebearing lines sit symmetric around the advance centre (the green centre line).
//   optL/optR = how far OUTSIDE its metric line each side's OPTICAL (dashed) line sits.
// The OPTICAL (dashed) lines are what EXPORTS. Tracking (moTrack %) scales every distance
// proportionally (−50% ⇒ ×0.5). Per glyph: LSB = (sym+optL)*T, RSB = (sym+optR)*T,
// advance = LSB + inkW + RSB, and lsbLineX = inkL − LSB folds the origin so the rest of the
// pipeline (bakeGlyphOrigin, export, opticalKern) is untouched → testing == export.
// MODEL: g.ob = { ocOff, hw } in FONT UNITS.
//   ocOff = the OPTICAL CENTRE offset from the ink's geometric middle — the GREEN line. The user
//           drags green to centre the glyph optically (manual); ocOff does NOT scale with tracking.
//   hw    = the symmetric HALF box-width — distance centre→blue and centre→red. Set by the AI
//           narrow/widen pass (per letter) or by dragging blue/red; hw SCALES with tracking.
// Per glyph: oc = inkCentre + ocOff; blue = oc − hw*T; red = oc + hw*T; advance = 2*hw*T;
// lsbLineX = blue. So the box is symmetric around the (manually-placed) optical centre, the box
// WIDTH is the AI/letter-driven part, and the rest of the pipeline (bakeGlyphOrigin, export,
// opticalKern) is untouched → testing == export.
function obTrack(f) { return Math.max(0.1, 1 + (f.moTrack || 0) / 100); }
function obInk(g, mid) {
  var L = g.layers && g.layers[mid]; if (!L || !L.contours || !L.contours.length) return null;
  var b = refspace.bezBounds(L.contours); if (!isFinite(b.xMin)) return null;
  return { L: b.xMin, R: b.xMax, W: b.xMax - b.xMin, C: (b.xMin + b.xMax) / 2 };
}
// Init (once) + return the glyph's optical-centre params with its live ink bounds.
function obParams(g, mid, f) {
  var ink = obInk(g, mid); if (!ink) return null;
  if (!g.ob || g.ob.hw == null) {
    var T = obTrack(f), lsbX = g.lsbLineX || 0, adv = g.advanceWidth || (ink.W + 80);
    var boxC = lsbX + adv / 2;                 // current box centre
    g.ob = { ocOff: Math.round(boxC - ink.C), hw: Math.round((adv / 2) / T) };   // no jump on enable
  }
  return { inkL: ink.L, inkR: ink.R, inkW: ink.W, inkC: ink.C, ocOff: g.ob.ocOff, hw: g.ob.hw };
}
// The three line x-positions (font units) at the current tracking: green centre, blue/red edges.
function obLines(g, mid, f) {
  var p = obParams(g, mid, f); if (!p) return null;
  var T = obTrack(f), oc = p.inkC + p.ocOff;
  return { center: oc, blue: oc - p.hw * T, red: oc + p.hw * T, T: T, p: p };
}
// Derive g.lsbLineX + g.advanceWidth from the box (centre ± half-width) at the current tracking.
function obSeat(g, mid, f) {
  var p = obParams(g, mid, f); if (!p) return;
  var T = obTrack(f), oc = p.inkC + p.ocOff;
  g.lsbLineX = Math.round(oc - p.hw * T);
  g.advanceWidth = Math.max(20, Math.round(2 * p.hw * T));
}
// Re-seat EVERY drawn glyph from its optical params (toggle-on, tracking change, shape edit).
function applyOpticalBearings(f, mid) {
  if (!f) return;
  f.glyphs.forEach(function (g) {
    if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return;
    if (obInk(g, mid)) obSeat(g, mid, f);
  });
}
// The Metric⟷Optical / AI BEARING dials belong to the Kerning tab; greyed while Optical-centre owns spacing.
function lockBearingDialsForOptical(on) {
  ['moBlend', 'moBearingAI', 'moKern', 'moKernAI'].forEach(function (id) { var e = $(id); if (e) { e.disabled = on; if (e.parentNode && e.parentNode.classList) e.parentNode.classList.toggle('dim', on); } });
}
// Modification sub-tab: 'kerning' (the slider stack) ↔ 'optical' (the green-centre line editor + AI
// width). Selecting 'optical' turns the optical-centre spacing mode ON (f.optBearings); 'kerning'
// turns it OFF. The previous kerning controls stay in the DOM but inactive on the optical tab.
function setCorrTab(tab) {
  var f = curFont(); if (!f) return;
  f.corrTab = (tab === 'optical') ? 'optical' : 'kerning';
  f.optBearings = (f.corrTab === 'optical');
  if (f.optBearings) applyOpticalBearings(f, curMasterId());   // seed + seat every glyph now
  syncCorrTab(f);
  renderRight(); scheduleTester(); autosave();
}
function syncCorrTab(f) {
  f = f || curFont(); var tab = (f && f.corrTab === 'optical') ? 'optical' : 'kerning';
  var tabs = document.querySelectorAll('.w-ctab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-corr-tab') === tab);
  var cc = document.querySelectorAll('.w-corr-content');
  for (var j = 0; j < cc.length; j++) cc[j].classList.toggle('hidden', cc[j].getAttribute('data-corr-tab') !== tab);
  lockBearingDialsForOptical(tab === 'optical');
}
// AI WIDTH (narrow/widen): the offline sidebearing model sets each letter's BOX WIDTH (g.ob.hw) from
// its shape — tight/heavy glyphs recede (narrow), open ones widen — while the user keeps CENTRING by
// hand with the green line (ocOff untouched). Safe-degrades if onnxruntime-web can't load the model.
var _aiWidthRunning = false;
function onAIOptWidth() {
  var f = curFont(), mid = curMasterId(); if (!f || _aiWidthRunning) return;
  if (!f.glyphs.some(isFilled)) { setStatus('Draw and assign some glyphs first.', 'err'); return; }
  _aiWidthRunning = true; setStatus('AI: harfe göre daralt/genişlet hesaplanıyor…', '');
  Promise.resolve().then(function () { return spacingai.predict(f, mid, { weight: masterWeight(f), root: ROOT }); })
    .then(function (sb) {
      if (curFont() !== f) return;
      if (!sb || !Object.keys(sb).length) { setStatus('AI modeli yüklenemedi — genişlik değişmedi.', 'err'); return; }
      var ref = optimizer.buildRef(f, mid);
      var optHalf = Math.round((optimizer.fontAirTargetUnits ? optimizer.fontAirTargetUnits(f, mid, ref) : 0.085 * (f.unitsPerEm || 1000)) / 2);
      var n = 0;
      f.glyphs.forEach(function (g) {
        if (g.kind === 'ligature' || g.kind === 'alternate' || g.kind === 'composed') return;
        var ink = obInk(g, mid); if (!ink) return;
        obParams(g, mid, f);                                 // ensure g.ob (keeps the user's ocOff centre)
        var rec = sb[g.name], recAvg = rec ? (((rec.recL || 0) + (rec.recR || 0)) / 2) : 0;
        g.ob.hw = Math.max(10, Math.round(ink.W / 2 + optHalf - recAvg));   // ink half + optical bearing, AI-tightened
        obSeat(g, mid, f); n++;
      });
      f._optBearings = sb; f._sbSig = sbSig(f, mid);
      renderRight(); scheduleTester(); autosave();
      setStatus('AI ' + n + ' harfin genişliğini ayarladı. Merkezlemeyi yeşil çizgiyle sen yap.', 'ok');
    })
    .catch(function (e) { setStatus('AI hata: ' + (e && e.message || e), 'err'); })
    .then(function () { _aiWidthRunning = false; });
}
// Ensure the model's per-glyph recession is cached + fresh, then bake. Called when an AI
// dial moves OR a plain dial commits while an AI dial is up but the cache went stale (shape
// edit). Async (onnxruntime-web); safe-degrades to uniform optical if unavailable.
var _aiPredicting = false;
async function ensureAISpacing() {
  if (!FEAT.optimize) return;
  var f = curFont(); if (!f) return;
  if (!f.glyphs.some(isFilled)) { setStatus('Draw and assign some glyphs first.', 'err'); return; }
  var mid = curMasterId();
  if (f._optBearings && f._sbSig === sbSig(f, mid)) { applyMetricOptical(true); return; }   // fresh → just bake
  if (_aiPredicting) return;                                          // a prediction is already in flight
  _aiPredicting = true;
  setStatus('AI spacing — reading glyph shapes…', 'info');
  try {
    var sig0 = sbSig(f, mid);                                          // shape AT predict time
    var sb = await spacingai.predict(f, mid, { weight: masterWeight(f), root: ROOT });
    if (curFont() !== f || sbSig(f, mid) !== sig0) return;             // font switched OR shape edited mid-run → discard
    if (!sb || !Object.keys(sb).length) {
      f._optBearings = null;
      setStatus('AI spacing unavailable (model could not load) — using uniform optical.', 'err');
      applyMetricOptical(true); return;
    }
    f._optBearings = sb; f._sbSig = sig0;                              // stamp the signature predict actually used
    applyMetricOptical(true);
    setStatus('AI spacing ready — model recession on ' + Object.keys(sb).length + ' glyph(s).', 'ok');
  } catch (e) {
    f._optBearings = null;
    setStatus('AI spacing failed: ' + (e && e.message || e), 'err');
    applyMetricOptical(true);
  } finally { _aiPredicting = false; }
}
// Context weight class for the model (the 8th-of feature). Map the master's style
// name to a usWeightClass; default Regular(400).
function masterWeight(f) {
  var m = (f.masters || []).filter(function (x) { return x.id === curMasterId(); })[0];
  var name = ((m && (m.type || m.name)) || 'regular').toLowerCase().replace(/[^a-z]/g, '');
  var W = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, heavy: 900, black: 900 };
  return W[name] || 400;
}
function scheduleMetricOptical() {
  if (_refRAF) return;
  var raf = (typeof window !== 'undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };
  _refRAF = raf(function () { _refRAF = 0; applyMetricOptical(false); });
}
function syncRefSlider() {                             // reflect the saved %s when (re)entering the page
  var f = curFont();
  function set(id, vid, val, signed) { var s = $(id); if (s) { s.value = val; if ($(vid)) $(vid).textContent = (signed && val > 0 ? '+' : '') + val + '%'; } }
  set('refSpace', 'refSpaceVal', (f && f.refSpace != null) ? f.refSpace : 100);
  set('moBlend', 'moBlendVal', (f && f.moBlend != null) ? f.moBlend : 0);
  set('moBearingAI', 'moBearingAIVal', (f && f.moBearingAI != null) ? f.moBearingAI : 0);
  set('moKern', 'moKernVal', (f && f.moKern != null) ? f.moKern : 0);
  set('moKernAI', 'moKernAIVal', (f && f.moKernAI != null) ? f.moKernAI : 0);
  set('moTrack', 'moTrackVal', (f && f.moTrack != null) ? f.moTrack : 0, true);
  set('aiOptic', 'aiOpticVal', (f && f.aiOptic != null) ? f.aiOptic : 0);   // AI Optimization (per-font)
  set('aiAvg', 'aiAvgVal', (f && f.aiAvg != null) ? f.aiAvg : 0);           // AI Average (trained)
  if (f) f.corrTab = f.optBearings ? 'optical' : (f.corrTab || 'kerning');
  try { syncCorrTab(f); } catch (e) {}     // tabs removed in the 3-slider UI; tolerate missing nodes
}
// ===== mini, no-API "assistant": pure heuristics that scan the font and surface a
// few plain-language observations + a suggested next move. It only reads stats
// (spacing, heights, coverage) — no network, no model — and never changes anything.
var analyzeRec = null;   // Analyze's recommended { standard, optical }, applied by Optimize
function aiAnalyze() {
  var f = curFont(); var box = $('aiReport'); if (!box) return;
  if (!f) { box.innerHTML = ''; return; }
  var mid = curMasterId(), upm = f.unitsPerEm || 1000, M = f.metrics || {};
  var filled = f.glyphs.filter(function (g) { return isFilled(g) && g.char != null && g.kind !== 'ligature' && g.kind !== 'composed'; });
  var notes = [];
  if (filled.length < 2) { box.innerHTML = '<div class="ai-note">Draw a few glyphs first — then I can analyse spacing, heights and coverage.</div>'; return; }
  // --- spacing rhythm: flag side-bearing outliers vs the median ---
  var sbs = [], info = [];
  filled.forEach(function (g) {
    var b = refspace.bezBounds(g.layers[mid].contours); if (!isFinite(b.xMin)) return;
    var lx = g.lsbLineX || 0, lsb = Math.round(b.xMin - lx), rsb = Math.round((g.advanceWidth || 0) - (b.xMax - lx));
    sbs.push(lsb); sbs.push(rsb); info.push({ g: g, lsb: lsb, rsb: rsb, w: b.w });
  });
  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? a[a.length >> 1] : 0; }
  var med = median(sbs) || Math.round(0.06 * upm), tight = [], loose = [];
  info.forEach(function (d) {
    if (d.lsb < med * 0.25 || d.rsb < med * 0.25) tight.push(d.g.char);
    if (d.lsb > med * 2.5 || d.rsb > med * 2.5) loose.push(d.g.char);
  });
  if (tight.length) notes.push(['tight', tight.length + ' glyph(s) look tight: ' + tight.slice(0, 12).join(' ') + ' — Standard at a higher % or Optical may even them out.']);
  if (loose.length) notes.push(['loose', loose.length + ' glyph(s) look loose: ' + loose.slice(0, 12).join(' ') + ' — a lower Standard % tightens them.']);
  // --- cap-height consistency ---
  var caps = filled.filter(function (g) { return g.char >= 'A' && g.char <= 'Z'; })
    .map(function (g) { return { c: g.char, h: refspace.bezBounds(g.layers[mid].contours).yMax }; });
  if (caps.length >= 3) {
    var hs = caps.map(function (c) { return c.h; }), mh = median(hs);
    var off = caps.filter(function (c) { return mh && Math.abs(c.h - mh) > mh * 0.06; });
    if (off.length) notes.push(['height', 'Cap heights vary: ' + off.slice(0, 8).map(function (c) { return c.c + '(' + (c.h > mh ? '+' : '') + Math.round((c.h - mh) / mh * 100) + '%)'; }).join(' ') + ' — consider matching them to the cap line.']);
    else notes.push(['ok', 'Cap heights are consistent (within 6%). 👍']);
  }
  // --- baseline alignment: flag glyphs whose ink bottom strays from the baseline,
  //     and say which way to nudge them (vertical is a manual move in the editor) ---
  var DESC = 'gjpqyµ', base = [];
  filled.forEach(function (g) {
    if (g.char.length === 1 && DESC.indexOf(g.char) >= 0) return;   // descenders legitimately dip
    base.push({ c: g.char, y: refspace.bezBounds(g.layers[mid].contours).yMin });
  });
  if (base.length >= 3) {
    var mb = median(base.map(function (d) { return d.y; }));
    var stray = base.filter(function (d) { return Math.abs(d.y - mb) > 0.06 * upm; });
    if (stray.length) notes.push(['vert', stray.length + ' glyph(s) sit off the baseline — ' + stray.slice(0, 8).map(function (d) { return d.c + (d.y > mb ? '↓' : '↑'); }).join(' ') + ' (↓ = drop it down to the line, ↑ = lift it up).']);
  }
  // --- coverage ---
  var total = f.glyphs.filter(function (g) { return g.char != null; }).length;
  notes.push(['cover', filled.length + ' of ' + total + ' glyphs drawn (' + Math.round(filled.length / total * 100) + '%).']);
  // --- a single suggested next move ---
  var sug = tight.length > loose.length ? 'Try Standard ≈ 120% to open the rhythm, then Optical ≈ 30%.'
    : (loose.length ? 'Try Standard ≈ 85% to tighten, then Optical ≈ 30%.'
      : 'Spacing looks even — a touch of Optical (≈ 25%) will refine the round/diagonal letters.');
  notes.push(['sug', '✦ Suggestion: ' + sug]);
  box.innerHTML = notes.map(function (nz) { return '<div class="ai-note ai-' + nz[0] + '">' + nz[1].replace(/</g, '&lt;') + '</div>'; }).join('');
  // recommendation that Optimize applies to the Standard / Optical sliders
  analyzeRec = { standard: tight.length > loose.length ? 120 : (loose.length ? 85 : 100), optical: (tight.length + loose.length) >= 2 ? 30 : 25 };
  setStatus('Assistant analysed ' + filled.length + ' glyph(s).', 'ok');
}
// ===== metrics & spacing editor (right pane of modification.) — ghost metric
// lines + optic allowances; drag the shape, its transform handles, the blue
// ink-left line (LSB) or the red advance line.
var mxSel = false, mxDrag = null, mxView = defaultView(), mxHandMode = 'off'; // 'off' | 'pan' | 'lock'
function shiftContoursXY(contours, dx, dy) { return transformContours(contours, 1, dx, dy); }
// The blue LSB line can sit off the storage origin (g.lsbLineX). Fold that offset
// into the outline so the built font's pen origin lands on the blue line:
// LSB = ink.minX - lsbLineX, advance = the box width (already stored). Used at
// export and preview build, and in-place before batch spacing ops.
function bakeGlyphOrigin(g) {
  var lx = g.lsbLineX || 0; if (!lx) return;
  Object.keys(g.layers).forEach(function (mid) {
    var l = g.layers[mid];
    if (l && l.contours && l.contours.length) l.contours = shiftContoursXY(l.contours, -lx, 0);
  });
  g.lsbLineX = 0;
}
function bakeAllOrigins(f) { f.glyphs.forEach(bakeGlyphOrigin); }
// the glyph's OWN construction grid as faint reference markup (em grid + items)
function glyphGridSvg(gd, vb) {
  var s = '';
  // grid + lines span the visible rect (vb) so they fill the frame at any zoom;
  // fall back to the em square when no view bounds are supplied
  var X0 = vb ? vb.x0 : 0, X1 = vb ? vb.x1 : 1000, Y0 = vb ? vb.y0 : -200, Y1 = vb ? vb.y1 : 800;
  if (gd.gridOn) {
    var c = gd.gridCell || 50, mul = gd.gridMul || 1, k, q;
    function gl(x1, y1, x2, y2, major) {
      s += '<line x1="' + gdXs(x1) + '" y1="' + gdYs(y1) + '" x2="' + gdXs(x2) + '" y2="' + gdYs(y2) +
           '" stroke="' + (major ? '#c0271d' : '#cfcfcf') + '" stroke-width="' + (major ? 1.2 : 0.7) + '"/>';
    }
    for (k = Math.floor((X0 - 500) / c); k <= Math.ceil((X1 - 500) / c); k++) { q = (mul === 2 && k % 2 === 0); gl(500 + k * c, Y1, 500 + k * c, Y0, q); }
    for (k = Math.floor((Y0 - 300) / c); k <= Math.ceil((Y1 - 300) / c); k++) { q = (mul === 2 && k % 2 === 0); gl(X0, 300 + k * c, X1, 300 + k * c, q); }
  }
  (gd.items || []).forEach(function (it) { s += gdItemSvg(it, it.red ? '#c0271d' : '#333333', 1.6, it.type === 'dline', null, false); });
  return s;
}
function mxRedraw(svg) {
  var f = curFont(), g = selGlyph(), M = f.metrics;
  var v = mxView;
  var s = '<rect x="0" y="0" width="' + GD_W + '" height="' + GD_H + '" rx="4" fill="#ffffff"/>';
  // everything below pans/zooms with the view, so lines/shapes dragged off the
  // canvas can always be brought back (scroll = zoom, drag empty = pan, dbl-click = reset)
  s += '<g transform="translate(' + v.x + ' ' + v.y + ') scale(' + v.s + ')">';
  var vb = viewFontBounds(v);   // visible rect so the grid + rulers fill the frame
  // the selected glyph's construction grid, shown faint (25%) behind the metrics
  if (g) s += '<g opacity="0.25">' + glyphGridSvg(glyphGD(g), vb) + '</g>';
  function HL(y, col, wd, dash) {
    s += '<line x1="' + gdXs(vb.x0) + '" y1="' + gdYs(y) + '" x2="' + gdXs(vb.x1) + '" y2="' + gdYs(y) +
         '" stroke="' + col + '" stroke-width="' + wd + '"' + (dash ? ' stroke-dasharray="6 5"' : '') + '/>';
  }
  // ghost metrics + optic (overshoot) allowances
  HL(M.ascender, '#c6c6c6', 0.8); HL(M.capHeight, '#9a9a9a', 1.1); HL(M.xHeight, '#9a9a9a', 1.1);
  HL(0, '#555555', 1.5); HL(M.descender, '#c6c6c6', 0.8);
  var OV = 15;
  HL(-OV, '#cfcfcf', 0.8, true); HL(M.capHeight + OV, '#cfcfcf', 0.8, true); HL(M.xHeight + OV, '#cfcfcf', 0.8, true);
  if (g) {
    var l = g.layers[curMasterId()];
    var cs2 = (l && l.contours && l.contours.length) ? l.contours : null;
    // the blue LSB line and red advance line are INDEPENDENT of the ink. lsbX is
    // the blue line's own x (the left-bearing origin); adv is the box width. The
    // shape, the blue line and the red line each move on their own — the ink may
    // freely cross the blue line. The lsbX offset is folded into the outline only
    // at build/export time (bakeGlyphOrigin), so nothing here moves another thing.
    var lsbX = (mxDrag && mxDrag.mode === 'lsb') ? mxDrag.lsbX : (g.lsbLineX || 0);
    var adv = (mxDrag && (mxDrag.mode === 'adv' || mxDrag.mode === 'lsb')) ? mxDrag.adv : (g.advanceWidth || 600);
    if (cs2) {
      var shape = (mxDrag && mxDrag.mode === 'scale') ? mxDrag.live : cs2;
      var sdx = (mxDrag && mxDrag.mode === 'shape') ? mxDrag.dx : 0;   // only the shape drag moves the ink
      var sdy = (mxDrag && mxDrag.mode === 'shape') ? mxDrag.dy : 0;
      s += '<path d="' + gdShapePath(shape, sdx, sdy) + '" fill="#1d1d1d" fill-rule="nonzero" data-shape="1" style="cursor:move"/>';
      var b = gdShapeBounds(shape, sdx, sdy);
      if (b && mxSel) {
        var x1 = gdXs(b.minX), x2 = gdXs(b.maxX), yT = gdYs(b.maxY), yB = gdYs(b.minY);
        var cxm = (x1 + x2) / 2, cym = (yT + yB) / 2;
        s += '<rect x="' + x1 + '" y="' + yT + '" width="' + (x2 - x1) + '" height="' + (yB - yT) + '" fill="none" stroke="#1473e6" stroke-width="1"/>';
        var HD = [['nw', x1, yT, 'nwse-resize'], ['n', cxm, yT, 'ns-resize'], ['ne', x2, yT, 'nesw-resize'], ['e', x2, cym, 'ew-resize'],
                  ['se', x2, yB, 'nwse-resize'], ['s', cxm, yB, 'ns-resize'], ['sw', x1, yB, 'nesw-resize'], ['w', x1, cym, 'ew-resize']];
        for (var hi = 0; hi < HD.length; hi++) {
          s += '<rect data-h="' + HD[hi][0] + '" x="' + (HD[hi][1] - 4) + '" y="' + (HD[hi][2] - 4) + '" width="8" height="8" fill="#fff" stroke="#1473e6" stroke-width="1.2" style="cursor:' + HD[hi][3] + '"/>';
        }
      }
      if (b) {
        s += '<text x="' + (gdXs(lsbX) + 4) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#1473e6">LSB ' + Math.round(b.minX - lsbX) + '</text>';
        s += '<text x="' + (gdXs(lsbX + adv) - 110) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#8d8d8d">RSB ' + Math.round((lsbX + adv) - b.maxX) + '</text>';
      }
    }
    var vyT = gdYs(vb.y1), vyB = gdYs(vb.y0);   // vertical lines span the visible height
    // storage origin (x=0) — a faint dashed reference the ink may cross
    var ox0 = gdXs(0);
    s += '<line x1="' + ox0 + '" y1="' + vyT + '" x2="' + ox0 + '" y2="' + vyB + '" stroke="#d7d7d7" stroke-width="1" stroke-dasharray="3 4"/>';
    // ===== OPTICAL-CENTRE mode: 3 lines. GREEN centre is the draggable master — drag it to place
    // the optical centre; the BLUE/RED box edges (= the exported LSB/RSB) translate symmetrically
    // with it. Drag blue or red to set the symmetric box WIDTH (the AI narrow/widen pass sets this
    // per letter). Live drag values preview here.
    if (f && f.optBearings && cs2 && obInk(g, curMasterId())) {
      var _p = obParams(g, curMasterId(), f), _T = obTrack(f), _inkC = _p.inkC;
      var _ocOff = (mxDrag && mxDrag.mode === 'obscen') ? mxDrag.ocOff : _p.ocOff;
      var _hw = (mxDrag && mxDrag.mode === 'obhw') ? mxDrag.hw : _p.hw;
      var _oc = _inkC + _ocOff, _blue = _oc - _hw * _T, _red = _oc + _hw * _T;
      var VL = function (xu, col, w, dash, mxk, hit) {
        var X = gdXs(xu);
        s += '<line x1="' + X + '" y1="' + vyT + '" x2="' + X + '" y2="' + vyB + '" stroke="' + col + '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="7 5"' : '') + '/>';
        if (mxk) s += '<line data-mx="' + mxk + '" x1="' + X + '" y1="' + vyT + '" x2="' + X + '" y2="' + vyB + '" stroke="#000" stroke-opacity="0" stroke-width="' + (hit || 14) + '" pointer-events="stroke" style="cursor:ew-resize"/>';
      };
      // faint ink-middle tick so the user sees how far off-centre the optical centre sits
      VL(_inkC, '#bfbfbf', 1, true, null, 0);
      VL(_blue, '#1473e6', 2.2, false, 'obhw', 14);            // box LEFT edge = exported LSB
      VL(_red, '#c0271d', 2.2, false, 'obhw', 14);             // box RIGHT edge = exported RSB
      VL(_oc, '#11a36a', 2.6, false, 'obscen', 16);            // GREEN optical centre — the master
      s += '<text x="' + (gdXs(_blue) + 3) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#1473e6">LSB ' + Math.round(_p.inkL - _blue) + '</text>';
      s += '<text x="' + (gdXs(_red) - 56) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#c0271d">RSB ' + Math.round(_red - _p.inkR) + '</text>';
      s += '<text x="' + (gdXs(_oc) + 3) + '" y="' + (gdYs(-200) + 30) + '" font-size="9" fill="#11a36a">centre ' + (_ocOff > 0 ? '+' : '') + _ocOff + '</text>';
    } else {
      // blue LSB line — independent + draggable
      var lx = gdXs(lsbX);
      s += '<line x1="' + lx + '" y1="' + vyT + '" x2="' + lx + '" y2="' + vyB + '" stroke="#1473e6" stroke-width="2.2"/>';
      s += '<line data-mx="lsb" x1="' + lx + '" y1="' + vyT + '" x2="' + lx + '" y2="' + vyB + '" stroke="#000" stroke-opacity="0" stroke-width="16" pointer-events="stroke" style="cursor:ew-resize"/>';
      // red advance line at the box right edge (lsbX + adv) — independent + draggable
      var rx = gdXs(lsbX + adv);
      s += '<line x1="' + rx + '" y1="' + vyT + '" x2="' + rx + '" y2="' + vyB + '" stroke="#c0271d" stroke-width="2.2"/>';
      s += '<line data-mx="adv" x1="' + rx + '" y1="' + vyT + '" x2="' + rx + '" y2="' + vyB + '" stroke="#000" stroke-opacity="0" stroke-width="14" pointer-events="stroke" style="cursor:ew-resize"/>';
      s += '<text x="' + (rx - 52) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#c0271d">ADV ' + Math.round(adv) + '</text>';
    }
  }
  s += '</g>';
  svg.innerHTML = s;
}
function mxCommit(g, contours, adv) {
  var f = curFont();
  glyphset.setGlyphContours(f, selectedSlot, curMasterId(), contours, adv != null ? adv : g.advanceWidth);
  // OPTICAL BEARINGS: if the shape moved/scaled, re-derive the advance from the optical lines on
  // the NEW ink so the symmetric/optical spacing stays true (obSeat writes g.advanceWidth +
  // g.lsbLineX directly; line drags already passed the seated advance above).
  if (f && f.optBearings) obSeat(g, curMasterId(), f);
  lastSig[selectedSlot] = glyphset.layerSignature(g, curMasterId());
  syncOpenGlyph(g);
  renderGrid(); renderModGrid(); scheduleTester(); autosave();
}
function renderMetricsEditor() {
  var box = $('w-designer'); if (!box) return;
  box.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'gd-wrap';
  wrap.innerHTML = '<div class="gd-mid"><div class="gd-stage">' +
    '<button class="mx-hand" type="button" title="Freeform: click → pan/zoom (blue) · click → lock the view in place (red) · click → recenter"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7-4l-2.5-4a2 2 0 0 1 3.5-2L8 14"/></svg></button>' +
    '<svg class="gd-canvas" viewBox="0 0 ' + GD_W + ' ' + GD_H + '" preserveAspectRatio="xMidYMid meet"></svg>' +
    '</div></div>';
  box.appendChild(wrap);
  var svg = wrap.querySelector('.gd-canvas');
  mxHandMode = 'off';              // fresh editing mode whenever the glyph/section changes
  mxView = defaultView();          // ...and 30%-zoomed-out framing so all is visible
  var handBtn = wrap.querySelector('.mx-hand');
  // 3-state freeform tool: off (edit, default view) → BLUE pan/zoom (freeform) →
  // RED locked (view frozen where you left it, editing re-enabled) → off (recenter)
  function setHandMode(mode) {
    mxHandMode = mode;
    handBtn.classList.toggle('pan', mode === 'pan');
    handBtn.classList.toggle('lock', mode === 'lock');
    svg.style.cursor = mode === 'pan' ? 'grab' : 'default';
    if (mode === 'off') mxView = defaultView();   // returning to off recenters
    mxRedraw(svg);
  }
  handBtn.addEventListener('click', function () {
    setHandMode(mxHandMode === 'off' ? 'pan' : (mxHandMode === 'pan' ? 'lock' : 'off'));
  });
  function fit() {
    var sz = paneCanvasSize();
    svg.style.width = sz.w + 'px';
    svg.style.height = sz.h + 'px';
  }
  function pointOf(ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var pp = pt.matrixTransform(svg.getScreenCTM().inverse());
    var v = mxView;
    var px = (pp.x - v.x) / v.s, py = (pp.y - v.y) / v.s;
    return { fx: (px - GD_PX) / GD_SX, fy: 800 - (py - GD_PY) / GD_SY, sx: pp.x, sy: pp.y };
  }
  // scroll to zoom toward the cursor — only in freeform (blue) mode
  wrap.addEventListener('wheel', function (ev) {
    if (mxHandMode !== 'pan') return;
    ev.preventDefault();
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var pp = pt.matrixTransform(svg.getScreenCTM().inverse());
    var ns = Math.max(0.4, Math.min(6, mxView.s * (ev.deltaY > 0 ? 0.9 : 1.1)));
    mxView.x = pp.x - (pp.x - mxView.x) * (ns / mxView.s);
    mxView.y = pp.y - (pp.y - mxView.y) * (ns / mxView.s);
    mxView.s = ns;
    mxRedraw(svg);
  }, { passive: false });
  // double-click empty space to recenter/reset the view
  svg.addEventListener('dblclick', function () { mxView = defaultView(); mxRedraw(svg); });
  svg.addEventListener('mousedown', function (ev) {
    ev.preventDefault();
    var pq = pointOf(ev);
    if (mxHandMode === 'pan') { mxDrag = { mode: 'pan', px: pq.sx, py: pq.sy, vx: mxView.x, vy: mxView.y }; return; }  // freeform: drag pans
    var g = selGlyph(); if (!g) return;
    var l = g.layers[curMasterId()];
    var cs2 = (l && l.contours && l.contours.length) ? l.contours : null;
    var hd = ev.target.closest ? ev.target.closest('[data-h]') : null;
    if (hd && cs2) {
      mxDrag = { mode: 'scale', h: hd.getAttribute('data-h'), b: gdShapeBounds(cs2, 0, 0), orig: JSON.parse(JSON.stringify(cs2)), live: cs2 };
      return;
    }
    var mk = ev.target.closest ? ev.target.closest('[data-mx]') : null;
    if (mk) {
      var mkMode = mk.getAttribute('data-mx');
      // OPTICAL-CENTRE handles: obscen = GREEN centre (move the optical centre, blue/red follow);
      // obhw = blue/red box edge (symmetric half-width). Both change g.ob, then re-seat the advance.
      if (mkMode === 'obscen' || mkMode === 'obhw') {
        var _op = obParams(g, curMasterId(), curFont());
        if (_op) mxDrag = { mode: mkMode, ocOff: _op.ocOff, hw: _op.hw, inkC: _op.inkC, T: obTrack(curFont()) };
        return;
      }
      var lsb0 = g.lsbLineX || 0, adv0 = g.advanceWidth || 600;
      // lsb drag moves only the blue line and holds the red line fixed (redX0);
      // adv drag moves only the red line and holds the blue line fixed (lsbX)
      if (mkMode === 'lsb') mxDrag = { mode: 'lsb', sx: pq.fx, lsb0: lsb0, lsbX: lsb0, adv0: adv0, adv: adv0, redX0: lsb0 + adv0 };
      else mxDrag = { mode: 'adv', sx: pq.fx, adv0: adv0, adv: adv0, lsbX: lsb0 };
      return;
    }
    var sh = ev.target.closest ? ev.target.closest('[data-shape]') : null;
    if (sh && cs2) { mxSel = true; mxDrag = { mode: 'shape', sx: pq.fx, sy: pq.fy, dx: 0, dy: 0 }; mxRedraw(svg); return; }
    mxSel = false; mxRedraw(svg);   // empty space (hand off): just deselect — use the hand tool to pan
  });
  function onMove(ev) {
    if (!mxDrag) return;
    var pq = pointOf(ev);
    if (mxDrag.mode === 'pan') {
      mxView.x = mxDrag.vx + (pq.sx - mxDrag.px);
      mxView.y = mxDrag.vy + (pq.sy - mxDrag.py);
      mxRedraw(svg);
      return;
    }
    if (mxDrag.mode === 'shape') {
      mxDrag.dx = Math.round(pq.fx - mxDrag.sx);
      mxDrag.dy = Math.round(pq.fy - mxDrag.sy);
      mxRedraw(svg);
    } else if (mxDrag.mode === 'lsb') {
      mxDrag.lsbX = Math.round(mxDrag.lsb0 + (pq.fx - mxDrag.sx));
      mxDrag.adv = Math.max(20, mxDrag.redX0 - mxDrag.lsbX); // hold the red line fixed
      mxRedraw(svg);
    } else if (mxDrag.mode === 'adv') {
      mxDrag.adv = Math.max(20, Math.round(mxDrag.adv0 + (pq.fx - mxDrag.sx)));
      mxRedraw(svg);
    } else if (mxDrag.mode === 'obscen') {        // GREEN centre → move the optical centre (blue/red follow)
      mxDrag.ocOff = Math.round(pq.fx - mxDrag.inkC);
      mxRedraw(svg);
    } else if (mxDrag.mode === 'obhw') {          // blue/red edge → symmetric half box-width
      var _oc = mxDrag.inkC + mxDrag.ocOff;
      mxDrag.hw = Math.max(10, Math.round(Math.abs(pq.fx - _oc) / mxDrag.T));
      mxRedraw(svg);
    } else if (mxDrag.mode === 'scale') {
      var b = mxDrag.b, h = mxDrag.h;
      var ax = h.indexOf('w') >= 0 ? b.maxX : (h.indexOf('e') >= 0 ? b.minX : (b.minX + b.maxX) / 2);
      var ay = h.indexOf('s') >= 0 ? b.maxY : (h.indexOf('n') >= 0 ? b.minY : (b.minY + b.maxY) / 2);
      var hx0 = h.indexOf('w') >= 0 ? b.minX : (h.indexOf('e') >= 0 ? b.maxX : null);
      var hy0 = h.indexOf('s') >= 0 ? b.minY : (h.indexOf('n') >= 0 ? b.maxY : null);
      var sx = hx0 != null ? (pq.fx - ax) / (hx0 - ax) : null;
      var sy = hy0 != null ? (pq.fy - ay) / (hy0 - ay) : null;
      var SX, SY;
      if (ev.shiftKey) { SX = sx != null ? Math.max(0.05, sx) : 1; SY = sy != null ? Math.max(0.05, sy) : 1; }
      else { var sP = sx != null && sy != null ? Math.max(Math.abs(sx), Math.abs(sy)) : (sx != null ? Math.abs(sx) : Math.abs(sy)); SX = SY = Math.max(0.05, sP); }
      mxDrag.live = gdScaleContours(mxDrag.orig, ax, ay, SX, SY);
      mxRedraw(svg);
    }
  }
  function onUp() {
    if (!mxDrag) return;
    var g = selGlyph();
    if (g) {
      var l = g.layers[curMasterId()];
      var cs2 = (l && l.contours && l.contours.length) ? l.contours : null;
      if (mxDrag.mode === 'shape' && cs2 && (mxDrag.dx || mxDrag.dy)) mxCommit(g, shiftContoursXY(cs2, mxDrag.dx, mxDrag.dy));
      else if (mxDrag.mode === 'lsb') { g.lsbLineX = mxDrag.lsbX; mxCommit(g, cs2 || [], mxDrag.adv); } // move only the blue line
      else if (mxDrag.mode === 'adv') mxCommit(g, cs2 || [], mxDrag.adv);
      else if (mxDrag.mode === 'obscen' || mxDrag.mode === 'obhw') {
        g.ob = g.ob || {}; if (mxDrag.mode === 'obscen') g.ob.ocOff = mxDrag.ocOff; else g.ob.hw = mxDrag.hw;
        obSeat(g, curMasterId(), curFont());   // re-derive lsbLineX + advance from centre ± half-width
        mxCommit(g, cs2 || [], g.advanceWidth);
      }
      else if (mxDrag.mode === 'scale' && mxDrag.live) mxCommit(g, mxDrag.live);
    }
    mxDrag = null;
    mxRedraw(svg);
  }
  bindPaneWindow(onMove, onUp, function () { fit(); mxRedraw(svg); });
  fit(); mxRedraw(svg);
}

// ---- language filter tabs (multi-select; overflow fades into …) ----
function renderFilters() {
  var box = $('w-filters'); if (!box) return;
  box.innerHTML = '';
  var f = curFont();
  var keys = [];
  f.glyphs.forEach(function (g) { if (keys.indexOf(g.alphabet) < 0) keys.push(g.alphabet); });
  function chip(label, key) {
    var c = document.createElement('div');
    var on = key === null ? alphaFilters.length === 0 : alphaFilters.indexOf(key) >= 0;
    c.className = 'fchip' + (on ? ' active' : '');
    c.textContent = label;
    c.title = label;
    c.addEventListener('click', function () {
      if (key === null) alphaFilters = [];
      else {
        var ix = alphaFilters.indexOf(key);
        if (ix >= 0) alphaFilters.splice(ix, 1); else alphaFilters.push(key);
      }
      renderFilters(); renderGrid();
    });
    box.appendChild(c);
  }
  chip('All', null);
  keys.forEach(function (k) {
    var al = charsets.ALPHABET_BY_KEY[k];
    chip(al ? al.label : k, k);
  });
  // ellipsis when the tabs don't fit
  box.classList.toggle('overflowing', box.scrollWidth > box.clientWidth + 1);
}

// ---- open a glyph: ALWAYS its own Illustrator project (never an artboard) ----
function openGlyph(i) {
  openGlyphIndex = i;
  pollMs = POLL_MS; pollSelMs = POLL_SEL_MS; pollIdle = 0; templateUntil = 0;   // entering a glyph edit → resume live-sync at once
  var f = curFont(), g = f.glyphs[i];
  var layer = g.layers[curMasterId()];
  var gd = glyphGD(g);
  var cfg = {
    metrics: f.metrics, unitsPerEm: f.unitsPerEm, advanceWidth: g.advanceWidth,
    name: g.name, char: g.char, ghost: g.ghost || g.char || '',
    grids: dna.designToGrids(gd, f.unitsPerEm),   // the glyph's OWN grid
    contours: (layer && layer.contours) ? layer.contours : [],
  };
  setStatus('Opening "' + glyphLabel(g) + '" project…');
  evalScript('fmOpenGlyph(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus((r.reused ? 'Switched to' : 'Opened') + ' "' + glyphLabel(g) + '" · edits sync live', 'ok');
    else setStatus('Could not open glyph: ' + ((r && r.error) || '?'), 'err');
  });
}

// ---- right-click options on a glyph cell: delete shape / delete glyph / open ----
function closeGlyphMenu() { var m = document.getElementById('glyphMenu'); if (m && m.parentNode) m.parentNode.removeChild(m); }
function showGlyphMenu(ev, slot) {
  ev.preventDefault(); ev.stopPropagation();
  closeGlyphMenu();
  var f = curFont(), g = f && f.glyphs[slot]; if (!g) return;
  selectedSlot = slot; updateAssign(); renderGrid(); renderModGrid(); renderRight();
  var m = document.createElement('div'); m.id = 'glyphMenu'; m.className = 'ctx-menu';
  function item(label, enabled, danger, fn) {
    var b = document.createElement('button');
    b.className = 'ctx-item' + (enabled ? (danger ? ' danger' : '') : ' dim');
    b.textContent = label;
    if (enabled) b.addEventListener('click', function () { closeGlyphMenu(); fn(); });
    m.appendChild(b);
  }
  item('Delete shape', isFilled(g), true, function () { ctxDeleteShape(slot); });
  item('Delete glyph', true, true, function () { ctxDeleteGlyph(slot); });
  item('Open in Illustrator', true, false, function () { openGlyph(slot); });
  document.body.appendChild(m);
  var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = Math.max(4, Math.min(ev.clientX, vw - mw - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(ev.clientY, vh - mh - 6)) + 'px';
}
function ctxDeleteShape(slot) {
  var f = curFont(), g = f.glyphs[slot]; if (!g) return;
  var mid = curMasterId();
  g.layers[mid] = { contours: [] }; g.lsbLineX = 0;
  lastSig[slot] = glyphset.layerSignature(g, mid); flatCache = {}; kernCache = {};
  syncOpenGlyph(g);
  renderGrid(); renderModGrid(); updateAssign(); renderRight(); scheduleTester(); autosave();
  setStatus('Cleared the shape of "' + glyphLabel(g) + '".', 'ok');
}
// ---- testing.: right-click a letter to swap in one of ITS alternates (only that
// occurrence — not every S, just the S you clicked) ----
function closeTesterAltMenu() { var m = document.getElementById('testerAltMenu'); if (m && m.parentNode) m.parentNode.removeChild(m); }
function showTesterAltMenu(ev, ti) {
  if (!FEAT.alternates) return;
  ev.preventDefault(); ev.stopPropagation();
  closeGlyphMenu(); closeTesterAltMenu();
  var f = curFont(); if (!f) return;
  var ch = testerText()[ti]; if (ch == null) return;
  var base = null; for (var i = 0; i < f.glyphs.length; i++) { if (f.glyphs[i].char === ch) { base = f.glyphs[i]; break; } }
  if (!base) return;
  var alts = altsOfBase(f, base), cur = (testerAlts[ti] != null) ? testerAlts[ti] : -1;
  var m = document.createElement('div'); m.id = 'testerAltMenu'; m.className = 'alt-flyout';
  var hd = document.createElement('div'); hd.className = 'alt-hd'; hd.textContent = 'Alternates · "' + glyphLabel(base) + '"'; m.appendChild(hd);
  if (!alts.length) {
    var none = document.createElement('div'); none.className = 'alt-none'; none.textContent = 'No alternates yet — add them with +Alternate on the glyphs. page.';
    m.appendChild(none);
  } else {
    var row = document.createElement('div'); row.className = 'alt-row';
    function chip(tag, g, active, fn) {
      var b = document.createElement('button'); b.className = 'alt-chip' + (active ? ' on' : '');
      b.innerHTML = ((g && isFilled(g)) ? glyphThumb(g) : '<span class="alt-letter">' + glyphLabelHtml(base) + '</span>') + '<span class="alt-tag">' + tag + '</span>';
      b.addEventListener('click', function () { fn(); closeTesterAltMenu(); });
      row.appendChild(b);
    }
    chip('default', base, cur < 0, function () { delete testerAlts[ti]; renderTesterText(); });
    alts.forEach(function (idx) {
      var g = f.glyphs[idx], mm = g.name.match(/\.ss(\d+)$/), tag = mm ? ('ss' + mm[1]) : 'alt';
      chip(tag, g, cur === idx, function () { testerAlts[ti] = idx; renderTesterText(); });
    });
    m.appendChild(row);
  }
  document.body.appendChild(m);
  var mw = m.offsetWidth, mh = m.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = Math.max(4, Math.min(ev.clientX, vw - mw - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(ev.clientY - mh - 6 < 4 ? ev.clientY + 14 : ev.clientY - mh - 6, vh - mh - 6)) + 'px';
}
function ctxDeleteGlyph(slot) {
  var f = curFont(), g = f.glyphs[slot]; if (!g) return;
  var label = glyphLabel(g);
  f.glyphs.splice(slot, 1);
  if (selectedSlot === slot) selectedSlot = -1; else if (selectedSlot > slot) selectedSlot--;
  if (openGlyphIndex === slot) openGlyphIndex = -1; else if (openGlyphIndex > slot) openGlyphIndex--;
  lastSig = {}; flatCache = {}; kernCache = {};
  renderGrid(); renderModGrid(); updateAssign(); renderRight(); scheduleTester(); autosave();
  setStatus('Deleted glyph "' + label + '".', 'ok');
}

// Auto-compose accented glyphs (é = e + acute …) from base letters. Marks that the
// user hasn't drawn are SYNTHESIZED from the font's own shapes (apostrophe→´/`,
// period→¨, hyphen→¯ + bent ^/ˇ, O→˚, comma→¸) so a multilingual font no longer
// needs every accent — or even every mark — drawn by hand. Drawn marks still win.
function onComposeAccents() {
  if (!FEAT.accents) return;
  var f = curFont(), mid = curMasterId();
  var r = accentCompose.composeAll(f, mid, { deriveMarks: true });
  r.composed.forEach(function (ch) { var g = f.glyphs.find(function (x) { return x.char === ch; }); if (g) syncOpenGlyph(g); });
  renderGrid(); renderModGrid(); scheduleTester(); autosave();
  if (!r.composed.length) {
    setStatus('Composed 0 — draw the base letters (A E I O U C N S Z…) first; the marks are auto-built from your shapes.', 'err');
  } else {
    setStatus('Composed ' + r.composed.length + ' accented glyph(s)' + (r.withDerived ? ' · marks auto-built from your shapes' : '') + (r.skipped.length ? ' (' + r.skipped.length + ' skipped — base not drawn)' : '') + '.', 'ok');
  }
}

// Make the standalone diacritic MARK glyphs once, derived from the font's existing
// shapes (apostrophe→´/`, period→¨, hyphen→¯, comma→¸, O→˚, weight-matched ^ ˇ ~ ˘).
// They become real editable glyphs (the user can refine); +Accents then uses them
// (a drawn mark always wins, so this never overwrites marks you've already made).
function shiftContours(cs, dx, dy) {
  cs.forEach(function (c) { c.points.forEach(function (p) { p.x += dx; p.y += dy; if (p.handleIn) { p.handleIn.x += dx; p.handleIn.y += dy; } if (p.handleOut) { p.handleOut.x += dx; p.handleOut.y += dy; } }); });
  return cs;
}
var MARK_GLYPHS = [
  { k: 'acute', name: 'acute', cp: 0x00B4, pos: 'above' }, { k: 'grave', name: 'grave', cp: 0x0060, pos: 'above' },
  { k: 'circumflex', name: 'circumflex', cp: 0x02C6, pos: 'above' }, { k: 'tilde', name: 'tilde', cp: 0x02DC, pos: 'above' },
  { k: 'dieresis', name: 'dieresis', cp: 0x00A8, pos: 'above' }, { k: 'macron', name: 'macron', cp: 0x00AF, pos: 'above' },
  { k: 'breve', name: 'breve', cp: 0x02D8, pos: 'above' }, { k: 'dotaccent', name: 'dotaccent', cp: 0x02D9, pos: 'above' },
  { k: 'ring', name: 'ring', cp: 0x02DA, pos: 'above' }, { k: 'caron', name: 'caron', cp: 0x02C7, pos: 'above' },
  { k: 'doubleacute', name: 'hungarumlaut', cp: 0x02DD, pos: 'above' }, { k: 'cedilla', name: 'cedilla', cp: 0x00B8, pos: 'below' },
  { k: 'ogonek', name: 'ogonek', cp: 0x02DB, pos: 'below' },
];
function onGenerateMarks() {
  if (!FEAT.accents) return;
  var f = curFont(); if (!f) return;
  var mid = curMasterId(), M = f.metrics || {}, em = f.unitsPerEm || 1000, cap = M.capHeight || 0.7 * em;
  var made = 0, kept = 0;
  MARK_GLYPHS.forEach(function (mk) {
    var ch = String.fromCodePoint(mk.cp), g = null;
    for (var i = 0; i < f.glyphs.length; i++) { if (f.glyphs[i].name === mk.name || f.glyphs[i].char === ch) { g = f.glyphs[i]; break; } }
    if (g && g.layers[mid] && g.layers[mid].contours && g.layers[mid].contours.length) { kept++; return; } // keep a user-drawn mark
    var d = markgen.deriveMark(f, mk.k, mid); if (!d || !d.contours.length) return;
    var cs = d.contours, b = glyphset.contoursBounds(cs); if (!b) return;
    var bearing = Math.round(0.08 * em), adv = Math.round(b.w + 2 * bearing);
    var dx = bearing - b.minX, dy = mk.pos === 'above' ? Math.round(cap * 0.64) - b.minY : Math.round(-0.03 * em) - b.maxY;
    shiftContours(cs, dx, dy);
    if (!g) {
      var layers = {}; (f.masters || []).forEach(function (m) { layers[m.id] = { contours: [] }; });
      g = { name: mk.name, char: ch, unicode: mk.cp, alphabet: 'custom', advanceWidth: adv, layers: layers };
      f.glyphs.push(g);
    }
    g.layers[mid] = { contours: cs }; g.advanceWidth = adv; g.lsbLineX = 0;
    made++;
  });
  var comp = accentCompose.composeAll(f, mid, { deriveMarks: true });  // also compose the accented letters (base + marks)
  renderGrid(); renderModGrid(); scheduleTester(); autosave();
  renderAccGrid();
  setStatus(made ? ('Made ' + made + ' mark glyph(s) + composed ' + comp.composed.length + ' accented letter(s) from your shapes.')
    : (comp.composed.length ? ('Composed ' + comp.composed.length + ' accented letter(s).') : (kept ? 'All marks already drawn — nothing new.' : 'Draw an apostrophe, period, hyphen or O (and the base letters) first.')),
    (made || comp.composed.length || kept) ? 'ok' : 'err');
}

// ---- accent. tab: marks + accented-letter grid, and the labeled marks template ----
function isAccentGlyph(g) {
  if (g.kind === 'composed') return true;
  for (var i = 0; i < MARK_GLYPHS.length; i++) if (MARK_GLYPHS[i].name === g.name) return true;
  return false;
}
function renderAccGrid() {
  var box = $('accGrid'); if (!box) return;
  var f = curFont(); box.innerHTML = '';
  if (!f) return;
  var any = 0;
  f.glyphs.forEach(function (g, i) {
    if (!isAccentGlyph(g)) return;
    any++;
    var cell = document.createElement('div');
    cell.className = 'cell altcell' + (isFilled(g) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '') + (g.char == null ? ' named' : '');
    cell.innerHTML = (isFilled(g) ? (glyphThumb(g) || '') : '') + '<span class="lab">' + glyphLabelHtml(g) + '</span>';
    cell.addEventListener('click', function () { selectedSlot = i; renderAccGrid(); updateAssign(); renderRight(); });
    box.appendChild(cell);
  });
  if (!any) box.innerHTML = '<div class="ai-note">No marks or accented letters yet — Create a marks template (or Auto Marks), draw them, then Compose.</div>';
}
// Open a LABELED Illustrator template with a box per diacritic mark (ghosted with
// the mark glyph). The user draws each; Import reads them back by cell name.
function onMakeMarksTemplate() {
  if (!FEAT.accents) return;
  var f = curFont(); if (!f) { setStatus('Open a font first.', 'err'); return; }
  var chars = MARK_GLYPHS.map(function (mk) { return { ghost: String.fromCodePoint(mk.cp), id: mk.name, w: 1 }; });
  var cfg = { sets: [{ name: 'Accent marks', chars: chars }], metrics: f.metrics, unitsPerEm: f.unitsPerEm, grids: [{ kind: 'metrics' }], ybounds: {} };
  setStatus('Opening marks template in Illustrator…');
  evalScript('fmOpenTemplate(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Marks template opened (' + r.cells + ' marks) — draw each in its box, then Import.', 'ok');
    else setStatus('Could not open template: ' + ((r && r.error) || '?'), 'err');
  });
}
function onImportMarksTemplate() {
  if (!FEAT.accents) return;
  var f = curFont(); if (!f) return;
  setStatus('Reading marks template…');
  evalScript('fmReadTemplate()').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!r || !r.ok) { setStatus('Could not read template: ' + ((r && r.error) || 'open one first'), 'err'); return; }
    if (!r.cells || !r.cells.length) { setStatus('No drawn marks found in the boxes.', 'err'); return; }
    var mid = curMasterId(), desc = f.metrics.descender, em = f.unitsPerEm || 1000, placed = 0;
    var byName = {}; MARK_GLYPHS.forEach(function (mk) { byName[mk.name] = mk; });
    r.cells.forEach(function (cell) {
      var mk = byName[cell.id]; if (!mk) return;
      var contours = ilbridge.contoursFromArtboard(cell.paths, cell.rect, r.scale, desc);
      if (!contours.length) return;
      var ch = String.fromCodePoint(mk.cp), g = null;
      for (var i = 0; i < f.glyphs.length; i++) { if (f.glyphs[i].name === mk.name || f.glyphs[i].char === ch) { g = f.glyphs[i]; break; } }
      if (!g) { var layers = {}; (f.masters || []).forEach(function (m) { layers[m.id] = { contours: [] }; }); g = { name: mk.name, char: ch, unicode: mk.cp, alphabet: 'custom', advanceWidth: Math.round(0.3 * em), layers: layers }; f.glyphs.push(g); }
      g.layers[mid] = { contours: contours }; g.lsbLineX = 0;
      var b = glyphset.contoursBounds(contours); if (b) g.advanceWidth = Math.round(b.w + 2 * 0.08 * em);
      placed++;
    });
    if (!placed) { setStatus('No marks imported — draw inside the boxes first.', 'err'); return; }
    lastSig = {}; flatCache = {};
    // Build the accented letters straight away (drawn marks win; any not drawn are
    // auto-derived from your shapes), so Import is the whole accent workflow.
    var comp = accentCompose.composeAll(f, mid, { deriveMarks: true });
    renderGrid(); renderModGrid(); scheduleTester(); autosave();
    setStatus('Imported ' + placed + ' mark(s) · composed ' + comp.composed.length + ' accented letter(s) (À Á Ç Ñ Š …).', 'ok');
  });
}

function updateAssign() {
  var g = selGlyph();
  $('assignBtn').disabled = !g;
  // the Assign chip shows the TARGET letter (consistent with the glyph cells) —
  // not the captured Illustrator shape, which would otherwise surface stray
  // artwork (e.g. the RuneType logo) in the handle. The live selection still
  // drives the drag image + the assign action, just not this preview.
  var assignWrap = $('assignWrap');
  if (g) {
    $('assignChip').innerHTML = glyphLabelHtml(g);
    if (assignWrap) assignWrap.classList.remove('has-shape');
  } else if (selSourceContours && selSourceContours.length) {
    $('assignChip').innerHTML = shapeThumbSVG(selSourceContours, 'chip-thumb');
    if (assignWrap) assignWrap.classList.add('has-shape');
  } else {
    $('assignChip').innerHTML = '';
    if (assignWrap) assignWrap.classList.remove('has-shape');
  }
  $('altChip').placeholder = g ? glyphLabel(g) : '';      // writable; hints the selection
  $('gotoBtn').disabled = !g;
  // the Go-to chip shows the glyph's drawn SHAPE (like glyphs.), falling back to
  // its letter only when the slot is still empty
  var gchip = $('gotoChip'), gwrap = gchip.parentNode;
  var gShape = g && isFilled(g) ? glyphThumb(g) : null;
  if (gShape) gchip.innerHTML = gShape;
  else gchip.innerHTML = g ? glyphLabelHtml(g) : '';
  // match the glyphs. chip: a near-black backing behind a drawn shape thumbnail
  if (gwrap && gwrap.classList) gwrap.classList.toggle('has-shape', !!gShape);
}

// ---- modification: alternates & ligatures ----
function onAlt() {
  if (!FEAT.alternates) return;
  var f = curFont(), base = -1;
  var ch = $('altChip').value.trim();
  if (ch) {
    f.glyphs.forEach(function (g, i) { if (base < 0 && g.char === ch) base = i; });
    if (base < 0) { setStatus('No glyph "' + ch + '" in this font.', 'err'); return; }
  } else if (selectedSlot >= 0) {
    // if the selected slot is ITSELF an alternate, make a sibling alternate of its
    // BASE (not an alternate-of-an-alternate) — the new alt is auto-selected, so a
    // second +Alternate would otherwise nest on the previous one.
    var sg = f.glyphs[selectedSlot];
    if (sg && sg.kind === 'alternate' && sg.baseName) {
      base = selectedSlot; f.glyphs.forEach(function (g, i) { if (g.name === sg.baseName) base = i; });
    } else base = selectedSlot;
  } else { setStatus('Type a letter (or select a glyph) to alternate.', 'err'); return; }
  var idx = glyphset.createAlternate(curFont(), base);
  if (idx < 0) { setStatus('Could not create alternate.', 'err'); return; }
  selectedSlot = idx; renderGrid(); updateAssign(); renderRight();
  setStatus('Created alternate "' + curFont().glyphs[idx].name + '" — open it from the grid when ready.', 'ok');
  autosave();
}
// Live preview of the two letters typed into the ligature box — their glyph thumbnails.
function updateLigPrev() {
  var el = $('ligPrev'); if (!el) return;
  var f = curFont(), s = (($('ligInput') && $('ligInput').value) || '').slice(0, 2);
  if (!f || !s) { el.innerHTML = ''; return; }
  var html = '';
  for (var i = 0; i < s.length; i++) {
    var g = null; for (var k = 0; k < f.glyphs.length; k++) if (f.glyphs[k].char === s[i]) { g = f.glyphs[k]; break; }
    html += (g && isFilled(g)) ? (glyphThumb(g) || '') : '<span class="lig-miss">' + s[i].replace(/</g, '&lt;').replace(/&/g, '&amp;') + '</span>';
  }
  el.innerHTML = html;
}
function onLig() {
  if (!FEAT.alternates) return;
  var str = $('ligInput').value.trim();
  if (str.length !== 2) {
    setStatus('Ligatures join exactly 2 letters — "' + str + '" has ' + str.length + '.', 'err');
    return;
  }
  var idx = glyphset.createLigature(curFont(), str);
  if (idx < 0) { setStatus('Could not create ligature.', 'err'); return; }
  selectedSlot = idx; $('ligInput').value = ''; updateLigPrev(); renderGrid(); updateAssign(); renderRight();
  setStatus('Created ligature "' + curFont().glyphs[idx].name + '" — open it from the grid when ready.', 'ok');
  autosave();
}

// ---- signature. — OpenType name-table metadata ----
var SIG_FIELDS = [
  { key: 'familyName', label: 'Family Name' },
  { key: 'styleName', label: 'Style / Subfamily' },
  { key: 'designer', label: 'Designer' },
  { key: 'designerURL', label: 'Designer URL' },
  { key: 'manufacturer', label: 'Manufacturer / Foundry' },
  { key: 'vendorURL', label: 'Vendor URL' },
  { key: 'version', label: 'Version' },
  { key: 'copyright', label: 'Copyright' },
  { key: 'trademark', label: 'Trademark' },
  { key: 'license', label: 'License' },
  { key: 'licenseURL', label: 'License URL' },
  { key: 'description', label: 'Description' },
  { key: 'sampleText', label: 'Sample Text' },
  { key: 'created', label: 'Created (date)' },
];
// signature. fields live inline on the save page; values write into the
// project as you type (every field optional, Fontself-style).
function buildSigFields() {
  var f = curFont(), box = $('sigFields'); box.innerHTML = '';
  if (!f.meta.created) f.meta.created = '2026-06-13';
  SIG_FIELDS.forEach(function (fl) {
    var row = document.createElement('label'); row.className = 'sv-row2';
    row.innerHTML = '<span>' + fl.label + '</span>';
    var inp = document.createElement('input');
    inp.type = 'text'; inp.value = f.meta[fl.key] || '';
    inp.placeholder = 'optional';
    inp.setAttribute('data-k', fl.key);
    inp.addEventListener('input', function () { f.meta[fl.key] = inp.value.trim(); autosave(); });
    row.appendChild(inp);
    box.appendChild(row);
  });
  if ($('demoFont')) $('demoFont').checked = !!f.demoFont;   // reflect the per-font Demo flag
}
function commitSig() {
  var box = $('sigFields'); if (!box) return;
  var f = curFont();
  var ins = box.querySelectorAll('input[data-k]');
  for (var i = 0; i < ins.length; i++) f.meta[ins[i].getAttribute('data-k')] = ins[i].value.trim();
}

// ---- save. — single-file project format or export folder ----
function serializeProject(f) {
  // strip runtime-only keys; undo stacks stay out of the file
  return JSON.stringify(f, function (k, v) {
    if (k && k.charAt(0) === '_') return undefined;
    if (k === 'undo' || k === 'redo') return [];
    return v;
  });
}
// PERF: autosave is a BLOCKING full-document JSON.stringify + writeFileSync, and it
// was called at the end of nearly every action (incl. the ~700ms live poll). Coalesce
// the storm into at most one write per ~1.5s; it reads curFont() at fire time so the
// latest state is always captured. _autosaveNow() flushes immediately on explicit save.
var _asTimer = null;
function _autosaveNow() {
  try {
    var dir = cs.getSystemPath(SystemPath.USER_DATA) + '/RuneType';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    if (fonts.length) fs.writeFileSync(dir + '/autosave.runetype', serializeProject(curFont()));
  } catch (e) { /* best-effort temp save */ }
}
function autosave() {
  if (_asTimer) return;
  _asTimer = setTimeout(function () { _asTimer = null; _autosaveNow(); }, 1500);
}
// Open File — pick a font/project/artwork file and open it with the OS default
// app (font files land in the system font viewer for manual install).
function onOpenFile() {
  // open a saved project or an existing font INTO the panel for editing (read by
  // the panel, not handed to the OS) — same loader as page-1 Import.
  // alpha: .runetype only — importing an existing font to edit is Pro.
  if (FEAT.fontImport) pickPath('Open a project or font to edit', 'Projects & Fonts:*.runetype;*.otf;*.ttf').then(openFromPath);
  else pickPath('Open a RuneType project to edit', 'RuneType Projects:*.runetype').then(openFromPath);
}
function onSaveProject() {
  commitSig();
  var f = curFont();
  var dlg = '(function(){var fl=File.saveDialog("Save RuneType project","RuneType:*.runetype");if(!fl)return "";if(fl.name.indexOf(".")<0)fl=new File(fl.fsName+".runetype");return fl.fsName;})()';
  evalScript(dlg).then(function (path) {
    if (!path) return;
    try {
      fs.writeFileSync(path, serializeProject(f));
        setStatus('Project saved → ' + path, 'ok');
    } catch (e) { setStatus('Save failed: ' + e.message, 'err'); }
  });
}
// ---- reset / rescue: clear the in-memory state and reload the panel fresh ----
function hardReset() {
  try { flatCache = {}; kernCache = {}; lastSig = {}; } catch (e) {}
  try { window.location.reload(); } catch (e) { try { location.reload(); } catch (e2) {} }
}
// Save & Reset: offer a file dialog (cancel still resets), write, then reload.
function saveThenReset() {
  var m = $('resetModal'); if (m) m.classList.add('hidden');
  var f = fonts.length ? curFont() : null;
  if (!f) { hardReset(); return; }
  try { commitSig(); } catch (e) {}
  var dlg = '(function(){var fl=File.saveDialog("Save RuneType project","RuneType:*.runetype");if(!fl)return "";if(fl.name.indexOf(".")<0)fl=new File(fl.fsName+".runetype");return fl.fsName;})()';
  evalScript(dlg).then(function (path) {
    if (path) { try { fs.writeFileSync(path, serializeProject(f)); } catch (e) {} }
    hardReset();
  });
}
function onExportGo() {
  commitSig();
  var wantOtf = FEAT.exportOtf && $('exOtf').checked;
  var wantTtf = FEAT.exportTtf && $('exTtf').checked;
  var wantVar = FEAT.exportVariable && $('exVar').checked;
  if (!wantOtf && !wantTtf && !wantVar) { setStatus('Pick at least one format to export.', 'err'); return; }
  var f = curFont();
  evalScript('(function(){var d=Folder.selectDialog("Choose a folder to export into");return d?d.fsName:"";})()').then(function (dir) {
    if (!dir) return;
    try {
      var fam = (f.meta.familyName || 'Font');
      var folder = dir + '/' + fam.replace(/[^\w\- ]+/g, '').trim();
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);   // exports land in a folder
      var n = 0, errs = 0, notes = [];
      // Multi-master variable: align compatible masters, export each as a named style
      // (a working family) + a compatibility report. (Single-file fvar/gvar writer
      // lives in core/ttfWriter.js — kept for the future AI-trained variable axes.)
      if (wantVar && f.masters.length > 1) {
        varCompat.matchPoints(f);
        var rep = varCompat.report(f);
        notes.push('variable: ' + rep.compatible.length + ' glyph(s) interpolation-ready across ' + rep.masters + ' masters' + (rep.ready ? '' : ', ' + rep.incompatible.length + ' need reconciling'));
        try { fs.writeFileSync(folder + '/' + fam.replace(/\s+/g, '') + '-variable-report.txt', JSON.stringify(rep, null, 2)); } catch (e) {}
      }
      f.masters.forEach(function (m) {
        var base = folder + '/' + fam.replace(/\s+/g, '') + '-' + m.name.replace(/\s+/g, '');
        if (wantOtf || wantVar) { try { fs.writeFileSync(base + '.otf', Buffer.from(new Uint8Array(buildCleanOtf(f, m)))); n++; } catch (e) { errs++; } }
        if (wantTtf) { try { fs.writeFileSync(base + '.ttf', Buffer.from(new Uint8Array(buildCleanTtf(f, m)))); n++; } catch (e) { errs++; } }
      });
      setStatus('Exported ' + n + ' file(s) → ' + folder + (notes.length ? ' · ' + notes.join(' · ') : '') + (errs ? ' (' + errs + ' skipped)' : ''), n ? 'ok' : 'err');
    } catch (e) { setStatus('Export failed: ' + (e && e.message ? e.message : e), 'err'); }
  });
}

// ===== outline cleanup — unite overlapping contours before any font build
// (the same paper.js trick Fontself uses, so stacked shapes never punch holes)
// Contour union (containment-tree, counter-preserving) lives in unite.js so it can be
// headlessly unit-tested (test/unite.test.js drives it with paper-jsdom). Thin wrapper
// binds the panel's paper scope.
function uniteContours(contours) { return unite.uniteContours(getPaper(), contours); }
// A deep copy of the project with every filled layer's overlaps united.
function cleanedProject(f, masterId) {
  var copy = JSON.parse(serializeProject(f));
  // OPTICAL BEARINGS: re-seat every glyph's advance/lsbLineX from its optical (dashed) lines on
  // the CURRENT ink, so the exported sidebearings are exactly the dashed lines — even if a shape
  // was edited after the last drag. (No-op unless the mode is on.) Seat ONLY the master being
  // built: obSeat writes the glyph-GLOBAL lsbLineX/advance, so looping every master left the
  // LAST master's seating in every exported file (Bold got the Regular's sidebearings).
  if (copy.optBearings) {
    try { applyOpticalBearings(copy, masterId || (copy.masters && copy.masters[0] && copy.masters[0].id)); } catch (e) {}
  }
  // NOTE: accented letters (À é ç ñ ö ü …) are composed on demand via the "+ Accents" button
  // (onComposeAccents) — a deliberate click, NOT silently at export — so they become real glyphs
  // in the project and the user sees them in the grid. Whatever accents exist at export time ride
  // along here; any STILL-undrawn accent/symbol slot falls to the placeholder as before.
  copy.glyphs.forEach(function (g) {
    Object.keys(g.layers).forEach(function (mid) {
      var l = g.layers[mid];
      if (l && l.contours && l.contours.length) l.contours = uniteContours(l.contours);   // also cleans single self-intersecting outlines (GDI-safe)
    });
    bakeGlyphOrigin(g);   // fold the blue-line (LSB) offset into the outline
  });
  return copy;
}

// ===== full OpenType name table (Fontself-style), applied by re-parsing the
// built OTF — core/fontEngine stays untouched.
function slugifyPS(t) { return (t || 'Font').replace(/[^A-Za-z0-9]+/g, ''); }
function applyNames(buffer, f, styleName) {
  var ot = getOpentype();
  if (!ot) return buffer;
  try {
    var font = ot.parse(buffer);
    var m = f.meta, fam = m.familyName || 'Untitled';
    var style = styleName || m.styleName || 'Regular';
    var full = style.toLowerCase() === 'regular' ? fam : fam + ' ' + style;
    var ps = slugifyPS(fam + '-' + style);
    var ver = (m.version || '1.000');
    function set(k, v) { if (v) font.names[k] = { en: String(v) }; }
    set('fontFamily', fam); set('fontSubfamily', style);
    set('preferredFamily', fam); set('preferredSubfamily', style);
    set('fullName', full); set('postScriptName', ps);
    set('uniqueID', ver + ';' + ps);
    set('version', 'Version ' + ver + ';RuneType Glyphmaker 1.0');
    set('designer', m.designer); set('designerURL', m.designerURL);
    set('manufacturer', m.manufacturer); set('manufacturerURL', m.vendorURL);
    set('license', m.license); set('licenseURL', m.licenseURL);
    set('description', m.description); set('trademark', m.trademark);
    set('copyright', m.copyright); set('sampleText', m.sampleText);
    // Bold/Italic flagging (OTF): opentype.js merges font.tables.os2 overrides on
    // toArrayBuffer — without this a Bold master exports as usWeightClass 400 + REGULAR.
    // (head.macStyle is NOT honored by opentype.js's writer — verified — but modern apps
    // read fsSelection/usWeightClass; the TTF writer stamps macStyle properly.)
    try {
      var bold = (m.weightClass ? m.weightClass >= 600 : /bold/i.test(style));
      var ital = /italic|oblique/i.test(style);
      font.tables.os2 = font.tables.os2 || {};
      font.tables.os2.usWeightClass = m.weightClass || (bold ? 700 : 400);
      font.tables.os2.fsSelection = ((ital ? 0x01 : 0) | (bold ? 0x20 : 0)) || 0x40;
    } catch (e2) {}
    return font.toArrayBuffer();
  } catch (e) { return buffer; }
}
// Build one master's OTF: cleaned outlines + the full name table.
function buildMeta(f, master) {
  var style = master.type || master.name || 'Regular';
  return {
    familyName: f.meta.familyName || 'Untitled', styleName: style,
    designer: f.meta.designer || '', version: f.meta.version, masterId: master.id,
    manufacturer: f.meta.manufacturer || '', copyright: f.meta.copyright || '', license: f.meta.license || '',
    // signature-panel fields — ttfWriter stamps these inline (the TTF path has no applyNames)
    designerURL: f.meta.designerURL || '', vendorURL: f.meta.vendorURL || '',
    trademark: f.meta.trademark || '', licenseURL: f.meta.licenseURL || '',
    description: f.meta.description || '', sampleText: f.meta.sampleText || '',
    // Bold masters must ship as weight 700 + BOLD flags in BOTH formats
    weightClass: f.meta.weightClass || (/bold/i.test(style) ? 700 : 400),
  };
}
// Empty-glyph placeholder art (the "boş harf" mark) loaded once. Lazily required
// so pro (emptyGlyphArt = null) never touches the file.
var _phArt = undefined;
function placeholderArt() {
  if (_phArt === undefined) {
    _phArt = null;
    // bosharf.json is bundled, so "Demo font" can use it in ANY edition (not just
    // the free one whose FEAT.emptyGlyphArt forces it).
    var artName = FEAT.emptyGlyphArt || 'bosharf';
    try { _phArt = require(ROOT + '/js/' + artName + '.json'); } catch (e) { _phArt = null; }
  }
  return _phArt;
}
// Fill undrawn slots with the placeholder so the exported font is complete. The
// free edition always watermarks empties; any edition does when "Demo font" is on.
var _cleanedArt = undefined;   // the placeholder logo, cleaned once (GDI-safe) + reused
function fillPlaceholders(cleaned, masterId, demo) {
  if (!demo && !FEAT.emptyGlyphArt) return;
  if (_cleanedArt === undefined) {
    // bosharf.json is now baked (scripts/bake-bosharf.js) as a BOOLEAN UNION of the SVG's
    // top-level <path>s — each painted with its OWN fill-rule, exactly like a browser/Illustrator
    // paints them — so it already arrives as clean, counter-correct non-zero geometry (outer CCW
    // + holes CW): 0 self/mutual crossings at float precision, the p/e/R counters open just like
    // the SVG the user sees. Do NOT run uniteContours here: its resolveCrossings re-traces the
    // whole 187-contour compound and COLLAPSES it to ~16, FILLING those counters solid (the very
    // bug the user reported on OTF export). The build's normalizeWinding alone keeps them — verified
    // by rasterising raw-bake vs. normalizeWinding(bake): both show open counters, pixel-for-pixel.
    _cleanedArt = placeholderArt() || null;
  }
  if (_cleanedArt) placeholder.fillEmptyGlyphs(cleaned, masterId, _cleanedArt);
}
// The kern table that SHIPS — built from the SAME per-pair function the tester previews
// (opticalKern), over the SAME glyphs, so the export is BYTE-for-byte the live preview. We do NOT
// reuse the stored f.kerning (it goes stale the instant the bake re-seats an advance: a kern
// computed for the old width no longer fits → letters collide / float, the "export ≠ program"
// bug) and we do NOT reuse optimizer.optimizeKerning (it scans at buildRef's DERIVED capHeight
// while opticalKern uses f.metrics.capHeight → ~60% of pairs disagree). Keys are glyph NAMES, which
// match the cleaned glyphs, so it applies correctly even though the font is built from the copy.
function exportKernTable(f, mid) {
  mid = mid || curMasterId();   // multi-master export passes the master being BUILT, not the UI's
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilledIn(g, mid) && g.char) filled.push(g); });
  var table = {};
  for (var i = 0; i < filled.length; i++) for (var j = 0; j < filled.length; j++) {
    var v = opticalKern(f, filled[i], filled[j], mid);
    if (v) table[filled[i].name + ',' + filled[j].name] = v;
  }
  return table;
}
// Undrawn ENCODED slots must not ship as invisible blank glyphs (pro edition / Demo off):
// the tester deliberately hides contour-less glyphs (undrawn letters preview in a system
// face), so a blank-but-encoded export types as invisible 0.6em holes — testing != export.
// Drop them from the cleaned copy so undrawn letters fall through to the OS fallback font,
// like the tester shows. Genuine whitespace (space, NBSP) keeps its slot + advance so the
// Space slider still ships. Runs AFTER fillPlaceholders (Demo mode fills them instead).
function stripBlankSlots(cleaned, masterId) {
  cleaned.glyphs = cleaned.glyphs.filter(function (g) {
    var l = g.layers && g.layers[masterId];
    if (l && l.contours && l.contours.length) return true;
    return g.unicode === 0x20 || g.unicode === 0xA0;
  });
}
function buildCleanOtf(f, master) {
  var cleaned = cleanedProject(f, master.id);
  fillPlaceholders(cleaned, master.id, !!f.demoFont);
  stripBlankSlots(cleaned, master.id);
  var built = fontEngine.buildFont(cleaned, 'otf', buildMeta(f, master));
  var named = applyNames(built.buffer, f, master.type || master.name);
  // opentype.js's writer drops GPOS/kern, so we splice a real 'kern' table onto the FINAL buffer.
  try { return kerninject.injectKernTable(named, exportKernTable(f, master.id), cleaned.glyphs); } catch (e) { return named; }
}
// TTF: the dedicated glyf writer already stamps the name table, so no applyNames
// (re-parsing+toArrayBuffer would convert it back to CFF).
function buildCleanTtf(f, master) {
  var cleaned = cleanedProject(f, master.id);
  fillPlaceholders(cleaned, master.id, !!f.demoFont);
  stripBlankSlots(cleaned, master.id);
  var built = fontEngine.buildFont(cleaned, 'ttf', buildMeta(f, master)).buffer;
  // Same kern splice as the OTF path — ttfWriter emits no kern/GPOS either, and the
  // GID order is identical (.notdef = 0, then project.glyphs[i] = i+1).
  try { return kerninject.injectKernTable(built, exportKernTable(f, master.id), cleaned.glyphs); } catch (e) { return built; }
}

function renderWorkspace() {
  renderMasterSelect(); renderFilters(); renderGrid(); updateAssign(); refreshTester();
  setTesterBg(true);   // testing. starts dark by default
  syncRefSlider();     // reflect the saved Arial+Times X-spacing %
  setSection('glyphs');
}

// ---- assign selection -> glyph ----
// Place contours (font units, from a selection) into a glyph slot.
function assignContoursTo(slot, contours) {
  if (slot < 0 || !contours || !contours.length) return false;
  if (!glyphset.assignContoursToGlyph(curFont(), contours, slot, curMasterId())) return false;
  var g = curFont().glyphs[slot];
  g.lsbLineX = 0;   // a fresh shape starts with the blue line on the origin
  setStatus('Assigned ' + contours.length + ' contour(s) → "' + glyphLabel(g) + '".', 'ok');
  renderGrid(); refreshTester(); renderRight(); autosave();
  return true;
}
function onAssign() {
  if (selectedSlot < 0) return;
  // use the live-captured selection if we have one, else read fresh
  if (selSourceContours && selSourceContours.length) {
    if (!assignContoursTo(selectedSlot, selSourceContours)) setStatus('Could not place selection.', 'err');
    return;
  }
  setStatus('Reading selection…');
  evalScript('fmReadSelection()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { setStatus('Bridge returned bad data.', 'err'); return; }
    if (!res || !res.ok) { setStatus((res && res.error) || 'Could not read selection.', 'err'); return; }
    var contours = ilbridge.contoursFromSelection(res.paths);
    if (!contours.length) { setStatus('Selection has no usable outlines.', 'err'); return; }
    if (!assignContoursTo(selectedSlot, contours)) setStatus('Could not place selection.', 'err');
  });
}

// ===== kerning — Optical is computed live from the outlines; Metric reads the
// project's kern table; Auto Kern bakes the optical pass INTO that table.
var flatCache = {}, kernCache = {};
function flattenContours(contours) {
  // contours -> straight segments (beziers sampled), for scanline profiling
  var segs = [];
  contours.forEach(function (c) {
    var pts = c.points, n = pts.length;
    if (n < 2) return;
    var count = c.closed ? n : n - 1;
    for (var i = 0; i < count; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasO || hasI) {
        var c1 = a.handleOut || a, c2 = b.handleIn || b, px = a.x, py = a.y;
        for (var k = 1; k <= 8; k++) {
          var t = k / 8, u = 1 - t;
          var x = u*u*u*a.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*b.x;
          var y = u*u*u*a.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*b.y;
          segs.push([px, py, x, y]); px = x; py = y;
        }
      } else segs.push([a.x, a.y, b.x, b.y]);
    }
  });
  return segs;
}
function glyphFlat(g, mid) {
  mid = mid || curMasterId();
  var sig = glyphset.layerSignature(g, mid);
  if (!sig) return null;
  var key = g.name + '|' + sig;   // sig is per-master geometry → collision-safe across masters
  if (!flatCache[key]) {
    var l = g.layers[mid];
    if (!l || !l.contours) return null;
    flatCache[key] = flattenContours(l.contours);
  }
  return flatCache[key];
}
function profileAt(segs, y) {
  var min = 1e9, max = -1e9;
  for (var i = 0; i < segs.length; i++) {
    var sg = segs[i], y1 = sg[1], y2 = sg[3];
    if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) {
      var x = (y2 === y1) ? sg[0] : sg[0] + (sg[2] - sg[0]) * (y - y1) / (y2 - y1);
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  return min > max ? null : { min: min, max: max };
}
// optical pair value: even out the visual air between the two ink profiles
function opticalKern(f, gL, gR, mid) {
  mid = mid || curMasterId();
  // Visual Kern (Track A) override wins, returned BEFORE the geometric path + cache, so the
  // tester preview, exportKernTable and the shipped 'kern' table all honor it automatically —
  // the whole feature rides the existing preview==export invariant through this one hook.
  // Persisted (non-underscore key) so it survives a .runetype round-trip. (Per-FONT by design,
  // master-agnostic.)
  if (f.kernOverride) {
    var ov = f.kernOverride[gL.name + ',' + gR.name];
    if (ov != null) return ov;
  }
  var fl = glyphFlat(gL, mid), fr = glyphFlat(gR, mid);
  if (!fl || !fr) return 0;
  var key = gL.name + '>' + gR.name + '|' + glyphset.layerSignature(gL, mid) + '|' + glyphset.layerSignature(gR, mid);
  if (kernCache[key] != null) return kernCache[key];
  var M = f.metrics, gaps = [];
  for (var k = 0; k <= 22; k++) {
    var y = 5 + (M.capHeight - 10) * k / 22;
    var pl = profileAt(fl, y), pr = profileAt(fr, y);
    if (!pl || !pr) continue;
    gaps.push((gL.advanceWidth - pl.max) + pr.min);  // RSB of left + LSB of right at this height
  }
  var v = 0;
  if (gaps.length) {
    // ROBUST gap (p15, not the single tightest height) so one protruding terminal (C beak /
    // B swash) doesn't read as a collision and over-separate the pair — IDENTICAL to the export
    // bake (optimizer.robustGap + optimizer.kernTarget), so this live preview == the exported font.
    var target = liveKernTarget(f, mid);
    v = Math.round(Math.max(-0.12 * f.unitsPerEm, Math.min(0.06 * f.unitsPerEm, target - optimizer.robustGap(gaps))));
    if (Math.abs(v) < 12) v = 0;
  }
  kernCache[key] = v;
  return v;
}
// The optical kern TARGET, computed once over all filled pairs (optimizer.kernTarget) and cached
// in kernCache (which is cleared on every glyph edit) so the per-pair tester loop stays cheap.
// Keyed per MASTER: the multi-master export loop measures each master's own outlines, and an
// unkeyed scalar leaked the first master's target into every other master's kern table.
function liveKernTarget(f, mid) {
  mid = mid || curMasterId();
  var key = '__target__' + mid;
  if (kernCache[key] == null) kernCache[key] = optimizer.kernTarget(f, mid);
  return kernCache[key];
}
function pairKern(f, gL, gR, mode) {
  if (!gL || !gR) return 0;
  // The export ships the LIVE optical kern (buildCleanOtf → optimizer.optimizeKerning, same math
  // as opticalKern), so the tester must show THAT to stay WYSIWYG — the stored f.kerning table is
  // no longer authoritative (it goes stale the moment an advance is re-baked). 'metric' is kept as
  // an escape hatch to inspect the raw stored table, but the default ('optical') == the export.
  if (mode === 'metric') { var t = f.kerning || {}; return t[gL.name + ',' + gR.name] || 0; }
  return opticalKern(f, gL, gR);
}
// Auto Kern: bake the optical pass into the project's kern table (Metric mode
// then shows the same quality without recomputing).
function onAutoKern() {
  if (!FEAT.optimize) return;
  var f = curFont();
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilled(g) && g.char) filled.push(g); });
  if (filled.length < 2) { setStatus('Need at least two placed glyphs to kern.', 'err'); return; }
  bakeAllOrigins(f);   // normalise blue-line offsets so pairs measure true bearings
  f.kerning = f.kerning || {};
  var n = 0;
  for (var i = 0; i < filled.length; i++) {
    for (var j = 0; j < filled.length; j++) {
      var v = opticalKern(f, filled[i], filled[j]);
      if (v) { f.kerning[filled[i].name + ',' + filled[j].name] = v; n++; }
    }
  }
  renderTesterText(); autosave();
  setStatus('Auto-kerned ' + filled.length + ' glyphs — ' + n + ' pair(s) baked into the kern table.', 'ok');
}

// === Visual Kern (Track A) — the headline auto-kerner. Judges the WHITE AREA between every
// pair (shared/kernvision.js) and seats a kern that makes the gaps optically EVEN, then writes
// it to f.kernOverride. opticalKern returns that first, so the tester preview and the EXPORTED
// kern table are byte-identical to it (preview==export, for free). Persisted in .runetype.
function onVisualKern() {
  if (!FEAT.optimize) return;
  var f = curFont();
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilled(g) && g.char && g.unicode >= 0x21) filled.push(g); });
  if (filled.length < 2) { setStatus('Need at least two placed glyphs to kern.', 'err'); return; }
  var aggrEl = $('vkAggr');
  var aggr = aggrEl ? ((+aggrEl.value || 0) / 100) : 0.6;
  setStatus('Visual Kern — reading the gaps…');
  bakeAllOrigins(f);                       // normalise blue-line offsets so pairs measure true bearings
  flatCache = {}; kernCache = {};          // measure on the just-baked outlines/advances
  setTimeout(async function () {           // let the status paint before the (blocking) pass
    var t0 = Date.now(), res, seeds = {};
    // Track B: the trained model PROPOSES a kern per pair; kernvision then verifies+refines each
    // in a tight window and guarantees no collision. Fails soft to {} (no model bundled / error)
    // → kernvision runs its full optical search, so the feature always works.
    try { seeds = (await kernai.predict(f, curMasterId(), filled, { root: ROOT })) || {}; } catch (e) { seeds = {}; }
    var usedAI = Object.keys(seeds).length > 0;
    try { res = kernvision.buildKernVision(f, curMasterId(), { aggr: aggr, seeds: seeds }); }
    catch (e) { setStatus('Visual Kern failed: ' + ((e && e.message) || e), 'err'); return; }
    f.kernOverride = res.table; f.aiKernOwned = false;   // Visual Kern owns the table now
    kernCache = {};                        // drop any geometric values cached before the override existed
    renderTesterText(); refreshTester(); autosave();
    setStatus('Visual Kern — ' + res.pairs + ' pair(s) evened across ' + res.glyphs + ' glyphs' +
      (usedAI ? ', AI-seeded' : '') + ' (' + (Date.now() - t0) + 'ms).', 'ok');
  }, 16);
}
function onVisualKernClear() {
  var f = curFont(); if (!f) return;
  f.kernOverride = {}; f.aiKernOwned = false;
  kernCache = {};
  renderTesterText(); refreshTester(); autosave();
  setStatus('Visual Kern cleared — back to live optical kern.', 'ok');
}
// Kern → Bearings: the "space first, kern the exceptions" pass. Takes the AI's per-pair kerns
// (f.kernOverride), bakes each letter's AVERAGE left/right kern into its sidebearings, and leaves
// only the residual exceptions as kerning (shared/kernvision.js redistributeToBearings). Total
// spacing is PRESERVED — the text looks identical — but the font becomes properly spaced with a
// small, clean kern table (the professional way to build a font). Run AFTER Visual Kern.
function onKernToBearings() {
  if (!FEAT.optimize) return;
  var f = curFont(); var mid = curMasterId();
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilled(g) && g.char && g.unicode >= 0x21) filled.push(g); });
  if (filled.length < 2) { setStatus('En az iki yerleşmiş glyph gerekli.', 'err'); return; }
  if (!f.kernOverride || !Object.keys(f.kernOverride).length) { setStatus('Önce "Visual Kern"i çalıştır.', 'err'); return; }
  bakeAllOrigins(f);                                   // fold blue-line offsets so bearing edits are clean
  var names = filled.map(function (g) { return g.name; });
  var full = {};                                       // every ordered pair (absent = 0)
  for (var i = 0; i < filled.length; i++) for (var j = 0; j < filled.length; j++) {
    if (i === j) continue;
    var key = filled[i].name + ',' + filled[j].name;
    full[key] = f.kernOverride[key] || 0;
  }
  var rb = kernvision.redistributeToBearings(full, names);
  var moved = 0;
  filled.forEach(function (g) {
    var b = rb.bearings[g.name]; if (!b) return;
    var l = g.layers[mid]; if (!l || !l.contours || !l.contours.length) return;
    if (b.dL) l.contours = shiftContoursXY(l.contours, b.dL, 0);   // add dL to LSB (move ink)
    g.advanceWidth = Math.round((g.advanceWidth || 0) + b.dL + b.dR);  // dL keeps RSB, dR adds to it
    if (b.dL || b.dR) moved++;
  });
  f.kernOverride = rb.residual; f.aiKernOwned = false; // full residual; exportKernTable drops the ~0s
  flatCache = {}; kernCache = {};
  renderTesterText(); refreshTester(); renderGrid(); autosave();
  var rk = 0; for (var k in rb.residual) if (Math.abs(rb.residual[k]) >= 6) rk++;
  setStatus('Kern ortalaması ' + moved + ' harfin bearing\'ine dağıtıldı — görsel korundu, kern istisnaları ' + rk + ' çift.', 'ok');
}
// AI Spacing — one click: the trained PARAGRAPH model proposes every pair kern, then its per-letter
// AVERAGE is baked into each letter's BEARING (Kern→Bearings), leaving only the exceptions as kern.
// So the second (paragraph) AI determines BOTH the kerning AND the bearings in a single pass. Composes
// on top of whatever optical bearings the sidebearing AI already set (it shifts them by the kern average).
function onAISpacing() {
  if (!FEAT.optimize) return;
  var f = curFont();
  var filled = [];
  f.glyphs.forEach(function (g) { if (isFilled(g) && g.char && g.unicode >= 0x21) filled.push(g); });
  if (filled.length < 2) { setStatus('En az iki yerleşmiş glyph gerekli.', 'err'); return; }
  var aggrEl = $('vkAggr'); var aggr = aggrEl ? ((+aggrEl.value || 0) / 100) : 0.6;
  setStatus('AI Spacing — paragraf modeli analiz ediyor…');
  bakeAllOrigins(f); flatCache = {}; kernCache = {};
  setTimeout(async function () {
    var t0 = Date.now(), seeds = {};
    try { seeds = (await kernai.predict(f, curMasterId(), filled, { root: ROOT })) || {}; } catch (e) { seeds = {}; }
    var usedAI = Object.keys(seeds).length > 0;
    var res;
    try { res = kernvision.buildKernVision(f, curMasterId(), { aggr: aggr, seeds: seeds }); }
    catch (e) { setStatus('AI Spacing failed: ' + ((e && e.message) || e), 'err'); return; }
    f.kernOverride = res.table; f.aiKernOwned = false; kernCache = {};
    onKernToBearings();                               // bake the AI kern average into the bearings
    var rk = 0; if (f.kernOverride) for (var k in f.kernOverride) if (Math.abs(f.kernOverride[k]) >= 6) rk++;
    setStatus('AI Spacing — ' + res.glyphs + ' harf' + (usedAI ? ', AI (paragraf)' : '') +
      ': bearing\'ler ayarlandı + ' + rk + ' istisna kern (' + (Date.now() - t0) + 'ms).', 'ok');
  }, 16);
}

// ---- live font tester (@font-face from the built OTF) ----
var testerDirty = false;
function refreshTester() {
  var f = curFont(); if (!f) return;
  // PERF: building the @font-face is a FULL font compile (opentype.js buildFont +
  // serialize). Skip it entirely unless a tester is actually on screen — otherwise
  // every draw/optimize/poll paid a whole-alphabet compile for nothing. Mark dirty
  // and rebuild lazily when the tester is shown.
  var ftWin = $('floatTester');
  if (activeSection !== 'test' && !(ftWin && !ftWin.classList.contains('hidden'))) { testerDirty = true; return; }
  testerDirty = false;
  syncSpaceSliders();   // reflect the font's saved space width
  var filled = f.glyphs.filter(isFilled).length;
  var styleEl = $('fm-faces') || (function () { var st = document.createElement('style'); st.id = 'fm-faces'; document.head.appendChild(st); return st; })();
  if (!filled) { styleEl.textContent = ''; $('t-text').style.fontFamily = 'inherit'; applyTesterCtl(); return; }
  try {
    // build from the FILLED glyphs only, so letters you haven't drawn fall back
    // to a standard system face instead of vanishing. The SPACE glyph rides along even
    // though it has no contours — its advance is the Space slider's product and must
    // preview exactly as it exports (testing == export for whitespace too).
    var sub = {}; for (var k in f) sub[k] = f[k];
    var tMid = curMasterId();
    sub.glyphs = f.glyphs.filter(function (g) { return isFilled(g) || g.unicode === 0x20 || g.unicode === 0xA0; }).map(function (g) {
      var lx = g.lsbLineX || 0; if (!lx) return g;          // fold the LSB offset in (non-mutating)
      var ng = {}; for (var kk in g) ng[kk] = g[kk];
      var nl = {}; for (var mm in g.layers) nl[mm] = g.layers[mm];
      var gl = g.layers[tMid];
      if (gl && gl.contours && gl.contours.length) nl[tMid] = { contours: shiftContoursXY(gl.contours, -lx, 0) };
      ng.layers = nl; ng.lsbLineX = 0;
      return ng;
    });
    var built = fontEngine.buildFont(sub, 'otf', { familyName: 'RTLive', styleName: 'Regular', masterId: curMasterId() });
    // Bake the REAL kern table into the preview font → the browser renders kerning + ligatures
    // NATIVELY (font-kerning:normal), exactly like Photoshop/Illustrator (no manual margin replica).
    var buf = built.buffer;
    try { buf = kerninject.injectKernTable(buf, exportKernTable(f), sub.glyphs); } catch (e) {}
    var fam;
    if (window.FontFace && document.fonts) {
      fam = 'RTLive_' + (++faceSeq);
      var face = new FontFace(fam, buf);
      document.fonts.add(face);
      if (!window.__rtFaces) window.__rtFaces = [];
      window.__rtFaces.push(face);
      while (window.__rtFaces.length > 2) document.fonts['delete'](window.__rtFaces.shift());
    } else {
      fam = 'RTLive_' + (++faceSeq);
      var b64 = Buffer.from(new Uint8Array(buf)).toString('base64');
      styleEl.textContent = '@font-face{font-family:"' + fam + '";src:url(data:font/otf;base64,' + b64 + ') format("opentype");}';
    }
    // fallback chain: drawn glyphs use the font, the rest use a standard face
    $('t-text').style.fontFamily = '"' + fam + '", "Adobe Clean", system-ui, sans-serif';
  } catch (e) { /* tester is best-effort */ }
  applyTesterCtl();
}
function applyTesterCtl() {
  var t = $('t-text');
  t.style.fontSize = $('t-size').value + 'px';
  t.style.fontKerning = 'normal';          // native kern from the embedded kern table (PS/Illustrator-accurate)
  t.style.letterSpacing = ((($('t-track') ? +$('t-track').value : 0)) / 1000).toFixed(4) + 'em';
  t.style.fontFeatureSettings = testLiga ? '"liga" 1, "clig" 1' : '"liga" 0, "clig" 0';
  renderTesterText(); renderFloatTester();
}
// ---- space character width (the testing 'Space' slider) ----
function spaceGlyph(f) { f = f || curFont(); if (!f) return null; for (var i = 0; i < f.glyphs.length; i++) if (f.glyphs[i].char === ' ') return f.glyphs[i]; return null; }
function spaceAdvance(f) { f = f || curFont(); var upm = f ? (f.unitsPerEm || 1000) : 1000; var g = spaceGlyph(f); return (g && g.advanceWidth) ? g.advanceWidth : Math.round(0.25 * upm); }
function syncSpaceSliders() {                            // reflect the font's space width on BOTH sliders
  var f = curFont(); var pct = f ? Math.round(spaceAdvance(f) / (f.unitsPerEm || 1000) * 100) : 25;
  ['t-space', 'm-space'].forEach(function (id) { var el = $(id); if (el) el.value = pct; });
  if ($('mSpaceVal')) $('mSpaceVal').textContent = pct + '%';
}
// Image-imported fonts have NO space glyph (the sheet sequences carry no blank),
// so the Space slider had nowhere to persist its value → syncSpaceSliders read back
// the 25% default and snapped the slider back mid-drag (looked un-draggable). Create
// the glyph on demand — the exported font then actually HAS a space character too.
function ensureSpaceGlyph(f) {
  f = f || curFont(); if (!f) return null;
  var g = spaceGlyph(f); if (g) return g;
  var layers = {}; (f.masters || []).forEach(function (m) { layers[m.id] = { contours: [] }; });
  g = { name: 'space', char: ' ', unicode: 32, alphabet: 'custom',
        advanceWidth: Math.round(0.25 * (f.unitsPerEm || 1000)), layers: layers };
  f.glyphs.push(g);
  return g;
}
function setSpaceWidth(pct, commit) {                    // % of em → space glyph advance (saved into the font)
  var f = curFont(); if (!f) return;
  if (isNaN(pct)) pct = 25;
  var g = ensureSpaceGlyph(f); if (g) g.advanceWidth = Math.round(pct / 100 * (f.unitsPerEm || 1000));
  syncSpaceSliders();
  renderTesterText(); renderFloatTester();
  if (commit) autosave();
}

// Rebuild the line as spans: each gap = track + the pair's kern (Optical live /
// Metric from the table), scaled to the current size. Caret is preserved.
// per-occurrence alternate picks in the tester: text-position index -> glyph index
var testerAlts = {};
var testLiga = true;   // tester: substitute ligatures (the "Ligatures" toggle)
// Pre-filter the drawn ligature glyphs ONCE per render (avoids an all-glyphs scan
// per character). Longest match wins so e.g. 'ffi' beats 'fi'.
function drawnLigatures(f, mid) {
  return f.glyphs.filter(function (g) {
    return g.kind === 'ligature' && g.components && g.components.length &&
      g.layers && g.layers[mid] && g.layers[mid].contours && g.layers[mid].contours.length;
  }).sort(function (a, b) { return b.components.length - a.components.length; });
}
function matchLigatureAt(ligs, text, i) {
  for (var k = 0; k < ligs.length; k++) {                        // already longest-first
    var comps = ligs[k].components, n = comps.length;
    if (i + n > text.length) continue;
    var ok = true;
    for (var c = 0; c < n; c++) if (text[i + c] !== comps[c]) { ok = false; break; }
    if (ok) return ligs[k];
  }
  return null;
}
function altsOfBase(f, base) {
  var out = [];
  for (var i = 0; i < f.glyphs.length; i++) { var g = f.glyphs[i]; if (g.kind === 'alternate' && g.baseName === base.name) out.push(i); }
  return out;
}
// The text is reconstructed from the DOM: real text nodes contribute their text;
// an alternate rendered as an inline SVG carries its character in data-altch (it
// has no text of its own), so the model never loses a character to an override.
function testerText() {
  var el = $('t-text'); if (!el) return '';
  var out = '';
  (function walk(node) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var n = node.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue.replace(/ /g, ' ');
      else if (n.nodeType === 1) {
        if (n.hasAttribute && n.hasAttribute('data-altch')) out += n.getAttribute('data-altch');
        else if (n.hasAttribute && n.hasAttribute('data-ligch')) out += n.getAttribute('data-ligch');
        else walk(n);
      }
    }
  })(el);
  return out;
}
function caretOffset(el) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return -1;
  var r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return -1;
  var pre = r.cloneRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaret(el, off) {
  if (off < 0) return;
  var sel = window.getSelection(), range = document.createRange(), seen = 0;
  function walk(node) {
    if (node.nodeType === 3) {
      var next = seen + node.length;
      if (off <= next) { range.setStart(node, off - seen); return true; }
      seen = next;
    } else for (var i = 0; i < node.childNodes.length; i++) if (walk(node.childNodes[i])) return true;
    return false;
  }
  if (walk(el)) { range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
}
function renderTesterText() {
  var el = $('t-text'); if (!el) return;
  var hasAlts = false; for (var ak in testerAlts) { if (testerAlts[ak] != null) { hasAlts = true; break; } }
  if (!hasAlts) {
    // NATIVE Photoshop/Illustrator rendering (DEFAULT): the contenteditable holds PLAIN text; the
    // @font-face (built WITH the real kern table by refreshTester) + font-kerning:normal +
    // font-feature-settings render ligatures + kerning natively — no per-char spans / manual margins,
    // so both previews match and look exactly like the exported font in PS/AI. Click-to-edit still
    // works: the click handler maps the POINT → char → glyph (testerCharIndex), no spans needed.
    if (el.querySelector('span,svg')) { var off0 = caretOffset(el); el.textContent = testerText(); setCaret(el, off0); }
    el.style.fontKerning = 'normal';
    el.style.letterSpacing = ((($('t-track') ? +$('t-track').value : 0)) / 1000).toFixed(4) + 'em';
    el.style.fontFeatureSettings = testLiga ? '"liga" 1, "clig" 1' : '"liga" 0, "clig" 0';
    return;
  }
  // --- per-char renderer — ONLY while per-occurrence ALTERNATES are active (right-click a letter →
  //     pick an alternate). Plain native text can't swap a single occurrence's glyph, so each position
  //     renders as an inline glyph spaced by pairKern (== export). Native CSS spacing is cleared so the
  //     manual per-span margins aren't doubled. Default view above stays fully native. ---
  el.style.letterSpacing = ''; el.style.fontKerning = ''; el.style.fontFeatureSettings = '';
  var f = fonts.length ? curFont() : null;
  var text = testerText();
  var mode = $('t-kern').value;
  var fsPx = parseFloat($('t-size').value);
  var trackPx = $('t-track').value / 10;
  var mid = f ? curMasterId() : null, M = f ? f.metrics : null, upm = f ? (f.unitsPerEm || 1000) : 1000;
  var off = caretOffset(el);
  var html = '';
  var ligs = (testLiga && f) ? drawnLigatures(f, mid) : [];
  for (var i = 0; i < text.length; i++) {
    // LIGATURE: if the toggle is on and the upcoming letters match a drawn ligature's
    // components, render the ligature glyph (inline SVG) and consume those letters.
    if (ligs.length) {
      var lig = matchLigatureAt(ligs, text, i);
      if (lig) {
        var lc = lig.layers[mid].contours, lw = lig.advanceWidth || Math.round(upm * 0.6);
        var lW = lw / upm * fsPx, lH = (M.ascender - M.descender) / upm * fsPx, lVA = M.descender / upm * fsPx;
        var afterCh = text[i + lig.components.length], lkern = 0;
        if (afterCh != null) { var gAf = null; for (var ax = 0; ax < f.glyphs.length; ax++) { if (f.glyphs[ax].char === afterCh) { gAf = f.glyphs[ax]; break; } } lkern = pairKern(f, lig, gAf, mode) / upm * fsPx; }
        var lmarg = (trackPx + lkern).toFixed(2), ligch = lig.components.join('').replace(/"/g, '&quot;');
        var ligIdx = f.glyphs.indexOf(lig), ligSel = (ligIdx === selectedSlot) ? ' tsel' : '';
        // contenteditable="false" makes the ligature an ATOMIC unit (delete it, type
        // around it like a letter); data-gi makes a click select+open it on the right.
        html += '<span contenteditable="false" data-ti="' + i + '" data-gi="' + ligIdx + '" data-ligch="' + ligch + '" class="tletter tlig' + ligSel + '" ' +
                'style="display:inline-block;line-height:0;width:' + lW.toFixed(2) + 'px;height:' + lH.toFixed(2) + 'px;vertical-align:' + lVA.toFixed(2) + 'px;margin-right:' + lmarg + 'px;">' +
                '<svg width="' + lW.toFixed(2) + '" height="' + lH.toFixed(2) + '" viewBox="0 ' + (-M.ascender) + ' ' + lw + ' ' + (M.ascender - M.descender) + '" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible"><path d="' + contoursToSVG(lc) + '" fill="currentColor"/></svg></span>';
        i += lig.components.length - 1;
        continue;
      }
    }
    var ch = text[i], kernPx = 0, baseIdx = -1, gL = null;
    if (f) {
      for (var gx = 0; gx < f.glyphs.length; gx++) { if (f.glyphs[gx].char === ch) { gL = f.glyphs[gx]; if (isFilled(gL)) baseIdx = gx; break; } }
    }
    // a chosen alternate for THIS occurrence (and only this one) overrides the glyph
    var ov = (testerAlts[i] != null && f && f.glyphs[testerAlts[i]] && gL && f.glyphs[testerAlts[i]].baseName === gL.name && isFilled(f.glyphs[testerAlts[i]])) ? testerAlts[i] : -1;
    var renderG = ov >= 0 ? f.glyphs[ov] : gL;     // glyph actually shown (drives kerning too)
    var giData = ov >= 0 ? ov : baseIdx;
    if (f && i < text.length - 1) {
      var gR = null;
      for (var rx = 0; rx < f.glyphs.length; rx++) { if (f.glyphs[rx].char === text[i + 1]) { gR = f.glyphs[rx]; break; } }
      kernPx = pairKern(f, renderG, gR, mode) / upm * fsPx;
    }
    var marg = (trackPx + kernPx).toFixed(2);
    var cls = 'tletter' + (giData >= 0 && giData === selectedSlot ? ' tsel' : '');
    var idAttr = ' data-ti="' + i + '"' + (giData >= 0 ? ' data-gi="' + giData + '"' : '');
    if (ov >= 0 && renderG.layers[mid] && renderG.layers[mid].contours && renderG.layers[mid].contours.length) {
      // render the alternate as an inline glyph so ONLY this occurrence changes;
      // data-altch keeps the character in the model (testerText) despite no text
      var ac = renderG.layers[mid].contours, aw = renderG.advanceWidth || (gL && gL.advanceWidth) || Math.round(upm * 0.5);
      var asc = M.ascender, desc = M.descender;
      var W = aw / upm * fsPx, H = (asc - desc) / upm * fsPx, vAlign = desc / upm * fsPx;
      var chEsc = ch === ' ' ? ' ' : ch;
      html += '<span contenteditable="false"' + idAttr + ' data-altch="' + chEsc.replace(/"/g, '&quot;') + '" class="' + cls + ' talt" ' +
              'style="display:inline-block;line-height:0;width:' + W.toFixed(2) + 'px;height:' + H.toFixed(2) + 'px;vertical-align:' + vAlign.toFixed(2) + 'px;margin-right:' + marg + 'px;">' +
              '<svg width="' + W.toFixed(2) + '" height="' + H.toFixed(2) + '" viewBox="0 ' + (-asc) + ' ' + aw + ' ' + (asc - desc) + '" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible"><path d="' + contoursToSVG(ac) + '" fill="currentColor"/></svg></span>';
    } else if (ch === ' ') {
      // the SPACE glyph's own advance (set by the testing 'Space' slider), so its
      // width is the real font space, not the browser's &nbsp;
      var spW = spaceAdvance(f) / upm * fsPx;
      html += '<span' + idAttr + ' class="' + cls + '" style="display:inline-block;width:' + spW.toFixed(2) + 'px;margin-right:' + marg + 'px">&nbsp;</span>';
    } else {
      html += '<span' + idAttr + ' class="' + cls + '" style="margin-right:' + marg + 'px">' +
              ch.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>';
    }
  }
  el.innerHTML = html || '';
  setCaret(el, off);
}
// Native preview holds PLAIN text (no per-char spans, so kerning/ligatures render natively). To keep
// click-to-edit working, map a click POINT back to the character index under it via the caret API +
// per-char client rects — then we can select/open that glyph exactly like the old span did.
function testerCharIndex(el, x, y) {
  if (!el) return -1;
  var node = el.firstChild;
  if (!node || node.nodeType !== 3) return -1;                 // single plain text node
  var text = node.nodeValue || ''; if (!text.length) return -1;
  function rectOf(i) { var r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);
    var rs = r.getClientRects(); return rs.length ? rs[rs.length - 1] : null; }
  var guess = -1;
  if (document.caretRangeFromPoint) { var rng = document.caretRangeFromPoint(x, y); if (rng && rng.startContainer === node) guess = rng.startOffset; }
  for (var k = 0; k < 2; k++) {                                 // the caret snaps to a gap → test char at guess, then guess-1
    var gi = guess - k; if (gi < 0 || gi >= text.length) continue;
    var rc = rectOf(gi); if (rc && x >= rc.left - 0.5 && x <= rc.right + 0.5 && y >= rc.top - 2 && y <= rc.bottom + 2) return gi;
  }
  for (var j = 0; j < text.length; j++) { var b = rectOf(j); if (b && x >= b.left && x <= b.right && y >= b.top - 2 && y <= b.bottom + 2) return j; }
  return guess >= 0 ? Math.min(text.length - 1, guess) : -1;
}
// Which glyph index a tester position renders (a per-occurrence alternate if one was chosen, else the
// base glyph for that char) — mirrors the renderer so a click selects the glyph you actually see.
function testerGlyphAt(f, text, i) {
  if (!f || i < 0 || i >= text.length) return -1;
  var ch = text[i], gL = null, baseIdx = -1;
  for (var gx = 0; gx < f.glyphs.length; gx++) { if (f.glyphs[gx].char === ch) { gL = f.glyphs[gx]; if (isFilled(gL)) baseIdx = gx; break; } }
  var alt = testerAlts[i];
  if (alt != null && f.glyphs[alt] && gL && f.glyphs[alt].baseName === gL.name && isFilled(f.glyphs[alt])) return alt;
  return baseIdx;
}
function setTesterBg(darkBg) {
  var p = $('t-paper');
  if (p) { p.classList.toggle('dark', darkBg); p.classList.toggle('light', !darkBg); }
  $('bg-b').classList.toggle('on', darkBg);
  $('bg-w').classList.toggle('on', !darkBg);
}
// ---- floating Live Test window: live-renders a word with the CURRENT spacing/kern
// so you can watch modification changes update in place. Cheap (one short line) and
// no-ops while hidden, so it costs nothing when closed. ----
function renderFloatTester() {
  var win = $('floatTester'); if (!win || win.classList.contains('hidden')) return;
  var box = $('ft-text'); if (!box) return;
  var text = $('ft-input') ? $('ft-input').value : 'Handgloves'; if (!text) text = ' ';
  // NATIVE rendering with the SAME kern-bearing @font-face as the testing page → the two previews
  // are identical and exactly like Photoshop/Illustrator (native kern + ligatures).
  box.textContent = text;
  box.style.fontFamily = $('t-text') ? $('t-text').style.fontFamily : 'inherit';
  box.style.fontSize = (parseFloat($('ft-size') ? $('ft-size').value : 48) || 48) + 'px';
  box.style.fontKerning = 'normal';
  box.style.letterSpacing = ((($('t-track') ? +$('t-track').value : 0)) / 1000).toFixed(4) + 'em';
  box.style.fontFeatureSettings = testLiga ? '"liga" 1, "clig" 1' : '"liga" 0, "clig" 0';
  return;
  // --- legacy SVG renderer below is unused (native rendering above) ---
  var f = fonts.length ? curFont() : null;
  var fsPx = parseFloat($('ft-size') ? $('ft-size').value : 48) || 48;
  var mode = $('t-kern') ? $('t-kern').value : 'metric';
  var trackPx = $('t-track') ? ($('t-track').value / 10) : 0;
  var mid = f ? curMasterId() : null, M = f ? f.metrics : null, upm = f ? (f.unitsPerEm || 1000) : 1000;
  var html = '';
  for (var i = 0; i < text.length; i++) {
    var ch = text[i], gL = null, kernPx = 0;
    if (f) for (var gx = 0; gx < f.glyphs.length; gx++) { if (f.glyphs[gx].char === ch) { gL = f.glyphs[gx]; break; } }
    if (f && i < text.length - 1) {
      var gR = null; for (var rx = 0; rx < f.glyphs.length; rx++) { if (f.glyphs[rx].char === text[i + 1]) { gR = f.glyphs[rx]; break; } }
      kernPx = pairKern(f, gL, gR, mode) / upm * fsPx;
    }
    var marg = (trackPx + kernPx).toFixed(2);
    if (ch === ' ') { var sw = spaceAdvance(f) / upm * fsPx; html += '<span style="display:inline-block;width:' + sw.toFixed(2) + 'px;margin-right:' + marg + 'px"></span>'; continue; }
    if (gL && isFilled(gL) && M) {
      var ac = gL.layers[mid].contours, aw = gL.advanceWidth || Math.round(upm * 0.5);
      var asc = M.ascender, desc = M.descender, W = aw / upm * fsPx, H = (asc - desc) / upm * fsPx, vA = desc / upm * fsPx;
      html += '<span style="display:inline-block;line-height:0;width:' + W.toFixed(2) + 'px;height:' + H.toFixed(2) + 'px;vertical-align:' + vA.toFixed(2) + 'px;margin-right:' + marg + 'px">' +
              '<svg width="' + W.toFixed(2) + '" height="' + H.toFixed(2) + '" viewBox="0 ' + (-asc) + ' ' + aw + ' ' + (asc - desc) + '" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible"><path d="' + contoursToSVG(ac) + '" fill="currentColor"/></svg></span>';
    } else {
      html += '<span style="margin-right:' + marg + 'px">' + ch.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>';
    }
  }
  box.innerHTML = html;
}
function toggleLiveTest() {
  var win = $('floatTester'); if (!win) return;
  win.classList.toggle('hidden');
  if (!win.classList.contains('hidden')) { if (testerDirty) refreshTester(); renderFloatTester(); }
}
// make an element draggable by a handle (used for the Live Test window)
function makeDraggable(win, handle) {
  if (!win || !handle) return;
  var dx = 0, dy = 0, down = false;
  handle.addEventListener('mousedown', function (e) {
    if (e.target && e.target.id === 'ft-close') return;
    down = true; var r = win.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top;
    win.style.right = 'auto'; win.style.left = r.left + 'px'; win.style.top = r.top + 'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!down) return;
    win.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dx)) + 'px';
    win.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - dy)) + 'px';
  });
  document.addEventListener('mouseup', function () { down = false; });
}

// ---- live sync: poll the active glyph project, update that glyph live ----
// Self-scheduling + adaptive so it doesn't hammer Illustrator with script forever:
//  • when the panel is HIDDEN (collapsed tab / Illustrator minimised) it backs off
//    and skips the host call entirely — the Page Visibility API works in CEP;
//  • when nothing's changed for a few ticks it widens 700ms → 3s, snapping back to
//    700ms the instant a live edit is detected, so drawing still feels instant.
var POLL_MS = 2500, POLL_MAX = 6000, pollMs = POLL_MS, pollIdle = 0, polling = false, lastSig = {}, testerTimer = null;   // PERF: gentle background live-sync (was 700ms); instant sync on panel focus instead
// Selection poll cadence: snappy (1.2s) for the Assign-shape preview, but drops to a
// slow heartbeat on a TEMPLATE document (no live select there → stop hammering it).
var POLL_SEL_MS = 2500, POLL_SEL_MAX = 6000, pollSelMs = POLL_SEL_MS;   // PERF: slower assign-preview poll (was 1200) — less Illustrator hammering
var templateUntil = 0;   // PERF: once a TEMPLATE doc is detected, stop polling Illustrator for 30s (templates use Import, not live sync) — re-checks after
function panelHidden() { return (typeof document !== 'undefined' && document.hidden) || $('view-work').classList.contains('hidden') || !fonts.length; }
function pollBackoff(changed, hard) {
  if (changed) { pollMs = POLL_MS; pollIdle = 0; }
  else if (hard) { pollMs = POLL_MAX; pollIdle = 99; }     // template/idle doc → straight to the slow heartbeat
  else if (++pollIdle > 4 && pollMs < POLL_MAX) pollMs = Math.min(POLL_MAX, pollMs + 350);
}
function startPolling() {
  if (polling) return; polling = true;
  // PERF: only round-trip to Illustrator when truly needed. pollActive (live glyph-edit sync) runs
  // ONLY while a glyph is open for editing; pollSelection ONLY on the glyphs page. Otherwise the
  // loops tick slowly and do nothing, so the panel stops hammering Illustrator (the main lag source).
  (function loopA() { setTimeout(function () { try { pollActive(); } catch (e) {} loopA(); }, (openGlyphIndex >= 0 && !panelHidden()) ? pollMs : 3000); })();
  (function loopS() { setTimeout(function () { try { pollSelection(); } catch (e) {} loopS(); }, (activeSection === 'glyphs' && !panelHidden()) ? pollSelMs : 3000); })();
}

// Live-read the Illustrator selection while on the glyphs page so the Assign
// handle shows the shape you're about to drop and the drop is instant.
function pollSelection() {
  if (panelHidden() || activeSection !== 'glyphs') return;
  if (templateUntil && Date.now() < templateUntil) return;   // on a template → don't poll Illustrator
  evalScript('fmReadSelection()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { res = null; }
    if (res && res.error === 'template') { pollSelMs = POLL_SEL_MAX; templateUntil = Date.now() + 30000; return; }   // template doc → stop polling for 30s
    templateUntil = 0; pollSelMs = POLL_SEL_MS;
    var contours = (res && res.ok && res.paths) ? ilbridge.contoursFromSelection(res.paths) : null;
    var had = !!(selSourceContours && selSourceContours.length);
    selSourceContours = (contours && contours.length) ? contours : null;
    if (!!selSourceContours !== had) updateAssign(); // refresh the handle preview
  });
}
// A small SVG thumbnail of contours (font units, y-up) for the Assign handle.
function shapeThumbSVG(contours, cls) {
  var b = glyphset.contoursBounds(contours); if (!b) return '';
  var pad = Math.max(b.w, b.h) * 0.12 + 1;
  var vb = (b.minX - pad) + ' ' + (-(b.maxY) - pad) + ' ' + (b.w + pad * 2) + ' ' + (b.h + pad * 2);
  return '<svg class="' + (cls || '') + '" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
         '<path d="' + contoursToSVG(contours) + '" fill="#fff"/></svg>';
}
function scheduleTester() { if (testerTimer) clearTimeout(testerTimer); testerTimer = setTimeout(refreshTester, 1200); }

function pollActive() {
  if (panelHidden() || openGlyphIndex < 0) return;   // PERF: live-sync ONLY while a glyph is open for editing — no Illustrator round-trips otherwise
  if (templateUntil && Date.now() < templateUntil) return;   // on a template → don't poll Illustrator
  evalScript('fmReadActive()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { return pollBackoff(false); }
    if (res && res.error === 'template') { templateUntil = Date.now() + 30000; return pollBackoff(false, true); }   // template sheet → stop polling for 30s
    if (!res || !res.ok || !res.paths || !res.paths.length) return pollBackoff(false);
    var f = curFont();
    // multiple glyph projects can be open — map the ACTIVE document to its glyph
    var idx = -1;
    if (res.glyph) { f.glyphs.forEach(function (g, k) { if (g.name === res.glyph) idx = k; }); }
    if (idx < 0) idx = openGlyphIndex;
    if (idx < 0 || idx >= f.glyphs.length) return pollBackoff(false);
    var contours = ilbridge.contoursFromArtboard(res.paths, res.rect, res.scale, f.metrics.descender);
    if (!contours.length) return pollBackoff(false);
    var adv = (res.rect[2] - res.rect[0]) / res.scale;
    // Skip unchanged reads BEFORE writing: the write is what clears a composed glyph's
    // composedFrom marker (glyphset.setGlyphContours), so an idle poll echo must not count
    // as a hand edit (and skipping the whole set is cheaper anyway).
    var lyr = { contours: contours };
    var sigLayers = {}; sigLayers[curMasterId()] = lyr;
    var sig = glyphset.layerSignature({ layers: sigLayers }, curMasterId());
    if (sig === lastSig[idx] && Math.round(adv) === f.glyphs[idx].advanceWidth) return pollBackoff(false);
    glyphset.setGlyphContours(f, idx, curMasterId(), contours, adv);
    lastSig[idx] = sig; pollBackoff(true);
    refreshGlyphCell(idx);                       // PERF: update the ONE changed cell, not the whole grid
    if (activeSection === 'mod') renderModGrid();
    if (idx === selectedSlot) renderRight();
    renderFloatTester();
    setStatus('Live · "' + glyphLabel(f.glyphs[idx]) + '" updated from its project', 'ok');
    scheduleTester(); autosave();
  });
}

// ---- edition gate: premium controls stay VISIBLE but DISABLED (an upsell),
// never hidden. One flag (features.js) drives the whole surface, so flipping
// EDITION to 'pro' unlocks everything with no other change. ----
function lockCtl(id, on, tip) {
  var e = $(id); if (!e) return;
  e.disabled = !on;
  if (!on) { e.classList.add('pro-locked'); if (tip) e.title = tip; }
  else { e.classList.remove('pro-locked'); }
}
function lockFmt(id, on) {   // export-format checkbox + its "soon" tag
  var cb = $(id); if (!cb) return;
  cb.disabled = !on; if (!on) cb.checked = false;
  var lab = cb.parentNode;
  if (lab && lab.classList) lab.classList.toggle('dim', !on);
  var soon = lab && lab.querySelector ? lab.querySelector('.muted') : null;
  if (soon) soon.style.display = on ? 'none' : '';
}
function applyEdition() {
  var PRO = 'Pro feature — upgrade to unlock';
  lockCtl('m-add', FEAT.masters, PRO); lockCtl('m-name', FEAT.masters, PRO); lockCtl('m-ddbtn', FEAT.masters, PRO);
  lockCtl('w-masterSel', FEAT.masters, PRO);
  lockCtl('countryBtn', !FEAT.charsets, PRO);           // country auto-select (locked sets greyed in the list)
  lockCtl('tg-grid', FEAT.gridPresets, 'Grid presets are a Pro feature');
  lockCtl('nf-opentpl', FEAT.template, PRO); lockCtl('nf-importtpl', FEAT.template, PRO);
  lockCtl('openTplBtn', FEAT.template, PRO); lockCtl('importTplBtn', FEAT.template, PRO);
  lockCtl('altBtn', FEAT.alternates, PRO); lockCtl('altChip', FEAT.alternates, PRO);
  lockCtl('ligBtn', FEAT.alternates, PRO); lockCtl('ligInput', FEAT.alternates, PRO);
  lockCtl('accentTplBtn', FEAT.accents, PRO); lockCtl('accentImportBtn', FEAT.accents, PRO);
  lockCtl('composeAccentsBtn', FEAT.accents, PRO);
  lockCtl('optimizeBtn', FEAT.optimize, PRO);
  lockCtl('refSpace', FEAT.optimize, PRO); lockCtl('moBlend', FEAT.optimize, PRO);
  lockCtl('moBearingAI', FEAT.optimize, PRO); lockCtl('moKern', FEAT.optimize, PRO); lockCtl('moKernAI', FEAT.optimize, PRO);
  lockCtl('moTrack', FEAT.optimize, PRO); lockCtl('aiAnalyze', FEAT.optimize, PRO);
  lockFmt('exOtf', FEAT.exportOtf); lockFmt('exTtf', FEAT.exportTtf); lockFmt('exVar', FEAT.exportVariable);
}

// ---- boot ----
function boot() {
  // Reload the ExtendScript (jsx) from disk on every panel open. The manifest <ScriptPath> loads
  // fontmaker.jsx ONCE into the host's ExtendScript engine, which persists for the whole Illustrator
  // session — so edits to the jsx (e.g. template cell sizes) otherwise need a full Illustrator
  // RESTART, not just a panel reopen. Re-evaluating the current file here redefines every fm*
  // function fresh, so a panel reopen (with the ?v= cache-busted main.js) is enough.
  try { evalScript(fs.readFileSync(ROOT + '/jsx/fontmaker.jsx', 'utf8')); } catch (e) {}
  buildPage1(); show('new');
  // page 1 (RuneType)
  $('m-add').addEventListener('click', onAddMaster);
  $('m-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAddMaster(); });
  $('m-name').addEventListener('input', updateMasterAdd);
  $('m-ddbtn').addEventListener('click', function () { $('m-list').classList.toggle('hidden'); });
  $('tg-lang').addEventListener('click', function () { setToggle('lang'); });
  $('tg-grid').addEventListener('click', function () { setToggle('preset'); });
  if ($('modeBasic')) $('modeBasic').addEventListener('click', function () { setMode('basic'); });
  if ($('modeAdv')) $('modeAdv').addEventListener('click', function () { setMode('advanced'); });
  applyMode();   // start in Basic by default
  $('countryBtn').addEventListener('click', function () { $('countryList').classList.toggle('hidden'); });
  $('nf-family').addEventListener('input', renderProfile);
  if ($('nf-imgimport')) $('nf-imgimport').addEventListener('click', onImgImportPage1);
  // Image Import parked as a demo — hide both entry buttons (New Font dialog + workspace).
  if (!IMG_IMPORT_ENABLED) {
    ['nf-imgimport', 'imgImportBtn'].forEach(function (id) { var el = $(id); if (el) el.style.display = 'none'; });
  }
  $('nf-opentpl').addEventListener('click', onOpenTemplate);
  $('nf-importtpl').addEventListener('click', onImportTemplate);
  $('nf-import').addEventListener('click', onImport);
  $('nf-create').addEventListener('click', onStartCreating);
  // page 2 (workspace)
  $('w-home').addEventListener('click', function () { draft = newDraft(); buildPage1(); show('new'); });
  if ($('glyphSearch')) $('glyphSearch').addEventListener('input', function () { searchQuery = this.value; renderGrid(); });
  $('assignBtn').addEventListener('click', onAssign);
  // the Assign Shape control is a drag source — drop it on any glyph cell to
  // assign the current Illustrator selection to that letter
  var dragSrc = $('assignWrap') || $('assignBtn');
  dragSrc.setAttribute('draggable', 'true');
  dragSrc.addEventListener('dragstart', function (ev) {
    ev.dataTransfer.setData('text/plain', 'assign'); ev.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('dragging-shape');
    // drag image = a thumbnail of the captured selection, so it feels like
    // carrying the actual shape onto the letter
    if (selSourceContours && selSourceContours.length) {
      var ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.innerHTML = shapeThumbSVG(selSourceContours, '');
      document.body.appendChild(ghost);
      try { ev.dataTransfer.setDragImage(ghost, 28, 28); } catch (e) {}
      setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
    }
  });
  dragSrc.addEventListener('dragend', function () { document.body.classList.remove('dragging-shape'); });
  $('altBtn').addEventListener('click', onAlt);
  $('ligBtn').addEventListener('click', onLig);
  $('ligInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') onLig(); });
  $('ligInput').addEventListener('input', updateLigPrev);
  $('ligInput').addEventListener('focus', updateLigPrev);
  if ($('openTplBtn')) $('openTplBtn').addEventListener('click', onOpenCurrentTemplate);
  if ($('importTplBtn')) $('importTplBtn').addEventListener('click', onImportCurrentTemplate);
  if ($('altLigTplBtn')) $('altLigTplBtn').addEventListener('click', onOpenAltLigTemplate);
  if ($('altLigImportBtn')) $('altLigImportBtn').addEventListener('click', onImportAltLigTemplate);

  var secTabs = document.querySelectorAll('#w-tabsec .w-stab');
  for (var st = 0; st < secTabs.length; st++) (function (t) {
    t.addEventListener('click', function () { setSection(t.getAttribute('data-sec')); });
  })(secTabs[st]);
  $('w-masterSel').addEventListener('change', function () {
    activeMaster = +this.value; lastSig = {}; flatCache = {}; kernCache = {};
    renderGrid(); renderModGrid(); refreshTester(); renderRight(); updateAssign();
  });
  $('optimizeBtn').addEventListener('click', onOptimize);
  if ($('composeAccentsBtn')) $('composeAccentsBtn').addEventListener('click', onComposeAccents);
  Array.prototype.forEach.call(document.querySelectorAll('.w-ctab'), function (b) {
    b.addEventListener('click', function () { setCorrTab(b.getAttribute('data-corr-tab')); });
  });
  if ($('aiOptWidth')) $('aiOptWidth').addEventListener('click', onAIOptWidth);
  if ($('aiSpacingBtn')) $('aiSpacingBtn').addEventListener('click', onAISpacing);
  if ($('visualKernBtn')) $('visualKernBtn').addEventListener('click', onVisualKern);
  if ($('visualKernClear')) $('visualKernClear').addEventListener('click', onVisualKernClear);
  if ($('kernToBearingsBtn')) $('kernToBearingsBtn').addEventListener('click', onKernToBearings);
  if ($('vkAggr')) $('vkAggr').addEventListener('input', function () { if ($('vkAggrVal')) $('vkAggrVal').textContent = this.value + '%'; });
  // === modification pipeline: AI Genişlik (geometric, instant) + AI Optik (model) + Tracking → applyAIOptic
  if ($('aiOptimizeBtn')) $('aiOptimizeBtn').addEventListener('click', onAIOptimize);     // run the optical model
  if ($('moTrack')) {
    $('moTrack').addEventListener('input', function () { applyAIOptic(false); });
    $('moTrack').addEventListener('change', function () { applyAIOptic(true); });
  }
  if ($('aiOptic')) {   // AI Optimizasyon (bearing) — needs the per-font shape model (ensureAIOpt)
    $('aiOptic').addEventListener('input', function () { applyAIOptic(false); });
    $('aiOptic').addEventListener('change', function () { var f = curFont(); ensureAIOpt(f).then(function () { if (curFont() === f) applyAIOptic(true); }); });
  }
  if ($('aiAvg')) {     // AI Optik (kern) — same per-font model
    $('aiAvg').addEventListener('input', function () { applyAIOptic(false); });
    $('aiAvg').addEventListener('change', function () { var f = curFont(); ensureAIOpt(f).then(function () { if (curFont() === f) applyAIOptic(true); }); });
  }
  if ($('aiAnalyze')) $('aiAnalyze').addEventListener('click', function () { aiAnalyze(); if ($('aiModal')) $('aiModal').classList.remove('hidden'); });
  if ($('aiModalX')) $('aiModalX').addEventListener('click', function () { $('aiModal').classList.add('hidden'); });
  if ($('m-space')) {
    $('m-space').addEventListener('input', function () { setSpaceWidth(parseInt(this.value, 10), false); });
    $('m-space').addEventListener('change', function () { setSpaceWidth(parseInt(this.value, 10), true); });
  }
  if ($('accentTplBtn')) $('accentTplBtn').addEventListener('click', onMakeMarksTemplate);
  if ($('accentImportBtn')) $('accentImportBtn').addEventListener('click', onImportMarksTemplate);
  if ($('imgImportBtn')) $('imgImportBtn').addEventListener('click', onImgImportClick);
  if ($('imgFillBtn')) $('imgFillBtn').addEventListener('click', onImgFill);
  if ($('imgCancelBtn')) $('imgCancelBtn').addEventListener('click', closeImgModal);
  if ($('wizBackBtn')) $('wizBackBtn').addEventListener('click', wizBack);
  if ($('wizCancelBtn')) $('wizCancelBtn').addEventListener('click', wizCancel);
  $('gotoBtn').addEventListener('click', function () { if (selectedSlot >= 0) openGlyph(selectedSlot); });
  $('saveProject').addEventListener('click', onSaveProject);
  $('exportGo').addEventListener('click', onExportGo);
  if ($('demoFont')) $('demoFont').addEventListener('change', function () { var f = curFont(); if (f) { f.demoFont = this.checked; autosave(); } });
  $('openFileBtn').addEventListener('click', onOpenFile);
  if ($('resetBtn')) $('resetBtn').addEventListener('click', function () { var m = $('resetModal'); if (m) m.classList.remove('hidden'); });
  if ($('resetCancel')) $('resetCancel').addEventListener('click', function () { var m = $('resetModal'); if (m) m.classList.add('hidden'); });
  if ($('resetNo')) $('resetNo').addEventListener('click', hardReset);
  if ($('resetSave')) $('resetSave').addEventListener('click', saveThenReset);
  if ($('liveTestBtn')) $('liveTestBtn').addEventListener('click', toggleLiveTest);
  if ($('ft-close')) $('ft-close').addEventListener('click', toggleLiveTest);
  if ($('ft-input')) $('ft-input').addEventListener('input', renderFloatTester);
  if ($('ft-size')) $('ft-size').addEventListener('input', renderFloatTester);
  makeDraggable($('floatTester'), $('ft-head'));
  $('bg-b').addEventListener('click', function () { setTesterBg(true); });
  $('bg-w').addEventListener('click', function () { setTesterBg(false); });
  ['t-size', 't-track'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  if ($('t-space')) {
    $('t-space').addEventListener('input', function () { setSpaceWidth(parseInt(this.value, 10), false); });
    $('t-space').addEventListener('change', function () { setSpaceWidth(parseInt(this.value, 10), true); });
  }
  $('t-kern').addEventListener('change', applyTesterCtl);
  if ($('t-liga')) $('t-liga').addEventListener('change', function () { testLiga = this.checked; renderTesterText(); });
  $('t-text').addEventListener('input', function () { testerAlts = {}; renderTesterText(); });  // edits clear per-position overrides
  // click a drawn letter in the tester → select it in the metrics editor so its spacing/kerning can be
  // tuned (the word updates live as you drag the lines). Native preview is plain text, so we map the
  // click POINT → character index → glyph index (caretRangeFromPoint), restoring click-to-edit.
  $('t-text').addEventListener('click', function (ev) {
    var el = $('t-text'); var f = fonts.length ? curFont() : null; if (!f) return;
    var i = testerCharIndex(el, ev.clientX, ev.clientY); if (i < 0) return;
    var gi = testerGlyphAt(f, el.textContent || '', i); if (gi < 0) return;
    selectedSlot = gi; renderRight();
  });
  // right-click a letter → its own alternates (just that occurrence)
  $('t-text').addEventListener('contextmenu', function (ev) {
    var el = $('t-text'); if (!fonts.length) return;
    var i = testerCharIndex(el, ev.clientX, ev.clientY); if (i < 0) return;
    ev.preventDefault(); showTesterAltMenu(ev, i);
  });
  // dismiss the popup menus on any outside click / Escape
  document.addEventListener('mousedown', function (ev) {
    var gm = document.getElementById('glyphMenu'); if (gm && !gm.contains(ev.target)) closeGlyphMenu();
    var am = document.getElementById('testerAltMenu'); if (am && !am.contains(ev.target)) closeTesterAltMenu();
  }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closeGlyphMenu(); closeTesterAltMenu(); } });
  applyEdition();
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
