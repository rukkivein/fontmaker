# RuneType Glyph Recognizer — ML pipeline

Offline visual model that guesses **which character** a traced glyph is, so Image
Import no longer depends on glyph order. Trains on open fonts (OFL/Apache/libre —
we ship only the trained model, never the fonts), exported to ONNX and run in the
panel via **onnxruntime-web (WASM)**. Positional mapping stays as the fallback for
low-confidence glyphs.

## Where things live
- **Code (versioned):** `C:\Users\okana\fontmaker\ml\` (this folder)
- **Workspace (data, big):** `E:\glyphset\` — venv, fonts, renders, packed data, model out
- **Python:** `E:\glyphset\.venv` (Python 3.12 + CUDA torch 2.6 — system Python 3.14 has no CUDA wheels)

## One command (the 24h run)
```
powershell -ExecutionPolicy Bypass -File C:\Users\okana\fontmaker\ml\run_all.ps1
```
Runs download → render → pack → train. Every stage is **resumable** (re-run after a
crash; it skips finished fonts/faces and resumes from the best checkpoint). Logs to
`E:\glyphset\run.log`. Final model: `E:\glyphset\out\glyph_int8.onnx` + `labels.json`.

## Stages (if you want to run them piecemeal)
| # | script | what | output | time |
|---|--------|------|--------|------|
| 0 | `charset_spec.py --han gb2312l1` | class set from charsets.js + Han tier | `classes.json` (**4796 classes**) | instant |
| 1 | `download_fonts.py` | Google Fonts + Noto + Noto-CJK + Velvetyne (open/libre) | `E:\glyphset\fonts\` (~3.5 GB) | ~1 h |
| 2 | `render_dataset.py` | cmap-gated 96×96 white-on-black renders, parallel, resumable | `…\data\renders\*.npz` | ~0.5–1 h |
| 3 | `pack_dataset.py` | consolidate → memmap, whole-font val split | `…\data\packed\` | ~min |
| 4 | `train.py` | MobileNetV3-Small + GPU aug + calibration + ONNX/INT8 | `E:\glyphset\out\` | ~6–15 h |

## Key design (from the research pass)
- **Classes** mirror `shared/charsets.js` so model output → glyph slot lines up: 1041
  non-Han + 3755 Han (GB2312 L1) = **4796**. Drop Han with `--han none` (→ ~1041) or
  `--han common` (~1200) for a faster first model.
- **Input** = 96×96 grayscale, white-on-black, bbox-normalized 10% margin. The panel's
  canvas rasterizer must match this EXACTLY (top accuracy risk if it drifts).
- **Augmentation** (GPU, on-the-fly) bridges clean-render → decorative/blackletter/trace:
  affine/perspective/elastic + morphological dilate/erode (stroke weight) + blur/noise +
  rare polarity flip. Stored data is just compact clean renders.
- **Calibration:** temperature scaling baked into the exported logits → the panel
  thresholds softmax confidence and falls back to positional mapping when unsure.
- **Validation holds out whole fonts** (incl. decorative) → measures real generalization.
- **Runtime:** onnxruntime-web WASM, `numThreads=1`, `proxy=false`, `simd=true`, bundled
  `ort-wasm-simd-threaded.{wasm,mjs}` (CSP `unsafe-eval` already permits WASM). INT8 model.

## Licensing
OFL/Apache/libre fonts may be rendered to a training set and a derived recognition
model shipped commercially (the model is not a "derivative font"). We never ship the
`.ttf`. Keep `download_fonts.py`'s sources as the attribution record.

## Smoke test (validate code without the full corpus)
```
E:\glyphset\.venv\Scripts\python.exe render_dataset.py --fonts "C:/Windows/Fonts" --classes E:/glyphset/classes.json --out E:/glyphset/data/smoke_renders --limit 8 --jobs 4
E:\glyphset\.venv\Scripts\python.exe pack_dataset.py  --renders E:/glyphset/data/smoke_renders --out E:/glyphset/data/smoke_packed --val-frac 0.2
E:\glyphset\.venv\Scripts\python.exe train.py --packed E:/glyphset/data/smoke_packed --out E:/glyphset/out_smoke --smoke
```
(Smoke uses Windows fonts only to exercise the code — NOT for the shipped model.)

## Next: panel integration (after a model exists)
Bundle onnxruntime-web + `glyph_int8.onnx` + `labels.json` into the extension, add a
canvas rasterizer (contours→[1,1,96,96], evenodd holes, white-on-black) that matches
training, run inference as the first guess in the Image-Import review, and fall back to
positional mapping below the confidence threshold.
