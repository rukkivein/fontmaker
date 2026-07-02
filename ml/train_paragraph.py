#!/usr/bin/env python3
"""Train the RuneType PARAGRAPH (running-strip) kerning model — Track B-2.

The user's vision, literally: don't learn a FONT, learn a PARAGRAPH's optical rhythm. So instead
of scoring an isolated pair, this renders a RUNNING STRIP — the center pair C·T plus 2 real
neighbor glyphs each side (6 glyphs in view) — as one grayscale image, centered so the gap under
analysis sits at the strip's middle (W/2), and regresses the CENTER gap's kern correction while
SEEING the neighbor rhythm. Self-supervised perturb-and-recover against REAL foundry spacing
(advance + GPOS): render the center at real_gpos[C,T] + Δ, label = -Δ/capH (recover the foundry
gap). Neighbor gaps get small independent jitter so the model judges evenness inside an IMPERFECT
rhythm, not against a clean baseline. Because the recover-target is real GPOS (H-H/n-n ≈ 0), flat
pairs train toward ~0 — the straight-pair over-tightening bias is structurally gone.

This is a guarded CHALLENGER: validate_and_bundle.py --arch paragraph bundles it ONLY if it beats
the pairwise baseline on held-out fonts + passes the bias/context/OOD gates; else the baseline ships.

  python train_paragraph.py --packed E:/glyphset/kernpair_packed2 --out E:/glyphset/paragraph_out --epochs 700 --max-hours 44
  python train_paragraph.py --packed C:/Temp/para_packed --out C:/Temp/para_out --smoke
"""
import argparse, json, os, time, glob
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import torchvision

HC, WC, PXEM = 80, 192, 48          # 1-ch running strip: 80 rows, 192 px wide, 48 px/em
H_ROWS = 64                          # source edge-profile rows (band [-0.30,1.00] em), mapped into the 80-row strip
IN_CH, NCTX, CTXN = 1, 6, 2          # 1 channel; 6 ctx scalars; 2 neighbor glyphs each side -> 6 in view
KREN_LO, KREN_HI = -0.15, 0.08       # center-gap Δ range (em)
JIT_LO, JIT_HI = -0.06, 0.06         # neighbor-gap jitter (em)
LABEL_CLIP = 0.6
ZERO_ANCHOR = 0.18                   # fraction of windows forced to Δ_center=0 (do-nothing attractor)
JIT_PROB = 0.6                       # fraction of windows that jitter the neighbors


def fmt_hm(s):
    return "?" if (s is None or s < 0 or s != s) else f"{int(s//3600)}h{int((s%3600)//60):02d}m"


def _winit(wid):
    np.random.seed((torch.initial_seed() + wid) % (2**32))


def render_strip(left, right, adv, seq, kerns, upm):
    """6-glyph running strip [1,HC,WC], centered on the C|T pen boundary (the analyzed gap) at W/2.
    seq = [n0,n1,C,T,n3,n4] glyph row-indices; kerns = [k01,k12,kC,k34,k45] applied gaps (font units).
    Scanline-fills each glyph's [left,right] profile at its cumulative pen origin. Byte-parity twin =
    cep/js/kernvision.js stripSilhouette (same PXEM, trunc rounding, H-1-r flip)."""
    s = PXEM / upm
    penx = [0.0]
    for n in range(1, 6):
        penx.append(penx[-1] + float(adv[seq[n - 1]]) + float(kerns[n - 1]))
    cx = penx[3]                         # pen boundary entering the RIGHT center glyph = the gap under analysis
    ox = WC / 2.0 - cx * s
    img = np.zeros((1, HC, WC), np.float32)
    for n in range(6):
        gi, px = seq[n], penx[n]
        Ll, Lr = left[gi], right[gi]
        for r in range(H_ROWS):
            rr = HC - 1 - r              # source row r -> strip row (content lands in rows 16..79)
            a, b = Ll[r], Lr[r]
            if np.isfinite(a) and np.isfinite(b):
                x0 = int((a + px) * s + ox); x1 = int((b + px) * s + ox) + 1
                x0 = 0 if x0 < 0 else (WC if x0 > WC else x0)
                x1 = 0 if x1 < 0 else (WC if x1 > WC else x1)
                if x1 > x0:
                    img[0, rr, x0:x1] = 1.0
    return img


class StripDS(Dataset):
    def __init__(self, files, length, val_list=None):
        self.files = files; self.length = length; self.val_list = val_list; self._cache = {}

    def __len__(self):
        return len(self.val_list) if self.val_list is not None else self.length

    def _face(self, fi):
        f = self._cache.get(fi)
        if f is None:
            d = np.load(self.files[fi], allow_pickle=True)
            left = d["left"].astype(np.float32); right = d["right"].astype(np.float32)
            adv = d["adv"].astype(np.float32); cls = d["cls"].astype(np.int64)
            upm = float(d["upm"]) or 1000.0; capH = float(d["capH"]) or 0.7 * upm
            N = cls.shape[0]
            gpos = d["gpos"].astype(np.float32) if "gpos" in d.files else np.zeros((N, N), np.float32)
            w = 0.25 + np.abs(gpos) / upm
            np.fill_diagonal(w, 0.0)
            w = w.reshape(-1); ws = w.sum()
            probs = (w / ws) if ws > 0 else None
            isl = ((cls >= 26) & (cls < 52)).astype(np.float32)
            f = dict(left=left, right=right, adv=adv, gpos=gpos, cls=cls, upm=upm, capH=capH,
                     N=N, probs=probs, isl=isl, w=float(d["weight"]) / 900.0, wd=float(d["width"]) / 9.0,
                     cap=capH / upm, xh=(float(d["xH"]) / capH) if capH else 0.5)
            self._cache[fi] = f
        return f

    def _build(self, f, i, j, neigh, dC, jits):
        upm, capH, gp = f["upm"], f["capH"], f["gpos"]
        seq = [neigh[0], neigh[1], i, j, neigh[2], neigh[3]]
        kerns = [gp[seq[0], seq[1]] + jits[0], gp[seq[1], seq[2]] + jits[1],
                 gp[seq[2], seq[3]] + dC,      gp[seq[3], seq[4]] + jits[2],
                 gp[seq[4], seq[5]] + jits[3]]
        img = render_strip(f["left"], f["right"], f["adv"], seq, kerns, upm)
        label = float(np.clip(-dC / capH, -LABEL_CLIP, LABEL_CLIP))
        ctx = np.array([f["w"], f["wd"], f["cap"], f["xh"], f["isl"][i], f["isl"][j]], np.float32)
        return (torch.from_numpy(img), torch.from_numpy(ctx), torch.tensor([label], dtype=torch.float32))

    def __getitem__(self, idx):
        rng = np.random
        if self.val_list is not None:
            fi, i, j, neigh, dC, jits = self.val_list[idx]
            return self._build(self._face(fi), i, j, neigh, dC, jits)
        fi = rng.randint(len(self.files)); f = self._face(fi)
        N, probs = f["N"], f["probs"]
        flat = rng.choice(N * N, p=probs) if probs is not None else rng.randint(N * N)
        i, j = divmod(int(flat), N)
        if i == j:
            j = (j + 1) % N
        neigh = [int(rng.randint(N)) for _ in range(4)]                 # 2 real neighbors each side
        dC = 0.0 if rng.random() < ZERO_ANCHOR else float(rng.uniform(KREN_LO, KREN_HI)) * f["upm"]
        jits = [(float(rng.uniform(JIT_LO, JIT_HI)) * f["upm"] if rng.random() < JIT_PROB else 0.0) for _ in range(4)]
        return self._build(f, i, j, neigh, dC, jits)


class StripNet(nn.Module):
    """MobileNetV3-Small on the 1-channel running strip + ctx scalars -> center-gap correction."""
    def __init__(self, nctx=NCTX):
        super().__init__()
        m = torchvision.models.mobilenet_v3_small(weights=None)
        c0 = m.features[0][0]
        m.features[0][0] = nn.Conv2d(IN_CH, c0.out_channels, c0.kernel_size, c0.stride, c0.padding, bias=False)
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
    faces = [x for x in idx["faces"] if x.get("has_gpos", 0) == 1]
    if not faces:
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
    ap.add_argument("--packed", default="E:/glyphset/kernpair_packed2")
    ap.add_argument("--out", default="E:/glyphset/paragraph_out")
    ap.add_argument("--epochs", type=int, default=700)
    ap.add_argument("--steps", type=int, default=4000)
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
    print(f"faces: train={len(tr_files)} val={len(va_files)}  strip {HC}x{WC} pxem{PXEM}", flush=True)

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
        neigh = [int(rng.integers(N)) for _ in range(4)]
        dC = 0.0 if rng.random() < ZERO_ANCHOR else float(rng.uniform(KREN_LO, KREN_HI)) * upm
        jits = [(float(rng.uniform(JIT_LO, JIT_HI)) * upm if rng.random() < JIT_PROB else 0.0) for _ in range(4)]
        val_list.append((fi, i, j, neigh, dC, jits))

    tr = DataLoader(StripDS(tr_files, args.steps * args.batch), batch_size=args.batch, shuffle=False,
                    num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0,
                    prefetch_factor=4 if args.workers else None, drop_last=True, worker_init_fn=_winit)
    va = DataLoader(StripDS(va_files, 0, val_list=val_list), batch_size=512, shuffle=False,
                    num_workers=max(2, args.workers // 2), pin_memory=True, persistent_workers=args.workers > 0)

    model = StripNet().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=5e-4)
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
        sched.step()
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
    di, dc = torch.zeros(1, IN_CH, HC, WC), torch.zeros(1, NCTX)
    onx = os.path.join(args.out, "paragraph.onnx")
    torch.onnx.export(model, (di, dc), onx, opset_version=17,
                      input_names=["img", "ctx"], output_names=["resid"],
                      dynamic_axes={"img": {0: "batch"}, "ctx": {0: "batch"}, "resid": {0: "batch"}})
    with open(os.path.join(args.out, "paragraph_meta.json"), "w", encoding="utf-8") as f:
        json.dump({"hc": HC, "wc": WC, "pxem": PXEM, "in_ch": IN_CH, "ctxn": CTXN, "nctx": NCTX,
                   "label_clip": LABEL_CLIP, "kren": [KREN_LO, KREN_HI], "jit": [JIT_LO, JIT_HI],
                   "val_mae": mae, "ctx_order": ["weight/900", "width/9", "capH/upm", "xH/capH", "leftIsLower", "rightIsLower"]}, f)
    print("exported", onx, flush=True)


if __name__ == "__main__":
    main()
