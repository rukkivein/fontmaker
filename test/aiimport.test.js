// Tests the .ai/.pdf importer without needing a real Illustrator file:
//  - PDF page-content path (FlateDecode stream of path operators)
//  - Illustrator PostScript art operator parsing (m/L/C/f, holes)
const zlib = require('zlib');
const { parseAI, _internals } = require('../electron/aiImport');

let fails = 0;
const ok = (c, m) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; };

// 1) Synthetic PDF-compatible content stream.
const content = '100 100 m 300 100 l 300 300 l 100 300 l h f';
const comp = zlib.deflateSync(Buffer.from(content, 'latin1'));
let pre = '%PDF-1.6\n1 0 obj\n<</Type/Page/Contents 2 0 R>>\nendobj\n';
pre += '2 0 obj\n<</Filter/FlateDecode/Length ' + comp.length + '>>\nstream\n';
const pdf = Buffer.concat([Buffer.from(pre, 'latin1'), comp, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
const shapes = parseAI(pdf);
ok(shapes.length === 1, 'PDF content → 1 shape');
ok(shapes[0] && shapes[0].contours[0].points.length === 4, 'PDF rectangle → 4 points');

// 2) Illustrator PostScript art: outer square + inner square (hole), grouped.
const art = `%!PS-Adobe-3.0\n%AI5_FileFormat 14.0\n` +
  `0 0 m 100 0 L 100 100 L 0 100 L f\n` +
  `30 30 m 70 30 L 70 70 L 30 70 L f\n` +
  `-5 -5 m -4 -5 L -4 -4 L f\n`; // tiny degenerate (should be dropped)
const contours = _internals.parseAIArt(art);
ok(contours.length === 3, 'AI art → 3 raw contours parsed');
const grouped = _internals.groupByNesting(contours);
const outer = grouped.find(s => s.contours.length === 2);
ok(!!outer, 'AI nesting groups the hole into its outer (1 shape with 2 contours)');

// 3) AI curve operators produce bezier handles.
const curveArt = `%!PS-Adobe-3.0\n%AI5_x\n0 0 m 0 50 50 100 100 100 C 100 0 0 0 0 0 c f`;
const cc = _internals.parseAIArt(curveArt);
ok(cc.length === 1 && cc[0].points.some(p => p.handleIn || p.handleOut), 'AI C/c operators create handles');

console.log(fails ? `\n${fails} failed` : '\nAI import OK');
process.exit(fails ? 1 : 0);
