#!/usr/bin/env python3
"""Train the RuneType glyph recognizer and export it for onnxruntime-web.

Pipeline: packed memmap -> MobileNetV3-Small (1-channel, 96x96) with heavy GPU
augmentation (affine/perspective/elastic/morphology/blur/noise — bridges the
clean-render -> decorative/blackletter/trace domain gap) -> label smoothing ->
whole-font validation + ECE -> temperature calibration (baked into the exported
logits) -> ONNX (opset 17) + INT8 static quantization for the WASM backend.

Outputs under <out>/: best.pt, glyph_fp32.onnx, glyph_int8.onnx, labels.json, metrics.json.

Usage:
  python train.py --packed E:/glyphset/data/packed --out E:/glyphset/out --epochs 40 --batch 384
  python train.py --packed E:/glyphset/data/packed --out E:/glyphset/out --smoke   # fast end-to-end check
"""
import argparse, json, math, os, time
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import torchvision

try:
    import kornia.augmentation as K
    HAVE_KORNIA = True
except Exception:
    HAVE_KORNIA = False


def fmt_hm(sec):
    if sec is None or sec < 0 or sec != sec:
        return "?"
    return f"{int(sec // 3600)}h{int((sec % 3600) // 60):02d}m"


# ------------------------------- data ---------------------------------------
class PackedDS(Dataset):
    # Holds only the memmap PATH + shape (small, picklable). Each DataLoader
    # worker opens its OWN memmap lazily on first access — pickling the 15GB
    # memmap to workers is what crashed Windows spawn ("pickle data truncated").
    def __init__(self, xpath, shape, y, idx):
        self.xpath, self.shape, self.y, self.idx = xpath, shape, y, idx
        self.X = None

    def __len__(self):
        return len(self.idx)

    def __getitem__(self, i):
        if self.X is None:
            self.X = np.memmap(self.xpath, dtype=np.uint8, mode="r", shape=self.shape)
        j = int(self.idx[i])
        x = torch.from_numpy(np.array(self.X[j], dtype=np.uint8))  # copy (memmap is read-only)
        return x, int(self.y[j])


def load_packed(packed):
    meta = np.load(os.path.join(packed, "meta.npz"), allow_pickle=True)
    N, S, nclasses = int(meta["n"]), int(meta["size"]), int(meta["nclasses"])
    xpath = os.path.join(packed, "X.u8")
    y = meta["y"].astype(np.int64)
    val = meta["val"].astype(bool)
    return xpath, (N, S, S), y, val, S, nclasses, str(meta["classes_path"])


# ------------------------------- model --------------------------------------
def make_model(nclasses):
    m = torchvision.models.mobilenet_v3_small(weights=None)
    c0 = m.features[0][0]
    m.features[0][0] = nn.Conv2d(1, c0.out_channels, kernel_size=c0.kernel_size,
                                 stride=c0.stride, padding=c0.padding, bias=False)
    m.classifier[3] = nn.Linear(m.classifier[3].in_features, nclasses)
    return m


class ExportWrap(nn.Module):
    """Bakes temperature scaling into the graph so the panel just softmaxes."""
    def __init__(self, model, T=1.0):
        super().__init__()
        self.model = model
        self.register_buffer("T", torch.tensor(float(T)))

    def forward(self, x):
        return self.model(x) / self.T


# ------------------------------- augmentation -------------------------------
class GpuAug(nn.Module):
    def __init__(self):
        super().__init__()
        if HAVE_KORNIA:
            self.geo = K.AugmentationSequential(
                K.RandomAffine(degrees=10.0, translate=(0.08, 0.08), scale=(0.8, 1.2), shear=12.0, p=0.9),
                K.RandomPerspective(0.3, p=0.3),
                K.RandomElasticTransform(kernel_size=(31, 31), sigma=(16.0, 16.0), alpha=(1.0, 1.0), p=0.25),
                same_on_batch=False,
            )
            self.blur = K.RandomGaussianBlur((3, 3), (0.1, 1.5), p=0.25)
            self.noise = K.RandomGaussianNoise(mean=0.0, std=0.05, p=0.25)
        else:
            self.geo = self.blur = self.noise = None

    def forward(self, x):  # x: float [B,1,H,W] in [0,1]
        if self.geo is not None:
            x = self.geo(x)
        # morphology -> stroke-weight (decorative/blackletter) variation
        r = torch.rand(2)
        if r[0] < 0.4:
            if r[1] < 0.5:
                x = F.max_pool2d(x, 3, 1, 1)            # dilate (heavier)
            else:
                x = -F.max_pool2d(-x, 3, 1, 1)          # erode (lighter)
        if self.blur is not None:
            x = self.blur(x)
            x = self.noise(x)
        if torch.rand(1).item() < 0.08:                 # rare polarity flip
            x = 1.0 - x
        return x.clamp(0, 1)


# ------------------------------- eval/calib ---------------------------------
@torch.no_grad()
def collect_logits(model, loader, device):
    model.eval()
    L, Y = [], []
    for x, y in loader:
        x = x.to(device).float().div_(255).unsqueeze(1)
        with torch.autocast("cuda", enabled=(device == "cuda")):
            out = model(x)
        L.append(out.float().cpu()); Y.append(y)
    return torch.cat(L), torch.cat(Y)


def accuracy_topk(logits, y, ks=(1, 3)):
    out = {}
    maxk = max(ks)
    _, pred = logits.topk(maxk, 1, True, True)
    correct = pred.eq(y.view(-1, 1))
    for k in ks:
        out[f"top{k}"] = correct[:, :k].any(1).float().mean().item()
    return out


def expected_calibration_error(probs, y, n_bins=15):
    conf, pred = probs.max(1)
    acc = pred.eq(y).float()
    bins = torch.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        m = (conf > bins[i]) & (conf <= bins[i + 1])
        if m.any():
            ece += (m.float().mean() * (acc[m].mean() - conf[m].mean()).abs()).item()
    return ece


def fit_temperature(logits, y):
    T = torch.nn.Parameter(torch.ones(1))
    opt = torch.optim.LBFGS([T], lr=0.05, max_iter=80)
    nll = nn.CrossEntropyLoss()

    def closure():
        opt.zero_grad()
        loss = nll(logits / T.clamp(min=1e-2), y)
        loss.backward()
        return loss
    opt.step(closure)
    return float(T.detach().clamp(min=1e-2).item())


# ------------------------------- ONNX export --------------------------------
def export_onnx(model, T, size, nclasses, out_dir, calib_X):
    model.eval()
    wrap = ExportWrap(model, T).eval().cpu()   # export/trace on CPU (params + dummy aligned)
    dummy = torch.zeros(1, 1, size, size)
    fp32 = os.path.join(out_dir, "glyph_fp32.onnx")
    torch.onnx.export(wrap, dummy, fp32, opset_version=17,
                      input_names=["input"], output_names=["logits"],
                      dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}})
    print("exported", fp32)
    try:
        from onnxruntime.quantization import quantize_static, CalibrationDataReader, QuantType, QuantFormat

        class DR(CalibrationDataReader):
            def __init__(self, X, n=200):
                self.data = iter([{"input": X[i:i + 1].astype(np.float32)} for i in range(min(n, len(X)))])

            def get_next(self):
                return next(self.data, None)

        int8 = os.path.join(out_dir, "glyph_int8.onnx")
        quantize_static(fp32, int8, DR(calib_X), quant_format=QuantFormat.QDQ,
                        per_channel=True, weight_type=QuantType.QInt8)
        print("exported", int8)
    except Exception as e:
        print("INT8 quantization skipped:", e)


# ------------------------------- train --------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packed", default="E:/glyphset/data/packed")
    ap.add_argument("--out", default="E:/glyphset/out")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=384)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-hours", type=float, default=0.0, help="stop after this many hours (0 = no cap)")
    ap.add_argument("--fresh", action="store_true", help="ignore any checkpoint, train from scratch")
    ap.add_argument("--smoke", action="store_true", help="tiny end-to-end run to validate the pipeline")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", device, torch.cuda.get_device_name(0) if device == "cuda" else "", flush=True)

    xpath, shape, y, val, S, nclasses, classes_path = load_packed(args.packed)
    tr_idx = np.where(~val)[0]
    va_idx = np.where(val)[0]
    if args.smoke:
        rng = np.random.default_rng(0)
        tr_idx = rng.choice(tr_idx, size=min(20000, len(tr_idx)), replace=False)
        va_idx = rng.choice(va_idx, size=min(4000, len(va_idx)), replace=False) if len(va_idx) else tr_idx[:2000]
        args.epochs = 1
    print(f"N={len(y):,} train={len(tr_idx):,} val={len(va_idx):,} classes={nclasses} size={S}", flush=True)

    tr = DataLoader(PackedDS(xpath, shape, y, tr_idx), batch_size=args.batch, shuffle=True,
                    num_workers=args.workers, pin_memory=True, persistent_workers=args.workers > 0,
                    prefetch_factor=4 if args.workers else None, drop_last=True)
    va = DataLoader(PackedDS(xpath, shape, y, va_idx), batch_size=512, shuffle=False,
                    num_workers=max(2, args.workers // 2), pin_memory=True, persistent_workers=args.workers > 0)

    model = make_model(nclasses).to(device)
    aug = GpuAug().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, epochs=args.epochs,
                                                steps_per_epoch=max(1, len(tr)))
    scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))
    lossfn = nn.CrossEntropyLoss(label_smoothing=0.1)

    ckpt = os.path.join(args.out, "best.pt")
    start_ep, best = 0, 0.0
    if os.path.exists(ckpt) and not args.smoke and not args.fresh:
        st = torch.load(ckpt, map_location=device)
        model.load_state_dict(st["model"]); start_ep = st.get("epoch", 0) + 1; best = st.get("best", 0.0)
        print(f"resumed from epoch {start_ep}, best top1 {best:.4f}")

    print(f"starting training: {args.epochs} epochs, batch {args.batch}. spawning {args.workers} data "
          f"workers — FIRST BATCH IN ~30-60s, please wait (do NOT close the window)…", flush=True)
    train_t0 = time.time()
    total_b = max(1, args.epochs * len(tr))   # for overall % / ETA
    for ep in range(start_ep, args.epochs):
        model.train(); t0 = time.time(); seen = 0
        for bi, (x, yb) in enumerate(tr):
            x = x.to(device, non_blocking=True).float().div_(255).unsqueeze(1)
            yb = yb.to(device, non_blocking=True)
            with torch.no_grad():
                x = aug(x)
            with torch.autocast("cuda", enabled=(device == "cuda")):
                out = model(x); loss = lossfn(out, yb)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
            seen += yb.numel()
            if bi % 50 == 0:
                el = time.time() - train_t0
                doneb = ep * len(tr) + bi
                ov = 100.0 * doneb / total_b
                ips = seen / (time.time() - t0 + 1e-9)
                eta = el * (total_b / max(doneb, 1) - 1) if doneb > 0 else None
                print(f"  [ep {ep+1}/{args.epochs} {100*bi/len(tr):3.0f}%] {bi}/{len(tr)} | loss {loss.item():.2f} | {ips:,.0f} img/s | overall {ov:.1f}% | ETA {fmt_hm(eta)}", flush=True)
        # validate
        logits, yv = collect_logits(model, va, device)
        acc = accuracy_topk(logits, yv)
        print(f"epoch {ep}: top1 {acc['top1']:.4f} top3 {acc['top3']:.4f}  ({time.time()-t0:.0f}s)", flush=True)
        if acc["top1"] >= best:
            best = acc["top1"]
            torch.save({"model": model.state_dict(), "epoch": ep, "best": best}, ckpt)
        # wall-clock budget: stop after --max-hours (keeps total time bounded)
        if args.max_hours > 0 and (time.time() - train_t0) > args.max_hours * 3600:
            print(f"reached --max-hours {args.max_hours} after epoch {ep}; stopping early.", flush=True)
            break

    # calibrate on val + metrics
    if os.path.exists(ckpt):
        model.load_state_dict(torch.load(ckpt, map_location=device)["model"])
    logits, yv = collect_logits(model, va, device)
    T = fit_temperature(logits, yv)
    probs = (logits / T).softmax(1)
    acc = accuracy_topk(logits, yv)
    ece = expected_calibration_error(probs, yv)
    print(f"FINAL: top1 {acc['top1']:.4f} top3 {acc['top3']:.4f}  T={T:.3f}  ECE={ece:.4f}")

    # labels.json (shared with the panel) + metrics
    with open(classes_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    labels = [{"cp": c["cp"], "char": c["char"]} for c in spec["classes"]]
    with open(os.path.join(args.out, "labels.json"), "w", encoding="utf-8") as f:
        json.dump({"size": S, "temperature": T, "classes": labels}, f, ensure_ascii=False)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump({"top1": acc["top1"], "top3": acc["top3"], "ece": ece, "T": T,
                   "n": int(len(y)), "classes": nclasses}, f, indent=0)

    # calibration set for INT8 (normalized like inference)
    Xmm = np.memmap(xpath, dtype=np.uint8, mode="r", shape=shape)
    calib = (np.asarray(Xmm[va_idx[:200]]).astype(np.float32) / 255.0)[:, None, :, :]
    export_onnx(model, T, S, nclasses, args.out, calib)
    print("done ->", args.out)


if __name__ == "__main__":
    main()
