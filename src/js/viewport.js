// Maps between world (font units, y-up) and screen (pixels, y-down).
// Supports an optional view rotation (used by the Position tool's rotate mode).
export class Viewport {
  constructor() { this.scale = 0.35; this.ox = 120; this.oy = 600; this.angle = 0; }

  toScreen(x, y) {
    const X = x * this.scale, Y = y * this.scale;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const Xr = X * c - Y * s, Yr = X * s + Y * c;
    return { sx: this.ox + Xr, sy: this.oy - Yr };
  }
  toWorld(sx, sy) {
    const Xr = sx - this.ox, Yr = this.oy - sy;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const X = Xr * c + Yr * s, Y = -Xr * s + Yr * c;
    return { x: X / this.scale, y: Y / this.scale };
  }

  fit(w, h, metrics, advanceWidth) {
    const top = metrics.ascender, bot = metrics.descender;
    const emH = top - bot;
    const padded = h * 0.78;
    this.scale = Math.min(padded / emH, (w * 0.6) / Math.max(advanceWidth, 400));
    this.ox = w * 0.5 - (advanceWidth * this.scale) / 2;
    this.oy = h * 0.5 + (((top + bot) / 2) * this.scale);
    this.angle = 0;
  }

  zoomAt(sx, sy, factor) {
    const w = this.toWorld(sx, sy);
    this.scale = Math.max(0.03, Math.min(4, this.scale * factor));
    const s = this.toScreen(w.x, w.y);
    this.ox += sx - s.sx;
    this.oy += sy - s.sy;
  }

  pan(dx, dy) { this.ox += dx; this.oy += dy; }
  pxToWorld(px) { return px / this.scale; }
}
