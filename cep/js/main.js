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

// ============ PAGE 1 — New Font ============
function buildNewFontForm() {
  var mt = $('nf-mastertype'); mt.innerHTML = '';
  charsets.MASTER_TYPES.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = t; mt.appendChild(o); });

  var list = $('nf-cs-list'); list.innerHTML = '';
  var defaults = { latinUpper: 1, latinLower: 1, numbers: 1, punct: 1 };
  charsets.ALPHABETS.forEach(function (a) {
    var lab = document.createElement('label'); lab.className = 'check';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = a.key;
    if (defaults[a.key]) cb.checked = true;
    cb.addEventListener('change', updateCsSummary);
    var span = document.createElement('span');
    span.innerHTML = a.label + (a.note ? ' <i class="muted">' + a.note + '</i>' : '');
    lab.appendChild(cb); lab.appendChild(span); list.appendChild(lab);
  });
  updateCsSummary();

  var grids = $('nf-grids'); grids.innerHTML = '';
  charsets.GRIDS.forEach(function (g, i) {
    var card = document.createElement('label'); card.className = 'gridcard';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'grid'; cb.value = g.key;
    if (i === 0) cb.checked = true;
    cb.addEventListener('change', updateGridWarn);
    var t = document.createElement('div'); t.className = 'gridcard-t'; t.textContent = g.label;
    var n = document.createElement('div'); n.className = 'gridcard-n'; n.textContent = g.note;
    card.appendChild(cb); card.appendChild(t); card.appendChild(n); grids.appendChild(card);
  });
  updateGridWarn();
}

function selectedAlphabets() {
  var out = [], b = $('nf-cs-list').querySelectorAll('input');
  for (var i = 0; i < b.length; i++) if (b[i].checked) out.push(b[i].value);
  return out;
}
function selectedGrids() {
  var out = [], b = $('nf-grids').querySelectorAll('input');
  for (var i = 0; i < b.length; i++) if (b[i].checked) out.push(b[i].value);
  return out;
}
function updateCsSummary() {
  var keys = selectedAlphabets();
  var n = charsets.collectGlyphs(keys, {}).length;
  $('nf-cs-summary').textContent = keys.length ? (keys.length + ' set' + (keys.length > 1 ? 's' : '') + ' · ' + n + ' glyphs') : 'Select…';
}
function updateGridWarn() {
  var n = selectedGrids().length;
  var w = $('nf-gridwarn');
  if (n >= 3) { w.textContent = '⚠ ' + n + ' grids overlaid — the canvas may get busy.'; w.classList.remove('hidden'); }
  else w.classList.add('hidden');
}

function onCreateFont() {
  var alphabets = selectedAlphabets();
  if (!alphabets.length) { $('nf-status').textContent = 'Pick at least one character set.'; $('nf-status').className = 'status err'; return; }
  var grids = selectedGrids(); if (!grids.length) grids = ['metrics'];
  var project = glyphset.createProject({
    familyName: $('nf-family').value.trim() || 'Untitled',
    version: $('nf-version').value.trim() || '1.000',
    masterType: $('nf-mastertype').value, masterName: $('nf-mastertype').value,
    alphabets: alphabets, grids: grids,
  });
  fonts.push(project); activeFont = fonts.length - 1; selectedSlot = -1; lastSig = {};
  $('nf-status').textContent = '';
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
    if (isFilled(g)) {
      var th = glyphThumb(g);
      cell.innerHTML = (th || '') + '<span class="lab">' + (g.char === ' ' ? '␣' : g.char) + '</span>';
    } else {
      cell.textContent = g.char === ' ' ? '␣' : g.char;
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
  var ok = selectedSlot >= 0; $('assignBtn').disabled = !ok;
  $('assignTarget').textContent = ok ? (function () { var c = curFont().glyphs[selectedSlot].char; return c === ' ' ? 'space' : c; })() : '—';
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
  buildNewFontForm(); show('new');
  $('nf-cs-btn').addEventListener('click', function () { $('nf-cs-list').classList.toggle('hidden'); });
  $('nf-create').addEventListener('click', onCreateFont);
  $('nf-cancel').addEventListener('click', function () { if (fonts.length) { show('work'); renderWorkspace(); } });
  $('w-newfont').addEventListener('click', function () { $('nf-cancel').classList.remove('hidden'); buildNewFontForm(); show('new'); });
  $('assignBtn').addEventListener('click', onAssign);
  $('exportBtn').addEventListener('click', onExport);
  ['t-size', 't-track', 't-kern'].forEach(function (id) { $(id).addEventListener('input', applyTesterCtl); });
  startPolling();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
