# RuneType™ Glyphmaker — Project Handoff

_Last updated: 2026-06-26 · local: `C:\Users\okana\fontmaker` · installed: `%APPDATA%\Adobe\CEP\extensions\com.fontmaker.illustrator` · edition: **pro**_

Hand this file to a new maintainer (human or AI). It is **self-contained** — you should not need any other doc to get oriented, build, and extend the project. Newest work is in **§9 This session**; the most important traps are in **§10 Critical gotchas**.

---

## 1. What it is

**RuneType™ Glyphmaker** (BRST STUDIO) turns shapes drawn in **Adobe Illustrator** into real fonts (**OTF**, **TTF**, variable-font groundwork). Fontself/Glyphs-inspired but more detailed: a construction-grid system, "Font DNA" presets, a metrics/kerning editor, an **optical-centre** spacing editor, and small **offline** ML passes (sidebearing model, glyph recognizer, vector refiner).

It is an **Adobe Illustrator CEP panel** — Chromium UI + Node runtime — **not UXP** (third-party UXP is unavailable for Illustrator; CEP is the only way to ship an Illustrator panel, and is how Fontself does it). Because it runs Node, `require`/`fs`/`Buffer` are native (no polyfills). The Illustrator DOM is **Y-up**, same as the font model, so geometry is **not** flipped anywhere.

---

## 2. Where everything lives

| Thing | Location |
|---|---|
| Local clone | `C:\Users\okana\fontmaker` |
| Installed panel (live in Illustrator) | `%APPDATA%\Adobe\CEP\extensions\com.fontmaker.illustrator` |
| CEF JS cache (the stale-code culprit) | `%LOCALAPPDATA%\Temp\cep_cache\ILST_*_com.fontmaker.illustrator.panel\` |
| User project autosave | `%APPDATA%\RuneType\autosave.runetype` |
| Repo | `github.com/rukkivein/fontmaker` |
| ML training workspaces | `fontmaker/ml/` (+ `E:\glyphset` per memory) |

---

## 3. Install / open / use

**Dev install:** `npm install` once, then **`npm run cep:install`** after *every* change (syncs `shared/`+`core/` → `cep/js`, copies `cep/` → the extensions folder, cache-busts, wipes CEF cache). Open Illustrator ▸ **Window ▸ Extensions ▸ RuneType Glyphmaker**.

**Verify the build loaded:** the workspace header shows **`build <id>`** (top-right). It changes every install. If it does *not* change after reopening the panel, CEF/ExtendScript is running cached code → close Illustrator fully and reopen (see §10).

**Making a font (the flow):**
1. **New Font** (page 1): name, character sets, master(s), a construction-grid preset (Font DNA).
2. **glyphs.** (page 2): draw in Illustrator → **assign** to a slot (drag handle / double-click / drop). Click a cell to open that glyph as its own Illustrator doc (edits sync live). Or **⊕ Image Import** a reference sheet to auto-fill the grid. Or **Open Template** → draw every letter in its box → **Import Template**.
3. **modification.** — two sub-tabs:
   - **Kerning**: Standard / Bearings (Metric⟷Optical + AI) / Kerning (Metric⟷Optical + AI) / Tracking / Space sliders.
   - **Optik merkez** (optical centre): the metrics editor shows a **green** centre line (drag = optically centre the glyph, manual) with **blue/red** symmetric box edges (= exported LSB/RSB), plus an **AI · daralt/genişlet** button (the model sets each letter's width). `+ Accents` button (next to Optimize) composes À-ÿ.
4. **testing.** — live `@font-face` preview; the kern shown is **exactly what exports** (see §5). Right-click a letter to swap an alternate for that occurrence.
5. **save.** — metadata + **Export** (OTF/TTF/Variable), **Save .runetype**, **Open** (.runetype or import .otf/.ttf to edit).

---

## 4. Build / test / commands (run from `C:\Users\okana\fontmaker`)

```
npm install            # deps: opentype.js, onnxruntime-web, imagetracerjs, fzstd, chokidar
npm test               # 20 suites incl. cepsync (sync-drift gate), bosharf-export (real OTF), spacing-parity
npm run cep:sync       # shared/+core/ → cep/js (no install)
npm run cep:install    # cep:sync + copy cep/ → extension + cache-bust ?v= + wipe CEF cache
node scripts/bake-bosharf.js   # re-bake the placeholder mark after editing cep/assets/bosharf.svg
```

---

## 5. Architecture — the 3-tier sync model

The panel is assembled from three tiers; understanding this is essential.

1. **Pure-data logic** in `shared/` (no font lib) and `core/` (the font engine) — runs identically in the panel AND in Node tests. **SYNCED** into `cep/js/` (and `core/` → `cep/js/lib/`) by `scripts/sync-cep.js`. `sync-cep.js` rewrites `require('opentype.js')` → `require('./opentype.js')` for the bundled copy. **`test/cepsync.test.js` asserts byte-for-byte equality** and fails on drift → after editing any `shared/`/`core/` file you MUST `npm run cep:sync`/`cep:install`.
2. **CEP-ONLY files**, edited directly in `cep/js/`, never synced (they need CEP runtime — `fs`, ONNX, CSInterface): **`main.js`** (the ~4k-line controller), `kerninject.js`, `spacingai.js`, `unite.js`, `glyphreco.js`, `vecai.js`, plus `cep/index.html`, `cep/css/styles.css`, `cep/jsx/fontmaker.jsx`, and the `cep/js/lib/` vendored libs (`opentype.js`, `paper-core.min.js`, ONNX `ort/`, `model/`).
3. **The ExtendScript bridge** `cep/jsx/fontmaker.jsx` — loaded into Illustrator's ExtendScript engine via the manifest `<ScriptPath>`; the panel calls `fm*` functions through `cs.evalScript('fmFoo(...)')`. **It is a SEPARATE engine from the panel JS** (see the cache gotcha in §10).

`shared/features.js` `EDITION = 'pro' | 'alpha'` drives the whole premium surface via `FEATURES`; controls are disabled-in-place (an upsell), and each handler also early-returns on its flag (defense-in-depth). Synced; guarded by tests.

---

## 6. Font engine + export

- **`core/fontEngine.js`** — opentype.js-based **OTF/CFF** builder. `buildFont(project, 'otf'|'ttf', meta)` is the entry. `glyphToPath` → `normalizeWinding(contours)` → `contourToCommands`. `addGsub` emits `liga`/`salt`/`ssNN` (ligatures need `components` codepoints; alternates need `baseName`; missing → silently skipped). Variable groundwork: fvar/gvar (deltas encoded as `(factor-1)*coord`; advance via the gvar pp2 phantom point) — **single-file variable export is still the open follow-up** (§11).
- **`core/ttfWriter.js`** — the real **glyf/TTF** writer (`buildGlyfFont`, `cubicToQuads`). Writes the `name` table inline → the TTF path does NOT call `applyNames`. (opentype.js 1.3.4 writes CFF/OTTO only — that's why TTF has its own writer.)
- **`normalizeWinding`** exists in BOTH fontEngine.js and ttfWriter.js (kept dep-free) — **keep them in sync when fixing winding**. It re-derives winding by area-containment **depth parity** (outer CCW, holes CW) so counters punch under non-zero fill.
- **`cep/js/kerninject.js`** — opentype.js drops GPOS/kern on write, so this splices a real format-0 `kern` table onto the FINAL sfnt (after `buildFont` + `applyNames`). This is why the tester's kerning actually ships. Splits >10k pairs into subtables.
- **`cep/js/unite.js`** — containment-tree contour **union** that PRESERVES counters/holes while removing self-intersections (GDI-safe). Used per drawn glyph at export.
- **Export pipeline** (main.js): `buildCleanOtf/Ttf(f, master)` → `cleanedProject(f)` (deep copy; `uniteContours` each drawn glyph; `bakeGlyphOrigin` folds the blue-line LSB offset into the outline; **re-seats advance/lsbLineX from optical-centre lines if that mode is on**) → `fontEngine.buildFont` → `applyNames` (OTF only) → `kerninject.injectKernTable(buf, exportKernTable(f), glyphs)`.
- **`preWound` flag**: the placeholder mark (`shared/bosharf.json`, the "DEMO" art) is baked as a boolean UNION of the SVG's top-level paths (each painted with its own fill-rule) → clean non-zero geometry with correct counters. `shared/placeholder.js fillEmptyGlyphs` stamps `layer.preWound=true`, and both writers **skip `normalizeWinding`** for it — because the grunge mark's counters are enclosed by the *combined* ink of many strokes (no single bigger contour), so depth-parity would fill them solid. **Never call `uniteContours` on the placeholder** (it collapses 187→16 contours and fills the counters).

---

## 7. Spacing / kerning / optical

- **`shared/optimizer.js`** — `bakeMetricOptical(project, mid, opts)` is the Metric⟷Optical bake of sidebearings + kern (idempotent: re-seats from an absolute class-based or captured baseline, never the live bearing). `optimizeKerning` and the kern block both use:
  - **`robustGap(gaps)`** = the **p15 (15th-percentile)** of the per-height profile gaps, NOT the raw min — so a lone protruding terminal (C's beak, B's swash) does not phantom-collide and over-separate the pair. (This was the "C over-open" bug.)
  - **`kernTarget`** = median robustGap over all pairs (the font's typical gap); straight pairs land ~0.
  - `classify`/`sbTargets` (class-based metric baseline), `fontAirTargetUnits` (median LSB+RSB, clamped).
- **`cep/js/spacingai.js`** — offline **onnxruntime-web MobileNetV3-Small** (`spacing.onnx`, ~4MB). `predict(project, mid, {weight, root})` → `{glyphName: {recL, recR}}` per-glyph optical **recession** (how much *tighter than optHalf* each side should sit — a tightening, NOT an absolute bearing). `ensureAISpacing` (main.js) caches it in `f._optBearings`, invalidated by `sbSig` (a shape-only hash — survives slider/bake/advance changes, invalidates on contour edits). Runs on the main thread (no SharedArrayBuffer in CEP); fails soft → `{}`.
- **OPTICAL-CENTRE mode** (`f.optBearings`, main.js) — the "Optik merkez" sub-tab. Per glyph `g.ob = { ocOff, hw }`:
  - `ocOff` = the optical-centre offset from the ink's geometric middle = the **GREEN** line (user drags it; MANUAL; does NOT scale with tracking).
  - `hw` = symmetric half box-width = distance centre→blue/red (SCALES with tracking `T = 1 + moTrack/100`; set by the **AI width** button or by dragging blue/red).
  - `oc = inkC + ocOff`; `blue = oc − hw*T`; `red = oc + hw*T`; `advance = 2*hw*T`; `lsbLineX = blue`. Helpers: `obParams/obLines/obSeat/applyOpticalBearings`. Drag modes `obscen` (green) / `obhw` (edges) in `mxRedraw`/`mxDrag`. `onAIOptWidth` sets `hw = inkW/2 + optHalf − (recL+recR)/2` per glyph (keeps the user's `ocOff`). `setCorrTab` switches Kerning↔Optical-centre.
- **CRITICAL INVARIANT — testing ≡ export.** The exported kern table is recomputed **live from the outlines** at export (`exportKernTable(f)` loops `opticalKern`, the SAME function the tester shows), NOT spliced from the stored `f.kerning` (which goes stale the instant the bake re-seats an advance — kern computed for old widths no longer fits → letters collide/float). Do NOT reuse `optimizer.optimizeKerning` for the export table: it scans at `buildRef`'s derived capHeight while `opticalKern` uses `f.metrics.capHeight` → ~60% of pairs disagree. Do NOT recompute *bearings* at export (`bakeMetricOptical` is opts-sensitive; wrong opts blew advances +200).

---

## 8. Template + image import (the Illustrator bridge)

**`cep/jsx/fontmaker.jsx`** (ExtendScript; can't be browser-tested — its pure bits are Node-tested, the rest verified live):
- **Per-glyph editing**: `fmReadSelection`/`fmSetArt`/`fmShiftArt`/`fmOpenGlyph` (open a single glyph as its own doc; live sync). `FM_SCALE = 0.25` pt/unit for per-glyph editing.
- **Template round-trip**: `fmTemplateCells` lays out one **box per glyph**; `fmOpenTemplate` builds the sheet (each box named `fmcell:<id>`, the grid + ghost letter drawn inside); `fmReadTemplate` reads boxes back by name and assigns artwork by centre-in-box. **`FM_TPL_SCALE = 0.075`** pt/unit (small pixel footprint; vector, no quality loss; import maps back with the same scale). **The box is the em GRID grown SYMMETRICALLY by `FM_TPL_PAD = 0.25` on every side** (box ~51% bigger than the grid, grid+letter centred). The grid frame is drawn inset; on import `fmReadTemplate` **insets the box by `pad = boxHeight*FM_TPL_PAD/(1+2*FM_TPL_PAD)` to recover the exact grid frame** → baseline/LSB import unchanged despite the bigger box (≈2.6-unit uniform error, negligible), and overflow into the box is captured (the big box is the capture region). The doc canvas is created ~1.4× bigger than content with the artboard shrunk to hug it → a large **gray pasteboard** to draw/overflow into.
- **`ilbridge.js`** (shared + cep) — `contoursFromArtboard(paths, rect, scale, descender)` maps artboard paths → font units off `rect` **left + bottom** only (fixed scale; advance comes from the ink, `setGlyphContours(..., null)`). Illustrator paths are Y-up = font model, no flip.
- **Image import** (auto-trace reference sheets → fill the grid): `⊕ Image Import` (glyphs page). Vectorize via Illustrator's own Image Trace (jsx `fmTraceImage`/`fmCollectTrace`, drops light/background fills so counters stay holes), OR `shared/potrace.js` (clean-room pixel-faithful tracer, primary) / `shared/imagetrace.js` (imagetracerjs, legacy fallback). `shared/imgglyphs.js` is the geometry brain: `clusterGlyphs` (rows by Y-whitespace, columns by X-overlap; i=stem+dot merge), `detectCategory`, `SEQ` canonical order, `mapClusters`, `seatClusters` (per-row baseline → accents up, descenders down). `cep/js/glyphreco.js` (offline MobileNetV3 glyph recognizer, first-guess) + `cep/js/vecai.js` (offline ONNX vector refiner). A review modal lets the user fix the set + per-glyph char before commit. Pure bits in `test/imgimport.test.js`.

---

## 9a. Session 2026-07-02 — verified audit: 17 spacing/kern/export fixes

A multi-agent audit (findings adversarially verified) over the bearing/kerning pipeline. All fixes committed (`13d3d43`), tests green (23 suites incl. new `accents.test.js`), installed (build `mr2qzeh8`).

1. **kernai was DEAD** — `kernai.predict` never seeded `_root` (unlike spacingai), so `init(null)` 404'd and `paragraph.onnx` NEVER loaded; every AI-kern path silently fell back to unseeded kernvision. Fixed: `predict(f, mid, filled, {root: ROOT})` self-seed + all 3 call sites. **The paragraph model is live for the first time.**
2. **ensureAIOpt** — in-flight promise guard (`f._aiOptPending`), `seatTo` now `recordBaked`s the scratch seating (a concurrent `captureBaseline` can no longer adopt it into `f.spaceBase` = permanent corruption), `done()` discards a stale-shape analysis, continuations check `curFont()`.
3. **applyAIOptic** — no-ops while an analysis is in flight; after a `.runetype` reload it re-analyzes instead of re-seating to box; kern-table OWNERSHIP (`f.aiKernOwned`, persisted): a Tracking nudge no longer wipes a Visual-Kern or reloaded kern table; on commit it re-derives composed accents from the re-baked base (é/ç/ş track e/c/s).
4. **kernvision** — row-disjoint pairs (period vs apostrophe) get NO kern (was: max tightening); all-collided font (raw template import) synthesizes an air-scale target instead of 0; aggressiveness scaling can't ship a collision (post-scale bump); a bad Track-B seed window falls back to the full search. `whiteArea` now returns `both`.
5. **accentCompose** — hand-drawn accented glyphs are protected (`target-drawn` refusal unless `opts.force`; self-composed glyphs keep refreshing); **İ U+0130 composable** (added to CE list; ı U+0131 stays draw-by-hand by design); `glyphset.setGlyphContours` clears `composedFrom` (+`kind`) so a hand edit stops future auto-overwrites; the live-sync poll now skips unchanged reads BEFORE writing.
6. **Template re-import** keeps existing advances (was: every glyph reset to ink+60, wiping raw-box/AI spacing).
7. **Export** — TTF now gets the kern table (same splice as OTF; pinned in kerninject.test.js); blank encoded slots are STRIPPED (undrawn letters fall to the OS face exactly like the tester; space/NBSP keep their advance); kern table computed per EXPORTED master (`exportKernTable(f, mid)` + per-mid `__target__` cache — Bold no longer ships Regular's kern); optical-bearing seating runs only for the built master (last-master-wins fixed); OTF/TTF name parity (trademark/URLs/description/sampleText/preferred 16/17) + Bold `usWeightClass`/`fsSelection` (+TTF `macStyle`; opentype.js ignores the head override on OTF — verified).
8. **Tester** — the space glyph ships in the preview font (Space slider WYSIWYG).
9. **Legacy Optimize button** rewired to the 3-slider pipeline (`onAIOptimize`); `applyMetricOptical` bails when its removed dial sliders are absent (was: destructive all-zero "reset to metric").

KNOWN-GAP (documented, low): spacingai rasterizes live contours with evenodd — overlapping not-yet-united hand shapes can punch false holes into the model input (training rasters come from compiled fonts). Fix would be uniting before rasterize; deferred.

## 9. Session 2026-06-26 — what changed, with anchors

All deployed; tests green; build stamp current.

1. **Kerning "C over-open" fixed** — `shared/optimizer.js`: `robustGap` (p15) replaced raw-min; `kernTarget` = median robustGap. Both `optimizeKerning` and `bakeMetricOptical` use them.
2. **testing ≡ export forced at the source** — `buildCleanOtf` now recomputes the kern via `exportKernTable(f)` (loops `opticalKern`); `pairKern` defaults to optical; the tester's `t-kern` defaults to "Live (real)". (main.js)
3. **Placeholder counters fixed** — `bake-bosharf.js` unions top-level paths; `placeholder.js` stamps `preWound`; `fontEngine.js`+`ttfWriter.js` skip `normalizeWinding` for preWound layers. Guard: `bosharf-export.test.js` (`holes >= 6`).
4. **DEMO placeholder** — `cep/assets/bosharf.svg` is now the "Rune type / DEMO" mark (old one at `bosharf-runetype-backup.svg`); re-baked (16 contours / 10 holes).
5. **"+ Accents" button** — `#composeAccentsBtn` next to Optimize → `onComposeAccents` (composes À-ÿ into the project; NOT silent at export anymore).
6. **Optical-centre tab** — the green-master `{ocOff, hw}` model, `setCorrTab`, `onAIOptWidth` (AI width), mod sub-tabs. (main.js + index.html + styles.css)
7. **Template** — centred-box growth (`FM_TPL_PAD=0.25`), smaller render (`FM_TPL_SCALE 0.12→0.075`), large gray pasteboard, grid-frame inset recovery. (fontmaker.jsx)
8. **CEF cache-bust + JSX reload + build stamp** — `install-cep.js` stamps `?v=<build>` on the `<script>` tags + wipes the CEF cache; `main.js boot` re-evals `fontmaker.jsx` from disk (defeats the ExtendScript engine cache); `#buildTag` shows the loaded build. (See §10.)

---

## 10. Critical gotchas (read before touching anything)

- **CEF caches the panel JS.** `index.html` loads `<script src="js/main.js">`; CEF compiles it into a per-extension Code Cache that survives reinstalls. `install-cep.js` stamps `?v=<build>` (unique per install) on the script URLs + wipes `cep_cache/*com.fontmaker*`. **Verify via the `build <id>` header tag** — if it doesn't change after reopening the panel, CEF is stale.
- **The JSX is a SEPARATE engine, cached for the whole Illustrator session.** `cep/jsx/fontmaker.jsx` loads via the manifest `<ScriptPath>` ONCE per session — the `?v=` cache-bust does NOT cover it. `main.js boot` now `evalScript(fs.readFileSync(ROOT+'/jsx/fontmaker.jsx'))` to re-define all `fm*` functions fresh on every panel open. If template behaviour ever looks stale, confirm that boot re-eval ran (or restart Illustrator fully).
- **Sync drift:** after editing `shared/`/`core/`, run `cep:sync`/`cep:install` or `cepsync.test.js` fails and the panel runs old logic. The `require('./opentype.js')` rewrite is automatic — don't hand-edit it in `cep/js/lib/fontEngine.js`.
- **`bakeGlyphOrigin` decoupling:** `lsbLineX`, `advanceWidth`, and the ink are three independent objects until export folds `lsbLineX` into the outline. Dragging blue/red/shape never moves another.
- **Stored `f.kerning` is stale after any advance re-bake** — always recompute at export (`exportKernTable`). `opticalKern` uses `f.metrics.capHeight`; `optimizer` uses a derived one → don't mix.
- **`preWound` placeholder:** never run `uniteContours`/`normalizeWinding` on it (collapses/fills counters).
- **paper.js loads as BROWSER (UMD)**, not Node — `getPaper()` hides `module/exports/define` so it takes the window branch (no jsdom).
- **ONNX models** (spacingai/glyphreco/vecai) run main-thread, lazy-load, fail-soft → `{}`. Don't assume they're available.
- **Grid Designer + Metrics editor use FONT UNITS** (x 0..1000, y −200..800), not pixels; `gdView`/`mxView` are separate zoom/pan states.
- **`mxDrag` is mode-tagged** (pan/shape/scale/lsb/adv/obscen/obhw): mousedown sets the mode, onMove checks it, onUp delegates.
- **`sbSig`** invalidates AI prediction on SHAPE edits only (contour/point/bounds), not position/advance/bake.
- **`onComposeAccents` never auto-runs** — explicit click, so composed marks are real editable glyphs.
- **`demoFont`** (per-font, Testing-tab checkbox) controls whether `fillEmptyGlyphs` stamps the placeholder on export.

---

## 11. Variable fonts (the open follow-up, pro)

Masters exist as data (`project.masters[]` + per-glyph `layers[masterId].contours`; `glyphset.addMaster`). `shared/varCompat.js` checks interpolation compatibility (`report`) and aligns start points/rotation (`matchPoints` — rotates start position only; the user reconciles point-count mismatches). **A single-file fvar/gvar variable font is NOT produced yet** — today the "Variable" export validates compatibility, writes a `-variable-report.txt`, and exports each master as a separate file. To finish: extend `fontEngine.buildFont` for multi-master fvar/gvar, write gvar binary in `ttfWriter.js`, rewire the export loop in main.js, flip the `exportVariable` gate.

## 12. Next steps

- Single-file variable (fvar/gvar) TTF.
- WOFF2 export. (~~kern into TTF~~ DONE 2026-07-02.)
- ~~Turkish ş ğ ı İ~~ DONE: slots via `latinCentral` (full Ext-A); İ composes; ı = draw by hand (no NFD).
- ML training campaign for "flawless bearing+kerning" (order matters — see the 2026-07-02 audit's ML assessment in [[project-kern-trainer]] memory): (1) stratified gothic/display val slice + OOD probe on the user's own fonts, (2) ONE retrain: punctuation charset + anti-aliased strips (stripSilhouette must change in LOCKSTEP), (3) display-corpus enrichment + variable instancing, fine-tune, (4) label-noise mitigation in pack/loss + gposkern accumulate fix, (5) MobileNetV3-Large only if still short. Render into NEW dirs + `--fresh` (resume-skip / stale-best.pt traps).
- spacingai evenodd raster gap (see §9a KNOWN-GAP).
- Optionally: auto-compose accents in the PANEL grid (not just on the button); a "copy width/centre to all" action in the optical-centre tab; per-side AI asymmetry.
- The user often **can't test interactively** — verify changes via headless-Chrome renders of the actual exported `.otf` / real-glyph mocks before handing off, and keep the build cache-busted (`?v=` + `#buildTag`) every install.
