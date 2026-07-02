# RuneType Smart Sidebearing Model

A second offline model (alongside the glyph recognizer) that predicts **per-glyph
optical spacing** to drive the Modification panel's **Metric ⟷ Optical** bake. It makes
the bake shape-aware: round letters tighter, flat letters more bearing, spiky/diagonal
letters handled carefully — instead of the uniform `optHalf` it uses today.

## The idea that makes a SANS-heavy corpus work for a GOTHIC font
The model never predicts *openness* (how tight the font is) — only the **per-glyph
recession** *relative to the font's own typical bearing*, in cap-height units. Openness
(`air`) is divided out at extraction and re-applied in the bake. So:
- The learned signal = "O recedes more than H" — a **universal optical fact** true in
  sans, serif, slab and gothic alike → it **transfers**; the Arial leak is closed *by
  construction*, not statistically.
- It's a **residual over an analytic area-margin prior** (cumulative-ink-mass edge, not
  the extreme pixel → spike-robust). If the net ever collapses it degrades to good
  area-spacing, never to uniform `optHalf`.

**Label (per glyph, em→cap units):**
`fontBear = median over A-Za-z of (LSB+RSB)/2/upm` (this IS the bake's `air`);
`target = (fontBear − bearing)/capE`; `prior = area-margin recession`;
**`resid = target − prior`** ← the 2 floats the net predicts (L/R).

**Input:** the existing 96×96 bbox-normalized raster (spacing stripped — can't cheat) +
8 context scalars `[priorL, priorR, weight/900, width/9, contrast, xH/capH, spikiness,
isLower]`.

## Pipeline (reuses the recognizer infra: venv, render_glyph, MobileNetV3, ONNX)
| # | script | status |
|---|--------|--------|
| 1 | **`render_spacing.py`** — extract raster + resid/prior/feats/qscore per face (resumable) | ✅ built |
| 2 | `pack_spacing.py` — consolidate → memmap; whole-font val; quality-gate (drop low `qscore`); spikiness-stratify; reserve a disjoint gothic/blackletter val slice | ⏳ next |
| 3 | `train_spacing.py` — MobileNetV3-Small + 8-ctx residual head → `[residL,residR]`; SmoothL1 + optional pairwise hinge; **safe aug only** (translate/rotate≤2°/blur/noise + **spike-injection**; NO shear/scale/elastic/dilate/flip — they falsify the label); best-by-val-MAE; fp32 ONNX (no temperature) | ⏳ next |
| 4 | panel: JS area-margin prior (parity with Python) + onnxruntime-web → per-glyph `{recL,recR}` → `bakeMetricOptical(opts.optBearings)` | ✅ DONE (cep/js/spacingai.js) |

## Bake seam (DONE)
`optimizer.bakeMetricOptical(project, mid, opts)` where `opts = {tBearing, aiBearing, tKern,
aiKern, track, stdMul, optBearings}`. `opts.optBearings = { glyphName: {recL,recR} }` = per-side
optical **RECESSION** in font units (how much TIGHTER than `optHalf` each side sits — NOT a final
bearing). The bake computes `oL = max(floor, round(optHalf − aiBearing·recL))`. `aiBearing` (0–1)
scales the model's influence; `tBearing` blends metric→that optical target.
**No model / aiBearing 0 ⇒ every glyph uses uniform `optHalf`.** `spacingai.predict` returns the
`{recL,recR}` map; passing `{oL,oR}` would read as recL=0 → silent uniform (the trap to avoid).

## Curation > architecture (the make-or-break)
Drop monospaced/tabular (grid bearings), faces missing OS/2 or <40 letters or mostly
zero bearings; keep the **top ~40–50% by `qscore`** (optical-sanity: do O/C/G/T/V recede
more than H/I/E/L?); de-dup by family; oversample the high-spikiness/display tail; measure
transfer on a **disjoint hand-tagged gothic slice**, not held-out sans.

## Smoke test (run BEFORE the 16k corpus)
```
set PY=E:\glyphset\.venv\Scripts\python.exe
%PY% ml\render_spacing.py --fonts C:\Windows\Fonts --no-local --out C:\Temp\sb_smoke --limit 12 --jobs 4
```
Assert: Consolas/Courier dropped as `mono`; each `_sb.npz` has aligned `x/resid/prior/feats`;
spot-check `O` has `target>0` (recedes) and `H` has `target≈0`. **Non-negotiable parity
gate** (do before training): the JS area-margin prior must match the Python `area_margin_prior`
to <1e-2 on Arial O/H/T — a drifted prior = residual on the wrong base.

Then: `pack_spacing.py` → `train_spacing.py --epochs 3 --smoke` → load ONNX → run
`bakeMetricOptical` with `optBearings` null (== current) then a stub map (O tightens, H same).
Only after all pass → launch `render_spacing.py` on `E:\glyphset\fonts` (resumable) → full train.

## Licensing
Same as the recognizer: OFL/Apache/libre fonts → derived model shipped (ONNX); never the `.ttf`.
