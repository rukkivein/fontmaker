'use strict';
// Auto-compose accented/diacritic glyphs from a base letter + a standalone mark
// the user has drawn (é = e + acute, č = c + caron, ç = c + cedilla …). Pure JS,
// no host APIs — runs in the panel and under Node tests. The decomposition set
// is derived from Unicode NFD so it auto-covers Latin-1 + Central-European
// without a hand table; non-composable letters (ø, ł, æ, þ, đ, dotlessi) fall
// out of NFD naturally and are never guessed.

const glyphset = require('./glyphset.js');
const markgen = require('./markgen.js');   // synthesize a mark from existing shapes when none is drawn

// combining codepoint -> mark name; also drives the NFD derivation
const COMBINING_TO_NAME = {
  0x0300: 'grave', 0x0301: 'acute', 0x0302: 'circumflex', 0x0303: 'tilde',
  0x0304: 'macron', 0x0306: 'breve', 0x0307: 'dotaccent', 0x0308: 'dieresis',
  0x030A: 'ring', 0x030B: 'doubleacute', 0x030C: 'caron', 0x0327: 'cedilla', 0x0328: 'ogonek',
};
const ABOVE = { grave: 1, acute: 1, circumflex: 1, tilde: 1, macron: 1, breve: 1, dotaccent: 1, dieresis: 1, ring: 1, doubleacute: 1, caron: 1 };
const BELOW = { cedilla: 1, ogonek: 1 };

// Candidate glyph names for a standalone mark, tried in order. uniXXXX is
// generated to match glyphset.glyphName()'s UPPER-case hex (so caron 'uni030C'
// matches, not 'uni030c').
function uni(cp) { return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0'); }
const MARK_NAME_CANDIDATES = {
  acute: ['acute', uni(0x0301), uni(0x00B4)],
  grave: ['grave', uni(0x0300), uni(0x0060)],
  circumflex: ['circumflex', uni(0x0302), uni(0x02C6)],
  tilde: ['tilde', uni(0x0303), uni(0x02DC)],
  dieresis: ['dieresis', uni(0x0308), uni(0x00A8)],
  ring: ['ring', 'ringabove', uni(0x030A), uni(0x02DA)],
  cedilla: ['cedilla', uni(0x0327), uni(0x00B8)],
  macron: ['macron', uni(0x0304), uni(0x00AF)],
  breve: ['breve', uni(0x0306), uni(0x02D8)],
  ogonek: ['ogonek', uni(0x0328), uni(0x02DB)],
  caron: ['caron', uni(0x030C), uni(0x02C7)],
  dotaccent: ['dotaccent', uni(0x0307), uni(0x02D9)],
  doubleacute: ['hungarumlaut', 'doubleacute', uni(0x030B), uni(0x02DD)],
};

function deriveDecompose(codepoints) {
  const map = {};
  for (const cp of codepoints) {
    let nfd;
    try { nfd = Array.from(String.fromCodePoint(cp).normalize('NFD')); }
    catch (e) { continue; }
    if (nfd.length < 2) continue;
    const baseCp = nfd[0].codePointAt(0);
    const marks = nfd.slice(1).map((c) => COMBINING_TO_NAME[c.codePointAt(0)]).filter(Boolean);
    if (marks.length !== nfd.length - 1) continue;   // a mark we don't handle
    // only plain ASCII letters as base (skip ǘ-style stacked or special bases)
    if (!((baseCp >= 0x41 && baseCp <= 0x5A) || (baseCp >= 0x61 && baseCp <= 0x7A))) continue;
    map[cp] = { base: baseCp, marks };
  }
  return map;
}

const LATIN1 = []; for (let c = 0x00C0; c <= 0x00FF; c++) if (c !== 0x00D7 && c !== 0x00F7) LATIN1.push(c);
const CE = [
  0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0107, 0x010C, 0x010D, 0x010E, 0x010F,
  0x0112, 0x0113, 0x0116, 0x0117, 0x0118, 0x0119, 0x011A, 0x011B, 0x011E, 0x011F, 0x0130, 0x0143, 0x0144,
  0x0147, 0x0148, 0x0150, 0x0151, 0x0154, 0x0155, 0x0158, 0x0159, 0x015A, 0x015B, 0x0160, 0x0161,
  0x015E, 0x015F, 0x0164, 0x0165, 0x016E, 0x016F, 0x0170, 0x0171, 0x0179, 0x017A, 0x017B, 0x017C, 0x017D, 0x017E,
];
// 0x0130 = İ (Turkish dotted capital I): NFD = I + U+0307 dotaccent, fully composable.
// ı (U+0131) has NO decomposition — NFD-derived by design, it stays a draw-by-hand letter.
const DECOMPOSE = deriveDecompose(LATIN1.concat(CE));

function cloneContours(contours) {
  return contours.map((c) => ({
    closed: c.closed,
    points: c.points.map((p) => ({
      x: p.x, y: p.y, type: p.type,
      handleIn: p.handleIn ? { x: p.handleIn.x, y: p.handleIn.y } : null,
      handleOut: p.handleOut ? { x: p.handleOut.x, y: p.handleOut.y } : null,
    })),
  }));
}
function translateContours(contours, dx, dy) {
  contours.forEach((c) => c.points.forEach((p) => {
    p.x += dx; p.y += dy;
    if (p.handleIn) { p.handleIn.x += dx; p.handleIn.y += dy; }
    if (p.handleOut) { p.handleOut.x += dx; p.handleOut.y += dy; }
  }));
  return contours;
}
function layerOf(project, g, masterId) { return g.layers && g.layers[masterId]; }
function drawn(layer) { return !!(layer && layer.contours && layer.contours.length); }

function findByChar(project, ch) { return project.glyphs.find((g) => g.char === ch); }
function findMarkGlyph(project, markName, masterId) {
  const cands = MARK_NAME_CANDIDATES[markName] || [markName];
  for (const nm of cands) {
    const g = project.glyphs.find((x) => x.name === nm);
    if (g && drawn(layerOf(project, g, masterId))) return g;
  }
  return null;
}

// Compose one accented glyph (by target char) into masterId. Returns a status.
function composeAccent(project, targetChar, masterId, opts) {
  opts = opts || {};
  const cp = targetChar.codePointAt(0);
  const dec = DECOMPOSE[cp];
  if (!dec) return { ok: false, reason: 'not-decomposable' };
  const target = findByChar(project, targetChar);
  if (!target) return { ok: false, reason: 'no-target-slot' };
  // HAND-DRAWN accented glyphs are sacred: only overwrite a drawn target when we composed
  // it ourselves (composedFrom marker → keep refreshing it) or the caller explicitly forces.
  // Without this, the implicit composeAll runs (Auto Marks, marks-template import) silently
  // destroyed a user's hand-drawn ş/ğ/ö artwork.
  if (drawn(layerOf(project, target, masterId)) && !target.composedFrom && !opts.force) {
    return { ok: false, reason: 'target-drawn' };
  }
  const baseChar = String.fromCodePoint(dec.base);
  const baseG = findByChar(project, baseChar);
  if (!baseG || !drawn(layerOf(project, baseG, masterId))) return { ok: false, reason: 'base-not-drawn:' + baseChar };

  const M = project.metrics || {};
  const capH = M.capHeight || 716, xH = M.xHeight || 519;
  // Fold any blue-line (LSB) offset out of the base + marks so the composed glyph
  // lives in the same origin-0 space export/preview assume — otherwise the base of
  // "é" would be shifted relative to a standalone "e". advance is the box width,
  // which is independent of lsbLineX, so it copies across unchanged.
  const baseLx = baseG.lsbLineX || 0;
  const out = cloneContours(layerOf(project, baseG, masterId).contours);
  if (baseLx) translateContours(out, -baseLx, 0);
  const baseB = glyphset.contoursBounds(out);
  if (!baseB) return { ok: false, reason: 'base-empty' };
  const baseIsUpper = dec.base >= 0x41 && dec.base <= 0x5A;
  const gap = Math.round((M.unitsPerEm || project.unitsPerEm || 1000) * 0.06);

  const derived = [];
  for (const markName of dec.marks) {
    let mk = null;
    const markG = findMarkGlyph(project, markName, masterId);   // a user-drawn mark always wins
    if (markG) {
      mk = cloneContours(layerOf(project, markG, masterId).contours);
      const markLx = markG.lsbLineX || 0;
      if (markLx) translateContours(mk, -markLx, 0);
    } else if (opts.deriveMarks !== false) {                    // else synthesize it from existing shapes
      const d = markgen.deriveMark(project, markName, masterId);
      if (d && d.contours && d.contours.length) { mk = d.contours; derived.push(markName); }
    }
    if (!mk) return { ok: false, reason: 'mark-not-drawn:' + markName };
    const markB = glyphset.contoursBounds(mk);
    if (!markB) return { ok: false, reason: 'mark-empty:' + markName };
    // horizontal: center the mark on the base
    const baseCx = baseB.minX + baseB.w / 2, markCx = markB.minX + markB.w / 2;
    let dx = baseCx - markCx;
    // vertical: above marks sit a gap over the base's top (cap or x-height ref);
    // below marks (cedilla/ogonek) hang under the baseline at the base's bottom
    let dy;
    if (BELOW[markName]) {
      dy = baseB.minY - gap - markB.maxY;
    } else {
      const topRef = baseIsUpper ? Math.max(baseB.maxY, capH) : Math.max(baseB.maxY, xH);
      dy = topRef + gap - markB.minY;
    }
    translateContours(mk, Math.round(dx), Math.round(dy));
    mk.forEach((c) => out.push(c));
  }

  target.layers[masterId] = { contours: out };
  target.advanceWidth = baseG.advanceWidth;
  target.lsbLineX = 0;   // the composed outline is already baked to the origin
  target.composedFrom = baseChar;
  if (!target.kind) target.kind = 'composed';
  return { ok: true, base: baseChar, marks: dec.marks, derived: derived };
}

// Compose every decomposable target whose base + marks are drawn. Returns
// { composed, skipped:[{char,reason}] }.
function composeAll(project, masterId, opts) {
  masterId = masterId || (project.masters && project.masters[0] && project.masters[0].id);
  const composed = [], skipped = [];
  let withDerived = 0;
  for (const cpStr of Object.keys(DECOMPOSE)) {
    const cp = +cpStr, ch = String.fromCodePoint(cp);
    const r = composeAccent(project, ch, masterId, opts);
    if (r.ok) { composed.push(ch); if (r.derived && r.derived.length) withDerived++; }
    else if (r.reason !== 'no-target-slot') skipped.push({ char: ch, reason: r.reason });
  }
  return { composed, skipped, withDerived };
}

module.exports = { DECOMPOSE, COMBINING_TO_NAME, MARK_NAME_CANDIDATES, composeAccent, composeAll, deriveDecompose };
