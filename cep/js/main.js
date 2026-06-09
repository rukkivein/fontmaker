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
  // Pre-select the most common Latin basics; other classic sets stay flagged.
  return {
    masters: [{ name: 'Regular' }],
    lang: { latinUpper: true, latinLower: true, numbers: true },
    preset: dna.DEFAULT_PRESET, presetTier: 'quick', customGrid: false,
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
  $('tierBar').classList.toggle('hidden', which !== 'preset');
  renderTier();
  renderRightList(); updatePillLabels();
}
function renderTier() {
  var tabs = $('tierBar').querySelectorAll('.tier-tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tier') === draft.presetTier);
}
function renderRightList() {
  var box = $('rune-list'); box.innerHTML = '';
  if (draft.toggle === 'preset') return renderPresets(box);
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
// Style Preset — single-select DNA preset (Quick or Advanced tier).
function renderPresets(box) {
  var list = draft.presetTier === 'advanced' ? dna.ADVANCED : dna.QUICK;
  list.forEach(function (p) {
    var on = !draft.customGrid && draft.preset === p.name;
    var row = document.createElement('div'); row.className = 'rune-item preset' + (on ? ' on' : '');
    var sub = p.similar ? ('like ' + p.similar) : ('geometry ' + p.params.geometry + ' · contrast ' + p.params.contrast);
    var txt = document.createElement('div'); txt.className = 'ri-txt';
    txt.innerHTML = '<div class="ri-t">' + p.name + '</div><div class="ri-d">' + sub + '</div>';
    var rad = document.createElement('div'); rad.className = 'ri-radio' + (on ? ' on' : '');
    row.appendChild(txt); row.appendChild(rad);
    row.addEventListener('click', function () {
      draft.preset = p.name; draft.customGrid = false; if ($('customGrid')) $('customGrid').checked = false;
      renderRightList(); updatePillLabels(); renderProfile();
    });
    box.appendChild(row);
  });
}
function selectedLangLabels() {
  return charsets.ALPHABETS.filter(function (it) { return draft.lang[it.key]; }).map(function (it) { return it.label; });
}
function updatePillLabels() {
  var l = selectedLangLabels();
  $('tg-lang-lbl').textContent = l.length ? l.join(', ') : 'Language Support';
  $('tg-grid-lbl').textContent = draft.customGrid ? 'Custom grid' : (draft.preset || 'Style Preset');
}

// --- profile (responsive: values shrink to never push the actions) ---
function renderProfile() {
  var p = $('profile');
  var fam = ($('nf-family') && $('nf-family').value.trim()) || 'Untitled';
  var masters = draft.masters.map(function (m) { return m.name; }).join(', ');
  var langs = selectedLangLabels().join(', ') || '—';
  var preset = draft.customGrid ? 'Custom grid' : (draft.preset || '—');
  p.innerHTML =
    '<div class="p-h">FONT NAME</div><div class="p-v">' + fam + '</div>' +
    '<div class="p-h">MASTERS</div><div class="p-v">' + masters + '</div>' +
    '<div class="p-h">LANGUAGE SUPPORT</div><div class="p-v">' + langs + '</div>' +
    '<div class="p-h">STYLE PRESET</div><div class="p-v">' + preset + '</div>';
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
  var project = glyphset.createProject({
    familyName: ($('nf-family').value.trim() || 'Untitled'),
    masterName: m0.name, masterType: m0.name,
    alphabets: alphabets, preset: draft.preset, customGrid: draft.customGrid,
  });
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
  $('tierBar').querySelectorAll('.tier-tab').forEach(function (t) {
    t.addEventListener('click', function () { draft.presetTier = t.getAttribute('data-tier'); renderTier(); renderRightList(); });
  });
  $('customGrid').addEventListener('change', function () {
    draft.customGrid = this.checked;
    renderRightList(); updatePillLabels(); renderProfile();
  });
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
