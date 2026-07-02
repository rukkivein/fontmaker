#!/usr/bin/env python3
"""Pack the PAIR-KERNING dataset: turn the rendered edge profiles into per-face training
bundles with the OPTICAL-EVEN kern LABEL (kstar) and a kern-sanity quality score.

The label is a faithful, vectorized port of shared/kernvision.js: for each ordered pair
(L,R) it searches the kern that makes the pair's CLAMPED WHITE AREA equal the font's typical
pair white (the median over all pairs) — i.e. the gaps look optically EVEN. That kstar is the
self-supervised target Track B's model learns to predict (the user's "make it FEEL even",
learned across the corpus — no GPOS, no copying). aggr is NOT applied here: kstar is the FULL
even kern; the aggressiveness knob lives at apply time in the panel.

qscore gates junk/auto-spaced faces: a real font tightens open pairs (A-V, T-o, Y-o, W-A) and
leaves straight pairs (H-H, n-n, o-o) ~0. Faces that don't are dropped at train time by keep_frac.

Per face packed npz (adds to the rendered arrays):
  kstar  : [N,N] full optical-even kern, font units (i=left, j=right; diagonal unused)
  qscore : scalar kern-sanity (higher = better)
  + cls,left,right,adv,upm,capH,xH,weight,width,src,face,val  (val = whole-font holdout)

Usage:
  python pack_kernpair.py --npz E:/glyphset/kernpair_npz --out E:/glyphset/kernpair_packed [--jobs 0]
  (smoke: --npz C:/Temp/kp_smoke --out C:/Temp/kp_packed)
"""
import argparse, glob, hashlib, json, os
import numpy as np

TRAIN = [chr(c) for c in list(range(0x41, 0x5B)) + list(range(0x61, 0x7B)) + list(range(0x30, 0x3A))]
IDX = {ch: i for i, ch in enumerate(TRAIN)}                     # letter -> class id 0..61
# optical-sanity probes (must be present in the face to count)
OPEN_PAIRS = [('A', 'V'), ('V', 'A'), ('T', 'o'), ('T', 'a'), ('Y', 'o'), ('Y', 'a'),
              ('W', 'A'), ('A', 'W'), ('F', 'a'), ('P', 'a'), ('r', 'o'), ('V', 'o'), ('L', 'T')]
STRAIGHT_PAIRS = [('H', 'H'), ('H', 'I'), ('I', 'H'), ('n', 'n'), ('o', 'o'), ('H', 'n'), ('m', 'n')]

MAXDEPTH_FRAC, FLOOR_FRAC = 0.33, 0.012
KMIN_FRAC, KMAX_FRAC, STEP_FRAC = -0.12, 0.06, 0.004


def font_hash01(name):
    return int(hashlib.blake2b(name.encode("utf-8"), digest_size=8).hexdigest(), 16) / 2**64


def kstar_matrix(left, right, adv, upm):
    """Vectorized kernvision: returns (kstar[N,N] font units, target white area).
    left/right are [N,H] edge profiles (NaN = no ink at that row)."""
    N, H = left.shape
    maxDepth = MAXDEPTH_FRAC * upm
    floor = FLOOR_FRAC * upm
    Lr = right[:, None, :]                      # left member uses its RIGHT edge  [N,1,H]
    Rl = left[None, :, :]                       # right member uses its LEFT edge  [1,N,H]
    both = np.isfinite(Lr) & np.isfinite(Rl)    # [N,N,H] — only rows where BOTH have ink count
    # (one-sided rows are vertical mismatch kern can't fix → excluded; see kernvision.js whiteArea)

    # candidate kerns
    K = np.arange(KMIN_FRAC * upm, KMAX_FRAC * upm + 1e-6, STEP_FRAC * upm)   # [M]
    M = K.shape[0]
    advL = adv[:, None, None, None]                                          # [N,1,1,1]
    gap = advL + K[None, None, :, None] + Rl[:, :, None, :] - Lr[:, :, None, :]   # [N,N,M,H]
    bm = both[:, :, None, :]
    clamped = np.clip(gap, 0.0, maxDepth)
    area = (clamped * bm).sum(axis=3)                                        # [N,N,M]
    collided = (bm & (gap < floor)).any(axis=3)                              # [N,N,M]

    # target = median pair white at kern=0 (closest candidate to 0)
    k0 = int(np.argmin(np.abs(K)))
    area0 = area[:, :, k0]
    valid0 = (area0 > 0) & (~collided[:, :, k0])
    eye = np.eye(N, dtype=bool)
    valid0 &= ~eye
    target = float(np.median(area0[valid0])) if valid0.any() else 0.0

    # k* = candidate whose area is closest to target, collided masked out
    err = np.abs(area - target)
    err[collided] = np.inf
    allbad = np.isinf(err).all(axis=2)
    ksel = np.argmin(err, axis=2)                                            # [N,N]
    kstar = K[ksel]
    kstar[allbad] = KMAX_FRAC * upm                                          # never found safe → loosest
    kstar[eye] = 0.0
    return kstar.astype(np.float32), target


def pack_face(path, out_dir):
    op = os.path.join(out_dir, os.path.basename(path).replace("_kp.npz", "_pk.npz"))
    if os.path.exists(op):
        return ("skip", 0.0)
    try:
        d = np.load(path, allow_pickle=True)
        cls = d["cls"]; left = d["left"].astype(np.float64); right = d["right"].astype(np.float64)
        adv = d["adv"].astype(np.float64); upm = float(d["upm"]) or 1000.0
        N = cls.shape[0]
        if N < 20:
            return ("sparse", 0.0)
        gpos = d["gpos"].astype(np.float32) if "gpos" in d.files else np.zeros((N, N), np.float32)
        has_gpos = int(d["has_gpos"]) if "has_gpos" in d.files else int((gpos != 0).any())
        kstar, target = kstar_matrix(left, right, adv, upm)

        pos = {int(c): i for i, c in enumerate(cls.tolist())}   # class id -> row index
        def kv(a, b):
            ia, ib = pos.get(IDX[a]), pos.get(IDX[b])
            return None if (ia is None or ib is None) else float(kstar[ia, ib])
        op_vals = [v for (a, b) in OPEN_PAIRS if (v := kv(a, b)) is not None]
        st_vals = [v for (a, b) in STRAIGHT_PAIRS if (v := kv(a, b)) is not None]
        if len(op_vals) < 4 or not st_vals:
            qscore = 0.0
        else:
            open_mean = np.mean(op_vals)               # want negative (tighten)
            straight_abs = np.mean(np.abs(st_vals))    # want small
            qscore = float((-open_mean - 0.5 * straight_abs) / upm)   # em units, higher = better

        np.savez(op + ".tmp", cls=cls, left=d["left"], right=d["right"], adv=d["adv"],
                 gpos=gpos, has_gpos=np.int16(has_gpos),
                 upm=d["upm"], capH=d["capH"], xH=d["xH"], weight=d["weight"], width=d["width"],
                 src=d["src"], face=d["face"], kstar=kstar, qscore=np.float32(qscore),
                 target=np.float32(target))
        os.replace(op + ".tmp.npz", op)
        return ("ok", qscore)
    except Exception as e:
        return ("error:" + str(e)[:60], 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", default="E:/glyphset/kernpair_npz")
    ap.add_argument("--out", default="E:/glyphset/kernpair_packed")
    ap.add_argument("--val-frac", type=float, default=0.06)
    ap.add_argument("--jobs", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.npz, "*_kp.npz")))
    print(f"{len(files)} rendered faces → packing labels")
    if not files:
        print("No rendered faces. Run render_kernpair.py first."); return

    try:
        from joblib import Parallel, delayed
        n_jobs = args.jobs if args.jobs > 0 else -1
        results = Parallel(n_jobs=n_jobs, backend="loky", verbose=5)(
            delayed(pack_face)(p, args.out) for p in files)
    except Exception:
        results = [pack_face(p, args.out) for p in files]

    # build the index: qscore + deterministic whole-font val split
    packed = sorted(glob.glob(os.path.join(args.out, "*_pk.npz")))
    index = []
    for p in packed:
        try:
            d = np.load(p, allow_pickle=True)
            name = os.path.basename(p)
            index.append({"file": name, "qscore": float(d["qscore"]),
                          "src": str(d["src"]), "n": int(d["cls"].shape[0]),
                          "has_gpos": int(d["has_gpos"]) if "has_gpos" in d.files else 0,
                          "val": font_hash01(name) < args.val_frac})
        except Exception:
            pass
    qs = sorted(x["qscore"] for x in index)
    p40 = qs[int(0.40 * (len(qs) - 1))] if qs else 0.0   # default keep top ~60%
    with open(os.path.join(args.out, "_index.json"), "w", encoding="utf-8") as f:
        json.dump({"count": len(index), "val_frac": args.val_frac,
                   "keep_qscore_p40": p40, "faces": index}, f)
    from collections import Counter
    status = Counter(r[0].split(":")[0] for r in results)
    nval = sum(1 for x in index if x["val"])
    print(f"\nDone. packed={len(index)} (val={nval})  faces: {dict(status)}  keep-qscore≥p40={p40:.4f}")


if __name__ == "__main__":
    main()
