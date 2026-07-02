'use strict';
// accentCompose — (1) hand-drawn accented glyphs are NEVER silently overwritten
// (only self-composed ones refresh; opts.force overrides), (2) Turkish İ (U+0130)
// composes from I + dotaccent, (3) ı (U+0131) stays non-decomposable by design.
const ac = require('../shared/accentCompose.js');

let fails = 0;
const ok = (c, m) => { console.log((c ? '✓' : '✗ FAIL') + ' ' + m); if (!c) fails++; };

const MID = 'm1';
const box = (x0, x1, y0, y1) => ({ closed: true, points: [
  { x: x0, y: y0, type: 'corner', handleIn: null, handleOut: null },
  { x: x1, y: y0, type: 'corner', handleIn: null, handleOut: null },
  { x: x1, y: y1, type: 'corner', handleIn: null, handleOut: null },
  { x: x0, y: y1, type: 'corner', handleIn: null, handleOut: null },
] });
const slot = (name, ch, adv, contours) => ({
  name, char: ch, unicode: ch.codePointAt(0), advanceWidth: adv,
  layers: { [MID]: contours ? { contours } : {} },
});

function proj() {
  return {
    unitsPerEm: 1000,
    metrics: { unitsPerEm: 1000, ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
    masters: [{ id: MID, name: 'Regular' }],
    glyphs: [
      slot('e', 'e', 520, [box(60, 460, 0, 500)]),
      slot('s', 's', 480, [box(60, 420, 0, 500)]),
      slot('I', 'I', 300, [box(100, 200, 0, 700)]),
      slot('acute', '´', 260, [box(80, 180, 560, 700)]),
      slot('cedilla', '¸', 260, [box(80, 180, -180, -60)]),
      slot('dotaccent', '˙', 260, [box(100, 160, 560, 640)]),
      slot('eacute', 'é', 520, null),                      // empty → composable
      slot('scedilla', 'ş', 500, [box(50, 430, -180, 500)]), // HAND-DRAWN ş
      slot('Idotaccent', 'İ', 300, null),                  // empty → composable
    ],
  };
}

// (1) normal compose into an empty slot works
const p1 = proj();
const r1 = ac.composeAccent(p1, 'é', MID);
ok(r1.ok, 'é composes from e + acute (' + JSON.stringify(r1.marks) + ')');
const eacute = p1.glyphs.find(g => g.char === 'é');
ok(eacute.composedFrom === 'e' && eacute.layers[MID].contours.length === 2, 'é carries composedFrom + base+mark contours');

// (2) hand-drawn ş is protected — composeAccent refuses without force
const r2 = ac.composeAccent(p1, 'ş', MID);
ok(!r2.ok && r2.reason === 'target-drawn', 'hand-drawn ş is NOT overwritten (reason=' + r2.reason + ')');
const sced = p1.glyphs.find(g => g.char === 'ş');
ok(sced.layers[MID].contours.length === 1 && !sced.composedFrom, 'ş artwork intact after the refusal');

// (3) …unless the caller forces it
const r3 = ac.composeAccent(p1, 'ş', MID, { force: true });
ok(r3.ok && sced.composedFrom === 's', 'force:true deliberately overwrites ş (composedFrom=' + sced.composedFrom + ')');

// (4) previously self-composed glyphs keep refreshing (no force needed)
const r4 = ac.composeAccent(p1, 'é', MID);
ok(r4.ok, 'a self-composed é recomposes freely (refresh path)');

// (5) composeAll skips the hand-drawn target but reports it (not silent)
const p2 = proj();
const all = ac.composeAll(p2, MID);
ok(all.composed.indexOf('é') >= 0, 'composeAll composes é');
ok(all.composed.indexOf('ş') < 0 && all.skipped.some(s => s.char === 'ş' && s.reason === 'target-drawn'),
  'composeAll skips hand-drawn ş and reports it');

// (6) Turkish İ (U+0130) decomposes to I + dotaccent and composes
ok(!!ac.DECOMPOSE[0x0130], 'İ (U+0130) is in the decompose table');
ok(all.composed.indexOf('İ') >= 0, 'composeAll composes İ from I + dotaccent');
const Idot = p2.glyphs.find(g => g.char === 'İ');
ok(Idot && Idot.layers[MID].contours.length === 2, 'İ = I stem + dot above');

// (7) ı (U+0131) has no NFD decomposition — never guessed, by design
ok(!ac.DECOMPOSE[0x0131], 'ı (U+0131) stays non-decomposable (draw by hand)');

console.log(fails ? ('\n' + fails + ' failed') : '\naccents OK');
process.exit(fails ? 1 : 0);
