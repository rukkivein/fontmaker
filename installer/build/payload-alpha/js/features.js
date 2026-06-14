'use strict';
// ─────────────────────────────────────────────────────────────────────────
// Edition gating — ONE source of truth. Flip EDITION to 'pro' to unlock the
// full premium surface in a single line; everything in the panel reads FEATURES
// (no scattered flags). Pure CommonJS so the CEP panel and the Node tests share
// it. Synced into cep/js/features.js by scripts/sync-cep.js.
// ─────────────────────────────────────────────────────────────────────────
var EDITION = 'alpha';            // 'alpha' (free) | 'pro' (paid)

var EDITIONS = {
  // Free alpha: only the core loop is open —
  //   draw → assign → live preview → metrics → OTF export → .runetype save/reopen.
  // The premium surface is gated off so the paid tool can't be run for free.
  alpha: {
    label: 'Alpha',
    masters: false,                       // single "Regular" master only (no multi-master)
    exportOtf: true,                      // OTF is the core deliverable — always on
    exportTtf: false,                     // TTF = pro
    exportVariable: false,                // variable/multi-master = pro
    fontImport: false,                    // open an existing .otf/.ttf to edit (.runetype reopen always on)
    accents: false,                       // + Accents auto-compose (é/ç/ş…)
    optimize: false,                      // Optimize + Auto Kern mini-AI (Auto Fit stays on)
    alternates: false,                    // + Alternate / + Ligature + per-occurrence swap
    gridPresets: false,                   // only the default grid; no preset menu / Grid pill
    charsets: ['latinUpper', 'numbers'],  // New Font sets offered (null = all sets)
    emptyGlyphArt: 'bosharf',             // placeholder art assets/<art>.svg for empty cells (null = letter ghost)
  },
  // Paid: the whole tool.
  pro: {
    label: 'Pro',
    masters: true,
    exportOtf: true,
    exportTtf: true,
    exportVariable: true,
    fontImport: true,
    accents: true,
    optimize: true,
    alternates: true,
    gridPresets: true,
    charsets: null,
    emptyGlyphArt: null,
  },
};

var FEATURES = EDITIONS[EDITION] || EDITIONS.pro;

module.exports = { EDITION, FEATURES, EDITIONS };
