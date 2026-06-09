"""Render each Font DNA preset's construction grid to a vector PDF — no external
libraries (PDF is hand-written; built-in Helvetica only for labels). One preset
per page. The grids are the point; a single construction letter G is drawn to
the grid (on the cap circle) at low opacity so the guides show through.
Reads _presets.json (from shared/dna.js); writes Quick + Advanced PDFs.
"""
import json, sys, math, os

UPM, ASC, DESC, CAP = 1000, 800, -200, 716
KAPPA = 0.5523

# The user's construction A (3 shapes), normalized to font units (y-up, baseline
# 0..cap 716, x centred). Drawn to the grid as the reference letter.
A_SHAPES = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'shared', 'glyph-A.json'), encoding='utf-8'))
A_W = max(p[0] for s in A_SHAPES for p in s) - min(p[0] for s in A_SHAPES for p in s)

def esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

class Page:
    def __init__(self, w, h):
        self.w, self.h, self.ops = w, h, []
    def color(self, g): self.ops.append('%.3f %.3f %.3f RG' % (g, g, g))
    def lw(self, w): self.ops.append('%.2f w' % w)
    def dash(self, on): self.ops.append('[3 3] 0 d' if on else '[] 0 d')
    def caps(self, round_): self.ops.append('1 J 1 j' if round_ else '0 J 0 j')
    def gs(self, name): self.ops.append('/%s gs' % name)
    def q(self): self.ops.append('q')
    def Q(self): self.ops.append('Q')
    def line(self, x1, y1, x2, y2): self.ops.append('%.2f %.2f m %.2f %.2f l S' % (x1, y1, x2, y2))
    def curve(self, a, b, c, d, e, f): self.ops.append('%.2f %.2f %.2f %.2f %.2f %.2f c' % (a, b, c, d, e, f))
    def ellipse(self, cx, cy, rx, ry):
        self.ops.append('%.2f %.2f m' % (cx + rx, cy))
        self.curve(cx + rx, cy + ry * KAPPA, cx + rx * KAPPA, cy + ry, cx, cy + ry)
        self.curve(cx - rx * KAPPA, cy + ry, cx - rx, cy + ry * KAPPA, cx - rx, cy)
        self.curve(cx - rx, cy - ry * KAPPA, cx - rx * KAPPA, cy - ry, cx, cy - ry)
        self.curve(cx + rx * KAPPA, cy - ry, cx + rx, cy - ry * KAPPA, cx + rx, cy)
        self.ops.append('S')
    def polyline(self, pts):
        self.ops.append('%.2f %.2f m' % pts[0])
        for p in pts[1:]:
            self.ops.append('%.2f %.2f l' % p)
        self.ops.append('S')
    def text(self, x, y, s, size, g=0.0, bold=False):
        f = 'F2' if bold else 'F1'
        self.ops.append('BT /%s %.1f Tf %.3f %.3f %.3f rg %.2f %.2f Td (%s) Tj ET' % (f, size, g, g, g, x, y, esc(s)))
    def stream(self): return '\n'.join(self.ops)

def build_pdf(pages, path):
    n = len(pages)
    page_nums = [6 + 2 * i for i in range(n)]   # 1 cat 2 pages 3 F1 4 F2 5 GState
    header = '%PDF-1.4\n'
    body = ''
    offsets = {}
    def add(num, s):
        nonlocal body
        offsets[num] = len(header) + len(body)
        body += '%d 0 obj\n%s\nendobj\n' % (num, s)
    add(1, '<< /Type /Catalog /Pages 2 0 R >>')
    add(2, '<< /Type /Pages /Count %d /Kids [%s] >>' % (n, ' '.join('%d 0 R' % p for p in page_nums)))
    add(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
    add(5, '<< /Type /ExtGState /ca 0.30 /CA 0.30 >>')
    for i, pg in enumerate(pages):
        pnum = page_nums[i]; cnum = pnum + 1
        res = '<< /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GS1 5 0 R >> >>'
        add(pnum, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources %s /Contents %d 0 R >>' % (pg.w, pg.h, res, cnum))
        st = pg.stream().encode('latin-1', 'replace')
        add(cnum, '<< /Length %d >>\nstream\n%s\nendstream' % (len(st), st.decode('latin-1')))
    xref_pos = len(header) + len(body)
    maxn = 5 + 2 * n
    xref = 'xref\n0 %d\n0000000000 65535 f \n' % (maxn + 1)
    for num in range(1, maxn + 1):
        xref += '%010d 00000 n \n' % offsets[num]
    trailer = 'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF' % (maxn + 1, xref_pos)
    open(path, 'wb').write((header + body + xref + trailer).encode('latin-1', 'replace'))
    print('wrote', path, n, 'pages')

def draw_A(pg, X, Y, advance, d, cell):
    """The user's 3-shape A, fitted to the grid: feet flush to the sidebearings
    (full advance width), full cap height, every point snapped to the em grid
    (cap/baseline/edges kept exact). All shapes are wound the same way and filled
    with ONE nonzero fill so overlaps never punch holes; low opacity over guides."""
    minPx = min(p[0] for sh in A_SHAPES for p in sh)
    def fxu(px): return (px - minPx) / A_W * advance        # x-extent -> [0, advance]
    def snapX(x):
        if x <= cell * 0.5: return 0.0
        if x >= advance - cell * 0.5: return advance
        return round(x / cell) * cell
    def snapY(y):
        if abs(y - CAP) <= cell * 0.6: return float(CAP)
        if abs(y) <= cell * 0.6: return 0.0
        return round(y / cell) * cell
    ops = []
    for sh in A_SHAPES:
        pts = [(snapX(fxu(px)), snapY(py)) for (px, py) in sh]
        area = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]; area += x1 * y2 - x2 * y1
        if area < 0: pts = pts[::-1]                         # normalize to CCW
        page = [(X(x), Y(y)) for (x, y) in pts]
        ops.append('%.2f %.2f m' % page[0])
        for p in page[1:]:
            ops.append('%.2f %.2f l' % p)
        ops.append('h')
    pg.q(); pg.gs('GS1'); pg.ops.append('0.10 0.10 0.10 rg')
    pg.ops += ops
    pg.ops.append('f')
    pg.Q()

def render(preset):
    W, H = 595.0, 842.0
    pg = Page(W, H)
    d = preset['params']; m = preset['metrics']; grids = preset['grids']
    advance = round(UPM * (0.40 + d['width'] / 100.0 * 0.35))
    span = ASC - DESC
    boxH = 560.0
    scale = boxH / span
    ox = (W - advance * scale) / 2.0
    oy = 150.0
    def X(fx): return ox + fx * scale
    def Y(fy): return oy + (fy - DESC) * scale

    pg.text(ox, H - 90, 'RuneType Glyphmaker  —  Grid Preset', 11, 0.45)
    pg.text(ox, H - 120, preset['name'], 26, 0.1, bold=True)
    pg.text(ox, H - 138, preset['tier'] + ' preset', 11, 0.45)
    keys = ['xHeight', 'weight', 'contrast', 'aperture', 'roundness', 'penAngle', 'geometry', 'gridDensity']
    pg.text(ox, H - 156, '   '.join('%s %d' % (k, d[k]) for k in keys), 8.5, 0.5)

    # sidebearings (verticals)
    pg.color(0.62); pg.lw(1.0)
    pg.line(X(0), Y(DESC), X(0), Y(ASC))
    pg.line(X(advance), Y(DESC), X(advance), Y(ASC))

    # em grid
    for g in grids:
        if g.get('kind') == 'emsquare':
            cell = g.get('cell', 62); pg.lw(0.5); pg.color(0.83)
            x = cell
            while x < advance:
                pg.line(X(x), Y(DESC), X(x), Y(ASC)); x += cell
            y = DESC + cell
            while y < ASC:
                pg.line(X(0), Y(y), X(advance), Y(y)); y += cell
    # broad-nib slants
    for g in grids:
        if g.get('kind') == 'broadnib':
            ang = math.radians(g.get('penAngle', 30)); dy = max(math.tan(ang), 0.01)
            pg.lw(0.5); pg.color(0.78); step = CAP / 3.0; sx = -advance
            while sx < advance * 2:
                pg.line(X(sx), Y(DESC), X(sx + span / dy), Y(ASC)); sx += step
    # construction circles (cap + x-height bowls)
    wf = 0.86
    for g in grids:
        if g.get('kind') == 'circle':
            wf = g.get('wf', 0.86); pg.lw(0.9); pg.color(0.55)
            for topU in (CAP, m['xHeight']):
                cy = (Y(0) + Y(topU)) / 2.0; ry = (Y(topU) - Y(0)) / 2.0
                pg.ellipse(X(advance / 2.0), cy, ry * wf, ry)
    # overshoot zones (dashed)
    for g in grids:
        if g.get('kind') == 'superellipse':
            ov = g.get('overshoot', 12); pg.lw(0.7); pg.color(0.6); pg.dash(True)
            for fy in (0 - ov, CAP + ov, m['xHeight'] + ov):
                pg.line(X(0), Y(fy), X(advance), Y(fy))
            pg.dash(False)
    # metric lines (over the grid, thick & visible)
    def mline(fy, g, w, label):
        pg.lw(w); pg.color(g); pg.line(X(0), Y(fy), X(advance), Y(fy))
        pg.text(X(advance) + 7, Y(fy) - 3, label, 7.5, 0.4)
    mline(ASC, 0.5, 1.1, 'ascender %d' % ASC)
    mline(CAP, 0.38, 1.2, 'cap height %d' % CAP)
    mline(m['xHeight'], 0.38, 1.2, 'x-height %d' % m['xHeight'])
    mline(0, 0.08, 1.7, 'baseline 0')
    mline(DESC, 0.5, 1.1, 'descender %d' % DESC)

    # the single construction letter, on the grid, see-through
    cell = next((g['cell'] for g in grids if g.get('kind') == 'emsquare'), round(UPM / 20))
    draw_A(pg, X, Y, advance, d, cell)

    pg.text(ox, 90, 'Construction grid from the Font DNA — metric lines, em grid, circles, broad-nib slants & overshoot. The G is drawn to the grid at low opacity.', 8, 0.5)
    return pg

def main():
    data = json.load(open('_presets.json', encoding='utf-8'))
    dest = sys.argv[1] if len(sys.argv) > 1 else '.'
    build_pdf([render(p) for p in data if p['tier'] == 'Quick'], dest + '/RuneType-Grid-Presets-Quick.pdf')
    build_pdf([render(p) for p in data if p['tier'] == 'Advanced'], dest + '/RuneType-Grid-Presets-Advanced.pdf')

main()
