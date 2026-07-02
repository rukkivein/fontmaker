// Inject a legacy format-0 'kern' table into a finished sfnt (OTF/TTF) buffer.
//
// WHY THIS EXISTS: the tester previews pair-kerning straight from f.kerning, but
// the export path can't emit it — opentype.js's writer drops GPOS/kern entirely
// ("NOT SUPPORTED" stub), and ttfWriter emits no GPOS either. So every kern pair
// the user tunes in "testing." was shown on screen yet ABSENT from the shipped
// font (a confirmed "the tester misleads me" bug). We splice a Microsoft format-0
// 'kern' subtable (the one opentype.js CAN still parse) into the final buffer,
// AFTER any re-serialization, so the exported file actually reproduces the kerning.
//
// f.kerning keys are "leftName,rightName" → value in font units (positive = open,
// matching the tester's margin-right convention and the OT 'kern' value sign).
// GID order matches fontEngine.buildFont: .notdef = 0, then project.glyphs[i] = i+1.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.kerninject = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function pad4(n) { return (n + 3) & ~3; }

  // sum of big-endian uint32 words over the (already 4-aligned) region; missing
  // tail bytes count as 0 so a short final word is handled.
  function tableChecksum(u8) {
    var sum = 0, n = u8.length;
    for (var i = 0; i < n; i += 4) {
      var w = (((u8[i] || 0) << 24) >>> 0) + (((u8[i + 1] || 0) << 16)) + (((u8[i + 2] || 0) << 8)) + (u8[i + 3] || 0);
      sum = (sum + w) >>> 0;
    }
    return sum >>> 0;
  }

  // A format-0 subtable's 'length' field is uint16, so 14 + 6*nPairs must fit in
  // 65535 → at most 10920 pairs per subtable. Bigger fonts get split into several
  // subtables (the 'kern' header's nTables carries them; pairs stay disjoint).
  var MAX_PER_SUB = 10920;

  function writeKernSubtable0(dv, o, pairs) {
    var n = pairs.length, subLen = 14 + n * 6;
    dv.setUint16(o, 0); o += 2;               // subtable version
    dv.setUint16(o, subLen); o += 2;          // subtable length
    dv.setUint16(o, 0x0001); o += 2;          // coverage: horizontal, format 0
    var es = n > 0 ? Math.floor(Math.log(n) / Math.LN2) : 0;
    var sr = 6 * Math.pow(2, es);
    dv.setUint16(o, n); o += 2;               // nPairs
    dv.setUint16(o, sr); o += 2;              // searchRange
    dv.setUint16(o, es); o += 2;              // entrySelector
    dv.setUint16(o, 6 * n - sr); o += 2;      // rangeShift
    for (var i = 0; i < n; i++) {
      dv.setUint16(o, pairs[i].l); o += 2;
      dv.setUint16(o, pairs[i].r); o += 2;
      dv.setInt16(o, pairs[i].v); o += 2;
    }
    return o;
  }

  // Build the whole format-0 'kern' table bytes. pairs: [{l,r,v}] sorted by (l,r).
  function buildKernFormat0(pairs) {
    var chunks = [];
    for (var i = 0; i < pairs.length; i += MAX_PER_SUB) chunks.push(pairs.slice(i, i + MAX_PER_SUB));
    if (!chunks.length) chunks.push([]);
    var total = 4;                            // kern header
    chunks.forEach(function (c) { total += 14 + c.length * 6; });
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint16(0, 0);                        // kern table version
    dv.setUint16(2, chunks.length);           // nTables (subtables)
    var o = 4;
    chunks.forEach(function (c) { o = writeKernSubtable0(dv, o, c); });
    return out;
  }

  // Re-serialize an sfnt from a {tag,data} table list with correct directory,
  // 4-byte padding, per-table checksums and head.checkSumAdjustment.
  function serializeSfnt(sfntVersion, tables) {
    tables.sort(function (a, b) { return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0; });
    var numTables = tables.length;
    var offset = 12 + numTables * 16;
    tables.forEach(function (t) { t.offset = offset; t.length = t.data.length; offset = pad4(offset + t.data.length); });
    var out = new Uint8Array(offset);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, sfntVersion >>> 0);
    dv.setUint16(4, numTables);
    var es = Math.floor(Math.log(numTables) / Math.LN2);
    var sr = Math.pow(2, es) * 16;
    dv.setUint16(6, sr);
    dv.setUint16(8, es);
    dv.setUint16(10, numTables * 16 - sr);
    var headOffset = -1;
    tables.forEach(function (t, i) {
      var rec = 12 + i * 16;
      out[rec] = t.tag.charCodeAt(0); out[rec + 1] = t.tag.charCodeAt(1);
      out[rec + 2] = t.tag.charCodeAt(2); out[rec + 3] = t.tag.charCodeAt(3);
      dv.setUint32(rec + 8, t.offset);
      dv.setUint32(rec + 12, t.length);
      out.set(t.data, t.offset);
      if (t.tag === 'head') headOffset = t.offset;
    });
    if (headOffset >= 0) dv.setUint32(headOffset + 8, 0);  // zero checkSumAdjustment before any checksum
    tables.forEach(function (t, i) {
      dv.setUint32(12 + i * 16 + 4, tableChecksum(out.subarray(t.offset, pad4(t.offset + t.length))));
    });
    if (headOffset >= 0) dv.setUint32(headOffset + 8, (0xB1B0AFBA - tableChecksum(out)) >>> 0);
    return out.buffer;
  }

  // buffer: ArrayBuffer | Uint8Array | Buffer of a finished sfnt.
  // kerning: { "L,R": units }. glyphs: the build's glyph array (gid = index+1).
  // Returns a new ArrayBuffer with the 'kern' table added (or the original bytes
  // as an ArrayBuffer when there is nothing to add).
  function injectKernTable(buffer, kerning, glyphs) {
    var u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!kerning || !glyphs) return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    var gid = {};
    for (var i = 0; i < glyphs.length; i++) gid[glyphs[i].name] = i + 1;   // .notdef = 0
    var pairs = [];
    Object.keys(kerning).forEach(function (k) {
      var v = Math.round(kerning[k]); if (!v) return;
      var c = k.indexOf(','); if (c < 0) return;
      var L = gid[k.slice(0, c)], R = gid[k.slice(c + 1)];
      if (L == null || R == null) return;
      v = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
      pairs.push({ l: L, r: R, v: v });
    });
    if (!pairs.length) return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    pairs.sort(function (a, b) { return (a.l - b.l) || (a.r - b.r); });

    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var sfntVersion = dv.getUint32(0);
    var numTables = dv.getUint16(4);
    var tables = [];
    for (var t = 0; t < numTables; t++) {
      var rec = 12 + t * 16;
      var tag = String.fromCharCode(u8[rec], u8[rec + 1], u8[rec + 2], u8[rec + 3]);
      var off = dv.getUint32(rec + 8), len = dv.getUint32(rec + 12);
      tables.push({ tag: tag, data: u8.subarray(off, off + len) });
    }
    var kern = buildKernFormat0(pairs);
    var existing = null;
    for (var j = 0; j < tables.length; j++) if (tables[j].tag === 'kern') { existing = tables[j]; break; }
    if (existing) existing.data = kern; else tables.push({ tag: 'kern', data: kern });
    return serializeSfnt(sfntVersion, tables);
  }

  return { injectKernTable: injectKernTable, buildKernFormat0: buildKernFormat0 };
}));
