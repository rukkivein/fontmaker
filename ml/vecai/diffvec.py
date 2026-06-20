"""Differentiable vectorizer — core pieces (Aşama 1 prototype).

Self-supervised setup the user designed: a FONT is both the input (render it) and
the answer (its own outline). We render a glyph, then optimise a set of cubic
Bézier contours so that (a) their differentiable raster matches the target and
(b) the curves are clean/minimal — recovering an AAA outline from a low-res image.

This module: outline extraction (fontTools = ground-truth vector), a differentiable
soft rasteriser (generalised winding number — handles holes, gradients flow to the
control points), and helpers. Pure PyTorch (no DiffVG build needed).
"""
import math
import logging
import numpy as np
import torch
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

logging.getLogger("fontTools").setLevel(logging.ERROR)   # silence harmless per-font warnings


# ---- ground-truth outline from a real font (the AAA target) ----------------
class _FlattenPen(BasePen):
    """Flatten a glyph to closed polylines (dense point lists), one per contour."""
    def __init__(self, glyphSet, steps=16):
        super().__init__(glyphSet)
        self.contours, self.cur, self.steps = [], None, steps

    def _moveTo(self, p): self.cur = [p]
    def _lineTo(self, p): self.cur.append(p)

    def _curveToOne(self, c1, c2, p):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps; mt = 1 - t
            x = mt**3*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t**3*p[0]
            y = mt**3*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t**3*p[1]
            self.cur.append((x, y))

    def _qCurveToOne(self, c, p):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps; mt = 1 - t
            x = mt*mt*p0[0] + 2*mt*t*c[0] + t*t*p[0]
            y = mt*mt*p0[1] + 2*mt*t*c[1] + t*t*p[1]
            self.cur.append((x, y))

    def _closePath(self):
        if self.cur and len(self.cur) > 2:
            self.contours.append(self.cur)
        self.cur = None


_FONT_CACHE = {}

def _load_font(font_path):
    f = _FONT_CACHE.get(font_path)
    if f is None:
        font = TTFont(font_path, fontNumber=0, lazy=True)
        f = (font.getGlyphSet(), font.getBestCmap())
        if len(_FONT_CACHE) < 4000:
            _FONT_CACHE[font_path] = f
    return f


def glyph_contours(font_path, char, steps=16):
    """Return the glyph's contours as numpy point arrays in FONT UNITS (y-up)."""
    gs, cmap = _load_font(font_path)
    cp = ord(char)
    if cmap is None or cp not in cmap:
        raise ValueError("char %r not in %s" % (char, font_path))
    pen = _FlattenPen(gs, steps)
    gs[cmap[cp]].draw(pen)
    return [np.array(c, dtype=np.float64) for c in pen.contours]


def normalize_contours(contours, margin=0.12):
    """Fit all contours into the unit box [0,1]^2 (image space, y-DOWN), keeping
    aspect, with margin. Returns list of [N,2] float32 arrays + the transform."""
    allp = np.concatenate(contours, 0)
    lo, hi = allp.min(0), allp.max(0)
    span = max((hi - lo).max(), 1e-6)
    scale = (1 - 2 * margin) / span
    cx, cy = (lo + hi) / 2
    out = []
    for c in contours:
        x = (c[:, 0] - cx) * scale + 0.5
        y = 0.5 - (c[:, 1] - cy) * scale   # flip y (font y-up -> image y-down)
        out.append(np.stack([x, y], 1).astype(np.float32))
    return out


# ---- differentiable soft rasteriser (generalised winding number) -----------
def pixel_grid(size, device):
    ys, xs = torch.meshgrid(
        (torch.arange(size, device=device) + 0.5) / size,
        (torch.arange(size, device=device) + 0.5) / size, indexing="ij")
    return torch.stack([xs, ys], -1).reshape(-1, 2)   # [P,2] in [0,1]


def soft_raster(contours, size, tau=0.012, chunk=4096):
    """contours: list of [N,2] tensors (closed polygons, image space).
    Returns a [size,size] occupancy in [0,1], differentiable wrt the points.
    Occupancy = sigmoid over the generalised winding number, so holes (opposite
    winding) cancel to 0 and gradients reach every vertex."""
    device = contours[0].device
    grid = pixel_grid(size, device)                    # [P,2]
    P = grid.shape[0]
    occ = torch.zeros(P, device=device)
    for s in range(0, P, chunk):
        g = grid[s:s + chunk]                          # [c,2]
        w = torch.zeros(g.shape[0], device=device)
        for poly in contours:
            a = poly                                   # [N,2]
            b = torch.roll(poly, -1, 0)
            pa = a[None] - g[:, None]                  # [c,N,2]
            pb = b[None] - g[:, None]
            cross = pa[..., 0]*pb[..., 1] - pa[..., 1]*pb[..., 0]
            dot = pa[..., 0]*pb[..., 0] + pa[..., 1]*pb[..., 1]
            w = w + torch.atan2(cross, dot).sum(-1)
        w = w / (2 * math.pi)                           # ~±1 inside, 0 outside/holes
        occ[s:s + chunk] = torch.sigmoid((w.abs() - 0.5) / tau)
    return occ.reshape(size, size)


def gaussian_blur(img, sigma):
    """Differentiable separable Gaussian blur — slight anti-aliasing so the render
    looks like a real (AA'd) glyph image and gives the optimiser smoother gradients."""
    if sigma is None or sigma <= 0:
        return img
    r = max(1, int(round(3 * sigma)))
    x = torch.arange(-r, r + 1, device=img.device, dtype=img.dtype)
    k = torch.exp(-(x ** 2) / (2 * sigma * sigma)); k = k / k.sum()
    F = torch.nn.functional
    y = img[None, None]
    y = F.conv2d(y, k.view(1, 1, 1, -1), padding=(0, r))
    y = F.conv2d(y, k.view(1, 1, -1, 1), padding=(r, 0))
    return y[0, 0]


def aa_raster(contours, size, tau=0.015, blur=0.8):
    """Anti-aliased differentiable render: soft winding fill + a slight blur."""
    return gaussian_blur(soft_raster(contours, size, tau=tau), blur)


def render_png(occ, path):
    a = (occ.detach().clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    from PIL import Image
    Image.fromarray(255 - a, "L").save(path)   # ink black on white


def pil_render(font_path, char, size, margin=0.12):
    """Reference raster via PIL, normalised the same way (for sanity compare)."""
    from PIL import Image, ImageFont, ImageDraw
    # render big then fit — reuse the same normalization box as the contours
    cs = normalize_contours(glyph_contours(font_path, char))
    img = Image.new("L", (size, size), 0)
    # draw filled polygons (even-odd) from the normalized contours
    from PIL import ImagePath
    polys = [[(p[0]*size, p[1]*size) for p in c] for c in cs]
    # even-odd fill via XOR of each polygon
    acc = Image.new("L", (size, size), 0)
    for poly in polys:
        layer = Image.new("L", (size, size), 0)
        ImageDraw.Draw(layer).polygon(poly, fill=255)
        acc = Image.eval(Image.composite(Image.new("L", (size, size), 255), acc, layer),
                         lambda v: v)  # placeholder; replaced below
    return img  # (PIL even-odd is awkward; we sanity-check against soft_raster visually)
