import { store } from './store.js';
import {
  hitPoint, hitHandle, makeRect, makeCircle, makeRoundRect, cubicPoint, smoothPoint,
} from './geometry.js';
import { propagateToLinked } from './project.js';

// Per-tool persistent control values.
export function toolState(id) {
  if (!store.ui.toolState[id]) store.ui.toolState[id] = defaultState(id);
  return store.ui.toolState[id];
}
function defaultState(id) {
  switch (id) {
    case 'position': return { mode: 'move' };
    case 'point': return { transform: false };
    case 'area': return { shape: 'square' };
    case 'brush': return { size: 90, hardness: 50, optimize: 40 };
    case 'pinmesh': return { polygons: 16, optimize: 50, pins: {} };
    case 'simplify': return { size: 80, hardness: 60, amount: 50 };
    case 'addshape': return { shape: 'rect', rounded: 0 };
    case 'axis': return { chain: true };
    default: return {};
  }
}

// ---- Shared selection / movement helpers --------------------------------
function selHas(ci, pi) { return store.ui.selection.points.some(q => q.ci === ci && q.pi === pi); }
function setSel(list) { store.ui.selection.points = list; }
function addSel(ci, pi) { if (!selHas(ci, pi)) store.ui.selection.points.push({ ci, pi }); }

function moveSelected(env, dx, dy) {
  const { layer } = env;
  for (const { ci, pi } of store.ui.selection.points) {
    const p = layer.contours[ci] && layer.contours[ci].points[pi];
    if (!p) continue;
    p.x += dx; p.y += dy;
    if (p.handleIn) { p.handleIn.x += dx; p.handleIn.y += dy; }
    if (p.handleOut) { p.handleOut.x += dx; p.handleOut.y += dy; }
  }
  if (env.globals.linkMasters) {
    propagateToLinked(env.project, env.glyphIndex, env.masterId, (otherLayer) => {
      for (const { ci, pi } of store.ui.selection.points) {
        const p = otherLayer.contours[ci] && otherLayer.contours[ci].points[pi];
        if (!p) continue;
        p.x += dx; p.y += dy;
        if (p.handleIn) { p.handleIn.x += dx; p.handleIn.y += dy; }
        if (p.handleOut) { p.handleOut.x += dx; p.handleOut.y += dy; }
      }
    });
  }
}

function addShapeToLayer(env, contour) {
  env.layer.contours.push(contour);
  if (env.globals.linkMasters) {
    propagateToLinked(env.project, env.glyphIndex, env.masterId,
      (other) => other.contours.push(JSON.parse(JSON.stringify(contour))));
  }
}

// nearest point on outline within radius (returns {ci,pi,dist} for closest pt)
function pointsInRadius(layer, x, y, r) {
  const out = [];
  for (let ci = 0; ci < layer.contours.length; ci++) {
    const pts = layer.contours[ci].points;
    for (let pi = 0; pi < pts.length; pi++) {
      const d = Math.hypot(pts[pi].x - x, pts[pi].y - y);
      if (d <= r) out.push({ ci, pi, d });
    }
  }
  return out;
}

// ---- TOOL DEFINITIONS ----------------------------------------------------
const TOOLS = {};

// POSITION — navigate the board (pan / rotate) + reset.
TOOLS.position = {
  id: 'position', label: 'Position', icon: '✥',
  controls: () => {
    const st = toolState('position');
    return [
      { type: 'segmented', label: 'Mode', value: st.mode, options: [['move', 'Move'], ['rotate', 'Rotate']],
        onChange: v => { st.mode = v; } },
      { type: 'button', label: ' ', text: 'Reset View',
        onClick: (env) => { if (env && env.view) { env.view.fit(env._w || 800, env._h || 600, env.project.metrics, env.glyph ? env.glyph.advanceWidth : 600); env.render(); } } },
    ];
  },
  onDown(env, pt, e) { this._last = { x: e.clientX, y: e.clientY }; this._start = pt; },
  onMove(env, pt, e) {
    const st = toolState('position');
    if (st.mode === 'rotate') {
      env.view.angle += (e.clientX - this._last.x) * 0.004;
    } else {
      env.view.pan(e.clientX - this._last.x, e.clientY - this._last.y);
    }
    this._last = { x: e.clientX, y: e.clientY };
  },
  onUp() { this._last = null; },
};

// POINT — select & move on-curve points; optional transform box; invert.
TOOLS.point = {
  id: 'point', label: 'Point', icon: '✦',
  controls: () => {
    const st = toolState('point');
    return [
      { type: 'toggle', label: 'Transform', value: st.transform, text: 'Show Transform Controls',
        onChange: v => { st.transform = v; store.notify('ui'); } },
      { type: 'button', label: ' ', text: 'Invert Selection',
        onClick: (env) => {
          if (!env || !env.layer) return;
          const all = [];
          env.layer.contours.forEach((c, ci) => c.points.forEach((_, pi) => { if (!selHas(ci, pi)) all.push({ ci, pi }); }));
          setSel(all); env.render(); store.notify('ui');
        } },
    ];
  },
  onDown(env, pt, e) {
    const tol = env.tol(7);
    const hit = hitPoint(env.layer, pt.x, pt.y, tol);
    if (hit) {
      if (e.shiftKey) addSel(hit.ci, hit.pi);
      else if (!selHas(hit.ci, hit.pi)) setSel([{ ci: hit.ci, pi: hit.pi }]);
      store.beginGesture('Move points');
      this._moving = true; this._last = pt;
    } else {
      if (!e.shiftKey) setSel([]);
      this._moving = false;
    }
    store.notify('ui');
  },
  onMove(env, pt) {
    if (!this._moving) return;
    moveSelected(env, pt.x - this._last.x, pt.y - this._last.y);
    this._last = pt;
  },
  onUp() { this._moving = false; },
  onRender(ctx, env, { col }) {
    const st = toolState('point');
    if (!st.transform || !store.ui.selection.points.length) return;
    // Draw a bounding box around selected points (Photoshop-like handles).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { ci, pi } of store.ui.selection.points) {
      const p = env.layer.contours[ci].points[pi];
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const a = env.view.toScreen(minX, maxY), b = env.view.toScreen(maxX, minY);
    ctx.save();
    ctx.strokeStyle = col('--accent'); ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
    ctx.setLineDash([]); ctx.fillStyle = col('--bg-3'); ctx.strokeStyle = col('--accent');
    for (const cx of [a.sx, (a.sx + b.sx) / 2, b.sx]) for (const cy of [a.sy, (a.sy + b.sy) / 2, b.sy]) {
      ctx.beginPath(); ctx.rect(cx - 3, cy - 3, 6, 6); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },
};

// AREA SELECT — marquee (square) or lasso selection of points.
TOOLS.area = {
  id: 'area', label: 'Area Select', icon: '▦',
  controls: () => {
    const st = toolState('area');
    return [{ type: 'segmented', label: 'Mode', value: st.shape,
      options: [['square', 'Square'], ['lasso', 'Lasso']], onChange: v => { st.shape = v; } }];
  },
  onDown(env, pt, e) { this._start = pt; this._path = [pt]; this._add = e.shiftKey; this._active = true; },
  onMove(env, pt) { if (this._active) { this._cur = pt; this._path.push(pt); env.render(); } },
  onUp(env, pt) {
    if (!this._active) return;
    const st = toolState('area');
    const found = [];
    env.layer.contours.forEach((c, ci) => c.points.forEach((p, pi) => {
      const inside = st.shape === 'square'
        ? (p.x >= Math.min(this._start.x, pt.x) && p.x <= Math.max(this._start.x, pt.x) &&
           p.y >= Math.min(this._start.y, pt.y) && p.y <= Math.max(this._start.y, pt.y))
        : pointInPolygon(p, this._path);
      if (inside) found.push({ ci, pi });
    }));
    setSel(this._add ? store.ui.selection.points.concat(found) : found);
    this._active = false; this._cur = null; this._path = null;
    store.notify('ui'); env.render();
  },
  onRender(ctx, env, { col }) {
    if (!this._active || !this._cur) return;
    const st = toolState('area');
    ctx.save(); ctx.strokeStyle = col('--accent'); ctx.fillStyle = col('--accent-soft');
    ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    if (st.shape === 'square') {
      const a = env.view.toScreen(this._start.x, this._start.y), b = env.view.toScreen(this._cur.x, this._cur.y);
      ctx.fillRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
      ctx.strokeRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
    } else {
      ctx.beginPath();
      this._path.forEach((p, i) => { const s = env.view.toScreen(p.x, p.y); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      ctx.stroke(); ctx.fill();
    }
    ctx.restore();
  },
};

// BRUSH — liquify-style deformation (push points in drag direction).
TOOLS.brush = {
  id: 'brush', label: 'Brush (Liquify)', icon: '❍',
  controls: () => {
    const st = toolState('brush');
    return [
      { type: 'slider', label: 'Size', min: 10, max: 400, value: st.size, onChange: v => st.size = v },
      { type: 'slider', label: 'Hardness', min: 0, max: 100, value: st.hardness, onChange: v => st.hardness = v },
      { type: 'slider', label: 'Add Points', min: 0, max: 100, value: st.optimize, onChange: v => st.optimize = v },
    ];
  },
  onDown(env, pt, e) { store.beginGesture('Liquify'); this._last = pt; this._down = true; this._cursor = pt; },
  onMove(env, pt) {
    if (!this._down) return;
    const st = toolState('brush');
    const r = st.size; const dx = pt.x - this._last.x, dy = pt.y - this._last.y;
    maybeSubdivideUnder(env.layer, pt, r, st.optimize);
    for (const { ci, pi, d } of pointsInRadius(env.layer, pt.x, pt.y, r)) {
      const p = env.layer.contours[ci].points[pi];
      const fall = falloff(d / r, st.hardness);
      p.x += dx * fall; p.y += dy * fall;
      if (p.handleIn) { p.handleIn.x += dx * fall; p.handleIn.y += dy * fall; }
      if (p.handleOut) { p.handleOut.x += dx * fall; p.handleOut.y += dy * fall; }
    }
    this._last = pt; this._cursor = pt;
  },
  onUp() { this._down = false; },
  onRender(ctx, env, { col }) { drawBrushRing(ctx, env, this._cursor, toolState('brush').size, col); },
};

// PIN MESH — After-Effects-style puppet pins; drag deforms weighted points.
TOOLS.pinmesh = {
  id: 'pinmesh', label: 'Pin Mesh', icon: '⊹',
  controls: () => {
    const st = toolState('pinmesh');
    return [
      { type: 'slider', label: 'Polygons', min: 4, max: 64, value: st.polygons, onChange: v => st.polygons = v },
      { type: 'slider', label: 'Add Points', min: 0, max: 100, value: st.optimize, onChange: v => st.optimize = v },
      { type: 'button', label: ' ', text: 'Clear Pins', onClick: (env) => { toolState('pinmesh').pins = {}; env && env.render(); } },
    ];
  },
  pinsFor(env) {
    const st = toolState('pinmesh');
    const key = env.glyphIndex + ':' + env.masterId;
    if (!st.pins[key]) st.pins[key] = [];
    return st.pins[key];
  },
  onDown(env, pt) {
    const pins = this.pinsFor(env);
    const tol = env.tol(10);
    const idx = pins.findIndex(pn => Math.hypot(pn.x - pt.x, pn.y - pt.y) <= tol);
    if (idx >= 0) { store.beginGesture('Warp'); this._drag = idx; this._last = pt; }
    else { store.commit('Add pin', () => {}); pins.push({ x: pt.x, y: pt.y }); env.render(); }
  },
  onMove(env, pt) {
    if (this._drag == null) return;
    const pins = this.pinsFor(env);
    const dx = pt.x - this._last.x, dy = pt.y - this._last.y;
    const pin = pins[this._drag];
    // Influence radius derived from polygon density.
    const st = toolState('pinmesh');
    const r = env.project.unitsPerEm / Math.max(2, st.polygons) * 4;
    for (const c of env.layer.contours) for (const p of c.points) {
      const d = Math.hypot(p.x - pin.x, p.y - pin.y);
      const w = d < r ? Math.pow(1 - d / r, 2) : 0;
      if (w <= 0) continue;
      p.x += dx * w; p.y += dy * w;
      if (p.handleIn) { p.handleIn.x += dx * w; p.handleIn.y += dy * w; }
      if (p.handleOut) { p.handleOut.x += dx * w; p.handleOut.y += dy * w; }
    }
    pin.x += dx; pin.y += dy; this._last = pt;
  },
  onUp() { this._drag = null; },
  onRender(ctx, env, { col }) {
    const pins = this.pinsFor(env);
    ctx.save();
    for (const pn of pins) {
      const s = env.view.toScreen(pn.x, pn.y);
      ctx.fillStyle = col('--accent-2'); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.sx, s.sy, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },
};

// SIMPLIFY BRUSH — within radius, smooth corners & remove redundant points.
TOOLS.simplify = {
  id: 'simplify', label: 'Simplify Brush', icon: '⌇',
  controls: () => {
    const st = toolState('simplify');
    return [
      { type: 'slider', label: 'Size', min: 10, max: 400, value: st.size, onChange: v => st.size = v },
      { type: 'slider', label: 'Hardness', min: 0, max: 100, value: st.hardness, onChange: v => st.hardness = v },
      { type: 'slider', label: 'Amount', min: 0, max: 100, value: st.amount, onChange: v => st.amount = v },
    ];
  },
  onDown(env, pt) { store.beginGesture('Simplify'); this._down = true; this._cursor = pt; this.apply(env, pt); },
  onMove(env, pt) { if (this._down) { this._cursor = pt; this.apply(env, pt); } },
  onUp() { this._down = false; },
  apply(env, pt) {
    const st = toolState('simplify');
    const r = st.size;
    const strength = st.amount / 100;
    for (const c of env.layer.contours) {
      // Smooth points under the brush.
      for (let pi = 0; pi < c.points.length; pi++) {
        const p = c.points[pi];
        if (Math.hypot(p.x - pt.x, p.y - pt.y) > r) continue;
        smoothPoint(c, pi, 0.16 + 0.25 * strength * falloff(Math.hypot(p.x - pt.x, p.y - pt.y) / r, st.hardness));
      }
      // Remove near-collinear redundant points when amount is high.
      if (strength > 0.5 && c.points.length > 4) {
        for (let pi = c.points.length - 1; pi >= 0; pi--) {
          const n = c.points.length;
          const prev = c.points[(pi - 1 + n) % n], cur = c.points[pi], next = c.points[(pi + 1) % n];
          if (Math.hypot(cur.x - pt.x, cur.y - pt.y) > r) continue;
          const area = Math.abs((next.x - prev.x) * (cur.y - prev.y) - (cur.x - prev.x) * (next.y - prev.y));
          if (area < 800 * strength && c.points.length > 4) c.points.splice(pi, 1);
        }
      }
    }
  },
  onRender(ctx, env, { col }) { drawBrushRing(ctx, env, this._cursor, toolState('simplify').size, col); },
};

// ADD SHAPE — drag to draw a rectangle (optionally rounded) or ellipse.
TOOLS.addshape = {
  id: 'addshape', label: 'Add Shape', icon: '◻',
  controls: () => {
    const st = toolState('addshape');
    const c = [
      { type: 'segmented', label: 'Shape', value: st.shape,
        options: [['rect', 'Rectangle'], ['circle', 'Ellipse']], onChange: v => { st.shape = v; store.notify('ui'); } },
    ];
    if (st.shape === 'rect')
      c.push({ type: 'slider', label: 'Rounded', min: 0, max: 100, value: st.rounded, onChange: v => st.rounded = v });
    return c;
  },
  onDown(env, pt) { this._start = pt; this._cur = pt; this._active = true; },
  onMove(env, pt) { if (this._active) { this._cur = pt; env.render(); } },
  onUp(env, pt) {
    if (!this._active) return;
    this._active = false;
    const st = toolState('addshape');
    const x = Math.min(this._start.x, pt.x), y = Math.min(this._start.y, pt.y);
    const w = Math.abs(pt.x - this._start.x), h = Math.abs(pt.y - this._start.y);
    if (w < 5 || h < 5) { env.render(); return; }
    let contour;
    if (st.shape === 'circle') contour = makeCircle(x + w / 2, y + h / 2, Math.min(w, h) / 2);
    else if (st.rounded > 0) contour = makeRoundRect(x, y, w, h, (st.rounded / 100) * Math.min(w, h) / 2);
    else contour = makeRect(x, y, w, h);
    store.commit('Add shape', () => {});
    addShapeToLayer(env, contour);
    env.render();
  },
  onRender(ctx, env, { col }) {
    if (!this._active) return;
    const a = env.view.toScreen(this._start.x, this._start.y), b = env.view.toScreen(this._cur.x, this._cur.y);
    ctx.save(); ctx.strokeStyle = col('--accent'); ctx.fillStyle = col('--accent-soft'); ctx.setLineDash([5, 3]);
    const st = toolState('addshape');
    if (st.shape === 'circle') { ctx.beginPath(); ctx.ellipse((a.sx + b.sx) / 2, (a.sy + b.sy) / 2, Math.abs(b.sx - a.sx) / 2, Math.abs(b.sy - a.sy) / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy); ctx.strokeRect(a.sx, a.sy, b.sx - a.sx, b.sy - a.sy); }
    ctx.restore();
  },
};

// AXIS — edit bezier handles (Illustrator-style), with optional chain/mirror.
TOOLS.axis = {
  id: 'axis', label: 'Axis (Curves)', icon: '〵',
  controls: () => {
    const st = toolState('axis');
    return [{ type: 'toggle', label: 'Handles', value: st.chain, text: 'Chain (mirror handles)',
      onChange: v => { st.chain = v; } }];
  },
  onDown(env, pt) {
    const tol = env.tol(8);
    const h = hitHandle(env.layer, pt.x, pt.y, tol);
    if (h) { store.beginGesture('Edit handle'); this._h = h; return; }
    // Click on an on-curve point with no handles: extrude handles from it.
    const p = hitPoint(env.layer, pt.x, pt.y, tol);
    if (p) {
      store.beginGesture('Add handle');
      const pt2 = env.layer.contours[p.ci].points[p.pi];
      if (!pt2.handleOut) pt2.handleOut = { x: pt2.x + 40, y: pt2.y };
      if (!pt2.handleIn) pt2.handleIn = { x: pt2.x - 40, y: pt2.y };
      pt2.type = 'smooth';
      this._h = { ci: p.ci, pi: p.pi, which: 'handleOut' };
    }
  },
  onMove(env, pt) {
    if (!this._h) return;
    const st = toolState('axis');
    const p = env.layer.contours[this._h.ci].points[this._h.pi];
    p[this._h.which] = { x: pt.x, y: pt.y };
    if (st.chain) {
      const other = this._h.which === 'handleOut' ? 'handleIn' : 'handleOut';
      p[other] = { x: 2 * p.x - pt.x, y: 2 * p.y - pt.y }; // mirror through anchor
    }
  },
  onUp() { this._h = null; },
};

// ---- helpers -------------------------------------------------------------
function falloff(t, hardness) {
  t = Math.max(0, Math.min(1, t));
  const h = hardness / 100;
  // hard core then smooth edge
  const soft = Math.cos(t * Math.PI) * 0.5 + 0.5; // 1..0
  return Math.max(0, h * (t < h ? 1 : soft) + (1 - h) * soft);
}
function drawBrushRing(ctx, env, cursor, size, col) {
  if (!cursor) return;
  const c = env.view.toScreen(cursor.x, cursor.y);
  ctx.save(); ctx.strokeStyle = col('--accent'); ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(c.sx, c.sy, size * env.view.scale, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
function maybeSubdivideUnder(layer, pt, r, optimize) {
  if (optimize <= 0) return;
  const maxLen = (1 - optimize / 100) * 300 + 40; // higher optimize => shorter allowed segs
  for (const c of layer.contours) {
    for (let i = c.points.length - 1; i >= 0; i--) {
      const n = c.points.length;
      const a = c.points[i], b = c.points[(i + 1) % n];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(mid.x - pt.x, mid.y - pt.y) > r) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > maxLen && c.points.length < 200) {
        const c1 = a.handleOut || a, c2 = b.handleIn || b;
        const np = cubicPoint(a, c1, c2, b, 0.5);
        c.points.splice(i + 1, 0, { x: np.x, y: np.y, type: 'smooth', handleIn: null, handleOut: null });
      }
    }
  }
}
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function getTool(id) { return TOOLS[id] || TOOLS.position; }
export const TOOL_ORDER = ['position', 'point', 'area', null, 'brush', 'pinmesh', 'simplify', 'addshape', 'axis'];
export { TOOLS };
