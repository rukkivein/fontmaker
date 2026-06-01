// Structural-invariant tests: inserting/deleting points must keep every master
// at an identical point count while preserving each master's own shape.
import {
  addContourAllMasters, insertPointAllMasters, deletePointsAllMasters, setLayerAllMasters,
} from '../src/js/project.js';
import { ensureLayer } from '../src/js/geometry.js';

let fails = 0;
function ok(cond, msg) { console.log((cond ? '✓' : '✗ FAIL') + ' ' + msg); if (!cond) fails++; }

const A = 'mA', B = 'mB';
const project = { masters: [{ id: A, name: 'Regular' }, { id: B, name: 'Bold' }], glyphs: [{ layers: {} }] };

// Seed each master with a straight horizontal segment of DIFFERENT length, so
// we can prove inserts use each master's own geometry.
const mk = (pts) => ({ closed: false, points: pts.map(([x, y]) => ({ x, y, type: 'corner', handleIn: null, handleOut: null })) });
addContourAllMasters(project, 0, mk([[0, 0], [100, 0]]));        // identical add to both
// now diverge B's geometry (designer reshaped Bold), counts still equal
ensureLayer(project.glyphs[0], B).contours[0].points[1].x = 200;

const cnt = (m) => ensureLayer(project.glyphs[0], m).contours[0].points.length;
ok(cnt(A) === 2 && cnt(B) === 2, 'both masters start with 2 points');

// Insert a point in the middle of segment 0 — propagates to both masters.
insertPointAllMasters(project, 0, 0, 0, 0.5);
ok(cnt(A) === 3 && cnt(B) === 3, 'after insert both masters have 3 points (counts stay equal)');

const pA = ensureLayer(project.glyphs[0], A).contours[0].points[1];
const pB = ensureLayer(project.glyphs[0], B).contours[0].points[1];
ok(Math.abs(pA.x - 50) < 1e-6, 'Regular inserted point sits on ITS curve (x≈50)');
ok(Math.abs(pB.x - 100) < 1e-6, 'Bold inserted point sits on ITS curve (x≈100) — shape preserved');

// Another insert (segment 1 this time) to simulate V→W densification.
insertPointAllMasters(project, 0, 0, 1, 0.5);
ok(cnt(A) === 4 && cnt(B) === 4, 'second insert keeps counts equal (4 / 4)');

// Delete the same point everywhere.
deletePointsAllMasters(project, 0, [{ ci: 0, pi: 1 }]);
ok(cnt(A) === 3 && cnt(B) === 3, 'delete removes matching point from both (3 / 3)');

// Assigning a shape resets all masters to identical, compatible geometry.
setLayerAllMasters(project, 0, [mk([[0, 0], [10, 0], [10, 10]])]);
ok(cnt(A) === 3 && cnt(B) === 3, 'assign sets all masters identical & compatible');
const sameRef = ensureLayer(project.glyphs[0], A).contours[0].points
  !== ensureLayer(project.glyphs[0], B).contours[0].points;
ok(sameRef, 'assigned masters are independent copies (not shared references)');

console.log(fails ? `\n${fails} test(s) failed` : '\nAll structural tests passed');
process.exit(fails ? 1 : 0);
