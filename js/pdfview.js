// PDF reader + annotator: text highlights/underlines with comments, pen and highlighter ink,
// typed text boxes, eraser, outline, find, and a companion notes page.
import { html, useState, useRef, useEffect, useLayoutEffect, useMemo, loadPdfjs } from './lib.js';
import { S, updateNote, getPdfDoc, open, createNote, flushAll, toast, flushers, emit } from './store.js';
import { strokePath, livePath, hitStroke, strokeBounds, round1, pointFromEvent, colorCss, INK_COLORS, HL_COLORS } from './ink.js';
import { Icon } from './icons.js';
import { uid, cls, clamp, mod, debounce, isTyping, escapeHtml, snippet, highlightTerms, MOD, SHIFT } from './util.js';

const GAP = 18;
const TOOLS = [['select', 'pointer', 'Select text & annotations', 'V'], ['hand', 'hand', 'Pan', 'H'], ['pen', 'pen', 'Pen', 'P'], ['marker', 'marker', 'Highlighter', 'M'], ['eraser', 'eraser', 'Eraser', 'E'], ['text', 'text', 'Text box', 'T']];
const KEYMAP = { v: 'select', h: 'hand', p: 'pen', m: 'marker', e: 'eraser', t: 'text' };

function mergeRects(rects) {
  rects = rects.filter((r) => r[2] > 0.5 && r[3] > 0.5).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[1] - r[1]) < Math.min(l[3], r[3]) * 0.6 && r[0] <= l[0] + l[2] + 3) {
      const x0 = Math.min(l[0], r[0]), y0 = Math.min(l[1], r[1]), x1 = Math.max(l[0] + l[2], r[0] + r[2]), y1 = Math.max(l[1] + l[3], r[1] + r[3]);
      out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
    } else out.push([...r]);
  }
  return out.map((r) => r.map(round1));
}
export function annBounds(a) {
  if (a.kind === 'ink') return strokeBounds(a);
  if (a.kind === 'text') return { x: a.x, y: a.y, w: a.w, h: (a.size || 14) * 1.4 * Math.max(1, (a.text || '').split('\n').length) };
  const xs = a.rects.map((r) => r[0]), ys = a.rects.map((r) => r[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...a.rects.map((r) => r[0] + r[2])) - x, h: Math.max(...a.rects.map((r) => r[1] + r[3])) - y };
}

function PdfPage({ doc, n, size, z, visible, anns, selId, findQ, editingId, setEditingId, commitAnn, removeAnn }) {
  const canvas = useRef();
  const textRef = useRef();
  const task = useRef();
  useEffect(() => {
    if (!visible || !doc) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const vp = page.getViewport({ scale: z * dpr });
        const c = canvas.current;
        const off = document.createElement('canvas');
        off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
        task.current?.cancel();
        task.current = page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp });
        await task.current.promise;
        if (cancelled || !c) return;
        c.width = off.width; c.height = off.height;
        c.getContext('2d').drawImage(off, 0, 0);
        const pdfjs = await loadPdfjs();
        const tl = textRef.current;
        if (!tl || cancelled) return;
        tl.innerHTML = '';
        const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: page.getViewport({ scale: z }) });
        await layer.render();
        if (findQ && findQ.length > 1) {
          const q = findQ.toLowerCase();
          tl.querySelectorAll('span').forEach((s) => { if (s.textContent.toLowerCase().includes(q)) s.classList.add('find-hit'); });
        }
      } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); }
    }, 60);
    return () => { cancelled = true; clearTimeout(t); task.current?.cancel(); };
  }, [visible, doc, z, findQ]);
  useEffect(() => { if (!visible && canvas.current) { canvas.current.width = 0; canvas.current.height = 0; if (textRef.current) textRef.current.innerHTML = ''; } }, [visible]);

  const w = size.w * z, h = size.h * z;
  const hls = anns.filter((a) => a.kind === 'hl'), inks = anns.filter((a) => a.kind === 'ink'), texts = anns.filter((a) => a.kind === 'text');
  const sel = anns.find((a) => a.id === selId);
  const sb = sel && sel.kind !== 'text' ? annBounds(sel) : null;
  return html`<div class="pdf-page" data-page=${n} style=${`width:${w}px;height:${h}px;--scale-factor:${z}`}>
    <canvas ref=${canvas} class="pdf-canvas"></canvas>
    <svg class="pdf-ann" viewBox=${`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none">
      ${hls.map((a) => html`<g key=${a.id} class=${cls('pdf-hl', a.style || 'highlight', a.comment && 'has-comment')}>
        ${a.rects.map((r) => (a.style === 'underline'
          ? html`<rect x=${r[0]} y=${r[1] + r[3] - 1.4} width=${r[2]} height="1.6" fill=${a.color} />`
          : a.style === 'strike' ? html`<rect x=${r[0]} y=${r[1] + r[3] * 0.5 - 0.7} width=${r[2]} height="1.4" fill=${a.color} />`
          : html`<rect x=${r[0]} y=${r[1]} width=${r[2]} height=${r[3]} fill=${a.color} />`))}
        ${a.comment && html`<circle cx=${a.rects[0][0] - 6} cy=${a.rects[0][1] + 4} r="3.2" fill=${a.color} stroke="#0003" stroke-width=".6" />`}
      </g>`)}
      ${inks.map((a) => html`<path key=${a.id} d=${strokePath(a)} fill=${a.color === 'ink' ? '#1d2320' : a.color} opacity=${a.tool === 'marker' ? 0.4 : 1} class=${a.tool === 'marker' ? 'mk' : ''} />`)}
      <path class="pdf-live" />
      ${sb && html`<rect class="pdf-selbox" x=${sb.x - 3} y=${sb.y - 3} width=${sb.w + 6} height=${sb.h + 6} rx="2" />`}
    </svg>
    <div class="textLayer" ref=${textRef}></div>
    <div class="pdf-texts">
      ${texts.map((a) => editingId === a.id
        ? html`<textarea key=${a.id} class="pdf-textbox editing" id=${'tb-' + a.id} style=${`left:${a.x * z}px;top:${a.y * z}px;width:${a.w * z}px;font-size:${(a.size || 14) * z}px;color:${a.color === 'ink' ? '#1d2320' : a.color}`}
            defaultValue=${a.text}
            onPointerDown=${(e) => e.stopPropagation()}
            onInput=${(e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
            onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && mod(e))) e.target.blur(); }}
            onBlur=${(e) => { setEditingId(null); const t = e.target.value; if (!t.trim()) removeAnn(a.id); else if (t !== a.text) commitAnn(a.id, { text: t }); }}></textarea>`
        : html`<div key=${a.id} data-ann=${a.id} class=${cls('pdf-textbox', selId === a.id && 'sel')} style=${`left:${a.x * z}px;top:${a.y * z}px;width:${a.w * z}px;font-size:${(a.size || 14) * z}px;color:${a.color === 'ink' ? '#1d2320' : a.color}`}>${a.text}</div>`)}
    </div>
    <div class="pdf-pageno">${n}</div>
  </div>`;
}

export function PdfView({ note }) {
  const c = note.content;
  const ann = c.ann || [];
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [sizes, setSizes] = useState(null);
  const [zoom, setZoomState] = useState(note.view?.zoom || 'fit');
  const [cw, setCw] = useState(0);
  const [tool, setTool] = useState('select');
  const [penColor, setPenColor] = useState('#d6453d');
  const [hlColor, setHlColor] = useState('#ffd84d');
  const [penSize, setPenSize] = useState(1.6);
  const [side, setSide] = useState(note.view?.side ?? (innerWidth > 1100 ? 'ann' : null));
  const [selId, setSelId] = useState(null);
  const [textSel, setTextSel] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [cur, setCur] = useState(note.view?.page || 1);
  const [vis, setVis] = useState(() => new Set([1]));
  const [findQ, setFindQ] = useState('');
  const [outline, setOutline] = useState(null);
  const [, force] = useState(0);
  const scroller = useRef();
  const g = useRef(null);
  const hist = useRef({ undo: [], redo: [] });
  const annRef = useRef(ann);
  annRef.current = ann;
  const restored = useRef(false);

  const saveView = useMemo(() => debounce((v) => updateNote(note.id, { view: { ...(S.notes.get(note.id)?.view || {}), ...v } }), 500), [note.id]);
  useEffect(() => { flushers.add(saveView.flush); return () => { saveView.flush(); flushers.delete(saveView.flush); }; }, [saveView]);

  useEffect(() => {
    let alive = true;
    setErr(null);
    (async () => {
      try {
        const d = await getPdfDoc(c.fileId);
        const sz = await Promise.all(Array.from({ length: d.numPages }, (_, i) => d.getPage(i + 1).then((p) => { const vp = p.getViewport({ scale: 1 }); return { w: vp.width, h: vp.height }; })));
        if (!alive) return;
        setDoc(d); setSizes(sz);
        if (c.pages !== d.numPages) updateNote(note.id, { content: { ...c, pages: d.numPages } });
      } catch (e) { if (alive) setErr(e.message || String(e)); }
    })();
    return () => { alive = false; };
  }, [c.fileId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, [!!sizes]);

  const maxW = sizes ? Math.max(...sizes.map((s) => s.w)) : 612;
  const z = clamp(zoom === 'fit' ? (cw - 56) / maxW : zoom, 0.25, 5);
  const tops = useMemo(() => {
    if (!sizes) return [];
    let y = GAP; const t = [];
    for (const s of sizes) { t.push(y); y += s.h * z + GAP; }
    t.push(y);
    return t;
  }, [sizes, z]);

  const goPage = (n, smooth = false, yOff = 0) => {
    const el = scroller.current;
    if (!el || !tops.length) return;
    n = clamp(n, 1, sizes.length);
    el.scrollTo({ top: tops[n - 1] - 8 + yOff * z, behavior: smooth ? 'smooth' : 'auto' });
  };

  // Restore last position, or honour a jump request (search result, citation link).
  useEffect(() => {
    if (!sizes || !cw) return;
    const j = S.jump[note.id];
    if (j?.page && Date.now() - j.ts < 5000) { delete S.jump[note.id]; requestAnimationFrame(() => goPage(j.page)); restored.current = true; return; }
    if (!restored.current) { restored.current = true; requestAnimationFrame(() => goPage(note.view?.page || 1)); }
  }, [sizes, cw, S.jump[note.id]]);

  const setZoom = (zz) => {
    const el = scroller.current;
    const anchorPage = cur;
    const off = el ? (el.scrollTop - (tops[anchorPage - 1] || 0)) / z : 0;
    setZoomState(zz);
    saveView({ zoom: zz });
    requestAnimationFrame(() => {
      const nz = clamp(zz === 'fit' ? (cw - 56) / maxW : zz, 0.25, 5);
      let y = GAP; for (let i = 0; i < anchorPage - 1; i++) y += sizes[i].h * nz + GAP;
      if (el) el.scrollTop = y + off * nz;
    });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !tops.length) return;
    const top = el.scrollTop, bottom = top + el.clientHeight;
    const mid = top + el.clientHeight * 0.35;
    let p = 1;
    for (let i = 0; i < sizes.length; i++) if (tops[i] <= mid) p = i + 1;
    if (p !== cur) { setCur(p); saveView({ page: p }); }
    const v = new Set();
    for (let i = 0; i < sizes.length; i++) if (tops[i + 1] > top - 1200 && tops[i] < bottom + 1200) v.add(i + 1);
    if ([...v].join() !== [...vis].join()) setVis(v);
    if (textSel) setTextSel(null);
  };
  useEffect(onScroll, [tops]);

  // ctrl/⌘ + wheel zoom
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setZoom(clamp(z * Math.exp(-e.deltaY * 0.004), 0.25, 5)); };
    el.addEventListener('wheel', wheel, { passive: false });
    // Apple Pencil: stop Safari from scrolling when the stylus touches the page.
    const ts = (e) => { const t = e.touches[0]; if (t && t.touchType === 'stylus' && S.settings.penOnly) e.preventDefault(); };
    el.addEventListener('touchstart', ts, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('touchstart', ts); };
  });

  /* ---- annotation mutations ---- */
  const commit = (next, record = true) => {
    if (record) { hist.current.undo.push(annRef.current); if (hist.current.undo.length > 100) hist.current.undo.shift(); hist.current.redo = []; }
    annRef.current = next;
    updateNote(note.id, { content: { ...S.notes.get(note.id).content, ann: next } });
  };
  const addAnn = (a) => { const x = { id: uid('a'), created: Date.now(), ...a }; commit([...annRef.current, x]); return x; };
  const commitAnn = (id, patch) => commit(annRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const removeAnn = (id) => { commit(annRef.current.filter((a) => a.id !== id)); if (selId === id) setSelId(null); };
  const undo = () => { const h = hist.current; if (!h.undo.length) return; h.redo.push(annRef.current); const p = h.undo.pop(); annRef.current = p; updateNote(note.id, { content: { ...c, ann: p } }); setSelId(null); };
  const redo = () => { const h = hist.current; if (!h.redo.length) return; h.undo.push(annRef.current); const p = h.redo.pop(); annRef.current = p; updateNote(note.id, { content: { ...c, ann: p } }); };

  /* ---- pointer input ---- */
  const pageOf = (e) => e.target.closest?.('.pdf-page');
  const toPage = (e, el) => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) / z, (e.clientY - r.top) / z]; };
  const effTool = (e) => {
    if (e.pointerType === 'pen' && (e.buttons & 32)) return 'eraser';
    if (e.pointerType === 'pen' && S.settings.penOnly && (tool === 'select' || tool === 'hand')) return 'pen';
    return tool;
  };
  const onPointerMoveHover = (e) => {
    // A hovering pen switches the page to non-scrolling so strokes don't pan the document.
    if (e.pointerType === 'pen' && scroller.current) scroller.current.style.touchAction = 'none';
  };
  const onPointerDown = (e) => {
    if (e.target.closest('.pdf-ui') || e.target.closest('textarea')) return;
    scroller.current.focus({ preventScroll: true });
    if (e.pointerType === 'touch') scroller.current.style.touchAction = '';
    const t = effTool(e);
    const pg = pageOf(e);
    if (t === 'hand' && e.pointerType !== 'touch') {
      e.preventDefault();
      g.current = { kind: 'pan', sy: e.clientY, sx: e.clientX, top: scroller.current.scrollTop, left: scroller.current.scrollLeft };
      scroller.current.setPointerCapture(e.pointerId);
      return;
    }
    if (t === 'select' || t === 'hand') {
      const tb = e.target.closest('[data-ann]');
      if (tb) { e.preventDefault(); const id = tb.dataset.ann; const a = annRef.current.find((x) => x.id === id); setSelId(id); setTextSel(null); g.current = { kind: 'movetext', id, sx: e.clientX, sy: e.clientY, x0: a.x, y0: a.y, moved: false }; scroller.current.setPointerCapture(e.pointerId); }
      return;
    }
    if (!pg) return;
    if (e.pointerType === 'touch' && S.settings.penOnly) { g.current = { kind: 'touchscroll', sy: e.clientY, top: scroller.current.scrollTop }; return; }
    e.preventDefault();
    getSelection().removeAllRanges();
    setTextSel(null); setSelId(null);
    scroller.current.setPointerCapture(e.pointerId);
    const n = +pg.dataset.page;
    const [x, y] = toPage(e, pg);
    if (t === 'pen' || t === 'marker') {
      const marker = t === 'marker';
      const live = pg.querySelector('.pdf-live');
      live.setAttribute('fill', marker ? hlColor : penColor === 'ink' ? '#1d2320' : penColor);
      live.setAttribute('opacity', marker ? '0.4' : '1');
      g.current = { kind: 'draw', pg, live, stroke: { kind: 'ink', page: n, tool: t, color: marker ? hlColor : penColor, size: marker ? 12 : penSize, sim: e.pointerType !== 'pen', points: [[round1(x), round1(y), e.pressure || 0.5]] } };
    } else if (t === 'eraser') { g.current = { kind: 'erase', pg, n, removed: new Set() }; eraseAt(n, x, y); }
    else if (t === 'text') {
      const a = addAnn({ kind: 'text', page: n, x: round1(x), y: round1(y - 8), w: 220, size: 13, color: penColor === 'ink' ? 'ink' : penColor, text: '' });
      setEditingId(a.id); setSelId(a.id); setTool('select');
      g.current = null;
    }
  };
  const eraseAt = (n, x, y) => {
    const G = g.current;
    const hit = annRef.current.filter((a) => a.page === n && !G.removed.has(a.id) && (a.kind === 'ink' ? hitStroke(a, x, y, 5) : a.kind === 'hl' ? a.rects.some((r) => x >= r[0] - 2 && x <= r[0] + r[2] + 2 && y >= r[1] - 2 && y <= r[1] + r[3] + 2) : false));
    if (hit.length) { hit.forEach((a) => G.removed.add(a.id)); commit(annRef.current.filter((a) => !G.removed.has(a.id)), G.removed.size === hit.length); }
  };
  const onPointerMove = (e) => {
    onPointerMoveHover(e);
    const G = g.current;
    if (!G) return;
    if (G.kind === 'pan') { scroller.current.scrollTop = G.top - (e.clientY - G.sy); scroller.current.scrollLeft = G.left - (e.clientX - G.sx); return; }
    if (G.kind === 'touchscroll') { scroller.current.scrollTop = G.top - (e.clientY - G.sy); return; }
    if (G.kind === 'movetext') {
      const dx = (e.clientX - G.sx) / z, dy = (e.clientY - G.sy) / z;
      if (!G.moved && Math.hypot(dx, dy) * z < 4) return;
      G.moved = true;
      const el = scroller.current.querySelector(`[data-ann="${G.id}"]`);
      if (el) el.style.transform = `translate(${dx * z}px,${dy * z}px)`;
      G.dx = dx; G.dy = dy;
      return;
    }
    if (G.kind === 'draw') {
      for (const ev of pointFromEvent(e)) { const [x, y] = toPage(ev, G.pg); G.stroke.points.push([round1(x), round1(y), ev.pressure || 0.5]); }
      G.live.setAttribute('d', livePath(G.stroke));
      return;
    }
    if (G.kind === 'erase') { const [x, y] = toPage(e, G.pg); eraseAt(G.n, x, y); }
  };
  const onPointerUp = (e) => {
    const G = g.current;
    g.current = null;
    if (G?.kind === 'draw') { G.live.setAttribute('d', ''); addAnn(G.stroke); return; }
    if (G?.kind === 'movetext') {
      const el = scroller.current.querySelector(`[data-ann="${G.id}"]`);
      if (el) el.style.transform = '';
      if (G.moved) commitAnn(G.id, { x: round1(G.x0 + G.dx), y: round1(G.y0 + G.dy) });
      else setEditingId(G.id);
      return;
    }
    if (G) return;
    if (tool !== 'select' || e.pointerType === 'pen' && S.settings.penOnly) return;
    // Text selection → highlight popover; plain click → pick an annotation.
    setTimeout(() => {
      const s = getSelection();
      if (s.rangeCount && !s.isCollapsed && scroller.current.contains(s.anchorNode)) {
        const range = s.getRangeAt(0);
        const byPage = new Map();
        for (const r of range.getClientRects()) {
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.pdf-page') || [...scroller.current.querySelectorAll('.pdf-page')].find((p) => { const b = p.getBoundingClientRect(); return r.top + r.height / 2 >= b.top && r.top + r.height / 2 <= b.bottom; });
          if (!el) continue;
          const b = el.getBoundingClientRect();
          const n = +el.dataset.page;
          if (!byPage.has(n)) byPage.set(n, []);
          byPage.get(n).push([(r.left - b.left) / z, (r.top - b.top) / z, r.width / z, r.height / z]);
        }
        const pages = [...byPage.entries()].map(([n, rs]) => ({ page: n, rects: mergeRects(rs) })).filter((p) => p.rects.length);
        if (!pages.length) return;
        const last = range.getBoundingClientRect();
        setSelId(null);
        setTextSel({ pages, text: s.toString().replace(/\s+/g, ' ').trim(), x: last.left + last.width / 2, y: last.bottom });
        return;
      }
      setTextSel(null);
      const pg = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pdf-page');
      if (!pg) { setSelId(null); return; }
      const n = +pg.dataset.page;
      const [x, y] = toPage(e, pg);
      const hit = [...annRef.current].reverse().find((a) => a.page === n && (a.kind === 'hl' ? a.rects.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] - 1 && y <= r[1] + r[3] + 1) : a.kind === 'ink' ? hitStroke(a, x, y, 4) : false));
      setSelId(hit?.id || null);
    }, 0);
  };

  const makeHighlight = (style, color = hlColor, select = true) => {
    if (!textSel) return;
    let created = null;
    const next = [...annRef.current];
    for (const p of textSel.pages) { created = { id: uid('a'), created: Date.now(), kind: 'hl', style, page: p.page, rects: p.rects, color, text: textSel.text, comment: '' }; next.push(created); }
    commit(next);
    getSelection().removeAllRanges();
    setTextSel(null);
    if (created && select) setSelId(created.id);
    return created;
  };

  /* ---- companion note ---- */
  const companion = () => {
    const ex = c.companionId && S.notes.get(c.companionId);
    if (ex && !ex.trashed) return ex;
    const n = createNote({ title: `${note.title} — notes`, notebookId: note.notebookId, tags: [...(note.tags || [])], content: { html: `<p>Notes on <a class="wikilink" data-note-id="${note.id}" href="#${note.id}">${escapeHtml(note.title)}</a></p><p><br></p>` }, silent: true });
    updateNote(note.id, { content: { ...S.notes.get(note.id).content, companionId: n.id } });
    return n;
  };
  const openCompanion = () => { const n = companion(); open(n.id, { split: true }); };
  const quoteToNotes = (a) => {
    flushAll();
    const n = companion();
    const cite = `<a class="wikilink" data-note-id="${note.id}" data-page="${a.page}" href="#${note.id}">${escapeHtml(note.title)}, p. ${a.page}</a>`;
    const block = `<blockquote><p>${escapeHtml(a.text || '')}</p></blockquote><p>${cite}${a.comment ? ' — ' + escapeHtml(a.comment) : ''}</p><p><br></p>`;
    const htmlNow = (n.content.html || '').replace(/(<p><br><\/p>)+$/, '');
    updateNote(n.id, { content: { html: htmlNow + block } }, { external: true });
    const shown = S.ws.panes.some((p) => p.tabs[p.active].cur === n.id);
    if (!shown) open(n.id, { split: true });
    toast(`Added quote to “${n.title}”`);
  };

  /* ---- keys ---- */
  const onKeyDown = (e) => {
    if (isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (mod(e) && k === 'z') { e.preventDefault(); e.stopPropagation(); e.shiftKey ? redo() : undo(); return; }
    if (mod(e) && k === 'f') { e.preventDefault(); setSide('find'); setTimeout(() => document.getElementById('pdf-find-' + note.id)?.focus(), 30); return; }
    if (mod(e) && (k === '=' || k === '+')) { e.preventDefault(); setZoom(z * 1.15); return; }
    if (mod(e) && k === '-') { e.preventDefault(); setZoom(z / 1.15); return; }
    if (mod(e) && k === '0') { e.preventDefault(); setZoom('fit'); return; }
    if (mod(e) || e.altKey) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selId) { e.preventDefault(); removeAnn(selId); return; }
    if (e.key === 'Escape') { setSelId(null); setTextSel(null); setTool('select'); return; }
    if (textSel && /^[1-5]$/.test(e.key)) { makeHighlight('highlight', HL_COLORS[+e.key - 1].id); return; }
    if (KEYMAP[k] && !e.repeat) { e.preventDefault(); setTool(KEYMAP[k]); return; }
    if (e.key === 'ArrowRight' && tool !== 'select') { goPage(cur + 1); }
    if (e.key === 'ArrowLeft' && tool !== 'select') { goPage(cur - 1); }
  };

  useEffect(() => {
    if (side !== 'outline' || outline || !doc) return;
    (async () => {
      try {
        const ol = await doc.getOutline();
        const resolve = async (items, depth) => {
          const out = [];
          for (const it of items || []) {
            let page = null;
            try { const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest; if (dest) page = (await doc.getPageIndex(dest[0])) + 1; } catch {}
            out.push({ title: it.title, page, depth });
            out.push(...(await resolve(it.items, depth + 1)));
          }
          return out;
        };
        setOutline(await resolve(ol, 0));
      } catch { setOutline([]); }
    })();
  }, [side, doc]);

  useEffect(() => {
    if (!editingId) return;
    const t = setTimeout(() => { const el = document.getElementById('tb-' + editingId); if (el) { el.focus({ preventScroll: true }); el.style.height = el.scrollHeight + 'px'; } }, 0);
    return () => clearTimeout(t);
  }, [editingId]);
  const setSideP = (s) => { setSide(s); saveView({ side: s }); };

  const selAnn = ann.find((a) => a.id === selId);
  const selRect = (() => {
    if (!selAnn || !scroller.current) return null;
    const pg = scroller.current.querySelector(`.pdf-page[data-page="${selAnn.page}"]`);
    if (!pg) return null;
    const r = pg.getBoundingClientRect(), b = annBounds(selAnn);
    return { x: r.left + (b.x + b.w / 2) * z, y: r.top + (b.y + b.h) * z, top: r.top + b.y * z };
  })();
  const pageAnn = (n) => ann.filter((a) => a.page === n);
  const findHits = useMemo(() => {
    const q = findQ.trim().toLowerCase();
    if (q.length < 2) return [];
    const pages = S.pdfText.get(note.id) || [];
    const out = [];
    pages.forEach((t, i) => { const l = t.toLowerCase(); let at = l.indexOf(q), c = 0; while (at >= 0 && c < 50) { c++; at = l.indexOf(q, at + q.length); } if (c) out.push({ page: i + 1, count: c, snip: snippet(t, [q], 120) }); });
    return out;
  }, [findQ, note.id, S.pdfText.get(note.id)]);

  if (err) return html`<div class="empty-state"><${Icon} name="pdf" size=${32} /><h3>This PDF couldn't be opened</h3><p>${err}</p></div>`;

  return html`<div class="pdf-wrap" onKeyDown=${onKeyDown}>
    <div class="pdf-toolbar pdf-ui">
      <button class=${cls('icon-btn', side && 'on')} title="Annotations, outline and find" aria-label="Toggle PDF sidebar" onClick=${() => setSideP(side ? null : 'ann')}><${Icon} name="sidebar" /></button>
      <div class="pageno">
        <input id=${'pg-' + note.id} class="page-input" value=${cur} aria-label="Page number" onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') { goPage(parseInt(e.target.value) || 1); e.target.blur(); } }} onFocus=${(e) => e.target.select()} />
        <span>of ${sizes?.length || c.pages || '…'}</span>
      </div>
      <span class="tb-sep"></span>
      <button class="icon-btn" title="Zoom out" aria-label="Zoom out" onClick=${() => setZoom(z / 1.15)}><${Icon} name="zoomOut" /></button>
      <button class="zoom-pct" title="Fit width" onClick=${() => setZoom('fit')}>${zoom === 'fit' ? 'Fit' : Math.round(z * 100) + '%'}</button>
      <button class="icon-btn" title="Zoom in" aria-label="Zoom in" onClick=${() => setZoom(z * 1.15)}><${Icon} name="zoomIn" /></button>
      <span class="spacer"></span>
      <span class="pdf-progress" title="Reading progress">${sizes ? Math.round((cur / sizes.length) * 100) : 0}%</span>
      <button class="btn small" onClick=${openCompanion} title="Open the notes page for this PDF side by side"><${Icon} name="page" size=${16} />Notes</button>
    </div>
    <div class="pdf-body">
      ${side && html`<aside class="pdf-side pdf-ui">
        <div class="seg">
          ${[['ann', 'Annotations'], ['outline', 'Outline'], ['find', 'Find']].map(([k, l]) => html`<button class=${cls(side === k && 'on')} onClick=${() => setSideP(k)}>${l}${k === 'ann' && ann.length ? html`<span class="count">${ann.length}</span>` : ''}</button>`)}
        </div>
        ${side === 'ann' && html`<div class="side-list">
          ${!ann.length && html`<p class="side-empty">Select text to highlight it, or pick the pen to write on the page. Everything you mark shows up here.</p>`}
          ${[...new Set(ann.map((a) => a.page))].sort((a, b) => a - b).map((p) => html`<div class="side-group">
            <div class="side-page">Page ${p}</div>
            ${pageAnn(p).map((a) => html`<button class=${cls('ann-row', selId === a.id && 'on')} onClick=${() => { const b = annBounds(a); goPage(a.page, true, Math.max(0, b.y - 60)); setSelId(a.id); }}>
              <span class="ann-chip" style=${`background:${a.color === 'ink' ? 'var(--fg)' : a.color}`}></span>
              <span class="ann-body">
                ${a.kind === 'hl' ? html`<span class="ann-quote">${a.text || 'Highlight'}</span>` : a.kind === 'text' ? html`<span>${a.text || 'Text box'}</span>` : html`<span class="muted">${a.tool === 'marker' ? 'Highlighter stroke' : 'Handwriting'}</span>`}
                ${a.comment && html`<span class="ann-comment">${a.comment}</span>`}
              </span>
            </button>`)}
          </div>`)}
        </div>`}
        ${side === 'outline' && html`<div class="side-list">
          ${outline === null ? html`<p class="side-empty">Reading outline…</p>` : !outline.length ? html`<p class="side-empty">This PDF has no outline. Use Find or the page number box to move around.</p>`
            : outline.map((o) => html`<button class="outline-row" style=${`padding-left:${10 + o.depth * 14}px`} disabled=${!o.page} onClick=${() => goPage(o.page, true)}><span>${o.title}</span>${o.page && html`<span class="muted">${o.page}</span>`}</button>`)}
        </div>`}
        ${side === 'find' && html`<div class="side-list">
          <input id=${'pdf-find-' + note.id} class="input" placeholder="Find in this PDF" value=${findQ} onInput=${(e) => setFindQ(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && findHits[0]) goPage(findHits.find((h) => h.page > cur)?.page || findHits[0].page, true); }} />
          ${findQ.trim().length > 1 && html`<p class="side-empty">${findHits.length ? `${findHits.reduce((s, h) => s + h.count, 0)} matches on ${findHits.length} pages` : S.pdfText.has(note.id) ? 'No matches' : 'Still indexing this PDF…'}</p>`}
          ${findHits.map((h) => html`<button class=${cls('find-row', h.page === cur && 'on')} onClick=${() => goPage(h.page, true)}><span class="side-page">Page ${h.page}</span><span class="find-snip" dangerouslySetInnerHTML=${{ __html: highlightTerms(h.snip, [findQ.trim()]) }}></span></button>`)}
        </div>`}
      </aside>`}
      <div class=${cls('pdf-scroll scroll', 'tool-' + tool)} ref=${scroller} tabIndex="0" onScroll=${onScroll}
        onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerUp}
        onPointerLeave=${(e) => { if (e.pointerType === 'pen' && !g.current) scroller.current.style.touchAction = ''; }}>
        ${!sizes ? html`<div class="pdf-loading">Opening PDF…</div>` : html`<div class="pdf-pages" style=${`height:${tops[tops.length - 1]}px;width:${maxW * z + 40}px`}>
          ${sizes.map((s, i) => html`<div class="pdf-slot" key=${i} style=${`top:${tops[i]}px;width:${s.w * z}px;height:${s.h * z}px`}>
            ${vis.has(i + 1) && html`<${PdfPage} doc=${doc} n=${i + 1} size=${s} z=${z} visible=${true} anns=${pageAnn(i + 1)} selId=${selId} findQ=${side === 'find' ? findQ.trim() : ''}
              editingId=${editingId} setEditingId=${setEditingId} commitAnn=${commitAnn} removeAnn=${removeAnn} />`}
          </div>`)}
        </div>`}
      </div>
    </div>

    <div class="dock pdf-ui" onPointerDown=${(e) => e.stopPropagation()}>
      ${TOOLS.map(([id, icon, label, key]) => html`<button class=${cls('dock-btn', tool === id && 'on')} title=${`${label} (${key})`} aria-label=${label} aria-pressed=${tool === id} onClick=${() => setTool(id)}><${Icon} name=${icon} size=${19} /></button>`)}
      <span class="dock-sep"></span>
      ${tool === 'marker' || tool === 'select'
        ? HL_COLORS.map((c) => html`<button class=${cls('swatch', hlColor === c.id && 'on')} style=${`--c:${c.id}`} title=${`${c.label} highlight`} aria-label=${c.label} onClick=${() => { setHlColor(c.id); if (selAnn?.kind === 'hl') commitAnn(selAnn.id, { color: c.id }); }}></button>`)
        : INK_COLORS.map((c) => html`<button class=${cls('swatch', penColor === c.id && 'on')} style=${`--c:${c.id === 'ink' ? '#1d2320' : c.css}`} title=${c.label} aria-label=${c.label} onClick=${() => setPenColor(c.id)}></button>`)}
      ${tool === 'pen' && html`<span class="dock-sep"></span>${[1, 1.6, 3].map((s) => html`<button class=${cls('size-btn', penSize === s && 'on')} title=${`Size ${s}`} onClick=${() => setPenSize(s)}><span style=${`width:${s * 2.4 + 2}px;height:${s * 2.4 + 2}px`}></span></button>`)}`}
      <span class="dock-sep"></span>
      <button class="dock-btn" title=${`Undo (${MOD}Z)`} aria-label="Undo" disabled=${!hist.current.undo.length} onClick=${undo}><${Icon} name="undo" size=${18} /></button>
      <button class="dock-btn" title=${`Redo (${MOD}${SHIFT}Z)`} aria-label="Redo" disabled=${!hist.current.redo.length} onClick=${redo}><${Icon} name="redo" size=${18} /></button>
    </div>

    ${textSel && html`<div class="popover hlbar pdf-ui" style=${`left:${clamp(textSel.x - 170, 8, innerWidth - 350)}px;top:${Math.min(textSel.y + 10, innerHeight - 60)}px`} onMouseDown=${(e) => e.preventDefault()}>
      ${HL_COLORS.map((c, i) => html`<button class="swatch" style=${`--c:${c.id}`} title=${`Highlight ${c.label} (${i + 1})`} aria-label=${`Highlight ${c.label}`} onClick=${() => makeHighlight('highlight', c.id)}></button>`)}
      <span class="sep"></span>
      <button class="fmt-btn" title="Underline" aria-label="Underline" onClick=${() => makeHighlight('underline', '#d6453d')}><${Icon} name="underline" size=${16} /></button>
      <button class="fmt-btn" title="Strike through" aria-label="Strike through" onClick=${() => makeHighlight('strike', '#d6453d')}><${Icon} name="strike" size=${16} /></button>
      <button class="fmt-btn" title="Copy text" aria-label="Copy text" onClick=${() => { navigator.clipboard?.writeText(textSel.text).then(() => toast('Copied'), () => {}); }}><${Icon} name="copy" size=${16} /></button>
      <button class="fmt-btn wide" title="Highlight and quote into this PDF's notes page" onClick=${() => { const a = makeHighlight('highlight', hlColor, false); if (a) quoteToNotes(a); }}><${Icon} name="quote" size=${16} /><span>To notes</span></button>
    </div>`}

    ${selAnn && selRect && !editingId && html`<${AnnPopover} a=${selAnn} rect=${selRect} commitAnn=${commitAnn} removeAnn=${removeAnn} quote=${quoteToNotes} close=${() => setSelId(null)} />`}
  </div>`;
}

function AnnPopover({ a, rect, commitAnn, removeAnn, quote, close }) {
  const [comment, setComment] = useState(a.comment || '');
  useEffect(() => setComment(a.comment || ''), [a.id]);
  const below = rect.y + 200 < innerHeight;
  return html`<div class="popover annpop pdf-ui" style=${`left:${clamp(rect.x - 160, 8, innerWidth - 330)}px;top:${below ? rect.y + 10 : Math.max(8, rect.top - 190)}px`} onPointerDown=${(e) => e.stopPropagation()}>
    <div class="annpop-row">
      ${(a.kind === 'hl' || (a.kind === 'ink' && a.tool === 'marker') ? HL_COLORS.map((c) => c.id) : INK_COLORS.map((c) => c.id)).map((col) => html`<button class=${cls('swatch', a.color === col && 'on')} style=${`--c:${col === 'ink' ? '#1d2320' : col}`} aria-label=${'Color ' + col} onClick=${() => commitAnn(a.id, { color: col })}></button>`)}
      <span class="spacer"></span>
      ${a.kind === 'hl' && html`<button class=${cls('fmt-btn', (a.style || 'highlight') === 'highlight' && 'on')} title="Highlight" onClick=${() => commitAnn(a.id, { style: 'highlight' })}><${Icon} name="highlight" size=${16} /></button>
        <button class=${cls('fmt-btn', a.style === 'underline' && 'on')} title="Underline" onClick=${() => commitAnn(a.id, { style: 'underline' })}><${Icon} name="underline" size=${16} /></button>`}
      ${a.kind === 'text' && [11, 13, 18].map((s) => html`<button class=${cls('fmt-btn', a.size === s && 'on')} title=${'Text size ' + s} onClick=${() => commitAnn(a.id, { size: s })}><span style=${`font-size:${s - 1}px;font-weight:600`}>A</span></button>`)}
      <button class="fmt-btn danger" title="Delete" aria-label="Delete annotation" onClick=${() => { removeAnn(a.id); close(); }}><${Icon} name="trash" size=${16} /></button>
    </div>
    ${a.kind === 'hl' && html`
      <textarea id=${'cm-' + a.id} class="input annpop-comment" placeholder="Add a comment…" rows="2" value=${comment}
        onInput=${(e) => setComment(e.target.value)} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitAnn(a.id, { comment: comment.trim() }); e.target.blur(); } }}
        onBlur=${() => comment.trim() !== (a.comment || '') && commitAnn(a.id, { comment: comment.trim() })}></textarea>
      <div class="annpop-row">
        <button class="btn small" onClick=${() => quote({ ...a, comment: comment.trim() })}><${Icon} name="quote" size=${15} />Quote to notes</button>
        <button class="btn small ghost" onClick=${() => navigator.clipboard?.writeText(a.text || '').then(() => toast('Copied'), () => {})}><${Icon} name="copy" size=${15} />Copy</button>
      </div>`}
  </div>`;
}
