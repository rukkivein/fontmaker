#!/usr/bin/env python3
"""Dump a Python↔JS parity fixture for the sidebearing feature math.

Renders a few Arial glyphs with the EXACT training rasterizer (render_dataset.
render_glyph) and records the uint8 raster + the analytic prior/contrast/spikiness
that ml/render_spacing.py computes. test/spacing-parity.test.js runs the JS port
(cep/js/spacingai.js) on the SAME rasters and asserts the values match <1e-2 — so
inference reconstructs the same recession the model was trained against.

  python ml/dump_parity_fixture.py
"""
import json, os, sys
import numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from PIL import ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_dataset import render_glyph
from render_spacing import area_margin_prior, contrast, spikiness, BAND

ARIAL = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "arial.ttf")
CHARS = "OHTAe"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures", "spacing_parity.json")


def main():
    tt = TTFont(ARIAL)
    cmap = tt.getBestCmap()
    upm = float(tt["head"].unitsPerEm) or 1000.0
    os2 = tt.get("OS/2")
    capH = float(getattr(os2, "sCapHeight", 0) or 0)
    xH = float(getattr(os2, "sxHeight", 0) or 0)
    gs = tt.getGlyphSet(); hmtx = tt["hmtx"]

    def bounds(ch):
        gn = cmap.get(ord(ch)); pen = BoundsPen(gs); gs[gn].draw(pen)
        return gn, hmtx[gn][0], pen.bounds
    if capH <= 0:
        capH = bounds("H")[2][3] - bounds("H")[2][1]
    capE = capH / upm
    pil = ImageFont.truetype(ARIAL, 200)

    glyphs = []
    for ch in CHARS:
        gn, adv, (xmn, ymn, xmx, ymx) = bounds(ch)
        iwf = xmx - xmn
        ras = render_glyph(pil, ch, 96, 0.10)
        pL, pR, inkw = area_margin_prior(ras)
        scale = (iwf / upm) / max(1, inkw)
        priorL = (pL * scale) / capE
        priorR = (pR * scale) / capE
        glyphs.append({
            "ch": ch, "n": int(ras.shape[0]),
            "raster": ras.astype(np.int32).flatten().tolist(),
            "iwf": float(iwf), "inkw": int(inkw), "capH": float(capH), "upm": float(upm),
            "pL": int(pL), "pR": int(pR),
            "priorL": float(priorL), "priorR": float(priorR),
            "contrast": float(contrast(ras)), "spikiness": float(spikiness(ras)),
        })
        print(f"{ch}: pL={pL} pR={pR} inkw={inkw} priorL={priorL:.4f} priorR={priorR:.4f} "
              f"contrast={contrast(ras):.4f} spik={spikiness(ras):.4f}", flush=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"band": BAND, "font": "Arial", "glyphs": glyphs}, f)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
