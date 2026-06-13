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
function gdView(gd) { if (!gd._view) gd._view = { x: 0, y: 0, s: 1 }; return gd._view; }
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
  s += '<g transform="translate(' + v.x + ' ' + v.y + ') scale(' + v.s + ')">';
  s += '<rect x="0" y="0" width="' + GD_W + '" height="' + GD_H + '" rx="4" fill="#ffffff"/>';
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
    var mid = wrap.querySelector('.gd-mid');
    var availH = Math.max(120, mid.clientHeight - 2);
    var availW = Math.max(120, mid.clientWidth - 2);
    var h = Math.min(availH, availW * GD_H / GD_W);
    var w = h * GD_W / GD_H;
    svg.style.width = Math.round(w) + 'px';
    svg.style.height = Math.round(h) + 'px';
  }
  window.addEventListener('resize', function () { fit(); });
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
    if (gd._tool !== 'free') { var v = gdView(gd); v.x = 0; v.y = 0; v.s = 1; } // leaving freeform resets the view
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
  window.addEventListener('mousemove', function (ev) {
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
  });
  window.addEventListener('mouseup', function () {
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
  });
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

// --- import an existing .ai project (just opens the file in Illustrator) ---
function onImport() {
  var js = '(function(){var f=File.openDialog("Open a project","Illustrator:*.ai;*.svg");if(!f)return "";app.open(f);return f.fsName;})()';
  evalScript(js).then(function (p) { /* opened in Illustrator */ });
}

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
function setStatus(m, k) { var el = $('status'); if (el) { el.textContent = m; el.className = 'status' + (k ? ' ' + k : ''); } }
function selGlyph() { return selectedSlot >= 0 ? curFont().glyphs[selectedSlot] : null; }
function glyphLabel(g) { return g.char == null ? g.name : (g.char === ' ' ? '␣' : g.char); }

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
  if (sec === 'save') { $('saveModal').classList.remove('hidden'); return; } // save. = export
  activeSection = sec;
  $('sec-glyphs').classList.toggle('hidden', sec !== 'glyphs');
  $('sec-mod').classList.toggle('hidden', sec !== 'mod');
  $('sec-test').classList.toggle('hidden', sec !== 'test');
  $('w-rightPane').classList.remove('hidden');   // the right pane stays on every section
  var tabs = document.querySelectorAll('#w-tabsec .w-stab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-sec') === sec);
  if (sec === 'mod') renderModGrid();
  if (sec === 'test') refreshTester();
  renderRight();
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
  var contours = g.layers[curMasterId()].contours;
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
    var label = glyphLabel(g);
    if (g.char == null) cell.className += ' named';
    if (isFilled(g)) {
      // preview thumbnail + the letter itself stays visible, dark, top-right
      cell.innerHTML = (glyphThumb(g) || '') + '<span class="lab">' + label + '</span>';
    } else {
      cell.textContent = label;
    }
    cell.title = g.name + ' — right-click to open in Illustrator';
    cell.addEventListener('click', function () {
      selectedSlot = i;
      updateAssign(); renderGrid(); renderRight();
    });
    cell.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      selectedSlot = i;
      updateAssign(); renderGrid(); renderRight();
      openGlyph(i); // right-click = open in AI
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
    cell.innerHTML = (glyphThumb(g) || '') + '<span class="lab">' + glyphLabel(g) + '</span>';
    cell.title = g.name;
    cell.addEventListener('click', function () {
      selectedSlot = i;
      updateAssign(); renderModGrid(); renderRight();
    });
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
var mxSel = false, mxDrag = null;
function shiftContoursXY(contours, dx, dy) { return transformContours(contours, 1, dx, dy); }
function mxRedraw(svg) {
  var f = curFont(), g = selGlyph(), M = f.metrics;
  var s = '<rect x="0" y="0" width="' + GD_W + '" height="' + GD_H + '" rx="4" fill="#ffffff"/>';
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
    var adv = (mxDrag && mxDrag.mode === 'adv') ? mxDrag.adv : (g.advanceWidth || 600);
    if (cs2) {
      var shape = (mxDrag && mxDrag.mode === 'scale') ? mxDrag.live : cs2;
      var sdx = (mxDrag && (mxDrag.mode === 'shape' || mxDrag.mode === 'lsb')) ? mxDrag.dx : 0;
      var sdy = (mxDrag && mxDrag.mode === 'shape') ? mxDrag.dy : 0;
      s += '<path d="' + gdShapePath(shape, sdx, sdy) + '" fill="#1d1d1d" fill-rule="nonzero" data-shape="1" style="cursor:move"/>';
      var b = gdShapeBounds(shape, sdx, sdy);
      // the glyph box's LEFT boundary (x=0) — fixed; the ink may cross it for
      // optical protrusion (negative LSB)
      var lx = gdXs(0);
      s += '<line x1="' + lx + '" y1="' + gdYs(800) + '" x2="' + lx + '" y2="' + gdYs(-200) + '" stroke="#1473e6" stroke-width="2.2"/>';
      if (b) {
        if (mxSel) {
          var x1 = gdXs(b.minX), x2 = gdXs(b.maxX), yT = gdYs(b.maxY), yB = gdYs(b.minY);
          var cxm = (x1 + x2) / 2, cym = (yT + yB) / 2;
          s += '<rect x="' + x1 + '" y="' + yT + '" width="' + (x2 - x1) + '" height="' + (yB - yT) + '" fill="none" stroke="#1473e6" stroke-width="1"/>';
          var HD = [['nw', x1, yT, 'nwse-resize'], ['n', cxm, yT, 'ns-resize'], ['ne', x2, yT, 'nesw-resize'], ['e', x2, cym, 'ew-resize'],
                    ['se', x2, yB, 'nwse-resize'], ['s', cxm, yB, 'ns-resize'], ['sw', x1, yB, 'nesw-resize'], ['w', x1, cym, 'ew-resize']];
          for (var hi = 0; hi < HD.length; hi++) {
            s += '<rect data-h="' + HD[hi][0] + '" x="' + (HD[hi][1] - 4) + '" y="' + (HD[hi][2] - 4) + '" width="8" height="8" fill="#fff" stroke="#1473e6" stroke-width="1.2" style="cursor:' + HD[hi][3] + '"/>';
          }
        }
        s += '<text x="' + (gdXs(0) + 4) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#1473e6">LSB ' + Math.round(b.minX) + '</text>';
        s += '<text x="' + (gdXs(adv) - 110) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#8d8d8d">RSB ' + Math.round(adv - b.maxX) + '</text>';
      }
    }
    // advance line (red) — the glyph's total width
    var rx = gdXs(adv);
    s += '<line x1="' + rx + '" y1="' + gdYs(800) + '" x2="' + rx + '" y2="' + gdYs(-200) + '" stroke="#c0271d" stroke-width="2.2"/>';
    s += '<line data-mx="adv" x1="' + rx + '" y1="' + gdYs(800) + '" x2="' + rx + '" y2="' + gdYs(-200) + '" stroke="#000" stroke-opacity="0" stroke-width="14" pointer-events="stroke" style="cursor:ew-resize"/>';
    s += '<text x="' + (rx - 52) + '" y="' + (gdYs(-200) + 16) + '" font-size="10" fill="#c0271d">ADV ' + Math.round(adv) + '</text>';
  }
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
    '<svg class="gd-canvas" viewBox="0 0 ' + GD_W + ' ' + GD_H + '" preserveAspectRatio="xMidYMid meet"></svg>' +
    '</div></div>';
  box.appendChild(wrap);
  var svg = wrap.querySelector('.gd-canvas');
  function fit() {
    var mid = wrap.querySelector('.gd-mid');
    var availH = Math.max(120, mid.clientHeight - 2), availW = Math.max(120, mid.clientWidth - 2);
    var h = Math.min(availH, availW * GD_H / GD_W);
    svg.style.width = Math.round(h * GD_W / GD_H) + 'px';
    svg.style.height = Math.round(h) + 'px';
  }
  function pointOf(ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var pp = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { fx: (pp.x - GD_PX) / GD_SX, fy: 800 - (pp.y - GD_PY) / GD_SY };
  }
  svg.addEventListener('mousedown', function (ev) {
    ev.preventDefault();
    var g = selGlyph(); if (!g) return;
    var l = g.layers[curMasterId()];
    var cs2 = (l && l.contours && l.contours.length) ? l.contours : null;
    var pq = pointOf(ev);
    var hd = ev.target.closest ? ev.target.closest('[data-h]') : null;
    if (hd && cs2) {
      mxDrag = { mode: 'scale', h: hd.getAttribute('data-h'), b: gdShapeBounds(cs2, 0, 0), orig: JSON.parse(JSON.stringify(cs2)), live: cs2 };
      return;
    }
    var mk = ev.target.closest ? ev.target.closest('[data-mx]') : null;
    if (mk) { mxDrag = { mode: mk.getAttribute('data-mx'), sx: pq.fx, dx: 0, adv: g.advanceWidth || 600, adv0: g.advanceWidth || 600 }; return; }
    var sh = ev.target.closest ? ev.target.closest('[data-shape]') : null;
    if (sh && cs2) { mxSel = true; mxDrag = { mode: 'shape', sx: pq.fx, sy: pq.fy, dx: 0, dy: 0 }; mxRedraw(svg); return; }
    mxSel = false; mxRedraw(svg);
  });
  function onMove(ev) {
    if (!mxDrag) return;
    var pq = pointOf(ev);
    if (mxDrag.mode === 'shape' || mxDrag.mode === 'lsb') {
      mxDrag.dx = Math.round(pq.fx - mxDrag.sx);
      if (mxDrag.mode === 'shape') mxDrag.dy = Math.round(pq.fy - mxDrag.sy);
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
      else if (mxDrag.mode === 'lsb' && cs2 && mxDrag.dx) mxCommit(g, shiftContoursXY(cs2, mxDrag.dx, 0)); // spacing shift inside the same advance
      else if (mxDrag.mode === 'adv') mxCommit(g, cs2 || [], mxDrag.adv);
      else if (mxDrag.mode === 'scale' && mxDrag.live) mxCommit(g, mxDrag.live);
    }
    mxDrag = null;
    mxRedraw(svg);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
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

function updateAssign() {
  var g = selGlyph();
  $('assignBtn').disabled = !g;
  $('openInAi').disabled = !g;
  $('assignChip').textContent = g ? glyphLabel(g) : '';   // empty when nothing selected
  $('altChip').placeholder = g ? glyphLabel(g) : '';      // writable; hints the selection
  $('gotoBtn').disabled = !g;
  $('gotoChip').textContent = g ? glyphLabel(g) : '';
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
  openGlyph(idx);
  setStatus('Created alternate "' + curFont().glyphs[idx].name + '" → its own project.', 'ok');
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
  openGlyph(idx);
  setStatus('Created ligature "' + curFont().glyphs[idx].name + '" → its own project.', 'ok');
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
function openSig() {
  var f = curFont(), box = $('sigFields'); box.innerHTML = '';
  if (!f.meta.created) f.meta.created = new Date().toISOString().slice(0, 10);
  SIG_FIELDS.forEach(function (fl) {
    var row = document.createElement('label'); row.className = 'fm-row';
    row.innerHTML = '<span>' + fl.label + '</span>';
    var inp = document.createElement('input');
    inp.type = 'text'; inp.value = f.meta[fl.key] || '';
    inp.setAttribute('data-k', fl.key);
    row.appendChild(inp);
    box.appendChild(row);
  });
  $('sigModal').classList.remove('hidden');
}
function saveSig() {
  var f = curFont();
  $('sigFields').querySelectorAll('input[data-k]').forEach(function (inp) {
    f.meta[inp.getAttribute('data-k')] = inp.value.trim();
  });
  $('sigModal').classList.add('hidden');
  renderMastersBar(); autosave();
  setStatus('Metadata saved into the project.', 'ok');
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
function onSaveProject() {
  var f = curFont();
  var dlg = '(function(){var fl=File.saveDialog("Save RuneType project","RuneType:*.runetype");if(!fl)return "";if(fl.name.indexOf(".")<0)fl=new File(fl.fsName+".runetype");return fl.fsName;})()';
  evalScript(dlg).then(function (path) {
    if (!path) return;
    try {
      fs.writeFileSync(path, serializeProject(f));
      $('saveModal').classList.add('hidden');
      setStatus('Project saved → ' + path, 'ok');
    } catch (e) { setStatus('Save failed: ' + e.message, 'err'); }
  });
}
function onExportGo() {
  if (!$('exOtf').checked) { setStatus('Pick at least one format to export.', 'err'); return; }
  var f = curFont();
  evalScript('(function(){var d=Folder.selectDialog("Choose a folder to export into");return d?d.fsName:"";})()').then(function (dir) {
    if (!dir) return;
    try {
      var fam = (f.meta.familyName || 'Font');
      var folder = dir + '/' + fam.replace(/[^\w\- ]+/g, '').trim();
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);   // exports land in a folder
      var n = 0, errs = 0;
      f.masters.forEach(function (m) {
        try {
          // overlaps united + full name table, like a foundry export
          fs.writeFileSync(folder + '/' + fam.replace(/\s+/g, '') + '-' + m.name.replace(/\s+/g, '') + '.otf',
            Buffer.from(new Uint8Array(buildCleanOtf(f, m))));
          n++;
        } catch (e) { errs++; }
      });
      $('saveModal').classList.add('hidden');
      setStatus('Exported ' + n + ' file(s) → ' + folder + (errs ? ' (' + errs + ' master(s) skipped — no outlines)' : ''), n ? 'ok' : 'err');
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
function buildCleanOtf(f, master) {
  var cleaned = cleanedProject(f);
  var built = fontEngine.buildFont(cleaned, 'otf', {
    familyName: f.meta.familyName || 'Untitled', styleName: master.type || master.name,
    designer: f.meta.designer || '', version: f.meta.version, masterId: master.id,
  });
  return applyNames(built.buffer, f, master.type || master.name);
}

// ===== install straight into Illustrator (the Fontself trick): an OTF written
// to <UserData>/Adobe/Fonts is picked up live, no admin needed.
var installedPaths = {};
function adobeFontsDir() { return cs.getSystemPath(SystemPath.USER_DATA) + '/Adobe/Fonts'; }
function onInstallFont() {
  var f = curFont(), m = f.masters[activeMaster];
  if (!f.glyphs.some(isFilled)) { setStatus('Nothing to install yet — draw some glyphs first.', 'err'); return; }
  try {
    var dir = adobeFontsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    var prev = installedPaths[activeFont];
    if (prev && fs.existsSync(prev)) { try { fs.unlinkSync(prev); } catch (e0) {} }
    var fam = slugifyPS(f.meta.familyName || 'Untitled');
    var path = dir + '/' + fam + '-' + slugifyPS(m.name) + '.otf';
    fs.writeFileSync(path, Buffer.from(new Uint8Array(buildCleanOtf(f, m))));
    installedPaths[activeFont] = path;
    $('saveModal').classList.add('hidden');
    setStatus('Installed → usable in Illustrator\'s font list right now (' + path + ')', 'ok');
  } catch (e) { setStatus('Install failed: ' + (e && e.message ? e.message : e), 'err'); }
}
function onUninstallFont() {
  var prev = installedPaths[activeFont];
  if (!prev) { setStatus('Nothing installed from this session.', 'err'); return; }
  try {
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
    delete installedPaths[activeFont];
    setStatus('Uninstalled from Illustrator.', 'ok');
  } catch (e) { setStatus('Uninstall failed: ' + e.message, 'err'); }
}

// ===== auto metrics — percentile of the drawn glyphs' extents (outlier-proof)
function percentileOf(arr, q) {
  if (!arr.length) return 0;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}
function onAutoMetrics() {
  var f = curFont();
  var tops = [], bots = [];
  f.glyphs.forEach(function (g) {
    if (!isFilled(g)) return;
    var b = glyphset.contoursBounds(g.layers[curMasterId()].contours);
    if (b) { tops.push(b.maxY); bots.push(Math.abs(Math.min(0, b.minY))); }
  });
  if (!tops.length) { setStatus('Draw some glyphs first — metrics are measured from them.', 'err'); return; }
  var asc = Math.round(Math.max(percentileOf(tops, 0.9), 0.5 * f.unitsPerEm));
  var desc = -Math.round(Math.max(percentileOf(bots, 0.9), 0.2 * f.unitsPerEm));
  f.metrics.ascender = asc; f.metrics.descender = desc;
  refreshTester(); renderRight(); autosave();
  setStatus('Metrics fitted to your glyphs: ascender ' + asc + ', descender ' + desc + '.', 'ok');
}

function renderWorkspace() {
  renderMasterSelect(); renderFilters(); renderGrid(); updateAssign(); refreshTester();
  setSection('glyphs');
  setStatus('Editing ' + curFont().meta.familyName + ' · ' + curFont().glyphs.length + ' slots');
}

// ---- assign selection -> glyph ----
function onAssign() {
  if (selectedSlot < 0) return;
  setStatus('Reading selection…');
  evalScript('fmReadSelection()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { setStatus('Bridge returned bad data.', 'err'); return; }
    if (!res || !res.ok) { setStatus((res && res.error) || 'Could not read selection.', 'err'); return; }
    var contours = ilbridge.contoursFromSelection(res.paths);
    if (!contours.length) { setStatus('Selection has no usable outlines.', 'err'); return; }
    if (!glyphset.assignContoursToGlyph(curFont(), contours, selectedSlot, curMasterId())) { setStatus('Could not place selection.', 'err'); return; }
    var g = curFont().glyphs[selectedSlot];
    setStatus('Assigned ' + contours.length + ' contour(s) → "' + glyphLabel(g) + '".', 'ok');
    renderGrid(); refreshTester(); renderRight(); autosave();
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
  if (!flatCache[key]) flatCache[key] = flattenContours(g.layers[curMasterId()].contours);
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
    if (!isFilled(g)) return;
    var b = glyphset.contoursBounds(g.layers[curMasterId()].contours);
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
    var built = fontEngine.buildFont(f, 'otf', { familyName: 'RTLive', styleName: 'Regular', masterId: curMasterId() });
    if (window.FontFace && document.fonts) {
      var face = new FontFace('RTLive_' + (++faceSeq), built.buffer);
      document.fonts.add(face);
      if (!window.__rtFaces) window.__rtFaces = [];
      window.__rtFaces.push(face);
      while (window.__rtFaces.length > 2) document.fonts['delete'](window.__rtFaces.shift());
      $('t-text').style.fontFamily = '"RTLive_' + faceSeq + '"';
    } else {
      var b64 = Buffer.from(new Uint8Array(built.buffer)).toString('base64');
      styleEl.textContent = '@font-face{font-family:"RTLive_' + (++faceSeq) + '";src:url(data:font/otf;base64,' + b64 + ') format("opentype");}';
      $('t-text').style.fontFamily = '"RTLive_' + faceSeq + '"';
    }
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
    var ch = text[i], kernPx = 0;
    if (f && i < text.length - 1) {
      var gL = null, gR = null;
      f.glyphs.forEach(function (g) { if (g.char === ch) gL = g; if (g.char === text[i + 1]) gR = g; });
      var k = pairKern(f, gL, gR, mode);
      kernPx = k / f.unitsPerEm * fsPx;
    }
    html += '<span style="margin-right:' + (trackPx + kernPx).toFixed(2) + 'px">' +
            (ch === ' ' ? '&nbsp;' : ch.replace(/&/g, '&amp;').replace(/</g, '&lt;')) + '</span>';
  }
  el.innerHTML = html || '';
  setCaret(el, off);
}
function setTesterBg(darkBg) {
  $('sec-test').classList.toggle('dark', darkBg);
  $('sec-test').classList.toggle('light', !darkBg);
  $('bg-b').classList.toggle('on', darkBg);
  $('bg-w').classList.toggle('on', !darkBg);
}

// ---- live sync: poll the active glyph project, update that glyph live ----
var POLL_MS = 700, polling = false, lastSig = {}, testerTimer = null;
function startPolling() { if (polling) return; polling = true; setInterval(pollActive, POLL_MS); }
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
  $('altBtn').addEventListener('click', onAlt);
  $('ligBtn').addEventListener('click', onLig);
  $('ligInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') onLig(); });
  $('sigBtn').addEventListener('click', openSig);
  $('sigSave').addEventListener('click', saveSig);
  $('sigCancel').addEventListener('click', function () { $('sigModal').classList.add('hidden'); });
  $('saveCancel').addEventListener('click', function () { $('saveModal').classList.add('hidden'); });
  var secTabs = document.querySelectorAll('#w-tabsec .w-stab');
  for (var st = 0; st < secTabs.length; st++) (function (t) {
    t.addEventListener('click', function () { setSection(t.getAttribute('data-sec')); });
  })(secTabs[st]);
  $('w-masterSel').addEventListener('change', function () {
    activeMaster = +this.value; lastSig = {};
    renderGrid(); renderModGrid(); refreshTester(); renderRight(); updateAssign();
  });
  $('autoAll').addEventListener('click', onAutoAll);
  $('autoOne').addEventListener('click', onAutoOne);
  $('autoKern').addEventListener('click', onAutoKern);
  $('gotoBtn').addEventListener('click', function () { if (selectedSlot >= 0) openGlyph(selectedSlot); });
  $('saveProject').addEventListener('click', onSaveProject);
  $('exportGo').addEventListener('click', onExportGo);
  $('installBtn').addEventListener('click', onInstallFont);
  $('uninstallBtn').addEventListener('click', onUninstallFont);
  $('autoMetrics').addEventListener('click', onAutoMetrics);
  $('bg-b').addEventListener('click', function () { setTesterBg(true); });
  $('bg-w').addEventListener('click', function () { setTesterBg(false); });
  ['t-size', 't-track'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  $('t-kern').addEventListener('change', applyTesterCtl);
  $('t-text').addEventListener('input', function () { renderTesterText(); });
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
