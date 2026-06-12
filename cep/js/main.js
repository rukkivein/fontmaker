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

var fonts = [];          // open fonts (each is a single-master project)
var activeFont = -1;
var selectedSlot = -1;
var openGlyphIndex = -1; // glyph currently open for editing in Illustrator
var searchQuery = '';
var alphaFilter = null;  // alphabet key to filter the grid, or null = all
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
    gridDesign: { items: [], gridOn: false, gridCell: 50, symX: false, symY: false, sel: -1, selGrid: false, undo: [], redo: [] },
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
  if (draft.toggle === 'preset') return renderGridDesigner(box);
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
var GD_W = 595, GD_H = 842, GD_PX = 36, GD_PY = 36; // mini A4 + canvas padding
var GD_SX = (GD_W - 2 * GD_PX) / 1000, GD_SY = (GD_H - 2 * GD_PY) / 1000;
function gdXs(fx) { return GD_PX + fx * GD_SX; }
function gdYs(fy) { return GD_PY + (800 - fy) * GD_SY; }
function gdSnap(gd) { return JSON.stringify({ items: gd.items, gridOn: gd.gridOn, gridCell: gd.gridCell, symX: gd.symX, symY: gd.symY }); }
function gdPush(gd) { gd.undo.push(gdSnap(gd)); if (gd.undo.length > 60) gd.undo.shift(); gd.redo.length = 0; }
function gdRestore(gd, s) { var o = JSON.parse(s); gd.items = o.items; gd.gridOn = o.gridOn; gd.gridCell = o.gridCell; gd.symX = o.symX; gd.symY = o.symY; gd.sel = -1; gd.selGrid = false; }
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
function gdRedraw(svg, gd) {
  var s = '<defs><clipPath id="gdclip"><rect x="' + GD_PX + '" y="' + GD_PY + '" width="' + (GD_W - 2 * GD_PX) + '" height="' + (GD_H - 2 * GD_PY) + '"/></clipPath></defs>';
  s += '<rect x="0" y="0" width="' + GD_W + '" height="' + GD_H + '" rx="4" fill="#ffffff"/>';
  s += '<g clip-path="url(#gdclip)">';
  if (gd.gridOn) {
    // the square grid is always centre-aligned: lines run outward from x=500 / y=300
    var c = gd.gridCell || 50, gc = gd.selGrid ? '#9cc3f0' : '#e2e2e2';
    var gx, gy;
    for (gx = 500; gx <= 1000; gx += c) s += '<line x1="' + gdXs(gx) + '" y1="' + gdYs(800) + '" x2="' + gdXs(gx) + '" y2="' + gdYs(-200) + '" stroke="' + gc + '" stroke-width="0.7"/>';
    for (gx = 500 - c; gx >= 0; gx -= c) s += '<line x1="' + gdXs(gx) + '" y1="' + gdYs(800) + '" x2="' + gdXs(gx) + '" y2="' + gdYs(-200) + '" stroke="' + gc + '" stroke-width="0.7"/>';
    for (gy = 300; gy <= 800; gy += c) s += '<line x1="' + gdXs(0) + '" y1="' + gdYs(gy) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(gy) + '" stroke="' + gc + '" stroke-width="0.7"/>';
    for (gy = 300 - c; gy >= -200; gy -= c) s += '<line x1="' + gdXs(0) + '" y1="' + gdYs(gy) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(gy) + '" stroke="' + gc + '" stroke-width="0.7"/>';
  }
  if (gd.symY) s += '<line x1="' + gdXs(500) + '" y1="' + gdYs(800) + '" x2="' + gdXs(500) + '" y2="' + gdYs(-200) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
  if (gd.symX) s += '<line x1="' + gdXs(0) + '" y1="' + gdYs(300) + '" x2="' + gdXs(1000) + '" y2="' + gdYs(300) + '" stroke="#1473e6" stroke-width="0.9" stroke-dasharray="7 5" opacity="0.55"/>';
  // ghosts (mirrors) under the originals; thick visible strokes; fat invisible hit layer on top
  gd.items.forEach(function (it) {
    gdVariants(it).forEach(function (m) { s += gdItemSvg(m, '#b5b5b5', 1.8, it.type === 'dline', null, false); });
  });
  gd.items.forEach(function (it, i) {
    var on = gdSelected(gd, i);
    s += gdItemSvg(it, on ? '#1473e6' : '#333333', on ? 3 : 2.4, it.type === 'dline', i, false);
  });
  gd.items.forEach(function (it, i) { s += gdItemSvg(it, null, 0, false, i, true); });
  if (gd._marq) {
    var m = gd._marq, x1 = Math.min(m.x1, m.x2), x2 = Math.max(m.x1, m.x2), y1 = Math.min(m.y1, m.y2), y2 = Math.max(m.y1, m.y2);
    s += '<rect x="' + gdXs(x1) + '" y="' + gdYs(y2) + '" width="' + ((x2 - x1) * GD_SX) + '" height="' + ((y2 - y1) * GD_SY) + '" fill="#1473e6" fill-opacity="0.08" stroke="#1473e6" stroke-width="1" stroke-dasharray="4 3"/>';
  }
  s += '</g>';
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
function renderGridDesigner(box) {
  var gd = draft.gridDesign;
  if (!gd.selSet) gd.selSet = [];
  var wrap = document.createElement('div'); wrap.className = 'gd-wrap'; wrap.tabIndex = 0;
  wrap.innerHTML =
    '<div class="gd-top">' +
      '<div class="gd-toolcol">' +
        '<div class="gd-tools">' +
          '<button class="gd-tool" data-t="circle" title="Add circle"><span class="gd-ic-circle"></span></button>' +
          '<button class="gd-tool" data-t="dline" title="Add dashed line (0-360)"><span class="gd-ic-dline"></span></button>' +
          '<button class="gd-tool" data-t="grid" title="Square grid on/off"><span class="gd-ic-grid"></span></button>' +
        '</div>' +
        '<input class="gd-slider" type="range" min="0" max="100" value="50" disabled title="Size / angle of the selection" />' +
      '</div>' +
      '<div class="gd-side">' +
        '<button class="gd-sym" data-a="symY" title="Vertical symmetry (applies to newly added items)"></button>' +
        '<button class="gd-sym" data-a="symX" title="Horizontal symmetry (applies to newly added items)"></button>' +
        '<button class="gd-hist" data-a="undo" title="Undo"></button>' +
        '<button class="gd-hist" data-a="redo" title="Redo"></button>' +
      '</div>' +
    '</div>' +
    '<div class="gd-mid">' +
      '<svg class="gd-canvas" viewBox="0 0 ' + GD_W + ' ' + GD_H + '" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<div class="gd-vbar" title="Drag onto the canvas to drop a vertical guide"></div>' +
    '</div>' +
    '<div class="gd-hbar" title="Drag onto the canvas to drop a baseline"></div>';
  box.appendChild(wrap);

  var svg = wrap.querySelector('.gd-canvas');
  var slider = wrap.querySelector('.gd-slider');
  function sync() {
    gdRedraw(svg, gd);
    var sv = gdSliderFor(gd);
    slider.disabled = (sv == null);
    if (sv != null) slider.value = Math.max(0, Math.min(100, sv));
    wrap.querySelector('[data-t=grid]').classList.toggle('active', gd.gridOn);
    wrap.querySelector('[data-a=symY]').classList.toggle('on', gd.symY);
    wrap.querySelector('[data-a=symX]').classList.toggle('on', gd.symX);
    updatePillLabels(); renderProfile();
  }
  function addItem(it) {
    // stamp the active symmetry onto the item — its mirrors live with IT
    it.symX = gd.symX; it.symY = gd.symY;
    gdPush(gd); gd.items.push(it); gd.selSet = [gd.items.length - 1]; gd.selGrid = false; sync();
  }
  wrap.querySelector('[data-t=circle]').addEventListener('click', function () { addItem({ type: 'circle', cx: 500, cy: 300, r: 200 }); });
  wrap.querySelector('[data-t=dline]').addEventListener('click', function () { addItem({ type: 'dline', cx: 500, cy: 300, angle: 45 }); });
  wrap.querySelector('[data-t=grid]').addEventListener('click', function () { gdPush(gd); gd.gridOn = !gd.gridOn; gd.selGrid = gd.gridOn; gd.selSet = []; sync(); });
  wrap.querySelector('[data-a=symY]').addEventListener('click', function () { gd.symY = !gd.symY; sync(); });
  wrap.querySelector('[data-a=symX]').addEventListener('click', function () { gd.symX = !gd.symX; sync(); });
  wrap.querySelector('[data-a=undo]').addEventListener('click', function () { if (!gd.undo.length) return; gd.redo.push(gdSnap(gd)); gdRestore(gd, gd.undo.pop()); gd.selSet = []; sync(); });
  wrap.querySelector('[data-a=redo]').addEventListener('click', function () { if (!gd.redo.length) return; gd.undo.push(gdSnap(gd)); gdRestore(gd, gd.redo.pop()); gd.selSet = []; sync(); });
  slider.addEventListener('input', function () { gdApplySlider(gd, +slider.value); gdRedraw(svg, gd); });
  slider.addEventListener('change', function () { gdPush(gd); updatePillLabels(); renderProfile(); });

  // ---- pointer interactions: move / marquee / ruler guides (Photoshop-like) ----
  function svgPoint(ev) {
    var pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    var p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return { fx: (p.x - GD_PX) / GD_SX, fy: 800 - (p.y - GD_PY) / GD_SY };
  }
  var drag = null;
  svg.addEventListener('mousedown', function (ev) {
    ev.preventDefault(); wrap.focus();
    var t = ev.target.closest ? ev.target.closest('[data-i]') : null;
    var p = svgPoint(ev);
    if (t) {
      var i = +t.getAttribute('data-i');
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
  // ruler bars: press & drag onto the canvas — the guide follows the pointer
  function startGuide(ev, type) {
    ev.preventDefault(); wrap.focus();
    var it = type === 'vline' ? { type: 'vline', x: 1000 } : { type: 'hline', y: -200 };
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
  sync();
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
  if (gd.gridOn) parts.push('grid');
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
  opts.gridDesign = { items: gd.items, gridOn: gd.gridOn, gridCell: gd.gridCell, symX: gd.symX, symY: gd.symY };
  var project = glyphset.createProject(opts);
  for (var i = 1; i < draft.masters.length; i++) glyphset.addMaster(project, draft.masters[i].name, draft.masters[i].name);
  fonts.push(project); activeFont = fonts.length - 1; selectedSlot = -1; lastSig = {};
  openGlyphIndex = -1; searchQuery = ''; alphaFilter = null;
  draft = null;
  // No document is created here — the plugin just shows the glyphs. A per-glyph
  // artboard opens only when you click a letter (openGlyph).
  show('work'); renderWorkspace();
}

// ============ PAGE 2 — Workspace ============
function curFont() { return fonts[activeFont]; }
function curMasterId() { return curFont().masters[0].id; }
function isFilled(g) { var l = g.layers[curMasterId()]; return !!(l && l.contours && l.contours.length); }
function setStatus(m, k) { $('status').textContent = m; $('status').className = 'status' + (k ? ' ' + k : ''); }

function renderTabs() {
  var tabs = $('w-tabs'); tabs.innerHTML = '';
  fonts.forEach(function (f, i) {
    var t = document.createElement('div');
    t.className = 'tab' + (i === activeFont ? ' active' : '');
    t.textContent = f.meta.familyName + ' · ' + f.masters[0].type;
    t.addEventListener('click', function () { activeFont = i; selectedSlot = -1; lastSig = {}; renderWorkspace(); });
    tabs.appendChild(t);
  });
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
  if (alphaFilter && g.alphabet !== alphaFilter) return false;
  return glyphset.glyphMatches(g, searchQuery);
}

function renderGrid() {
  var grid = $('grid'); grid.innerHTML = '';
  var f = curFont();
  var shown = 0;
  f.glyphs.forEach(function (g, i) {
    if (!glyphVisible(g)) return;
    shown++;
    var cell = document.createElement('div');
    cell.className = 'cell' + (isFilled(g) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '') + (i === openGlyphIndex ? ' open' : '');
    var label = g.char != null ? (g.char === ' ' ? '␣' : g.char) : g.name;
    if (g.char == null) cell.className += ' named';
    if (isFilled(g)) {
      var th = glyphThumb(g);
      cell.innerHTML = (th || '') + '<span class="lab">' + label + '</span>';
    } else {
      cell.textContent = label;
    }
    cell.title = g.name + ' — double-click to edit';
    cell.addEventListener('click', function () { selectedSlot = i; updateAssign(); renderGrid(); });
    cell.addEventListener('dblclick', function () { selectedSlot = i; updateAssign(); openGlyph(i); renderGrid(); });
    grid.appendChild(cell);
  });
  var filled = f.glyphs.filter(isFilled).length;
  $('filledCount').textContent = filled + ' / ' + f.glyphs.length + (shown !== f.glyphs.length ? ' · ' + shown + ' shown' : '');
  $('exportBtn').disabled = filled === 0;
}

// Alphabet filter chips (built from the alphabets present in the font).
function renderFilters() {
  var box = $('glyphFilters'); if (!box) return;
  box.innerHTML = '';
  var f = curFont();
  var keys = [];
  f.glyphs.forEach(function (g) { if (keys.indexOf(g.alphabet) < 0) keys.push(g.alphabet); });
  function chip(label, key) {
    var c = document.createElement('div');
    c.className = 'fchip' + ((alphaFilter === key) ? ' active' : '');
    c.textContent = label;
    c.addEventListener('click', function () { alphaFilter = key; renderFilters(); renderGrid(); });
    box.appendChild(c);
  }
  chip('All', null);
  keys.forEach(function (k) {
    var a = charsets.ALPHABET_BY_KEY[k];
    chip(a ? a.label : k, k);
  });
}

// Open a glyph for editing in Illustrator (its own artboard, grids + ghost +
// any existing artwork). Edits stream back via the live-sync poll (no file).
function openGlyph(i) {
  if (i === openGlyphIndex) return; // already open
  openGlyphIndex = i;
  var f = curFont(), g = f.glyphs[i];
  var layer = g.layers[curMasterId()];
  var cfg = {
    metrics: f.metrics, unitsPerEm: f.unitsPerEm, advanceWidth: g.advanceWidth,
    name: g.name, char: g.char, ghost: g.ghost || g.char || '',
    grids: f.grids.map(function (x) { return { kind: x.kind, cell: x.cell, penAngle: x.penAngle, overshoot: x.overshoot }; }),
    contours: (layer && layer.contours) ? layer.contours : [],
  };
  setStatus('Opening "' + (g.char || g.name) + '" for editing…');
  evalScript('fmOpenGlyph(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Editing "' + (g.char || g.name) + '" · draws sync back automatically', 'ok');
    else setStatus('Could not open glyph: ' + ((r && r.error) || '?'), 'err');
  });
}

function updateAssign() {
  var ok = selectedSlot >= 0; $('assignBtn').disabled = !ok; $('altBtn').disabled = !ok;
  $('assignTarget').textContent = ok ? (function () { var g = curFont().glyphs[selectedSlot]; return g.char == null ? g.name : (g.char === ' ' ? 'space' : g.char); })() : '—';
}

// ---- special glyphs: alternates & ligatures ----
function appendArtboardFor(idx) {
  var f = curFont(), g = f.glyphs[idx];
  var cfg = {
    metrics: f.metrics, unitsPerEm: f.unitsPerEm,
    grids: f.grids.map(function (x) { return { kind: x.kind, cell: x.cell, penAngle: x.penAngle, overshoot: x.overshoot }; }),
    name: g.name, ghost: g.ghost || '',
  };
  evalScript('fmAppendArtboard(' + JSON.stringify(JSON.stringify(cfg)) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (!(r && r.ok)) setStatus('Glyph added (artboard not created: ' + ((r && r.error) || '?') + ')', 'err');
  });
}
function onAlt() {
  if (selectedSlot < 0) return;
  var idx = glyphset.createAlternate(curFont(), selectedSlot);
  if (idx < 0) { setStatus('Could not create alternate.', 'err'); return; }
  appendArtboardFor(idx);
  selectedSlot = idx; renderGrid(); updateAssign();
  setStatus('Created alternate "' + curFont().glyphs[idx].name + '" → its own artboard.', 'ok');
}
function onLig() {
  var str = $('ligInput').value.trim();
  if (str.length < 2) { setStatus('Type ≥2 characters to ligate (e.g. ft).', 'err'); return; }
  var idx = glyphset.createLigature(curFont(), str);
  if (idx < 0) { setStatus('Could not create ligature.', 'err'); return; }
  appendArtboardFor(idx);
  selectedSlot = idx; $('ligInput').value = ''; renderGrid(); updateAssign();
  setStatus('Created ligature "' + curFont().glyphs[idx].name + '" → its own artboard.', 'ok');
}

function renderWorkspace() {
  renderTabs(); renderFilters(); renderGrid(); updateAssign(); refreshTester();
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
    var pts = contours.reduce(function (n, c) { return n + c.points.length; }, 0);
    setStatus('Assigned ' + contours.length + ' contour(s), ' + pts + ' pts → "' + g.char + '".', 'ok');
    renderGrid(); refreshTester();
  });
}

// ---- live font tester (@font-face from the built OTF) ----
function refreshTester() {
  var f = curFont(); if (!f) return;
  var filled = f.glyphs.filter(isFilled).length;
  var styleEl = $('fm-faces') || (function () { var s = document.createElement('style'); s.id = 'fm-faces'; document.head.appendChild(s); return s; })();
  if (!filled) { styleEl.textContent = ''; $('t-text').style.fontFamily = 'inherit'; applyTesterCtl(); return; }
  try {
    var fam = 'FMTest_' + (++faceSeq);
    var built = fontEngine.buildFont(f, 'otf', { familyName: fam, styleName: 'Regular', masterId: curMasterId() });
    var b64 = Buffer.from(new Uint8Array(built.buffer)).toString('base64');
    styleEl.textContent = '@font-face{font-family:"' + fam + '";src:url(data:font/otf;base64,' + b64 + ') format("opentype");}';
    $('t-text').style.fontFamily = '"' + fam + '"';
  } catch (e) { /* tester is best-effort */ }
  applyTesterCtl();
}
function applyTesterCtl() {
  var t = $('t-text');
  t.style.fontSize = $('t-size').value + 'px';
  t.style.letterSpacing = ($('t-track').value / 10) + 'px';
  t.style.fontKerning = $('t-kern').value;
  t.style.fontFeatureSettings = $('t-kern').value === 'none' ? '"kern" 0' : '"kern" 1';
}

// ---- live sync: poll the active artboard, update that glyph live ----
var POLL_MS = 700, polling = false, lastSig = {}, testerTimer = null;
function startPolling() { if (polling) return; polling = true; setInterval(pollActive, POLL_MS); }
function scheduleTester() { if (testerTimer) clearTimeout(testerTimer); testerTimer = setTimeout(refreshTester, 1200); }

function pollActive() {
  if (!fonts.length || $('view-work').classList.contains('hidden')) return;
  evalScript('fmReadActive()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { return; }
    if (!res || !res.ok || !res.paths || !res.paths.length) return;
    var f = curFont(), idx = openGlyphIndex; // the glyph currently being edited
    if (idx < 0 || idx >= f.glyphs.length) return;
    var contours = ilbridge.contoursFromArtboard(res.paths, res.rect, res.scale, f.metrics.descender);
    if (!contours.length) return;
    var adv = (res.rect[2] - res.rect[0]) / res.scale;
    glyphset.setGlyphContours(f, idx, curMasterId(), contours, adv);
    var sig = glyphset.layerSignature(f.glyphs[idx], curMasterId());
    if (sig === lastSig[idx]) return;
    lastSig[idx] = sig;
    renderGrid();
    setStatus('Live · "' + f.glyphs[idx].char + '" updated from artboard', 'ok');
    scheduleTester();
  });
}

// ---- export OTF ----
function onExport() {
  var f = curFont(), m = f.masters[0];
  var meta = { familyName: f.meta.familyName, styleName: m.type || 'Regular', designer: $('designer').value.trim(), version: f.meta.version, masterId: m.id };
  var fileName = (f.meta.familyName.replace(/\s+/g, '') || 'Font') + '-' + (m.type || 'Regular') + '.otf';
  setStatus('Choose where to save…');
  var dlg = '(function(){var f=File.saveDialog("Save font","OTF:*.otf");if(!f)return "";if(f.name.indexOf(".")<0)f=new File(f.fsName+".otf");return f.fsName;})()';
  evalScript(dlg).then(function (p) {
    if (!p) { setStatus('Export cancelled.'); return; }
    try {
      setStatus('Building font…');
      var built = fontEngine.buildFont(f, 'otf', meta);
      fs.writeFileSync(p, Buffer.from(new Uint8Array(built.buffer)));
      setStatus('Exported ' + built.glyphCount + ' glyphs → ' + p, 'ok');
    } catch (e) { setStatus('Export failed: ' + (e && e.message ? e.message : e), 'err'); }
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
  $('w-newfont').addEventListener('click', function () { draft = newDraft(); buildPage1(); show('new'); });
  // page 2 (workspace)
  $('glyphSearch').addEventListener('input', function () { searchQuery = this.value; renderGrid(); });
  $('assignBtn').addEventListener('click', onAssign);
  $('altBtn').addEventListener('click', onAlt);
  $('ligBtn').addEventListener('click', onLig);
  $('exportBtn').addEventListener('click', onExport);
  ['t-size', 't-track', 't-kern'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
