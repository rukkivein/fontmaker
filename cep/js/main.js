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
var fontEngine = require(ROOT + '/js/lib/fontEngine.js');
var fs = require('fs');

var fonts = [];          // open fonts (each is a single-master project)
var activeFont = -1;
var selectedSlot = -1;
var faceSeq = 0;         // unique @font-face family per rebuild

function $(id) { return document.getElementById(id); }
function show(v) { $('view-new').classList.toggle('hidden', v !== 'new'); $('view-work').classList.toggle('hidden', v !== 'work'); }
function evalScript(code) { return new Promise(function (r) { cs.evalScript(code, function (x) { r(x); }); }); }

// ============ PAGE 1 — New Font (RuneType Glyphmaker) ============
// Holds settings only; nothing is generated until Start Creating.
var draft = null;
function newDraft() {
  return {
    masters: [{ name: 'Regular' }],
    lang: { latinUpper: true, latinLower: true, numbers: true, punct: true },
    grid: { metrics: true },
    toggle: 'lang',
  };
}

function buildPage1() {
  if (!draft) draft = newDraft();
  renderMasters(); setToggle(draft.toggle); renderProfile();
}

// --- masters ---
function renderMasters() {
  var list = $('m-list'); list.innerHTML = '';
  draft.masters.forEach(function (m, i) {
    var row = document.createElement('div'); row.className = 'm-row';
    var nm = document.createElement('span'); nm.textContent = m.name; row.appendChild(nm);
    if (i > 0) {
      var x = document.createElement('button'); x.className = 'm-x'; x.textContent = '✕';
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
  renderMasters(); renderProfile();
  $('m-list').classList.remove('hidden');
}

// --- the two toggles + shared right list ---
function setToggle(which) {
  draft.toggle = which;
  $('tg-lang').classList.toggle('active', which === 'lang');
  $('tg-grid').classList.toggle('active', which === 'grid');
  $('tg-lang').querySelector('.pill-ar').textContent = which === 'lang' ? '◀' : '▶';
  $('tg-grid').querySelector('.pill-ar').textContent = which === 'grid' ? '◀' : '▶';
  renderRightList(); updatePillLabels();
}
function curItems() { return draft.toggle === 'lang' ? charsets.ALPHABETS : charsets.GRIDS; }
function curSel() { return draft.toggle === 'lang' ? draft.lang : draft.grid; }
function renderRightList() {
  var box = $('rune-list'); box.innerHTML = '';
  var sel = curSel();
  curItems().forEach(function (it) {
    var on = !!sel[it.key];
    var row = document.createElement('div'); row.className = 'rune-item' + (on ? ' on' : '');
    var txt = document.createElement('div'); txt.className = 'ri-txt';
    txt.innerHTML = '<div class="ri-t">' + it.label + '</div><div class="ri-d">' + (it.desc || it.note || '') + '</div>';
    var btn = document.createElement('button'); btn.className = 'ri-btn'; btn.textContent = on ? '✕' : '+';
    btn.addEventListener('click', function () { sel[it.key] = !sel[it.key]; renderRightList(); updatePillLabels(); renderProfile(); });
    row.appendChild(txt); row.appendChild(btn); box.appendChild(row);
  });
}
function selectedLabels(which) {
  var sel = which === 'lang' ? draft.lang : draft.grid;
  var items = which === 'lang' ? charsets.ALPHABETS : charsets.GRIDS;
  return items.filter(function (it) { return sel[it.key]; }).map(function (it) { return it.label; });
}
function updatePillLabels() {
  var l = selectedLabels('lang'), g = selectedLabels('grid');
  $('tg-lang-lbl').textContent = l.length ? l.join(', ') : 'Language Support';
  $('tg-grid-lbl').textContent = g.length ? g.join(', ') : 'Supported Grids';
}

// --- profile (responsive: values shrink to never push the actions) ---
function renderProfile() {
  var p = $('profile');
  var fam = ($('nf-family') && $('nf-family').value.trim()) || 'Untitled';
  var masters = draft.masters.map(function (m) { return m.name; }).join(', ');
  var langs = selectedLabels('lang').join(', ') || '—';
  var grids = selectedLabels('grid').join(', ') || '—';
  p.innerHTML =
    '<div class="p-h">FONT NAME</div><div class="p-v">' + fam + '</div>' +
    '<div class="p-h">MASTERS</div><div class="p-v">' + masters + '</div>' +
    '<div class="p-h">LANGUAGE SUPPORT</div><div class="p-v">' + langs + '</div>' +
    '<div class="p-h">GRIDS</div><div class="p-v">' + grids + '</div>';
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
  var grids = Object.keys(draft.grid).filter(function (k) { return draft.grid[k]; });
  if (!grids.length) grids = ['metrics'];
  var m0 = draft.masters[0];
  var project = glyphset.createProject({
    familyName: ($('nf-family').value.trim() || 'Untitled'),
    masterName: m0.name, masterType: m0.name,
    alphabets: alphabets, grids: grids,
  });
  for (var i = 1; i < draft.masters.length; i++) glyphset.addMaster(project, draft.masters[i].name, draft.masters[i].name);
  fonts.push(project); activeFont = fonts.length - 1; selectedSlot = -1; lastSig = {};
  draft = null;
  show('work'); renderWorkspace();
  generateIllustratorProject(project);
}

// Build the Illustrator document up front: one artboard per glyph with the
// selected grids drawn and a ghost letter — "like a script", on Create Font.
function generateIllustratorProject(project) {
  setStatus('Creating Illustrator project…');
  var cfg = {
    familyName: project.meta.familyName,
    unitsPerEm: project.unitsPerEm,
    metrics: project.metrics,
    grids: project.grids.map(function (g) {
      return { kind: g.kind, cell: g.cell, divisions: g.divisions, penAngle: g.penAngle, overshoot: g.overshoot };
    }),
    glyphs: project.glyphs.map(function (g) { return { char: g.char, name: g.name }; }),
  };
  var payload = JSON.stringify(cfg);
  evalScript('fmCreateProject(' + JSON.stringify(payload) + ')').then(function (raw) {
    var r; try { r = JSON.parse(raw); } catch (e) { r = null; }
    if (r && r.ok) setStatus('Project ready · ' + r.artboards + ' artboards in ' + r.doc, 'ok');
    else setStatus('Project doc not created: ' + ((r && r.error) || 'unknown') + ' (panel still works)', 'err');
  });
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

function renderGrid() {
  var grid = $('grid'); grid.innerHTML = '';
  var f = curFont();
  f.glyphs.forEach(function (g, i) {
    var cell = document.createElement('div');
    cell.className = 'cell' + (isFilled(g) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '');
    var label = g.char != null ? (g.char === ' ' ? '␣' : g.char) : g.name;
    if (g.char == null) cell.className += ' named';
    if (isFilled(g)) {
      var th = glyphThumb(g);
      cell.innerHTML = (th || '') + '<span class="lab">' + label + '</span>';
    } else {
      cell.textContent = label;
    }
    cell.addEventListener('click', function () { selectedSlot = i; renderGrid(); updateAssign(); });
    cell.addEventListener('dblclick', function () { selectedSlot = i; updateAssign(); onAssign(); });
    grid.appendChild(cell);
  });
  var filled = f.glyphs.filter(isFilled).length;
  $('filledCount').textContent = filled + ' / ' + f.glyphs.length;
  $('exportBtn').disabled = filled === 0;
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
  renderTabs(); renderGrid(); updateAssign(); refreshTester();
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
    var f = curFont(), idx = res.index;
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
  $('m-ddbtn').addEventListener('click', function () { $('m-list').classList.toggle('hidden'); });
  $('tg-lang').addEventListener('click', function () { setToggle('lang'); });
  $('tg-grid').addEventListener('click', function () { setToggle('grid'); });
  $('nf-family').addEventListener('input', renderProfile);
  $('nf-import').addEventListener('click', onImport);
  $('nf-create').addEventListener('click', onStartCreating);
  $('w-newfont').addEventListener('click', function () { draft = newDraft(); buildPage1(); show('new'); });
  // page 2 (workspace)
  $('assignBtn').addEventListener('click', onAssign);
  $('altBtn').addEventListener('click', onAlt);
  $('ligBtn').addEventListener('click', onLig);
  $('exportBtn').addEventListener('click', onExport);
  ['t-size', 't-track', 't-kern'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
