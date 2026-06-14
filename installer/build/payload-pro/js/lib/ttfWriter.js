'use strict';
// Pure-JS glyf-flavored TrueType writer (opentype.js 1.3.4 only writes CFF/OTTO).
// Converts the project's cubic outlines to TrueType quadratics and serializes a
// valid sfnt (0x00010000) with head/hhea/hmtx/maxp/cmap/name/OS2/post/loca/glyf/gasp.
// No Node fs/Buffer — mirrors core/fontEngine.js so it runs in the panel too.
// Honest scope: NO GSUB/GPOS (ligatures/alternates live only on the CFF path).

// ---- winding (mirrors fontEngine; outer CCW / holes CW). No TT flip pass:
// non-zero rasterizers accept this; verified exact in fontTools. ----
function signedArea(pts) { var a = 0; for (var i = 0; i < pts.length; i++) { var q = pts[(i + 1) % pts.length]; a += pts[i].x * q.y - q.x * pts[i].y; } return a / 2; }
function pointInPoly(x, y, poly) { var inside = false; for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) { var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
function reverse(c) {
  var pts = c.points.slice().reverse().map(function (p) { return { x: p.x, y: p.y, handleIn: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null, handleOut: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null }; });
  return { closed: c.closed, points: pts };
}
function normalizeWinding(contours) {
  var polys = contours.map(function (c) { return c.points; });
  return contours.map(function (c, i) {
    if (c.points.length < 3) return c;
    var s = c.points[0], depth = 0;
    for (var j = 0; j < contours.length; j++) { if (j === i || contours[j].points.length < 3) continue; if (pointInPoly(s.x, s.y, polys[j])) depth++; }
    var wantCCW = depth % 2 === 0;
    return (signedArea(c.points) > 0) === wantCCW ? c : reverse(c);
  });
}

// ---- cubic -> quadratic. Error sampled against the LOCAL sub-curve (the bug
// the reviewer caught: don't close over the original endpoints). ----
function cubicAt(p0, c1, c2, p3, t) { var u = 1 - t; return { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y }; }
function quadAt(p0, cp, p1, t) { var u = 1 - t; return { x: u * u * p0.x + 2 * u * t * cp.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * cp.y + t * t * p1.y }; }
function cubicErr(p0, c1, c2, p3) { // single-quad control + max sampled deviation
  var cp = { x: (3 * c1.x - p0.x + 3 * c2.x - p3.x) / 4, y: (3 * c1.y - p0.y + 3 * c2.y - p3.y) / 4 };
  var maxd = 0;
  for (var s = 1; s <= 7; s++) { var t = s / 8; var a = cubicAt(p0, c1, c2, p3, t), b = quadAt(p0, cp, p3, t); var d = Math.hypot(a.x - b.x, a.y - b.y); if (d > maxd) maxd = d; }
  return { cp: cp, err: maxd };
}
function splitCubic(p0, c1, c2, p3) { // de Casteljau at t=0.5
  var m = function (a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  var a = m(p0, c1), b = m(c1, c2), cc = m(c2, p3), d = m(a, b), e = m(b, cc), f = m(d, e);
  return [[p0, a, d, f], [f, e, cc, p3]];
}
function cubicToQuads(p0, c1, c2, p3, tol, depth, out) {
  var r = cubicErr(p0, c1, c2, p3);
  if (r.err <= tol || depth >= 10) { out.push({ cp: r.cp, end: p3 }); return; }
  var h = splitCubic(p0, c1, c2, p3);
  cubicToQuads(h[0][0], h[0][1], h[0][2], h[0][3], tol, depth + 1, out);
  cubicToQuads(h[1][0], h[1][1], h[1][2], h[1][3], tol, depth + 1, out);
}

// contour -> TT points [{x,y,on}] (rounded), implicitly closed (drop dup start)
function contourToTT(c, tol) {
  var p = c.points, n = p.length; if (n < 2) return [];
  var tt = [{ x: p[0].x, y: p[0].y, on: true }];
  var segs = c.closed ? n : n - 1;
  for (var i = 0; i < segs; i++) {
    var a = p[i], b = p[(i + 1) % n];
    var hasO = a.handleOut && (a.handleOut.x !== a.x || a.handleOut.y !== a.y);
    var hasI = b.handleIn && (b.handleIn.x !== b.x || b.handleIn.y !== b.y);
    if (hasO || hasI) {
      var quads = []; cubicToQuads({ x: a.x, y: a.y }, a.handleOut || a, b.handleIn || b, { x: b.x, y: b.y }, tol, 0, quads);
      for (var q = 0; q < quads.length; q++) { tt.push({ x: quads[q].cp.x, y: quads[q].cp.y, on: false }); tt.push({ x: quads[q].end.x, y: quads[q].end.y, on: true }); }
    } else tt.push({ x: b.x, y: b.y, on: true });
  }
  // closed: last on-curve == start; drop it
  if (c.closed && tt.length > 1) { var L = tt[tt.length - 1]; if (L.on && Math.round(L.x) === Math.round(tt[0].x) && Math.round(L.y) === Math.round(tt[0].y)) tt.pop(); }
  for (var k = 0; k < tt.length; k++) { tt[k].x = Math.round(tt[k].x); tt[k].y = Math.round(tt[k].y); }
  return tt;
}

// ---- byte writer ----
function Writer() { this.b = []; }
Writer.prototype.u8 = function (v) { this.b.push(v & 0xff); return this; };
Writer.prototype.u16 = function (v) { this.b.push((v >> 8) & 0xff, v & 0xff); return this; };
Writer.prototype.i16 = function (v) { if (v < 0) v += 0x10000; return this.u16(v); };
Writer.prototype.u32 = function (v) { this.b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; };
Writer.prototype.tag = function (s) { for (var i = 0; i < 4; i++) this.b.push(s.charCodeAt(i)); return this; };
Writer.prototype.bytes = function (arr) { for (var i = 0; i < arr.length; i++) this.b.push(arr[i] & 0xff); return this; };
Writer.prototype.pad4 = function () { while (this.b.length % 4) this.b.push(0); return this; };
function strUTF16BE(s) { var a = []; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a.push((c >> 8) & 0xff, c & 0xff); } return a; }

function buildGlyf(glyphTT) {
  // glyphTT: [{contours:[[{x,y,on}]], adv, name, unicode}] (index 0 = .notdef)
  var glyfParts = [], loca = [0], maxPts = 0, maxCtrs = 0;
  var gXMin = 32767, gYMin = 32767, gXMax = -32768, gYMax = -32768;
  var perGlyphBounds = [];
  for (var gi = 0; gi < glyphTT.length; gi++) {
    var ctrs = glyphTT[gi].contours.filter(function (c) { return c.length > 0; });
    if (!ctrs.length) { perGlyphBounds.push({ xMin: 0, yMin: 0, xMax: 0, yMax: 0 }); loca.push(loca[loca.length - 1]); continue; }
    var all = [], ends = [], xMin = 32767, yMin = 32767, xMax = -32768, yMax = -32768;
    for (var ci = 0; ci < ctrs.length; ci++) { for (var pi = 0; pi < ctrs[ci].length; pi++) { var pt = ctrs[ci][pi]; all.push(pt); if (pt.x < xMin) xMin = pt.x; if (pt.x > xMax) xMax = pt.x; if (pt.y < yMin) yMin = pt.y; if (pt.y > yMax) yMax = pt.y; } ends.push(all.length - 1); }
    if (all.length > maxPts) maxPts = all.length; if (ctrs.length > maxCtrs) maxCtrs = ctrs.length;
    perGlyphBounds.push({ xMin: xMin, yMin: yMin, xMax: xMax, yMax: yMax });
    if (xMin < gXMin) gXMin = xMin; if (yMin < gYMin) gYMin = yMin; if (xMax > gXMax) gXMax = xMax; if (yMax > gYMax) gYMax = yMax;
    var w = new Writer();
    w.i16(ctrs.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
    for (var e = 0; e < ends.length; e++) w.u16(ends[e]);
    w.u16(0); // instructionLength
    // flags + delta arrays
    var flags = [], xs = [], ys = [], px = 0, py = 0;
    for (var ai = 0; ai < all.length; ai++) {
      var P = all[ai], dx = P.x - px, dy = P.y - py; px = P.x; py = P.y;
      var f = P.on ? 1 : 0;
      if (dx === 0) f |= 0x10; else if (dx >= -255 && dx <= 255) { f |= 0x02; if (dx > 0) f |= 0x10; xs.push(Math.abs(dx)); } else { xs.push(dx); }
      if (dy === 0) f |= 0x20; else if (dy >= -255 && dy <= 255) { f |= 0x04; if (dy > 0) f |= 0x20; ys.push(Math.abs(dy)); } else { ys.push(dy); }
      flags.push(f);
    }
    for (var fi = 0; fi < flags.length; fi++) w.u8(flags[fi]);
    var xqi = 0; for (var fx = 0; fx < flags.length; fx++) { var ff = flags[fx]; if (ff & 0x02) w.u8(xs[xqi++]); else if (!(ff & 0x10)) { w.i16(xs[xqi++]); } }
    var yqi = 0; for (var fy = 0; fy < flags.length; fy++) { var fg = flags[fy]; if (fg & 0x04) w.u8(ys[yqi++]); else if (!(fg & 0x20)) { w.i16(ys[yqi++]); } }
    while (w.b.length % 2) w.b.push(0);
    glyfParts.push(w.b); loca.push(loca[loca.length - 1] + w.b.length);
  }
  var glyf = []; for (var g = 0; g < glyfParts.length; g++) glyf = glyf.concat(glyfParts[g]);
  if (gXMin > gXMax) { gXMin = gYMin = gXMax = gYMax = 0; }
  return { glyf: glyf, loca: loca, maxPts: maxPts, maxCtrs: maxCtrs, bounds: { xMin: gXMin, yMin: gYMin, xMax: gXMax, yMax: gYMax }, perGlyph: perGlyphBounds };
}

function table(tag, bytes) { return { tag: tag, data: bytes }; }

function buildGlyfFont(project, metadata, masterId) {
  metadata = metadata || {};
  var upm = project.unitsPerEm || 1000;
  masterId = masterId || (metadata.masterId) || (project.masters && project.masters[0] && project.masters[0].id);
  var tol = 1.0;

  // glyph list: .notdef first, then project glyphs (skip non-unicode for cmap)
  var list = [{ name: '.notdef', unicode: 0, adv: Math.round(upm * 0.5), contours: [] }];
  for (var i = 0; i < project.glyphs.length; i++) {
    var g = project.glyphs[i], layer = g.layers && g.layers[masterId];
    var ctrs = (layer && layer.contours) ? normalizeWinding(layer.contours) : [];
    var tt = ctrs.map(function (c) { return contourToTT(c, tol); }).filter(function (a) { return a.length > 0; });
    list.push({ name: g.name || ('uni' + (g.unicode || 0).toString(16)), unicode: g.unicode || 0, adv: Math.round(g.advanceWidth != null ? g.advanceWidth : upm * 0.6), contours: tt });
  }

  var built = buildGlyf(list);
  var numGlyphs = list.length;

  // ---- cmap (format 4, BMP) ----
  var cmapEntries = []; for (var ci = 0; ci < list.length; ci++) if (list[ci].unicode > 0 && list[ci].unicode <= 0xFFFF) cmapEntries.push({ cp: list[ci].unicode, gid: ci });
  cmapEntries.sort(function (a, b) { return a.cp - b.cp; });
  var segs = [];
  for (var ce = 0; ce < cmapEntries.length;) {
    var startCp = cmapEntries[ce].cp, startGid = cmapEntries[ce].gid, prevCp = startCp, prevGid = startGid, j2 = ce + 1;
    while (j2 < cmapEntries.length && cmapEntries[j2].cp === prevCp + 1 && cmapEntries[j2].gid === prevGid + 1) { prevCp = cmapEntries[j2].cp; prevGid = cmapEntries[j2].gid; j2++; }
    segs.push({ start: startCp, end: prevCp, startGid: startGid }); ce = j2;
  }
  segs.push({ start: 0xffff, end: 0xffff, startGid: 0, terminator: true });
  var segCount = segs.length, sc2 = segCount * 2;
  var searchRange = 2 * Math.pow(2, Math.floor(Math.log(segCount) / Math.LN2)); var entrySelector = Math.floor(Math.log(searchRange / 2) / Math.LN2); var rangeShift = sc2 - searchRange;
  var sub = new Writer();
  sub.u16(4).u16(0).u16(0); // format,length(fill),language
  sub.u16(sc2).u16(searchRange).u16(entrySelector).u16(rangeShift);
  for (var s1 = 0; s1 < segs.length; s1++) sub.u16(segs[s1].end);
  sub.u16(0); // reservedPad
  for (var s2 = 0; s2 < segs.length; s2++) sub.u16(segs[s2].start);
  for (var s3 = 0; s3 < segs.length; s3++) { if (segs[s3].terminator) sub.i16(1); else sub.i16((segs[s3].startGid - segs[s3].start) & 0xffff); } // idDelta
  for (var s4 = 0; s4 < segs.length; s4++) sub.u16(0); // idRangeOffset
  // patch subtable length
  sub.b[2] = (sub.b.length >> 8) & 0xff; sub.b[3] = sub.b.length & 0xff;
  var cmap = new Writer();
  cmap.u16(0).u16(1); // version, numTables
  cmap.u16(3).u16(1).u32(12); // platform 3, enc 1, offset
  cmap.bytes(sub.b);
  var cmapBytes = cmap.b;

  // ---- head ----
  var head = new Writer();
  head.u32(0x00010000).u32(0x00010000).u32(0); // version, fontRevision, checkSumAdjustment(later)
  head.u32(0x5F0F3CF5).u16(0x000B).u16(upm);
  head.u32(0).u32(0).u32(0).u32(0); // created (8), modified (8)
  head.i16(built.bounds.xMin).i16(built.bounds.yMin).i16(built.bounds.xMax).i16(built.bounds.yMax);
  head.u16(metadata.styleName && /italic/i.test(metadata.styleName) ? 0x0002 : 0); // macStyle
  head.u16(8); // lowestRecPPEM
  head.i16(2).i16(1).i16(0); // fontDirectionHint, indexToLocFormat=1(long), glyphDataFormat
  var headBytes = head.b;

  // ---- hhea + hmtx ----
  var asc = project.metrics ? project.metrics.ascender : Math.round(upm * 0.8);
  var desc = project.metrics ? project.metrics.descender : -Math.round(upm * 0.2);
  var advMax = 0, minLsb = 32767, minRsb = 32767, xMaxExtent = -32768;
  for (var hi = 0; hi < list.length; hi++) { if (list[hi].adv > advMax) advMax = list[hi].adv; var bb = built.perGlyph[hi]; var lsb = bb.xMin; if (lsb < minLsb) minLsb = lsb; var rsb = list[hi].adv - bb.xMax; if (rsb < minRsb) minRsb = rsb; if (bb.xMax > xMaxExtent) xMaxExtent = bb.xMax; }
  var hhea = new Writer();
  hhea.u32(0x00010000).i16(asc).i16(desc).i16(Math.round(upm * 0.09)); // ascender, descender, lineGap
  hhea.u16(advMax).i16(minLsb === 32767 ? 0 : minLsb).i16(minRsb === 32767 ? 0 : minRsb).i16(xMaxExtent < -32767 ? 0 : xMaxExtent);
  hhea.i16(1).i16(0).i16(0); // caretSlopeRise, caretSlopeRun, caretOffset
  hhea.i16(0).i16(0).i16(0).i16(0); // reserved * 4
  hhea.i16(0).u16(numGlyphs); // metricDataFormat, numberOfHMetrics
  var hheaBytes = hhea.b;
  var hmtx = new Writer(); for (var mi = 0; mi < list.length; mi++) hmtx.u16(list[mi].adv).i16(built.perGlyph[mi].xMin);
  var hmtxBytes = hmtx.b;

  // ---- maxp v1.0 ----
  var maxp = new Writer();
  maxp.u32(0x00010000).u16(numGlyphs).u16(built.maxPts).u16(built.maxCtrs).u16(0).u16(0); // maxPoints, maxContours, maxComposite*
  // maxZones, maxTwilightPoints, maxStorage, maxFunctionDefs, maxInstructionDefs,
  // maxStackElements, maxSizeOfInstructions, maxComponentElements, maxComponentDepth (9)
  maxp.u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  var maxpBytes = maxp.b;

  // ---- OS/2 v4 (96 bytes incl. sFamilyClass) ----
  var firstCp = cmapEntries.length ? cmapEntries[0].cp : 0, lastCp = cmapEntries.length ? cmapEntries[cmapEntries.length - 1].cp : 0;
  var os2 = new Writer();
  os2.u16(4); // version
  os2.i16(Math.round(advMax * 0.5)); // xAvgCharWidth (approx)
  os2.u16(metadata.weightClass || 400).u16(5); // usWeightClass, usWidthClass(medium)
  os2.u16(0); // fsType
  os2.i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.075)).i16(Math.round(upm * 0.7)).i16(Math.round(upm * 0.075)); // subscript X/Y size/offset
  os2.i16(Math.round(upm * 0.65)).i16(Math.round(upm * 0.075)).i16(Math.round(upm * 0.7)).i16(Math.round(upm * 0.48)); // superscript
  os2.i16(Math.round(upm * 0.05)).i16(Math.round(upm * 0.26)); // strikeout size, position
  os2.i16(0); // sFamilyClass (the field the reviewer caught)
  os2.bytes([2, 0, 6, 3, 0, 0, 0, 0, 0, 0]); // panose (10)
  os2.u32(0).u32(0).u32(0).u32(0); // ulUnicodeRange1-4
  os2.tag('RNTP'); // achVendID
  os2.u16(/italic/i.test(metadata.styleName || '') ? 0x01 : 0x40); // fsSelection
  os2.u16(firstCp).u16(lastCp);
  os2.i16(asc).i16(desc).i16(Math.round(upm * 0.09)); // sTypoAscender/Descender/LineGap
  os2.u16(asc).u16(Math.abs(desc)); // usWinAscent/Descent
  os2.u32(1).u32(0); // ulCodePageRange1-2 (Latin1)
  os2.i16(Math.round(project.metrics ? project.metrics.xHeight : upm * 0.5)).i16(Math.round(project.metrics ? project.metrics.capHeight : upm * 0.7)); // sxHeight, sCapHeight
  os2.u16(0).u16(0).u16(400); // usDefaultChar, usBreakChar, usMaxContext
  var os2Bytes = os2.b;

  // ---- post v3 ----
  var post = new Writer();
  post.u32(0x00030000).u32(0).i16(0).i16(0).u16(0).u16(0).u32(0).u32(0).u32(0).u32(0);
  var postBytes = post.b;

  // ---- name ----
  var fam = metadata.familyName || 'Untitled', sty = metadata.styleName || 'Regular';
  var full = sty.toLowerCase() === 'regular' ? fam : fam + ' ' + sty;
  var ps = (fam + '-' + sty).replace(/[^A-Za-z0-9]+/g, '');
  var ver = 'Version ' + (metadata.version || '1.000');
  var records = [[1, fam], [2, sty], [3, ver + ';' + ps], [4, full], [6, ps]];
  if (metadata.designer) records.push([9, metadata.designer]);
  if (metadata.copyright) records.push([0, metadata.copyright]);
  if (metadata.license) records.push([13, metadata.license]);
  if (metadata.manufacturer) records.push([8, metadata.manufacturer]);
  records.sort(function (a, b) { return a[0] - b[0]; });
  var nameHdr = new Writer(); nameHdr.u16(0).u16(records.length).u16(6 + 12 * records.length);
  var storage = [], off = 0, recs = new Writer();
  for (var ri = 0; ri < records.length; ri++) { var bytes = strUTF16BE(String(records[ri][1])); recs.u16(3).u16(1).u16(0x0409).u16(records[ri][0]).u16(bytes.length).u16(off); storage = storage.concat(bytes); off += bytes.length; }
  var nameBytes = nameHdr.b.concat(recs.b).concat(storage);

  // ---- gasp (unhinted: gridfit+grayscale at all sizes) ----
  var gasp = new Writer(); gasp.u16(0).u16(1).u16(0xFFFF).u16(0x000F);
  var gaspBytes = gasp.b;

  // ---- loca (long) ----
  var locaW = new Writer(); for (var li = 0; li < built.loca.length; li++) locaW.u32(built.loca[li]);
  var locaBytes = locaW.b;

  // ---- assemble sfnt ----
  var tables = [
    table('OS/2', os2Bytes), table('cmap', cmapBytes), table('gasp', gaspBytes),
    table('glyf', built.glyf), table('head', headBytes), table('hhea', hheaBytes),
    table('hmtx', hmtxBytes), table('loca', locaBytes), table('maxp', maxpBytes),
    table('name', nameBytes), table('post', postBytes),
  ];
  tables.sort(function (a, b) { return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0; });

  function checksum(bytes) { var sum = 0; for (var i = 0; i < bytes.length; i += 4) { var v = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0); sum = (sum + (v >>> 0)) >>> 0; } return sum >>> 0; }

  var numTables = tables.length;
  var sr = Math.pow(2, Math.floor(Math.log(numTables) / Math.LN2)) * 16, es = Math.floor(Math.log(sr / 16) / Math.LN2), rs = numTables * 16 - sr;
  var head2 = new Writer(); head2.u32(0x00010000).u16(numTables).u16(sr).u16(es).u16(rs);
  var dirLen = 12 + numTables * 16;
  var offset = dirLen, records2 = new Writer(), headTableOffset = -1;
  // table data region (each padded to 4)
  var dataRegion = [], padded = [];
  for (var t = 0; t < tables.length; t++) {
    var tb = tables[t].data.slice(); var realLen = tb.length; while (tb.length % 4) tb.push(0);
    records2.tag(tables[t].tag).u32(checksum(tb)).u32(offset).u32(realLen);
    if (tables[t].tag === 'head') headTableOffset = offset;
    padded.push(tb); offset += tb.length;
  }
  var all2 = head2.b.concat(records2.b);
  for (var pp = 0; pp < padded.length; pp++) all2 = all2.concat(padded[pp]);
  // checkSumAdjustment
  var total = checksum(all2);
  var adj = (0xB1B0AFBA - total) >>> 0;
  var hoff = headTableOffset + 8; // checkSumAdjustment field within head
  all2[hoff] = (adj >>> 24) & 0xff; all2[hoff + 1] = (adj >>> 16) & 0xff; all2[hoff + 2] = (adj >>> 8) & 0xff; all2[hoff + 3] = adj & 0xff;

  var buf = new ArrayBuffer(all2.length), dv = new Uint8Array(buf);
  for (var z = 0; z < all2.length; z++) dv[z] = all2[z];
  return buf;
}

module.exports = { buildGlyfFont, cubicToQuads, normalizeWinding };
