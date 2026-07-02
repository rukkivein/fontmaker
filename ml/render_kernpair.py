#!/usr/bin/env python3
"""Render the PAIR-KERNING dataset from the open font corpus (Visual Kerning Trainer, Track B).

Unlike render_spacing.py (which bbox-normalizes EACH glyph to its own 96x96 — so the
relative size + spacing between two glyphs is lost), this stores every glyph at a COMMON
font-unit scale so pairs can be composited at their true spacing + an arbitrary kern. For
each letter/figure it records the per-row LEFT and RIGHT ink-edge profile (font units,
glyph origin at x=0) over a fixed vertical band, plus the advance — exactly what
shared/kernvision.js needs to (a) compute the optical-even kern LABEL and (b) build the
pair silhouette the model sees. Edge profiles (not a 2D raster) keep it tiny (~0.5 KB/glyph)
and are computed straight from the outline (scanline over the flattened contours), so they
match the JS scorer's geometry exactly — no PIL/point-size drift.

Per face npz (resumable, one .npz/face):
  cls   : [N] letter/figure id 0..61
  left  : [N,H] leftmost ink x per row (font units, origin-relative; NaN = no ink at row)
  right : [N,H] rightmost ink x per row
  adv   : [N] advance width (font units)
  upm, capH, xH, ascender, descender, weight, width : face scalars
  src, face

Usage:
  python render_kernpair.py --fonts E:/glyphset/fonts --out E:/glyphset/kernpair_npz [--jobs 0] [--limit N]
  (smoke: --fonts C:/Windows/Fonts --out C:/Temp/kp_smoke --limit 20)
"""
import argparse, json, os, sys
import numpy as np
from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.basePen import BasePen

from render_dataset import list_faces, out_name, source_of
from gposkern import gpos_kern

TRAIN = [chr(c) for c in list(range(0x41, 0x5B)) + list(range(0x61, 0x7B)) + list(range(0x30, 0x3A))]
CLS = {ch: i for i, ch in enumerate(TRAIN)}        # 0..61
H_ROWS = 64                                         # vertical scan rows over the band
BAND_LO, BAND_HI = -0.30, 1.00                      # band as em fraction (descenders..caps/asc)


class SegPen(BasePen):
    """Flatten a glyph outline (components decomposed by BasePen) into straight segments
    in font units — the same 8-sample cubic flattening shared/kernvision.js uses."""
    def __init__(self, glyphSet):
        BasePen.__init__(self, glyphSet)
        self.segs = []
        self._last = None
        self._start = None

    def _moveTo(self, pt):
        self._last = pt; self._start = pt

    def _lineTo(self, pt):
        if self._last is not None:
            self.segs.append((self._last, pt))
        self._last = pt

    def _curveToOne(self, c1, c2, pt):
        a = self._last if self._last is not None else pt
        px, py = a
        for s in range(1, 9):
            t = s / 8.0; u = 1.0 - t
            x = u*u*u*a[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t*t*t*pt[0]
            y = u*u*u*a[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t*t*t*pt[1]
            self.segs.append(((px, py), (x, y))); px, py = x, y
        self._last = pt

    def _qCurveToOne(self, c, pt):
        a = self._last if self._last is not None else pt
        c1 = (a[0] + 2.0/3.0*(c[0]-a[0]), a[1] + 2.0/3.0*(c[1]-a[1]))
        c2 = (pt[0] + 2.0/3.0*(c[0]-pt[0]), pt[1] + 2.0/3.0*(c[1]-pt[1]))
        self._curveToOne(c1, c2, pt)

    def _closePath(self):
        if self._last is not None and self._start is not None and self._last != self._start:
            self.segs.append((self._last, self._start))
        self._last = self._start


def edge_profiles(segs, ys, y0, dy, H):
    """Per-row min(left)/max(right) ink x by scanline. ys is linear (ys[r]=y0+r*dy) so each
    segment only touches the rows in its y-span — O(segs + crossings)."""
    left = np.full(H, np.nan, np.float64)
    right = np.full(H, np.nan, np.float64)
    for (x1, y1), (x2, y2) in segs:
        if y1 == y2:
            continue
        ylo, yhi = (y1, y2) if y1 < y2 else (y2, y1)
        r_lo = int(np.ceil((ylo - y0) / dy));  r_hi = int(np.floor((yhi - y0) / dy))
        if r_lo < 0: r_lo = 0
        if r_hi > H - 1: r_hi = H - 1
        for r in range(r_lo, r_hi + 1):
            y = y0 + r * dy
            x = x1 + (x2 - x1) * (y - y1) / (y2 - y1)
            if not (x >= left[r]):   # NaN-safe min
                left[r] = x
            if not (x <= right[r]):  # NaN-safe max
                right[r] = x
    return left.astype(np.float32), right.astype(np.float32)


def render_kernpair_face(path, face, out_dir, fonts_dirs):
    op = out_name(path, face, out_dir).replace(".npz", "_kp.npz")
    if os.path.exists(op):
        return ("skip", 0)
    try:
        is_coll = path.lower().endswith((".ttc", ".otc"))
        tt = (TTCollection(path, lazy=True).fonts[face] if is_coll else TTFont(path, lazy=True, fontNumber=0))
        cmap = tt.getBestCmap()
        if not cmap or "hmtx" not in tt or "head" not in tt:
            return ("nometrics", 0)
        upm = float(tt["head"].unitsPerEm) or 1000.0
        try:
            if getattr(tt.get("post"), "isFixedPitch", 0):
                return ("mono", 0)                       # monospaced = grid bearings, poison for kern
        except Exception:
            pass
        os2 = tt.get("OS/2")
        weight = float(getattr(os2, "usWeightClass", 400) or 400)
        width = float(getattr(os2, "usWidthClass", 5) or 5)
        capH = float(getattr(os2, "sCapHeight", 0) or 0)
        xH = float(getattr(os2, "sxHeight", 0) or 0)
        asc = float(getattr(tt.get("hhea"), "ascent", 0) or 0) or 0.8 * upm
        desc = float(getattr(tt.get("hhea"), "descent", 0) or 0) or -0.2 * upm
        gs = tt.getGlyphSet()
        hmtx = tt["hmtx"]

        y0 = BAND_LO * upm
        dy = (BAND_HI - BAND_LO) * upm / (H_ROWS - 1)
        ys = [y0 + r * dy for r in range(H_ROWS)]

        rows = []  # (cls, left[H], right[H], adv, glyphname, char)
        for ch in TRAIN:
            gn = cmap.get(ord(ch))
            if gn is None or gn not in gs:
                continue
            pen = SegPen(gs)
            try:
                gs[gn].draw(pen)
            except Exception:
                continue
            if not pen.segs:
                continue
            left, right = edge_profiles(pen.segs, ys, y0, dy, H_ROWS)
            if not np.isfinite(left).any():
                continue
            adv = float(hmtx[gn][0])
            if adv <= 0:
                continue
            rows.append((CLS[ch], left, right, adv, gn, ch))

        if len(rows) < 20:
            return ("sparse", 0)

        # REAL foundry kern (GPOS PairPos / legacy kern) for the present glyphs → [N,N] matrix,
        # font units, 0 where the font did not kern that pair. This is Track B's pretrain target.
        gname = [r[4] for r in rows]
        nm2row = {gn: i for i, gn in enumerate(gname)}
        allowed = [(gname[i], gname[j]) for i in range(len(rows)) for j in range(len(rows))]
        kd = gpos_kern(tt, allowed)
        Nr = len(rows)
        gpos = np.zeros((Nr, Nr), np.float32)
        for (a, b), v in kd.items():
            ia, ib = nm2row.get(a), nm2row.get(b)
            if ia is not None and ib is not None:
                gpos[ia, ib] = v
        has_gpos = 1 if kd else 0

        # cap/x fallbacks if OS/2 lacked them (normalization only — coarse is fine)
        if capH <= 0:
            capH = 0.7 * upm
        if xH <= 0:
            xH = 0.5 * upm

        cls = np.asarray([r[0] for r in rows], np.int16)
        left = np.stack([r[1] for r in rows]).astype(np.float32)
        right = np.stack([r[2] for r in rows]).astype(np.float32)
        adv = np.asarray([r[3] for r in rows], np.float32)

        np.savez(op + ".tmp", cls=cls, left=left, right=right, adv=adv, gpos=gpos,
                 has_gpos=np.int16(has_gpos),
                 upm=np.float32(upm), capH=np.float32(capH), xH=np.float32(xH),
                 asc=np.float32(asc), desc=np.float32(desc),
                 weight=np.float32(weight), width=np.float32(width),
                 src=source_of(path, fonts_dirs), face=np.int16(face))
        os.replace(op + ".tmp.npz", op)
        return ("ok", len(rows))
    except Exception as e:
        return ("error:" + str(e)[:60], 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", nargs="+", default=["E:/glyphset/fonts"])
    ap.add_argument("--local", default=False, action=argparse.BooleanOptionalAction)
    ap.add_argument("--out", default="E:/glyphset/kernpair_npz")
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
    print(f"{len(faces)} faces; {len(TRAIN)} letters/figures per face; H={H_ROWS} rows")
    if not faces:
        print("No fonts found."); sys.exit(1)

    try:
        from joblib import Parallel, delayed
        n_jobs = args.jobs if args.jobs > 0 else -1
        results = Parallel(n_jobs=n_jobs, backend="loky", verbose=5)(
            delayed(render_kernpair_face)(p, fi, args.out, font_dirs) for (p, fi) in faces)
    except Exception:
        results = [render_kernpair_face(p, fi, args.out, font_dirs) for (p, fi) in faces]

    from collections import Counter
    status = Counter(r[0].split(":")[0] for r in results)
    total = sum(r[1] for r in results)
    print(f"\nDone. glyphs={total:,}  faces: {dict(status)}")
    with open(os.path.join(args.out, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"faces": len(faces), "glyphs": total, "status": dict(status),
                   "letters": len(TRAIN), "rows": H_ROWS, "band": [BAND_LO, BAND_HI]}, f, indent=0)


if __name__ == "__main__":
    main()
