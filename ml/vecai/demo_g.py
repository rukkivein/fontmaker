"""Clean, LABELLED demo on Times New Roman lowercase 'g':
  1. ORIGINAL VECTOR (outline + its anchor points)
  2. RASTERIZED  (just shrink to small px + bicubic AA — NO jitter, no displacement)
  3. VECTOR FROM RASTER (optimise an outline to fit the small raster; outline + points)
So you can judge how much survives a small rasterise. No artificial roughening.
"""
import sys, numpy as np, torch
sys.path.insert(0, "C:/Users/okana/fontmaker/ml/vecai")
import diffvec as dv
from PIL import Image, ImageDraw, ImageFont

FONT = "C:/Windows/Fonts/times.ttf"
DEV = "cuda" if torch.cuda.is_available() else "cpu"
SMALL = 50           # the "pixelate" size the user asked for
OPT = 220            # optimisation / display resolution
PANEL = 300
try: LABFONT = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 20)
except Exception: LABFONT = ImageFont.load_default()


def resample(c, K):
    d = np.sqrt(((np.roll(c, -1, 0) - c) ** 2).sum(1))
    s = np.concatenate([[0], np.cumsum(d)]); total = max(s[-1], 1e-9)
    cc = np.vstack([c, c[0]]); out = []; j = 0
    for t in np.linspace(0, total, K, endpoint=False):
        while j < len(s) - 2 and s[j + 1] < t: j += 1
        f = min(max((t - s[j]) / max(s[j + 1] - s[j], 1e-9), 0.0), 1.0)
        out.append(cc[j] * (1 - f) + cc[j + 1] * f)
    return np.array(out, dtype=np.float32), total


def sample_contour(A, Hin, Hout, steps=14):
    p0, p1 = A, A + Hout
    p2, p3 = torch.roll(A, -1, 0) + torch.roll(Hin, -1, 0), torch.roll(A, -1, 0)
    t = torch.linspace(0, 1, steps + 1, device=A.device)[:-1]; mt = 1 - t
    return (((mt**3)[None, :, None]*p0[:, None] + (3*mt*mt*t)[None, :, None]*p1[:, None]
             + (3*mt*t*t)[None, :, None]*p2[:, None] + (t**3)[None, :, None]*p3[:, None])
            ).reshape(-1, 2)


def draw_vector(params, label, raster_bg=None):
    """params: list of dict(A,Hin,Hout) tensors. Draw outline + anchor dots."""
    im = Image.new("RGB", (PANEL, PANEL + 30), "white")
    d = ImageDraw.Draw(im)
    if raster_bg is not None:
        bg = Image.fromarray(raster_bg, "L").resize((PANEL, PANEL), Image.NEAREST).convert("RGB")
        im.paste(Image.blend(Image.new("RGB", (PANEL, PANEL), "white"), bg, 0.18), (0, 30))
    for p in params:
        pts = sample_contour(p["A"], p["Hin"], p["Hout"]).detach().cpu().numpy() * PANEL
        d.line([tuple(q) for q in pts] + [tuple(pts[0])], fill=(20, 20, 20), width=2)
    for p in params:
        for h in ("Hout", "Hin"):
            A = p["A"].detach().cpu().numpy() * PANEL; H = (p["A"] + p[h]).detach().cpu().numpy() * PANEL
            for a, hh in zip(A, H): d.line([tuple(a), tuple(hh)], fill=(160, 160, 160), width=1)
        for a in p["A"].detach().cpu().numpy() * PANEL:
            d.ellipse([a[0]-3, a[1]+30-3, a[0]+3, a[1]+30+3], fill=(225, 40, 30))
    # shift the vector content down by 30 to sit under the label band
    content = im.crop((0, 30, PANEL, PANEL + 30))
    out = Image.new("RGB", (PANEL, PANEL + 30), "white")
    out.paste(content, (0, 30))
    ImageDraw.Draw(out).text((8, 5), label, fill=(0, 0, 0), font=LABFONT)
    return out


def panel_raster(arr_small, label):
    im = Image.new("RGB", (PANEL, PANEL + 30), "white")
    big = Image.fromarray(arr_small, "L").resize((PANEL, PANEL), Image.NEAREST).convert("RGB")
    im.paste(big, (0, 30))
    ImageDraw.Draw(im).text((8, 5), label, fill=(0, 0, 0), font=LABFONT)
    return im


# 1) ORIGINAL VECTOR
gt = dv.normalize_contours(dv.glyph_contours(FONT, "g"))
gt_params = []
for c in gt:
    A, _ = resample(c, max(8, len(c) // 14))
    tang = (np.roll(A, -1, 0) - np.roll(A, 1, 0)) / 6.0
    gt_params.append({"A": torch.tensor(A, device=DEV),
                      "Hout": torch.tensor(tang, device=DEV),
                      "Hin": torch.tensor(-tang, device=DEV)})

# 2) RASTERIZE: render small (SMALL px), bicubic AA — just a resize, no jitter
gt_t = [torch.tensor(c, device=DEV) for c in gt]
small = dv.aa_raster(gt_t, SMALL, tau=0.02, blur=0.45)
small_png = (255 - (small.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))   # ink black
# upscale the small raster (bicubic) -> optimisation target
small_pil = Image.fromarray((small.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8), "L")
tgt = torch.tensor(np.asarray(small_pil.resize((OPT, OPT), Image.BICUBIC), np.float32) / 255.0, device=DEV)

# 3) VECTOR FROM RASTER: init from topology, optimise to fit the small raster
params = []
for c in gt:
    A, _ = resample(c, max(8, len(c) // 14))
    tang = (np.roll(A, -1, 0) - np.roll(A, 1, 0)) / 6.0
    params.append({"A": torch.tensor(A, device=DEV, requires_grad=True),
                   "Hout": torch.tensor(tang, device=DEV, requires_grad=True),
                   "Hin": torch.tensor(-tang, device=DEV, requires_grad=True)})
opt = torch.optim.Adam([t for p in params for t in p.values()], lr=0.01)
for it in range(400):
    tau = 0.05 * (1 - 0.7 * it / 400)
    occ = dv.aa_raster([sample_contour(p["A"], p["Hin"], p["Hout"]) for p in params], OPT, tau=tau, blur=1.0)
    g1 = sum(((p["Hout"] + p["Hin"]) ** 2).mean() for p in params)
    loss = ((occ - tgt) ** 2).mean() + 0.003 * g1
    opt.zero_grad(); loss.backward(); opt.step()
print("final fit MSE:", round(float(((occ - tgt) ** 2).mean()), 5))

p1 = draw_vector(gt_params, "1. ORIGINAL VECTOR")
p2 = panel_raster(small_png, f"2. RASTERIZED {SMALL}px")
p3 = draw_vector(params, "3. VECTOR FROM RASTER", raster_bg=small_png)
sheet = Image.new("RGB", (PANEL*3 + 24, PANEL + 30), "white")
sheet.paste(p1, (0, 0)); sheet.paste(p2, (PANEL + 12, 0)); sheet.paste(p3, (PANEL*2 + 24, 0))
sheet.save("C:/Users/okana/fontmaker/ml/vecai/_demo_g.png")
print("saved _demo_g.png")
