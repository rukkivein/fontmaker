#!/usr/bin/env python3
"""Pack the per-font _sb.npz spacing renders into a memmap for training.

Like pack_dataset.py but the labels are CONTINUOUS (resid/prior/feats) and we add a
CURATION GATE: keep only fonts whose optical-sanity `qscore` (do O/C/G/T/V recede more
than H/I/E/L?) is in the top half — auto-spaced / junk fonts score ~0 and are dropped
whole. Val holds out WHOLE FONTS. Per-letter cap balances the 62 classes while keeping
many fonts per class.

Out under <out>/:
  X.u8     memmap uint8 [N,S,S]
  meta.npz resid[N,2] prior[N,2] feats[N,8] cls[N] font[N] val[N] size n
"""
import argparse, glob, hashlib, json, os
import numpy as np

NCLS = 62  # A-Z a-z 0-9


def font_hash01(name):
    return (int(hashlib.blake2b(name.encode("utf-8"), digest_size=8).hexdigest(), 16) % 10_000) / 10_000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--renders", default="E:/glyphset/spacing_npz")
    ap.add_argument("--out", default="E:/glyphset/spacing_packed")
    ap.add_argument("--val-frac", type=float, default=0.06)
    ap.add_argument("--cap", type=int, default=6000, help="max TRAIN samples per letter class")
    ap.add_argument("--val-cap", type=int, default=1500)
    ap.add_argument("--keep-frac", type=float, default=0.5, help="keep this top fraction of fonts by qscore")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if not args.force and os.path.exists(os.path.join(args.out, "X.u8")) and os.path.exists(os.path.join(args.out, "meta.npz")):
        print("already packed — skipping (use --force).", flush=True); return

    npzs = sorted(p for p in glob.glob(os.path.join(args.renders, "*.npz")) if not os.path.basename(p).startswith("_"))
    if not npzs:
        raise SystemExit("no _sb.npz found — run render_spacing.py first")

    # --- pass 0: per-font qscore → quality threshold (keep top keep-frac, and qscore>0) ---
    qs = []
    for p in npzs:
        try:
            with np.load(p) as z:
                if "qscore" in z and int(z["x"].shape[0]) > 0:
                    qs.append(float(z["qscore"]))
        except Exception:
            pass
    if not qs:
        raise SystemExit("no usable faces (all empty/sparse)")
    thr = max(1e-4, float(np.quantile(np.asarray(qs), 1.0 - args.keep_frac)))
    print(f"{len(npzs)} faces, qscore keep-threshold={thr:.4f} (top {args.keep_frac:.0%}, qscore>0)", flush=True)

    # --- pass 1: flat index of kept samples ---
    NPZ, LOC, CLS, VAL = [], [], [], []
    S = 96
    kept_faces = 0
    for fi, p in enumerate(npzs):
        try:
            with np.load(p) as z:
                n = int(z["x"].shape[0]) if "x" in z else 0
                if n == 0:
                    continue
                q = float(z["qscore"]) if "qscore" in z else 0.0
                if q < thr:
                    continue
                S = int(z["x"].shape[1])
                cls = z["cls"].astype(np.int32)
        except Exception:
            continue
        kept_faces += 1
        isval = font_hash01(os.path.basename(p)) < args.val_frac
        NPZ.append(np.full(n, fi, np.int32)); LOC.append(np.arange(n, dtype=np.int32))
        CLS.append(cls); VAL.append(np.full(n, isval, np.bool_))
        if (fi + 1) % 4000 == 0:
            print(f"  scanned {fi+1}/{len(npzs)}", flush=True)
    if not NPZ:
        raise SystemExit("quality gate dropped everything — lower --keep-frac")
    NPZ = np.concatenate(NPZ); LOC = np.concatenate(LOC); CLS = np.concatenate(CLS); VAL = np.concatenate(VAL)
    total = len(CLS)
    print(f"kept {kept_faces} faces, {total:,} samples, size {S}", flush=True)

    # --- selection: cap per letter-class (balance) within train/val ---
    rng = np.random.default_rng(0)
    keep = np.zeros(total, np.bool_)

    def cap(pool, c_cap):
        if len(pool) == 0:
            return
        order = pool[np.argsort(CLS[pool], kind="stable")]
        b = np.searchsorted(CLS[order], np.arange(NCLS + 1))
        for c in range(NCLS):
            seg = order[b[c]:b[c + 1]]
            if len(seg) > c_cap:
                seg = rng.choice(seg, c_cap, replace=False)
            keep[seg] = True

    cap(np.where(~VAL)[0], args.cap)
    cap(np.where(VAL)[0], args.val_cap)
    sel = np.where(keep)[0]
    N = len(sel)
    print(f"selected {N:,} (train cap {args.cap}/class) -> X.u8 ~{N*S*S/1e9:.1f} GB", flush=True)

    X = np.memmap(os.path.join(args.out, "X.u8"), dtype=np.uint8, mode="w+", shape=(N, S, S))
    resid = np.zeros((N, 2), np.float32); prior = np.zeros((N, 2), np.float32); feats = np.zeros((N, 8), np.float32)
    cls = CLS[sel].astype(np.int16); val = VAL[sel].copy(); font = NPZ[sel].astype(np.int32)

    by = {}
    sN, sL = NPZ[sel], LOC[sel]
    for oi in range(N):
        by.setdefault(int(sN[oi]), []).append((oi, int(sL[oi])))
    done = 0
    for fi, items in by.items():
        with np.load(npzs[fi]) as z:
            x, rz, pz, fz = z["x"], z["resid"], z["prior"], z["feats"]
            for (oi, li) in items:
                X[oi] = x[li]; resid[oi] = rz[li]; prior[oi] = pz[li]; feats[oi] = fz[li]
        done += 1
        if done % 4000 == 0:
            print(f"  written {done}/{len(by)} faces", flush=True)
    X.flush()
    np.savez(os.path.join(args.out, "meta.npz"), resid=resid, prior=prior, feats=feats,
             cls=cls, font=font, val=val, size=S, n=N)
    print(f"packed N={N:,}  train={int((~val).sum()):,}  val={int(val.sum()):,}  "
          f"|resid| mean={np.abs(resid).mean():.3f}", flush=True)


if __name__ == "__main__":
    main()
