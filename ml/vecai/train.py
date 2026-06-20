"""Aşama 2 — train the hybrid REFINER on the font corpus (self-supervised).

Sample: a font glyph -> AA raster (input) + its own outline (the answer). The model
sees the raster + a ROUGH init (the GT outline coarsely resampled + jittered, a
stand-in for a classical trace) and nudges every anchor/handle so the rendered
result matches the high-quality GT render. Loss is the SAME differentiable raster
loss proven in Aşama 1, so no point-correspondence is needed. The model learns the
general skill "clean a rough outline into AAA using the image."

This is a FIRST run on a subset to show it learns; scale fonts/steps up after.
"""
import sys, os, glob, random, math
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
sys.path.insert(0, "C:/Users/okana/fontmaker/ml/vecai")
import diffvec as dv
from PIL import Image

DEV = "cuda" if torch.cuda.is_available() else "cpu"
FONT_DIR = "E:/glyphset/fonts"
CHARS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
# TWO models / TWO sliders:
#   'jitter' = remove design-level bumps/roughness (init = target + random noise)
#   'quant'  = remove AA/rasterisation pixel deformation + optimise points (init = raster grid)
MODE = sys.argv[3] if len(sys.argv) > 3 else "quant"
JITTER_SIGMA = 0.02
torch.manual_seed(0); random.seed(0); np.random.seed(0)


# ---- data ----------------------------------------------------------------
def list_fonts(n):
    fs = glob.glob(os.path.join(FONT_DIR, "**", "*.ttf"), recursive=True)
    fs += glob.glob(os.path.join(FONT_DIR, "**", "*.otf"), recursive=True)
    random.shuffle(fs)
    return fs[:n]


def resample(c, K):
    d = np.sqrt(((np.roll(c, -1, 0) - c) ** 2).sum(1))
    s = np.concatenate([[0], np.cumsum(d)]); total = max(s[-1], 1e-9)
    cc = np.vstack([c, c[0]]); out = []; j = 0
    for t in np.linspace(0, total, K, endpoint=False):
        while j < len(s) - 2 and s[j + 1] < t: j += 1
        f = min(max((t - s[j]) / max(s[j + 1] - s[j], 1e-9), 0.0), 1.0)
        out.append(cc[j] * (1 - f) + cc[j + 1] * f)
    return np.array(out, dtype=np.float32), total


def make_sample(font_path):
    """Return (gt_contours, target_anchors[clean], init_anchors[degraded]) or None.
    target = the original outline resampled to K anchors (the ANSWER); init = target
    roughened (a stand-in for a classical trace) — the model must recover target."""
    ch = random.choice(CHARS)
    try:
        gt = dv.normalize_contours(dv.glyph_contours(font_path, ch))
    except Exception:
        return None
    if not gt or sum(len(c) for c in gt) < 8:
        return None
    S = random.randint(50, 200)               # the resolution the glyph is rasterised at
    targets, inits = [], []
    for c in gt:
        _, peri = resample(c, 4)
        K = int(min(26, max(6, round(peri / 0.09))))    # ~original point COUNT
        A, _ = resample(c, K)                            # original point POSITIONS (target)
        tang = (np.roll(A, -1, 0) - np.roll(A, 1, 0)) / 6.0
        targets.append({"A": A.astype(np.float32),
                        "Hout": tang.astype(np.float32),
                        "Hin": (-tang).astype(np.float32)})
        if MODE == "jitter":
            init = A + np.random.normal(0, JITTER_SIGMA, A.shape)   # random bumps → smoothing AI
        else:                                                      # 'quant'
            init = np.round(A * S) / float(S)                       # raster grid → de-pixelate AI
        inits.append(init.astype(np.float32))
    return gt, targets, inits, S


def render_input(gt_t, S, msize=96):
    """The model's INPUT: render the glyph at S px (50–200, the sample's resolution),
    then BICUBIC-resample to the fixed model size — sharp anti-aliasing like a real
    image. The model recovers the same clean vector from any source resolution."""
    occ = dv.aa_raster(gt_t, S, tau=0.014, blur=max(0.55, S / 170.0)).detach()
    pil = Image.fromarray((occ.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8), "L")
    pil = pil.resize((msize, msize), Image.BICUBIC)
    arr = np.asarray(pil, np.float32) / 255.0
    return torch.tensor(arr, device=DEV).view(1, 1, msize, msize)   # ink = 1 inside


# ---- model ---------------------------------------------------------------
class Encoder(nn.Module):
    def __init__(self, c=48):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, c, 3, 2, 1), nn.GroupNorm(8, c), nn.SiLU(),     # S/2
            nn.Conv2d(c, c * 2, 3, 2, 1), nn.GroupNorm(8, c * 2), nn.SiLU(),  # S/4
            nn.Conv2d(c * 2, c * 2, 3, 1, 1), nn.GroupNorm(8, c * 2), nn.SiLU())
        self.fc_dim = c * 2

    def forward(self, img):           # img [1,1,S,S]
        f = self.net(img)             # [1, C, S/4, S/4]
        g = f.mean(dim=(2, 3))        # [1, C] global context
        return f, g


class Refiner(nn.Module):
    def __init__(self, c=48):
        super().__init__()
        self.enc = Encoder(c)
        d = self.enc.fc_dim
        self.head = nn.Sequential(
            nn.Linear(d + d + 2, 128), nn.SiLU(),
            nn.Linear(128, 128), nn.SiLU(),
            nn.Linear(128, 6))        # danchor(2), hout(2), hin(2)
        self.head[-1].weight.data.mul_(0.05); self.head[-1].bias.data.zero_()

    def forward(self, img, anchors):  # anchors: [N,2] in [0,1]
        f, g = self.enc(img)
        # bilinear sample feature at each anchor (grid_sample wants [-1,1])
        grid = (anchors * 2 - 1).view(1, 1, -1, 2)               # [1,1,N,2]
        samp = F.grid_sample(f, grid, align_corners=True)        # [1,C,1,N]
        samp = samp[0, :, 0, :].t()                              # [N,C]
        gN = g.expand(anchors.shape[0], -1)                      # [N,C]
        x = torch.cat([samp, gN, anchors], 1)                    # [N, C+C+2]
        out = self.head(x)
        dA = torch.tanh(out[:, :2]) * 0.12                        # bounded move
        hout = torch.tanh(out[:, 2:4]) * 0.25
        hin = torch.tanh(out[:, 4:6]) * 0.25
        A = anchors + dA
        return A, hin, hout


def sample_contour(A, Hin, Hout, steps=10):
    p0, p1 = A, A + Hout
    p2, p3 = torch.roll(A, -1, 0) + torch.roll(Hin, -1, 0), torch.roll(A, -1, 0)
    t = torch.linspace(0, 1, steps + 1, device=A.device)[:-1]; mt = 1 - t
    pts = ((mt**3)[None, :, None]*p0[:, None] + (3*mt*mt*t)[None, :, None]*p1[:, None]
           + (3*mt*t*t)[None, :, None]*p2[:, None] + (t**3)[None, :, None]*p3[:, None])
    return pts.reshape(-1, 2)


MSIZE = 96   # model input size
BLUR = max(0.7, MSIZE / 150.0)


def glyph_loss(model, gt, targets, inits, S):
    gt_t = [torch.tensor(c, device=DEV) for c in gt]
    img = render_input(gt_t, S, MSIZE)                               # multi-res sharp input
    target_render = dv.aa_raster(gt_t, MSIZE, tau=0.02, blur=BLUR).detach()
    polys, l_pos = [], 0.0
    for tg, A0 in zip(targets, inits):
        A, Hin, Hout = model(img, torch.tensor(A0, device=DEV))
        # DIRECT closeness to the ORIGINAL vector — anchors AND handles
        l_pos = l_pos + ((A - torch.tensor(tg["A"], device=DEV)) ** 2).mean() \
                      + ((Hout - torch.tensor(tg["Hout"], device=DEV)) ** 2).mean() \
                      + ((Hin - torch.tensor(tg["Hin"], device=DEV)) ** 2).mean()
        polys.append(sample_contour(A, Hin, Hout))
    l_raster = ((dv.aa_raster(polys, MSIZE, tau=0.02, blur=BLUR) - target_render) ** 2).mean()
    return l_pos + 0.3 * l_raster


def main():
    nfonts = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
    fonts = list_fonts(nfonts)
    print(f"MODE={MODE} fonts={len(fonts)} steps={steps} size={MSIZE} device={DEV}", flush=True)
    model = Refiner().to(DEV)
    opt = torch.optim.Adam(model.parameters(), lr=5e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, steps)
    ema = None
    for it in range(steps):
        loss = 0.0; nb = 0
        for _ in range(6):
            s = make_sample(random.choice(fonts))
            if s is None: continue
            loss = loss + glyph_loss(model, *s); nb += 1
        if nb == 0: continue
        loss = loss / nb
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step()
        ema = loss.item() if ema is None else 0.97 * ema + 0.03 * loss.item()
        if it % 50 == 0 or it == steps - 1:
            print(f"step {it:5d}/{steps}  loss {loss.item():.5f}  ema {ema:.5f}", flush=True)
    os.makedirs("C:/Users/okana/fontmaker/ml/vecai/ckpt", exist_ok=True)
    torch.save(model.state_dict(), f"C:/Users/okana/fontmaker/ml/vecai/ckpt/refiner_{MODE}.pt")
    evalviz(model)
    export_onnx(model, f"C:/Users/okana/fontmaker/ml/vecai/ckpt/refiner_{MODE}.onnx")


@torch.no_grad()
def export_onnx(model, path):
    """Export the per-contour refiner to ONNX (dynamic anchor count) for the panel."""
    m = model.eval().to("cpu")
    img = torch.zeros(1, 1, MSIZE, MSIZE)
    anchors = torch.rand(12, 2)
    torch.onnx.export(
        m, (img, anchors), path, opset_version=16,
        input_names=["image", "anchors"], output_names=["A", "Hin", "Hout"],
        dynamic_axes={"anchors": {0: "N"}, "A": {0: "N"}, "Hin": {0: "N"}, "Hout": {0: "N"}})
    print("exported", path, flush=True)
    model.to(DEV)


@torch.no_grad()
def evalviz(model, R=160):
    holdout = list_fonts(9999)[-4:]
    tiles = []
    for fp in holdout:
        s = None
        for _ in range(6):
            s = make_sample(fp)
            if s: break
        if not s: continue
        gt, targets, inits, S = s
        gt_t = [torch.tensor(c, device=DEV) for c in gt]
        tgt = dv.aa_raster(gt_t, R, tau=0.008, blur=1.0)
        img = render_input(gt_t, S, MSIZE)
        def hh(a, k): return torch.tensor((np.roll(a, k, 0) - a) / 3, device=DEV)
        init_r = dv.aa_raster([sample_contour(torch.tensor(a, device=DEV), hh(a, 1), hh(a, -1)) for a in inits], R, tau=0.008, blur=1.0)
        rp = []
        for a in inits:
            A, Hin, Hout = model(img, torch.tensor(a, device=DEV))
            rp.append(sample_contour(A, Hin, Hout))
        ref_r = dv.aa_raster(rp, R, tau=0.008, blur=1.0)
        def png(o): return 255 - (o.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        gap = np.full((R, 6), 200, np.uint8)
        tiles.append(np.concatenate([png(tgt), gap, png(init_r), gap, png(ref_r)], 1))
    if tiles:
        sep = np.full((6, tiles[0].shape[1]), 160, np.uint8)
        sheet = tiles[0]
        for t in tiles[1:]: sheet = np.concatenate([sheet, sep, t], 0)
        Image.fromarray(sheet, "L").save(f"C:/Users/okana/fontmaker/ml/vecai/_train_eval_{MODE}.png")
        print(f"saved _train_eval_{MODE}.png  (TARGET | rough init | REFINED)", flush=True)


if __name__ == "__main__":
    main()
