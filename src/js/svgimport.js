import { makePoint } from './geometry.js';
import { uid } from './store.js';

// Parse an SVG document into editable shapes (lists of contours).
// .ai and modern .eps files are frequently PDF/SVG-compatible; for .ai we
// attempt to extract embedded SVG/XML, falling back gracefully.
export function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) return [];

  // Determine a flip height from viewBox/height so shapes come in y-up.
  let vbH = 1000;
  const vb = svg.getAttribute('viewBox');
  if (vb) { const p = vb.trim().split(/[\s,]+/).map(Number); if (p.length === 4) vbH = p[3]; }
  else if (svg.getAttribute('height')) vbH = parseFloat(svg.getAttribute('height')) || vbH;
  const fy = (y) => vbH - y;

  const shapes = [];
  const pushShape = (contours) => {
    if (contours.length) shapes.push({ id: uid('shape'), contours });
  };

  svg.querySelectorAll('path').forEach(el => {
    const d = el.getAttribute('d');
    if (d) pushShape(parsePathData(d, fy));
  });
  svg.querySelectorAll('rect').forEach(el => {
    const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0;
    const w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0;
    pushShape([{ closed: true, points: [
      makePoint(x, fy(y)), makePoint(x + w, fy(y)),
      makePoint(x + w, fy(y + h)), makePoint(x, fy(y + h)),
    ] }]);
  });
  svg.querySelectorAll('circle, ellipse').forEach(el => {
    const cx = +el.getAttribute('cx') || 0, cy = +el.getAttribute('cy') || 0;
    const rx = +(el.getAttribute('rx') || el.getAttribute('r')) || 0;
    const ry = +(el.getAttribute('ry') || el.getAttribute('r')) || 0;
    const k = 0.5523;
    const p = (x, y, hi, ho) => { const pt = makePoint(x, y, 'smooth'); pt.handleIn = hi; pt.handleOut = ho; return pt; };
    pushShape([{ closed: true, points: [
      p(cx + rx, fy(cy), { x: cx + rx, y: fy(cy - ry * k) }, { x: cx + rx, y: fy(cy + ry * k) }),
      p(cx, fy(cy + ry), { x: cx + rx * k, y: fy(cy + ry) }, { x: cx - rx * k, y: fy(cy + ry) }),
      p(cx - rx, fy(cy), { x: cx - rx, y: fy(cy + ry * k) }, { x: cx - rx, y: fy(cy - ry * k) }),
      p(cx, fy(cy - ry), { x: cx - rx * k, y: fy(cy - ry) }, { x: cx + rx * k, y: fy(cy - ry) }),
    ] }]);
  });
  svg.querySelectorAll('polygon, polyline').forEach(el => {
    const raw = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < raw.length; i += 2) pts.push(makePoint(raw[i], fy(raw[i + 1])));
    if (pts.length) pushShape([{ closed: el.tagName.toLowerCase() === 'polygon', points: pts }]);
  });

  return shapes;
}

// Tokenize + interpret SVG path data into contours (cubic-only internally).
function parsePathData(d, fy) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);
  const contours = [];
  let cur = null;
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let prevCtrl = null; // for S/T smooth commands

  const open = (x, y) => { cur = { closed: false, points: [makePoint(x, fy(y))] }; contours.push(cur); startX = x; startY = y; };
  const lineTo = (x, y) => { cur.points.push(makePoint(x, fy(y))); };
  const curveTo = (x1, y1, x2, y2, x, y) => {
    const last = cur.points[cur.points.length - 1];
    last.handleOut = { x: x1, y: fy(y1) };
    const p = makePoint(x, fy(y), 'smooth');
    p.handleIn = { x: x2, y: fy(y2) };
    cur.points.push(p);
  };

  let cmd = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        open(x, y); cx = x; cy = y; cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { let x = num(), y = num(); if (rel) { x += cx; y += cy; } lineTo(x, y); cx = x; cy = y; break; }
      case 'H': { let x = num(); if (rel) x += cx; lineTo(x, cy); cx = x; break; }
      case 'V': { let y = num(); if (rel) y += cy; lineTo(cx, y); cy = y; break; }
      case 'C': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        curveTo(x1, y1, x2, y2, x, y); prevCtrl = { x: x2, y: y2 }; cx = x; cy = y;
        break;
      }
      case 'S': {
        let x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
        const x1 = prevCtrl ? 2 * cx - prevCtrl.x : cx, y1 = prevCtrl ? 2 * cy - prevCtrl.y : cy;
        curveTo(x1, y1, x2, y2, x, y); prevCtrl = { x: x2, y: y2 }; cx = x; cy = y;
        break;
      }
      case 'Q': {
        let qx = num(), qy = num(), x = num(), y = num();
        if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
        // quadratic -> cubic
        const x1 = cx + 2 / 3 * (qx - cx), y1 = cy + 2 / 3 * (qy - cy);
        const x2 = x + 2 / 3 * (qx - x), y2 = y + 2 / 3 * (qy - y);
        curveTo(x1, y1, x2, y2, x, y); prevCtrl = { x: qx, y: qy }; cx = x; cy = y;
        break;
      }
      case 'Z': { if (cur) cur.closed = true; cx = startX; cy = startY; i; break; }
      default: i++; break; // skip unsupported (A arc etc.)
    }
  }
  return contours.filter(c => c.points.length > 1);
}
