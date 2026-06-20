#!/usr/bin/env python3
"""Export the trained best.pt -> ONNX (fp32 + INT8) + labels.json / metrics.json,
memory-SAFELY. Calibration runs on a val SUBSET so it can never OOM (the full
1.7M val-logits autograd is what stalled the in-train export). No retraining."""
import argparse, json, os
import numpy as np, torch
from torch.utils.data import DataLoader
from train import (make_model, fit_temperature, accuracy_topk,
                   expected_calibration_error, export_onnx, load_packed,
                   collect_logits, PackedDS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packed", default="E:/glyphset/data/packed")
    ap.add_argument("--out", default="E:/glyphset/out")
    ap.add_argument("--calib", type=int, default=30000, help="# val samples used for calibration")
    args = ap.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", device, flush=True)

    xpath, shape, y, val, S, nclasses, classes_path = load_packed(args.packed)
    va_idx = np.where(val)[0]
    rng = np.random.default_rng(0)
    if len(va_idx) > args.calib:
        va_idx = np.sort(rng.choice(va_idx, args.calib, replace=False))
    print(f"calibrating on {len(va_idx):,} val samples; classes={nclasses} size={S}", flush=True)
    va = DataLoader(PackedDS(xpath, shape, y, va_idx), batch_size=512, shuffle=False,
                    num_workers=4, pin_memory=True)

    model = make_model(nclasses).to(device)
    ckpt = os.path.join(args.out, "best.pt")
    st = torch.load(ckpt, map_location=device)
    model.load_state_dict(st["model"])
    print(f"loaded best.pt (epoch {st.get('epoch')}, best top1 {st.get('best'):.4f})", flush=True)

    logits, yv = collect_logits(model, va, device)
    print(f"val logits {tuple(logits.shape)}", flush=True)
    T = fit_temperature(logits, yv)
    acc = accuracy_topk(logits, yv)
    ece = expected_calibration_error((logits / T).softmax(1), yv)
    print(f"FINAL: top1 {acc['top1']:.4f} top3 {acc['top3']:.4f} T={T:.3f} ECE={ece:.4f}", flush=True)

    with open(classes_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    labels = [{"cp": c["cp"], "char": c["char"]} for c in spec["classes"]]
    with open(os.path.join(args.out, "labels.json"), "w", encoding="utf-8") as f:
        json.dump({"size": S, "temperature": T, "classes": labels}, f, ensure_ascii=False)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump({"top1": acc["top1"], "top3": acc["top3"], "ece": ece, "T": T, "classes": nclasses}, f, indent=0)

    Xmm = np.memmap(xpath, dtype=np.uint8, mode="r", shape=shape)
    calib = (np.asarray(Xmm[va_idx[:200]]).astype(np.float32) / 255.0)[:, None, :, :]
    export_onnx(model, T, S, nclasses, args.out, calib)
    print("EXPORT DONE ->", args.out, flush=True)


if __name__ == "__main__":
    main()
