#!/usr/bin/env python3
"""Validate the exported ONNX end-to-end: render known glyphs the SAME way as
training and check the model predicts them. Confirms model + labels.json index
mapping + normalization all line up before wiring the panel."""
import json, sys
import numpy as np
import onnxruntime as ort
from PIL import ImageFont
sys.path.insert(0, "C:/Users/okana/fontmaker/ml")
from render_dataset import render_glyph

lab = json.load(open("E:/glyphset/out/labels.json", encoding="utf-8"))
classes = lab["classes"]
S = lab["size"]
sess = ort.InferenceSession("E:/glyphset/out/glyph_int8.onnx", providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name

tests = [("C:/Windows/Fonts/arial.ttf", "ABMgaes5?7€%ñ"),
         ("C:/Windows/Fonts/times.ttf", "RQkpy0123"),
         ("C:/Windows/Fonts/segoeui.ttf", "şğıöçüZ")]
ok = tot = 0
for path, chars in tests:
    try:
        font = ImageFont.truetype(path, 200)
    except Exception:
        continue
    for ch in chars:
        arr = render_glyph(font, ch, S, 0.10)
        if arr is None:
            continue
        x = (arr.astype(np.float32) / 255.0)[None, None, :, :]
        logits = sess.run(None, {iname: x})[0][0]
        top = logits.argsort()[-3:][::-1]
        p1 = classes[top[0]]["char"]
        top3 = " ".join(classes[i]["char"] for i in top)
        hit = (p1 == ch)
        ok += hit; tot += 1
        print(f"  {ch!r:5} -> top1={p1!r:5} {'OK ' if hit else 'top3:[' + top3 + ']'}")
print(f"\n{ok}/{tot} top-1 correct")
