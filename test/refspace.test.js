'use strict';
// Unit tests for shared/refspace.js — the Arial+Times "X value" spacing math.
const assert = require('assert');
const refspace = require('../shared/refspace.js');
function ok(c, m) { assert.ok(c, m); console.log('✓ ' + m); }

// a square ink from x=100..300, y=0..700  (xMin=100, width=200)
function squareGlyph(ch, advance) {
  return {
    char: ch, advanceWidth: advance,
    layers: { m0: { contours: [{ closed: true, points: [
      { x: 100, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 700 }, { x: 100, y: 700 },
    ] }] } },
  };
}

// --- spacingTargets: fraction-of-em -> font units at a percent ---
var frac = { A: { lsb: 0.05, rsb: 0.04 }, W: { lsb: 0.01, rsb: 0.01 } };
var t100 = refspace.spacingTargets(frac, 1000, 100);
ok(t100.A.lsb === 50 && t100.A.rsb === 40, 'spacingTargets: 0.05/0.04 em @1000upm 100% -> 50/40');
ok(t100.W.lsb === 10 && t100.W.rsb === 10, 'spacingTargets: W -> 10/10');
var t200 = refspace.spacingTargets(frac, 1000, 200);
ok(t200.A.lsb === 100 && t200.A.rsb === 80, 'spacingTargets: 200% doubles (exaggerate)');
var t50 = refspace.spacingTargets(frac, 1000, 50);
ok(t50.A.lsb === 25 && t50.A.rsb === 20, 'spacingTargets: 50% halves (reduce)');
var t2048 = refspace.spacingTargets(frac, 2048, 100);
ok(t2048.A.lsb === Math.round(0.05 * 2048), 'spacingTargets: scales to the project UPM');

// --- applyRefSpacing: sets ink-left=lsb, advance=lsb+inkW+rsb, never resizes ---
var proj = { glyphs: [squareGlyph('A', 9999), squareGlyph('W', 1)] };
var n = refspace.applyRefSpacing(proj, 'm0', t100, 30);
ok(n === 2, 'applyRefSpacing: touched both drawn glyphs');
var A = proj.glyphs[0], W = proj.glyphs[1];
var Ab = require('../shared/optimizer.js').bezBounds(A.layers.m0.contours);
ok(Ab.xMin === 50, 'A ink-left moved to target LSB (50)');
ok(Math.round(Ab.w) === 200, 'A ink WIDTH unchanged (200) — never resized');
ok(A.advanceWidth === 50 + 200 + 40, 'A advance = lsb+inkW+rsb (290), NOT the original 9999');
ok(W.advanceWidth === 10 + 200 + 10, 'W advance = 220, independent of its original (1)');

// --- non-compounding: same targets applied again => identical ---
var advBefore = A.advanceWidth, xBefore = Ab.xMin;
refspace.applyRefSpacing(proj, 'm0', t100, 30);
var Ab2 = require('../shared/optimizer.js').bezBounds(A.layers.m0.contours);
ok(A.advanceWidth === advBefore && Ab2.xMin === xBefore, 'applying twice is idempotent (absolute, not cumulative)');

// --- skips specials and untargeted glyphs ---
var proj2 = { glyphs: [
  squareGlyph('A', 500),
  (function () { var g = squareGlyph('Z', 500); return g; })(),         // no target for Z
  (function () { var g = squareGlyph('ff', 500); g.kind = 'ligature'; return g; })(),
] };
var n2 = refspace.applyRefSpacing(proj2, 'm0', t100, 30);
ok(n2 === 1, 'applyRefSpacing: only the glyph with a target (A) is re-spaced; Z + ligature skipped');
ok(proj2.glyphs[1].advanceWidth === 500 && proj2.glyphs[2].advanceWidth === 500, 'untargeted + ligature advances untouched');

// --- minAdvance guards a big negative right bearing (e.g. f) from going <= 0 ---
var frac2 = { f: { lsb: 0.02, rsb: -0.30 } };
var tf = refspace.spacingTargets(frac2, 1000, 100);     // lsb 20, rsb -300
var projf = { glyphs: [squareGlyph('f', 500)] };         // inkW 200 -> 20+200-300 = -80
refspace.applyRefSpacing(projf, 'm0', tf, 30);
ok(projf.glyphs[0].advanceWidth === 30, 'minAdvance clamps an absurd negative advance to the floor');

// =====================================================================
// OPTICAL correction (density nudge, horizontal-only, advance fixed)
// =====================================================================
// A left-heavy triangle: vertices (100,0),(300,0),(100,400). Its area centroid x is
// (100+300+100)/3 = 166.7 — LEFT of the bbox centre (200), like a C.
function leftHeavyGlyph(ch) {
  return { char: ch, advanceWidth: 0, layers: { m0: { contours: [{ closed: true, points: [
    { x: 100, y: 0 }, { x: 300, y: 0 }, { x: 100, y: 400 },
  ] }] } } };
}
var cx = refspace.areaCentroidX(leftHeavyGlyph('C').layers.m0.contours);
ok(cx != null && Math.abs(cx - 200 / 3 - 100) < 1, 'areaCentroidX: left-heavy triangle centroid ≈166.7 (left of centre 200)');

var tC = refspace.spacingTargets({ C: { lsb: 0.05, rsb: 0.04 } }, 1000, 100); // lsb50 rsb40

// standard only (opticalAmount = 0)
var pStd = { glyphs: [leftHeavyGlyph('C')] };
refspace.applyRefSpacing(pStd, 'm0', tC, 30, 0);
var bStd = refspace.bezBounds(pStd.glyphs[0].layers.m0.contours);
ok(bStd.xMin === 50, 'standard: ink-left = LSB (50)');
ok(pStd.glyphs[0].advanceWidth === 290, 'standard: advance = 50+200+40 = 290');

// standard + optical (amount 1.0) — ink nudges LEFT, advance UNCHANGED, width UNCHANGED
var pOpt = { glyphs: [leftHeavyGlyph('C')] };
refspace.applyRefSpacing(pOpt, 'm0', tC, 30, 1.0);
var bOpt = refspace.bezBounds(pOpt.glyphs[0].layers.m0.contours);
ok(pOpt.glyphs[0].advanceWidth === 290, 'optical: advance STILL 290 — the box never moves');
ok(Math.round(bOpt.w) === 200, 'optical: ink width STILL 200 — never resized');
ok(bOpt.xMin < bStd.xMin, 'optical: left-heavy glyph nudged LEFT (ink-left ' + bOpt.xMin + ' < ' + bStd.xMin + ')');
ok(Math.abs(bOpt.xMin - (50 - 33.33)) < 1.5, 'optical: nudge = balance (≈ -33.3) within the bearings');

// optical clamp: a huge amount can't push the ink past the pen origin (ink-left ≥ 0)
var pClamp = { glyphs: [leftHeavyGlyph('C')] };
refspace.applyRefSpacing(pClamp, 'm0', tC, 30, 100);
var bClamp = refspace.bezBounds(pClamp.glyphs[0].layers.m0.contours);
ok(bClamp.xMin === 0, 'optical clamp: ink-left pinned at 0 (within LSB), not driven negative');
ok(pClamp.glyphs[0].advanceWidth === 290, 'optical clamp: advance still 290');

// optical is purely horizontal — Y bounds untouched
ok(bOpt.yMin === bStd.yMin && bOpt.yMax === bStd.yMax, 'optical: vertical bounds unchanged (horizontal-only)');

// stacking is order-independent / idempotent: re-applying gives the same result
var advBefore2 = bOpt.xMin;
refspace.applyRefSpacing(pOpt, 'm0', tC, 30, 1.0);
var bOpt2 = refspace.bezBounds(pOpt.glyphs[0].layers.m0.contours);
ok(Math.abs(bOpt2.xMin - advBefore2) < 0.01 && pOpt.glyphs[0].advanceWidth === 290, 'standard+optical re-apply is idempotent');

console.log('\nrefspace tests passed');
