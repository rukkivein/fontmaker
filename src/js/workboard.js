import { store, uid } from './store.js';
import { Viewport } from './viewport.js';
import { layerBounds, pointInShape, breakApart } from './geometry.js';
import { setLayerAllMasters } from './project.js';
import { chartboard } from './chartboard.js';
import { toast } from './toast.js';

// Ensure the project carries a workboard scratch space (persisted with save).
export function ensureWork(project) {
  if (!project.work) project.work = { shapes: [] };
  return project.work;
}

// Place a free-floating shape (one or more contours) into a glyph: scale to cap
// height, sit on the baseline, give sensible sidebearings, write to all masters.
export function assignShapeToGlyph(project, contours, glyphIndex) {
  const glyph = project.glyphs[glyphIndex];
  const b = layerBounds({ contours });
  if (!b) return;
  const target = project.metrics.capHeight;
  const scale = target / Math.max(b.h, 1);
  const lsb = 60;
  const tx = (x) => (x - b.minX) * scale + lsb;
  const ty = (y) => (y - b.minY) * scale;
  const place = () => contours.map(c => ({
    closed: c.closed,
    points: c.points.map(p => ({
      x: tx(p.x), y: ty(p.y), type: p.type,
      handleIn: p.handleIn ? { x: tx(p.handleIn.x), y: ty(p.handleIn.y) } : null,
      handleOut: p.handleOut ? { x: tx(p.handleOut.x), y: ty(p.handleOut.y) } : null,
    })),
  }));
  setLayerAllMasters(project, glyphIndex, place());
  glyph.advanceWidth = Math.round(b.w * scale + lsb * 2);
}

export class Workboard {
  constructor() { this.view = new Viewport(); this._fitted = false; }

  mount(container) {
    this.container = container;
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    const info = document.createElement('div');
    info.className = 'board-info';
    info.innerHTML = 'Click a shape · <b>Break Apart</b> to split into pieces · drag a piece onto a glyph →<br>Shift-click multi-selects · drag empty space pans';
    // Floating action bar (top-right).
    const bar = document.createElement('div');
    bar.className = 'wb-actions';
    bar.innerHTML = `
      <button class="wb-btn" data-act="break">⛒ Break Apart</button>
      <button class="wb-btn" data-act="breakAll">Break All</button>
      <button class="wb-btn" data-act="selectAll">Select All</button>
      <button class="wb-btn" data-act="delete">Delete</button>`;
    bar.querySelector('[data-act=break]').onclick = () => this.breakSelected(false);
    bar.querySelector('[data-act=breakAll]').onclick = () => this.breakSelected(true);
    bar.querySelector('[data-act=selectAll]').onclick = () => { store.ui.workSelection = ensureWork(store.project).shapes.map(s => s.id); this.draw(); };
    bar.querySelector('[data-act=delete]').onclick = () => this.deleteSelected();
    container.appendChild(canvas); container.appendChild(info); container.appendChild(bar);
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.attach();
    this.resize();
  }

  resize() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    if (!this._fitted) { this.view.fit(r.width, r.height, store.project.metrics, 1000); this._fitted = true; }
    this.draw();
  }

  // Frame all shapes in view (used after an import so art lands on-screen
  // regardless of its native coordinate space).
  fitToShapes() {
    if (!this.canvas) return;
    const work = ensureWork(store.project);
    if (!work.shapes.length) return;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const s of work.shapes) for (const ct of s.contours) for (const p of ct.points) {
      a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y);
    }
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || a === 1e9) return;
    const bw = Math.max(c - a, 1), bh = Math.max(d - b, 1);
    this.view.angle = 0;
    this.view.scale = Math.min((r.width * 0.85) / bw, (r.height * 0.85) / bh);
    const cx = (a + c) / 2, cy = (b + d) / 2;
    this.view.ox = r.width / 2 - cx * this.view.scale;
    this.view.oy = r.height / 2 + cy * this.view.scale;
    this.draw();
  }

  draw() {
    if (!this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { ctx, canvas } = this;
    ctx.save(); ctx.scale(dpr, dpr);
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();

    ctx.strokeStyle = col('--grid-line'); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    const o = this.view.toScreen(0, 0);
    ctx.beginPath(); ctx.moveTo(0, o.sy); ctx.lineTo(W, o.sy); ctx.moveTo(o.sx, 0); ctx.lineTo(o.sx, H); ctx.stroke();
    ctx.globalAlpha = 1;

    const work = ensureWork(store.project);
    for (const shape of work.shapes) {
      this.drawShape(ctx, shape, col, store.ui.workSelection.includes(shape.id));
    }
    ctx.restore();
  }

  drawShape(ctx, shape, col, selected) {
    ctx.beginPath();
    for (const c of shape.contours) {
      const pts = c.points; if (!pts.length) continue;
      let s = this.view.toScreen(pts[0].x, pts[0].y); ctx.moveTo(s.sx, s.sy);
      const n = pts.length, segs = c.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n], bs = this.view.toScreen(b.x, b.y);
        if (a.handleOut || b.handleIn) {
          const c1 = this.view.toScreen((a.handleOut || a).x, (a.handleOut || a).y);
          const c2 = this.view.toScreen((b.handleIn || b).x, (b.handleIn || b).y);
          ctx.bezierCurveTo(c1.sx, c1.sy, c2.sx, c2.sy, bs.sx, bs.sy);
        } else ctx.lineTo(bs.sx, bs.sy);
      }
      if (c.closed) ctx.closePath();
    }
    ctx.fillStyle = selected ? col('--accent') : col('--contour');
    ctx.globalAlpha = selected ? 0.9 : 0.78; ctx.fill('evenodd');
    // Always outline each piece faintly so separate pieces stay distinguishable.
    ctx.globalAlpha = 1; ctx.lineWidth = selected ? 1.6 : 1;
    ctx.strokeStyle = selected ? col('--accent') : col('--panel-border');
    ctx.stroke();
  }

  shapesAtTop(x, y) {
    const work = ensureWork(store.project);
    for (let i = work.shapes.length - 1; i >= 0; i--) {
      const sh = work.shapes[i];
      if (pointInShape(sh, x, y)) return sh;
      // tiny/open shapes: fall back to bbox so they're still grabbable
      const b = layerBounds({ contours: sh.contours });
      if (b && b.w * b.h < 50 && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return sh;
    }
    return null;
  }

  selectedShapes() {
    const work = ensureWork(store.project);
    return work.shapes.filter(s => store.ui.workSelection.includes(s.id));
  }

  // ---- Break apart / delete --------------------------------------------
  breakSelected(all) {
    const work = ensureWork(store.project);
    const targets = all ? work.shapes.slice() : this.selectedShapes();
    if (!targets.length) { toast('Select a shape first'); return; }
    store.commit('Break apart', (p) => {
      const w = ensureWork(p);
      const newSel = [];
      for (const sh of targets) {
        const pieces = breakApart(sh.contours);
        if (pieces.length <= 1) { newSel.push(sh.id); continue; }
        const idx = w.shapes.indexOf(w.shapes.find(s => s.id === sh.id));
        const made = pieces.map(pc => ({ id: uid('shape'), contours: pc.contours, source: sh.source }));
        w.shapes.splice(idx, 1, ...made);
        made.forEach(m => newSel.push(m.id));
      }
      store.ui.workSelection = newSel;
    });
    const n = store.ui.workSelection.length;
    toast(`Broke into ${n} piece${n === 1 ? '' : 's'}`);
    this.draw();
  }

  deleteSelected() {
    if (!store.ui.workSelection.length) return;
    store.commit('Delete shapes', (p) => {
      const w = ensureWork(p);
      w.shapes = w.shapes.filter(s => !store.ui.workSelection.includes(s.id));
    });
    store.ui.workSelection = [];
    this.draw();
  }

  // ---- Pointer interaction ---------------------------------------------
  attach() {
    const canvas = this.canvas;
    const getPt = (e) => {
      const r = canvas.getBoundingClientRect();
      return this.view.toWorld(e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener('pointerdown', (e) => {
      store.ui.activeBoard = 'workboard'; store.emit('focus-changed');
      const w = getPt(e);
      if (e.button === 1 || store._space || store.ui.tool === 'position') {
        this._pan = { x: e.clientX, y: e.clientY }; return;
      }
      const shape = this.shapesAtTop(w.x, w.y);
      if (shape) {
        if (e.shiftKey) {
          const i = store.ui.workSelection.indexOf(shape.id);
          if (i >= 0) store.ui.workSelection.splice(i, 1); else store.ui.workSelection.push(shape.id);
        } else if (!store.ui.workSelection.includes(shape.id)) {
          store.ui.workSelection = [shape.id];
        }
        this._drag = { startWorld: w, lastWorld: w, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        if (!e.shiftKey) store.ui.workSelection = [];
      }
      this.draw();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this._pan) {
        this.view.pan(e.clientX - this._pan.x, e.clientY - this._pan.y);
        this._pan = { x: e.clientX, y: e.clientY }; this.draw(); return;
      }
      if (this._drag) {
        this._drag.moved = true;
        const overCell = chartboard.cellIndexAt(e.clientX, e.clientY);
        chartboard.setDropTarget(overCell);
        this.showDragGhost(e, overCell != null);
        // If dragging within the workboard (not over the chartboard), move the
        // selected pieces live so the user can lay them out.
        if (overCell == null) {
          const w = getPt(e);
          const dx = w.x - this._drag.lastWorld.x, dy = w.y - this._drag.lastWorld.y;
          this.translateSelected(dx, dy);
          this._drag.lastWorld = w;
          this.draw();
        }
      }
    });

    const end = (e) => {
      if (this._pan) { this._pan = null; return; }
      if (this._drag) {
        const idx = chartboard.cellIndexAt(e.clientX, e.clientY);
        if (idx != null && this._drag.moved) {
          // Assign the selected pieces (combined) to the target glyph.
          const contours = [].concat(...this.selectedShapes().map(s => s.contours));
          if (contours.length) {
            store.commit('Assign shape', (p) => assignShapeToGlyph(p, contours, idx));
            const g = store.project.glyphs[idx];
            toast(`Assigned → “${g.char === ' ' ? 'space' : g.char}”`);
            store.notify('assign');
          }
        } else if (this._drag.moved) {
          store.commit('Move shape', () => {}); // checkpoint the live move for undo
        }
        chartboard.setDropTarget(null);
        this.hideDragGhost();
        this._drag = null;
        this.draw();
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.view.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.08 : 0.926);
      else this.view.pan(-e.deltaX, -e.deltaY);
      this.draw();
    }, { passive: false });
  }

  translateSelected(dx, dy) {
    for (const sh of this.selectedShapes()) {
      for (const c of sh.contours) for (const p of c.points) {
        p.x += dx; p.y += dy;
        if (p.handleIn) { p.handleIn.x += dx; p.handleIn.y += dy; }
        if (p.handleOut) { p.handleOut.x += dx; p.handleOut.y += dy; }
      }
    }
  }

  showDragGhost(e, assigning) {
    if (!this._ghostEl) {
      this._ghostEl = document.createElement('div');
      this._ghostEl.style.cssText = 'position:fixed;z-index:700;pointer-events:none;font-size:11px;padding:5px 10px;border-radius:8px;background:var(--accent);color:#fff;box-shadow:var(--shadow);';
      document.body.appendChild(this._ghostEl);
    }
    this._ghostEl.textContent = assigning ? '◈ Drop on the glyph to assign' : '✥ Move';
    this._ghostEl.style.left = (e.clientX + 12) + 'px';
    this._ghostEl.style.top = (e.clientY + 12) + 'px';
  }
  hideDragGhost() { if (this._ghostEl) { this._ghostEl.remove(); this._ghostEl = null; } }
}

export const workboard = new Workboard();
