import { store } from './store.js';
import { ALPHABETS, GRID_PRESETS, baseLetter } from './data.js';

function overlay() {
  const root = document.getElementById('modal-root');
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  root.appendChild(ov);
  return ov;
}
export function close() { const r = document.getElementById('modal-root'); r.querySelectorAll('.modal-overlay').forEach(o => o.remove()); }

// ---- New Project ---------------------------------------------------------
export function newProjectDialog(onCreate) {
  const ov = overlay();
  const m = document.createElement('div'); m.className = 'modal'; ov.appendChild(m);
  let masters = ['Regular', 'Bold'];
  const selectedAlphabets = new Set(['latin']);

  function render() {
    m.innerHTML = `
      <h2>New Project</h2>
      <p class="sub">Set up your family, masters, character sets and grid system.</p>
      <div class="field"><label>Family Name</label><input id="np-family" type="text" value="My Typeface"></div>
      <div class="field"><label>Masters (interpolation poles — e.g. Condensed / Regular / Expanded)</label>
        <div id="np-masters"></div>
        <button class="mini-btn" id="np-add-master">+ Add master</button>
      </div>
      <div class="field"><label>Character Sets (multilingual)</label><div class="chip-row" id="np-alpha"></div></div>
      <div class="field"><label>Grid System</label>
        <select id="np-grid">${Object.entries(GRID_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" id="np-cancel">Cancel</button>
        <button class="btn-primary" id="np-create">Create Project</button>
      </div>`;
    const mh = m.querySelector('#np-masters');
    masters.forEach((name, i) => {
      const row = document.createElement('div'); row.className = 'master-row';
      row.innerHTML = `<input type="text" value="${name}"><button class="mini-btn">✕</button>`;
      row.querySelector('input').oninput = (e) => masters[i] = e.target.value;
      row.querySelector('button').onclick = () => { if (masters.length > 1) { masters.splice(i, 1); render(); } };
      mh.appendChild(row);
    });
    m.querySelector('#np-add-master').onclick = () => { masters.push('Master ' + (masters.length + 1)); render(); };
    const ah = m.querySelector('#np-alpha');
    for (const [key, set] of Object.entries(ALPHABETS)) {
      const c = document.createElement('button');
      c.className = 'chip' + (selectedAlphabets.has(key) ? ' on' : '');
      c.textContent = set.label;
      c.onclick = () => { selectedAlphabets.has(key) ? selectedAlphabets.delete(key) : selectedAlphabets.add(key); render(); };
      ah.appendChild(c);
    }
    m.querySelector('#np-cancel').onclick = close;
    m.querySelector('#np-create').onclick = () => {
      const familyName = m.querySelector('#np-family').value.trim() || 'Untitled';
      const gridPreset = m.querySelector('#np-grid').value;
      const alphabets = selectedAlphabets.size ? [...selectedAlphabets] : ['latin'];
      close();
      onCreate({ familyName, masterNames: masters.slice(), alphabets, gridPreset });
    };
  }
  render();
}

// ---- Export --------------------------------------------------------------
export function exportDialog(onExport) {
  const ov = overlay();
  const m = document.createElement('div'); m.className = 'modal'; ov.appendChild(m);
  const meta = store.project.meta;
  m.innerHTML = `
    <h2>Export Font</h2>
    <p class="sub">Industry-standard output with embedded metadata.</p>
    <div class="field-row">
      <div class="field"><label>Format</label>
        <select id="ex-format">
          <option value="otf">OpenType (.otf)</option>
          <option value="ttf">TrueType (.ttf)</option>
          <option value="woff">Web Font (.woff)</option>
          <option value="variable">Variable (default master)</option>
        </select>
      </div>
      <div class="field"><label>Master</label>
        <select id="ex-master">${store.project.masters.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}</select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Family Name</label><input id="ex-family" type="text" value="${meta.familyName}"></div>
      <div class="field"><label>Style</label><input id="ex-style" type="text" value="${meta.styleName}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Designer</label><input id="ex-designer" type="text" value="${meta.designer || ''}"></div>
      <div class="field"><label>Version</label><input id="ex-version" type="text" value="${meta.version || '1.000'}"></div>
    </div>
    <div class="field"><label>Copyright</label><input id="ex-copyright" type="text" value="${meta.copyright || ''}"></div>
    <div class="field"><label>License</label><input id="ex-license" type="text" value="${meta.license || ''}"></div>
    <div class="modal-actions">
      <button class="btn-ghost" id="ex-cancel">Cancel</button>
      <button class="btn-primary" id="ex-go">Choose Folder & Export</button>
    </div>`;
  m.querySelector('#ex-cancel').onclick = close;
  m.querySelector('#ex-go').onclick = () => {
    const metadata = {
      familyName: m.querySelector('#ex-family').value,
      styleName: m.querySelector('#ex-style').value,
      designer: m.querySelector('#ex-designer').value,
      version: m.querySelector('#ex-version').value,
      copyright: m.querySelector('#ex-copyright').value,
      license: m.querySelector('#ex-license').value,
      masterId: m.querySelector('#ex-master').value,
    };
    const format = m.querySelector('#ex-format').value;
    // persist meta back into the project
    Object.assign(store.project.meta, {
      familyName: metadata.familyName, styleName: metadata.styleName,
      designer: metadata.designer, version: metadata.version,
      copyright: metadata.copyright, license: metadata.license,
    });
    close();
    onExport({ format, metadata });
  };
}

// ---- Find Glyph ----------------------------------------------------------
export function findGlyphDialog(onPick, seed = '') {
  const ov = overlay();
  const m = document.createElement('div'); m.className = 'modal'; ov.appendChild(m);
  m.innerHTML = `
    <h2>${seed ? 'Alternates & related' : 'Find Glyph'}</h2>
    <p class="sub">Type characters (e.g. A B é). Case variants, diacritics, stylistic alternates (.ssNN) and ligatures are shown too.</p>
    <input id="fg-input" type="text" placeholder="Type a letter…" autofocus>
    <div class="find-results" id="fg-results"></div>`;
  const input = m.querySelector('#fg-input');
  const results = m.querySelector('#fg-results');
  if (seed) input.value = seed;

  function update() {
    const q = input.value.trim();
    results.innerHTML = '';
    const glyphs = store.project.glyphs;
    let list = [];
    if (!q) {
      list = glyphs.slice(0, 40);
    } else {
      const targets = [...q];
      const bases = new Set(targets.map(c => baseLetter(c).toLowerCase()));
      const seen = new Set();
      const add = (g) => { if (g && !seen.has(g)) { seen.add(g); list.push(g); } };
      // 1) exact characters
      for (const g of glyphs) if (g.char && targets.includes(g.char)) add(g);
      // 2) case variants / diacritics (same base letter)
      for (const g of glyphs) if (g.char && bases.has(baseLetter(g.char).toLowerCase())) add(g);
      // 3) stylistic alternates (.ssNN) of any matched base
      const baseNames = new Set(list.filter(g => g.char).map(g => g.name));
      for (const g of glyphs) if (g.baseName && baseNames.has(g.baseName)) add(g);
      // 4) ligatures whose components include a typed character
      for (const g of glyphs) if (g.components && g.components.some(c => targets.includes(c))) add(g);
    }
    for (const g of list.slice(0, 80)) {
      const idx = glyphs.indexOf(g);
      const cell = document.createElement('div'); cell.className = 'find-cell';
      const label = g.char ? (g.char === ' ' ? '␣' : g.char) : (g.kind === 'ligature' ? '∮' : g.name.split('.').pop());
      cell.innerHTML = `<div class="ch">${label}</div><div class="nm">${g.name}</div>`;
      cell.onclick = () => { close(); onPick(idx); };
      results.appendChild(cell);
    }
  }
  input.oninput = update;
  input.onkeydown = (e) => { if (e.key === 'Enter') { const first = results.querySelector('.find-cell'); first && first.click(); } };
  update();
  setTimeout(() => input.focus(), 30);
}

// ---- Small text prompt ---------------------------------------------------
export function textPromptDialog(title, sub, placeholder, onSubmit) {
  const ov = overlay();
  const m = document.createElement('div'); m.className = 'modal'; ov.appendChild(m);
  m.innerHTML = `<h2>${title}</h2><p class="sub">${sub}</p>
    <input id="tp-input" type="text" placeholder="${placeholder}" autofocus>
    <div class="modal-actions"><button class="btn-ghost" id="tp-cancel">Cancel</button>
      <button class="btn-primary" id="tp-ok">Create</button></div>`;
  const input = m.querySelector('#tp-input');
  const go = () => { const v = input.value.trim(); close(); if (v) onSubmit(v); };
  m.querySelector('#tp-cancel').onclick = close;
  m.querySelector('#tp-ok').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  setTimeout(() => input.focus(), 30);
}

// ---- About / Shortcuts ---------------------------------------------------
export function infoDialog(title, html) {
  const ov = overlay();
  const m = document.createElement('div'); m.className = 'modal'; ov.appendChild(m);
  m.innerHTML = `<h2>${title}</h2><div class="sub" style="line-height:1.7">${html}</div>
    <div class="modal-actions"><button class="btn-primary" id="ok">OK</button></div>`;
  m.querySelector('#ok').onclick = close;
}
