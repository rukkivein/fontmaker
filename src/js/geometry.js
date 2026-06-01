// Geometry helpers shared by the editor, renderer and exporter.
// Coordinate space is font units, y-up (baseline = 0).

export function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// Shoelace signed area over on-curve points (y-up): >0 = counter-clockwise.
export function signedArea(contour) {
  const p = contour.points; let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return a / 2;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Even-odd hit test for a whole shape (so clicks inside a counter miss it).
export function pointInShape(shape, x, y) {
  let count = 0;
  for (const c of shape.contours) if (c.points.length >= 3 && pointInPolygon(x, y, c.points)) count++;
  return count % 2 === 1;
}

// Break a compound outline into separate pieces: each outer contour plus the
// holes nested inside it becomes one piece. This is the "release compound path"
// that lets a single imported word (e.g. "glypho") split into per-letter shapes
// you can drag onto glyphs individually.
export function breakApart(contours) {
  if (contours.length <= 1) return [{ contours: contours.map(cloneC) }];
  const polys = contours.map(c => c.points);
  const depth = contours.map((c, i) => {
    let d = 0; const s = c.points[0];
    for (let j = 0; j < contours.length; j++) {
      if (j === i || contours[j].points.length < 3) continue;
      if (pointInPolygon(s.x, s.y, polys[j])) d++;
    }
    return d;
  });
  const pieces = [];
  const outerToPiece = new Map();
  contours.forEach((c, i) => {
    if (depth[i] % 2 === 0) { outerToPiece.set(i, pieces.length); pieces.push({ contours: [cloneC(c)] }); }
  });
  contours.forEach((c, i) => {
    if (depth[i] % 2 === 0) return; // it's an outer, already placed
    // Attach hole to the smallest-area outer that contains it.
    let best = -1, bestA = Infinity; const s = c.points[0];
    contours.forEach((o, j) => {
      if (j === i || depth[j] % 2 !== 0 || !pointInPolygon(s.x, s.y, polys[j])) return;
      const a = Math.abs(signedArea(o)); if (a < bestA) { bestA = a; best = j; }
    });
    if (best >= 0) pieces[outerToPiece.get(best)].contours.push(cloneC(c));
    else pieces.push({ contours: [cloneC(c)] });
  });
  return pieces.length ? pieces : [{ contours: contours.map(cloneC) }];
}

function cloneC(c) {
  return { closed: c.closed, points: c.points.map(p => ({
    x: p.x, y: p.y, type: p.type,
    handleIn: p.handleIn ? { ...p.handleIn } : null,
    handleOut: p.handleOut ? { ...p.handleOut } : null,
  })) };
}

// ---- Point / contour construction ---------------------------------------
export function makePoint(x, y, type = 'corner') {
  return { x, y, type, handleIn: null, handleOut: null };
}

export function makeRect(x, y, w, h) {
  return {
    closed: true,
    points: [
      makePoint(x, y), makePoint(x + w, y),
      makePoint(x + w, y + h), makePoint(x, y + h),
    ],
  };
}

// Rounded rectangle as cubic corners.
export function makeRoundRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const k = r * 0.5523;
  const pts = [];
  const corners = [
    { cx: x + r,     cy: y,         dir: 'bl' },
  ];
  // Build 4 rounded corners with handles.
  function corner(px, py, hi, ho, type = 'smooth') {
    const p = makePoint(px, py, type);
    p.handleIn = hi; p.handleOut = ho; return p;
  }
  // bottom-left -> bottom-right -> top-right -> top-left (y-up)
  const out = [];
  // BL
  out.push(corner(x + r, y, { x: x + r - k, y: y }, { x: x + w - r + k, y: y }));
  // BR
  out.push(corner(x + w, y + r, { x: x + w, y: y + r - k }, { x: x + w, y: y + h - r + k }));
  // TR
  out.push(corner(x + w - r, y + h, { x: x + w - r + k, y: y + h }, { x: x + r - k, y: y + h }));
  // TL
  out.push(corner(x, y + h - r, { x: x, y: y + h - r + k }, { x: x, y: y + r - k }));
  // For perfect rounding we'd add 8 points; this 4-point smooth approximation
  // reads as a rounded rect and stays light for editing.
  return { closed: true, points: out };
}

export function makeCircle(cx, cy, r) {
  const k = r * 0.5523;
  const p = (x, y, hi, ho) => { const pt = makePoint(x, y, 'smooth'); pt.handleIn = hi; pt.handleOut = ho; return pt; };
  return {
    closed: true,
    points: [
      p(cx + r, cy, { x: cx + r, y: cy - k }, { x: cx + r, y: cy + k }),
      p(cx, cy + r, { x: cx + k, y: cy + r }, { x: cx - k, y: cy + r }),
      p(cx - r, cy, { x: cx - r, y: cy + k }, { x: cx - r, y: cy - k }),
      p(cx, cy - r, { x: cx - k, y: cy - r }, { x: cx + k, y: cy - r }),
    ],
  };
}

// ---- Layer access --------------------------------------------------------
export function ensureLayer(glyph, masterId) {
  if (!glyph.layers) glyph.layers = {};
  if (!glyph.layers[masterId]) glyph.layers[masterId] = { contours: [] };
  return glyph.layers[masterId];
}

export function layerBounds(layer) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (!layer || !layer.contours) return null;
  for (const c of layer.contours) for (const p of c.points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---- Hit testing (coordinates in font units) -----------------------------
export function hitPoint(layer, x, y, tol) {
  if (!layer) return null;
  for (let ci = 0; ci < layer.contours.length; ci++) {
    const pts = layer.contours[ci].points;
    for (let pi = 0; pi < pts.length; pi++) {
      if (dist(pts[pi].x, pts[pi].y, x, y) <= tol) return { ci, pi };
    }
  }
  return null;
}

export function hitHandle(layer, x, y, tol) {
  if (!layer) return null;
  for (let ci = 0; ci < layer.contours.length; ci++) {
    const pts = layer.contours[ci].points;
    for (let pi = 0; pi < pts.length; pi++) {
      const p = pts[pi];
      if (p.handleIn && dist(p.handleIn.x, p.handleIn.y, x, y) <= tol) return { ci, pi, which: 'handleIn' };
      if (p.handleOut && dist(p.handleOut.x, p.handleOut.y, x, y) <= tol) return { ci, pi, which: 'handleOut' };
    }
  }
  return null;
}

// Nearest segment on the outline to (x,y) within maxDist, with its param t.
// Used by Alt-click "insert point" so a click on the curve splits it.
export function nearestSegment(layer, x, y, maxDist) {
  if (!layer) return null;
  let best = null;
  for (let ci = 0; ci < layer.contours.length; ci++) {
    const c = layer.contours[ci], pts = c.points, n = pts.length;
    const segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const c1 = a.handleOut || a, c2 = b.handleIn || b;
      const STEPS = 16;
      for (let s = 0; s <= STEPS; s++) {
        const t = s / STEPS;
        const p = cubicPoint(a, c1, c2, b, t);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= maxDist && (!best || d < best.dist)) best = { ci, seg: i, t, dist: d };
      }
    }
  }
  return best;
}

// Nearest point on any contour outline (for brush/liquify radius queries).
export function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// ---- SVG path string (for previews & test bar; y flipped to screen) ------
export function layerToSVGPath(layer, flipY = true, originY = 0) {
  if (!layer || !layer.contours) return '';
  const fy = (y) => flipY ? originY - y : y;
  let d = '';
  for (const c of layer.contours) {
    const pts = c.points;
    if (!pts.length) continue;
    d += `M ${pts[0].x} ${fy(pts[0].y)} `;
    const n = pts.length;
    const segs = c.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const hasOut = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
      const hasIn = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
      if (hasOut || hasIn) {
        const c1 = a.handleOut || a, c2 = b.handleIn || b;
        d += `C ${c1.x} ${fy(c1.y)} ${c2.x} ${fy(c2.y)} ${b.x} ${fy(b.y)} `;
      } else {
        d += `L ${b.x} ${fy(b.y)} `;
      }
    }
    if (c.closed) d += 'Z ';
  }
  return d.trim();
}

// Smooth a single point: turn corner into mirrored handles based on neighbors.
export function smoothPoint(contour, pi, strength = 0.33) {
  const pts = contour.points, n = pts.length;
  const prev = pts[(pi - 1 + n) % n], cur = pts[pi], next = pts[(pi + 1) % n];
  const dx = next.x - prev.x, dy = next.y - prev.y;
  cur.type = 'smooth';
  cur.handleOut = { x: cur.x + dx * strength, y: cur.y + dy * strength };
  cur.handleIn = { x: cur.x - dx * strength, y: cur.y - dy * strength };
}
