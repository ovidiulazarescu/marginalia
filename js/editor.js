// Page-note editor: a contenteditable surface with Markdown shortcuts, a slash menu,
// [[wiki links]], a selection toolbar, checklists and inline sketch blocks.
import { html, useEffect, useRef, useState, useMemo, useLayoutEffect } from './lib.js';
import { S, updateNote, open, createNote, findByTitle, flushers, pickNote, toast, liveNotes } from './store.js';
import { hydrateInk, newInkBlockHTML } from './ink.js';
import { sanitizeHTML, mdToHTML, looksLikeMarkdown } from './md.js';
import { imageToDataURL, mod, debounce, fuzzyScore, escapeHtml, pickFiles, cls, MOD, ALT, SHIFT } from './util.js';
import { Icon, typeIcon } from './icons.js';

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV', 'TD', 'TH']);
const exec = (c, v = null) => document.execCommand(c, false, v);

function blockOf(node, root) {
  while (node && node !== root) {
    if (node.nodeType === 1 && BLOCKS.has(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}
function textBeforeCaret(block, range) {
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(range.startContainer, range.startOffset);
  return r;
}
function selectRange(r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function caretRect() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0).cloneRange();
  let rect = r.getClientRects()[0];
  if (!rect) { const b = blockOf(r.startContainer, document.body); rect = (b || r.startContainer.parentElement)?.getBoundingClientRect(); }
  return rect;
}

export function serializeEditor(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('[data-ui]').forEach((x) => x.remove());
  c.querySelectorAll('.ink-block').forEach((b) => { b.innerHTML = ''; b.removeAttribute('tabindex'); });
  c.querySelectorAll('span[style*="background"]').forEach((s) => { const m = document.createElement('mark'); m.append(...s.childNodes); s.replaceWith(m); });
  return c.innerHTML;
}

const SLASH = [
  { id: 'h1', label: 'Heading 1', icon: 'h1', keys: 'title big', hint: '#' },
  { id: 'h2', label: 'Heading 2', icon: 'h2', keys: 'subtitle', hint: '##' },
  { id: 'h3', label: 'Heading 3', icon: 'text', keys: 'small heading', hint: '###' },
  { id: 'p', label: 'Text', icon: 'text', keys: 'paragraph plain' },
  { id: 'ul', label: 'Bullet list', icon: 'bullets', keys: 'unordered', hint: '-' },
  { id: 'ol', label: 'Numbered list', icon: 'numbers', keys: 'ordered', hint: '1.' },
  { id: 'task', label: 'Checklist', icon: 'checkSquare', keys: 'todo task checkbox', hint: '[]' },
  { id: 'quote', label: 'Quote', icon: 'quote', keys: 'blockquote citation', hint: '>' },
  { id: 'callout', label: 'Callout', icon: 'callout', keys: 'note box info key' },
  { id: 'pre', label: 'Code block', icon: 'code', keys: 'snippet pre', hint: '```' },
  { id: 'hr', label: 'Divider', icon: 'divider', keys: 'line separator rule', hint: '---' },
  { id: 'sketch', label: 'Sketch', icon: 'brush', keys: 'draw ink handwriting drawing pen' },
  { id: 'table', label: 'Table', icon: 'grid', keys: 'grid columns' },
  { id: 'image', label: 'Image', icon: 'image', keys: 'picture photo upload' },
  { id: 'link', label: 'Link to note', icon: 'link', keys: 'wiki reference backlink', hint: '[[' },
  { id: 'date', label: "Today's date", icon: 'calendar', keys: 'time now' },
];

export function PageEditor({ note, pane }) {
  const ed = useRef();
  const titleRef = useRef();
  const scrollRef = useRef();
  const [popup, setPopup] = useState(null);
  const [fmt, setFmt] = useState(null);
  const pop = useRef(null);
  pop.current = popup;

  const save = useMemo(() => debounce(() => { if (ed.current) updateNote(note.id, { content: { html: serializeEditor(ed.current) } }); }, 300), [note.id]);
  const saveTitle = useMemo(() => debounce((t) => updateNote(note.id, { title: t }), 250), [note.id]);
  useEffect(() => {
    const f = () => { save.flush(); saveTitle.flush(); };
    flushers.add(f);
    return () => { f(); flushers.delete(f); };
  }, [save]);

  const hydrate = (root) => {
    root.querySelectorAll('.ink-block').forEach((b) => hydrateInk(b, { onChange: save, penOnly: () => S.settings.penOnly }));
    root.querySelectorAll('img').forEach((i) => (i.draggable = false));
  };

  useLayoutEffect(() => {
    const el = ed.current;
    el.innerHTML = sanitizeHTML(note.content?.html || '') || '<p><br></p>';
    hydrate(el);
    if (titleRef.current) { titleRef.current.value = note.title || ''; autosize(titleRef.current); }
    try { exec('defaultParagraphSeparator', 'p'); } catch {}
    const j = S.jump[note.id];
    if (!note.title && Date.now() - note.created < 3000) titleRef.current?.focus();
    else if (j?.focus === 'end' && Date.now() - j.ts < 3000) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); selectRange(r); delete S.jump[note.id]; }
  }, [note.id, note.rev]);

  // Selection toolbar
  useEffect(() => {
    const onSel = () => {
      const s = getSelection();
      const el = ed.current;
      if (!el || !s.rangeCount || s.isCollapsed || !el.contains(s.anchorNode) || s.anchorNode?.parentElement?.closest('.ink-block')) { setFmt(null); return; }
      const r = s.getRangeAt(0).getBoundingClientRect();
      if (!r.width) { setFmt(null); return; }
      setFmt({ x: r.left + r.width / 2, y: r.top, b: r.bottom });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const changed = () => save();

  /* ---- block formatting ---- */
  const setBlock = (kind) => {
    const el = ed.current;
    el.focus();
    const s = getSelection();
    const blk = s.rangeCount ? blockOf(s.getRangeAt(0).startContainer, el) : null;
    if (kind === 'ul' || kind === 'ol' || kind === 'task') {
      const inList = blk?.closest('ul,ol');
      if (kind === 'task') {
        if (!(inList && inList.tagName === 'UL')) exec('insertUnorderedList');
        const ul = blockOf(getSelection().getRangeAt(0).startContainer, el)?.closest('ul');
        if (ul) { const was = ul.classList.contains('tasks') && inList; ul.classList.toggle('tasks', !was); [...ul.children].forEach((li) => (was ? li.removeAttribute('data-checked') : li.hasAttribute('data-checked') || li.setAttribute('data-checked', 'false'))); }
      } else {
        if (inList?.classList.contains('tasks') && kind === 'ul') { inList.classList.remove('tasks'); [...inList.children].forEach((li) => li.removeAttribute('data-checked')); }
        else exec(kind === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      }
      unwrapListParagraphs();
    } else if (kind === 'quote') exec('formatBlock', blk?.closest('blockquote') ? 'p' : 'blockquote');
    else if (kind === 'callout') {
      const c = blk?.closest('.callout');
      if (c) { const p = document.createElement('p'); p.innerHTML = c.innerHTML || '<br>'; c.replaceWith(p); }
      else exec('insertHTML', `<div class="callout">${blk && blk.textContent.trim() ? '' : '<br>'}</div>`);
    } else if (kind === 'hr') exec('insertHTML', '<hr><p><br></p>');
    else if (kind === 'sketch') { exec('insertHTML', newInkBlockHTML() + '<p><br></p>'); hydrate(el); }
    else if (kind === 'table') exec('insertHTML', '<table><thead><tr><th><br></th><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>');
    else if (kind === 'date') exec('insertText', new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    else if (kind === 'image') { insertImages(); return; }
    else if (kind === 'link') { linkFromPicker(); return; }
    else {
      const tag = { h1: 'h1', h2: 'h2', h3: 'h3', p: 'p', pre: 'pre' }[kind];
      const cur = blk?.tagName.toLowerCase();
      exec('formatBlock', cur === tag && tag !== 'p' ? 'p' : tag);
    }
    changed();
  };

  // Chrome sometimes nests a new list inside the paragraph it came from; lift it out, keeping the caret.
  const unwrapListParagraphs = () => {
    const bad = ed.current.querySelectorAll('p > ul, p > ol');
    if (!bad.length) return;
    const sel = getSelection();
    const at = sel.rangeCount ? [sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset] : null;
    bad.forEach((l) => { const p = l.parentElement; if (p?.isConnected) p.replaceWith(...p.childNodes); });
    if (at && at[0].isConnected) { const r = document.createRange(); r.setStart(at[0], Math.min(at[1], at[0].length ?? at[0].childNodes.length)); r.collapse(true); selectRange(r); }
  };
  const toggleMark = () => {
    const s = getSelection();
    const m = s.anchorNode?.parentElement?.closest('mark');
    if (m && ed.current.contains(m)) { m.replaceWith(...m.childNodes); }
    else { exec('styleWithCSS', true); exec('hiliteColor', '#ffe066'); exec('styleWithCSS', false); }
    normalizeMarks(); changed();
  };
  const normalizeMarks = () => ed.current.querySelectorAll('span[style*="background"]').forEach((sp) => { const m = document.createElement('mark'); m.append(...sp.childNodes); sp.replaceWith(m); });
  const toggleCode = () => {
    const s = getSelection();
    const c = s.anchorNode?.parentElement?.closest('code');
    if (c && !c.closest('pre')) { c.replaceWith(document.createTextNode(c.textContent)); changed(); return; }
    if (s.isCollapsed) return;
    exec('insertHTML', `<code>${escapeHtml(s.toString())}</code>​`);
    changed();
  };

  /* ---- links ---- */
  const linkHTML = (n, label) => `<a class="wikilink" data-note-id="${n.id}" href="#${n.id}">${escapeHtml(label || n.title || 'Untitled')}</a>&nbsp;`;
  const linkFromPicker = async (initial = '') => {
    const s = getSelection();
    const saved = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    const label = saved && !saved.collapsed ? saved.toString() : '';
    const n = await pickNote({ title: 'Link to note', q: initial || label, allowCreate: true });
    ed.current.focus();
    if (saved) selectRange(saved);
    if (n) { exec('insertHTML', linkHTML(n, label || n.title)); changed(); }
  };
  const resolveOrCreate = (title) => findByTitle(title) || createNote({ title: title.trim(), notebookId: note.notebookId, silent: true });

  const insertImages = async (files) => {
    files ||= await pickFiles('image/*');
    ed.current.focus();
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try { const { src } = await imageToDataURL(f); exec('insertHTML', `<img src="${src}" alt="${escapeHtml(f.name || '')}"><p><br></p>`); }
      catch { toast(`Couldn't read ${f.name}`); }
    }
    hydrate(ed.current); changed();
  };

  /* ---- popups ([[ and /) ---- */
  const checkPopups = () => {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) { if (pop.current) setPopup(null); return; }
    const r = s.getRangeAt(0);
    const tn = r.startContainer;
    if (tn.nodeType !== 3) { if (pop.current) setPopup(null); return; }
    const before = tn.data.slice(0, r.startOffset);
    let m = before.match(/\[\[([^\]\n]{0,80})$/);
    if (m) { const rect = caretRect(); setPopup({ kind: 'link', q: m[1], node: tn, start: r.startOffset - m[0].length, end: r.startOffset, x: rect?.left || 0, y: rect?.bottom || 0, idx: pop.current?.kind === 'link' && pop.current.q === m[1] ? pop.current.idx : 0 }); return; }
    m = before.match(/(^|\s)\/([\w ]{0,20})$/);
    if (m && !/\s\s$/.test(m[2]) && !blockOf(tn, ed.current)?.closest('pre')) {
      const items = slashItems(m[2]);
      if (items.length) { const rect = caretRect(); setPopup({ kind: 'slash', q: m[2], node: tn, start: r.startOffset - m[2].length - 1, end: r.startOffset, x: rect?.left || 0, y: rect?.bottom || 0, idx: pop.current?.kind === 'slash' && pop.current.q === m[2] ? pop.current.idx : 0 }); return; }
    }
    if (pop.current) setPopup(null);
  };
  const slashItems = (q) => {
    q = q.trim().toLowerCase();
    if (!q) return SLASH;
    return SLASH.map((it) => ({ it, s: Math.max(fuzzyScore(q, it.label), fuzzyScore(q, it.keys) * 0.8) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it);
  };
  const linkItems = (q) => {
    const ql = q.trim();
    const notes = liveNotes().filter((n) => n.id !== note.id);
    let list = ql
      ? notes.map((n) => ({ n, s: fuzzyScore(ql, n.title || 'Untitled') })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.n.opened - a.n.opened).map((x) => x.n)
      : notes.sort((a, b) => (b.opened || 0) - (a.opened || 0));
    list = list.slice(0, 7).map((n) => ({ n }));
    if (ql && !findByTitle(ql)) list.push({ create: ql });
    return list;
  };
  const replacePopupText = (p) => {
    const r = document.createRange();
    r.setStart(p.node, Math.max(0, p.start));
    r.setEnd(p.node, Math.min(p.node.length, p.end));
    selectRange(r);
  };
  const choosePopup = (p, item) => {
    setPopup(null);
    ed.current.focus();
    replacePopupText(p);
    if (p.kind === 'slash') {
      exec('delete');
      setBlock(item.id);
    } else {
      const n = item.create ? createNote({ title: item.create, notebookId: note.notebookId, silent: true }) : item.n;
      exec('insertHTML', linkHTML(n));
      if (item.create) toast(`Created “${item.create}”`);
      changed();
    }
  };

  /* ---- input rules ---- */
  const onInput = (e) => {
    const s = getSelection();
    if (e.inputType === 'insertText' && s.rangeCount && s.isCollapsed) {
      const r = s.getRangeAt(0);
      const tn = r.startContainer;
      const blk = blockOf(tn, ed.current);
      if (blk && tn.nodeType === 3) {
        if (/ $/.test(e.data || '') && !blk.closest('pre')) {
          const pre = textBeforeCaret(blk, r);
          const t = pre.toString();
          const rules = [[/^#\s$/, 'h1'], [/^##\s$/, 'h2'], [/^###\s$/, 'h3'], [/^[-*+]\s$/, 'ul'], [/^1[.)]\s$/, 'ol'], [/^\[[ xX]?\]\s$/, 'task'], [/^-\s?\[[ xX]?\]\s$/, 'task'], [/^>\s$/, 'quote'], [/^```\s?$/, 'pre']];
          const inLi = blk.tagName === 'LI';
          for (const [re, kind] of rules) {
            if (!re.test(t.replace(/ /g, ' '))) continue;
            if (inLi && kind !== 'task') break;
            const checked = /x/i.test(t);
            selectRange(pre); exec('delete');
            if (inLi && kind === 'task') { const ul = blk.closest('ul'); if (ul) { ul.classList.add('tasks'); [...ul.children].forEach((li) => li.hasAttribute('data-checked') || li.setAttribute('data-checked', 'false')); } }
            else setBlock(kind);
            if (kind === 'task' && checked) { const li = blockOf(getSelection().getRangeAt(0).startContainer, ed.current)?.closest('li'); li?.setAttribute('data-checked', 'true'); }
            changed();
            return;
          }
        }
        if (/[*_`=~\]]$/.test(e.data || '') && !blk.closest('pre')) {
          const before = tn.data.slice(0, r.startOffset);
          const inl = [
            [/\[\[([^\]\n]{1,120})\]\]$/, 'link'],
            [/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, 'strong'],
            [/(?:^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, 'em'],
            [/(?:^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, 'em'],
            [/`([^`]+)`$/, 'code'],
            [/==([^=\s](?:[^=]*[^=\s])?)==$/, 'mark'],
            [/~~([^~\s](?:[^~]*[^~\s])?)~~$/, 's'],
          ];
          for (const [re, tag] of inl) {
            const m = before.match(re);
            if (!m) continue;
            const full = /^[*_`=~[]/.test(m[0]) ? m[0] : m[0].slice(1);
            const rr = document.createRange();
            rr.setStart(tn, r.startOffset - full.length); rr.setEnd(tn, r.startOffset);
            selectRange(rr);
            if (tag === 'link') { const n = resolveOrCreate(m[1].split('|')[0]); exec('insertHTML', linkHTML(n, m[1].split('|')[1])); }
            else exec('insertHTML', `<${tag}>${escapeHtml(m[1])}</${tag}>​`);
            changed();
            return;
          }
        }
      }
    }
    checkPopups();
    changed();
  };

  /* ---- keys ---- */
  const onKeyDown = (e) => {
    const p = pop.current;
    if (p) {
      const items = p.kind === 'slash' ? slashItems(p.q) : linkItems(p.q);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPopup({ ...p, idx: (p.idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length }); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && items[p.idx]) { e.preventDefault(); choosePopup(p, items[p.idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setPopup(null); return; }
    }
    const s = getSelection();
    const r = s.rangeCount ? s.getRangeAt(0) : null;
    const blk = r ? blockOf(r.startContainer, ed.current) : null;
    const k = e.key.toLowerCase();
    if (mod(e) && e.altKey && /^Digit[0-3]$/.test(e.code)) { e.preventDefault(); setBlock(['p', 'h1', 'h2', 'h3'][+e.code.slice(-1)]); return; }
    if (mod(e) && e.shiftKey && /^Digit[789]$/.test(e.code)) { e.preventDefault(); setBlock({ 7: 'ol', 8: 'ul', 9: 'task' }[e.code.slice(-1)]); return; }
    if (mod(e) && e.shiftKey && k === 'h') { e.preventDefault(); toggleMark(); return; }
    if (mod(e) && e.shiftKey && k === 'x') { e.preventDefault(); exec('strikeThrough'); changed(); return; }
    if (mod(e) && !e.shiftKey && k === 'e') { e.preventDefault(); e.stopPropagation(); toggleCode(); return; }
    if (mod(e) && e.shiftKey && k === 'l') { e.preventDefault(); linkFromPicker(); return; }
    if (mod(e) && e.key === 'Enter') {
      e.preventDefault();
      const li = blk?.closest('li');
      if (li && li.hasAttribute('data-checked')) { li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true'); changed(); return; }
      const outer = blk?.closest('pre,blockquote,.callout,h1,h2,h3,table') || blk;
      if (outer) { const np = document.createElement('p'); np.innerHTML = '<br>'; outer.after(np); const rr = document.createRange(); rr.setStart(np, 0); selectRange(rr); changed(); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && blk) {
      if (blk.closest('pre')) { e.preventDefault(); exec('insertLineBreak'); changed(); return; }
      if (blk.tagName === 'P' && /^(-{3,}|\*{3,}|_{3,})$/.test(blk.textContent.trim())) { e.preventDefault(); const hr = document.createElement('hr'); const np = document.createElement('p'); np.innerHTML = '<br>'; blk.replaceWith(hr); hr.after(np); const rr = document.createRange(); rr.setStart(np, 0); selectRange(rr); changed(); return; }
      if (!blk.textContent.trim() && (blk.closest('blockquote') || blk.closest('.callout'))) { e.preventDefault(); const outer = blk.closest('blockquote,.callout'); if (blk !== outer) blk.remove(); const np = document.createElement('p'); np.innerHTML = '<br>'; outer.after(np); if (!outer.textContent.trim()) outer.remove(); const rr = document.createRange(); rr.setStart(np, 0); selectRange(rr); changed(); return; }
      if (blk.closest('ul.tasks')) setTimeout(() => { const s2 = getSelection(); const li = s2.rangeCount && blockOf(s2.getRangeAt(0).startContainer, ed.current)?.closest('li'); if (li && li.closest('ul.tasks')) li.setAttribute('data-checked', 'false'); }, 0);
    }
    if (e.key === 'Backspace' && blk && r.collapsed && /^(H1|H2|H3|PRE|BLOCKQUOTE)$/.test(blk.tagName) && textBeforeCaret(blk, r).toString() === '') { e.preventDefault(); exec('formatBlock', 'p'); changed(); return; }
    if (e.key === 'Tab') {
      if (blk?.closest('li')) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); changed(); return; }
      if (blk?.closest('pre')) { e.preventDefault(); exec('insertText', '  '); return; }
      if (blk?.closest('td,th')) { e.preventDefault(); const cells = [...blk.closest('table').querySelectorAll('td,th')]; const c = blk.closest('td,th'); const nx = cells[cells.indexOf(c) + (e.shiftKey ? -1 : 1)]; if (nx) { const rr = document.createRange(); rr.selectNodeContents(nx); rr.collapse(false); selectRange(rr); } return; }
    }
    if (e.key === 'Escape') { ed.current.blur(); }
    if ((e.key === 'ArrowUp') && blk && blk === ed.current.firstElementChild && r && textBeforeCaret(blk, r).toString().indexOf('\n') < 0) {
      const rr = r.getBoundingClientRect(); const br = blk.getBoundingClientRect();
      if (!rr.height || rr.top - br.top < 8) { e.preventDefault(); titleRef.current?.focus(); }
    }
  };

  const onKeyUp = (e) => { if (/Arrow|Home|End/.test(e.key)) checkPopups(); };

  const onClick = (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      const id = a.dataset.noteId;
      if (id) {
        if (!S.notes.has(id) || S.notes.get(id).trashed) { toast('That note no longer exists.'); return; }
        open(id, { split: mod(e) || e.shiftKey, page: a.dataset.page ? +a.dataset.page : undefined });
      } else if (a.href) window.open(a.href, '_blank', 'noopener');
      return;
    }
    const li = e.target.closest('ul.tasks > li');
    if (li && e.target === li) {
      const x = e.clientX - li.getBoundingClientRect().left;
      if (x < 26) { li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true'); changed(); }
    }
    checkPopups();
  };

  const onPaste = (e) => {
    const dt = e.clipboardData;
    const imgs = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); insertImages(imgs); return; }
    const s = getSelection();
    if (s.rangeCount && blockOf(s.getRangeAt(0).startContainer, ed.current)?.closest('pre')) { e.preventDefault(); exec('insertText', dt.getData('text/plain')); return; }
    const h = dt.getData('text/html');
    const t = dt.getData('text/plain');
    if (h) { e.preventDefault(); exec('insertHTML', sanitizeHTML(h)); hydrate(ed.current); changed(); return; }
    if (t && looksLikeMarkdown(t)) { e.preventDefault(); exec('insertHTML', mdToHTML(t, findByTitle)); changed(); return; }
    if (t && t.includes('\n')) { e.preventDefault(); exec('insertHTML', t.split(/\r?\n/).map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('')); changed(); }
  };
  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    const nid = e.dataTransfer?.getData('application/x-note-id');
    if (files.length || nid) {
      e.preventDefault(); e.stopPropagation();
      const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (pos) selectRange(pos);
      if (files.length) insertImages(files);
      else if (S.notes.has(nid)) { exec('insertHTML', linkHTML(S.notes.get(nid))); changed(); }
    }
  };

  const onTitleKey = (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.target.selectionStart === e.target.value.length)) {
      e.preventDefault();
      saveTitle.flush();
      const el = ed.current;
      el.focus();
      const r = document.createRange();
      const first = el.firstElementChild || el;
      r.setStart(first, 0); r.collapse(true); selectRange(r);
    }
  };

  const fmtBtn = (icon, title, fn, active) => html`<button class=${cls('fmt-btn', active && 'on')} title=${title} aria-label=${title} onMouseDown=${(e) => { e.preventDefault(); fn(); }}><${Icon} name=${icon} size=${16} /></button>`;
  const fmtState = (c) => { try { return document.queryCommandState(c); } catch { return false; } };

  const items = popup ? (popup.kind === 'slash' ? slashItems(popup.q) : linkItems(popup.q)) : [];
  const words = note.words || 0;

  return html`
    <div class="page-scroll scroll" ref=${scrollRef}>
      <article class="page-doc">
        <textarea ref=${titleRef} class="page-title" rows="1" placeholder="Untitled" spellcheck=${S.settings.spellcheck}
          onInput=${(e) => { autosize(e.target); saveTitle(e.target.value); }} onKeyDown=${onTitleKey} aria-label="Title"></textarea>
        <${NoteMeta} note=${note} />
        <div ref=${ed} class="editor prose" contenteditable="true" spellcheck=${S.settings.spellcheck} data-placeholder="Write, or type / for blocks and [[ to link a note"
          onInput=${onInput} onKeyDown=${onKeyDown} onKeyUp=${onKeyUp} onClick=${onClick} onPaste=${onPaste} onDrop=${onDrop}
          onBlur=${() => setTimeout(() => setPopup(null), 150)}></div>
        <footer class="page-foot">${words.toLocaleString()} words · ${Math.max(1, Math.round(words / 230))} min read</footer>
      </article>
    </div>
    ${popup && items.length > 0 && html`
      <div class="popover suggest" style=${`left:${Math.min(popup.x, innerWidth - 300)}px;top:${Math.min(popup.y + 6, innerHeight - 340)}px`} onMouseDown=${(e) => e.preventDefault()}>
        <div class="suggest-head">${popup.kind === 'slash' ? 'Insert block' : 'Link to note'}</div>
        ${items.map((it, i) => popup.kind === 'slash'
          ? html`<button class=${cls('suggest-item', i === popup.idx && 'on')} onClick=${() => choosePopup(popup, it)} onMouseEnter=${() => setPopup({ ...popup, idx: i })}>
              <${Icon} name=${it.icon} size=${16} /><span>${it.label}</span>${it.hint && html`<kbd>${it.hint}</kbd>`}</button>`
          : html`<button class=${cls('suggest-item', i === popup.idx && 'on')} onClick=${() => choosePopup(popup, it)} onMouseEnter=${() => setPopup({ ...popup, idx: i })}>
              ${it.create ? html`<${Icon} name="plus" size=${16} /><span>Create “${it.create}”</span>` : html`<${Icon} name=${typeIcon(it.n.type)} size=${16} /><span>${it.n.title || 'Untitled'}</span>`}</button>`)}
      </div>`}
    ${fmt && !popup && html`
      <div class="popover fmtbar" style=${`left:${Math.max(8, Math.min(fmt.x - 190, innerWidth - 390))}px;top:${fmt.y > 70 ? fmt.y - 48 : fmt.b + 8}px`}>
        ${fmtBtn('bold', `Bold (${MOD}B)`, () => { exec('bold'); changed(); }, fmtState('bold'))}
        ${fmtBtn('italic', `Italic (${MOD}I)`, () => { exec('italic'); changed(); }, fmtState('italic'))}
        ${fmtBtn('underline', `Underline (${MOD}U)`, () => { exec('underline'); changed(); }, fmtState('underline'))}
        ${fmtBtn('strike', `Strikethrough (${MOD}${SHIFT}X)`, () => { exec('strikeThrough'); changed(); }, fmtState('strikeThrough'))}
        ${fmtBtn('code', `Inline code (${MOD}E)`, toggleCode)}
        ${fmtBtn('highlight', `Highlight (${MOD}${SHIFT}H)`, toggleMark)}
        <span class="sep"></span>
        ${fmtBtn('h1', 'Heading 1', () => setBlock('h1'))}
        ${fmtBtn('h2', 'Heading 2', () => setBlock('h2'))}
        ${fmtBtn('quote', 'Quote', () => setBlock('quote'))}
        ${fmtBtn('bullets', 'Bullet list', () => setBlock('ul'))}
        <span class="sep"></span>
        ${fmtBtn('link', `Link to note (${MOD}${SHIFT}L)`, () => linkFromPicker())}
        ${fmtBtn('x', 'Clear formatting', () => { exec('removeFormat'); changed(); })}
      </div>`}
  `;
}

export function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

import { NoteMeta } from './meta.js';
