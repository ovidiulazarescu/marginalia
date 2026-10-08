// Shared freehand-ink engine (perfect-freehand) used by canvas, PDF and sketch blocks.
import { getStroke } from './lib.js';
import { iconSVG } from './icons.js';

export const INK_COLORS = [
  { id: 'ink', label: 'Ink', css: 'var(--ink)', hex: '#1d2320' },
  { id: '#2f6fde', label: 'Blue', css: '#2f6fde', hex: '#2f6fde' },
  { id: '#d6453d', label: 'Red', css: '#d6453d', hex: '#d6453d' },
  { id: '#1f9d6b', label: 'Green', css: '#1f9d6b', hex: '#1f9d6b' },
  { id: '#8b5cd6', label: 'Purple', css: '#8b5cd6', hex: '#8b5cd6' },
  { id: '#e08a1e', label: 'Orange', css: '#e08a1e', hex: '#e08a1e' },
];
export const HL_COLORS = [
  { id: '#ffd84d', label: 'Yellow' }, { id: '#7ee0a6', label: 'Green' }, { id: '#8cc8ff', label: 'Blue' },
  { id: '#ff9ec4', label: 'Pink' }, { id: '#ffb26b', label: 'Orange' },
];
export const colorCss = (c) => (c === 'ink' ? 'var(--ink)' : c);
export const colorHex = (c, dark) => (c === 'ink' ? (dark ? '#e6ebe7' : '#1d2320') : c);

function outlineToPath(pts) {
  if (pts.length < 2) return '';
  const f = (n) => Math.round(n * 10) / 10;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}Q`;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    d += `${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)} `;
  }
  return d + 'Z';
}
export function strokeOptions(s, last = true) {
  const marker = s.tool === 'marker';
  return { size: s.size, thinning: marker ? 0 : 0.6, smoothing: 0.55, streamline: marker ? 0.6 : 0.45, simulatePressure: !!s.sim, last, start: { cap: !marker }, end: { cap: !marker } };
}
const cache = new WeakMap();
export function strokePath(s) {
  let d = cache.get(s);
  if (d === undefined) { d = outlineToPath(getStroke(s.points, strokeOptions(s))); cache.set(s, d); }
  return d;
}
export const livePath = (s) => outlineToPath(getStroke(s.points, strokeOptions(s, false)));
export const round1 = (n) => Math.round(n * 10) / 10;
export const strokeBounds = (s) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const p = s.size / 2;
  return { x: x0 - p, y: y0 - p, w: x1 - x0 + 2 * p, h: y1 - y0 + 2 * p };
};
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function hitStroke(s, x, y, r) {
  const pts = s.points, R = r + s.size / 2;
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) < R;
  for (let i = 1; i < pts.length; i++) if (segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < R) return true;
  return false;
}
export function pointFromEvent(e) {
  // Coalesced events give smoother, denser strokes on fast pen movement.
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  return evs.length ? evs : [e];
}
export const strokeSVG = (s) => `<path d="${strokePath(s)}" fill="${colorCss(s.color)}"${s.tool === 'marker' ? ' class="mk" opacity="0.38"' : ''}/>`;

/* ---------- Sketch blocks inside page notes ---------- */
export const newInkBlockHTML = () => `<div class="ink-block" contenteditable="false" data-ink='${JSON.stringify({ w: 680, h: 260, s: [] })}'></div>`;

export function inkSVGString(json, forExport = false) {
  let d;
  try { d = JSON.parse(json || '{}'); } catch { d = {}; }
  const w = d.w || 680, h = d.h || 260;
  const paths = (d.s || []).map((s) => {
    const fill = forExport ? colorHex(s.color, false) : colorCss(s.color);
    return `<path d="${strokePath(s)}" fill="${fill}"${s.tool === 'marker' ? ' opacity="0.38"' : ''}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${paths}</svg>`;
}

export function hydrateInk(block, { onChange, penOnly }) {
  if (block._ink) { block._ink.render(); return; }
  let data;
  try { data = JSON.parse(block.dataset.ink || '{}'); } catch { data = {}; }
  data.w ||= 680; data.h ||= 260; data.s ||= [];
  let tool = 'pen', color = 'ink', size = 3;
  const undo = [];
  block.innerHTML = '';
  block.setAttribute('contenteditable', 'false');
  block.tabIndex = -1;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ink-svg');
  const g = document.createElementNS(svg.namespaceURI, 'g');
  const live = document.createElementNS(svg.namespaceURI, 'path');
  svg.append(g, live);
  const bar = document.createElement('div');
  bar.className = 'ink-bar';
  bar.dataset.ui = '1';
  const btn = (name, title, act) => `<button type="button" data-act="${act}" title="${title}" aria-label="${title}">${iconSVG(name, 16)}</button>`;
  bar.innerHTML = `${btn('pen', 'Pen', 'pen')}${btn('marker', 'Highlighter', 'marker')}${btn('eraser', 'Eraser', 'eraser')}<span class="sep"></span>${INK_COLORS.map((c) => `<button type="button" class="dot" data-color="${c.id}" title="${c.label}" style="--c:${c.css}"></button>`).join('')}<span class="sep"></span>${btn('undo', 'Undo stroke', 'undo')}${btn('trash', 'Delete sketch', 'delete')}`;
  const grip = document.createElement('div');
  grip.className = 'ink-grip'; grip.dataset.ui = '1'; grip.title = 'Drag to resize';
  block.append(svg, bar, grip);

  const commit = () => {
    block.dataset.ink = JSON.stringify(data);
    onChange?.();
  };
  const render = () => {
    svg.setAttribute('viewBox', `0 0 ${data.w} ${data.h}`);
    svg.style.aspectRatio = `${data.w} / ${data.h}`;
    g.innerHTML = data.s.map(strokeSVG).join('');
    bar.querySelectorAll('[data-act]').forEach((b) => b.classList.toggle('on', b.dataset.act === tool));
    bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
  };
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) { color = b.dataset.color; if (tool === 'eraser') tool = 'pen'; }
    const a = b.dataset.act;
    if (a === 'pen' || a === 'marker' || a === 'eraser') { tool = a; size = a === 'marker' ? 16 : 3; }
    if (a === 'undo' && undo.length) { data.s = undo.pop(); commit(); }
    if (a === 'delete') { const p = document.createElement('p'); p.innerHTML = '<br>'; block.replaceWith(p); onChange?.(); return; }
    render();
  });
  const toLocal = (e) => {
    const r = svg.getBoundingClientRect();
    const k = data.w / r.width;
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  };
  let cur = null, erasing = false, scrollStart = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button > 0 && e.button !== 5) return;
    if (e.pointerType === 'touch' && penOnly()) {
      const sc = block.closest('.scroll');
      scrollStart = { y: e.clientY, top: sc?.scrollTop || 0, sc };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    e.preventDefault();
    block.focus({ preventScroll: true });
    svg.setPointerCapture(e.pointerId);
    const eraser = tool === 'eraser' || (e.buttons & 32);
    undo.push(data.s.slice()); if (undo.length > 50) undo.shift();
    if (eraser) { erasing = true; erase(e); return; }
    const [x, y] = toLocal(e);
    cur = { tool, color, size: tool === 'marker' ? 16 : size, sim: e.pointerType !== 'pen', points: [[round1(x), round1(y), e.pressure || 0.5]] };
    live.setAttribute('fill', colorCss(color));
    live.setAttribute('opacity', tool === 'marker' ? '0.38' : '1');
  });
  const erase = (e) => {
    const [x, y] = toLocal(e);
    const before = data.s.length;
    data.s = data.s.filter((s) => !hitStroke(s, x, y, 8));
    if (data.s.length !== before) render();
  };
  svg.addEventListener('pointermove', (e) => {
    if (scrollStart) { if (scrollStart.sc) scrollStart.sc.scrollTop = scrollStart.top - (e.clientY - scrollStart.y); return; }
    if (erasing) { erase(e); return; }
    if (!cur) return;
    for (const ev of pointFromEvent(e)) { const [x, y] = toLocal(ev); cur.points.push([round1(x), round1(y), ev.pressure || 0.5]); }
    live.setAttribute('d', livePath(cur));
  });
  const end = () => {
    if (scrollStart) { scrollStart = null; return; }
    if (erasing) { erasing = false; commit(); return; }
    if (!cur) return;
    data.s.push(cur); cur = null;
    live.setAttribute('d', '');
    render(); commit();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  block.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && undo.length) { e.preventDefault(); e.stopPropagation(); data.s = undo.pop(); render(); commit(); }
  });
  // Height grip
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId);
    const r = svg.getBoundingClientRect(); const k = data.w / r.width; const y0 = e.clientY, h0 = data.h;
    const mv = (ev) => { data.h = Math.max(120, Math.min(2000, Math.round(h0 + (ev.clientY - y0) * k))); render(); };
    const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); commit(); };
    grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
  });
  block._ink = { render };
  render();
}
