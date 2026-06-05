'use strict';
/* FontMaker CEP panel controller (Adobe Illustrator).
 * Draw letters in Illustrator; this panel assigns the selected artwork to glyph
 * slots (scaled to cap height, written to every master) and exports a real OTF
 * via the shared host-agnostic engine. Geometry is read through ExtendScript
 * (jsx/fontmaker.jsx) and converted with the same shared/ilbridge.js used by the
 * tests, then built with core/fontEngine.js. CEP runs Node, so require/fs/Buffer
 * are native. */

var cs = new CSInterface();
var ROOT = cs.getSystemPath(SystemPath.EXTENSION);

// Node modules (absolute paths — robust across CEP require quirks).
var ilbridge = require(ROOT + '/js/ilbridge.js');
var glyphset = require(ROOT + '/js/glyphset.js');
var fontEngine = require(ROOT + '/js/lib/fontEngine.js');
var fs = require('fs');

// --- state ---
var project = glyphset.createProject({ familyName: 'My Typeface' });
var selectedIndex = -1;

// --- dom ---
function $(id) { return document.getElementById(id); }
var grid = $('grid'), statusEl = $('status'), assignBtn = $('assignBtn');
var assignTarget = $('assignTarget'), exportBtn = $('exportBtn'), filledCount = $('filledCount');

function setStatus(msg, kind) { statusEl.textContent = msg; statusEl.className = 'status' + (kind ? ' ' + kind : ''); }

function evalScript(code) {
  return new Promise(function (resolve) { cs.evalScript(code, function (r) { resolve(r); }); });
}

function isFilled(g) {
  var layer = g.layers[project.masters[0].id];
  return !!(layer && layer.contours && layer.contours.length);
}
function refreshCounts() {
  var n = project.glyphs.filter(isFilled).length;
  filledCount.textContent = n + (n === 1 ? ' glyph' : ' glyphs');
  exportBtn.disabled = n === 0;
}
function buildGrid() {
  grid.textContent = '';
  project.glyphs.forEach(function (g, i) {
    var cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = g.char === ' ' ? '␣' : g.char;
    cell.addEventListener('click', function () { selectGlyph(i); });
    grid.appendChild(cell);
  });
  syncGrid();
}
function syncGrid() {
  var cells = grid.children;
  for (var i = 0; i < cells.length; i++) {
    var cls = 'cell';
    if (isFilled(project.glyphs[i])) cls += ' filled';
    if (i === selectedIndex) cls += ' selected';
    cells[i].className = cls;
  }
  refreshCounts();
}
function selectGlyph(i) {
  selectedIndex = i;
  var g = project.glyphs[i];
  assignTarget.textContent = g.char === ' ' ? 'space' : g.char;
  assignBtn.disabled = false;
  syncGrid();
}

// --- assign selection -> glyph ---
function onAssign() {
  if (selectedIndex < 0) return;
  setStatus('Reading selection…');
  evalScript('fmReadSelection()').then(function (raw) {
    var res;
    try { res = JSON.parse(raw); } catch (e) { setStatus('Bridge returned bad data.', 'err'); return; }
    if (!res || !res.ok) { setStatus((res && res.error) || 'Could not read selection.', 'err'); return; }
    // res.paths matches the shape shared/ilbridge.js expects → reuse it (Y flip + handles).
    var contours = ilbridge.contoursFromSelection(res.paths);
    if (!contours.length) { setStatus('Selection has no usable outlines.', 'err'); return; }
    var ok = glyphset.assignContoursToGlyph(project, contours, selectedIndex);
    if (!ok) { setStatus('Could not place selection.', 'err'); return; }
    var g = project.glyphs[selectedIndex];
    var pts = contours.reduce(function (n, c) { return n + c.points.length; }, 0);
    setStatus('Assigned ' + contours.length + ' contour(s), ' + pts + ' pts → "' + g.char + '".', 'ok');
    syncGrid();
  });
}

// --- export OTF ---
function metadata() {
  return {
    familyName: ($('familyName').value || 'My Typeface').trim(),
    styleName: ($('styleName').value || 'Regular').trim(),
    designer: ($('designer').value || '').trim(),
    masterId: project.masters[0].id, version: '1.000',
  };
}
function onExport() {
  var meta = metadata();
  project.meta.familyName = meta.familyName;
  project.meta.styleName = meta.styleName;
  var fileName = (meta.familyName.replace(/\s+/g, '') || 'Font') + '.otf';
  setStatus('Choose where to save…');
  // Ask Illustrator for a save path (native dialog), then write with Node fs.
  var dlg = '(function(){var f=File.saveDialog("Save font","OTF:*.otf");' +
            'if(!f)return "";if(f.name.indexOf(".")<0)f=new File(f.fsName+".otf");return f.fsName;})()';
  evalScript(dlg).then(function (p) {
    if (!p) { setStatus('Export cancelled.'); return; }
    try {
      setStatus('Building font…');
      var built = fontEngine.buildFont(project, 'otf', meta);
      fs.writeFileSync(p, Buffer.from(new Uint8Array(built.buffer)));
      setStatus('Exported ' + built.glyphCount + ' glyphs → ' + p, 'ok');
    } catch (e) {
      setStatus('Export failed: ' + (e && e.message ? e.message : e), 'err');
    }
  });
}

// --- boot ---
function boot() {
  buildGrid();
  assignBtn.addEventListener('click', onAssign);
  exportBtn.addEventListener('click', onExport);
  evalScript('fmPing()').then(function (raw) {
    var info; try { info = JSON.parse(raw); } catch (e) { info = null; }
    if (info && info.ok) setStatus('Ready · ' + info.app + ' ' + info.version + (info.doc ? ' · ' + info.doc : '') + ' · ' + project.glyphs.length + ' slots');
    else setStatus('Ready · ' + project.glyphs.length + ' slots (host bridge not confirmed)');
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
