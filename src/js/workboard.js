import { store } from './store.js';
import { Viewport } from './viewport.js';
import { layerBounds, ensureLayer } from './geometry.js';
import { propagateToLinked } from './project.js';
import { chartboard } from './chartboard.js';
import { toast } from './toast.js';

// Ensure the project carries a workboard scratch space (persisted with save).
export function ensureWork(project) {
  if (!project.work) project.work = { shapes: [] };
  return project.work;
}

// Place a free-floating shape into a glyph: scale to cap height, sit on the
// baseline, give sensible sidebearings, then write into the active master.
export function assignShapeToGlyph(project, shape, glyphIndex, masterId, link) {
  const glyph = project.glyphs[glyphIndex];
  const b = layerBounds({ contours: shape.contours });
  if (!b) return;
  const target = project.metrics.capHeight;
  const scale = target / Math.max(b.h, 1);
  const lsb = 60;
  const tx = (x) => (x - b.minX) * scale + lsb;
  const ty = (y) => (y - b.minY) * scale; // baseline at min-y
  const place = () => shape.contours.map(c => ({
    closed: c.closed,
    points: c.points.map(p => ({
      x: tx(p.x), y: ty(p.y), type: p.type,
      handleIn: p.handleIn ? { x: tx(p.handleIn.x), y: ty(p.handleIn.y) } : null,
      handleOut: p.handleOut ? { x: tx(p.handleOut.x), y: ty(p.handleOut.y) } : null,
    })),
  }));
  const layer = ensureLayer(glyph, masterId);
  layer.contours = place();
  glyph.advanceWidth = Math.round(b.w * scale + lsb * 2);
  if (link) {
    propagateToLinked(project, glyphIndex, masterId, (other) => {
      other.contours = place();
    });
  }
}

export class Workboard {
  constructor() { this.view = new Viewport(); this._fitted = false; }

  mount(container) {
    this.container = container;
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    const info = document.createElement('div');
    info.className = 'board-info';
    info.textContent = 'Workboard — Import SVG/AI, then drag a shape onto a glyph →';
    container.appendChild(canvas); container.appendChild(info);
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

  draw() {
    if (!this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { ctx, canvas } = this;
    ctx.save(); ctx.scale(dpr, dpr);
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();

    // Light artboard grid.
    ctx.strokeStyle = col('--grid-line'); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    const o = this.view.toScreen(0, 0);
    ctx.beginPath(); ctx.moveTo(0, o.sy); ctx.lineTo(W, o.sy); ctx.moveTo(o.sx, 0); ctx.lineTo(o.sx, H); ctx.stroke();
    ctx.globalAlpha = 1;

    const work = ensureWork(store.project);
    for (const shape of work.shapes) {
      const selected = store.ui.workSelection.includes(shape.id);
      this.drawShape(ctx, shape, col, selected);
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
    ctx.fillStyle = col('--contour'); ctx.globalAlpha = selected ? 0.95 : 0.8; ctx.fill('evenodd');
    if (selected) { ctx.globalAlpha = 1; ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  shapeAt(x, y) {
    const work = ensureWork(store.project);
    // Hit-test by bounding box (cheap, adequate for selection).
    for (let i = work.shapes.length - 1; i >= 0; i--) {
      const b = layerBounds({ contours: work.shapes[i].contours });
      if (b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return work.shapes[i];
    }
    return null;
  }

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
      const shape = this.shapeAt(w.x, w.y);
      if (shape) {
        store.ui.workSelection = [shape.id];
        this._dragShape = { shape, startClient: { x: e.clientX, y: e.clientY }, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else store.ui.workSelection = [];
      this.draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this._pan) {
        this.view.pan(e.clientX - this._pan.x, e.clientY - this._pan.y);
        this._pan = { x: e.clientX, y: e.clientY }; this.draw(); return;
      }
      if (this._dragShape) {
        this._dragShape.moved = true;
        this.showDragGhost(e);
        const idx = chartboard.cellIndexAt(e.clientX, e.clientY);
        chartboard.setDropTarget(idx);
      }
    });
    const end = (e) => {
      if (this._pan) { this._pan = null; return; }
      if (this._dragShape) {
        const idx = chartboard.cellIndexAt(e.clientX, e.clientY);
        if (idx != null && this._dragShape.moved) {
          const masterId = store.ui.activeMasterId || store.project.masters[0].id;
          store.commit('Assign shape', (p) => {
            assignShapeToGlyph(p, this._dragShape.shape, idx, masterId, store.ui.globals.linkMasters);
          });
          const g = store.project.glyphs[idx];
          toast(`Assigned shape → “${g.char === ' ' ? 'space' : g.char}”`);
          store.notify('assign');
        }
        chartboard.setDropTarget(null);
        this.hideDragGhost();
        this._dragShape = null;
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

  showDragGhost(e) {
    if (!this._ghostEl) {
      this._ghostEl = document.createElement('div');
      this._ghostEl.style.cssText = 'position:fixed;z-index:700;pointer-events:none;font-size:11px;padding:5px 10px;border-radius:8px;background:var(--accent);color:#fff;box-shadow:var(--shadow);';
      this._ghostEl.textContent = '◈ Drop on a glyph to assign';
      document.body.appendChild(this._ghostEl);
    }
    this._ghostEl.style.left = (e.clientX + 12) + 'px';
    this._ghostEl.style.top = (e.clientY + 12) + 'px';
  }
  hideDragGhost() { if (this._ghostEl) { this._ghostEl.remove(); this._ghostEl = null; } }
}

export const workboard = new Workboard();
