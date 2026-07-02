#!/usr/bin/env python3
"""Pre-flight label-sanity gate for the sidebearing pipeline.

Loads the _sb.npz the smoke render produced and checks the recession label has the
RIGHT SIGN: real fonts should mostly score qscore>0 (O/C/G/T/V recede more than
H/I/E/L). If this fails the label math is wrong — do NOT burn hours on the 16k run.

  python check_spacing.py C:\\Temp\\sb_smoke
"""
import sys, glob, os, statistics
import numpy as np

d = sys.argv[1] if len(sys.argv) > 1 else "C:/Temp/sb_smoke"
npzs = [p for p in glob.glob(os.path.join(d, "*.npz")) if not os.path.basename(p).startswith("_")]
if not npzs:
    print("SANITY FAIL: no _sb.npz rendered in", d); sys.exit(1)

qs = []
for p in npzs:
    try:
        with np.load(p) as z:
            if "qscore" in z and "x" in z and int(z["x"].shape[0]) > 0:
                qs.append((os.path.basename(p), float(z["qscore"])))
    except Exception:
        pass
if not qs:
    print("SANITY FAIL: every face was empty/sparse — render_glyph or metric extraction is broken"); sys.exit(1)

vals = [q for _, q in qs]
mq = statistics.mean(vals)
pos = sum(1 for q in vals if q > 0)
for name, q in sorted(qs, key=lambda t: -t[1])[:8]:
    print(f"  {q:+.4f}  {name}")
print(f"SANITY: {len(vals)} faces | mean qscore {mq:+.4f} | {pos}/{len(vals)} positive "
      f"(O/C/G/T/V should recede more than H/I/E/L)")
if mq > 0 and pos >= max(1, len(vals) // 2):
    print("SANITY OK — recession label has the right sign. Safe to run the full corpus."); sys.exit(0)
print("SANITY FAIL — recession sign looks wrong; check render_spacing.py label math BEFORE the 16k run.")
sys.exit(1)
