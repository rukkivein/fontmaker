#!/usr/bin/env python3
"""Render the SIDEBEARING dataset from the open font corpus.

For every font face, for each letter/figure (A-Z a-z 0-9), store:
  - x      : the SAME 96x96 bbox-normalized white-on-black raster the recognizer uses
             (render_dataset.render_glyph, byte-for-byte == the panel's rasterizer) —
             SPACING IS STRIPPED (crop to ink bbox), so the net can't read the gap.
  - resid  : [residL, residR] = the LEARNING TARGET = (designer recession) - (analytic
             area-margin prior), in cap-height units. The font's OPENNESS is divided out
             (lives in the bake's `air`), so a sans-heavy corpus still teaches the
             universal per-glyph recession that transfers to gothic display.
  - prior  : [priorL, priorR] = analytic area-margin recession (also a model feature).
  - feats  : 8 context scalars [priorL, priorR, weight, width, contrast, xH/capH,
             spikiness, isLower].
  - cls    : 0..61 letter/figure id (for stratification / per-class metrics).
  - qscore : per-font optical-sanity score (recession rank-corr) → curation gate.

Resumable (one .npz/face). Reuses render_dataset's face listing + rasterizer verbatim.

Usage:
  python render_spacing.py --fonts E:/glyphset/fonts --out E:/glyphset/spacing_npz [--jobs 0] [--limit N]
"""
import argparse, json, os, sys
import numpy as np
from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.boundsPen import BoundsPen
from PIL import ImageFont
from joblib import Parallel, delayed

# reuse the recognizer infra VERBATIM (same rasterizer == panel parity)
from render_dataset import list_faces, render_glyph, out_name, source_of

BAND = 0.04                      # area-margin: optical edge = where cumulative ink hits 4%
TRAIN = [chr(c) for c in list(range(0x41, 0x5B)) + list(range(0x61, 0x7B)) + list(range(0x30, 0x3A))]
CLS = {ch: i for i, ch in enumerate(TRAIN)}                         # 0..61
# optical-sanity probe: these recede a lot vs these (near-flat) — a real font ranks them right
HIGH_REC, LOW_REC = "OCGQTVAWY", "HIELMNUDBP"


def area_margin_prior(raster):
    """priorL/priorR in RASTER COLUMNS: distance from the ink bbox edge to where the
    cumulative ink mass first reaches BAND of the total. Uses mass (not the extreme
    pixel) so a lone spike barely moves it. Returns (priorL_px, priorR_px, inkW_cols)."""
    col = raster.sum(axis=0).astype(np.float64)
    nz = np.nonzero(col)[0]
    if nz.size == 0:
        return None
    left, right = int(nz[0]), int(nz[-1])
    inkw = right - left + 1
    tot = col.sum()
    if tot <= 0:
        return None
    thr = BAND * tot
    cl = np.cumsum(col[left:right + 1])
    edgeL = left + int(np.searchsorted(cl, thr))                   # first col >= thr from the left
    clr = np.cumsum(col[right:left - 1 if left > 0 else None:-1])  # from the right
    edgeR = right - int(np.searchsorted(clr, thr))
    return max(0, edgeL - left), max(0, right - edgeR), inkw


def spikiness(raster):
    """perimeter^2 / (4*pi*area) of the silhouette (1 for a disk; high for spiky)."""
    ink = raster > 32
    area = int(ink.sum())
    if area < 8:
        return 1.0
    # boundary px = ink px with a non-ink 4-neighbour
    p = np.zeros_like(ink)
    p[1:, :] |= ink[1:, :] & ~ink[:-1, :]
    p[:-1, :] |= ink[:-1, :] & ~ink[1:, :]
    p[:, 1:] |= ink[:, 1:] & ~ink[:, :-1]
    p[:, :-1] |= ink[:, :-1] & ~ink[:, 1:]
    perim = int((p | (ink & ((np.arange(ink.shape[0])[:, None] == 0) | (np.arange(ink.shape[1])[None, :] == 0)))).sum())
    perim = max(perim, int(p.sum()))
    return float(min(6.0, perim * perim / (4.0 * np.pi * area)))


def contrast(raster):
    """vertical-run / horizontal-run through the centre — high for high-contrast faces."""
    ink = raster > 32
    h, w = ink.shape
    vr = int(ink[:, w // 2].sum()) or 1
    hr = int(ink[h // 2, :].sum()) or 1
    return float(min(4.0, max(vr, hr) / max(1, min(vr, hr))))


def render_spacing_face(path, face, out_dir, size, margin, render_px, fonts_dirs):
    op = out_name(path, face, out_dir).replace(".npz", "_sb.npz")
    if os.path.exists(op):
        return ("skip", 0)
    try:
        is_coll = path.lower().endswith((".ttc", ".otc"))
        tt = (TTCollection(path, lazy=True).fonts[face] if is_coll else TTFont(path, lazy=True, fontNumber=0))
        cmap = tt.getBestCmap()
        if not cmap or "hmtx" not in tt or "head" not in tt:
            return ("nometrics", 0)
        upm = float(tt["head"].unitsPerEm) or 1000.0
        # drop monospaced whole (grid-forced bearings = poison)
        try:
            if getattr(tt.get("post"), "isFixedPitch", 0):
                return ("mono", 0)
        except Exception:
            pass
        os2 = tt.get("OS/2")
        weight = float(getattr(os2, "usWeightClass", 400) or 400)
        width = float(getattr(os2, "usWidthClass", 5) or 5)
        capH = float(getattr(os2, "sCapHeight", 0) or 0)
        xH = float(getattr(os2, "sxHeight", 0) or 0)
        gs = tt.getGlyphSet()
        hmtx = tt["hmtx"]

        def ink_bounds(ch):
            gn = cmap.get(ord(ch))
            if gn is None or gn not in gs:
                return None
            pen = BoundsPen(gs)
            try:
                gs[gn].draw(pen)
            except Exception:
                return None
            if pen.bounds is None:
                return None
            adv = hmtx[gn][0]
            return gn, adv, pen.bounds  # (xMin,yMin,xMax,yMax)

        if capH <= 0:
            hb = ink_bounds("H")
            capH = (hb[2][3] - hb[2][1]) if hb else 0.7 * upm
        if xH <= 0:
            xb = ink_bounds("x")
            xH = (xb[2][3] - xb[2][1]) if xb else 0.5 * upm
        capE = capH / upm  # cap height as em fraction (the cap-unit denominator, in em)

        try:
            pil = ImageFont.truetype(path, render_px, index=face)
        except Exception:
            return ("pilfail", 0)

        rows = []  # (cls, raster, priorL, priorR, lsbE, rsbE, feats[8])
        for ch in TRAIN:
            ib = ink_bounds(ch)
            if ib is None:
                continue
            gn, adv, (xmn, ymn, xmx, ymx) = ib
            iwf = xmx - xmn
            if iwf <= 0 or adv <= 0:
                continue
            lsbE = xmn / upm                       # designer LSB, em
            rsbE = (adv - xmx) / upm               # designer RSB, em
            ras = render_glyph(pil, ch, size, margin)
            if ras is None:
                continue
            am = area_margin_prior(ras)
            if am is None:
                continue
            pLpx, pRpx, inkw = am
            scale = (iwf / upm) / max(1, inkw)     # em per raster col (horizontal)
            priorL = (pLpx * scale) / capE         # cap units
            priorR = (pRpx * scale) / capE
            feats = [priorL, priorR, weight / 900.0, width / 9.0, contrast(ras), (xH / capH) if capH else 0.5, spikiness(ras), 1.0 if ch.islower() else 0.0]
            rows.append((CLS[ch], ras, priorL, priorR, lsbE, rsbE, feats))

        if len(rows) < 40:                          # too few letters → unreliable fontBear
            np.savez(op + ".tmp", x=np.zeros((0, size, size), np.uint8))
            os.replace(op + ".tmp.npz", op)
            return ("sparse", 0)

        bears = sorted((l + r) / 2.0 for (_, _, _, _, l, r, _) in rows)   # per-glyph mean bearing (em)
        fontBear = bears[len(bears) // 2]                                  # font openness scalar (em)
        X = np.stack([r[1] for r in rows]).astype(np.uint8)
        cls = np.asarray([r[0] for r in rows], np.int16)
        prior = np.asarray([[r[2], r[3]] for r in rows], np.float32)
        feats = np.asarray([r[6] for r in rows], np.float32)
        # target recession (cap units) = (fontBear - designerBearing)/capE ; residual = target - prior
        tL = np.asarray([(fontBear - r[4]) / capE for r in rows], np.float32)
        tR = np.asarray([(fontBear - r[5]) / capE for r in rows], np.float32)
        resid = np.stack([tL - prior[:, 0], tR - prior[:, 1]], axis=1).astype(np.float32)
        np.clip(resid, -0.6, 0.6, out=resid)

        # optical-sanity gate: do HIGH_REC letters actually recede more than LOW_REC?
        tgt = {TRAIN[c]: (a + b) / 2 for c, a, b in zip(cls.tolist(), tL.tolist(), tR.tolist())}
        hi = [tgt[c] for c in HIGH_REC if c in tgt]
        lo = [tgt[c] for c in LOW_REC if c in tgt]
        qscore = float((np.mean(hi) - np.mean(lo))) if hi and lo else 0.0

        np.savez(op + ".tmp", x=X, cls=cls, resid=resid, prior=prior, feats=feats,
                 qscore=np.float32(qscore), fontbear=np.float32(fontBear),
                 src=source_of(path, fonts_dirs), face=np.int16(face))
        os.replace(op + ".tmp.npz", op)
        return ("ok", len(rows))
    except Exception as e:
        return ("error:" + str(e)[:60], 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", nargs="+", default=["E:/glyphset/fonts"])
    ap.add_argument("--local", default=True, action=argparse.BooleanOptionalAction)
    ap.add_argument("--out", default="E:/glyphset/spacing_npz")
    ap.add_argument("--size", type=int, default=96)
    ap.add_argument("--margin", type=float, default=0.10)
    ap.add_argument("--render-px", type=int, default=200)
    ap.add_argument("--jobs", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    font_dirs = list(args.fonts)
    if args.local:
        for d in (os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
                  os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")):
            if os.path.isdir(d) and os.path.abspath(d) not in [os.path.abspath(x) for x in font_dirs]:
                font_dirs.append(d)
    faces = list_faces(font_dirs)
    if args.limit:
        faces = faces[: args.limit]
    print(f"{len(faces)} faces; {len(TRAIN)} letters/figures per face")
    if not faces:
        print("No fonts found."); sys.exit(1)

    n_jobs = args.jobs if args.jobs > 0 else -1
    results = Parallel(n_jobs=n_jobs, backend="loky", verbose=5)(
        delayed(render_spacing_face)(p, fi, args.out, args.size, args.margin, args.render_px, font_dirs)
        for (p, fi) in faces)

    from collections import Counter
    status = Counter(r[0].split(":")[0] for r in results)
    total = sum(r[1] for r in results)
    print(f"\nDone. glyphs={total:,}  faces: {dict(status)}")
    with open(os.path.join(args.out, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"faces": len(faces), "glyphs": total, "status": dict(status),
                   "letters": len(TRAIN), "band": BAND}, f, indent=0)


if __name__ == "__main__":
    main()
