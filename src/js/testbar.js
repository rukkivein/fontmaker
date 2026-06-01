import { store } from './store.js';
import { ensureLayer, layerToSVGPath } from './geometry.js';

// Bottom test strip — always light. Renders typed text using the current
// glyphs' outlines (falls back to the ghost system font for empty glyphs).
export function initTestbar() {
  const bar = document.getElementById('testbar');
  const toggle = document.getElementById('testbar-toggle');
  const input = document.getElementById('testbar-input');
  const size = document.getElementById('testbar-size');

  toggle.onclick = () => {
    bar.classList.toggle('collapsed');
    toggle.textContent = bar.classList.contains('collapsed') ? '▲' : '▼';
    renderTestbar();
  };
  input.oninput = renderTestbar;
  size.oninput = renderTestbar;
  renderTestbar();
}

export function renderTestbar() {
  const bar = document.getElementById('testbar');
  if (bar.classList.contains('collapsed') || !store.project) return;
  const host = document.getElementById('testbar-render');
  const input = document.getElementById('testbar-input');
  const size = +document.getElementById('testbar-size').value;
  const masterLabel = document.getElementById('testbar-master-label');
  const masterId = store.ui.activeMasterId || store.project.masters[0].id;
  const m = store.project.masters.find(x => x.id === masterId);
  masterLabel.textContent = m ? 'Master: ' + m.name : '';

  const metrics = store.project.metrics;
  const upm = store.project.unitsPerEm;
  const scale = size / upm;
  const text = input.value;
  let x = 20;
  const baseline = metrics.ascender * scale + 10;
  let paths = '';
  let fallbacks = '';

  for (const ch of text) {
    const gi = store.project.glyphs.findIndex(g => g.char === ch);
    const glyph = gi >= 0 ? store.project.glyphs[gi] : null;
    const adv = glyph ? glyph.advanceWidth : upm * 0.5;
    if (glyph) {
      const layer = ensureLayer(glyph, masterId);
      if (layer.contours.length) {
        const d = layerToSVGPath(layer, false); // keep y-up; flipped by transform below
        paths += `<path transform="translate(${x},${baseline}) scale(${scale},${-scale})" d="${d}"/>`;
      } else if (ch !== ' ') {
        fallbacks += `<text x="${x}" y="${baseline}" font-size="${size}" fill="#bbb" font-family="Helvetica, Arial">${escapeXML(ch)}</text>`;
      }
    }
    x += adv * scale;
  }
  host.innerHTML = `<svg width="${Math.max(x + 20, 100)}" height="${(metrics.ascender - metrics.descender) * scale + 20}">${fallbacks}${paths}</svg>`;
}

function escapeXML(s) { return s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
