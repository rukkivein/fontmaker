'use strict';
const zlib = require('zlib');

/*
 * Reads vector artwork directly from Adobe Illustrator .ai files (and PDFs).
 *
 * Modern .ai files are PDF documents (Illustrator's default "Create PDF
 * Compatible File" embeds the artwork as a PDF page content stream). We locate
 * the page's /Contents stream, inflate it, and interpret the PDF path-painting
 * operators (m l c v y re h, plus q Q cm for the transform stack) into our
 * editable contour model. PDF user space is y-up, matching our font units, so
 * no axis flip is needed.
 *
 * Returns an array of shapes: [{ contours: [{ closed, points:[{x,y,type,
 * handleIn, handleOut}] }] }].
 */
function parseAI(buffer) {
  const latin = buffer.toString('latin1');
  // 1) Real vector paths from the PDF page content (present when "Create PDF
  //    Compatible File" was on). Cheapest and most accurate.
  let content = extractPageContent(buffer, latin);
  if (content) { const s = parseContentStream(content); if (s.length) return s; }
  // 2) Otherwise read Illustrator's own art data. Modern .ai (CC 2020+) stores
  //    it zstd-compressed under %AI24_ZStandard_Data; older files keep legacy
  //    PostScript art. Both decode to readable AI path operators.
  const art = extractAIArt(buffer, latin);
  if (art) { const contours = parseAIArt(art); if (contours.length) return clean(groupByNesting(contours)); }
  // 3) Last resort: any FlateDecode stream that looks like content.
  content = extractAllFlate(buffer, latin);
  if (content) { const s = parseContentStream(content); if (s.length) return clean(s); }
  return [];
}

// Drop degenerate shapes (points / hairlines) that come from stray numbers in
// the file's binary sections.
function clean(shapes) {
  return shapes.filter(s => {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const ct of s.contours) for (const p of ct.points) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
    return (c - a) >= 1 && (d - b) >= 1;
  });
}

// Decompress a zstd frame. Prefer Node's native zstd (Node 22.15+); fall back
// to the pure-JS fzstd so it also works inside Electron's bundled Node 20.
function zstdDecompress(frame) {
  try {
    const zlib = require('zlib');
    if (typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(frame);
  } catch { /* try fzstd */ }
  try { return require('fzstd').decompress(frame); } catch { return null; }
}

// Concatenate raw stream bodies (by exact /Length), then return the AI art as a
// readable string — zstd-inflated when needed.
function extractAIArt(buffer, latin) {
  const re = /stream\r?\n/g; let m; const bodies = [];
  while ((m = re.exec(latin))) {
    const ds = m.index + m[0].length;
    const dictStart = latin.lastIndexOf('<<', m.index);
    const dict = latin.slice(dictStart, m.index);
    const lm = /\/Length\s+(\d+)/.exec(dict);
    if (!lm) continue;
    bodies.push(buffer.subarray(ds, ds + parseInt(lm[1], 10)));
  }
  const all = Buffer.concat(bodies);
  const tag = all.indexOf('%AI24_ZStandard_Data');
  if (tag >= 0) {
    let z = tag;
    while (z < all.length - 4 && !(all[z] === 0x28 && all[z + 1] === 0xB5 && all[z + 2] === 0x2F && all[z + 3] === 0xFD)) z++;
    const frame = all.subarray(z);
    const out = zstdDecompress(frame);
    if (out) return Buffer.from(out).toString('latin1');
  }
  // Legacy uncompressed PostScript art.
  const ps = all.indexOf('%!PS-Adobe');
  if (ps >= 0 && all.indexOf('%AI', ps) >= 0) return all.subarray(ps).toString('latin1');
  return null;
}

// Parse Illustrator's PostScript-style art into flat contours.
// AI path ops: m (moveto), l/L (lineto), c/C, v/V, y/Y (curves); paint ops
// f F s S b B keep the path, n N discard it (clips / non-printing).
function parseAIArt(str) {
  const tokens = scanTokens(str);
  const contours = [];
  let cur = null, curX = 0, curY = 0;
  const ops = [];
  const move = (x, y) => { cur = { closed: false, points: [mkPoint(x, y)] }; curX = x; curY = y; };
  const line = (x, y) => { if (!cur) move(x, y); else { cur.points.push(mkPoint(x, y)); curX = x; curY = y; } };
  const curve = (x1, y1, x2, y2, x3, y3) => {
    if (!cur) move(x1, y1);
    cur.points[cur.points.length - 1].handleOut = { x: x1, y: y1 };
    const np = mkPoint(x3, y3, 'smooth'); np.handleIn = { x: x2, y: y2 };
    cur.points.push(np); curX = x3; curY = y3;
  };
  let pending = []; // subpaths not yet painted
  const endPath = (keep) => {
    if (cur) { pending.push(cur); cur = null; }
    if (keep) for (const c of pending) if (c.points.length >= 2) contours.push(c);
    pending = [];
  };
  for (const t of tokens) {
    if (t.num !== undefined) { ops.push(t.num); continue; }
    const a = ops, N = a.length, op = t.op;
    switch (op) {
      case 'm': if (cur) pending.push(cur); move(a[N - 2], a[N - 1]); break;
      case 'l': case 'L': line(a[N - 2], a[N - 1]); break;
      case 'c': case 'C': curve(a[N - 6], a[N - 5], a[N - 4], a[N - 3], a[N - 2], a[N - 1]); break;
      case 'v': case 'V': curve(curX, curY, a[N - 4], a[N - 3], a[N - 2], a[N - 1]); break;
      case 'y': case 'Y': curve(a[N - 4], a[N - 3], a[N - 2], a[N - 1], a[N - 2], a[N - 1]); break;
      case 'f': case 'F': case 'b': case 'B': case 's': case 'S':
        if (cur) cur.closed = true; endPath(true); break;
      case 'n': case 'N': endPath(false); break;
      default: break;
    }
    ops.length = 0;
  }
  endPath(true);
  return contours;
}

// Group flat contours into shapes by nesting (outer + the holes inside it),
// so a file of letter outlines splits into per-letter shapes with real holes.
function groupByNesting(contours) {
  contours = contours.filter(c => c.points.length >= 2);
  if (contours.length <= 1) return contours.length ? [{ contours }] : [];
  const polys = contours.map(c => c.points);
  const area = (c) => { let s = 0; const p = c.points; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i].x * q.y - q.x * p[i].y; } return Math.abs(s / 2); };
  const inPoly = (x, y, poly) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; };
  const depth = contours.map((c, i) => { let d = 0; const s = c.points[0]; for (let j = 0; j < contours.length; j++) { if (j === i || contours[j].points.length < 3) continue; if (inPoly(s.x, s.y, polys[j])) d++; } return d; });
  const pieces = []; const outerOf = new Map();
  contours.forEach((c, i) => { if (depth[i] % 2 === 0) { outerOf.set(i, pieces.length); pieces.push({ contours: [c] }); } });
  contours.forEach((c, i) => {
    if (depth[i] % 2 === 0) return;
    let best = -1, bestA = Infinity; const s = c.points[0];
    contours.forEach((o, j) => { if (j === i || depth[j] % 2 !== 0 || !inPoly(s.x, s.y, polys[j])) return; const aa = area(o); if (aa < bestA) { bestA = aa; best = j; } });
    if (best >= 0) pieces[outerOf.get(best)].contours.push(c); else pieces.push({ contours: [c] });
  });
  return pieces;
}

// ---- PDF structure: find the page content stream -------------------------
function findObject(latin, num) {
  const re = new RegExp('(?:^|[^0-9])' + num + '\\s+0\\s+obj');
  const m = re.exec(latin);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = latin.indexOf('endobj', start);
  return { start, end: end < 0 ? latin.length : end };
}

function streamBytes(buffer, latin, obj) {
  const sIdx = latin.indexOf('stream', obj.start);
  if (sIdx < 0 || sIdx > obj.end) return null;
  // Stream data begins after 'stream' + EOL (CRLF or LF).
  let dataStart = sIdx + 6;
  if (latin[dataStart] === '\r') dataStart++;
  if (latin[dataStart] === '\n') dataStart++;
  const eIdx = latin.indexOf('endstream', dataStart);
  const raw = buffer.subarray(dataStart, eIdx);
  const dict = latin.slice(obj.start, sIdx);
  if (/\/FlateDecode/.test(dict)) {
    try { return zlib.inflateSync(raw).toString('latin1'); }
    catch { try { return zlib.inflateRawSync(raw).toString('latin1'); } catch { return null; } }
  }
  return raw.toString('latin1');
}

function extractPageContent(buffer, latin) {
  // Locate the /Type /Page object (not /Pages).
  const pm = /\/Type\s*\/Page(?![s])/.exec(latin);
  if (!pm) return null;
  // Find this object's dict bounds.
  const objStart = latin.lastIndexOf(' obj', pm.index);
  const dictEnd = latin.indexOf('endobj', pm.index);
  const dict = latin.slice(objStart, dictEnd < 0 ? latin.length : dictEnd);
  const cm = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(dict);
  if (!cm) return null;
  const refs = [];
  const reRef = /(\d+)\s+0\s+R/g; let r;
  while ((r = reRef.exec(cm[1]))) refs.push(parseInt(r[1], 10));
  let out = '';
  for (const num of refs) {
    const obj = findObject(latin, num);
    if (!obj) continue;
    const s = streamBytes(buffer, latin, obj);
    if (s) out += s + '\n';
  }
  return out || null;
}

// Fallback: inflate every FlateDecode stream and keep the one that looks most
// like vector content (has path + paint operators).
function extractAllFlate(buffer, latin) {
  const re = /stream\r?\n/g; let m; let best = null, bestScore = 0;
  while ((m = re.exec(latin))) {
    const dataStart = m.index + m[0].length;
    const eIdx = latin.indexOf('endstream', dataStart);
    if (eIdx < 0) continue;
    const dictStart = latin.lastIndexOf('obj', m.index);
    const dict = latin.slice(dictStart, m.index);
    if (!/\/FlateDecode/.test(dict)) continue;
    let s;
    try { s = zlib.inflateSync(buffer.subarray(dataStart, eIdx)).toString('latin1'); } catch { continue; }
    const score = (s.match(/[ml]\s|[cvy]\s|\sre\s/g) || []).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// ---- Content-stream interpreter -----------------------------------------
function mkPoint(x, y, type = 'corner') { return { x, y, type, handleIn: null, handleOut: null }; }

// Compose so a point is transformed by `cm` first, then the existing CTM.
function composeOldCm(o, c) {
  return [
    o[0] * c[0] + o[2] * c[1],
    o[1] * c[0] + o[3] * c[1],
    o[0] * c[2] + o[2] * c[3],
    o[1] * c[2] + o[3] * c[3],
    o[0] * c[4] + o[2] * c[5] + o[4],
    o[1] * c[4] + o[3] * c[5] + o[5],
  ];
}

function parseContentStream(str) {
  const tokens = scanTokens(str);
  const shapes = [];
  let subpaths = [], cur = null, curX = 0, curY = 0, clip = false;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const ops = [];

  const tf = (x, y) => ({ x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5] });
  const moveTo = (x, y) => { const p = tf(x, y); cur = { closed: false, points: [mkPoint(p.x, p.y)] }; subpaths.push(cur); curX = x; curY = y; };
  const lineTo = (x, y) => { if (!cur) moveTo(x, y); else { const p = tf(x, y); cur.points.push(mkPoint(p.x, p.y)); curX = x; curY = y; } };
  const curveTo = (x1, y1, x2, y2, x3, y3) => {
    if (!cur) moveTo(x1, y1);
    const c1 = tf(x1, y1), c2 = tf(x2, y2), e = tf(x3, y3);
    cur.points[cur.points.length - 1].handleOut = { x: c1.x, y: c1.y };
    const np = mkPoint(e.x, e.y, 'smooth'); np.handleIn = { x: c2.x, y: c2.y };
    cur.points.push(np); curX = x3; curY = y3;
  };
  const rect = (x, y, w, h) => { moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); if (cur) cur.closed = true; };
  const paint = (isNoOp) => {
    if (clip && isNoOp) { subpaths = []; cur = null; clip = false; return; }
    const cs = subpaths.filter(c => c.points.length >= 2);
    if (cs.length) shapes.push({ contours: cs });
    subpaths = []; cur = null; clip = false;
  };

  for (const t of tokens) {
    if (t.num !== undefined) { ops.push(t.num); continue; }
    const a = ops, N = a.length, op = t.op;
    switch (op) {
      case 'm': moveTo(a[N - 2], a[N - 1]); break;
      case 'l': lineTo(a[N - 2], a[N - 1]); break;
      case 'c': curveTo(a[N - 6], a[N - 5], a[N - 4], a[N - 3], a[N - 2], a[N - 1]); break;
      case 'v': curveTo(curX, curY, a[N - 4], a[N - 3], a[N - 2], a[N - 1]); break;
      case 'y': curveTo(a[N - 4], a[N - 3], a[N - 2], a[N - 1], a[N - 2], a[N - 1]); break;
      case 're': rect(a[N - 4], a[N - 3], a[N - 2], a[N - 1]); break;
      case 'h': if (cur) cur.closed = true; break;
      case 'cm': if (N >= 6) ctm = composeOldCm(ctm, [a[N - 6], a[N - 5], a[N - 4], a[N - 3], a[N - 2], a[N - 1]]); break;
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'W': case 'W*': clip = true; break;
      case 'n': paint(true); break;
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': paint(false); break;
      default: break;
    }
    ops.length = 0;
  }
  if (subpaths.length) paint(false);
  return shapes.filter(s => s.contours.length);
}

// Character scanner that yields {num} / {op}, skipping names, strings, arrays,
// dicts, comments and inline images.
function scanTokens(str) {
  const out = []; const n = str.length; let i = 0;
  const isDelim = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0' ||
    c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '/' || c === '%' || c === '{' || c === '}';
  while (i < n) {
    const ch = str[i];
    if (ch <= ' ') { i++; continue; }
    if (ch === '%') { while (i < n && str[i] !== '\n' && str[i] !== '\r') i++; continue; }
    if (ch === '(') { let d = 1; i++; while (i < n && d > 0) { const c = str[i]; if (c === '\\') { i += 2; continue; } if (c === '(') d++; else if (c === ')') d--; i++; } continue; }
    if (ch === '<') {
      if (str[i + 1] === '<') { i += 2; let d = 1; while (i < n && d > 0) { if (str[i] === '<' && str[i + 1] === '<') { d++; i += 2; } else if (str[i] === '>' && str[i + 1] === '>') { d--; i += 2; } else i++; } continue; }
      i++; while (i < n && str[i] !== '>') i++; i++; continue;
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { i++; continue; }
    if (ch === '/') { i++; while (i < n && !isDelim(str[i])) i++; continue; }
    let j = i; while (j < n && !isDelim(str[j])) j++;
    if (j === i) { i++; continue; } // stray delimiter (e.g. ')' in binary data) — skip
    const tok = str.slice(i, j); i = j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) out.push({ num: parseFloat(tok) });
    else if (tok === 'BI') { const ei = str.indexOf('EI', i); i = ei < 0 ? n : ei + 2; }
    else if (tok) out.push({ op: tok });
  }
  return out;
}

module.exports = { parseAI, _internals: { scanTokens, parseAIArt, groupByNesting, extractAIArt, parseContentStream } };
