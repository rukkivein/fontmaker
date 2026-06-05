'use strict';
/* FontMaker CEP panel controller (Adobe Illustrator).
 * Page 1 (New Font): name/designer/version, master type, multi-select character
 * sets, case filter, construction grid. Page 2 (Workspace): one tab per open
 * font, master sub-tabs, assign selected Illustrator artwork to glyph slots
 * (scaled to cap height) and export a real OTF via the shared host-agnostic core.
 * Geometry is read through ExtendScript; CEP runs Node so require/fs/Buffer are
 * native. */

var cs = new CSInterface();
var ROOT = cs.getSystemPath(SystemPath.EXTENSION);

var ilbridge = require(ROOT + '/js/ilbridge.js');
var glyphset = require(ROOT + '/js/glyphset.js');
var charsets = require(ROOT + '/js/charsets.js');
var fontEngine = require(ROOT + '/js/lib/fontEngine.js');
var fs = require('fs');

// ---- state ----
var fonts = [];          // array of project objects (each may have several masters)
var activeFont = -1;     // index into fonts
var selectedSlot = -1;   // glyph index within the active font

function $(id) { return document.getElementById(id); }
function show(view) {
  $('view-new').classList.toggle('hidden', view !== 'new');
  $('view-work').classList.toggle('hidden', view !== 'work');
}
function evalScript(code) {
  return new Promise(function (res) { cs.evalScript(code, function (r) { res(r); }); });
}

// ============ PAGE 1 — New Font ============
function buildNewFontForm() {
  var mt = $('nf-mastertype');
  mt.innerHTML = '';
  charsets.MASTER_TYPES.forEach(function (t) {
    var o = document.createElement('option'); o.value = t; o.textContent = t; mt.appendChild(o);
  });

  var box = $('nf-alphabets'); box.innerHTML = '';
  var defaults = { latinUpper: 1, latinLower: 1, numbers: 1, punct: 1 };
  charsets.ALPHABETS.forEach(function (a) {
    var lab = document.createElement('label'); lab.className = 'check';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = a.key;
    if (defaults[a.key]) cb.checked = true;
    var span = document.createElement('span');
    span.innerHTML = a.label + (a.note ? ' <i class="muted">' + a.note + '</i>' : '');
    lab.appendChild(cb); lab.appendChild(span); box.appendChild(lab);
  });

  var grids = $('nf-grids'); grids.innerHTML = '';
  charsets.GRIDS.forEach(function (g, i) {
    var card = document.createElement('label'); card.className = 'gridcard';
    var rb = document.createElement('input'); rb.type = 'radio'; rb.name = 'grid'; rb.value = g.key;
    if (i === 0) rb.checked = true;
    var t = document.createElement('div'); t.className = 'gridcard-t'; t.textContent = g.label;
    var n = document.createElement('div'); n.className = 'gridcard-n'; n.textContent = g.note;
    card.appendChild(rb); card.appendChild(t); card.appendChild(n); grids.appendChild(card);
  });
}

function readNewFontForm() {
  var alphabets = [];
  var boxes = $('nf-alphabets').querySelectorAll('input[type=checkbox]');
  for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) alphabets.push(boxes[i].value);
  var caseVal = (document.querySelector('input[name=case]:checked') || {}).value || 'both';
  var grid = (document.querySelector('input[name=grid]:checked') || {}).value || 'metrics';
  return {
    familyName: $('nf-family').value.trim() || 'Untitled',
    designer: $('nf-designer').value.trim(),
    version: $('nf-version').value.trim() || '1.000',
    masterType: $('nf-mastertype').value,
    masterName: $('nf-mastertype').value,
    alphabets: alphabets,
    upperOnly: caseVal === 'upper',
    lowerOnly: caseVal === 'lower',
    grid: grid,
  };
}

function onCreateFont() {
  var opts = readNewFontForm();
  if (!opts.alphabets.length) { $('nf-status').textContent = 'Pick at least one character set.'; $('nf-status').className = 'status err'; return; }
  var project = glyphset.createProject(opts);
  project._activeMaster = 0;
  fonts.push(project);
  activeFont = fonts.length - 1;
  selectedSlot = -1;
  $('nf-status').textContent = '';
  show('work');
  renderWorkspace();
}

// ============ PAGE 2 — Workspace ============
function curFont() { return fonts[activeFont]; }
function curMaster() { var f = curFont(); return f.masters[f._activeMaster || 0]; }

function isFilled(g, masterId) {
  var l = g.layers[masterId];
  return !!(l && l.contours && l.contours.length);
}

function renderTabs() {
  var tabs = $('w-tabs'); tabs.innerHTML = '';
  fonts.forEach(function (f, i) {
    var t = document.createElement('div');
    t.className = 'tab' + (i === activeFont ? ' active' : '');
    t.textContent = f.meta.familyName;
    t.addEventListener('click', function () { activeFont = i; selectedSlot = -1; renderWorkspace(); });
    tabs.appendChild(t);
  });
}

function renderMasters() {
  var mt = $('w-masters'); mt.innerHTML = '';
  var f = curFont();
  f.masters.forEach(function (m, i) {
    var b = document.createElement('div');
    b.className = 'mtab' + (i === (f._activeMaster || 0) ? ' active' : '');
    b.textContent = m.name;
    b.title = 'Master: ' + m.type;
    b.addEventListener('click', function () { f._activeMaster = i; renderWorkspace(); });
    mt.appendChild(b);
  });
  var add = document.createElement('div');
  add.className = 'mtab add'; add.textContent = '＋'; add.title = 'Add master';
  add.addEventListener('click', onAddMaster);
  mt.appendChild(add);
}

function onAddMaster() {
  var types = charsets.MASTER_TYPES;
  var f = curFont();
  // cycle to the next unused type as a sensible default name
  var used = {}; f.masters.forEach(function (m) { used[m.type] = 1; });
  var pick = types.filter(function (t) { return !used[t]; })[0] || 'Other';
  var m = glyphset.addMaster(f, pick, pick);
  f._activeMaster = f.masters.length - 1;
  renderWorkspace();
  setStatus('Added master "' + m.name + '".', 'ok');
}

function renderGrid() {
  var grid = $('grid'); grid.innerHTML = '';
  var f = curFont(); var mid = curMaster().id;
  f.glyphs.forEach(function (g, i) {
    var cell = document.createElement('div');
    cell.className = 'cell' + (isFilled(g, mid) ? ' filled' : '') + (i === selectedSlot ? ' selected' : '');
    cell.textContent = g.char === ' ' ? '␣' : g.char;
    cell.addEventListener('click', function () { selectedSlot = i; renderGrid(); updateAssign(); });
    grid.appendChild(cell);
  });
  var filled = f.glyphs.filter(function (g) { return isFilled(g, mid); }).length;
  $('filledCount').textContent = filled + ' / ' + f.glyphs.length;
  $('exportBtn').disabled = filled === 0;
}

function updateAssign() {
  var ok = selectedSlot >= 0;
  $('assignBtn').disabled = !ok;
  if (ok) { var g = curFont().glyphs[selectedSlot]; $('assignTarget').textContent = g.char === ' ' ? 'space' : g.char; }
  else $('assignTarget').textContent = '—';
}

function setStatus(msg, kind) { $('status').textContent = msg; $('status').className = 'status' + (kind ? ' ' + kind : ''); }

function renderWorkspace() {
  renderTabs(); renderMasters(); renderGrid(); updateAssign();
  setStatus('Editing ' + curFont().meta.familyName + ' · ' + curMaster().name + ' · ' + curFont().glyphs.length + ' slots');
}

// ---- assign selection -> glyph (active master) ----
function onAssign() {
  if (selectedSlot < 0) return;
  setStatus('Reading selection…');
  evalScript('fmReadSelection()').then(function (raw) {
    var res; try { res = JSON.parse(raw); } catch (e) { setStatus('Bridge returned bad data.', 'err'); return; }
    if (!res || !res.ok) { setStatus((res && res.error) || 'Could not read selection.', 'err'); return; }
    var contours = ilbridge.contoursFromSelection(res.paths);
    if (!contours.length) { setStatus('Selection has no usable outlines.', 'err'); return; }
    var ok = glyphset.assignContoursToGlyph(curFont(), contours, selectedSlot, curMaster().id);
    if (!ok) { setStatus('Could not place selection.', 'err'); return; }
    var g = curFont().glyphs[selectedSlot];
    var pts = contours.reduce(function (n, c) { return n + c.points.length; }, 0);
    setStatus('Assigned ' + contours.length + ' contour(s), ' + pts + ' pts → "' + g.char + '" (' + curMaster().name + ').', 'ok');
    renderGrid();
  });
}

// ---- export OTF (active master) ----
function onExport() {
  var f = curFont(), m = curMaster();
  var meta = {
    familyName: f.meta.familyName, styleName: m.type || 'Regular',
    designer: f.meta.designer, version: f.meta.version, masterId: m.id,
  };
  var fileName = (f.meta.familyName.replace(/\s+/g, '') || 'Font') + '-' + (m.name || 'Regular') + '.otf';
  setStatus('Choose where to save…');
  var dlg = '(function(){var f=File.saveDialog("Save font","OTF:*.otf");if(!f)return "";' +
            'if(f.name.indexOf(".")<0)f=new File(f.fsName+".otf");return f.fsName;})()';
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
  buildNewFontForm();
  show('new');
  $('nf-create').addEventListener('click', onCreateFont);
  $('nf-cancel').addEventListener('click', function () { if (fonts.length) { show('work'); renderWorkspace(); } });
  $('w-newfont').addEventListener('click', function () {
    $('nf-cancel').classList.remove('hidden'); buildNewFontForm(); show('new');
  });
  $('assignBtn').addEventListener('click', onAssign);
  $('exportBtn').addEventListener('click', onExport);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
