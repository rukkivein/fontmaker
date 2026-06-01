import { store } from './store.js';
import { Viewport } from './viewport.js';
import { ensureLayer, layerToSVGPath } from './geometry.js';
import { getTool } from './tools.js';

// The glyphboard: a horizontal split of panes, one per "open" master.
// Each pane edits one master layer of the currently selected glyph.
export class Glyphboard {
  constructor() {
    this.viewports = {};      // masterId -> Viewport
    this.canvases = {};       // masterId -> { canvas, ctx, pane, info }
    this.openMasters = null;  // array of masterIds, null => [activeMaster]
    this.drag = null;
    this._raf = 0;
  }

  openMasterList() {
    const p = store.project;
    if (this.openMasters && this.openMasters.length) {
      return this.openMasters.filter(id => p.masters.some(m => m.id === id));
    }
    return [store.ui.activeMasterId || p.masters[0].id];
  }

  mount(container) {
    this.container = container;
    container.innerHTML = '';
    const split = document.createElement('div');
    split.className = 'glyph-split';
    container.appendChild(split);
    this.split = split;
    this.canvases = {};
    this.viewports = this.viewports || {};

    const masters = this.openMasterList();
    for (const mid of masters) {
      const pane = document.createElement('div');
      pane.className = 'glyph-pane';
      pane.dataset.master = mid;
      const canvas = document.createElement('canvas');
      const info = document.createElement('div');
      info.className = 'board-info';
      const tag = document.createElement('div');
      tag.className = 'pane-tag';
      tag.textContent = this.masterName(mid);
      pane.appendChild(canvas); pane.appendChild(info); pane.appendChild(tag);
      split.appendChild(pane);
      this.canvases[mid] = { canvas, ctx: canvas.getContext('2d'), pane, info };
      if (!this.viewports[mid]) this.viewports[mid] = new Viewport();
      this.attach(canvas, mid);
    }
    this.resize();
  }

  masterName(mid) {
    const m = store.project.masters.find(x => x.id === mid);
    return m ? m.name : mid;
  }

  setOpenMasters(list) { this.openMasters = list; if (this.container) this.mount(this.container); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const mid of Object.keys(this.canvases)) {
      const { canvas } = this.canvases[mid];
      const r = canvas.getBoundingClientRect();
      if (r.width === 0) continue;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const v = this.viewports[mid];
      if (!v._fitted) {
        v.fit(r.width, r.height, store.project.metrics, this.curGlyph() ? this.curGlyph().advanceWidth : 600);
        v._fitted = true;
      }
    }
    this.draw();
  }

  curGlyph() {
    const idx = store.ui.selectedGlyph;
    return idx == null ? null : store.project.glyphs[idx];
  }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  // Color lookup. Honors the "light glyphboard surface" mode by overriding the
  // dark theme's tokens with a light set for this board only.
  colorFn() {
    const css = getComputedStyle(document.documentElement);
    if (!store.ui.glyphboardLight) return (n) => css.getPropertyValue(n).trim();
    const LIGHT = {
      '--grid-line': 'rgba(0,0,0,0.10)', '--grid-metric': 'rgba(55,62,74,0.42)', '--grid-movable': '#c97d18',
      '--ghost': 'rgba(0,0,0,0.13)', '--contour': '#14161a', '--accent': '#3a3f47', '--accent-2': '#7a7f88',
      '--point': '#3a3f47', '--point-sel': '#c97d18', '--handle': '#8a6fb0', '--bg-3': '#eceef1',
      '--text-faint': '#8a8f97', '--text-dim': '#5c6066', '--board-active': '#3a3f47',
    };
    return (n) => LIGHT[n] !== undefined ? LIGHT[n] : css.getPropertyValue(n).trim();
  }

  // ---- Rendering --------------------------------------------------------
  draw() {
    const glyph = this.curGlyph();
    for (const mid of Object.keys(this.canvases)) {
      this.drawPane(mid, glyph);
    }
  }

  drawPane(mid, glyph) {
    const cv = this.canvases[mid];
    if (!cv) return;
    const { ctx, canvas, pane, info } = cv;
    const dpr = window.devicePixelRatio || 1;
    const v = this.viewports[mid];
    ctx.save();
    ctx.scale(dpr, dpr);
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);

    const col = this.colorFn();

    const isActive = mid === (store.ui.ghostMasterId || store.ui.activeMasterId);
    pane.classList.toggle('active', isActive && store.ui.activeBoard === 'glyphboard');

    if (store.ui.globals.gridsOn) this.drawGrid(ctx, v, col);
    if (store.ui.globals.ghostOn && glyph) this.drawGhosts(ctx, v, glyph, mid, col);

    // Master ghosts: other masters' outlines, faint.
    if (glyph) {
      for (const m of store.project.masters) {
        if (m.id === mid) continue;
        if (!store.ui.globals.ghostMasters[m.id]) continue;
        this.drawContours(ctx, v, ensureLayer(glyph, m.id), col, { ghost: true });
      }
      let activeLayer = ensureLayer(glyph, mid);
      // Variable test animation: interpolate between the first two masters.
      if (store.ui.globals.varAnim && store.project.masters.length >= 2 && store.ui._varT != null) {
        const ms = store.project.masters;
        const interp = interpolateLayer(ensureLayer(glyph, ms[0].id), ensureLayer(glyph, ms[1].id), store.ui._varT);
        if (interp) activeLayer = interp;
      }
      this.drawContours(ctx, v, activeLayer, col, { active: isActive });
    }

    // Let the active tool draw overlays (selection box, brush ring…).
    const tool = getTool(store.ui.tool);
    if (tool.onRender && isActive) {
      tool.onRender(ctx, this.makeEnv(mid), { col, W, H });
    }

    ctx.restore();
    this.updateInfo(info, mid, glyph, v);
  }

  drawGrid(ctx, v, col) {
    const m = store.project.metrics;
    const upm = store.project.unitsPerEm;
    const editable = store.ui.gridEditMode;
    const metricCol = editable ? col('--grid-movable') : col('--grid-metric');
    const lines = [
      ['ascender', m.ascender], ['cap', m.capHeight], ['x-height', m.xHeight],
      ['baseline', m.baseline], ['descender', m.descender],
    ];
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    for (const [label, y] of lines) {
      const s = v.toScreen(0, y);
      ctx.strokeStyle = label === 'baseline' ? col('--grid-metric') : metricCol;
      ctx.globalAlpha = label === 'baseline' ? 0.9 : 0.6;
      ctx.beginPath(); ctx.moveTo(0, s.sy); ctx.lineTo(99999, s.sy); ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = metricCol;
      ctx.fillText(label, 6, s.sy - 3);
    }
    // Verticals (LSB/RSB) and advance width.
    ctx.globalAlpha = 0.5;
    const glyph = this.curGlyph();
    const verts = store.project.grid.verticals.map(vt => vt.x);
    if (glyph) verts.push(glyph.advanceWidth);
    for (const x of verts) {
      const s = v.toScreen(x, 0);
      ctx.strokeStyle = col('--grid-line');
      ctx.beginPath(); ctx.moveTo(s.sx, 0); ctx.lineTo(s.sx, 99999); ctx.stroke();
    }
    // Guides (golden / modular / radial).
    this.drawGuides(ctx, v, col);
    ctx.globalAlpha = 1;
  }

  drawGuides(ctx, v, col) {
    const guides = store.project.grid.guides || [];
    ctx.save();
    ctx.strokeStyle = col('--accent');
    ctx.globalAlpha = 0.22;
    ctx.setLineDash([4, 4]);
    for (const g of guides) {
      if (g.type === 'radial') {
        for (let r = 1; r <= g.rings; r++) {
          const rr = (store.project.unitsPerEm / 2) * (r / g.rings);
          const c = v.toScreen(g.cx, g.cy);
          ctx.beginPath(); ctx.arc(c.sx, c.sy, rr * v.scale, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (g.type === 'modular') {
        for (let x = 0; x <= store.project.unitsPerEm; x += g.unit) {
          const s = v.toScreen(x, 0);
          ctx.beginPath(); ctx.moveTo(s.sx, 0); ctx.lineTo(s.sx, 99999); ctx.stroke();
        }
      } else if (g.type === 'golden') {
        const cap = store.project.metrics.capHeight;
        const ys = [cap / 1.618, cap * (1 - 1 / 1.618)];
        for (const y of ys) { const s = v.toScreen(0, y); ctx.beginPath(); ctx.moveTo(0, s.sy); ctx.lineTo(99999, s.sy); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  // Choose the right reference ghost: a normal glyph gets the system-font
  // letter; an alternate traces its base glyph; a ligature traces its
  // component glyphs side by side.
  drawGhosts(ctx, v, glyph, mid, col) {
    if (glyph.ghostFrom) {
      const src = store.project.glyphs.find(g => g.name === glyph.ghostFrom);
      this.drawOutlineGhost(ctx, v, src, mid, col, 0);
    } else if (glyph.ghostComponents) {
      let ox = 0;
      for (const ch of glyph.ghostComponents) {
        const g = store.project.glyphs.find(x => x.char === ch);
        if (!g) continue;
        this.drawOutlineGhost(ctx, v, g, mid, col, ox);
        ox += g.advanceWidth;
      }
    } else {
      this.drawGhost(ctx, v, glyph, col); // system reference letter
    }
  }

  // Faint outline of another glyph (the "structure ghost"), x-offset in units.
  drawOutlineGhost(ctx, v, g, mid, col, offsetX) {
    if (!g) return;
    const layer = ensureLayer(g, mid);
    if (!layer.contours.length) return;
    ctx.save();
    ctx.beginPath();
    for (const c of layer.contours) {
      const pts = c.points; if (!pts.length) continue;
      let s = v.toScreen(pts[0].x + offsetX, pts[0].y); ctx.moveTo(s.sx, s.sy);
      const n = pts.length, segs = c.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n], bs = v.toScreen(b.x + offsetX, b.y);
        if (a.handleOut || b.handleIn) {
          const c1 = v.toScreen((a.handleOut || a).x + offsetX, (a.handleOut || a).y);
          const c2 = v.toScreen((b.handleIn || b).x + offsetX, (b.handleIn || b).y);
          ctx.bezierCurveTo(c1.sx, c1.sy, c2.sx, c2.sy, bs.sx, bs.sy);
        } else ctx.lineTo(bs.sx, bs.sy);
      }
      if (c.closed) ctx.closePath();
    }
    ctx.fillStyle = col('--accent'); ctx.globalAlpha = 0.16; ctx.fill('evenodd');
    ctx.restore();
  }

  drawGhost(ctx, v, glyph, col) {
    if (!glyph.char || glyph.char === ' ') return;
    const m = store.project.metrics;
    const base = v.toScreen(0, 0);
    // Approximate: size so cap height roughly matches metric cap height.
    const px = (m.capHeight / 0.7) * v.scale;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = col('--ghost');
    ctx.font = `${px}px "Helvetica Neue", Arial, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(glyph.char, base.sx, base.sy);
    ctx.restore();
  }

  drawContours(ctx, v, layer, col, { ghost = false, active = false } = {}) {
    if (!layer || !layer.contours.length) return;
    ctx.save();
    // Fill outline.
    ctx.beginPath();
    for (const c of layer.contours) {
      const pts = c.points; if (!pts.length) continue;
      let s = v.toScreen(pts[0].x, pts[0].y);
      ctx.moveTo(s.sx, s.sy);
      const n = pts.length, segs = c.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const hasOut = a.handleOut, hasIn = b.handleIn;
        const bs = v.toScreen(b.x, b.y);
        if (hasOut || hasIn) {
          const c1 = v.toScreen((a.handleOut || a).x, (a.handleOut || a).y);
          const c2 = v.toScreen((b.handleIn || b).x, (b.handleIn || b).y);
          ctx.bezierCurveTo(c1.sx, c1.sy, c2.sx, c2.sy, bs.sx, bs.sy);
        } else ctx.lineTo(bs.sx, bs.sy);
      }
      if (c.closed) ctx.closePath();
    }
    if (ghost) {
      // Other-master ghost: faint fill + dashed outline in the secondary accent.
      ctx.fillStyle = col('--accent-2'); ctx.globalAlpha = 0.10; ctx.fill('evenodd');
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.strokeStyle = col('--accent-2'); ctx.globalAlpha = 0.6; ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = col('--contour'); ctx.globalAlpha = 0.92; ctx.fill('evenodd');
      ctx.lineWidth = 1.2; ctx.strokeStyle = col('--accent'); ctx.globalAlpha = 0.9; ctx.stroke();
    }
    ctx.restore();

    if (ghost) return;
    // Points + handles (only when not ghost).
    const tol = 4;
    for (let ci = 0; ci < layer.contours.length; ci++) {
      const pts = layer.contours[ci].points;
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        const s = v.toScreen(p.x, p.y);
        const sel = store.ui.selection.points.some(q => q.ci === ci && q.pi === pi);
        // Handles
        for (const which of ['handleIn', 'handleOut']) {
          if (!p[which]) continue;
          const hs = v.toScreen(p[which].x, p[which].y);
          ctx.strokeStyle = col('--handle'); ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(s.sx, s.sy); ctx.lineTo(hs.sx, hs.sy); ctx.stroke();
          ctx.globalAlpha = 0.9; ctx.fillStyle = col('--handle');
          ctx.beginPath(); ctx.arc(hs.sx, hs.sy, 2.6, 0, Math.PI * 2); ctx.fill();
        }
        // On-curve point — selected anchors get a soft glow (Apple-ish detail).
        ctx.globalAlpha = 1;
        ctx.fillStyle = sel ? col('--point-sel') : col('--point');
        if (sel) { ctx.save(); ctx.shadowColor = col('--point-sel'); ctx.shadowBlur = 9; }
        if (p.type === 'smooth') {
          ctx.beginPath(); ctx.arc(s.sx, s.sy, sel ? 4.2 : 3.4, 0, Math.PI * 2); ctx.fill();
        } else {
          const r = sel ? 4 : 3.2;
          ctx.fillRect(s.sx - r, s.sy - r, r * 2, r * 2);
        }
        if (sel) {
          ctx.restore();
          // bright inner core
          ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.9;
          ctx.beginPath(); ctx.arc(s.sx, s.sy, 1.4, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  updateInfo(info, mid, glyph, v) {
    if (!glyph) { info.textContent = 'No glyph selected'; return; }
    const m = store.project.masters.find(x => x.id === mid);
    const idLabel = glyph.unicode != null
      ? 'U+' + glyph.unicode.toString(16).toUpperCase().padStart(4, '0')
      : (glyph.name || '');
    const head = glyph.char ? (glyph.char === ' ' ? 'space' : glyph.char) : (glyph.name || '');
    info.innerHTML =
      `<b>${head}</b>  ${idLabel}<br>` +
      `${m ? m.name : ''} · w ${glyph.advanceWidth}<br>` +
      `zoom ${(v.scale * 100).toFixed(0)}%`;
  }

  // ---- Grid editing (active only while Tab is held) ---------------------
  gridHit(v, pt) {
    const tolY = v.pxToWorld(6), tolX = v.pxToWorld(6);
    const m = store.project.metrics;
    const lines = [['ascender', m.ascender], ['capHeight', m.capHeight], ['xHeight', m.xHeight], ['descender', m.descender]];
    for (const [key, val] of lines) if (Math.abs(pt.y - val) <= tolY) return { kind: 'h', key };
    const verts = store.project.grid.verticals;
    for (let i = 0; i < verts.length; i++) {
      if (Math.abs(pt.x - verts[i].x) <= tolX) {
        const mid = verts.length === 2 ? (verts[i].x + verts[1 - i].x) / 2 : null;
        return { kind: 'v', idx: i, mid };
      }
    }
    return null;
  }

  handleGridDrag(g, pt) {
    if (g.kind === 'h') {
      // Metric lines move freely (baseline stays at 0).
      store.project.metrics[g.key] = Math.round(pt.y);
    } else {
      const verts = store.project.grid.verticals;
      const nx = Math.round(pt.x);
      verts[g.idx].x = nx;
      // Symmetry: keep the paired sidebearing mirrored about the fixed midpoint.
      if (g.mid != null && verts.length === 2) verts[1 - g.idx].x = Math.round(2 * g.mid - nx);
    }
  }

  // ---- Editing context passed to tools ----------------------------------
  makeEnv(mid) {
    const idx = store.ui.selectedGlyph;
    const glyph = store.project.glyphs[idx];
    return {
      store, project: store.project, glyphIndex: idx, masterId: mid,
      glyph, layer: glyph ? ensureLayer(glyph, mid) : null,
      view: this.viewports[mid],
      globals: store.ui.globals, ui: store.ui,
      tol: (px) => this.viewports[mid].pxToWorld(px),
      render: () => this.requestDraw(),
    };
  }

  // ---- Pointer handling --------------------------------------------------
  attach(canvas, mid) {
    const getPt = (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const w = this.viewports[mid].toWorld(sx, sy);
      return { sx, sy, x: w.x, y: w.y };
    };

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      store.ui.activeBoard = 'glyphboard';
      store.ui.ghostMasterId = mid;
      store.ui.activeMasterId = mid;
      store.emit('focus-changed');
      const pt = getPt(e);
      const tool = getTool(store.ui.tool);
      // Space / middle button => pan regardless of tool.
      if (e.button === 1 || (e.button === 0 && store._space)) {
        this.drag = { panning: true, lastX: e.clientX, lastY: e.clientY, mid };
        return;
      }
      // Grid editing has priority while Tab is held.
      if (store.ui.gridEditMode) {
        const g = this.gridHit(this.viewports[mid], pt);
        if (g) { store.beginGesture('Edit grid'); this.drag = { mid, gridDrag: g }; return; }
      }
      const env = this.makeEnv(mid);
      this.drag = { mid, tool };
      if (tool.onDown) tool.onDown(env, pt, e);
      this.requestDraw();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) {
        // Hover cursor hints could go here.
        return;
      }
      const pt = getPt(e);
      if (this.drag.panning) {
        const v = this.viewports[this.drag.mid];
        v.pan(e.clientX - this.drag.lastX, e.clientY - this.drag.lastY);
        this.drag.lastX = e.clientX; this.drag.lastY = e.clientY;
        this.requestDraw();
        return;
      }
      if (this.drag.gridDrag) { this.handleGridDrag(this.drag.gridDrag, pt); this.requestDraw(); return; }
      const env = this.makeEnv(this.drag.mid);
      if (this.drag.tool && this.drag.tool.onMove) this.drag.tool.onMove(env, pt, e);
      this.requestDraw();
    });

    const end = (e) => {
      if (!this.drag) return;
      if (!this.drag.panning && this.drag.tool && this.drag.tool.onUp) {
        const pt = getPt(e);
        this.drag.tool.onUp(this.makeEnv(this.drag.mid), pt, e);
      }
      this.drag = null;
      store.notify('edit');
      this.requestDraw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const v = this.viewports[mid];
      if (e.ctrlKey || e.metaKey) {
        v.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.08 : 0.926);
      } else {
        v.pan(-e.deltaX, -e.deltaY);
      }
      this.requestDraw();
    }, { passive: false });
  }
}

// Interpolate two compatible layers (equal structure) for variable preview.
function interpolateLayer(a, b, t) {
  if (!a || !b || a.contours.length !== b.contours.length) return null;
  const lerp = (p, q) => p + (q - p) * t;
  const contours = [];
  for (let i = 0; i < a.contours.length; i++) {
    const ca = a.contours[i], cb = b.contours[i];
    if (ca.points.length !== cb.points.length) return null;
    const points = ca.points.map((pa, j) => {
      const pb = cb.points[j];
      const h = (ka, kb) => (ka && kb) ? { x: lerp(ka.x, kb.x), y: lerp(ka.y, kb.y) } : null;
      return { x: lerp(pa.x, pb.x), y: lerp(pa.y, pb.y), type: pa.type,
        handleIn: h(pa.handleIn, pb.handleIn), handleOut: h(pa.handleOut, pb.handleOut) };
    });
    contours.push({ closed: ca.closed, points });
  }
  return { contours };
}

export const glyphboard = new Glyphboard();
