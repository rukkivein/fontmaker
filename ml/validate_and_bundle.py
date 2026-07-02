#!/usr/bin/env python3
"""Validate the trained pair-kern ONNX on held-out GPOS faces and, IF it passes, bundle it into
the CEP extension (cep/js/lib/model/). Run by run_kernpair_all.bat after training; its exit code
gates the bundle+install so a bad model never ships while the user is away.

GATE (the bias the optical-only model failed):
  - STRAIGHT pairs (H-H, n-n, o-o, l-l, H-I) must predict ~0   (median |pred| small)
  - OPEN pairs (A-V, T-o, Y-o, W-A, V-A, P-A) must predict clearly negative (mean < 0)
  - overall MAE vs real GPOS on probe pairs is reported

  python validate_and_bundle.py --packed E:/glyphset/kernpair_packed --model E:/glyphset/kernpair_out \
         --dest C:/Users/okana/fontmaker/cep/js/lib/model
"""
import argparse, json, os, shutil, sys
import numpy as np
from train_kernpair import render_pair

TRAIN = [chr(c) for c in list(range(0x41, 0x5B)) + list(range(0x61, 0x7B)) + list(range(0x30, 0x3A))]
IDX = {ch: i for i, ch in enumerate(TRAIN)}
STRAIGHT = ['H,H', 'n,n', 'o,o', 'l,l', 'H,I', 'm,m', 'i,i']
OPEN = ['A,V', 'T,o', 'Y,o', 'W,A', 'V,A', 'P,a', 'L,T', 'r,o', 'T,a', 'F,a']


def _load_face_arrays(npz_path):
    d = np.load(npz_path, allow_pickle=True)
    cls = d["cls"]; upm = float(d["upm"]) or 1000.0; capH = float(d["capH"]) or 0.7 * upm
    N = cls.shape[0]
    gpos = d["gpos"].astype(np.float32) if "gpos" in d.files else np.zeros((N, N), np.float32)
    return dict(left=d["left"].astype(np.float32), right=d["right"].astype(np.float32),
                adv=d["adv"].astype(np.float32), gpos=gpos, cls=cls, upm=upm, capH=capH,
                w=float(d["weight"]) / 900.0, wd=float(d["width"]) / 9.0,
                cap=capH / upm, xh=(float(d["xH"]) / capH) if capH else 0.5,
                pos={int(c): i for i, c in enumerate(cls.tolist())})


def run_paragraph(args, emit):
    """Gate the running-strip (paragraph) model: G0 bias + G2 context-stability + G3 OOD-safety,
    and (optional) G1 challenger-must-win vs the pairwise baseline. Bundles paragraph.onnx only if
    sound; if a baseline exists and beats it, bundles the baseline; else bundles nothing (Track A lives)."""
    import onnxruntime as ort
    from train_paragraph import render_strip, LABEL_CLIP
    from render_dataset import list_faces, out_name
    onnx = os.path.join(args.model, "paragraph.onnx")
    if not os.path.exists(onnx):
        emit("FAIL: no paragraph.onnx at " + onnx); sys.exit(2)
    sess = ort.InferenceSession(onnx, providers=['CPUExecutionProvider'])
    inn = [i.name for i in sess.get_inputs()]
    isl = lambda c: 1.0 if 26 <= c < 52 else 0.0

    def predict(fa, i, j, neigh, kc=0.0):
        seq = [neigh[0], neigh[1], i, j, neigh[2], neigh[3]]
        img = render_strip(fa["left"], fa["right"], fa["adv"], seq, [0.0, 0.0, kc, 0.0, 0.0], fa["upm"])[None].astype(np.float32)
        ctx = np.array([[fa["w"], fa["wd"], fa["cap"], fa["xh"], isl(int(fa["cls"][i])), isl(int(fa["cls"][j]))]], np.float32)
        return float(sess.run(None, {inn[0]: img, inn[1]: ctx})[0][0, 0]) * fa["capH"]

    def ix(fa, ch): return fa["pos"].get(IDX[ch])
    def neutral(fa):
        for ch in ['n', 'o', 'H', 'a']:
            k = ix(fa, ch)
            if k is not None: return k
        return 0

    idx = json.load(open(os.path.join(args.packed, "_index.json")))
    valf = [x for x in idx["faces"] if x["val"] and x.get("has_gpos", 0) == 1][: args.faces]
    if not valf:
        valf = [x for x in idx["faces"] if x.get("has_gpos", 0) == 1][: args.faces]
    emit(f"[paragraph] validating on {len(valf)} held-out GPOS faces")

    # G0 bias + probe MAE (inference-matched: render at kern=0, neutral neighbors)
    straight_abs, open_pred, errs = [], [], []
    for x in valf:
        try: fa = _load_face_arrays(os.path.join(args.packed, x["file"]))
        except Exception: continue
        u2k = 1000.0 / fa["upm"]; nb = neutral(fa); neigh = [nb, nb, nb, nb]
        for pp in STRAIGHT:
            i, j = ix(fa, pp.split(',')[0]), ix(fa, pp.split(',')[1])
            if i is None or j is None: continue
            p = predict(fa, i, j, neigh); straight_abs.append(abs(p) * u2k); errs.append(abs(p - float(fa["gpos"][i, j])) * u2k)
        for pp in OPEN:
            i, j = ix(fa, pp.split(',')[0]), ix(fa, pp.split(',')[1])
            if i is None or j is None: continue
            p = predict(fa, i, j, neigh); open_pred.append(p * u2k); errs.append(abs(p - float(fa["gpos"][i, j])) * u2k)
    s_med = float(np.median(straight_abs)) if straight_abs else 999
    o_mean = float(np.mean(open_pred)) if open_pred else 0
    mae = float(np.mean(errs)) if errs else 999
    emit(f"G0 straight |pred| median = {s_med:.1f}u (gate < {args.straight_max})")
    emit(f"G0 open pred mean        = {o_mean:.1f}u (gate < {args.open_max})")
    emit(f"   probe MAE vs GPOS     = {mae:.1f}u")
    g0 = (s_med < args.straight_max) and (o_mean < args.open_max)

    # G2 context-stability: same open pair (T,o) in 4 neighbor contexts → spread bounded
    spreads = []
    for x in valf[:150]:
        try: fa = _load_face_arrays(os.path.join(args.packed, x["file"]))
        except Exception: continue
        i, j = ix(fa, 'T'), ix(fa, 'o')
        if i is None or j is None: continue
        u2k = 1000.0 / fa["upm"]; ctxs = []
        for cc in ['l', 'm', 'H', 'o']:
            n = ix(fa, cc)
            if n is not None: ctxs.append(predict(fa, i, j, [n, n, n, n]) * u2k)
        if len(ctxs) >= 3: spreads.append(max(ctxs) - min(ctxs))
    g2_spread = float(np.median(spreads)) if spreads else 0.0
    emit(f"G2 context spread (T,o median) = {g2_spread:.1f}u (gate < {args.context_spread_max})")
    g2 = g2_spread < args.context_spread_max

    # G3 OOD sanity on the user's display faces → finite + bounded
    g3 = True; ood_n = 0
    if args.ood:
        from render_kernpair import render_kernpair_face
        tmp = os.path.join(os.environ.get("TEMP", "C:/Temp"), "para_ood"); os.makedirs(tmp, exist_ok=True)
        for dood in args.ood:
            try: faces = list_faces([dood])[:6]
            except Exception: faces = []
            for (p, fi) in faces:
                try:
                    render_kernpair_face(p, fi, tmp, [dood])
                    npz = out_name(p, fi, tmp).replace(".npz", "_kp.npz")
                    if not os.path.exists(npz): continue
                    fa = _load_face_arrays(npz); nb = neutral(fa)
                    for pp in (OPEN[:4] + STRAIGHT[:3]):
                        i, j = ix(fa, pp.split(',')[0]), ix(fa, pp.split(',')[1])
                        if i is None or j is None: continue
                        v = predict(fa, i, j, [nb, nb, nb, nb]); ood_n += 1
                        if (not np.isfinite(v)) or abs(v) >= LABEL_CLIP * fa["capH"]:
                            g3 = False; emit(f"G3 OOD FAIL {os.path.basename(p)} {pp}: {v}")
                except Exception as e:
                    emit("G3 OOD skip: " + str(e)[:50])
    emit(f"G3 OOD sanity: {ood_n} probes, ok={g3}")

    # G1 challenger-must-win (optional — needs the pairwise baseline onnx)
    g1 = True; baseline_better = False
    bonnx = os.path.join(args.baseline, "kernpair.onnx") if args.baseline else ""
    if bonnx and os.path.exists(bonnx):
        try:
            from train_kernpair import render_pair
            bs = ort.InferenceSession(bonnx, providers=['CPUExecutionProvider']); bn = [i.name for i in bs.get_inputs()]
            berr = []
            for x in valf:
                try: fa = _load_face_arrays(os.path.join(args.packed, x["file"]))
                except Exception: continue
                u2k = 1000.0 / fa["upm"]
                for pp in (OPEN + STRAIGHT):
                    i, j = ix(fa, pp.split(',')[0]), ix(fa, pp.split(',')[1])
                    if i is None or j is None: continue
                    img = render_pair(fa["left"], fa["right"], fa["adv"], i, j, 0.0, fa["upm"])[None].astype(np.float32)
                    ctx = np.array([[fa["w"], fa["wd"], fa["cap"], fa["xh"], isl(int(fa["cls"][i])), isl(int(fa["cls"][j]))]], np.float32)
                    bp = float(bs.run(None, {bn[0]: img, bn[1]: ctx})[0][0, 0]) * fa["capH"]
                    berr.append(abs(bp - float(fa["gpos"][i, j])) * u2k)
            mae_base = float(np.mean(berr)) if berr else 999
            emit(f"G1 paragraph MAE {mae:.1f}u vs baseline MAE {mae_base:.1f}u")
            if mae > mae_base: g1 = False; baseline_better = True
        except Exception as e:
            emit("G1 baseline compare skipped: " + str(e)[:60])
    else:
        emit("G1 no baseline onnx — judging paragraph on G0/G2/G3 only")

    # ---- decision + bundle ----
    if baseline_better and g0 and g2 and g3:
        os.makedirs(args.dest, exist_ok=True)
        shutil.copy2(bonnx, os.path.join(args.dest, "kernpair.onnx"))
        bm = os.path.join(args.baseline, "kernpair_meta.json")
        if os.path.exists(bm): shutil.copy2(bm, os.path.join(args.dest, "kernpair_meta.json"))
        emit("G1 lost — bundled the pairwise BASELINE (still a success)."); sys.exit(0)
    if g0 and g1 and g2 and g3:
        os.makedirs(args.dest, exist_ok=True)
        shutil.copy2(onnx, os.path.join(args.dest, "paragraph.onnx"))
        pm = os.path.join(args.model, "paragraph_meta.json")
        if os.path.exists(pm): shutil.copy2(pm, os.path.join(args.dest, "paragraph_meta.json"))
        emit("PASS -- bundled paragraph.onnx -> " + args.dest); sys.exit(0)
    emit(f"FAIL: gates g0={g0} g1={g1} g2={g2} g3={g3} -- NOT bundling."); sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--packed", default="E:/glyphset/kernpair_packed")
    ap.add_argument("--model", default="E:/glyphset/kernpair_out")
    ap.add_argument("--dest", default="C:/Users/okana/fontmaker/cep/js/lib/model")
    ap.add_argument("--faces", type=int, default=400)
    ap.add_argument("--straight-max", type=float, default=28.0)   # median |pred| on straight pairs (units, upm-norm to 1000)
    ap.add_argument("--open-max", type=float, default=-22.0)      # mean pred on open pairs must be below this
    ap.add_argument("--arch", default="pair", choices=["pair", "paragraph"])
    ap.add_argument("--baseline", default="")                    # pairwise kernpair_out2 dir (challenger-must-win)
    ap.add_argument("--ood", action="append", default=[])        # OOD font dirs (the user's display faces)
    ap.add_argument("--context-spread-max", type=float, default=18.0)
    ap.add_argument("--log", default="")
    args = ap.parse_args()

    def emit(msg):
        print(msg, flush=True)
        if args.log:
            try:
                with open(args.log, "a", encoding="utf-8", errors="replace") as lf:
                    lf.write(msg + "\n")
            except Exception:
                pass

    if args.arch == "paragraph":
        return run_paragraph(args, emit)

    onnx = os.path.join(args.model, "kernpair.onnx")
    if not os.path.exists(onnx):
        print("FAIL: no kernpair.onnx at", onnx); sys.exit(2)
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx, providers=['CPUExecutionProvider'])
    inn = [i.name for i in sess.get_inputs()]

    idx = json.load(open(os.path.join(args.packed, "_index.json")))
    valf = [x for x in idx["faces"] if x["val"] and x.get("has_gpos", 0) == 1][: args.faces]
    if not valf:
        valf = [x for x in idx["faces"] if x.get("has_gpos", 0) == 1][: args.faces]
    print(f"validating on {len(valf)} held-out GPOS faces")

    straight_abs, open_pred, errs = [], [], []
    for x in valf:
        try:
            d = np.load(os.path.join(args.packed, x["file"]), allow_pickle=True)
        except Exception:
            continue
        cls = d["cls"]; pos = {int(c): i for i, c in enumerate(cls.tolist())}
        left = d["left"].astype(np.float32); right = d["right"].astype(np.float32); adv = d["adv"].astype(np.float32)
        upm = float(d["upm"]) or 1000.0; capH = float(d["capH"]) or 0.7 * upm
        gpos = d["gpos"] if "gpos" in d.files else None
        w = float(d["weight"]) / 900.0; wd = float(d["width"]) / 9.0
        cap = capH / upm; xh = (float(d["xH"]) / capH) if capH else 0.5
        u2k = 1000.0 / upm                                    # normalize to a 1000-upm scale for the gate

        def predict(pp):
            a, b = pp.split(','); ia, ib = pos.get(IDX[a]), pos.get(IDX[b])
            if ia is None or ib is None:
                return None
            img = render_pair(left, right, adv, ia, ib, 0.0, upm)[None].astype(np.float32)
            isl = lambda c: 1.0 if 26 <= c < 52 else 0.0
            ctx = np.array([[w, wd, cap, xh, isl(int(cls[ia])), isl(int(cls[ib]))]], np.float32)
            r = float(sess.run(None, {inn[0]: img, inn[1]: ctx})[0][0, 0])
            return r * capH, (float(gpos[ia, ib]) if gpos is not None else None)

        for pp in STRAIGHT:
            pr = predict(pp)
            if pr: straight_abs.append(abs(pr[0]) * u2k);
            if pr and pr[1] is not None: errs.append(abs(pr[0] - pr[1]) * u2k)
        for pp in OPEN:
            pr = predict(pp)
            if pr: open_pred.append(pr[0] * u2k)
            if pr and pr[1] is not None: errs.append(abs(pr[0] - pr[1]) * u2k)

    s_med = float(np.median(straight_abs)) if straight_abs else 999
    o_mean = float(np.mean(open_pred)) if open_pred else 0
    mae = float(np.mean(errs)) if errs else 999
    emit(f"straight |pred| median = {s_med:.1f} units  (gate < {args.straight_max})")
    emit(f"open pred mean        = {o_mean:.1f} units  (gate < {args.open_max})")
    emit(f"probe MAE vs real GPOS = {mae:.1f} units")

    ok = (s_med < args.straight_max) and (o_mean < args.open_max)
    if not ok:
        emit("FAIL: model did not pass the bias gate -- NOT bundling."); sys.exit(1)

    os.makedirs(args.dest, exist_ok=True)
    shutil.copy2(onnx, os.path.join(args.dest, "kernpair.onnx"))
    meta = os.path.join(args.model, "kernpair_meta.json")
    if os.path.exists(meta):
        shutil.copy2(meta, os.path.join(args.dest, "kernpair_meta.json"))
    emit("PASS -- bundled kernpair.onnx -> " + args.dest); sys.exit(0)


if __name__ == "__main__":
    main()
