"""Sanity: does the differentiable soft-rasteriser actually render glyphs (with
holes) correctly? Render a few letters, save a contact sheet, eyeball it."""
import sys, torch, numpy as np
sys.path.insert(0, "C:/Users/okana/fontmaker/ml/vecai")
import diffvec as dv
from PIL import Image

FONT = "C:/Windows/Fonts/times.ttf"
CHARS = "AaegO8"
SIZE = 128
dev = "cuda" if torch.cuda.is_available() else "cpu"

tiles = []
for ch in CHARS:
    cs = dv.normalize_contours(dv.glyph_contours(FONT, ch))
    tc = [torch.tensor(c, device=dev) for c in cs]
    occ = dv.soft_raster(tc, SIZE)
    a = (255 - (occ.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    tiles.append(a)
    print(f"{ch}: contours={len(cs)} inside-frac={occ.mean().item():.3f}")

sheet = np.concatenate(tiles, axis=1)
Image.fromarray(sheet, "L").save("C:/Users/okana/fontmaker/ml/vecai/_sanity.png")
print("saved _sanity.png", sheet.shape)
