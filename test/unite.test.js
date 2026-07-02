// Guard the export contour cleanup (cep/js/unite.js). It must PRESERVE the user's intended
// fill — exactly how Illustrator renders the contours under NON-ZERO winding (real drawn
// glyphs already have their counters cut) — while removing SELF-INTERSECTIONS / overlaps so
// the font renders correctly in Windows GDU / Word (which fill self-touching outlines solid).
// paper-jsdom is the same paper.js 0.12.18 the panel vendors.
const assert = require('assert');
let paper;
try { paper = require('paper-jsdom'); } catch (e) {
  console.log('unite SKIP — paper-jsdom not installed (devDependency)'); process.exit(0);
}
paper.setup(new paper.Size(4000, 4000));
const { uniteContours, contoursToPaper } = require('../cep/js/unite.js');

function ring(cx, cy, r, cw, steps) {     // cw=true → clockwise (a hole under non-zero)
  steps = steps || 80; const pts = [];
  for (let i = 0; i < steps; i++) { const a = 2 * Math.PI * (cw ? -i : i) / steps; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
  return { closed: true, points: pts };
}
function rect(x0, y0, x1, y1) { return { closed: true, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }; }

// non-zero fill fraction of the bbox (the rendered appearance — solid ≈ 0.78, ring ≈ 0.3)
function fillFrac(contours) {
  const fl = contoursToPaper(paper, contours);
  const b = fl.reduce((B, p) => B.unite(p.bounds), fl[0].bounds.clone());
  let f = 0, t = 0;
  for (let gx = 1; gx < 30; gx++) for (let gy = 1; gy < 30; gy++) {
    const x = b.x + b.width * gx / 31, y = b.y + b.height * gy / 31, pt = new paper.Point(x, y);
    let w = 0; fl.forEach(p => { if (p.contains(pt)) w++; });   // contains uses each path's own (non-zero) fill
    t++; if (w % 2 === 1) f++;   // odd # of containing simple loops ≈ non-zero for nested/opposite rings
  }
  return f / t;
}
function selfCross(contours) { let s = 0; contoursToPaper(paper, contours).forEach(p => { s += p.getCrossings(p).length; }); return s; }
function pairCross(contours) { const ps = contoursToPaper(paper, contours); let s = 0; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) s += ps[i].getCrossings(ps[j]).length; return s; }

let fails = 0;
const ok = (c, m) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; };

// 1) COUNTER PRESERVED through a crossing stroke (the O/Q/R bug): outer ring + opposite-wound
//    counter + a tail that crosses the ring. Output must keep the hole AND be GDI-safe.
{
  const inp = [ring(400, 400, 300, false), ring(400, 400, 150, true), rect(360, 380, 760, 120)];
  const before = fillFrac(inp), out = uniteContours(paper, inp), after = fillFrac(out);
  ok(after < 0.7, `Q-like: counter preserved (fill ${(after * 100) | 0}%, was ${(before * 100) | 0}%)`);
  ok(selfCross(out) === 0 && pairCross(out) === 0, 'Q-like: GDI-safe (no self/mutual crossing)');
}
// 2) SELF-INTERSECTING outline (a bowtie / figure-8) → cleaned to non-self-intersecting.
{
  const bow = { closed: true, points: [{ x: 0, y: 0 }, { x: 300, y: 300 }, { x: 300, y: 0 }, { x: 0, y: 300 }] };
  ok(selfCross([bow]) > 0, 'bowtie input self-intersects (precondition)');
  const out = uniteContours(paper, [bow]);
  ok(selfCross(out) === 0, 'bowtie: self-intersection removed (GDI-safe)');
}
// 3) OVERLAPPING solid bars → united, NO spurious hole (overlap stays filled).
{
  const inp = [rect(100, 100, 200, 600), rect(150, 300, 500, 380)];
  const out = uniteContours(paper, inp);
  ok(selfCross(out) === 0 && pairCross(out) === 0, 'overlap bars: GDI-safe');
  // the small overlap region must NOT become a hole → fill stays high relative to the union
  const holes = out.map(c => { let a = 0, p = c.points; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; }).filter(a => a < -1).length;
  ok(holes === 0, 'overlap bars: no spurious hole (' + holes + ' holes)');
}
// 4) CLEAN glyph (separate opposite counter, no crossing) → returned UNTOUCHED.
{
  const inp = [ring(400, 400, 300, false), ring(400, 400, 150, true)];
  const out = uniteContours(paper, inp);
  ok(out === inp, 'clean O: untouched (no needless re-trace)');
}
// 5) TWO counters both preserved (B-like): outer + 2 opposite counters + a crossing bar.
{
  const inp = [rect(100, 50, 500, 650), ring(300, 500, 80, true), ring(300, 200, 80, true), rect(80, 330, 520, 370)];
  const out = uniteContours(paper, inp);
  ok(selfCross(out) === 0 && pairCross(out) === 0, 'B-like 2-counter: GDI-safe');
  const neg = out.map(c => { let a = 0, p = c.points; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; }).filter(a => a < -1).length;
  ok(neg >= 2, 'B-like: both counters survive as holes (' + neg + ')');
}

console.log(fails ? `\n${fails} failed` : '\nunite OK — counters preserved, self-intersections removed (GDI-safe), no spurious holes');
process.exit(fails ? 1 : 0);
