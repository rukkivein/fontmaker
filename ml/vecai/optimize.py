"""Aşama 1 PROOF (v2): optimise cubic-Bézier contours to match a glyph with FEW,
clean anchors. Keys that make the inverse problem converge: a clean coarse init
(right topology), SOFTNESS ANNEALING (start blurry so gradients reach everywhere,
then sharpen), and COARSE-TO-FINE resolution. Saves target | init | OPTIMISED.
"""
import sys, torch, numpy as np
sys.path.insert(0, "C:/Users/okana/fontmaker/ml/vecai")
import diffvec as dv
from PIL import Image

FONT = "C:/Windows/Fonts/times.ttf"
DEV = "cuda" if torch.cuda.is_available() else "cpu"


def resample(c, K):
    d = np.sqrt(((np.roll(c, -1, 0) - c) ** 2).sum(1))
    s = np.concatenate([[0], np.cumsum(d)]); total = max(s[-1], 1e-9)
    cc = np.vstack([c, c[0]]); out = []; j = 0
    for t in np.linspace(0, total, K, endpoint=False):
        while j < len(s) - 1 and s[j + 1] < t: j += 1
        f = (t - s[j]) / max(s[j + 1] - s[j], 1e-9)
        out.append(cc[j] * (1 - f) + cc[j + 1] * f)
    return np.array(out, dtype=np.float32), total


def sample_contour(A, Hin, Hout, steps=12):
    p0, p1 = A, A + Hout
    p2, p3 = torch.roll(A, -1, 0) + torch.roll(Hin, -1, 0), torch.roll(A, -1, 0)
    t = torch.linspace(0, 1, steps + 1, device=A.device)[:-1]; mt = 1 - t
    pts = ((mt**3)[None, :, None]*p0[:, None] + (3*mt*mt*t)[None, :, None]*p1[:, None]
           + (3*mt*t*t)[None, :, None]*p2[:, None] + (t**3)[None, :, None]*p3[:, None])
    return pts.reshape(-1, 2)


def init_params(gt_contours):
    params = []
    for c in gt_contours:
        _, peri = resample(c, 4)
        K = int(min(30, max(7, round(peri / 0.085))))   # ~1 anchor / 0.085 perimeter
        A, _ = resample(c, K)
        nxt, prv = np.roll(A, -1, 0), np.roll(A, 1, 0)
        params.append({
            "A": torch.tensor(A, device=DEV, requires_grad=True),
            "Hout": torch.tensor((nxt - A) / 3, device=DEV, requires_grad=True),
            "Hin": torch.tensor((prv - A) / 3, device=DEV, requires_grad=True),
        })
    return params


def blur_for(size):
    return max(0.7, size / 150.0)   # slight anti-aliasing, scales with resolution


def render(params, size, tau, steps=12):
    polys = [sample_contour(p["A"], p["Hin"], p["Hout"], steps) for p in params]
    return dv.aa_raster(polys, size, tau=tau, blur=blur_for(size))


def g1(params):  # smooth flow: in/out handles opposite (light; corners can override)
    return sum(((p["Hout"] + p["Hin"]) ** 2).mean() for p in params)


def to_png(occ):
    return 255 - (occ.detach().clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)


def run(char):
    gt = dv.normalize_contours(dv.glyph_contours(FONT, char))
    gt_t = [torch.tensor(c, device=DEV) for c in gt]
    params = init_params(gt)
    init_img = to_png(render(params, 256, 0.01))
    flat = [t for p in params for t in p.values()]
    opt = torch.optim.Adam(flat, lr=0.02)
    # coarse-to-fine + softness annealing
    stages = [(96, 0.06, 160), (144, 0.03, 160), (224, 0.014, 220)]
    for size, tau0, iters in stages:
        target = dv.aa_raster(gt_t, size, tau=tau0, blur=blur_for(size)).detach()
        for it in range(iters):
            tau = tau0 * (1 - 0.6 * it / iters)          # sharpen within the stage
            opt.zero_grad()
            occ = render(params, size, tau)
            loss = ((occ - target) ** 2).mean() + 0.003 * g1(params)
            loss.backward(); opt.step()
    target_hi = dv.aa_raster(gt_t, 256, tau=0.008, blur=blur_for(256)).detach()
    final = render(params, 256, 0.008)
    npts = sum(p["A"].shape[0] for p in params)
    print(f"{char}: anchors={npts}  MSE init->final "
          f"{((render(init_params(gt),256,0.008)-target_hi)**2).mean().item():.4f} -> "
          f"{((final-target_hi)**2).mean().item():.4f}")
    return [to_png(target_hi), init_img, to_png(final)]


chars = sys.argv[1] if len(sys.argv) > 1 else "AagO"
rows = []
for ch in chars:
    t = run(ch); gap = np.full((256, 8), 200, np.uint8)
    rows.append(np.concatenate([t[0], gap, t[1], gap, t[2]], 1))
sep = np.full((8, rows[0].shape[1]), 160, np.uint8)
sheet = rows[0]
for r in rows[1:]: sheet = np.concatenate([sheet, sep, r], 0)
Image.fromarray(sheet, "L").save("C:/Users/okana/fontmaker/ml/vecai/_optimize.png")
print("saved _optimize.png  (TARGET | init | OPTIMISED)")
