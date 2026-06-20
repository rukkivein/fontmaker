'use strict';
// markgen.js — SYNTHESIZE diacritic marks from a font's existing shapes so accented
// letters can auto-compose without the user drawing every mark. Marks are derived by
// rotate / scale / shear / mirror of the apostrophe, period, hyphen, comma and O, plus
// a few weight-matched CONSTRUCTED shapes (^ ˇ ~ ˘) whose stroke thickness is read
// from the font (the hyphen / period) so they match. Pure JS; used by accentCompose
// as a fallback when a mark glyph isn't present. A user-drawn mark always wins.

const glyphset = require('./glyphset.js');

// ---- contour transforms (anchor + both handles) ----
function clone(cs) {
  return cs.map(function (c) { return { closed: c.closed !== false, points: c.points.map(function (p) { return { x: p.x, y: p.y, type: p.type || 'corner', handleIn: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null, handleOut: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null }; }) }; });
}
function mapPts(cs, fn) {
  return cs.map(function (c) {
    return { closed: c.closed !== false, points: c.points.map(function (p) {
      var a = fn(p.x, p.y), o = { x: a.x, y: a.y, type: p.type || 'corner', handleIn: null, handleOut: null };
      if (p.handleIn) { var hi = fn(p.handleIn.x, p.handleIn.y); o.handleIn = { x: hi.x, y: hi.y }; }
      if (p.handleOut) { var ho = fn(p.handleOut.x, p.handleOut.y); o.handleOut = { x: ho.x, y: ho.y }; }
      return o;
    }) };
  });
}
function reverse(cs) { // reverse direction (swap in/out handles) — keeps winding after a mirror
  return cs.map(function (c) { return { closed: c.closed !== false, points: c.points.slice().reverse().map(function (p) { return { x: p.x, y: p.y, type: p.type || 'corner', handleIn: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null, handleOut: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null }; }) }; });
}
function bbox(cs) { return glyphset.contoursBounds(cs); }
function translate(cs, dx, dy) { return mapPts(cs, function (x, y) { return { x: x + dx, y: y + dy }; }); }
function norm0(cs) { var b = bbox(cs); return b ? translate(cs, -b.minX, -b.minY) : cs; }   // bbox → origin
function scaleO(cs, sx, sy) { return mapPts(cs, function (x, y) { return { x: x * sx, y: y * sy }; }); } // about origin
function fit(cs, W, H) { var b = bbox(cs); if (!b || b.w < 1e-6 || b.h < 1e-6) return cs; return scaleO(norm0(cs), W / b.w, H / b.h); }
function fitKeep(cs, H) { var b = bbox(cs); if (!b || b.h < 1e-6) return cs; var s = H / b.h; return scaleO(norm0(cs), s, s); }
function shearRight(cs, k) { var b = bbox(cs), y0 = b ? b.minY : 0; return mapPts(cs, function (x, y) { return { x: x + k * (y - y0), y: y }; }); } // top leans +x
function mirrorX(cs) { var b = bbox(cs), ax = b ? (b.minX + b.maxX) / 2 : 0; return reverse(mapPts(cs, function (x, y) { return { x: 2 * ax - x, y: y }; })); }
function mirrorY(cs) { var b = bbox(cs), ay = b ? (b.minY + b.maxY) / 2 : 0; return reverse(mapPts(cs, function (x, y) { return { x: x, y: 2 * ay - y }; })); }

// ---- primitives (used only when a source glyph is missing) ----
function rect(w, h) { return [{ closed: true, points: [{ x: 0, y: 0, type: 'corner' }, { x: w, y: 0, type: 'corner' }, { x: w, y: h, type: 'corner' }, { x: 0, y: h, type: 'corner' }] }]; }
function disc(d) {
  var r = d / 2, k = 0.5523 * r;
  function P(x, y, hi, ho) { return { x: x, y: y, type: 'smooth', handleIn: hi, handleOut: ho }; }
  return [{ closed: true, points: [
    P(r, 0, { x: r - k, y: 0 }, { x: r + k, y: 0 }), P(d, r, { x: d, y: r - k }, { x: d, y: r + k }),
    P(r, d, { x: r + k, y: d }, { x: r - k, y: d }), P(0, r, { x: 0, y: r + k }, { x: 0, y: r - k })] }];
}
function ringShape(d, t) { var outer = disc(d), inner = reverse(translate(disc(d - 2 * t), t, t)); return outer.concat(inner); }
// a closed band of vertical thickness T following a cubic centre-line — for ~ and ˘
function band(center, T) {
  var top = center.map(function (p) { return { x: p.x, y: p.y + T / 2, type: 'smooth', handleIn: p.hi ? { x: p.hi.x, y: p.hi.y + T / 2 } : null, handleOut: p.ho ? { x: p.ho.x, y: p.ho.y + T / 2 } : null }; });
  var bot = center.slice().reverse().map(function (p) { return { x: p.x, y: p.y - T / 2, type: 'smooth', handleIn: p.ho ? { x: p.ho.x, y: p.ho.y - T / 2 } : null, handleOut: p.hi ? { x: p.hi.x, y: p.hi.y - T / 2 } : null }; });
  return [{ closed: true, points: top.concat(bot) }];
}

// ---- source lookup ----
function srcContours(project, ch, mid) {
  var g = null; for (var i = 0; i < project.glyphs.length; i++) if (project.glyphs[i].char === ch) { g = project.glyphs[i]; break; }
  if (!g) return null;
  var l = g.layers && g.layers[mid]; if (!l || !l.contours || !l.contours.length) return null;
  var cs = clone(l.contours);
  if (g.lsbLineX) cs = translate(cs, -g.lsbLineX, 0);
  return cs;
}
function firstSrc(project, chars, mid) { for (var i = 0; i < chars.length; i++) { var c = srcContours(project, chars[i], mid); if (c) return c; } return null; }
function strokeW(project, mid, em) {
  var hy = firstSrc(project, ['-', '‐', '–'], mid); if (hy) { var b = bbox(hy); if (b) return Math.max(0.05 * em, Math.min(0.14 * em, b.h)); }
  var pd = firstSrc(project, ['.'], mid); if (pd) { var b2 = bbox(pd); if (b2) return Math.max(0.05 * em, Math.min(0.14 * em, b2.h * 0.5)); }
  return 0.085 * em;
}

// ---- derive one mark → { contours, source } | null ----
function deriveMark(project, markName, mid) {
  mid = mid || (project.masters && project.masters[0] && project.masters[0].id);
  var M = project.metrics || {}, em = project.unitsPerEm || M.unitsPerEm || 1000;
  var cap = M.capHeight || 0.7 * em, ST = strokeW(project, mid, em);
  var cs, src;
  switch (markName) {
    case 'acute': {
      var ap = firstSrc(project, ["'", '’', '‘', 'ʼ'], mid);
      cs = shearRight(ap ? fitKeep(ap, 0.32 * cap) : rect(ST * 1.15, 0.32 * cap), 0.5); src = ap ? 'apostrophe' : 'built'; break;
    }
    case 'grave': { var a = deriveMark(project, 'acute', mid); if (!a) return null; return { contours: norm0(mirrorX(a.contours)), source: a.source }; }
    case 'doubleacute': {
      var ac = deriveMark(project, 'acute', mid); if (!ac) return null;
      var a1 = norm0(ac.contours), bw = bbox(a1).w, a2 = translate(clone(a1), bw * 1.45, 0); return { contours: a1.concat(a2), source: ac.source };
    }
    case 'dieresis': {
      var pd = firstSrc(project, ['.'], mid), dot = norm0(pd ? fitKeep(pd, ST * 1.2) : disc(ST * 1.2));
      var d2 = translate(clone(dot), 0.34 * cap, 0); return { contours: dot.concat(d2), source: pd ? 'period' : 'built' };
    }
    case 'dotaccent': { var p = firstSrc(project, ['.'], mid); return { contours: norm0(p ? fitKeep(p, ST * 1.25) : disc(ST * 1.25)), source: p ? 'period' : 'built' }; }
    case 'macron': { var hy = firstSrc(project, ['-', '‐', '–'], mid); return { contours: norm0(hy ? fit(hy, 0.5 * cap, ST) : rect(0.5 * cap, ST)), source: hy ? 'hyphen' : 'built' }; }
    case 'ring': { var oc = firstSrc(project, ['o', 'O', '0'], mid); return { contours: norm0(oc ? fitKeep(oc, 0.42 * cap) : ringShape(0.42 * cap, ST)), source: oc ? 'O' : 'built' }; }
    case 'circumflex': {
      var W = 0.48 * cap, H = 0.28 * cap, Tx = ST * 1.15, Ty = ST * 1.6;
      var pts = [[0, 0], [W / 2, H], [W, 0], [W - Tx, 0], [W / 2, H - Ty], [Tx, 0]];
      return { contours: norm0([{ closed: true, points: pts.map(function (q) { return { x: q[0], y: q[1], type: 'corner' }; }) }]), source: 'built' };
    }
    case 'caron': { var cf = deriveMark(project, 'circumflex', mid); return { contours: norm0(mirrorY(cf.contours)), source: 'built' }; }
    case 'tilde': {
      var tc = firstSrc(project, ['~', '˜'], mid);
      if (tc) return { contours: norm0(fit(tc, 0.52 * cap, 0.18 * cap)), source: 'asciitilde' };
      var Wt = 0.52 * cap, At = 0.11 * cap, ct = [
        { x: 0, y: 0, ho: { x: Wt * 0.18, y: At * 1.7 } },
        { x: Wt * 0.5, y: 0, hi: { x: Wt * 0.32, y: At * 1.7 }, ho: { x: Wt * 0.68, y: -At * 1.7 } },
        { x: Wt, y: 0, hi: { x: Wt * 0.82, y: -At * 1.7 } }];
      return { contours: norm0(band(ct, ST)), source: 'built' };
    }
    case 'breve': {
      var Wb = 0.46 * cap, Db = 0.15 * cap, cb = [
        { x: 0, y: Db, ho: { x: Wb * 0.28, y: -Db * 0.15 } },
        { x: Wb * 0.5, y: 0, hi: { x: Wb * 0.2, y: 0 }, ho: { x: Wb * 0.8, y: 0 } },
        { x: Wb, y: Db, hi: { x: Wb * 0.72, y: -Db * 0.15 } }];
      return { contours: norm0(band(cb, ST)), source: 'built' };
    }
    case 'cedilla': { var cm = firstSrc(project, [','], mid); return { contours: norm0(cm ? fitKeep(cm, 0.27 * cap) : shearRight(rect(ST * 1.0, 0.27 * cap), 0.35)), source: cm ? 'comma' : 'built' }; }
    case 'ogonek': { var ce = deriveMark(project, 'cedilla', mid); if (!ce) return null; return { contours: norm0(mirrorX(ce.contours)), source: ce.source }; }
    default: return null;
  }
  return { contours: norm0(cs), source: src };
}

module.exports = { deriveMark };
