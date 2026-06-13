'use strict';
/* FontMaker CEP panel controller (Adobe Illustrator).
 * Page 1 (New Font): name/version, master type, multi-select character sets
 * (dropdown), and one or more overlaid construction grids. Page 2 (Workspace):
 * a tab per open font, assign selected Illustrator artwork to glyph slots
 * (scaled to cap height), a live font tester, and OTF export. Geometry is read
 * via ExtendScript; CEP runs Node so require/fs/Buffer are native. */

var cs = new CSInterface();
var ROOT = cs.getSystemPath(SystemPath.EXTENSION);
var ilbridge = require(ROOT + '/js/ilbridge.js');
var glyphset = require(ROOT + '/js/glyphset.js');
var charsets = require(ROOT + '/js/charsets.js');
var dna = require(ROOT + '/js/dna.js');
var optimizer = require(ROOT + '/js/optimizer.js');
var accentCompose = require(ROOT + '/js/accentCompose.js');
var varCompat = require(ROOT + '/js/varCompat.js');
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
function show(v) { $('view-new').classList.toggle('hidden', v !== 'new'); $('view-work').classList.toggle('hidden', v !== 'work'); }
function evalScript(code) { return new Promise(function (r) { cs.evalScript(code, function (x) { r(x); }); }); }

// ============ PAGE 1 — New Font (RuneType Glyphmaker) ============
// Holds settings only; nothing is generated until Start Creating.
var draft = null;
function newDraft() {
  // Pre-select the most common Latin basics. The grid starts as a blank canvas
  // the user designs on (circles / dashed lines / square grid / baselines).
  return {
    masters: [{ name: 'Regular' }],
    lang: { latinUpper: true, latinLower: true, numbers: true },
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
      draft.lang = {};                       // replace — don't stack countries
      c.sets.forEach(function (k) { draft.lang[k] = true; });
      $('countryList').classList.add('hidden');
      setToggle('lang'); renderProfile();
    });
    list.appendChild(it);
  });
}

// The + is disabled until a non-empty, non-duplicate master name is typed
// (so you can't add a second "Regular" or an empty master).
function updateMasterAdd() {
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
  if (draft.toggle === 'preset') return renderGridDesigner(box, draft.gridDesign, function () { updatePillLabels(); renderProfile(); });
  // Language Support — multi-select character sets.
  charsets.ALPHABETS.forEach(function (it) {
    var on = !!draft.lang[it.key];
    var essential = charsets.ESSENTIAL.indexOf(it.key) >= 0;
    var row = document.createElement('div'); row.className = 'rune-item' + (on ? ' on' : '') + (essential ? ' essential' : '');
    var rec = essential ? ' <span class="ri-rec">Recommended</span>' : '';
    var txt = document.createElement('div'); txt.className = 'ri-txt';
    txt.innerHTML = '<div class="ri-t">' + it.label + rec + '</div><div class="ri-d chars">' + charsets.sampleChars(it.key, 10) + '</div>';
    var btn = document.createElement('div'); btn.className = 'ri-btn ' + (on ? 'is-x' : 'is-plus');
    row.appendChild(txt); row.appendChild(btn);
    row.addEventListener('click', function () { draft.lang[it.key] = !draft.lang[it.key]; renderRightList(); updatePillLabels(); renderProfile(); });
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
  var s = '<defs><clipPath id="gdclip"><rect x="' + GD_PX + '" y="' + GD_PY + '" width="' + (GD_W - 2 * GD_PX) + '" height="' + (GD_H - 2 * GD_PY) + '"/></clipPath></defs>';
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
    for (k = 0; 500 + k * c <= 1000 || 500 - k * c >= 0; k++) {
      q = (mul === 2 && k % 2 === 0);
      if (500 + k * c <= 1000) gl(500 + k * c, 800, 500 + k * c, -200, q);
      if (k > 0 && 500 - k * c >= 0) gl(500 - k * c, 800, 500 - k * c, -200, q);
    }
    for (k = 0; 300 + k * c <= 800 || 300 - k * c >= -200; k++) {
      q = (mul === 2 && k % 2 === 0);
      if (300 + k * c <= 800) gl(0, 300 + k * c, 1000, 300 + k * c, q);
      if (k > 0 && 300 - k * c >= -200) gl(0, 300 - k * c, 1000, 300 - k * c, q);
    }
  }
  if (gd.symY) s += '<line x1="' + gdXs(500) + '" y1="' + gdYs(800) + '" x2="' + gdXs(500) + '" y2="' + gdYs(-200) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
  if (gd.symX) s += '<line x1="' + gdXs(0) + '" y1="' + gdYs(300) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(300) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
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
function onImport() { pickPath('Open a RuneType project or font to edit', 'Projects & Fonts:*.runetype;*.otf;*.ttf').then(openFromPath); }

// --- Start Creating: build the font from the draft, then enter the workspace ---
function onStartCreating() {
  var alphabets = Object.keys(draft.lang).filter(function (k) { return draft.lang[k]; });
  if (!alphabets.length) { setToggle('lang'); return; }
  var m0 = draft.masters[0];
  var opts = {
    familyName: ($('nf-family').value.trim() || 'Untitled'),
    masterName: m0.name, masterType: m0.name, alphabets: alphabets,
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
}

// ============ PAGE 2 — Workspace ============
var FM_SCALE_PANEL = 0.25; // must match jsx FM_SCALE
function curFont() { return fonts[activeFont]; }
function curMasterId() { return curFont().masters[activeMaster].id; }
function isFilled(g) { var l = g.layers[curMasterId()]; return !!(l && l.contours && l.contours.length); }
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
function setSection(sec) {
  activeSection = sec;
  $('sec-glyphs').classList.toggle('hidden', sec !== 'glyphs');
  $('sec-mod').classList.toggle('hidden', sec !== 'mod');
  $('sec-test').classList.toggle('hidden', sec !== 'test');
  $('sec-save').classList.toggle('hidden', sec !== 'save');
  // the right pane (designer / metrics) shows everywhere except the full-width
  // save page; testing. keeps the metrics editor on the right
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
  var pad = Math.max(b.w, b.h) * 0.12 + 1;
  var vb = (b.minX - pad) + ' ' + (-(b.maxY) - pad) + ' ' + (b.w + pad * 2) + ' ' + (b.h + pad * 2);
  return '<svg class="thumb" viewBox="' + vb + '" preserveAspectRatio="xMidYMid meet">' +
         '<path d="' + contoursToSVG(contours) + '" fill="#eaeaee"/></svg>';
}

function glyphVisible(g) {
  if (alphaFilters.length && alphaFilters.indexOf(g.alphabet) < 0) return false;
  return glyphset.glyphMatches(g, searchQuery);
}

function renderGrid() {
  var grid = $('grid'); if (!grid) return;
  grid.innerHTML = '';
  var f = curFont();
  f.glyphs.forEach(function (g, i) {
    if (!glyphVisible(g)) return;
    var cell = document.createElement('div');
    cell.className = 'cell' + (isFilled(g) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '');
    var label = glyphLabelHtml(g);
    if (g.char == null) cell.className += ' named';
    if (isFilled(g)) {
      // preview thumbnail + the letter itself stays visible, dark, top-right
      cell.innerHTML = (glyphThumb(g) || '') + '<span class="lab">' + label + '</span>';
    } else {
      cell.innerHTML = label;
    }
    cell.title = g.name + ' — double-click to assign the selection · right-click for options · drop a shape';
    cell.addEventListener('click', function () {
      selectedSlot = i;
      updateAssign(); renderGrid(); renderRight();
    });
    // double-click a cell = assign the CURRENT Illustrator selection straight to
    // it (the fastest, button-free path the user wanted)
    cell.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      selectedSlot = i; updateAssign(); renderGrid();
      onAssign();
    });
    // right-click = options menu (delete shape / delete glyph / open in Illustrator)
    cell.addEventListener('contextmenu', function (ev) { showGlyphMenu(ev, i); });
    // drag-drop: drop the Assign-Shape handle on a letter to assign the current
    // Illustrator selection straight to it
    cell.addEventListener('dragover', function (ev) { ev.preventDefault(); cell.classList.add('drop'); ev.dataTransfer.dropEffect = 'copy'; });
    cell.addEventListener('dragleave', function () { cell.classList.remove('drop'); });
    cell.addEventListener('drop', function (ev) {
      ev.preventDefault(); cell.classList.remove('drop');
      selectedSlot = i; updateAssign(); renderGrid(); onAssign();
    });
    grid.appendChild(cell);
  });
}

// ---- modification. — only the glyphs that have outlines ----
function renderModGrid() {
  var grid = $('modGrid'); if (!grid) return;
  grid.innerHTML = '';
  var f = curFont();
  var shown = 0;
  f.glyphs.forEach(function (g, i) {
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

// ===== AUTOMATION — class-aware fitting: A reaches the cap, a the x-height,
// b/d/k the ascender, g/p/y hangs its tail; W stays wide, I stays thin and
// breathes more. Heights normalize per class, widths stay natural, spacing
// scales with the glyph's width.
var FIT_ASC = 'bdfhklt', FIT_DESC = 'gjpqy';
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
function autoFitGlyph(f, i) {
  var g = f.glyphs[i], mid = curMasterId(), l = g.layers[mid];
  if (!l || !l.contours || !l.contours.length) return false;
  var b = glyphset.contoursBounds(l.contours);
  if (!b || b.h <= 2) return false;
  var M = f.metrics, ch = g.char || '', U = f.unitsPerEm;
  var topAlign = null, target;
  if (/^[A-Z0-9]$/.test(ch)) target = M.capHeight;
  else if (/^[a-z]$/.test(ch)) {
    if (FIT_DESC.indexOf(ch) >= 0) { target = M.xHeight - M.descender; topAlign = M.xHeight; }
    else if (FIT_ASC.indexOf(ch) >= 0) target = M.capHeight;
    else target = M.xHeight;
  } else target = Math.min(b.h, M.capHeight); // punctuation & symbols stay sane
  var sc = target / b.h, w = b.w * sc;
  // spacing aware of width: thin glyphs (I) breathe, wide ones (W) tighten
  var side = Math.round(0.055 * U * (w < 0.22 * U ? 1.5 : w > 0.75 * U ? 0.75 : 1));
  var x0 = -b.minX * sc + side;
  var y0 = topAlign != null ? topAlign - b.maxY * sc : -b.minY * sc;
  l.contours = transformContours(l.contours, sc, x0, y0);
  g.advanceWidth = Math.round(w + 2 * side);
  g.lsbLineX = 0;   // auto-fit re-bases the ink onto the origin
  lastSig[i] = glyphset.layerSignature(g, mid);
  return true;
}
function syncOpenGlyph(g) {
  var l = g.layers[curMasterId()];
  evalScript('fmSetArt(' + JSON.stringify(JSON.stringify({ name: g.name, contours: (l && l.contours) || [], metrics: curFont().metrics })) + ')');
}
function onAutoAll() {
  var f = curFont(), n = 0;
  f.glyphs.forEach(function (g, i) { if (autoFitGlyph(f, i)) { n++; syncOpenGlyph(g); } });
  if (!n) { setStatus('Nothing to fit yet — assign some shapes first.', 'err'); return; }
  flatCache = {}; kernCache = {};
  renderGrid(); renderModGrid(); renderRight(); scheduleTester(); autosave();
  setStatus('Auto-fitted ' + n + ' glyph(s): heights per class, spacing per width.', 'ok');
}
// The embedded optimizer ("mini AI"): class-aware sidebearings/advance for the
// whole font + optical pair kerning, in one pass. Re-spaces consistently.
function onOptimize() {
  var f = curFont();
  if (!f.glyphs.some(isFilled)) { setStatus('Draw and assign some glyphs first.', 'err'); return; }
  bakeAllOrigins(f);   // normalise any blue-line offsets before re-spacing
  var r = optimizer.optimizeAll(f, curMasterId());
  f.glyphs.forEach(function (g) { if (isFilled(g)) syncOpenGlyph(g); });
  flatCache = {}; kernCache = {};
  renderGrid(); renderModGrid(); renderRight(); renderTesterText(); scheduleTester(); autosave();
  setStatus('Optimized: re-spaced ' + r.spaced + ' glyph(s), ' + r.kernPairs + ' optical kern pair(s).', 'ok');
}
function onAutoOne() {
  if (selectedSlot < 0) return;
  var f = curFont();
  if (!autoFitGlyph(f, selectedSlot)) { setStatus('This glyph has no outline yet.', 'err'); return; }
  syncOpenGlyph(f.glyphs[selectedSlot]);
  renderGrid(); renderModGrid(); renderRight(); scheduleTester(); autosave();
  setStatus('Auto-fitted "' + glyphLabel(f.glyphs[selectedSlot]) + '".', 'ok');
}

// ===== metrics & spacing editor (right pane of modification.) — ghost metric
// lines + optic allowances; drag the shape, its transform handles, the blue
// ink-left line (LSB) or the red advance line.
var mxSel = false, mxDrag = null, mxView = defaultView(), mxHand = false;
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
function glyphGridSvg(gd) {
  var s = '';
  if (gd.gridOn) {
    var c = gd.gridCell || 50, mul = gd.gridMul || 1, k, q;
    function gl(x1, y1, x2, y2, major) {
      s += '<line x1="' + gdXs(x1) + '" y1="' + gdYs(y1) + '" x2="' + gdXs(x2) + '" y2="' + gdYs(y2) +
           '" stroke="' + (major ? '#c0271d' : '#cfcfcf') + '" stroke-width="' + (major ? 1.2 : 0.7) + '"/>';
    }
    for (k = 0; 500 + k * c <= 1000 || 500 - k * c >= 0; k++) { q = (mul === 2 && k % 2 === 0); if (500 + k * c <= 1000) gl(500 + k * c, 800, 500 + k * c, -200, q); if (k > 0 && 500 - k * c >= 0) gl(500 - k * c, 800, 500 - k * c, -200, q); }
    for (k = 0; 300 + k * c <= 800 || 300 - k * c >= -200; k++) { q = (mul === 2 && k % 2 === 0); if (300 + k * c <= 800) gl(0, 300 + k * c, 1000, 300 + k * c, q); if (k > 0 && 300 - k * c >= -200) gl(0, 300 - k * c, 1000, 300 - k * c, q); }
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
  // the selected glyph's construction grid, shown faint (25%) behind the metrics
  if (g) s += '<g opacity="0.25">' + glyphGridSvg(glyphGD(g)) + '</g>';
  function HL(y, col, wd, dash) {
    s += '<line x1="' + gdXs(0) + '" y1="' + gdYs(y) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(y) +
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
    // storage origin (x=0) — a faint dashed reference the ink may cross
    var ox0 = gdXs(0);
    s += '<line x1="' + ox0 + '" y1="' + gdYs(800) + '" x2="' + ox0 + '" y2="' + gdYs(-200) + '" stroke="#d7d7d7" stroke-width="1" stroke-dasharray="3 4"/>';
    // blue LSB line — independent + draggable
    var lx = gdXs(lsbX);
    s += '<line x1="' + lx + '" y1="' + gdYs(800) + '" x2="' + lx + '" y2="' + gdYs(-200) + '" stroke="#1473e6" stroke-width="2.2"/>';
    s += '<line data-mx="lsb" x1="' + lx + '" y1="' + gdYs(800) + '" x2="' + lx + '" y2="' + gdYs(-200) + '" stroke="#000" stroke-opacity="0" stroke-width="16" pointer-events="stroke" style="cursor:ew-resize"/>';
    // red advance line at the box right edge (lsbX + adv) — independent + draggable
    var rx = gdXs(lsbX + adv);
    s += '<line x1="' + rx + '" y1="' + gdYs(800) + '" x2="' + rx + '" y2="' + gdYs(-200) + '" stroke="#c0271d" stroke-width="2.2"/>';
    s += '<line data-mx="adv" x1="' + rx + '" y1="' + gdYs(800) + '" x2="' + rx + '" y2="' + gdYs(-200) + '" stroke="#000" stroke-opacity="0" stroke-width="14" pointer-events="stroke" style="cursor:ew-resize"/>';
    s += '<text x="' + (rx - 52) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#c0271d">ADV ' + Math.round(adv) + '</text>';
  }
  s += '</g>';
  svg.innerHTML = s;
}
function mxCommit(g, contours, adv) {
  glyphset.setGlyphContours(curFont(), selectedSlot, curMasterId(), contours, adv != null ? adv : g.advanceWidth);
  lastSig[selectedSlot] = glyphset.layerSignature(g, curMasterId());
  syncOpenGlyph(g);
  renderGrid(); renderModGrid(); scheduleTester(); autosave();
}
function renderMetricsEditor() {
  var box = $('w-designer'); if (!box) return;
  box.innerHTML = '';
  var wrap = document.createElement('div'); wrap.className = 'gd-wrap';
  wrap.innerHTML = '<div class="gd-mid"><div class="gd-stage">' +
    '<button class="mx-hand" type="button" title="Pan &amp; zoom — drag to move, scroll to zoom. Turn off to recenter."><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7-4l-2.5-4a2 2 0 0 1 3.5-2L8 14"/></svg></button>' +
    '<svg class="gd-canvas" viewBox="0 0 ' + GD_W + ' ' + GD_H + '" preserveAspectRatio="xMidYMid meet"></svg>' +
    '</div></div>';
  box.appendChild(wrap);
  var svg = wrap.querySelector('.gd-canvas');
  mxHand = false;                  // fresh editing mode whenever the glyph/section changes
  mxView = defaultView();          // ...and 30%-zoomed-out framing so all is visible
  var handBtn = wrap.querySelector('.mx-hand');
  function setHand(on) {
    mxHand = on; handBtn.classList.toggle('on', on);
    svg.style.cursor = on ? 'grab' : 'default';
    if (!on) { mxView = defaultView(); mxRedraw(svg); }   // turning the hand off recenters
  }
  handBtn.addEventListener('click', function () { setHand(!mxHand); });
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
  // scroll to zoom toward the cursor — only while the hand tool is active
  wrap.addEventListener('wheel', function (ev) {
    if (!mxHand) return;
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
  svg.addEventListener('dblclick', function () { mxView.x = 0; mxView.y = 0; mxView.s = 1; mxRedraw(svg); });
  svg.addEventListener('mousedown', function (ev) {
    ev.preventDefault();
    var pq = pointOf(ev);
    if (mxHand) { mxDrag = { mode: 'pan', px: pq.sx, py: pq.sy, vx: mxView.x, vy: mxView.y }; return; }  // hand tool: drag pans
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

// Auto-compose accented glyphs (é = e + acute …) from base letters + drawn
// marks. Innovation: a multilingual font stops needing every accent drawn by
// hand once the base + the few marks exist.
function onComposeAccents() {
  var f = curFont(), mid = curMasterId();
  var r = accentCompose.composeAll(f, mid);
  r.composed.forEach(function (ch) { var g = f.glyphs.find(function (x) { return x.char === ch; }); if (g) syncOpenGlyph(g); });
  renderGrid(); renderModGrid(); scheduleTester(); autosave();
  if (!r.composed.length) {
    var missing = {}; r.skipped.forEach(function (s) { missing[s.reason.split(':')[0]] = 1; });
    setStatus('Composed 0 — draw the base letters and the mark glyphs (acute, grave, caron…) first.', 'err');
  } else {
    setStatus('Composed ' + r.composed.length + ' accented glyph(s)' + (r.skipped.length ? ' (' + r.skipped.length + ' skipped — base or mark not drawn)' : '') + '.', 'ok');
  }
}

function updateAssign() {
  var g = selGlyph();
  $('assignBtn').disabled = !g;
  $('openInAi').disabled = !g;
  // the Assign chip shows the live Illustrator selection (the shape you'll
  // drop); when nothing is selected it shows the target letter
  var assignWrap = $('assignWrap');
  if (selSourceContours && selSourceContours.length) {
    $('assignChip').innerHTML = shapeThumbSVG(selSourceContours, 'chip-thumb');
    if (assignWrap) assignWrap.classList.add('has-shape');
  } else {
    $('assignChip').innerHTML = g ? glyphLabelHtml(g) : '';
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
  $('autoOne').disabled = !(g && isFilled(g));
}

// ---- modification: alternates & ligatures ----
function onAlt() {
  var f = curFont(), base = -1;
  var ch = $('altChip').value.trim();
  if (ch) {
    f.glyphs.forEach(function (g, i) { if (base < 0 && g.char === ch) base = i; });
    if (base < 0) { setStatus('No glyph "' + ch + '" in this font.', 'err'); return; }
  } else if (selectedSlot >= 0) base = selectedSlot;
  else { setStatus('Type a letter (or select a glyph) to alternate.', 'err'); return; }
  var idx = glyphset.createAlternate(curFont(), base);
  if (idx < 0) { setStatus('Could not create alternate.', 'err'); return; }
  selectedSlot = idx; renderGrid(); updateAssign(); renderRight();
  setStatus('Created alternate "' + curFont().glyphs[idx].name + '" — open it from the grid when ready.', 'ok');
  autosave();
}
function onLig() {
  var str = $('ligInput').value.trim();
  if (str.length !== 2) {
    setStatus('Ligatures join exactly 2 letters — "' + str + '" has ' + str.length + '.', 'err');
    return;
  }
  var idx = glyphset.createLigature(curFont(), str);
  if (idx < 0) { setStatus('Could not create ligature.', 'err'); return; }
  selectedSlot = idx; $('ligInput').value = ''; renderGrid(); updateAssign(); renderRight();
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
function autosave() {
  try {
    var dir = cs.getSystemPath(SystemPath.USER_DATA) + '/RuneType';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    if (fonts.length) fs.writeFileSync(dir + '/autosave.runetype', serializeProject(curFont()));
  } catch (e) { /* best-effort temp save */ }
}
// Open File — pick a font/project/artwork file and open it with the OS default
// app (font files land in the system font viewer for manual install).
function onOpenFile() {
  // open a saved project or an existing font INTO the panel for editing (read by
  // the panel, not handed to the OS) — same loader as page-1 Import
  pickPath('Open a project or font to edit', 'Projects & Fonts:*.runetype;*.otf;*.ttf').then(openFromPath);
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
function onExportGo() {
  commitSig();
  var wantOtf = $('exOtf').checked, wantTtf = $('exTtf').checked, wantVar = $('exVar').checked;
  if (!wantOtf && !wantTtf && !wantVar) { setStatus('Pick at least one format to export.', 'err'); return; }
  var f = curFont();
  evalScript('(function(){var d=Folder.selectDialog("Choose a folder to export into");return d?d.fsName:"";})()').then(function (dir) {
    if (!dir) return;
    try {
      var fam = (f.meta.familyName || 'Font');
      var folder = dir + '/' + fam.replace(/[^\w\- ]+/g, '').trim();
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);   // exports land in a folder
      var n = 0, errs = 0, notes = [];
      // Variable: align compatible masters then export each as a named style
      // (a working family). A single-file .ttf with fvar/gvar is the follow-up.
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
function contoursToPaper(P, contours) {
  var kids = [];
  contours.forEach(function (c) {
    if (!c.closed || c.points.length < 3) return;
    var segs = c.points.map(function (pt) {
      var hIn = pt.handleIn ? new P.Point(pt.handleIn.x - pt.x, pt.handleIn.y - pt.y) : null;
      var hOut = pt.handleOut ? new P.Point(pt.handleOut.x - pt.x, pt.handleOut.y - pt.y) : null;
      return new P.Segment(new P.Point(pt.x, pt.y), hIn, hOut);
    });
    kids.push(new P.Path({ segments: segs, closed: true, insert: false }));
  });
  return kids;
}
function paperToContours(item) {
  var paths = item.children && item.children.length ? item.children : [item];
  var out = [];
  paths.forEach(function (pp) {
    if (!pp.segments || pp.segments.length < 2) return;
    out.push({
      closed: true,
      points: pp.segments.map(function (sg) {
        return {
          x: Math.round(sg.point.x * 100) / 100, y: Math.round(sg.point.y * 100) / 100, type: 'corner',
          handleIn: sg.handleIn.isZero() ? null : { x: sg.point.x + sg.handleIn.x, y: sg.point.y + sg.handleIn.y },
          handleOut: sg.handleOut.isZero() ? null : { x: sg.point.x + sg.handleOut.x, y: sg.point.y + sg.handleOut.y },
        };
      }),
    });
  });
  return out;
}
function uniteContours(contours) {
  var P = getPaper();
  if (!P || !contours || contours.length < 2) return contours;
  try {
    var kids = contoursToPaper(P, contours);
    if (kids.length < 2) return contours;
    var acc = kids[0];
    for (var i = 1; i < kids.length; i++) {
      var nx = kids[i];
      if (acc.intersects(nx) || acc.contains(nx.position) || nx.contains(acc.position)) {
        var before = acc;
        try { acc = acc.unite(nx, { insert: false }); } catch (e) { acc = before; }
        if (!acc) acc = before;
      } else {
        var grp = new P.CompoundPath({ insert: false });
        grp.addChildren(acc.children && acc.children.length ? acc.removeChildren() : [acc]);
        grp.addChild(nx);
        acc = grp;
      }
    }
    var res = paperToContours(acc);
    return res.length ? res : contours;
  } catch (e) { return contours; }
}
// A deep copy of the project with every filled layer's overlaps united.
function cleanedProject(f) {
  var copy = JSON.parse(serializeProject(f));
  copy.glyphs.forEach(function (g) {
    Object.keys(g.layers).forEach(function (mid) {
      var l = g.layers[mid];
      if (l && l.contours && l.contours.length > 1) l.contours = uniteContours(l.contours);
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
    return font.toArrayBuffer();
  } catch (e) { return buffer; }
}
// Build one master's OTF: cleaned outlines + the full name table.
function buildMeta(f, master) {
  return {
    familyName: f.meta.familyName || 'Untitled', styleName: master.type || master.name,
    designer: f.meta.designer || '', version: f.meta.version, masterId: master.id,
    manufacturer: f.meta.manufacturer || '', copyright: f.meta.copyright || '', license: f.meta.license || '',
  };
}
function buildCleanOtf(f, master) {
  var cleaned = cleanedProject(f);
  var built = fontEngine.buildFont(cleaned, 'otf', buildMeta(f, master));
  return applyNames(built.buffer, f, master.type || master.name);
}
// TTF: the dedicated glyf writer already stamps the name table, so no applyNames
// (re-parsing+toArrayBuffer would convert it back to CFF).
function buildCleanTtf(f, master) {
  var cleaned = cleanedProject(f);
  return fontEngine.buildFont(cleaned, 'ttf', buildMeta(f, master)).buffer;
}

function renderWorkspace() {
  renderMasterSelect(); renderFilters(); renderGrid(); updateAssign(); refreshTester();
  setTesterBg(true);   // testing. starts dark by default
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
function glyphFlat(g) {
  var sig = glyphset.layerSignature(g, curMasterId());
  if (!sig) return null;
  var key = g.name + '|' + sig;
  if (!flatCache[key]) {
    var l = g.layers[curMasterId()];
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
function opticalKern(f, gL, gR) {
  var fl = glyphFlat(gL), fr = glyphFlat(gR);
  if (!fl || !fr) return 0;
  var key = gL.name + '>' + gR.name + '|' + glyphset.layerSignature(gL, curMasterId()) + '|' + glyphset.layerSignature(gR, curMasterId());
  if (kernCache[key] != null) return kernCache[key];
  var M = f.metrics, minGap = 1e9;
  for (var k = 0; k <= 22; k++) {
    var y = 5 + (M.capHeight - 10) * k / 22;
    var pl = profileAt(fl, y), pr = profileAt(fr, y);
    if (!pl || !pr) continue;
    var gap = (gL.advanceWidth - pl.max) + pr.min;  // RSB of left + LSB of right at this height
    if (gap < minGap) minGap = gap;
  }
  var v = 0;
  if (minGap < 1e9) {
    // aim for the FONT'S own typical pair gap, so straight pairs stay at 0 and
    // only pairs with extra (or missing) air get values; tiny values are noise
    var target = fontAirTarget(f);
    v = Math.round(Math.max(-0.12 * f.unitsPerEm, Math.min(0.06 * f.unitsPerEm, target - minGap)));
    if (Math.abs(v) < 12) v = 0;
  }
  kernCache[key] = v;
  return v;
}
// the typical RSB+LSB of this font's placed glyphs (median of each side)
function fontAirTarget(f) {
  var ls = [], rs = [];
  f.glyphs.forEach(function (g) {
    var l = g.layers[curMasterId()];
    if (!l || !l.contours || !l.contours.length) return;
    var b = glyphset.contoursBounds(l.contours);
    if (!b) return;
    ls.push(Math.max(0, b.minX));
    rs.push(Math.max(0, g.advanceWidth - b.maxX));
  });
  function med(a) { if (!a.length) return 0; a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }
  var t = med(ls) + med(rs);
  return Math.max(60, Math.min(0.14 * f.unitsPerEm, t || 0.085 * f.unitsPerEm));
}
function pairKern(f, gL, gR, mode) {
  if (!gL || !gR) return 0;
  if (mode === 'optical') return opticalKern(f, gL, gR);
  var t = f.kerning || {};
  return t[gL.name + ',' + gR.name] || 0;
}
// Auto Kern: bake the optical pass into the project's kern table (Metric mode
// then shows the same quality without recomputing).
function onAutoKern() {
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

// ---- live font tester (@font-face from the built OTF) ----
function refreshTester() {
  var f = curFont(); if (!f) return;
  var filled = f.glyphs.filter(isFilled).length;
  var styleEl = $('fm-faces') || (function () { var st = document.createElement('style'); st.id = 'fm-faces'; document.head.appendChild(st); return st; })();
  if (!filled) { styleEl.textContent = ''; $('t-text').style.fontFamily = 'inherit'; applyTesterCtl(); return; }
  try {
    // build from the FILLED glyphs only, so letters you haven't drawn fall back
    // to a standard system face instead of vanishing
    var sub = {}; for (var k in f) sub[k] = f[k];
    var tMid = curMasterId();
    sub.glyphs = f.glyphs.filter(isFilled).map(function (g) {
      var lx = g.lsbLineX || 0; if (!lx) return g;          // fold the LSB offset in (non-mutating)
      var ng = {}; for (var kk in g) ng[kk] = g[kk];
      var nl = {}; for (var mm in g.layers) nl[mm] = g.layers[mm];
      var gl = g.layers[tMid];
      if (gl && gl.contours && gl.contours.length) nl[tMid] = { contours: shiftContoursXY(gl.contours, -lx, 0) };
      ng.layers = nl; ng.lsbLineX = 0;
      return ng;
    });
    var built = fontEngine.buildFont(sub, 'otf', { familyName: 'RTLive', styleName: 'Regular', masterId: curMasterId() });
    var fam;
    if (window.FontFace && document.fonts) {
      fam = 'RTLive_' + (++faceSeq);
      var face = new FontFace(fam, built.buffer);
      document.fonts.add(face);
      if (!window.__rtFaces) window.__rtFaces = [];
      window.__rtFaces.push(face);
      while (window.__rtFaces.length > 2) document.fonts['delete'](window.__rtFaces.shift());
    } else {
      fam = 'RTLive_' + (++faceSeq);
      var b64 = Buffer.from(new Uint8Array(built.buffer)).toString('base64');
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
  t.style.fontKerning = 'none';            // WE drive the pair spacing below
  renderTesterText();
}
// Rebuild the line as spans: each gap = track + the pair's kern (Optical live /
// Metric from the table), scaled to the current size. Caret is preserved.
function testerText() { return $('t-text').textContent; }
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
  var f = fonts.length ? curFont() : null;
  var text = testerText();
  var mode = $('t-kern').value;
  var fsPx = parseFloat($('t-size').value);
  var trackPx = $('t-track').value / 10;
  var off = caretOffset(el);
  var html = '';
  for (var i = 0; i < text.length; i++) {
    var ch = text[i], kernPx = 0, gi = -1, gL = null;
    if (f) {
      for (var gx = 0; gx < f.glyphs.length; gx++) { if (f.glyphs[gx].char === ch) { gL = f.glyphs[gx]; if (isFilled(gL)) gi = gx; break; } }
    }
    if (f && i < text.length - 1) {
      var gR = null;
      for (var rx = 0; rx < f.glyphs.length; rx++) { if (f.glyphs[rx].char === text[i + 1]) { gR = f.glyphs[rx]; break; } }
      var k = pairKern(f, gL, gR, mode);
      kernPx = k / f.unitsPerEm * fsPx;
    }
    // a drawn letter is clickable: it selects that glyph into the metrics editor
    // (right pane) so its spacing/kerning can be tuned and seen live in the word
    var attr = gi >= 0 ? (' data-gi="' + gi + '" class="tletter' + (gi === selectedSlot ? ' tsel' : '') + '"') : '';
    html += '<span' + attr + ' style="margin-right:' + (trackPx + kernPx).toFixed(2) + 'px">' +
            (ch === ' ' ? '&nbsp;' : ch.replace(/&/g, '&amp;').replace(/</g, '&lt;')) + '</span>';
  }
  el.innerHTML = html || '';
  setCaret(el, off);
}
function setTesterBg(darkBg) {
  var p = $('t-paper');
  if (p) { p.classList.toggle('dark', darkBg); p.classList.toggle('light', !darkBg); }
  $('bg-b').classList.toggle('on', darkBg);
  $('bg-w').classList.toggle('on', !darkBg);
}

// ---- live sync: poll the active glyph project, update that glyph live ----
var POLL_MS = 700, polling = false, lastSig = {}, testerTimer = null;
function startPolling() { if (polling) return; polling = true; setInterval(pollActive, POLL_MS); setInterval(pollSelection, 1200); }

// Live-read the Illustrator selection while on the glyphs page so the Assign
// handle shows the shape you're about to drop and the drop is instant.
function pollSelection() {
  if (!fonts.length || $('view-work').classList.contains('hidden') || activeSection !== 'glyphs') return;
  evalScript('fmReadSelection()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { res = null; }
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
  if (!fonts.length || $('view-work').classList.contains('hidden')) return;
  evalScript('fmReadActive()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { return; }
    if (!res || !res.ok || !res.paths || !res.paths.length) return;
    var f = curFont();
    // multiple glyph projects can be open — map the ACTIVE document to its glyph
    var idx = -1;
    if (res.glyph) { f.glyphs.forEach(function (g, k) { if (g.name === res.glyph) idx = k; }); }
    if (idx < 0) idx = openGlyphIndex;
    if (idx < 0 || idx >= f.glyphs.length) return;
    var contours = ilbridge.contoursFromArtboard(res.paths, res.rect, res.scale, f.metrics.descender);
    if (!contours.length) return;
    var adv = (res.rect[2] - res.rect[0]) / res.scale;
    glyphset.setGlyphContours(f, idx, curMasterId(), contours, adv);
    var sig = glyphset.layerSignature(f.glyphs[idx], curMasterId());
    if (sig === lastSig[idx]) return;
    lastSig[idx] = sig;
    renderGrid();
    if (activeSection === 'mod') renderModGrid();
    if (idx === selectedSlot) renderRight();
    setStatus('Live · "' + glyphLabel(f.glyphs[idx]) + '" updated from its project', 'ok');
    scheduleTester(); autosave();
  });
}

// ---- boot ----
function boot() {
  buildPage1(); show('new');
  // page 1 (RuneType)
  $('m-add').addEventListener('click', onAddMaster);
  $('m-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') onAddMaster(); });
  $('m-name').addEventListener('input', updateMasterAdd);
  $('m-ddbtn').addEventListener('click', function () { $('m-list').classList.toggle('hidden'); });
  $('tg-lang').addEventListener('click', function () { setToggle('lang'); });
  $('tg-grid').addEventListener('click', function () { setToggle('preset'); });
  $('countryBtn').addEventListener('click', function () { $('countryList').classList.toggle('hidden'); });
  $('nf-family').addEventListener('input', renderProfile);
  $('nf-import').addEventListener('click', onImport);
  $('nf-create').addEventListener('click', onStartCreating);
  // page 2 (workspace)
  $('w-home').addEventListener('click', function () { draft = newDraft(); buildPage1(); show('new'); });
  $('glyphSearch').addEventListener('input', function () { searchQuery = this.value; renderGrid(); });
  $('openInAi').addEventListener('click', function () { if (selectedSlot >= 0) openGlyph(selectedSlot); });
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

  var secTabs = document.querySelectorAll('#w-tabsec .w-stab');
  for (var st = 0; st < secTabs.length; st++) (function (t) {
    t.addEventListener('click', function () { setSection(t.getAttribute('data-sec')); });
  })(secTabs[st]);
  $('w-masterSel').addEventListener('change', function () {
    activeMaster = +this.value; lastSig = {}; flatCache = {}; kernCache = {};
    renderGrid(); renderModGrid(); refreshTester(); renderRight(); updateAssign();
  });
  $('autoAll').addEventListener('click', onAutoAll);
  $('autoOne').addEventListener('click', onAutoOne);
  $('autoKern').addEventListener('click', onAutoKern);
  $('optimizeBtn').addEventListener('click', onOptimize);
  $('accentBtn').addEventListener('click', onComposeAccents);
  $('gotoBtn').addEventListener('click', function () { if (selectedSlot >= 0) openGlyph(selectedSlot); });
  $('saveProject').addEventListener('click', onSaveProject);
  $('exportGo').addEventListener('click', onExportGo);
  $('openFileBtn').addEventListener('click', onOpenFile);
  $('bg-b').addEventListener('click', function () { setTesterBg(true); });
  $('bg-w').addEventListener('click', function () { setTesterBg(false); });
  ['t-size', 't-track'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  $('t-kern').addEventListener('change', applyTesterCtl);
  $('t-text').addEventListener('input', function () { renderTesterText(); });
  // click a drawn letter in the tester → select it in the metrics editor so its
  // spacing/kerning can be tuned (the word updates live as you drag the lines)
  $('t-text').addEventListener('click', function (ev) {
    var sp = ev.target && ev.target.closest ? ev.target.closest('[data-gi]') : null;
    if (!sp) return;
    selectedSlot = +sp.getAttribute('data-gi');
    renderRight();
    renderTesterText();
  });
  // dismiss the glyph right-click menu on any outside click / Escape / scroll
  document.addEventListener('mousedown', function (ev) {
    var m = document.getElementById('glyphMenu');
    if (m && !m.contains(ev.target)) closeGlyphMenu();
  }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeGlyphMenu(); });
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
