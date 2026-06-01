import { store } from './store.js';
import { TOOL_ORDER, getTool } from './tools.js';
import { refreshControlPanel } from './controlpanel.js';
import { glyphboard } from './glyphboard.js';

export function buildToolbar() {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = '';
  for (const id of TOOL_ORDER) {
    if (id === null) { const s = document.createElement('div'); s.className = 'tool-sep'; bar.appendChild(s); continue; }
    const tool = getTool(id);
    const b = document.createElement('button');
    b.className = 'tool-btn' + (store.ui.tool === id ? ' active' : '');
    b.dataset.tool = id;
    b.innerHTML = `${tool.icon}<span class="tip">${tool.label}</span>`;
    b.onclick = () => selectTool(id);
    bar.appendChild(b);
  }
}

export function selectTool(id) {
  store.ui.tool = id;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === id));
  refreshControlPanel();
  glyphboard.requestDraw && glyphboard.requestDraw();
}
