#!/usr/bin/env python3
"""Render the glyph-recognition dataset from the open font corpus.

For every font face, render each covered codepoint that is in our class set
(classes.json) to a normalized SIZExSIZE grayscale bitmap (ink = white on black,
bbox-normalized with a fixed margin — EXACTLY how the CEP panel rasterizes a
traced glyph at inference). Output is one .npz per face (resumable: a present
.npz means done), parallelized across faces. Augmentation happens later, live in
the training DataLoader — here we store only compact clean renders.

Correctness controls (per the research):
  - gate on fontTools getBestCmap() so we never render .notdef "tofu" boxes
  - expand .ttc/.otc collections to all sub-faces
  - per-font tofu sentinel + ink-coverage rejection
  - wrap every font in try/except so broken files don't kill a 24h run

Usage:
  python render_dataset.py --fonts E:/glyphset/fonts --classes E:/glyphset/classes.json \
         --out E:/glyphset/data/renders --jobs 0
"""
import argparse, glob, hashlib, json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont, TTCollection
from joblib import Parallel, delayed

SENTINEL_CP = 0xF8FF  # a PUA codepoint most fonts don't cover -> renders .notdef


def file_sha1(path, chunk=1 << 20):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def list_faces(fonts_dirs):
    """Yield (path, face_index) for every face across ALL font dirs, de-duplicated
    by file content so the same font appearing in multiple sources (Google ∩ Noto,
    or a Windows font also in a download) is only rendered once."""
    faces = []
    pats = ("*.ttf", "*.otf", "*.ttc", "*.otc")
    paths = []
    for fonts_dir in fonts_dirs:
        for p in pats:
            paths += glob.glob(os.path.join(fonts_dir, "**", p), recursive=True)
    paths = sorted(set(paths))
    npaths = len(paths)
    seen, dups, scanned = set(), 0, 0
    for path in paths:
        scanned += 1
        if scanned % 2000 == 0:
            print(f"  scanning fonts {scanned}/{npaths} (dedup)…", flush=True)
        try:
            sig = (os.path.getsize(path), file_sha1(path))
        except Exception:
            continue
        if sig in seen:
            dups += 1
            continue
        seen.add(sig)
        low = path.lower()
        try:
            if low.endswith((".ttc", ".otc")):
                n = len(TTCollection(path, lazy=True).fonts)
                for i in range(n):
                    faces.append((path, i))
            else:
                faces.append((path, 0))
        except Exception:
            continue
    if dups:
        print(f"  dedup: skipped {dups} byte-identical duplicate font files")
    return faces


def out_name(path, face, out_dir):
    h = hashlib.blake2b((os.path.abspath(path) + "#" + str(face)).encode("utf-8"), digest_size=8).hexdigest()
    base = os.path.splitext(os.path.basename(path))[0]
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in base)[:40]
    return os.path.join(out_dir, f"{safe}_{face}_{h}.npz")


def source_of(path, fonts_dirs):
    ap = os.path.abspath(path)
    for base in fonts_dirs:
        b = os.path.abspath(base)
        if ap.startswith(b + os.sep):
            rel = os.path.relpath(ap, b).replace("\\", "/")
            return rel.split("/", 1)[0] if "/" in rel else os.path.basename(b)
    return "external"


def render_glyph(pil_font, ch, size, margin_frac):
    big = size * 4
    img = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(img)
    try:
        bbox = d.textbbox((0, 0), ch, font=pil_font)
    except Exception:
        return None
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w <= 0 or h <= 0 or w > big or h > big:
        return None
    d.text((-bbox[0], -bbox[1]), ch, fill=255, font=pil_font)
    crop = img.crop((0, 0, min(big, w), min(big, h)))
    bb = crop.getbbox()
    if bb is None:
        return None
    ink = crop.crop(bb)
    arr = np.asarray(ink)
    cov = float(arr.mean())
    if cov < 1.0 or cov > 245.0:   # empty or near-solid block (tofu)
        return None
    iw, ih = ink.size
    pad = int(round(size * margin_frac))
    target = max(1, size - 2 * pad)
    s = target / max(iw, ih)
    nw, nh = max(1, int(round(iw * s))), max(1, int(round(ih * s)))
    ink = ink.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("L", (size, size), 0)
    canvas.paste(ink, ((size - nw) // 2, (size - nh) // 2))
    return np.asarray(canvas, dtype=np.uint8)


def render_face(path, face, cp_to_idx, size, margin_frac, out_dir, render_px, fonts_dirs):
    op = out_name(path, face, out_dir)
    if os.path.exists(op):
        return ("skip", path, face, 0)
    try:
        tt = (TTCollection(path, lazy=True).fonts[face] if path.lower().endswith((".ttc", ".otc"))
              else TTFont(path, lazy=True, fontNumber=0))
        cmap = tt.getBestCmap()
        if not cmap:
            return ("nocmap", path, face, 0)
        try:
            pil = ImageFont.truetype(path, render_px, index=face)
        except Exception:
            return ("pilfail", path, face, 0)

        # per-font tofu sentinel
        sent_hash = None
        if SENTINEL_CP not in cmap:
            sg = render_glyph(pil, chr(SENTINEL_CP), size, margin_frac)
            if sg is not None:
                sent_hash = sg.tobytes()

        xs, ys = [], []
        for cp, idx in cp_to_idx.items():
            if cp not in cmap:
                continue
            g = render_glyph(pil, chr(cp), size, margin_frac)
            if g is None:
                continue
            if sent_hash is not None and g.tobytes() == sent_hash:
                continue
            xs.append(g)
            ys.append(idx)
        if not xs:
            # write an empty marker so we don't retry this face
            np.savez(op + ".tmp", x=np.zeros((0, size, size), np.uint8), y=np.zeros((0,), np.int16),
                     src=source_of(path, fonts_dirs))
            os.replace(op + ".tmp.npz", op)
            return ("empty", path, face, 0)
        X = np.stack(xs).astype(np.uint8)
        Y = np.asarray(ys, dtype=np.int16)
        np.savez(op + ".tmp", x=X, y=Y, src=source_of(path, fonts_dirs))
        os.replace(op + ".tmp.npz", op)
        return ("ok", path, face, len(ys))
    except Exception as e:
        return ("error:" + str(e)[:60], path, face, 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fonts", nargs="+", default=["E:/glyphset/fonts"])
    ap.add_argument("--local", default=True, action=argparse.BooleanOptionalAction,
                    help="also render locally-installed Windows fonts (--no-local to skip)")
    ap.add_argument("--classes", default="E:/glyphset/classes.json")
    ap.add_argument("--out", default="E:/glyphset/data/renders")
    ap.add_argument("--size", type=int, default=96)
    ap.add_argument("--margin", type=float, default=0.10)
    ap.add_argument("--render-px", type=int, default=200)
    ap.add_argument("--jobs", type=int, default=0, help="0 = all cores")
    ap.add_argument("--limit", type=int, default=0, help="limit faces (smoke test)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    with open(args.classes, "r", encoding="utf-8") as f:
        spec = json.load(f)
    cp_to_idx = {c["cp"]: i for i, c in enumerate(spec["classes"])}
    size = spec["meta"].get("img_size", args.size)
    print(f"{len(cp_to_idx)} classes, size {size}")

    font_dirs = list(args.fonts)
    if args.local:
        local = (os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
                 os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts"))
        have = [os.path.abspath(x) for x in font_dirs]
        for d in local:
            if os.path.isdir(d) and os.path.abspath(d) not in have:
                font_dirs.append(d)
    print("font dirs:", font_dirs)

    faces = list_faces(font_dirs)
    if args.limit:
        faces = faces[: args.limit]
    print(f"{len(faces)} font faces (incl. local: {args.local})")
    if not faces:
        print("No fonts found — run download_fonts.py first.")
        sys.exit(1)

    n_jobs = args.jobs if args.jobs > 0 else -1
    results = Parallel(n_jobs=n_jobs, backend="loky", verbose=5)(
        delayed(render_face)(p, fi, cp_to_idx, size, args.margin, args.out, args.render_px, font_dirs)
        for (p, fi) in faces
    )

    from collections import Counter
    status = Counter(r[0].split(":")[0] for r in results)
    total = sum(r[3] for r in results)
    print(f"\nDone. samples={total:,}  faces: {dict(status)}")
    # write a manifest
    with open(os.path.join(args.out, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"classes": args.classes, "size": size, "faces": len(faces),
                   "samples": total, "status": dict(status)}, f, indent=0)


if __name__ == "__main__":
    main()
