# RuneType™ Glyphmaker — Handoff

_Last updated: 2026-06 (this session) · branch `claude/inspiring-bardeen-fqkF4` · repo `rukkivein/fontmaker`_
_This file is **editable**. Newest work is in **§ This session**; the variable-font state (for the
second AI) is in **§ Variable fonts**._

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
   shape, the blue **LSB** line, the red **advance** line (all independent); a 3-state
   **hand** pan-tool (blue=pan → red=lock → reset). Tools: **Optimize** + **Auto Kern**
   (kern table), the **Standard / Optical / Profile / Space** sliders (the new spacing
   system — see § This session), an **experimental optimisation** block, the **✦ Analyze**
   assistant, and a **⊞ Live Test** floating preview. (Note: the old size-changing
   "Auto Fit / Optimize Test" were removed — font size never auto-changes.)
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

## This session (2026-06) — spacing system, optical/AI, template, perf

Major additions on top of the state above:

- **Reference spacing — the "X value"** (`shared/refspace.js`, unit-tested in `test/refspace.test.js`).
  In **modification**, three stacked, **horizontal-only, never-resizing** sliders:
  - **Standard (0–200%)** — every glyph's side bearings set to the average of **Arial + Times
    New Roman** bearings (read live from `C:\Windows\Fonts\arial.ttf`/`times.ttf` via opentype,
    as em-fractions). 100% = the classic consensus (I tight, W open), >100% widens, <100% tightens.
    It **never** uses the font's own values, so it can't fall back to the original.
  - **Optical (0–100%)** — nudges each glyph toward its ink **area centroid** (mass) within the
    Standard bearings; advance box (blue/red lines) stays put.
  - **Profile (0–100%, experimental)** — same idea but by the **silhouette** profile.
  - **Space (0–80%)** — the space glyph's advance as % of em; in both testing AND modification.
  - All compose; apply live on drag (cheap render only), commit on release.
- **Experimental optimisation** block + **✦ Analyze** — a tiny **no-API** assistant: local
  heuristics that flag tight/loose spacing outliers, cap-height inconsistency, coverage %, and
  glyphs sitting off the baseline (↑/↓ suggestion), plus one suggested next move.
- **Template overhaul:** selected sets each on their own row, wrap at 50/row, tiny set captions,
  artboard anchored top-left and hugging content, ~13% wider cells, ghosts seated by **real Arial
  per-char y-bounds** (passed from `main.js`), so `_` sits low, `-` mid, accents high. GPU fixes:
  ghosts are **solid gray** (no transparency → no driver TDR), artwork scan de-quadratic, and the
  whole sheet builds at **`FM_TPL_SCALE = 0.1`** (was 0.25) → a ~2000–3000pt document instead of
  ~8000×5000 (much lighter on low-RAM machines). Import preserves drawn size & position exactly.
- **Reset/rescue:** floating **⟳** button (top-right) → modal (Save .runetype & Reset / Reset /
  Cancel) → `hardReset()` clears caches + reloads the panel.
- **Live Test window:** floating, in-panel (NOT a 2nd OS window → RAM-safe), updates live with
  spacing/kern/space changes.
- **Perf:** the live-sync poller is now **adaptive** (700ms→3s when idle, sleeps when the panel is
  hidden via Page Visibility) and spacing drags do only the light metrics-editor render.
- **Misc:** grid thumbnails scale to the em (`.` small, `H` cap-height); punctuation reorganised
  (one "Basic Punctuation" set + a separate "Punctuation Extended"); **EDITION flipped to `'pro'`**.

### Image Import (auto-trace reference sheets → auto-fill the grid)
**glyphs.** page has an **⊕ Image Import** button (in the alt/lig/accent row). Pick 1–4 raster
sheets (numbers / uppercase+accents / lowercase+accents / punctuation — in ANY order); the panel
traces each, splits it into glyphs, guesses each character, shows a **review dialog**, and on
confirm seats the chosen glyphs into the active master. The dialog is the safety net: per-sheet
**set** dropdown (overrides auto-detect) + an editable **character box** under every traced glyph
(clear a box to skip it). Filling reuses `glyphset.setGlyphContours` so it behaves like any other
assignment; matches existing glyph slots by unicode and reports any chars not in the font's sets.

Pipeline (clustering/detection/mapping/seating are pure JS, unit-tested in `test/imgimport.test.js`):
- **Vectorize = Illustrator's own Image Trace** (jsx `fmTraceImage` → `PlacedItem.trace()` +
  `tracing.expandTracing()` in a throwaway doc): `fmPickImages` shows a native multi-select dialog,
  then each sheet is traced B/W and expanded to paths; `fmCollectTrace` drops light/background
  fills (robust even where v28+ `ignoreWhite` is a no-op) so counters (o a 0 8…) stay as real
  compound-path HOLES. `imgglyphs.contoursFromTracePaths(paths, bounds)` converts Illustrator's
  Y-UP path points to pixel space (Y-down, flipped against the traced group's bounds). **Replaced
  the old JS tracer** — imagetracerjs filled counters and was glitchy on decorative faces. (Legacy
  `shared/imagetrace.js` + imagetracerjs stay bundled but unused; remove later if desired.)
- `shared/imgglyphs.js` — the geometry brain: `clusterGlyphs` (rows by Y-whitespace, then columns
  by X-overlap, so i=stem+dot, ==two bars, accent=base+mark each merge into ONE glyph while
  neighbours stay separate), `detectCategory` (digits/upper/lower/symbols from glyph count, height
  uniformity, x-height ratio, baseline scatter), `SEQ` (canonical char order transcribed from the 4
  reference sheets), `mapClusters`, and `seatClusters` (per-sheet scale from the dominant ascent =
  cap/x-height line via `modeApprox`, each glyph on its row baseline → accents float up, descenders
  drop below; outputs font-unit contours for `setGlyphContours`).
- Panel side (`cep/js/main.js`, search "IMAGE IMPORT"): file decode via Chromium `<canvas>`
  (downscales to ≤1500px, flattens alpha to white — no PNG-decoder dep), the review modal, and
  commit. `scripts/sync-cep.js` bundles both modules + the tracer; `cepsync.test.js` guards drift.
- **Not edition-gated yet** — if Image Import should be a pro feature, add a `FEATURES.imageImport`
  gate in `shared/features.js` and early-return in `onImgImportClick` (mirror the accents/optimize
  pattern). Tuning knobs live in `imagetrace.DEFAULT_TRACE` (pathomit/ltres/qtres) and the
  `clusterGlyphs` rowTol/xTol if real sheets cluster wrong.

## Variable fonts (READ THIS — the second-AI target area)

- **Masters exist** as data: `project.masters[]` (`{id,name,type}`) + per-glyph
  `layers[masterId].contours`. `glyphset.addMaster()` adds an empty layer to every glyph.
- **`shared/varCompat.js` is ready:** `report(f)` checks interpolation compatibility (same contour
  & point counts across masters); `matchPoints(f)` aligns start points/rotation. No changes needed.
- **What's MISSING:** a single-file **fvar/gvar** variable font is **not produced yet**. Today the
  "Variable" export (`cep/js/main.js` ~1975) only validates compatibility, writes a
  `-variable-report.txt`, and exports **each master as a separate file**. Code note: *"a single-file
  .ttf with fvar/gvar is the follow-up."*
- **To implement real variable export (in order):**
  1. `core/fontEngine.js` — extend `buildFont` to take multiple master ids → emit **fvar** (axes)
     + **gvar** (per-glyph point deltas).
  2. `core/ttfWriter.js` — write the **gvar** binary (per-master point deltas) alongside glyf.
     (Note: bundled opentype.js 1.3.4 writes CFF/OTTO only, so TTF/variable go through `ttfWriter`.)
  3. `cep/js/main.js` (~1975) — rewire the export to produce one variable file from the compatible
     masters instead of looping.
  4. `shared/features.js` — `exportVariable` gate (already defined).

## Edition gating — current = **`pro`** (full); alpha is the free build
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
