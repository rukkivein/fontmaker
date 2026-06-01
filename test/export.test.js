const opentype = require('opentype.js');
const fontExport = require('../electron/fontExport');
const os = require('os'), path = require('path'), fs = require('fs');

const mId = 'm1';
const project = {
  unitsPerEm: 1000,
  metrics: { ascender: 800, capHeight: 700, xHeight: 500, baseline: 0, descender: -200 },
  masters: [{ id: mId, name: 'Regular' }],
  glyphs: [
    { name: 'A', char: 'A', unicode: 65, advanceWidth: 600, layers: { [mId]: { contours: [
      { closed: true, points: [
        { x: 100, y: 0, type:'corner', handleIn:null, handleOut:null },
        { x: 500, y: 0, type:'corner', handleIn:null, handleOut:null },
        { x: 500, y: 700, type:'corner', handleIn:null, handleOut:null },
        { x: 100, y: 700, type:'corner', handleIn:null, handleOut:null },
      ]},
      // a curved counter to test cubic export
      { closed: true, points: [
        { x: 200, y: 150, type:'smooth', handleIn:{x:200,y:80}, handleOut:{x:200,y:220} },
        { x: 400, y: 150, type:'smooth', handleIn:{x:400,y:220}, handleOut:{x:400,y:80} },
      ]},
    ] } } },
    { name: 'o', char: 'o', unicode: 111, advanceWidth: 560, layers: { [mId]: { contours: [] } } },
  ],
};
const out = path.join(os.tmpdir(), 'fm_test.otf');
const res = fontExport.export(project, 'otf', { familyName: 'TestFam', styleName: 'Regular', designer: 'Me', version: '1.001' }, out);
console.log('exported glyphs:', res.glyphCount, 'bytes:', fs.statSync(out).size);
const f = opentype.loadSync(out);
console.log('reloaded family:', f.names.fontFamily && f.names.fontFamily.en);
console.log('numGlyphs:', f.glyphs.length);
const A = f.charToGlyph('A');
console.log('A advanceWidth:', A.advanceWidth, 'path commands:', A.path.commands.length);
console.log('OK');
