import { store } from './store.js';
import { getTool } from './tools.js';
import { glyphboard } from './glyphboard.js';

// Returns an editing env for the active glyphboard pane (for button actions).
function activeEnv() {
  const mid = store.ui.activeMasterId;
  if (store.ui.visibleBoards.glyphboard && glyphboard.canvases[mid]) {
    const r = glyphboard.canvases[mid].canvas.getBoundingClientRect();
    const env = glyphboard.makeEnv(mid);
    env._w = r.width; env._h = r.height;
    return env;
  }
  return null;
}

function renderControl(d) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl-group';
  if (d.label) { const l = document.createElement('div'); l.className = 'ctl-label'; l.textContent = d.label; wrap.appendChild(l); }
  const row = document.createElement('div'); row.className = 'ctl-row'; wrap.appendChild(row);

  if (d.type === 'segmented') {
    const seg = document.createElement('div'); seg.className = 'seg';
    for (const [val, txt] of d.options) {
      const b = document.createElement('button');
      b.textContent = txt; if (val === d.value) b.classList.add('active');
      b.onclick = () => { d.onChange(val); refreshControlPanel(); glyphboard.requestDraw && glyphboard.requestDraw(); };
      seg.appendChild(b);
    }
    row.appendChild(seg);
  } else if (d.type === 'slider') {
    const wrapS = document.createElement('div'); wrapS.className = 'slider-wrap';
    const input = document.createElement('input'); input.type = 'range';
    input.min = d.min; input.max = d.max; input.value = d.value;
    const val = document.createElement('span'); val.className = 'slider-val'; val.textContent = d.value;
    input.oninput = () => { val.textContent = input.value; d.onChange(+input.value); glyphboard.requestDraw && glyphboard.requestDraw(); };
    wrapS.appendChild(input); wrapS.appendChild(val); row.appendChild(wrapS);
  } else if (d.type === 'toggle') {
    const b = document.createElement('button'); b.className = 'mini-btn'; if (d.value) b.style.background = 'var(--accent)';
    b.textContent = (d.value ? '☑ ' : '☐ ') + d.text;
    b.onclick = () => { d.onChange(!d.value); refreshControlPanel(); glyphboard.requestDraw && glyphboard.requestDraw(); };
    row.appendChild(b);
  } else if (d.type === 'button') {
    const b = document.createElement('button'); b.className = 'mini-btn'; b.textContent = d.text;
    b.onclick = () => d.onClick(activeEnv());
    row.appendChild(b);
  }
  return wrap;
}

function iconToggle(symbol, active, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-toggle' + (active ? ' active' : '');
  b.textContent = symbol; b.title = title;
  b.onclick = onClick;
  return b;
}

let varAnimRAF = 0;
function toggleVarAnim() {
  const g = store.ui.globals;
  g.varAnim = !g.varAnim;
  if (g.varAnim) {
    const start = performance.now();
    const loop = (t) => {
      if (!store.ui.globals.varAnim) { glyphboard.requestDraw(); return; }
      store.ui._varT = (Math.sin((t - start) / 700) + 1) / 2;
      glyphboard.requestDraw();
      varAnimRAF = requestAnimationFrame(loop);
    };
    varAnimRAF = requestAnimationFrame(loop);
  } else {
    cancelAnimationFrame(varAnimRAF); store.ui._varT = null; glyphboard.requestDraw();
  }
  refreshControlPanel();
}

function masterGhostMenu(anchor) {
  closeAnyPopover();
  const pop = document.createElement('div');
  pop.className = 'dropdown'; pop.id = 'master-ghost-pop';
  // Clicks inside the menu must not reach the document close-handler.
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 4) + 'px';
  pop.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  const title = document.createElement('div'); title.className = 'ctl-label'; title.style.padding = '4px 8px';
  title.textContent = 'Show master ghosts'; pop.appendChild(title);
  for (const m of store.project.masters) {
    const on = !!store.ui.globals.ghostMasters[m.id];
    const item = document.createElement('button'); item.className = 'dropdown-item';
    item.innerHTML = `<span>${(on ? '☑' : '☐')} ${m.name}</span>`;
    item.onclick = (e) => {
      e.stopPropagation();
      store.ui.globals.ghostMasters[m.id] = !on;
      glyphboard.requestDraw(); masterGhostMenu(anchor);
    };
    pop.appendChild(item);
  }
  document.getElementById('modal-root').appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', closeAnyPopover, { once: true }), 0);
}
function closeAnyPopover() { const p = document.getElementById('master-ghost-pop'); if (p) p.remove(); }

export function refreshControlPanel() {
  if (!store.project) return;
  const toolHost = document.getElementById('tool-controls');
  const globalHost = document.getElementById('global-controls');
  toolHost.innerHTML = ''; globalHost.innerHTML = '';

  // Active tool's contextual controls.
  const tool = getTool(store.ui.tool);
  const nameTag = document.createElement('div'); nameTag.className = 'ctl-group';
  nameTag.innerHTML = `<div class="ctl-label">Tool</div><div class="ctl-row" style="font-weight:600">${tool.label}</div>`;
  toolHost.appendChild(nameTag);
  for (const d of (tool.controls ? tool.controls() : [])) toolHost.appendChild(renderControl(d));

  // Global controls (right side).
  const g = store.ui.globals;
  globalHost.appendChild(iconToggle('👁', g.ghostOn, 'Toggle ghost letters', () => { g.ghostOn = !g.ghostOn; glyphboard.requestDraw(); refreshControlPanel(); }));
  globalHost.appendChild(iconToggle('▦', g.gridsOn, 'Toggle grids', () => { g.gridsOn = !g.gridsOn; glyphboard.requestDraw(); refreshControlPanel(); }));
  globalHost.appendChild(iconToggle('🔗', g.linkMasters, 'Link masters (apply edits to all)', () => { g.linkMasters = !g.linkMasters; refreshControlPanel(); }));
  globalHost.appendChild(iconToggle('▶', g.varAnim, 'Test variable interpolation', toggleVarAnim));
  const ghostBtn = iconToggle('◍', false, 'Master ghosts…', null);
  ghostBtn.onclick = () => masterGhostMenu(ghostBtn);
  globalHost.appendChild(ghostBtn);
}
