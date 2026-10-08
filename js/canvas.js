// Infinite canvas: cards, sticky notes, linked-note cards, images, frames, arrows and freehand ink.
import { html, useState, useRef, useEffect, useLayoutEffect, useMemo } from './lib.js';
import { S, updateNote, open, pickNote, findByTitle, toast, importPdf, flushers } from './store.js';
import { strokePath, livePath, hitStroke, strokeBounds, round1, pointFromEvent, colorCss, INK_COLORS, HL_COLORS } from './ink.js';
import { Icon, typeIcon } from './icons.js';
import { uid, cls, clamp, mod, imageToDataURL, pickFiles, debounce, isTyping, MOD, SHIFT } from './util.js';
import { openMenu } from './dialogs.js';

export const CARD_COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
const TOOLS = [
  ['select', 'pointer', 'Select', 'V'], ['hand', 'hand', 'Pan', 'H'], ['pen', 'pen', 'Pen', 'P'], ['marker', 'marker', 'Highlighter', 'M'],
  ['eraser', 'eraser', 'Eraser', 'E'], ['text', 'text', 'Text card', 'T'], ['sticky', 'sticky', 'Sticky note', 'S'],
  ['note', 'note', 'Note card', 'N'], ['arrow', 'arrow', 'Connect cards', 'A'], ['frame', 'frame', 'Frame', 'F'],
];
const KEYMAP = { v: 'select', h: 'hand', p: 'pen', m: 'marker', e: 'eraser', t: 'text', s: 'sticky', n: 'note', a: 'arrow', f: 'frame' };

function itemRect(it) { return { x: it.x, y: it.y, w: it.w, h: it.h }; }
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

function anchor(r, tx, ty) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = r.w / 2 / Math.abs(dx || 1e-9), sy = r.h / 2 / Math.abs(dy || 1e-9);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}
export function edgePath(a, b) {
  const [x1, y1] = anchor(a, b.x + b.w / 2, b.y + b.h / 2);
  const [x2, y2] = anchor(b, a.x + a.w / 2, a.y + a.h / 2);
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const horiz = Math.abs(x2 - x1) > Math.abs(y2 - y1);
  const c1 = horiz ? [mx, y1] : [x1, my], c2 = horiz ? [mx, y2] : [x2, my];
  return { d: `M${x1} ${y1} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x2} ${y2}`, x2, y2, ang: Math.atan2(y2 - c2[1], x2 - c2[0]) };
}
export function contentBounds(doc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (r) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
  (doc.items || []).forEach((i) => add(itemRect(i)));
  (doc.strokes || []).forEach((s) => add(strokeBounds(s)));
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function RichText({ text }) {
  const parts = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const n = findByTitle(m[1]);
    parts.push(html`<a class=${cls('cv-link', !n && 'missing')} onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); if (n) open(n.id, { split: mod(e) }); else toast(`No note named “${m[1]}” yet`); }}>${m[1]}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

export function CanvasView({ note }) {
  const doc = note.content;
  const items = doc.items || [], strokes = doc.strokes || [], edges = doc.edges || [];
  const root = useRef();
  const live = useRef();
  const [view, setViewState] = useState(note.view || null);
  const viewRef = useRef(view);
  const [tool, setTool] = useState('select');
  const [penColor, setPenColor] = useState('ink');
  const [hlColor, setHlColor] = useState('#ffd84d');
  const [penSize, setPenSize] = useState(3);
  const [sel, setSel] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [drag, setDrag] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [linkDraft, setLinkDraft] = useState(null);
  const [space, setSpace] = useState(false);
  const g = useRef(null);
  const pointers = useRef(new Map());
  const hist = useRef({ undo: [], redo: [] });
  const docRef = useRef(doc);
  docRef.current = doc;

  const saveView = useMemo(() => debounce((v) => updateNote(note.id, { view: v }), 600), [note.id]);
  useEffect(() => { flushers.add(saveView.flush); return () => { saveView.flush(); flushers.delete(saveView.flush); }; }, [saveView]);
  const setView = (v) => { viewRef.current = v; setViewState(v); saveView(v); };

  useLayoutEffect(() => { if (!view) zoomToFit(false); }, []);
  useEffect(() => { hist.current = { undo: [], redo: [] }; setSel(new Set()); }, [note.rev]);
  // Focus the card editor after it is attached to the document.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = root.current?.querySelector('.cv-edit');
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.tagName === 'INPUT') el.select(); else { el.selectionStart = el.value.length; el.style.height = el.scrollHeight + 'px'; }
  }, [editing]);

  const commit = (patch, record = true) => {
    const cur = docRef.current;
    if (record) { hist.current.undo.push(cur); if (hist.current.undo.length > 100) hist.current.undo.shift(); hist.current.redo = []; }
    const next = { ...cur, ...patch };
    docRef.current = next;
    updateNote(note.id, { content: next });
  };
  const undo = () => { const h = hist.current; if (!h.undo.length) return; h.redo.push(docRef.current); const p = h.undo.pop(); docRef.current = p; updateNote(note.id, { content: p }); setSel(new Set()); };
  const redo = () => { const h = hist.current; if (!h.redo.length) return; h.undo.push(docRef.current); const p = h.redo.pop(); docRef.current = p; updateNote(note.id, { content: p }); };

  const v = view || { x: 0, y: 0, z: 1 };
  const toWorld = (cx, cy) => { const r = root.current.getBoundingClientRect(); const vv = viewRef.current || v; return [(cx - r.left - vv.x) / vv.z, (cy - r.top - vv.y) / vv.z]; };

  function zoomToFit(animate = true) {
    const el = root.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = contentBounds(docRef.current);
    if (!b) { setView({ x: r.width / 2 - 200, y: r.height / 3, z: 1 }); return; }
    const pad = 80;
    const z = clamp(Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2 - 60) / Math.max(b.h, 1)), 0.1, 1.5);
    setView({ x: r.width / 2 - (b.x + b.w / 2) * z, y: (r.height - 60) / 2 - (b.y + b.h / 2) * z, z });
  }
  const zoomAt = (factor, cx, cy) => {
    const r = root.current.getBoundingClientRect();
    const vv = viewRef.current || v;
    const z = clamp(vv.z * factor, 0.08, 6);
    const px = cx - r.left, py = cy - r.top;
    setView({ x: px - ((px - vv.x) * z) / vv.z, y: py - ((py - vv.y) * z) / vv.z, z });
  };
  const zoomCenter = (f) => { const r = root.current.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); };

  // Wheel needs a non-passive listener for preventDefault.
  useEffect(() => {
    const el = root.current;
    const onWheel = (e) => {
      if (e.target.closest('.cv-edit')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX, e.clientY);
      else { const vv = viewRef.current || v; setView({ ...vv, x: vv.x - e.deltaX, y: vv.y - e.deltaY }); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ---- creation helpers ---- */
  const addItem = (it, edit = false) => {
    const item = { id: uid('i'), color: 'none', ...it };
    commit({ items: [...docRef.current.items, item] });
    setSel(new Set([item.id]));
    if (edit) setEditing(item.id);
    return item;
  };
  const addNoteCard = async (x, y) => {
    const n = await pickNote({ title: 'Add a note card', allowCreate: true });
    if (n) addItem({ kind: 'note', noteId: n.id, x: x - 130, y: y - 50, w: 260, h: 120 });
    setTool('select');
  };
  const addImages = async (files, x, y) => {
    let off = 0;
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const { src, w, h } = await imageToDataURL(f, 1400);
      const s = Math.min(1, 420 / w);
      addItem({ kind: 'image', src, x: x + off, y: y + off, w: Math.round(w * s), h: Math.round(h * s) });
      off += 24;
    }
  };

  /* ---- pointer handling ---- */
  const hitItem = (e) => e.target.closest?.('[data-item]')?.dataset.item;
  const onPointerDown = (e) => {
    if (e.target.closest('.cv-ui') || e.target.closest('.cv-edit')) return;
    root.current.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: viewRef.current || v };
      if (live.current) live.current.setAttribute('d', '');
      setDrag(null); setMarquee(null);
      return;
    }
    if (pointers.current.size > 2) return;
    root.current.setPointerCapture(e.pointerId);
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const itemId = hitItem(e);
    const touchPan = e.pointerType === 'touch' && S.settings.penOnly && !(tool === 'select' && itemId);
    let t = tool;
    if (e.pointerType === 'pen' && (e.buttons & 32)) t = 'eraser';
    if (e.button === 1 || space || t === 'hand' || touchPan) {
      g.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v0: viewRef.current || v };
      return;
    }
    if (editing) { setEditing(null); }
    if (t === 'pen' || t === 'marker') {
      const marker = t === 'marker';
      g.current = { kind: 'draw', stroke: { id: uid('s'), tool: t, color: marker ? hlColor : penColor, size: marker ? 18 : penSize, sim: e.pointerType !== 'pen', points: [[round1(wx), round1(wy), e.pressure || 0.5]] } };
      live.current.setAttribute('fill', colorCss(g.current.stroke.color));
      live.current.setAttribute('opacity', marker ? '0.4' : '1');
      return;
    }
    if (t === 'eraser') { g.current = { kind: 'erase', removed: new Set() }; eraseAt(wx, wy); return; }
    if (t === 'text' || t === 'sticky') {
      addItem(t === 'text' ? { kind: 'text', text: '', x: wx - 8, y: wy - 16, w: 260, h: 64 } : { kind: 'sticky', text: '', color: 'yellow', x: wx - 100, y: wy - 80, w: 200, h: 180 }, true);
      setTool('select');
      return;
    }
    if (t === 'note') { addNoteCard(wx, wy); return; }
    if (t === 'frame') { g.current = { kind: 'frame', x0: wx, y0: wy }; setMarquee({ x: wx, y: wy, w: 0, h: 0, frame: true }); return; }
    if (t === 'arrow') {
      if (itemId) { g.current = { kind: 'link', from: itemId }; setLinkDraft({ from: itemId, x: wx, y: wy }); }
      return;
    }
    // select tool
    if (e.target.closest('.cv-resize')) {
      const it = items.find((i) => i.id === itemId);
      g.current = { kind: 'resize', id: itemId, sx: wx, sy: wy, w0: it.w, h0: it.h, ratio: it.kind === 'image' ? it.h / it.w : 0 };
      return;
    }
    const edgeId = e.target.closest('[data-edge]')?.dataset.edge;
    let hit = itemId;
    if (!hit && !edgeId) { const s = [...strokes].reverse().find((s) => hitStroke(s, wx, wy, 6 / (viewRef.current || v).z)); hit = s?.id; }
    if (edgeId) { setSel(new Set([edgeId])); return; }
    if (hit) {
      let next = sel;
      if (e.shiftKey) { next = new Set(sel); next.has(hit) ? next.delete(hit) : next.add(hit); }
      else if (!sel.has(hit)) next = new Set([hit]);
      setSel(next);
      // Frames carry the cards and ink that sit inside them.
      const ids = new Set(next);
      for (const id of next) {
        const f = items.find((i) => i.id === id && i.kind === 'frame');
        if (!f) continue;
        items.forEach((i) => i.id !== f.id && inside(itemRect(i), f) && ids.add(i.id));
        strokes.forEach((s) => inside(strokeBounds(s), f) && ids.add(s.id));
      }
      g.current = { kind: 'move', ids, sx: wx, sy: wy, moved: false, alt: e.altKey };
      return;
    }
    if (!e.shiftKey) setSel(new Set());
    g.current = { kind: 'marquee', x0: wx, y0: wy, base: e.shiftKey ? new Set(sel) : new Set() };
    setMarquee({ x: wx, y: wy, w: 0, h: 0 });
  };

  const eraseAt = (x, y) => {
    const r = 8 / (viewRef.current || v).z;
    const gone = strokes.filter((s) => !g.current.removed.has(s.id) && hitStroke(s, x, y, r));
    if (gone.length) { gone.forEach((s) => g.current.removed.add(s.id)); setDrag({ hidden: new Set(g.current.removed) }); }
  };

  const onPointerMove = (e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const G = g.current;
    if (!G) return;
    if (G.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const r = root.current.getBoundingClientRect();
      const z = clamp(G.v0.z * (d / G.d0), 0.08, 6);
      const wx = (G.m0[0] - r.left - G.v0.x) / G.v0.z, wy = (G.m0[1] - r.top - G.v0.y) / G.v0.z;
      setView({ z, x: m[0] - r.left - wx * z, y: m[1] - r.top - wy * z });
      return;
    }
    if (G.kind === 'pan') { setView({ ...G.v0, x: G.v0.x + e.clientX - G.sx, y: G.v0.y + e.clientY - G.sy }); return; }
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    if (G.kind === 'draw') {
      for (const ev of pointFromEvent(e)) { const [x, y] = toWorld(ev.clientX, ev.clientY); G.stroke.points.push([round1(x), round1(y), ev.pressure || 0.5]); }
      live.current.setAttribute('d', livePath(G.stroke));
      return;
    }
    if (G.kind === 'erase') { eraseAt(wx, wy); return; }
    if (G.kind === 'move') {
      const dx = wx - G.sx, dy = wy - G.sy;
      if (!G.moved && Math.hypot(dx, dy) * (viewRef.current || v).z < 3) return;
      G.moved = true; G.dx = dx; G.dy = dy;
      setDrag({ ids: G.ids, dx, dy });
      return;
    }
    if (G.kind === 'resize') {
      let w = Math.max(80, G.w0 + wx - G.sx), h = Math.max(40, G.h0 + wy - G.sy);
      if (G.ratio) h = w * G.ratio;
      G.w = w; G.h = h;
      setDrag({ resize: G.id, w, h });
      return;
    }
    if (G.kind === 'marquee' || G.kind === 'frame') {
      const r = { x: Math.min(G.x0, wx), y: Math.min(G.y0, wy), w: Math.abs(wx - G.x0), h: Math.abs(wy - G.y0), frame: G.kind === 'frame' };
      setMarquee(r);
      if (G.kind === 'marquee') {
        const next = new Set(G.base);
        items.forEach((i) => intersects(itemRect(i), r) && next.add(i.id));
        strokes.forEach((s) => intersects(strokeBounds(s), r) && next.add(s.id));
        setSel(next);
      }
      return;
    }
    if (G.kind === 'link') setLinkDraft({ from: G.from, x: wx, y: wy, over: hitItem(e) || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-item]')?.dataset.item });
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    const G = g.current;
    if (!G) return;
    if (G.kind === 'pinch') { if (pointers.current.size < 2) g.current = null; return; }
    g.current = null;
    if (G.kind === 'draw') {
      live.current.setAttribute('d', '');
      if (G.stroke.points.length > 1 || G.stroke.tool === 'pen') commit({ strokes: [...docRef.current.strokes, G.stroke] });
    } else if (G.kind === 'erase') {
      setDrag(null);
      if (G.removed.size) commit({ strokes: docRef.current.strokes.filter((s) => !G.removed.has(s.id)) });
    } else if (G.kind === 'move') {
      setDrag(null);
      if (G.moved) {
        const { dx, dy, ids } = G;
        const dup = G.alt;
        if (dup) {
          const map = new Map();
          const newItems = docRef.current.items.filter((i) => ids.has(i.id)).map((i) => { const c = { ...i, id: uid('i'), x: i.x + dx, y: i.y + dy }; map.set(i.id, c.id); return c; });
          const newStrokes = docRef.current.strokes.filter((s) => ids.has(s.id)).map((s) => ({ ...s, id: uid('s'), points: s.points.map(([x, y, p]) => [round1(x + dx), round1(y + dy), p]) }));
          commit({ items: [...docRef.current.items, ...newItems], strokes: [...docRef.current.strokes, ...newStrokes] });
          setSel(new Set([...newItems.map((i) => i.id), ...newStrokes.map((s) => s.id)]));
        } else {
          commit({
            items: docRef.current.items.map((i) => (ids.has(i.id) ? { ...i, x: Math.round(i.x + dx), y: Math.round(i.y + dy) } : i)),
            strokes: docRef.current.strokes.map((s) => (ids.has(s.id) ? { ...s, points: s.points.map(([x, y, p]) => [round1(x + dx), round1(y + dy), p]) } : s)),
          });
        }
      }
    } else if (G.kind === 'resize') {
      setDrag(null);
      if (G.w) commit({ items: docRef.current.items.map((i) => (i.id === G.id ? { ...i, w: Math.round(G.w), h: Math.round(G.h) } : i)) });
    } else if (G.kind === 'marquee') setMarquee(null);
    else if (G.kind === 'frame') {
      setMarquee(null);
      const m = marquee;
      if (m && m.w > 40 && m.h > 40) {
        const f = { id: uid('i'), kind: 'frame', text: 'Untitled frame', color: 'none', x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h) };
        // Frames go to the back so cards stay clickable.
        commit({ items: [f, ...docRef.current.items] });
        setSel(new Set([f.id])); setEditing(f.id);
      }
      setTool('select');
    } else if (G.kind === 'link') {
      setLinkDraft(null);
      const to = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-item]')?.dataset.item;
      if (to && to !== G.from && !edges.some((x) => (x.from === G.from && x.to === to) || (x.from === to && x.to === G.from))) commit({ edges: [...docRef.current.edges, { id: uid('e'), from: G.from, to }] });
    }
  };

  const onDblClick = (e) => {
    if (e.target.closest('.cv-ui') || e.target.closest('.cv-edit')) return;
    const id = hitItem(e);
    const it = items.find((i) => i.id === id);
    if (it?.kind === 'note') { open(it.noteId, { split: mod(e) || e.shiftKey }); return; }
    if (it && it.kind !== 'image') { setEditing(it.id); setSel(new Set([it.id])); return; }
    if (!it && tool === 'select') { const [wx, wy] = toWorld(e.clientX, e.clientY); addItem({ kind: 'text', text: '', x: wx - 8, y: wy - 16, w: 260, h: 64 }, true); }
  };

  /* ---- keyboard ---- */
  const deleteSel = () => {
    if (!sel.size) return;
    commit({
      items: items.filter((i) => !sel.has(i.id)),
      strokes: strokes.filter((s) => !sel.has(s.id)),
      edges: edges.filter((x) => !sel.has(x.id) && !sel.has(x.from) && !sel.has(x.to)),
    });
    setSel(new Set());
  };
  const duplicateSel = () => {
    const newItems = items.filter((i) => sel.has(i.id)).map((i) => ({ ...i, id: uid('i'), x: i.x + 24, y: i.y + 24 }));
    const newStrokes = strokes.filter((s) => sel.has(s.id)).map((s) => ({ ...s, id: uid('s'), points: s.points.map(([x, y, p]) => [x + 24, y + 24, p]) }));
    commit({ items: [...items, ...newItems], strokes: [...strokes, ...newStrokes] });
    setSel(new Set([...newItems, ...newStrokes].map((x) => x.id)));
  };
  const setColorSel = (c) => commit({ items: items.map((i) => (sel.has(i.id) && i.kind !== 'image' ? { ...i, color: c } : i)) });
  const setInkColorSel = (c) => commit({ strokes: strokes.map((s) => (sel.has(s.id) ? { ...s, color: c } : s)) });
  const order = (front) => {
    const chosen = items.filter((i) => sel.has(i.id)), rest = items.filter((i) => !sel.has(i.id));
    commit({ items: front ? [...rest, ...chosen] : [...chosen, ...rest] });
  };

  const onKeyDown = (e) => {
    if (isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (mod(e) && k === 'z') { e.preventDefault(); e.stopPropagation(); e.shiftKey ? redo() : undo(); return; }
    if (mod(e) && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod(e) && k === 'a') { e.preventDefault(); setSel(new Set([...items.map((i) => i.id), ...strokes.map((s) => s.id)])); return; }
    if (mod(e) && k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (mod(e) && (k === '=' || k === '+')) { e.preventDefault(); zoomCenter(1.2); return; }
    if (mod(e) && k === '-') { e.preventDefault(); zoomCenter(1 / 1.2); return; }
    if (mod(e) && k === '0') { e.preventDefault(); const r = root.current.getBoundingClientRect(); zoomAt(1 / v.z, r.left + r.width / 2, r.top + r.height / 2); return; }
    if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); zoomToFit(); return; }
    if (mod(e) || e.altKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); return; }
    if (e.key === 'Escape') { setSel(new Set()); setTool('select'); return; }
    if (e.key === 'Enter' && sel.size === 1) { const it = items.find((i) => sel.has(i.id)); if (it?.kind === 'note') open(it.noteId); else if (it && it.kind !== 'image') { e.preventDefault(); setEditing(it.id); } return; }
    if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      commit({ items: items.map((i) => (sel.has(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)), strokes: strokes.map((s) => (sel.has(s.id) ? { ...s, points: s.points.map(([x, y, p]) => [x + dx, y + dy, p]) } : s)) });
      return;
    }
    if (e.key === ' ' && !space) { e.preventDefault(); setSpace(true); return; }
    if (KEYMAP[k] && !e.repeat) { e.preventDefault(); setTool(KEYMAP[k]); }
  };
  const onKeyUp = (e) => { if (e.key === ' ') setSpace(false); };

  const onPaste = async (e) => {
    if (isTyping(e)) return;
    const r = root.current.getBoundingClientRect();
    const [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files, cx - 150, cy - 100); return; }
    const t = e.clipboardData.getData('text/plain');
    if (t) { e.preventDefault(); addItem({ kind: 'text', text: t.slice(0, 5000), x: cx - 130, y: cy - 40, w: 280, h: Math.min(400, 40 + 22 * t.split('\n').length) }); }
  };
  const onDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const nid = e.dataTransfer.getData('application/x-note-id');
    if (nid && S.notes.has(nid)) { addItem({ kind: 'note', noteId: nid, x: wx - 130, y: wy - 50, w: 260, h: 120 }); return; }
    const files = [...e.dataTransfer.files];
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) addImages(imgs, wx, wy);
    for (const f of files.filter((f) => f.type === 'application/pdf')) {
      const n = await importPdf(f, { notebookId: note.notebookId, openIt: false });
      if (n) addItem({ kind: 'note', noteId: n.id, x: wx - 130, y: wy - 50, w: 260, h: 120 });
    }
  };

  const itemMenu = (e, it) => {
    if (!sel.has(it.id)) setSel(new Set([it.id]));
    openMenu(e, [
      it.kind === 'note' && { label: 'Open note', icon: 'external', run: () => open(it.noteId) },
      it.kind === 'note' && { label: 'Open in split view', icon: 'split', run: () => open(it.noteId, { split: true }) },
      it.kind !== 'image' && it.kind !== 'note' && { label: 'Edit text', icon: 'text', run: () => setEditing(it.id) },
      { label: 'Duplicate', icon: 'duplicate', kbd: `${MOD}D`, run: duplicateSel },
      { label: 'Bring to front', icon: 'layers', run: () => order(true) },
      { label: 'Send to back', icon: 'layers', run: () => order(false) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, kbd: '⌫', run: deleteSel },
    ], { at: 'pointer' });
  };

  /* ---- render ---- */
  const dragFor = (id) => (drag?.ids?.has(id) ? [drag.dx, drag.dy] : null);
  const rectFor = (it) => {
    const d = dragFor(it.id);
    let r = { x: it.x + (d ? d[0] : 0), y: it.y + (d ? d[1] : 0), w: it.w, h: it.h };
    if (drag?.resize === it.id) { r.w = drag.w; r.h = drag.h; }
    return r;
  };
  const byId = new Map(items.map((i) => [i.id, i]));
  const single = sel.size === 1 ? items.find((i) => sel.has(i.id)) : null;
  const selStrokes = strokes.filter((s) => sel.has(s.id));
  const selItems = items.filter((i) => sel.has(i.id));
  const cursor = space || tool === 'hand' ? (g.current?.kind === 'pan' ? 'grabbing' : 'grab') : tool === 'select' ? 'default' : tool === 'eraser' ? 'cell' : 'crosshair';

  const renderItem = (it) => {
    const r = rectFor(it);
    const isSel = sel.has(it.id);
    const isEdit = editing === it.id;
    const style = `left:${r.x}px;top:${r.y}px;width:${r.w}px;${it.kind === 'text' ? `min-height:${r.h}px` : `height:${r.h}px`}`;
    let body;
    if (it.kind === 'note') {
      const n = S.notes.get(it.noteId);
      body = n && !n.trashed
        ? html`<div class="cv-note-type"><${Icon} name=${typeIcon(n.type)} size=${14} /><span>${n.type === 'pdf' ? `PDF · ${n.content.pages || '?'} pages` : n.type === 'canvas' ? 'Canvas' : 'Page'}</span></div>
            <div class="cv-note-title">${n.title || 'Untitled'}</div>
            <div class="cv-note-ex">${(n.text || '').slice(0, 220)}</div>`
        : html`<div class="cv-note-title muted">Missing note</div>`;
    } else if (it.kind === 'image') body = html`<img src=${it.src} alt="" draggable="false" />`;
    else if (it.kind === 'frame') body = isEdit
      ? html`<input class="cv-edit cv-frame-input" id=${'frame-' + it.id} defaultValue=${it.text} 
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.target.blur(); root.current.focus({ preventScroll: true }); } }}
          onBlur=${(e) => { setEditing(null); if (e.target.value !== it.text) commit({ items: docRef.current.items.map((i) => (i.id === it.id ? { ...i, text: e.target.value } : i)) }); }} />`
      : html`<div class="cv-frame-label">${it.text || 'Frame'}</div>`;
    else body = isEdit
      ? html`<textarea class="cv-edit" id=${'card-' + it.id} 
          onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && mod(e))) { e.target.blur(); root.current.focus({ preventScroll: true }); } }}
          onInput=${(e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
          onBlur=${(e) => {
            setEditing(null);
            const text = e.target.value;
            const h = Math.max(it.h, Math.ceil(e.target.scrollHeight + 2));
            if (!text.trim() && it.kind === 'text') { commit({ items: docRef.current.items.filter((i) => i.id !== it.id) }); return; }
            if (text !== it.text || h !== it.h) commit({ items: docRef.current.items.map((i) => (i.id === it.id ? { ...i, text, h: it.kind === 'text' ? h : i.h } : i)) });
          }} defaultValue=${it.text}></textarea>`
      : html`<div class="cv-text">${it.text ? html`<${RichText} text=${it.text} />` : html`<span class="muted">${it.kind === 'sticky' ? 'Sticky note' : 'Empty card'}</span>`}</div>`;
    return html`<div key=${it.id} data-item=${it.id} class=${cls('cv-item', 'cv-' + it.kind, 'c-' + (it.color || 'none'), isSel && 'sel', isEdit && 'editing', linkDraft?.over === it.id && 'link-target')} style=${style}
      onContextMenu=${(e) => itemMenu(e, it)}>
      ${body}
      ${isSel && sel.size === 1 && tool === 'select' && !isEdit && html`<div class="cv-resize cv-handle" aria-hidden="true"></div>`}
    </div>`;
  };

  const frames = items.filter((i) => i.kind === 'frame'), cards = items.filter((i) => i.kind !== 'frame');
  const selBox = (() => {
    if (!selStrokes.length) return null;
    const bs = selStrokes.map(strokeBounds);
    const d = drag?.ids ? [drag.dx, drag.dy] : [0, 0];
    const x = Math.min(...bs.map((b) => b.x)) + d[0], y = Math.min(...bs.map((b) => b.y)) + d[1];
    return { x: x - 4, y: y - 4, w: Math.max(...bs.map((b) => b.x + b.w)) + d[0] - x + 8, h: Math.max(...bs.map((b) => b.y + b.h)) + d[1] - y + 8 };
  })();
  const empty = !items.length && !strokes.length;
  const showInkColors = tool === 'pen' || (selStrokes.length > 0 && !selItems.length);
  const showHl = tool === 'marker';
  const showCardColors = !showInkColors && !showHl && selItems.some((i) => i.kind !== 'image');

  return html`<div class="cv" ref=${root} tabIndex="0" style=${`cursor:${cursor}`}
      onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}
      onDblClick=${onDblClick} onKeyDown=${onKeyDown} onKeyUp=${onKeyUp} onPaste=${onPaste}
      onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop=${onDrop}
      onContextMenu=${(e) => { if (!e.target.closest('[data-item]')) e.preventDefault(); }}>
    <div class="cv-grid" style=${`background-size:${24 * v.z}px ${24 * v.z}px;background-position:${v.x}px ${v.y}px`}></div>
    <div class="cv-world" style=${`transform:translate(${v.x}px,${v.y}px) scale(${v.z})`}>
      ${frames.map(renderItem)}
      <svg class="cv-svg cv-edges" width="1" height="1">
        <defs><marker id=${'ah-' + note.id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--fg-2)" /></marker></defs>
        ${edges.map((ed) => {
          const a = byId.get(ed.from), b = byId.get(ed.to);
          if (!a || !b) return null;
          const p = edgePath(rectFor(a), rectFor(b));
          return html`<g key=${ed.id} data-edge=${ed.id} class=${cls('cv-edge', sel.has(ed.id) && 'sel')}><path class="hit" d=${p.d} /><path class="line" d=${p.d} marker-end=${`url(#ah-${note.id})`} /></g>`;
        })}
        ${linkDraft && byId.get(linkDraft.from) && html`<path class="cv-edge-draft" d=${edgePath(rectFor(byId.get(linkDraft.from)), { x: linkDraft.x, y: linkDraft.y, w: 1, h: 1 }).d} />`}
      </svg>
      ${cards.map(renderItem)}
      <svg class="cv-svg cv-ink" width="1" height="1">
        ${strokes.map((s) => {
          if (drag?.hidden?.has(s.id)) return null;
          const d = dragFor(s.id);
          return html`<path key=${s.id} d=${strokePath(s)} fill=${colorCss(s.color)} opacity=${s.tool === 'marker' ? 0.4 : 1} class=${s.tool === 'marker' ? 'mk' : ''} transform=${d ? `translate(${d[0]} ${d[1]})` : undefined} />`;
        })}
        <path ref=${live} />
        ${selBox && html`<rect class="cv-selbox" x=${selBox.x} y=${selBox.y} width=${selBox.w} height=${selBox.h} rx="4" />`}
        ${marquee && html`<rect class=${marquee.frame ? 'cv-frame-draft' : 'cv-marquee'} x=${marquee.x} y=${marquee.y} width=${marquee.w} height=${marquee.h} />`}
      </svg>
    </div>

    ${empty && html`<div class="cv-empty">
      <p class="cv-empty-title">An empty canvas</p>
      <p>Double-click to add a card · drag notes in from the sidebar · press <kbd>P</kbd> to draw</p>
    </div>`}

    <div class="dock cv-ui" onPointerDown=${(e) => e.stopPropagation()}>
      ${TOOLS.map(([id, icon, label, key]) => html`<button class=${cls('dock-btn', tool === id && 'on')} title=${`${label} (${key})`} aria-label=${label} aria-pressed=${tool === id} onClick=${() => { if (id === 'note') { const r = root.current.getBoundingClientRect(); const [x, y] = toWorld(r.left + r.width / 2, r.top + r.height / 2); addNoteCard(x, y); } else setTool(id); }}><${Icon} name=${icon} size=${19} /></button>`)}
      <button class="dock-btn" title="Add image" aria-label="Add image" onClick=${async () => { const f = await pickFiles('image/*'); const r = root.current.getBoundingClientRect(); const [x, y] = toWorld(r.left + r.width / 2, r.top + r.height / 2); addImages(f, x - 150, y - 100); }}><${Icon} name="image" size=${19} /></button>
      ${(showInkColors || showHl || showCardColors) && html`<span class="dock-sep"></span>`}
      ${showInkColors && INK_COLORS.map((c) => html`<button class=${cls('swatch', (selStrokes.length && !selItems.length ? selStrokes[0].color : penColor) === c.id && 'on')} style=${`--c:${c.css}`} title=${c.label} aria-label=${c.label} onClick=${() => { setPenColor(c.id); if (selStrokes.length) setInkColorSel(c.id); }}></button>`)}
      ${tool === 'pen' && html`<span class="dock-sep"></span>${[2, 3, 6].map((s) => html`<button class=${cls('size-btn', penSize === s && 'on')} title=${`Size ${s}`} onClick=${() => setPenSize(s)}><span style=${`width:${s + 3}px;height:${s + 3}px`}></span></button>`)}`}
      ${showHl && HL_COLORS.map((c) => html`<button class=${cls('swatch', hlColor === c.id && 'on')} style=${`--c:${c.id}`} title=${c.label} aria-label=${c.label} onClick=${() => setHlColor(c.id)}></button>`)}
      ${showCardColors && CARD_COLORS.map((c) => html`<button class=${cls('swatch card-swatch', 'c-' + c, selItems[0]?.color === c && 'on')} title=${c} aria-label=${'Color ' + c} onClick=${() => setColorSel(c)}></button>`)}
      <span class="dock-sep"></span>
      <button class="dock-btn" title=${`Undo (${MOD}Z)`} aria-label="Undo" disabled=${!hist.current.undo.length} onClick=${undo}><${Icon} name="undo" size=${18} /></button>
      <button class="dock-btn" title=${`Redo (${MOD}${SHIFT}Z)`} aria-label="Redo" disabled=${!hist.current.redo.length} onClick=${redo}><${Icon} name="redo" size=${18} /></button>
    </div>
    <div class="zoombar cv-ui" onPointerDown=${(e) => e.stopPropagation()}>
      <button class="icon-btn" title="Zoom out" aria-label="Zoom out" onClick=${() => zoomCenter(1 / 1.2)}><${Icon} name="minus" size=${16} /></button>
      <button class="zoom-pct" title="Reset to 100%" onClick=${() => { const r = root.current.getBoundingClientRect(); zoomAt(1 / v.z, r.left + r.width / 2, r.top + r.height / 2); }}>${Math.round(v.z * 100)}%</button>
      <button class="icon-btn" title="Zoom in" aria-label="Zoom in" onClick=${() => zoomCenter(1.2)}><${Icon} name="plus" size=${16} /></button>
      <button class="icon-btn" title=${`Zoom to fit (${SHIFT}1)`} aria-label="Zoom to fit" onClick=${() => zoomToFit()}><${Icon} name="fit" size=${16} /></button>
    </div>
  </div>`;
}
