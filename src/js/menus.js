import { store } from './store.js';

// In-app menubar mirroring the native menu, so the app feels like a real
// program regardless of platform chrome. Items dispatch stable action ids.
const MENUS = [
  { label: 'File', items: [
    ['New Project…', 'file:new', '⌘N'],
    ['Open Project…', 'file:open', '⌘O'],
    '-',
    ['Save', 'file:save', '⌘S'],
    ['Save As…', 'file:saveAs', '⇧⌘S'],
    '-',
    ['Import…', 'file:import', '⇧⌘I'],
    ['Export…', 'file:export', '⌘E'],
  ]},
  { label: 'Edit', items: [
    ['Undo', 'edit:undo', '⌘Z'],
    ['Redo', 'edit:redo', '⌘Y'],
    '-',
    ['Cut', 'edit:cut', '⌘X'],
    ['Copy', 'edit:copy', '⌘C'],
    ['Paste', 'edit:paste', '⌘V'],
    '-',
    ['Select All', 'edit:selectAll', '⌘A'],
    ['Deselect', 'edit:deselect', '⌘D'],
    '-',
    ['Find Glyph…', 'edit:findGlyph', '⌘F'],
  ]},
  { label: 'Window', items: [
    ['Glyphboard', 'window:glyphboard', '⌘1'],
    ['Workboard', 'window:workboard', '⌘2'],
    ['Chartboard', 'window:chartboard', '⌘3'],
    '-',
    ['Toggle Theme', 'window:toggleTheme', '⇧⌘T'],
  ]},
  { label: 'Help', items: [
    ['Keyboard Shortcuts', 'help:shortcuts'],
    ['About FontMaker', 'help:about'],
  ]},
];

let openDropdown = null;

export function buildMenubar(dispatch) {
  const bar = document.getElementById('menubar');
  bar.innerHTML = '';
  for (const menu of MENUS) {
    const btn = document.createElement('button');
    btn.className = 'menu-btn'; btn.textContent = menu.label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(btn, menu, dispatch); });
    btn.addEventListener('mouseenter', () => { if (openDropdown) toggleDropdown(btn, menu, dispatch); });
    bar.appendChild(btn);
  }
  // Top-bar Import / Export buttons.
  document.querySelectorAll('#topbar [data-action]').forEach(el => {
    el.addEventListener('click', () => dispatch(el.dataset.action));
  });
  document.addEventListener('click', closeDropdown);
}

function toggleDropdown(btn, menu, dispatch) {
  closeDropdown();
  document.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('open'));
  btn.classList.add('open');
  const dd = document.createElement('div');
  dd.className = 'dropdown';
  const r = btn.getBoundingClientRect();
  dd.style.left = r.left + 'px';
  for (const item of menu.items) {
    if (item === '-') { const s = document.createElement('div'); s.className = 'dropdown-sep'; dd.appendChild(s); continue; }
    const [label, action, accel] = item;
    const it = document.createElement('button'); it.className = 'dropdown-item';
    it.innerHTML = `<span>${label}</span>${accel ? `<span class="accel">${accel}</span>` : ''}`;
    it.addEventListener('click', (e) => { e.stopPropagation(); closeDropdown(); dispatch(action); });
    dd.appendChild(it);
  }
  document.getElementById('modal-root').appendChild(dd);
  openDropdown = { dd, btn };
}

function closeDropdown() {
  if (openDropdown) { openDropdown.dd.remove(); openDropdown.btn.classList.remove('open'); openDropdown = null; }
}
