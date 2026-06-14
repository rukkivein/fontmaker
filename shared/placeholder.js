'use strict';
// Fill every undrawn glyph slot of a master with a placeholder outline, so an
// unfinished free-edition font still exports a COMPLETE, branded glyph set (the
// "boş harf" mark) instead of blank/.notdef boxes — and a half-done free font
// can't be passed off as finished. Pure data (no font lib) → runs in the panel
// and in Node tests alike. Call on a CLEANED project copy, just before build.
function isEmptyLayer(g, mid) {
  var l = g.layers && g.layers[mid];
  return !(l && l.contours && l.contours.length);
}

// project: a (cleaned) project copy — mutated in place.
// masterId: which master's layers to fill.
// placeholder: { contours:[...], advanceWidth } in the project's font units.
// Returns the number of slots filled. Only encoded slots are touched; helper
// glyphs with no codepoint (e.g. .notdef) are left alone.
function fillEmptyGlyphs(project, masterId, placeholder) {
  if (!project || !project.glyphs || !placeholder || !placeholder.contours || !placeholder.contours.length) return 0;
  var n = 0;
  for (var i = 0; i < project.glyphs.length; i++) {
    var g = project.glyphs[i];
    if (g.unicode == null && g.char == null) continue;     // unencoded/helper slot
    if (g.unicode === 32 || g.char === ' ') continue;      // space stays blank
    if (!isEmptyLayer(g, masterId)) continue;              // already drawn — keep it
    g.layers = g.layers || {};
    g.layers[masterId] = { contours: JSON.parse(JSON.stringify(placeholder.contours)) };
    if (placeholder.advanceWidth) g.advanceWidth = placeholder.advanceWidth;
    g.lsbLineX = 0;
    n++;
  }
  return n;
}

module.exports = { fillEmptyGlyphs, isEmptyLayer };
