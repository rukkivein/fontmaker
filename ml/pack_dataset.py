#!/usr/bin/env python3
"""Pack per-font .npz renders into a memmap for training, with a PER-CLASS CAP.

The raw renders are huge and imbalanced — every font has 'A' (~18k samples for
one class) while rare scripts have a handful. We cap each class to --cap train
samples (random subset); rare classes keep everything they have. This bounds the
packed array size AND balances the classes (better training, much faster). Val
holds out WHOLE FONTS (incl. decorative) so it measures real generalization.

Produces under <out>/:
  X.u8       memmap uint8 [N, S, S]
  meta.npz   y[int16], font[int32], val[bool], size, n, nclasses, classes_path
"""
import argparse, glob, hashlib, json, os
import numpy as np


def font_hash01(name):
    h = hashlib.blake2b(name.encode("utf-8"), digest_size=8).hexdigest()
    return (int(h, 16) % 10_000) / 10_000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--renders", default="E:/glyphset/data/renders")
    ap.add_argument("--out", default="E:/glyphset/data/packed")
    ap.add_argument("--classes", default="E:/glyphset/classes.json")
    ap.add_argument("--val-frac", type=float, default=0.04)
    ap.add_argument("--cap", type=int, default=700, help="max TRAIN samples per class")
    ap.add_argument("--val-cap", type=int, default=120, help="max VAL samples per class")
    ap.add_argument("--size", type=int, default=96)
    ap.add_argument("--force", action="store_true", help="repack even if X.u8 + meta.npz already exist")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if (not args.force and os.path.exists(os.path.join(args.out, "X.u8"))
            and os.path.exists(os.path.join(args.out, "meta.npz"))):
        print("already packed (X.u8 + meta.npz exist) — skipping. Use --force to repack.", flush=True)
        return

    with open(args.classes, "r", encoding="utf-8") as f:
        nclasses = len(json.load(f)["classes"])

    npzs = sorted(glob.glob(os.path.join(args.renders, "*.npz")))
    npzs = [p for p in npzs if not os.path.basename(p).startswith("_")]
    if not npzs:
        raise SystemExit("no renders found — run render_dataset.py first")

    # pass 1: flat arrays of (npz_idx, local_idx, label, is_val)
    NPZ, LOC, LAB, VAL = [], [], [], []
    S = args.size
    for fi, p in enumerate(npzs):
        with np.load(p) as z:
            y = z["y"]
            n = int(y.shape[0])
            if n == 0:
                continue
            if "x" in z:
                S = int(z["x"].shape[1])
        isval = font_hash01(os.path.basename(p)) < args.val_frac
        NPZ.append(np.full(n, fi, np.int32))
        LOC.append(np.arange(n, dtype=np.int32))
        LAB.append(y.astype(np.int32))
        VAL.append(np.full(n, isval, np.bool_))
        if (fi + 1) % 4000 == 0:
            print(f"  scanned {fi+1}/{len(npzs)} faces", flush=True)
    NPZ = np.concatenate(NPZ); LOC = np.concatenate(LOC)
    LAB = np.concatenate(LAB); VAL = np.concatenate(VAL)
    total = len(LAB)
    print(f"{len(npzs)} faces, {total:,} raw samples, size {S}", flush=True)

    # selection: cap TRAIN and VAL per class (random subset within each)
    rng = np.random.default_rng(0)
    keep = np.zeros(total, np.bool_)

    def cap_per_class(pool_idx, cap):
        if len(pool_idx) == 0:
            return
        order = pool_idx[np.argsort(LAB[pool_idx], kind="stable")]
        bounds = np.searchsorted(LAB[order], np.arange(nclasses + 1))
        for c in range(nclasses):
            seg = order[bounds[c]:bounds[c + 1]]
            if len(seg) > cap:
                seg = rng.choice(seg, cap, replace=False)
            keep[seg] = True

    cap_per_class(np.where(~VAL)[0], args.cap)
    cap_per_class(np.where(VAL)[0], args.val_cap)

    sel = np.where(keep)[0]
    N = len(sel)
    gb = N * S * S / 1e9
    print(f"selected {N:,} of {total:,} samples (train cap {args.cap}, val cap {args.val_cap}) -> X.u8 ~{gb:.1f} GB", flush=True)

    X = np.memmap(os.path.join(args.out, "X.u8"), dtype=np.uint8, mode="w+", shape=(N, S, S))
    y = LAB[sel].astype(np.int16)
    val = VAL[sel].copy()
    font = NPZ[sel].astype(np.int32)

    # group selected samples by source npz so each file opens once
    by = {}
    sel_npz, sel_loc = NPZ[sel], LOC[sel]
    for out_i in range(N):
        by.setdefault(int(sel_npz[out_i]), []).append((out_i, int(sel_loc[out_i])))
    done = 0
    for fi, items in by.items():
        with np.load(npzs[fi]) as z:
            x = z["x"]
            for (out_i, li) in items:
                X[out_i] = x[li]
        done += 1
        if done % 4000 == 0:
            print(f"  written {done}/{len(by)} faces", flush=True)
    X.flush()

    np.savez(os.path.join(args.out, "meta.npz"), y=y, font=font, val=val,
             size=S, n=N, nclasses=nclasses, classes_path=args.classes)
    binc = np.bincount(y[~val], minlength=nclasses)
    print(f"packed N={N:,}  train={int((~val).sum()):,}  val={int(val.sum()):,}  "
          f"classes-with-0-train={int((binc==0).sum())}  "
          f"min/median/max per class={binc.min()}/{int(np.median(binc))}/{binc.max()}", flush=True)


if __name__ == "__main__":
    main()
