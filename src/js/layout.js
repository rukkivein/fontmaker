import { store } from './store.js';
import { glyphboard } from './glyphboard.js';
import { workboard } from './workboard.js';
import { chartboard } from './chartboard.js';

const BOARDS = [
  { id: 'glyphboard', title: 'Glyphboard', inst: glyphboard },
  { id: 'workboard', title: 'Workboard', inst: workboard },
  { id: 'chartboard', title: 'Chartboard', inst: chartboard },
];

class Layout {
  mount(root) { this.root = root; this.render(); }

  visible() { return BOARDS.filter(b => store.ui.visibleBoards[b.id]); }

  render() {
    if (!this.root || !store.project) return;
    // If nothing visible, force chartboard (spec: it fills when others closed).
    if (!this.visible().length) store.ui.visibleBoards.chartboard = true;
    this.root.innerHTML = '';
    const vis = this.visible();
    vis.forEach((b, i) => {
      const board = document.createElement('section');
      board.className = 'board' + (store.ui.activeBoard === b.id ? ' active' : '');
      if (b.id === 'glyphboard' && store.ui.glyphboardLight) board.classList.add('surface-light');
      board.dataset.board = b.id;
      board.style.flex = (store.ui.layout[shortKey(b.id)] || 1) + ' 1 0';
      board.appendChild(this.buildHead(b));
      const body = document.createElement('div');
      body.className = 'board-body';
      board.appendChild(body);
      board.addEventListener('pointerdown', () => { store.ui.activeBoard = b.id; this.markActive(); }, true);
      this.root.appendChild(board);
      // Mount the board instance into the body.
      b.inst.mount(body);

      if (i < vis.length - 1) this.root.appendChild(this.buildSplitter(b, vis[i + 1]));
    });
    requestAnimationFrame(() => this.resizeAll());
  }

  buildHead(b) {
    const head = document.createElement('div');
    head.className = 'board-head';
    const title = document.createElement('span');
    title.className = 'board-title'; title.textContent = b.title;
    head.appendChild(title);

    if (b.id === 'glyphboard') {
      const idx = store.ui.selectedGlyph;
      const g = idx != null ? store.project.glyphs[idx] : null;
      const sub = document.createElement('span');
      sub.textContent = g ? `“${g.char === ' ' ? 'space' : g.char}”` : '(no glyph)';
      sub.style.color = 'var(--text-dim)';
      head.appendChild(sub);

      const tabs = document.createElement('div');
      tabs.className = 'board-tabs';
      const open = glyphboard.openMasterList();
      for (const m of store.project.masters) {
        const t = document.createElement('button');
        t.className = 'board-tab' + (open.includes(m.id) ? ' active' : '');
        t.textContent = m.name;
        t.title = 'Click: edit · Shift-click: add to split view';
        t.addEventListener('click', (e) => {
          e.stopPropagation();
          let list = glyphboard.openMasterList().slice();
          if (e.shiftKey) {
            if (list.includes(m.id)) { if (list.length > 1) list = list.filter(x => x !== m.id); }
            else list.push(m.id);
          } else list = [m.id];
          store.ui.activeMasterId = m.id;
          store.ui.ghostMasterId = m.id;
          glyphboard.setOpenMasters(list);
          this.render();
          store.notify('ui');
        });
        tabs.appendChild(t);
      }
      head.appendChild(tabs);
    }

    if (b.id === 'chartboard') {
      const sel = document.createElement('select');
      sel.style.cssText = 'margin-left:auto;background:var(--bg-3);color:var(--text);border:1px solid var(--panel-border);border-radius:6px;padding:2px 6px;';
      for (const m of store.project.masters) {
        const o = document.createElement('option'); o.value = m.id; o.textContent = m.name;
        if (m.id === (store.ui.activeMasterId || store.project.masters[0].id)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { store.ui.activeMasterId = sel.value; chartboard.renderAll(); });
      head.appendChild(sel);
    }
    return head;
  }

  buildSplitter(left, right) {
    const sp = document.createElement('div');
    sp.className = 'splitter';
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const lk = shortKey(left.id), rk = shortKey(right.id);
      const l0 = store.ui.layout[lk] || 1, r0 = store.ui.layout[rk] || 1;
      const total = l0 + r0;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const frac = dx / Math.max(200, this.root.clientWidth);
        let nl = Math.max(0.15, l0 + frac * total);
        let nr = Math.max(0.15, r0 - frac * total);
        store.ui.layout[lk] = nl; store.ui.layout[rk] = nr;
        this.applyFlex();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.resizeAll(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    return sp;
  }

  applyFlex() {
    for (const el of this.root.querySelectorAll('.board')) {
      el.style.flex = (store.ui.layout[shortKey(el.dataset.board)] || 1) + ' 1 0';
    }
    this.resizeAll();
  }

  markActive() {
    for (const el of this.root.querySelectorAll('.board'))
      el.classList.toggle('active', el.dataset.board === store.ui.activeBoard);
    glyphboard.draw && glyphboard.draw();
  }

  resizeAll() {
    if (store.ui.visibleBoards.glyphboard) glyphboard.resize();
    if (store.ui.visibleBoards.workboard) workboard.resize();
    if (store.ui.visibleBoards.chartboard) chartboard.renderAll();
  }
}

function shortKey(id) { return id === 'glyphboard' ? 'glyph' : id === 'workboard' ? 'work' : 'chart'; }

export const layout = new Layout();
