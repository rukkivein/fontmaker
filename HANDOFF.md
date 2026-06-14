# RuneType™ Glyphmaker — Handoff

_Last updated: 2026-06-14 · branch `claude/inspiring-bardeen-fqkF4` · tip `52db33f`_

## What it is
RuneType™ Glyphmaker by **BRST STUDIO** — a tool that turns shapes drawn in **Adobe
Illustrator** into real fonts (**OTF**, **TTF**, and a multi-master/variable groundwork).
Fontself/Glyphs-inspired but more detailed (a construction-grid system + "Font DNA" +
metrics/kerning editor + a small offline "smart" spacing/kerning pass). It is an
**Illustrator CEP panel** (NOT UXP — third-party UXP is unavailable for Illustrator;
CEP is the only way to ship an Illustrator panel, which is also how Fontself does it).

## Where everything lives
| Thing | Location |
|---|---|
| Git repo | `github.com/rukkivein/fontmaker` (working branch: `claude/inspiring-bardeen-fqkF4` — this IS the default branch, all work is here) |
| Local clone | `C:\Users\okana\fontmaker` |
| Installed panel (live in Illustrator) | `%APPDATA%\Adobe\CEP\extensions\com.fontmaker.illustrator` |
| One-click installer (EXE) | `C:\Users\okana\Desktop\RuneType_Glyphmaker_Setup.exe` (built by Inno Setup) |
| Source backup (zip) | `C:\Users\okana\Desktop\RuneType_Glyphmaker_backup_20260614.zip` |
| Inno Setup compiler | `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe` |

## How to install / open it
- **End user:** run `RuneType_Glyphmaker_Setup.exe` (per-user, no admin — copies the
  panel into the CEP extensions folder and enables unsigned CEP extensions). Then open
  Illustrator ▸ **Window ▸ Extensions ▸ RuneType Glyphmaker**.
- **From source (dev):** `npm install`, then `npm run cep:install` (bundles shared code
  into `cep/js` and copies `cep/` into the extensions folder). Reload the panel in
  Illustrator after each change.

## How you actually make a font (the workflow)
1. **New Font** (page 1): name it, pick character sets + a style preset (grid), masters.
2. **glyphs.** (page 2): draw a shape in Illustrator, then **assign** it to a glyph slot
   (drag the Assign handle onto a cell, double-click a cell, or drop a shape). Click a
   cell to open that glyph as its own Illustrator document for editing (edits sync live).
   Right-click a cell → Delete shape / Delete glyph / Open in Illustrator.
3. **modification.** (kerning & metrics): the right pane is a metrics editor — drag the
   shape, the blue **LSB** line, the red **advance** line (all independent); a **hand**
   pan-tool (top-left) for zoom/pan; **Auto Fit**, **Auto Kern**, and **Optimize** (the
   offline "mini-AI" spacing/kerning pass).
4. **testing.** (type & preview): a live @font-face preview; click a letter to tune its
   spacing in the metrics editor; **right-click a letter to swap in one of its alternates**
   for that occurrence only.
5. **save.** (signature + export): metadata fields + **Export to Folder** (OTF/TTF/Variable),
   **Save Project (.runetype)**, **Open File** (reopen a .runetype OR import an existing
   .otf/.ttf to edit).

## Architecture (the important files)
- `core/fontEngine.js` — host-agnostic font builder (pure JS + opentype.js; **do not break**
  — reused everywhere). `core/ttfWriter.js` — real `glyf` TTF writer (cubic→quad, fontTools-validated).
- `shared/` — `glyphset.js` (project/glyph model + charsets), `dna.js` (Font DNA presets →
  grids), `charsets.js`, `optimizer.js` (the spacing/kerning "mini-AI"), `accentCompose.js`
  (auto é/ç/ş… from base + mark), `varCompat.js` (master interpolation compatibility),
  `ilbridge.js` (Illustrator-path ↔ font-unit geometry).
- `cep/` — the panel: `index.html`, `css/styles.css`, `js/main.js` (~2k lines, the controller),
  `jsx/fontmaker.jsx` (ExtendScript that runs inside Illustrator — opens/draws glyph docs,
  reads selection geometry, writes compound paths so counters are holes).
- `scripts/sync-cep.js` — bundles `shared/` + `core/` into `cep/js` (so the installed panel
  is self-contained). `test/cepsync.test.js` fails if `cep/js` drifts → always `npm run cep:sync`/`cep:install`.
- `installer/runetype.iss` — Inno Setup script → the Setup EXE.

## Build / test / package commands (run from `C:\Users\okana\fontmaker`)
```
npm install                 # deps (opentype.js etc.)
npm test                    # all suites (structural, sync, finalize.verify, fontTools TTF gate)
npm run cep:install         # sync shared→cep/js AND copy cep/ → installed extension
"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\runetype.iss   # rebuild the EXE
```

## Key facts & caveats (so you don't relearn them)
- **CEP, not UXP** (UXP isn't available for Illustrator). The panel runs Node, so
  `require`/`fs`/`Buffer` are native — no polyfills.
- **Illustrator DOM is Y-UP** — geometry is NOT flipped. opentype.js `glyph.path.commands`
  are also y-up font units (it only flips in `getPath`), so font import needs no flip.
- **opentype.js 1.3.4 writes OTTO/CFF only** (no glyf/variable) — that's why TTF has its own
  `ttfWriter.js`, and single-file variable (fvar/gvar) is still a marked follow-up.
- After editing `cep/`/`shared/`/`core/`, **always `npm run cep:install`** (not just sync) or
  the user tests a stale panel in Illustrator.
- ExtendScript (`cep/jsx`) can't be tested in a browser — its pure-JS bits are unit-tested in
  Node; the rest is verified live in Illustrator by the user.

## Current state
Working end-to-end: draw → assign → modify (independent LSB/advance/shape, pan/zoom,
infinite grid, auto-fit/kern/optimize) → test (live preview, per-letter spacing, alternate
swap) → save/export (OTF + TTF, .runetype save+reopen, OTF/TTF import for editing). Glyphs
with counters (O/D/B…) draw as compound paths (holes). UI verified responsive / no overflow
on 1920×1080 (and the user's 4K). All tests green; EXE + backup on the Desktop.

## Edition gating — free **alpha** is SHIPPED (2026-06-14)
One flag drives the whole premium surface: **`shared/features.js`** → `EDITION = 'alpha' | 'pro'`
(exposes `FEATURES`). Flip to `'pro'` = one line, everything unlocks. Synced into
`cep/js/features.js` (in `sync-cep.js`; guarded by `cepsync.test.js`).

Alpha gates (all premium controls are **disabled/greyed in place, not hidden** — an upsell):
- **Masters** → single "Regular" (page-1 add + page-2 picker disabled).
- **Export** → OTF only (TTF/Variable checkboxes disabled; `onExportGo` also gates them).
- **Font import** → `.runetype` reopen only; opening an existing `.otf/.ttf` to edit is blocked.
- **+Accents**, **Optimize**, **Auto Kern** → disabled (**Auto Fit stays on**).
- **+Alternate / +Ligature** + the tester's right-click alternate swap → disabled.
- **Grid presets** → page-1 Grid pill + the designer's `Preset…` menu disabled (default grid only).
- **Character sets** → only Latin Uppercase + Numbers selectable; the rest show greyed with a "Pro"
  tag; country auto-select disabled.
- Every handler also early-returns on its flag (defense-in-depth), so unhiding a control still no-ops.

**Empty-glyph art ("boş harf"):** undrawn slots still show their letter in the grid, but at EXPORT
every undrawn encoded slot is filled with **`bosharf.svg`** so a half-finished free font exports a
complete, branded set (can't be passed off as done). Pipeline: `scripts/bake-bosharf.js` parses the
138-path SVG (incl. arcs) → `shared/bosharf.json` (font-unit contours, baseline-seated, ~823 pts);
`shared/placeholder.js` `fillEmptyGlyphs()` injects it post-clean in `buildCleanOtf/Ttf`
(`FEATURES.emptyGlyphArt`). Re-bake after editing the SVG: `node scripts/bake-bosharf.js`.
Tests: `features.test.js`, `placeholder.test.js`, `bosharf-export.test.js` (builds a real OTF).

## Next
- Single-file variable (`fvar`/`gvar`) TTF is still the open follow-up (pro).
- When monetizing: flip `EDITION` to `'pro'` in `shared/features.js` for the paid build.
