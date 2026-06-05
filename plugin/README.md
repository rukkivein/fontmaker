# FontMaker — Illustrator UXP Plugin

Assign artwork you draw in Illustrator to glyph slots and export a real OTF,
using the same host-agnostic engine (`core/fontEngine.js`) as the desktop app.

## Layout
```
plugin/
  manifest.json     UXP manifest (v5, host ILST / Illustrator 27+)
  index.html        panel markup
  styles.css        graphite-glass panel styling
  panel.js          controller: selection → glyph, OTF export
  src/ilbridge.js   Illustrator pathPoints → FontMaker contour model (pure, tested)
  src/glyphset.js   project model + cap-height assignment (pure, tested)
  lib/fontEngine.js bundled copy of core/fontEngine.js (require path rewritten)
  lib/opentype.js   bundled opentype.js dist
```

`lib/` is generated — never edit by hand. After changing `core/fontEngine.js`
run `npm run plugin:sync`. `test/pluginsync.test.js` fails if `lib/` drifts.

## How it works
1. Draw letters as paths/compound paths in Illustrator.
2. Select the artwork, click a glyph slot in the panel, click **Assign**.
   - `src/ilbridge.js` reads `selection → pathItems → pathPoints`
     (`anchor`, `leftDirection`→handleIn, `rightDirection`→handleOut), flips Y
     (Illustrator is Y-down), and builds our contour model.
   - `src/glyphset.js` scales it to cap height, sits it on the baseline, and
     writes it to every master (variable-compatible start).
3. Click **Export OTF** → `core/fontEngine.js` builds the font (winding
   normalized, GSUB for alternates/ligatures) and UXP's file API saves it.

The full pipeline (mock selection → bridge → assign → buildFont → reload) is
covered headlessly by `test/uxpbridge.test.js`.

## Loading in Illustrator (developer)
Live load needs the **UXP Developer Tool (UDT)** — install it from the Creative
Cloud desktop app (Marketplace → search "UXP Developer Tool"), or via
`@adobe/uxp-devtools-cli`. Then:
1. Open Illustrator (2025 or 2026 — both ≥ 27.0).
2. UDT → **Add Plugin** → select `plugin/manifest.json` → **Load**.
3. Window ▸ FontMaker opens the panel.

## Known unknowns to verify on first real load
- **Host code / minVersion**: manifest uses `"app": "ILST"`. If Illustrator's
  loader rejects it, its error names the expected code/version — one-line fix.
- **DOM access**: `panel.js` getApp() tries `require('illustrator').app` then a
  global `app`. Confirm which Illustrator exposes and pin it.
- **opentype.js under UXP**: pure JS, expected to run; if the engine throws on a
  missing `Buffer`/`DataView`, add a small polyfill in `panel.js` before require.
- **File write**: uses `uxp.storage.localFileSystem.getFileForSaving` +
  `file.write(buffer, { format: binary })`.
