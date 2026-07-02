#!/usr/bin/env python3
"""Train the RuneType SIDEBEARING model and export it for onnxruntime-web.

Regression: (96x96 glyph raster + 8 context scalars) -> [residL, residR] (the recession
residual over the analytic area-margin prior, in cap-height units). Reuses the recognizer
training scaffold (PackedDS lazy memmap, OneCycle/AMP, resumable best.pt, progress %/ETA)
but: a regression head, SmoothL1, SAFE augmentation only (translate/rotate<=2deg/blur/
noise + spike-injection — anything that moves the optical edge would falsify the label),
best-by-val-MAE, and a 2-INPUT fp32 ONNX (no temperature).

  python train_spacing.py --packed E:/glyphset/spacing_packed --out E:/glyphset/spacing_out --epochs 40
  python train_spacing.py --packed ... --out ... --smoke
"""
import argparse, json, os, time
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import torchvision

try:
    import kornia.augmentation as K
    HAVE_KORNIA = True
except Exception:
    HAVE_KORNIA = False


def fmt_hm(s):
    return "?" if (s is None or s < 0 or s != s) else f"{int(s//3600)}h{int((s%3600)//60):02d}m"


class PackedDS(Dataset):
    def __init__(self, xpath, shape, feats, resid, idx):
        self.xpath, self.shape, self.feats, self.resid, self.idx = xpath, shape, feats, resid, idx
        self.X = None

    def __len__(self):
        return len(self.idx)

    def __getitem__(self, i):
        if self.X is None:
            self.X = np.memmap(self.xpath, dtype=np.uint8, mode="r", shape=self.shape)
        j = int(self.idx[i])
        x = torch.from_numpy(np.array(self.X[j], dtype=np.uint8))
        return x, torch.from_numpy(self.feats[j]), torch.from_numpy(self.resid[j])


def load_packed(packed):
    meta = np.load(os.path.join(packed, "meta.npz"), allow_pickle=True)
    N, S = int(meta["n"]), int(meta["size"])
    return (os.path.join(packed, "X.u8"), (N, S, S),
            meta["feats"].astype(np.float32), meta["resid"].astype(np.float32),
            meta["val"].astype(bool), S, meta["cls"].astype(np.int64))


class SBNet(nn.Module):
    """MobileNetV3-Small trunk on the 1-channel raster, with the 8 context scalars
    concatenated before a small regression head -> [residL, residR]."""
    def __init__(self, nctx=8):
        super().__init__()
        m = torchvision.models.mobilenet_v3_small(weights=None)
        c0 = m.features[0][0]
        m.features[0][0] = nn.Conv2d(1, c0.out_channels, c0.kernel_size, c0.stride, c0.padding, bias=False)
        fdim = m.classifier[0].in_features                    # 576
        self.trunk = nn.Sequential(m.features, m.avgpool, nn.Flatten())
        self.head = nn.Sequential(nn.Linear(fdim + nctx, 128), nn.Hardswish(), nn.Dropout(0.1), nn.Linear(128, 2))

    def forward(self, x, ctx):
        return self.head(torch.cat([self.trunk(x), ctx], dim=1))


class SafeAug(nn.Module):
    """ONLY augmentations that preserve the area-margin recession (the label)."""
    def __init__(self):
        super().__init__()
        if HAVE_KORNIA:
            self.geo = K.AugmentationSequential(
                K.RandomAffine(degrees=2.0, translate=(0.02, 0.02), scale=None, shear=None, p=0.7),
                same_on_batch=False)
            self.blur = K.RandomGaussianBlur((3, 3), (0.1, 1.0), p=0.25)
            self.noise = K.RandomGaussianNoise(mean=0.0, std=0.04, p=0.25)
        else:
            self.geo = self.blur = self.noise = None

    def forward(self, x):  # x: [B,1,H,W] in [0,1]
        if self.geo is not None:
            x = self.geo(x)
            x = self.blur(x); x = self.noise(x)
        else:                                                 # minimal fallback: tiny translate + noise
            if torch.rand(1).item() < 0.7:
                dx, dy = int(torch.randint(-2, 3, (1,))), int(torch.randint(-2, 3, (1,)))
                x = torch.roll(x, shifts=(dy, dx), dims=(2, 3))
            x = x + 0.04 * torch.randn_like(x) * (torch.rand(1, device=x.device) < 0.25)
        # SPIKE-INJECTION: sparse bright px in a 1-px ring just OUTSIDE the ink — simulates
        # spikes/serifs/trace roughness; the area-mass edge (4%) barely moves, so the target
        # is preserved while the net learns to ignore protrusions (the sim->real bridge).
        if torch.rand(1).item() < 0.5:
            ink = (x > 0.25).float()
            ring = (F.max_pool2d(ink, 3, 1, 1) > 0).float() * (1.0 - ink)
            spikes = ring * (torch.rand_like(x) < 0.12).float()
            x = torch.maximum(x, spikes)
        return x.clamp(0, 1)


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    abser, n = 0.0, 0
    ps, ts = [], []
    for x, ctx, yb in loader:
        x = x.to(device).float().div_(255).unsqueeze(1); ctx = ctx.to(device).float(); yb = yb.to(device).float()
        with torch.autocast("cuda", enabled=(device == "cuda")):
            p = model(x, ctx).float()
        abser += (p - yb).abs().sum().item(); n += yb.numel()
        ps.append(p.cpu()); ts.append(yb.cpu())
    P, T = torch.cat(ps), torch.cat(ts)
    mae = abser / max(1, n)
    spread = (P.std().item(), T.std().item())             # collapse alarm: pred std should track target std
    return mae, spread


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packed", default="E:/glyphset/spacing_packed")
    ap.add_argument("--out", default="E:/glyphset/spacing_out")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-hours", type=float, default=0.0)
    ap.add_argument("--fresh", action="store_true")
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", device, torch.cuda.get_device_name(0) if device == "cuda" else "", flush=True)

    xpath, shape, feats, resid, val, S, cls = load_packed(args.packed)
    tr_idx, va_idx = np.where(~val)[0], np.where(val)[0]
    if args.smoke:
        rng = np.random.default_rng(0)
        tr_idx = rng.choice(tr_idx, size=min(8000, len(tr_idx)), replace=False)
        va_idx = rng.choice(va_idx, size=min(2000, len(va_idx)), replace=False) if len(va_idx) else tr_idx[:1000]
        args.epochs = 2
    print(f"N={shape[0]:,} train={len(tr_idx):,} val={len(va_idx):,} size={S}", flush=True)

    tr = DataLoader(PackedDS(xpath, shape, feats, resid, tr_idx), batch_size=args.batch, shuffle=True,
                    num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0,
                    prefetch_factor=4 if args.workers else None, drop_last=True)
    va = DataLoader(PackedDS(xpath, shape, feats, resid, va_idx), batch_size=1024, shuffle=False,
                    num_workers=max(2, args.workers // 2), pin_memory=True, persistent_workers=args.workers > 0)

    model = SBNet().to(device)
    aug = SafeAug().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, epochs=args.epochs, steps_per_epoch=max(1, len(tr)))
    scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))

    ckpt = os.path.join(args.out, "best.pt")
    start_ep, best = 0, 1e9
    if os.path.exists(ckpt) and not args.smoke and not args.fresh:
        st = torch.load(ckpt, map_location=device)
        model.load_state_dict(st["model"]); start_ep = st.get("epoch", 0) + 1; best = st.get("best", 1e9)
        print(f"resumed from epoch {start_ep}, best MAE {best:.4f}", flush=True)

    print(f"training {args.epochs} epochs, batch {args.batch}; spawning {args.workers} workers — "
          f"first batch in ~30-60s, do NOT close the window…", flush=True)
    t_all = time.time()
    total_b = max(1, args.epochs * len(tr))
    for ep in range(start_ep, args.epochs):
        model.train(); t0 = time.time(); seen = 0
        for bi, (x, ctx, yb) in enumerate(tr):
            x = x.to(device, non_blocking=True).float().div_(255).unsqueeze(1)
            ctx = ctx.to(device, non_blocking=True).float(); yb = yb.to(device, non_blocking=True).float()
            with torch.no_grad():
                x = aug(x)
            with torch.autocast("cuda", enabled=(device == "cuda")):
                pred = model(x, ctx)
                loss = F.smooth_l1_loss(pred, yb, beta=0.05)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
            seen += yb.shape[0]
            if bi % 50 == 0:
                el = time.time() - t_all; doneb = ep * len(tr) + bi
                ov = 100.0 * doneb / total_b
                eta = el * (total_b / max(doneb, 1) - 1) if doneb > 0 else None
                ips = seen / (time.time() - t0 + 1e-9)
                print(f"  [ep {ep+1}/{args.epochs} {100*bi/len(tr):3.0f}%] loss {loss.item():.4f} | "
                      f"{ips:,.0f} img/s | overall {ov:.1f}% | ETA {fmt_hm(eta)}", flush=True)
        mae, (ps, ts) = evaluate(model, va, device)
        print(f"epoch {ep}: val MAE {mae:.4f} | pred-std {ps:.3f} vs target-std {ts:.3f}  ({time.time()-t0:.0f}s)", flush=True)
        if mae <= best:
            best = mae
            torch.save({"model": model.state_dict(), "epoch": ep, "best": best}, ckpt)
        if args.max_hours > 0 and (time.time() - t_all) > args.max_hours * 3600:
            print(f"reached --max-hours {args.max_hours}; stopping after epoch {ep}.", flush=True); break

    if os.path.exists(ckpt):
        model.load_state_dict(torch.load(ckpt, map_location=device)["model"])
    mae, (ps, ts) = evaluate(model, va, device)
    print(f"FINAL: val MAE {mae:.4f} | pred-std {ps:.3f} vs target-std {ts:.3f}", flush=True)

    # 2-input fp32 ONNX (panel provides the raster + the 8 ctx scalars)
    model.eval().cpu()
    di, dc = torch.zeros(1, 1, S, S), torch.zeros(1, 8)
    onx = os.path.join(args.out, "spacing.onnx")
    torch.onnx.export(model, (di, dc), onx, opset_version=17,
                      input_names=["input", "ctx"], output_names=["resid"],
                      dynamic_axes={"input": {0: "batch"}, "ctx": {0: "batch"}, "resid": {0: "batch"}})
    with open(os.path.join(args.out, "spacing_meta.json"), "w", encoding="utf-8") as f:
        json.dump({"size": S, "nctx": 8, "band": 0.04, "val_mae": mae,
                   "feat_order": ["priorL", "priorR", "weight/900", "width/9", "contrast", "xH/capH", "spikiness", "isLower"]}, f)
    print("exported", onx, "->", args.out, flush=True)


if __name__ == "__main__":
    main()
