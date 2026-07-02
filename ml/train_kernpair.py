#!/usr/bin/env python3
"""Train the RuneType PAIR-KERNING model and export it for onnxruntime-web (Track B).

Self-supervised optical kerning: the model sees a rendered PAIR (2-channel silhouette: left
glyph, right glyph) spaced at some kern and predicts the correction (cap-height units) to the
OPTICAL-EVEN spacing kstar that pack_kernpair.py computed (the kernvision white-area target).
We render the pair at a RANDOM kern across the range and label it (kstar - kern)/capH — a
perturb-and-recover objective, so at inference (pair shown at the natural advance, kern=0) the
model outputs ~kstar/capH, the even kern. NO GPOS, no copying — it learns the optical-evenness
rule across the whole corpus. Track A (kernvision) then VERIFIES the proposal before it ships.

Pairs are composited ON THE FLY from the stored edge profiles (tiny + infinite spacing aug),
so there is no giant pre-rendered image set. Mirrors train_spacing.py (MobileNetV3-Small trunk,
SmoothL1, AdamW/OneCycle/AMP, best-by-val-MAE, fp32 ONNX opset-17).

  python train_kernpair.py --packed E:/glyphset/kernpair_packed --out E:/glyphset/kernpair_out --epochs 30
  python train_kernpair.py --packed C:/Temp/kp_packed --out C:/Temp/kp_out --smoke
"""
import argparse, json, os, time, glob
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import torchvision

HC, WC, PXEM = 64, 96, 56          # pair silhouette: 64 rows (=profile rows), 96 px wide, 56 px/em
NCTX = 6
KREN_LO, KREN_HI = -0.15, 0.08     # render kern sampled across this em range (covers natural+tight+loose)
LABEL_CLIP = 0.6                    # cap-height units


def fmt_hm(s):
    return "?" if (s is None or s < 0 or s != s) else f"{int(s//3600)}h{int((s%3600)//60):02d}m"


def _winit(wid):
    # per-worker numpy seed — else every DataLoader worker shares numpy's state and draws
    # IDENTICAL random faces/pairs/kerns (PyTorch only re-seeds random+torch, not numpy).
    np.random.seed((torch.initial_seed() + wid) % (2**32))


def render_pair(left, right, adv, i, j, k, upm):
    """2-channel silhouette [2,HC,WC] in [0,1] for pair (i left, j right) at kern k (font units),
    fixed PXEM scale (so the gap scale is real), joint-centered horizontally."""
    s = PXEM / upm
    Ll, Lr = left[i], right[i]
    Rl, Rr = left[j] + adv[i] + k, right[j] + adv[i] + k
    fin = np.concatenate([Ll[np.isfinite(Ll)], Lr[np.isfinite(Lr)], Rl[np.isfinite(Rl)], Rr[np.isfinite(Rr)]])
    img = np.zeros((2, HC, WC), np.float32)
    if fin.size == 0:
        return img
    cx = 0.5 * (fin.min() + fin.max())
    ox = WC / 2.0 - cx * s
    for r in range(HC):                       # profile row r (0=bottom band) -> image row (top=0)
        rr = HC - 1 - r
        a, b = Ll[r], Lr[r]
        if np.isfinite(a) and np.isfinite(b):
            x0 = int(a * s + ox); x1 = int(b * s + ox) + 1
            x0 = 0 if x0 < 0 else (WC if x0 > WC else x0); x1 = 0 if x1 < 0 else (WC if x1 > WC else x1)
            if x1 > x0: img[0, rr, x0:x1] = 1.0
        a, b = Rl[r], Rr[r]
        if np.isfinite(a) and np.isfinite(b):
            x0 = int(a * s + ox); x1 = int(b * s + ox) + 1
            x0 = 0 if x0 < 0 else (WC if x0 > WC else x0); x1 = 0 if x1 < 0 else (WC if x1 > WC else x1)
            if x1 > x0: img[1, rr, x0:x1] = 1.0
    return img


class PairDS(Dataset):
    """Lazily loads packed per-face npz (cached per worker) and composites random pairs.
    Train mode: virtual length, random face/pair/kern each call. Val mode: a fixed sample list."""
    def __init__(self, files, length, val_list=None):
        self.files = files
        self.length = length
        self.val_list = val_list            # list of (file_idx, i, j, k) or None for train
        self._cache = {}

    def __len__(self):
        return len(self.val_list) if self.val_list is not None else self.length

    def _face(self, fi):
        f = self._cache.get(fi)
        if f is None:
            d = np.load(self.files[fi], allow_pickle=True)
            left = d["left"].astype(np.float32); right = d["right"].astype(np.float32)
            adv = d["adv"].astype(np.float32)
            cls = d["cls"].astype(np.int64)
            upm = float(d["upm"]) or 1000.0; capH = float(d["capH"]) or 0.7 * upm
            N = cls.shape[0]
            # TARGET = real foundry GPOS kern (0 where the font left a pair un-kerned). Training on
            # this teaches the model what a real type designer does — incl. ~0 for flat pairs (H-H),
            # which is what fixes the straight-pair over-tightening of the optical-only model.
            tgt = d["gpos"].astype(np.float32) if "gpos" in d.files else d["kstar"].astype(np.float32)
            # sample weight: base 0.25 keeps PLENTY of zero-kern (straight) pairs in view so the model
            # learns "most pairs = 0", with kerned pairs upweighted by their magnitude.
            w = 0.25 + np.abs(tgt) / upm
            np.fill_diagonal(w, 0.0)
            w = w.reshape(-1); ws = w.sum()
            probs = (w / ws) if ws > 0 else None
            isl = ((cls >= 26) & (cls < 52)).astype(np.float32)   # a-z
            f = dict(left=left, right=right, adv=adv, tgt=tgt, cls=cls, upm=upm, capH=capH,
                     N=N, probs=probs, isl=isl,
                     w=float(d["weight"]) / 900.0, wd=float(d["width"]) / 9.0,
                     cap=capH / upm, xh=(float(d["xH"]) / capH) if capH else 0.5)
            self._cache[fi] = f
        return f

    def _make(self, fi, i, j, k):
        f = self._face(fi)
        img = render_pair(f["left"], f["right"], f["adv"], i, j, k, f["upm"])
        label = float(np.clip((f["tgt"][i, j] - k) / f["capH"], -LABEL_CLIP, LABEL_CLIP))
        ctx = np.array([f["w"], f["wd"], f["cap"], f["xh"], f["isl"][i], f["isl"][j]], np.float32)
        return (torch.from_numpy(img), torch.from_numpy(ctx), torch.tensor([label], dtype=torch.float32))

    def __getitem__(self, idx):
        if self.val_list is not None:
            fi, i, j, k = self.val_list[idx]
            return self._make(fi, i, j, k)
        rng = np.random
        fi = rng.randint(len(self.files))
        f = self._face(fi)
        N, probs = f["N"], f["probs"]
        flat = rng.choice(N * N, p=probs) if probs is not None else rng.randint(N * N)
        i, j = divmod(int(flat), N)
        if i == j:
            j = (j + 1) % N
        k = (rng.uniform(KREN_LO, KREN_HI)) * f["upm"]
        return self._make(fi, i, j, k)


class KPNet(nn.Module):
    """MobileNetV3-Small trunk on the 2-channel pair silhouette + ctx scalars -> kern residual."""
    def __init__(self, nctx=NCTX):
        super().__init__()
        m = torchvision.models.mobilenet_v3_small(weights=None)
        c0 = m.features[0][0]
        m.features[0][0] = nn.Conv2d(2, c0.out_channels, c0.kernel_size, c0.stride, c0.padding, bias=False)
        fdim = m.classifier[0].in_features
        self.trunk = nn.Sequential(m.features, m.avgpool, nn.Flatten())
        self.head = nn.Sequential(nn.Linear(fdim + nctx, 128), nn.Hardswish(), nn.Dropout(0.1), nn.Linear(128, 1))

    def forward(self, img, ctx):
        return self.head(torch.cat([self.trunk(img), ctx], dim=1))


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval(); abser, n = 0.0, 0; ps, ts = [], []
    for img, ctx, yb in loader:
        img = img.to(device).float(); ctx = ctx.to(device).float(); yb = yb.to(device).float()
        with torch.autocast("cuda", enabled=(device == "cuda")):
            p = model(img, ctx).float()
        abser += (p - yb).abs().sum().item(); n += yb.numel(); ps.append(p.cpu()); ts.append(yb.cpu())
    P, T = torch.cat(ps), torch.cat(ts)
    return abser / max(1, n), (P.std().item(), T.std().item())


def build_file_lists(packed):
    idx = json.load(open(os.path.join(packed, "_index.json")))
    # train ONLY on faces that carry real foundry kern (GPOS/legacy) — that is the target. Fonts
    # with no kern table would supply all-zero labels and bias the model toward predicting nothing.
    faces = [x for x in idx["faces"] if x.get("has_gpos", 0) == 1]
    if not faces:                                                  # fallback: optical-only corpus
        keep_q = idx.get("keep_qscore_p40", 0.0)
        faces = [x for x in idx["faces"] if x["qscore"] >= keep_q]
    base = packed
    tr = [os.path.join(base, x["file"]) for x in faces if not x["val"]]
    va = [os.path.join(base, x["file"]) for x in faces if x["val"]]
    if not va:
        va = tr[: max(1, len(tr) // 20)]
    return tr, va


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packed", default="E:/glyphset/kernpair_packed")
    ap.add_argument("--out", default="E:/glyphset/kernpair_out")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--steps", type=int, default=2000)       # train batches per epoch (virtual)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--val-samples", type=int, default=8000)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-hours", type=float, default=0.0)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", device, torch.cuda.get_device_name(0) if device == "cuda" else "", flush=True)

    tr_files, va_files = build_file_lists(args.packed)
    if args.smoke:
        args.epochs, args.steps, args.val_samples = 2, 60, 800
        args.workers = min(args.workers, 4)
    print(f"faces: train={len(tr_files)} val={len(va_files)}", flush=True)

    # fixed val sample list (deterministic)
    rng = np.random.default_rng(0)
    val_list = []
    for _ in range(args.val_samples):
        fi = int(rng.integers(len(va_files)))
        try:
            d = np.load(va_files[fi], allow_pickle=True); N = int(d["cls"].shape[0]); upm = float(d["upm"]) or 1000.0
        except Exception:
            continue
        i = int(rng.integers(N)); j = int(rng.integers(N))
        if i == j: j = (j + 1) % N
        k = float(rng.uniform(KREN_LO, KREN_HI)) * upm
        val_list.append((fi, i, j, k))

    tr = DataLoader(PairDS(tr_files, args.steps * args.batch), batch_size=args.batch, shuffle=False,
                    num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0,
                    prefetch_factor=4 if args.workers else None, drop_last=True, worker_init_fn=_winit)
    va = DataLoader(PairDS(va_files, 0, val_list=val_list), batch_size=512, shuffle=False,
                    num_workers=max(2, args.workers // 2), pin_memory=True, persistent_workers=args.workers > 0)

    model = KPNet().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=5e-4)
    # Cosine annealing with WARM RESTARTS — robust for a long autonomous run: every cycle the LR
    # restarts and the model refines a fresh minimum; best-by-val-MAE keeps the overall best, so a
    # 2-day run keeps improving instead of decaying once (OneCycle) or overfitting (samples are
    # freshly randomized each step, so there is effectively infinite data — no epoch overfit).
    sched = torch.optim.lr_scheduler.CosineAnnealingWarmRestarts(
        opt, T_0=max(5, args.epochs // 10), T_mult=2, eta_min=args.lr * 0.02)
    scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))

    ckpt = os.path.join(args.out, "best.pt"); start_ep, best = 0, 1e9
    if os.path.exists(ckpt) and not args.smoke and not args.fresh:
        st = torch.load(ckpt, map_location=device)
        model.load_state_dict(st["model"]); start_ep = st.get("epoch", 0) + 1; best = st.get("best", 1e9)
        print(f"resumed epoch {start_ep}, best MAE {best:.4f}", flush=True)

    t_all = time.time(); total_b = max(1, args.epochs * len(tr))
    for ep in range(start_ep, args.epochs):
        model.train(); t0 = time.time(); seen = 0
        for bi, (img, ctx, yb) in enumerate(tr):
            img = img.to(device, non_blocking=True).float(); ctx = ctx.to(device, non_blocking=True).float()
            yb = yb.to(device, non_blocking=True).float()
            with torch.autocast("cuda", enabled=(device == "cuda")):
                pred = model(img, ctx); loss = F.smooth_l1_loss(pred, yb, beta=0.03)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward(); scaler.step(opt); scaler.update()
            seen += yb.shape[0]
            if bi % 50 == 0:
                el = time.time() - t_all; doneb = ep * len(tr) + bi; ov = 100.0 * doneb / total_b
                eta = el * (total_b / max(doneb, 1) - 1) if doneb > 0 else None
                ips = seen / (time.time() - t0 + 1e-9)
                print(f"  [ep {ep+1}/{args.epochs} {100*bi/len(tr):3.0f}%] loss {loss.item():.4f} | "
                      f"{ips:,.0f} smp/s | overall {ov:.1f}% | ETA {fmt_hm(eta)}", flush=True)
        mae, (ps, ts) = evaluate(model, va, device)
        sched.step()                          # cosine warm-restarts advance per epoch
        print(f"epoch {ep}: val MAE {mae:.4f} | pred-std {ps:.3f} vs target-std {ts:.3f}  ({time.time()-t0:.0f}s)", flush=True)
        if mae <= best:
            best = mae
            torch.save({"model": model.state_dict(), "epoch": ep, "best": best}, ckpt)
        if args.max_hours > 0 and (time.time() - t_all) > args.max_hours * 3600:
            print(f"reached --max-hours {args.max_hours}; stopping.", flush=True); break

    if os.path.exists(ckpt):
        model.load_state_dict(torch.load(ckpt, map_location=device)["model"])
    mae, (ps, ts) = evaluate(model, va, device)
    print(f"FINAL: val MAE {mae:.4f} | pred-std {ps:.3f} vs target-std {ts:.3f}", flush=True)

    model.eval().cpu()
    di, dc = torch.zeros(1, 2, HC, WC), torch.zeros(1, NCTX)
    onx = os.path.join(args.out, "kernpair.onnx")
    torch.onnx.export(model, (di, dc), onx, opset_version=17,
                      input_names=["img", "ctx"], output_names=["resid"],
                      dynamic_axes={"img": {0: "batch"}, "ctx": {0: "batch"}, "resid": {0: "batch"}})
    with open(os.path.join(args.out, "kernpair_meta.json"), "w", encoding="utf-8") as f:
        json.dump({"hc": HC, "wc": WC, "pxem": PXEM, "nctx": NCTX, "label_clip": LABEL_CLIP,
                   "kren": [KREN_LO, KREN_HI], "val_mae": mae,
                   "ctx_order": ["weight/900", "width/9", "capH/upm", "xH/capH", "leftIsLower", "rightIsLower"]}, f)
    print("exported", onx, flush=True)


if __name__ == "__main__":
    main()
