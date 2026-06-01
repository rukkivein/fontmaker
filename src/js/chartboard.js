import { store } from './store.js';
import { ensureLayer, layerBounds } from './geometry.js';

// Renders one glyph's outline (active master) into a small canvas, fit to box.
export function renderGlyphPreview(canvas, glyph, masterId, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.save(); ctx.scale(dpr, dpr);
  const W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const m = store.project.metrics;
  const layer = ensureLayer(glyph, masterId);
  const pad = 0.16 * H;
  const emH = m.ascender - m.descender;
  const scale = (H - 2 * pad) / emH;
  const baseY = H - pad + m.descender * scale;
  const cx = W / 2 - (glyph.advanceWidth * scale) / 2;
  const toS = (x, y) => ({ sx: cx + x * scale, sy: baseY - y * scale });

  if (!layer.contours.length) {
    // Placeholder: show character ghost + (un)assigned state.
    if (glyph.char && glyph.char !== ' ') {
      ctx.fillStyle = css.getPropertyValue('--text-faint').trim();
      ctx.globalAlpha = 0.5;
      ctx.font = `${Math.round(H * 0.5)}px "Helvetica Neue", Arial`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph.char, W / 2, H / 2);
    }
    ctx.restore(); return;
  }
  ctx.beginPath();
  for (const c of layer.contours) {
    const pts = c.points; if (!pts.length) continue;
    let s = toS(pts[0].x, pts[0].y); ctx.moveTo(s.sx, s.sy);
    const n = pts.length, segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n], bs = toS(b.x, b.y);
      if (a.handleOut || b.handleIn) {
        const c1 = toS((a.handleOut || a).x, (a.handleOut || a).y), c2 = toS((b.handleIn || b).x, (b.handleIn || b).y);
        ctx.bezierCurveTo(c1.sx, c1.sy, c2.sx, c2.sy, bs.sx, bs.sy);
      } else ctx.lineTo(bs.sx, bs.sy);
    }
    if (c.closed) ctx.closePath();
  }
  ctx.fillStyle = opts.color || css.getPropertyValue('--contour').trim();
  ctx.fill('evenodd');
  ctx.restore();
}

export class Chartboard {
  mount(container) {
    this.container = container;
    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'chart-grid';
    container.appendChild(grid);
    this.grid = grid;
    this.cells = [];
    const p = store.project;
    const masterId = store.ui.activeMasterId || p.masters[0].id;

    // Responsive column count.
    const colW = 76;
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${colW}px, 1fr))`;

    p.glyphs.forEach((glyph, idx) => {
      const cell = document.createElement('div');
      cell.className = 'chart-cell';
      cell.dataset.idx = idx;
      const hasOutline = (ensureLayer(glyph, masterId).contours.length > 0);
      if (hasOutline) cell.classList.add('assigned');
      if (idx === store.ui.selectedGlyph) cell.classList.add('selected');
      const cv = document.createElement('canvas');
      const label = document.createElement('div');
      label.className = 'cell-label';
      label.textContent = glyph.char === ' ' ? '␣' : glyph.char;
      cell.appendChild(cv); cell.appendChild(label);
      grid.appendChild(cell);
      this.cells.push({ cell, cv, idx });

      cell.addEventListener('click', () => {
        store.ui.selectedGlyph = idx;
        store.notify('select-glyph');
        this.refreshSelection();
      });
      cell.addEventListener('dblclick', () => {
        store.ui.selectedGlyph = idx;
        store.emit('open-glyphboard', idx);
      });
    });

    // Render previews after layout settles.
    requestAnimationFrame(() => this.renderAll());
  }

  renderAll() {
    const masterId = store.ui.activeMasterId || store.project.masters[0].id;
    for (const { cv, idx } of this.cells) {
      renderGlyphPreview(cv, store.project.glyphs[idx], masterId);
    }
  }

  refreshSelection() {
    for (const { cell, idx } of this.cells) cell.classList.toggle('selected', idx === store.ui.selectedGlyph);
  }

  // Highlight a cell as a drop target while dragging a workboard shape.
  setDropTarget(idx) {
    for (const { cell, idx: i } of this.cells) cell.classList.toggle('drop-target', i === idx);
  }
  cellIndexAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const cell = el && el.closest && el.closest('.chart-cell');
    return cell ? +cell.dataset.idx : null;
  }
}

export const chartboard = new Chartboard();
