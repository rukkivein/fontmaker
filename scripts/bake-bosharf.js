'use strict';
// One-shot: convert cep/assets/bosharf.svg (the "boş harf" / empty-letter mark,
// 138 sub-paths incl. arcs) into the panel's contour model, in 1000-UPM font
// units sitting on the baseline. Writes shared/bosharf.json, which the export
// path injects into every undrawn glyph slot in the free edition.
//
// Self-contained SVG path parser (M/L/H/V/C/S/Q/T/A/Z, abs+rel, arcs→cubics) so
// it runs anywhere — paper-core needs a canvas/DOM and won't load headless.
// Re-run after editing bosharf.svg:  node scripts/bake-bosharf.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---- SVG path -> segment list (arc flags read as single 0/1) ----------------
function parsePath(d) {
  let i = 0; const len = d.length; const out = []; let cmd = '';
  const counts = { M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0 };
  const skip = () => { while (i < len && /[\s,]/.test(d[i])) i++; };
  function num() {
    skip(); const s = i;
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < len && d[i] >= '0' && d[i] <= '9') i++;
    if (d[i] === '.') { i++; while (i < len && d[i] >= '0' && d[i] <= '9') i++; }
    if (d[i] === 'e' || d[i] === 'E') { i++; if (d[i] === '+' || d[i] === '-') i++; while (i < len && d[i] >= '0' && d[i] <= '9') i++; }
    return parseFloat(d.slice(s, i));
  }
  function flag() { skip(); const c = d[i]; i++; return c === '1' ? 1 : 0; }
  while (i < len) {
    skip(); if (i >= len) break;
    if (/[a-zA-Z]/.test(d[i])) { cmd = d[i]; i++; }
    const up = cmd.toUpperCase(); const rel = cmd !== up;
    if (up === 'Z') { out.push({ c: 'Z', rel, p: [] }); continue; }
    const n = counts[up]; const p = [];
    for (let k = 0; k < n; k++) {
      if (up === 'A' && (k === 3 || k === 4)) p.push(flag());
      else p.push(num());
    }
    out.push({ c: up, rel, p });
    if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';  // implicit lineto
  }
  return out;
}

// ---- endpoint-arc -> cubic bezier segments ----------------------------------
function arcToCubics(x0, y0, rx, ry, phiDeg, fa, fs, x, y) {
  if (rx === 0 || ry === 0) return [[x0, y0, x, y, x, y]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = fa === fs ? -1 : 1;
  let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  num = num < 0 ? 0 : num;
  const co = sign * Math.sqrt(num / den);
  const cx1 = co * rx * y1 / ry, cy1 = -co * ry * x1 / rx;
  const cx = cp * cx1 - sp * cy1 + (x0 + x) / 2, cy = sp * cx1 + cp * cy1 + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, l = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot / l)));
    if (ux * vy - uy * vx < 0) a = -a; return a;
  };
  let th1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dth = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI;
  if (fs && dth < 0) dth += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const out = []; const delta = dth / segs;
  const t = 4 / 3 * Math.tan(delta / 4);
  let a0 = th1, sx = x0, sy = y0;
  for (let s = 0; s < segs; s++) {
    const a1 = a0 + delta;
    const cos0 = Math.cos(a0), sin0 = Math.sin(a0), cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    const e1x = cp * rx * cos1 - sp * ry * sin1 + cx, e1y = sp * rx * cos1 + cp * ry * sin1 + cy;
    const c1x = sx + (-(cp * rx * sin0) - sp * ry * cos0) * t, c1y = sy + (-(sp * rx * sin0) + cp * ry * cos0) * t;
    const c2x = e1x - (-(cp * rx * sin1) - sp * ry * cos1) * t, c2y = e1y - (-(sp * rx * sin1) + cp * ry * cos1) * t;
    out.push([c1x, c1y, c2x, c2y, e1x, e1y]);
    a0 = a1; sx = e1x; sy = e1y;
  }
  return out;
}

// ---- segments -> contours (absolute coords, cubic handles on the points) ----
function P(x, y) { return { x, y, type: 'corner', handleIn: null, handleOut: null }; }
function toContours(d) {
  const segs = parsePath(d);
  const contours = []; let cur = null;
  let cx = 0, cy = 0, sx = 0, sy = 0, pcx = null, pcy = null, lastC = '';
  const cubic = (x1, y1, x2, y2, x, y) => {
    const prev = cur.points[cur.points.length - 1];
    prev.handleOut = { x: x1, y: y1 };
    const np = P(x, y); np.handleIn = { x: x2, y: y2 };
    cur.points.push(np); cx = x; cy = y;
  };
  for (const s of segs) {
    const p = s.p, rel = s.rel, ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (s.c) {
      case 'M': {
        cx = p[0] + ox; cy = p[1] + oy; sx = cx; sy = cy;
        cur = { closed: false, points: [P(cx, cy)] }; contours.push(cur);
        break;
      }
      case 'L': cur.points.push(P(p[0] + ox, p[1] + oy)); cx = p[0] + ox; cy = p[1] + oy; break;
      case 'H': cur.points.push(P(p[0] + (rel ? cx : 0), cy)); cx = p[0] + (rel ? cx : 0); break;
      case 'V': cur.points.push(P(cx, p[0] + (rel ? cy : 0))); cy = p[0] + (rel ? cy : 0); break;
      case 'C': cubic(p[0] + ox, p[1] + oy, p[2] + ox, p[3] + oy, p[4] + ox, p[5] + oy);
        pcx = p[2] + ox; pcy = p[3] + oy; break;
      case 'S': {
        const r1x = (lastC === 'C' || lastC === 'S') ? 2 * cx - pcx : cx;
        const r1y = (lastC === 'C' || lastC === 'S') ? 2 * cy - pcy : cy;
        cubic(r1x, r1y, p[0] + ox, p[1] + oy, p[2] + ox, p[3] + oy);
        pcx = p[0] + ox; pcy = p[1] + oy; break;
      }
      case 'Q': {
        const qx = p[0] + ox, qy = p[1] + oy, ex = p[2] + ox, ey = p[3] + oy;
        cubic(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey);
        pcx = qx; pcy = qy; break;
      }
      case 'T': {
        const qx = (lastC === 'Q' || lastC === 'T') ? 2 * cx - pcx : cx;
        const qy = (lastC === 'Q' || lastC === 'T') ? 2 * cy - pcy : cy;
        const ex = p[0] + ox, ey = p[1] + oy;
        cubic(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey);
        pcx = qx; pcy = qy; break;
      }
      case 'A': {
        const ex = p[5] + ox, ey = p[6] + oy;
        arcToCubics(cx, cy, p[0], p[1], p[2], p[3], p[4], ex, ey).forEach(c => cubic(c[0], c[1], c[2], c[3], c[4], c[5]));
        break;
      }
      case 'Z': {
        if (cur) {
          cur.closed = true;
          const lp = cur.points[cur.points.length - 1], fp = cur.points[0];
          if (cur.points.length > 1 && Math.abs(lp.x - fp.x) < 0.01 && Math.abs(lp.y - fp.y) < 0.01) { fp.handleIn = lp.handleIn; cur.points.pop(); }
        }
        cx = sx; cy = sy;
        break;
      }
    }
    lastC = s.c;
  }
  return contours.filter(c => c.points.length >= 2);
}

// ---- main -------------------------------------------------------------------
const svg = fs.readFileSync(path.join(ROOT, 'cep/assets/bosharf.svg'), 'utf8');
const ds = [];
svg.replace(/<path\b[^>]*\bd="([^"]*)"/g, (_, d) => { ds.push(d); return _; });
console.log('paths:', ds.length);

let contours = [];
ds.forEach(d => { contours = contours.concat(toContours(d)); });

// overall bounds across every point + handle
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const eat = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
contours.forEach(c => c.points.forEach(p => { eat(p.x, p.y); if (p.handleIn) eat(p.handleIn.x, p.handleIn.y); if (p.handleOut) eat(p.handleOut.x, p.handleOut.y); }));
const artW = maxX - minX, artH = maxY - minY;

// fit into a cap-tall, em-wide box on the baseline; SVG is y-down → flip
const TARGET_H = 700, TARGET_W = 920, SIDE = 45;
const s = Math.min(TARGET_H / artH, TARGET_W / artW);
const fx = (x) => +( (x - minX) * s + SIDE ).toFixed(2);
const fy = (y) => +( (maxY - y) * s ).toFixed(2);
const mapPt = (p) => ({
  x: fx(p.x), y: fy(p.y), type: p.type,
  handleIn: p.handleIn ? { x: fx(p.handleIn.x), y: fy(p.handleIn.y) } : null,
  handleOut: p.handleOut ? { x: fx(p.handleOut.x), y: fy(p.handleOut.y) } : null,
});
const outContours = contours.map(c => ({ closed: c.closed !== false, points: c.points.map(mapPt) }));
const advanceWidth = Math.round(artW * s + 2 * SIDE);
const totalPts = outContours.reduce((n, c) => n + c.points.length, 0);

const json = { source: 'bosharf.svg', upm: 1000, advanceWidth, contours: outContours };
fs.writeFileSync(path.join(ROOT, 'shared/bosharf.json'), JSON.stringify(json));
console.log('contours:', outContours.length, 'points:', totalPts,
  'art:', Math.round(artW) + 'x' + Math.round(artH), 'scale:', s.toFixed(4),
  'advance:', advanceWidth, '\nwrote shared/bosharf.json',
  (fs.statSync(path.join(ROOT, 'shared/bosharf.json')).size / 1024).toFixed(0) + 'KB');
