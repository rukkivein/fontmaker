"""Render each Font DNA preset's construction grid to a vector PDF — no external
libraries (PDF is hand-written; uses the built-in Helvetica). One preset per page.
Reads _presets.json (produced from shared/dna.js) and writes two PDFs.
"""
import json, sys

UPM, ASC, DESC, CAP = 1000, 800, -200, 716

def esc(s):  # PDF string escape
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

class Page:
    def __init__(self, w, h):
        self.w, self.h, self.ops = w, h, []
    def color(self, g): self.ops.append('%.3f %.3f %.3f RG' % (g, g, g))
    def fill(self, g): self.ops.append('%.3f %.3f %.3f rg' % (g, g, g))
    def rgbStroke(self, r, g, b): self.ops.append('%.3f %.3f %.3f RG' % (r, g, b))
    def lw(self, w): self.ops.append('%.2f w' % w)
    def dash(self, on): self.ops.append('[3 3] 0 d' if on else '[] 0 d')
    def line(self, x1, y1, x2, y2): self.ops.append('%.2f %.2f m %.2f %.2f l S' % (x1, y1, x2, y2))
    def rect(self, x, y, w, h): self.ops.append('%.2f %.2f %.2f %.2f re S' % (x, y, w, h))
    def text(self, x, y, s, size, g=0.0, bold=False):
        f = 'F2' if bold else 'F1'
        self.ops.append('BT /%s %.1f Tf %.3f %.3f %.3f rg %.2f %.2f Td (%s) Tj ET' % (f, size, g, g, g, x, y, esc(s)))
    def stream(self): return '\n'.join(self.ops)

def build_pdf(pages, path):
    objs = []  # (num placeholder) we assemble sequentially
    # 1 Catalog, 2 Pages, then per page: Page obj + Content obj; fonts shared
    n_pages = len(pages)
    # object numbering: 1=catalog 2=pages 3=F1 4=F2 then pages/contents
    kids_start = 5
    page_obj_nums = [kids_start + 2 * i for i in range(n_pages)]
    out = []
    out.append('%PDF-1.4\n')
    offsets = {}
    body = ''
    def add(num, s):
        nonlocal body
        offsets[num] = len(header) + len(body)
        body += '%d 0 obj\n%s\nendobj\n' % (num, s)
    header = '%PDF-1.4\n'
    add(1, '<< /Type /Catalog /Pages 2 0 R >>')
    kids = ' '.join('%d 0 R' % p for p in page_obj_nums)
    add(2, '<< /Type /Pages /Count %d /Kids [%s] >>' % (n_pages, kids))
    add(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
    for i, pg in enumerate(pages):
        pnum = page_obj_nums[i]; cnum = pnum + 1
        res = '<< /Font << /F1 3 0 R /F2 4 0 R >> >>'
        add(pnum, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources %s /Contents %d 0 R >>' % (pg.w, pg.h, res, cnum))
        st = pg.stream().encode('latin-1', 'replace')
        add(cnum, '<< /Length %d >>\nstream\n%s\nendstream' % (len(st), st.decode('latin-1')))
    xref_pos = len(header) + len(body)
    maxn = 4 + 2 * n_pages
    xref = 'xref\n0 %d\n0000000000 65535 f \n' % (maxn + 1)
    for num in range(1, maxn + 1):
        xref += '%010d 00000 n \n' % offsets[num]
    trailer = 'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF' % (maxn + 1, xref_pos)
    data = header + body + xref + trailer
    open(path, 'wb').write(data.encode('latin-1', 'replace'))
    print('wrote', path, len(data), 'bytes,', n_pages, 'pages')

def render(preset):
    W, H = 595.0, 842.0  # A4
    pg = Page(W, H)
    d = preset['params']; m = preset['metrics']; grids = preset['grids']
    advance = round(UPM * (0.40 + d['width'] / 100.0 * 0.35))
    span = ASC - DESC
    # fit the box into the page
    boxH = 560.0
    scale = boxH / span
    boxW = advance * scale
    ox = (W - boxW) / 2.0
    oy = 150.0  # bottom of descender line
    def X(fx): return ox + fx * scale
    def Y(fy): return oy + (fy - DESC) * scale

    # title
    pg.text(ox, H - 90, 'RuneType Glyphmaker  —  Grid Preset', 11, 0.45)
    pg.text(ox, H - 120, preset['name'], 26, 0.1, bold=True)
    pg.text(ox, H - 138, preset['tier'] + ' preset', 11, 0.45)
    keys = ['xHeight', 'weight', 'contrast', 'aperture', 'roundness', 'penAngle', 'geometry', 'gridDensity']
    pstr = '   '.join('%s %d' % (k, d[k]) for k in keys)
    pg.text(ox, H - 156, pstr, 8.5, 0.5)

    # outer box (sidebearings = verticals)
    pg.lw(0.6); pg.color(0.78)
    pg.line(X(0), Y(DESC), X(0), Y(ASC))
    pg.line(X(advance), Y(DESC), X(advance), Y(ASC))

    # em-square grid (light) if present
    for gd in grids:
        if gd.get('kind') == 'emsquare':
            cell = gd.get('cell', 62)
            pg.lw(0.3); pg.color(0.9)
            x = cell
            while x < advance:
                pg.line(X(x), Y(DESC), X(x), Y(ASC)); x += cell
            y = DESC + cell
            while y < ASC:
                pg.line(X(0), Y(y), X(advance), Y(y)); y += cell
    # broad-nib slants
    for gd in grids:
        if gd.get('kind') == 'broadnib':
            import math
            ang = math.radians(gd.get('penAngle', 30)); dy = max(math.tan(ang), 0.01)
            pg.lw(0.3); pg.color(0.86)
            step = CAP / 3.0; sx = -advance
            while sx < advance * 2:
                pg.line(X(sx), Y(DESC), X(sx + span / dy), Y(ASC)); sx += step
    # metric lines (drawn over the grid)
    def mline(fy, g, w, label):
        pg.lw(w); pg.color(g); pg.line(X(0), Y(fy), X(advance), Y(fy))
        pg.text(X(advance) + 6, Y(fy) - 3, label, 7.5, 0.45)
    mline(ASC, 0.7, 0.5, 'ascender %d' % ASC)
    mline(CAP, 0.55, 0.6, 'cap height %d' % CAP)
    mline(m['xHeight'], 0.55, 0.6, 'x-height %d' % m['xHeight'])
    mline(0, 0.2, 0.9, 'baseline 0')
    mline(DESC, 0.7, 0.5, 'descender %d' % DESC)
    # overshoot zones (dashed)
    for gd in grids:
        if gd.get('kind') == 'superellipse':
            ov = gd.get('overshoot', 12)
            pg.lw(0.4); pg.color(0.82); pg.dash(True)
            for fy in (0 - ov, CAP + ov, m['xHeight'] + ov):
                pg.line(X(0), Y(fy), X(advance), Y(fy))
            pg.dash(False)

    # a SINGLE faint reference letter on the grid (the grid is the focus).
    # Helvetica cap height ~0.717 em → size so cap = CAP units.
    size_pt = (CAP * scale) / 0.717
    pg.text(X(advance / 2.0) - size_pt * 0.33, Y(0), 'A', size_pt, 0.86)

    # footer
    pg.text(ox, 90, 'Construction grid derived from the Font DNA. Metric lines, em grid (density), broad-nib slants and overshoot vary per preset.', 8, 0.55)
    return pg

def main():
    data = json.load(open('_presets.json', encoding='utf-8'))
    quick = [render(p) for p in data if p['tier'] == 'Quick']
    adv = [render(p) for p in data if p['tier'] == 'Advanced']
    dest = sys.argv[1] if len(sys.argv) > 1 else '.'
    build_pdf(quick, dest + '/RuneType-Grid-Presets-Quick.pdf')
    build_pdf(adv, dest + '/RuneType-Grid-Presets-Advanced.pdf')

main()
