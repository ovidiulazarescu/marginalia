// Page-note editor: a contenteditable surface with Markdown shortcuts, a slash menu,
// [[wiki links]], a selection toolbar, checklists and inline sketch blocks.
import { html, useEffect, useRef, useState, useMemo, useLayoutEffect } from './lib.js';
import { S, updateNote, open, createNote, findByTitle, flushers, pickNote, toast, liveNotes } from './store.js';
import { hydrateInk, newInkBlockHTML } from './ink.js';
import { sanitizeHTML, mdToHTML, looksLikeMarkdown, detectCode, preText, CODE_LANGS, linkifyElement, cleanUrl, hrefFor } from './md.js';
import { openMenu, promptDialog } from './dialogs.js';
import { imageToDataURL, mod, debounce, fuzzyScore, escapeHtml, pickFiles, cls, openExternal, MOD, ALT, SHIFT } from './util.js';
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

// Text from the start of the caret's line (inside a code block) up to the caret.
function lineBeforeCaret(pre, range) {
  const r = document.createRange();
  r.setStart(pre, 0);
  r.setEnd(range.startContainer, range.startOffset);
  const d = document.createElement('div');
  d.append(r.cloneContents());
  d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  const all = d.textContent;
  return all.slice(all.lastIndexOf('\n') + 1);
}
// Text from the start of a code block to the caret, with <br> counted as a newline.
function textBeforeCaretIn(pre, range) {
  const r = document.createRange();
  r.setStart(pre, 0);
  r.setEnd(range.startContainer, range.startOffset);
  const d = document.createElement('div');
  d.append(r.cloneContents());
  d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  return d.textContent;
}
// Maps a character index in a code block's text back to a DOM position.
function posAt(pre, index) {
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let acc = 0, node;
  while ((node = w.nextNode())) {
    if (node.nodeType === 3) {
      if (index <= acc + node.length) return { node, offset: index - acc };
      acc += node.length;
    } else if (node.nodeName === 'BR') acc += 1;
  }
  return null;
}
const textToParagraphs = (t) => t.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  .map((l) => `<p>${escapeHtml(l).replace(/^[ \t]+/, (w) => w.replace(/\t/g, '    ').replace(/ /g, '&nbsp;')) || '<br>'}</p>`).join('');

export function PageEditor({ note, pane, crumbs, actions }) {
  const ed = useRef();
  const titleRef = useRef();
  const scrollRef = useRef();
  const [popup, setPopup] = useState(null);
  const [fmt, setFmt] = useState(null);
  const [codeBar, setCodeBar] = useState(null);
  const [, setTick] = useState(0);
  const savedRange = useRef(null);
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
    linkifyElement(root);
    root.querySelectorAll('a[href]:not(.wikilink)').forEach((a) => (a.title = `${a.getAttribute('href')} (opens in a new tab)`));
    const last = root.lastElementChild;
    if (last && /^(PRE|TABLE)$/.test(last.tagName) || last?.classList?.contains('ink-block')) { const p = document.createElement('p'); p.innerHTML = '<br>'; root.append(p); }
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
      if (el && s.rangeCount && el.contains(s.anchorNode)) {
        savedRange.current = s.getRangeAt(0).cloneRange();
        setTick((x) => x + 1);
        placeCodeBar();
      } else if (!document.activeElement?.closest?.('.menu, .code-bar, .format-bar')) setCodeBar(null);
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
    else if (kind === 'pre') { toggleCodeBlock(); return; }
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

  /* ---- code blocks ---- */
  const preAtCaret = () => {
    const s = getSelection();
    return s.rangeCount ? blockOf(s.getRangeAt(0).startContainer, ed.current)?.closest('pre') || null : null;
  };
  const caretToEnd = (node) => { const r = document.createRange(); r.selectNodeContents(node); r.collapse(false); selectRange(r); };
  const ensureParagraphAfter = (node) => {
    if (node.nextElementSibling?.tagName !== 'P') { const p = document.createElement('p'); p.innerHTML = '<br>'; node.after(p); }
  };
  // Places code as one block, keeping every space. Returns a function that turns it back into plain paragraphs.
  const insertCodeBlock = (text, lang = '') => {
    const el = ed.current;
    const s = getSelection();
    if (s.rangeCount && !s.isCollapsed) exec('delete');
    const blk = s.rangeCount ? blockOf(s.getRangeAt(0).startContainer, el) : null;
    const top = blk ? [...el.children].find((c) => c.contains(blk)) || blk : null;
    const pre = document.createElement('pre');
    if (lang) pre.dataset.lang = lang;
    pre.textContent = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const replaced = top && top.tagName === 'P' && !top.textContent.trim() && !top.querySelector('img');
    if (replaced) top.replaceWith(pre);
    else if (top) top.after(pre);
    else el.append(pre);
    ensureParagraphAfter(pre);
    caretToEnd(pre);
    changed();
    return () => {
      if (!pre.isConnected) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = textToParagraphs(preText(pre));
      const last = tmp.lastElementChild;
      pre.replaceWith(...tmp.childNodes);
      if (last) caretToEnd(last);
      changed();
    };
  };
  // Code block button: paragraphs become one code block, and a code block becomes paragraphs again.
  const toggleCodeBlock = () => {
    const el = ed.current;
    el.focus();
    const pre = preAtCaret();
    if (pre) {
      const tmp = document.createElement('div');
      tmp.innerHTML = textToParagraphs(preText(pre)) || '<p><br></p>';
      const last = tmp.lastElementChild;
      pre.replaceWith(...tmp.childNodes);
      if (last) caretToEnd(last);
      changed();
      return;
    }
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    const blocks = [...el.children].filter((c) => r.intersectsNode(c) && /^(P|H1|H2|H3|BLOCKQUOTE|DIV)$/.test(c.tagName) && !c.classList.contains('ink-block'));
    if (!blocks.length) { exec('formatBlock', 'pre'); changed(); return; }
    const text = blocks.map((b) => b.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '')).join('\n');
    const code = document.createElement('pre');
    code.textContent = text;
    blocks[0].replaceWith(code);
    blocks.slice(1).forEach((b) => b.remove());
    ensureParagraphAfter(code);
    caretToEnd(code);
    changed();
  };
  const placeCodeBar = () => {
    const pre = preAtCaret();
    const doc = ed.current?.parentElement;
    if (!pre || !doc) { setCodeBar((c) => (c ? null : c)); return; }
    const top = pre.getBoundingClientRect().top - doc.getBoundingClientRect().top;
    setCodeBar({ pre, top, lang: pre.dataset.lang || '' });
  };
  const setLang = (pre, lang) => { if (lang) pre.dataset.lang = lang; else delete pre.dataset.lang; changed(); placeCodeBar(); };
  const copyCode = (pre) => navigator.clipboard?.writeText(preText(pre)).then(() => toast('Code copied'), () => toast('Copying is blocked here. Select the code and press ⌘C.'));

  /* ---- web links ---- */
  // Turns the URL just before the caret into a link (after typing a space, or before Enter).
  const autolinkBeforeCaret = (spaceTyped) => {
    const s = getSelection();
    if (!s.rangeCount || !s.isCollapsed) return;
    const r = s.getRangeAt(0);
    const tn = r.startContainer;
    if (tn.nodeType !== 3 || tn.parentElement.closest('a, code, pre')) return;
    const caret = r.startOffset;
    const before = tn.data.slice(0, caret - (spaceTyped ? 1 : 0));
    const m = before.match(/(?:^|[\s(\u00a0])((?:https?:\/\/|www\.)[^\s<>"'`\u00a0]+)$/i);
    if (!m) return;
    const url = cleanUrl(m[1]);
    if (!/\.[a-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+/i.test(url)) return;
    const start = before.length - m[1].length, end = start + url.length;
    const rr = document.createRange();
    rr.setStart(tn, start); rr.setEnd(tn, end);
    selectRange(rr);
    let a = null;
    if (exec('createLink', hrefFor(url))) {
      const sel = getSelection();
      const at = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      a = at?.closest('a');
    }
    if (!a) {
      // The editing command can be refused (for example while another edit is in progress): wrap it directly.
      a = document.createElement('a');
      a.href = hrefFor(url);
      rr.surroundContents(a);
    }
    {
      a.title = `${a.getAttribute('href')} (opens in a new tab)`;
      const cr = document.createRange();
      const next = a.nextSibling;
      if (next && next.nodeType === 3) cr.setStart(next, Math.min(next.length, caret - end)); else cr.setStartAfter(a);
      cr.collapse(true);
      selectRange(cr);
    }
    changed();
  };

  const editWebLink = async () => {
    const range = savedRange.current;
    const at = range && (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement);
    const a = at?.closest?.('a:not(.wikilink)');
    if (a && ed.current.contains(a)) { a.replaceWith(...a.childNodes); changed(); toast('Link removed'); return; }
    const label = range && !range.collapsed ? range.toString() : '';
    const url = await promptDialog(label ? 'Link the selected text to' : 'Insert a web link', '', { placeholder: 'https://example.com', confirmLabel: 'Add link' });
    ed.current.focus();
    if (range) selectRange(range);
    if (!url) return;
    const href = /^(https?:|mailto:)/i.test(url) ? url : 'https://' + url.replace(/^\/+/, '');
    if (label) exec('createLink', href);
    else exec('insertHTML', `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>&nbsp;`);
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
    if (e.inputType === 'insertText' && / $/.test(e.data || '')) autolinkBeforeCaret(true);
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
    if (e.key === 'Enter' && blk && !blk.closest('pre')) autolinkBeforeCaret(false);
    if (e.key === 'Enter' && !e.shiftKey && blk) {
      if (blk.closest('pre')) {
        // Keep the current line's indentation, plus one level after "key:", "{", "[" or "(".
        e.preventDefault();
        const line = textBeforeCaretIn(blk.closest('pre'), r).split('\n').pop();
        let indent = line.match(/^[ \t]*/)[0];
        if (/(:|\{|\[|\()\s*$/.test(line) && !/https?:\/\/\S*$/.test(line)) indent += '  ';
        exec('insertLineBreak');
        if (indent) exec('insertText', indent);
        changed();
        return;
      }
      if (blk.tagName === 'P' && /^(-{3,}|\*{3,}|_{3,})$/.test(blk.textContent.trim())) { e.preventDefault(); const hr = document.createElement('hr'); const np = document.createElement('p'); np.innerHTML = '<br>'; blk.replaceWith(hr); hr.after(np); const rr = document.createRange(); rr.setStart(np, 0); selectRange(rr); changed(); return; }
      if (!blk.textContent.trim() && (blk.closest('blockquote') || blk.closest('.callout'))) { e.preventDefault(); const outer = blk.closest('blockquote,.callout'); if (blk !== outer) blk.remove(); const np = document.createElement('p'); np.innerHTML = '<br>'; outer.after(np); if (!outer.textContent.trim()) outer.remove(); const rr = document.createRange(); rr.setStart(np, 0); selectRange(rr); changed(); return; }
      if (blk.closest('ul.tasks')) setTimeout(() => { const s2 = getSelection(); const li = s2.rangeCount && blockOf(s2.getRangeAt(0).startContainer, ed.current)?.closest('li'); if (li && li.closest('ul.tasks')) li.setAttribute('data-checked', 'false'); }, 0);
    }
    if (e.key === 'Backspace' && blk && r.collapsed && /^(H1|H2|H3|PRE|BLOCKQUOTE)$/.test(blk.tagName) && textBeforeCaret(blk, r).toString() === '') { e.preventDefault(); exec('formatBlock', 'p'); changed(); return; }
    if (e.key === 'Tab') {
      if (blk?.closest('li')) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); changed(); return; }
      if (blk?.closest('pre')) {
        e.preventDefault();
        const pre = blk.closest('pre');
        if (!e.shiftKey) { exec('insertText', '  '); changed(); return; }
        // Shift+Tab removes up to two spaces (or a tab) from the start of the line.
        const before = textBeforeCaretIn(pre, r);
        const lineAt = before.lastIndexOf('\n') + 1;
        const lead = (preText(pre).slice(lineAt).match(/^( {1,2}|\t)/) || [''])[0];
        if (!lead) return;
        const from = posAt(pre, lineAt), to = posAt(pre, lineAt + lead.length);
        if (!from || !to) return;
        const caret = before.length - lead.length;
        const rr = document.createRange(); rr.setStart(from.node, from.offset); rr.setEnd(to.node, to.offset);
        selectRange(rr); exec('delete');
        const back = posAt(pre, Math.max(lineAt, caret));
        if (back) { const cr = document.createRange(); cr.setStart(back.node, back.offset); selectRange(cr); }
        changed();
        return;
      }
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
      } else if (a.getAttribute('href')) openExternal(a.href);
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
    const h = dt.getData('text/html');
    const t = dt.getData('text/plain');
    // Inside a code block, paste exactly what was copied.
    if (preAtCaret()) { e.preventDefault(); exec('insertText', t.replace(/\r\n?/g, '\n')); changed(); placeCodeBar(); return; }
    // Code (YAML, JSON, shell, Terraform...) becomes a code block so indentation survives.
    // Copies from code editors arrive as HTML with white-space: pre, which also counts.
    const fromEditor = h && /white-space:\s*pre|<pre[\s>]/i.test(h) && /\n/.test(t);
    const richDoc = h && /<(table|img|h[1-6]|li)\b/i.test(h) && !fromEditor;
    const lang = t && !richDoc ? detectCode(t) : null;
    if (t && (lang !== null || fromEditor)) {
      e.preventDefault();
      const undo = insertCodeBlock(t, lang || '');
      toast(lang ? `Pasted as a ${lang.toUpperCase()} code block` : 'Pasted as a code block', { label: 'Paste as text', run: () => { undo(); } });
      return;
    }
    const lone = t && t.trim().match(/^(?:https?:\/\/|www\.)\S+$/i) ? cleanUrl(t.trim()) : null;
    if (lone) {
      e.preventDefault();
      const sel = getSelection();
      if (sel.rangeCount && !sel.isCollapsed && !sel.getRangeAt(0).toString().includes('\n')) exec('createLink', hrefFor(lone)); // link the selected words
      else exec('insertHTML', `<a href="${escapeHtml(hrefFor(lone))}">${escapeHtml(lone)}</a>&nbsp;`);
      hydrate(ed.current); changed();
      return;
    }
    if (h) { e.preventDefault(); exec('insertHTML', sanitizeHTML(h)); hydrate(ed.current); changed(); return; }
    if (t && looksLikeMarkdown(t)) { e.preventDefault(); exec('insertHTML', mdToHTML(t, findByTitle)); hydrate(ed.current); changed(); return; }
    // Plain text: one paragraph per line, leading spaces kept, web addresses linked.
    if (t && (t.includes('\n') || /^[ \t]/.test(t) || /(https?:\/\/|www\.)/i.test(t))) { e.preventDefault(); exec('insertHTML', textToParagraphs(t)); hydrate(ed.current); changed(); }
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

  // Toolbar state comes from the last caret position inside the editor.
  const sr = savedRange.current;
  const inEd = sr && ed.current?.contains(sr.startContainer);
  const blkEl = inEd ? blockOf(sr.startContainer, ed.current) : null;
  const atEl = inEd ? (sr.startContainer.nodeType === 1 ? sr.startContainer : sr.startContainer.parentElement) : null;
  const blockType = !blkEl ? 'p' : blkEl.closest('pre') ? 'pre' : blkEl.closest('.callout') ? 'callout' : blkEl.closest('blockquote') ? 'quote' : /^H[123]$/.test(blkEl.tagName) ? blkEl.tagName.toLowerCase() : 'p';
  const listType = blkEl?.closest('ul.tasks') ? 'task' : blkEl?.closest('ol') ? 'ol' : blkEl?.closest('ul') ? 'ul' : null;
  const BLOCKS = [['p', 'Text', 'text'], ['h1', 'Heading 1', 'h1'], ['h2', 'Heading 2', 'h2'], ['h3', 'Heading 3', 'text'], ['quote', 'Quote', 'quote'], ['pre', 'Code block', 'code'], ['callout', 'Callout', 'callout']];
  const run = (fn) => { const el = ed.current; el.focus(); if (sr && el.contains(sr.startContainer)) selectRange(sr); fn(); setTick((x) => x + 1); };
  const chooseBlock = (k) => run(() => {
    if (k === blockType) return;
    if (blockType === 'pre') toggleCodeBlock();
    else if (blockType === 'quote' || blockType === 'callout') setBlock(blockType); // leave the quote/callout first
    if (k !== 'p') setBlock(k);
    else if (/^h[123]$/.test(blockType)) exec('formatBlock', 'p');
    changed();
  });
  const tb = (icon, title, fn, on) => html`<button class=${cls('tb-btn', on && 'on')} title=${title} aria-label=${title} aria-pressed=${!!on} onMouseDown=${(e) => e.preventDefault()} onClick=${() => run(fn)}><${Icon} name=${icon} size=${17} /></button>`;
  const LANG_NAMES = { yaml: 'YAML', json: 'JSON', bash: 'Shell', hcl: 'Terraform (HCL)', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', sql: 'SQL', html: 'HTML', css: 'CSS', xml: 'XML', markdown: 'Markdown', go: 'Go', java: 'Java', c: 'C', dockerfile: 'Dockerfile', ini: 'INI', toml: 'TOML' };

  return html`
    <header class="note-bar page-bar">
      ${crumbs}
    ${S.settings.formatBar ? html`<div class="format-bar" role="toolbar" aria-label="Formatting">
        ${tb('undo', `Undo (${MOD}Z)`, () => exec('undo'))}
        ${tb('redo', `Redo (${MOD}${SHIFT}Z)`, () => exec('redo'))}
        <span class="tb-sep"></span>
        <button class="tb-block" title="Text style" onMouseDown=${(e) => e.preventDefault()}
          onClick=${(e) => openMenu(e, BLOCKS.map(([k, l, i]) => ({ label: l, icon: i, checked: blockType === k, run: () => chooseBlock(k) })))}>
          ${BLOCKS.find((b) => b[0] === blockType)[1]}<${Icon} name="chevronDown" size=${14} /></button>
        <span class="tb-sep"></span>
        ${tb('bold', `Bold (${MOD}B)`, () => { exec('bold'); changed(); }, fmtState('bold'))}
        ${tb('italic', `Italic (${MOD}I)`, () => { exec('italic'); changed(); }, fmtState('italic'))}
        ${tb('underline', `Underline (${MOD}U)`, () => { exec('underline'); changed(); }, fmtState('underline'))}
        ${tb('strike', `Strikethrough (${MOD}${SHIFT}X)`, () => { exec('strikeThrough'); changed(); }, fmtState('strikeThrough'))}
        ${tb('highlight', `Highlight (${MOD}${SHIFT}H)`, toggleMark, !!atEl?.closest('mark'))}
        ${tb('code', `Inline code (${MOD}E)`, toggleCode, !!atEl?.closest('code') && !atEl?.closest('pre'))}
        <span class="tb-sep"></span>
        ${tb('external', atEl?.closest('a:not(.wikilink)') ? 'Remove web link' : 'Web link', editWebLink, !!atEl?.closest('a:not(.wikilink)'))}
        ${tb('link', `Link to a note (${MOD}${SHIFT}L or [[)`, () => linkFromPicker())}
        <span class="tb-sep"></span>
        ${tb('bullets', `Bullet list (${MOD}${SHIFT}8)`, () => setBlock('ul'), listType === 'ul')}
        ${tb('numbers', `Numbered list (${MOD}${SHIFT}7)`, () => setBlock('ol'), listType === 'ol')}
        ${tb('checkSquare', `Checklist (${MOD}${SHIFT}9)`, () => setBlock('task'), listType === 'task')}
        ${tb('outdent', `Outdent (${SHIFT}Tab)`, () => { if (blockType === 'pre') { const k = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); ed.current.dispatchEvent(k); } else { exec('outdent'); changed(); } })}
        ${tb('indent', 'Indent (Tab)', () => { if (blockType === 'pre') exec('insertText', '  '); else exec('indent'); changed(); })}
        <span class="tb-sep"></span>
        ${tb('code', 'Code block (keeps spacing; paste YAML or JSON straight in)', () => setBlock('pre'), blockType === 'pre')}
        <button class="tb-btn tb-insert" title="Insert table, divider, callout, sketch, image or date" aria-label="Insert" onMouseDown=${(e) => e.preventDefault()}
          onClick=${(e) => openMenu(e, [
            { label: 'Table', icon: 'grid', run: () => run(() => setBlock('table')) },
            { label: 'Divider', icon: 'divider', run: () => run(() => setBlock('hr')) },
            { label: 'Callout', icon: 'callout', run: () => run(() => setBlock('callout')) },
            { label: 'Sketch', icon: 'brush', run: () => run(() => setBlock('sketch')) },
            { label: 'Image…', icon: 'image', run: () => run(() => setBlock('image')) },
            { label: "Today's date", icon: 'calendar', run: () => run(() => setBlock('date')) },
          ])}><${Icon} name="plus" size=${17} /></button>
        <span class="tb-sep"></span>
        ${tb('x', 'Clear formatting', () => { exec('removeFormat'); changed(); })}
      </div>` : html`<span class="spacer"></span>`}
      ${actions}
    </header>
    <div class="page-scroll scroll" ref=${scrollRef}>
      <article class="page-doc">
        <textarea ref=${titleRef} class="page-title" rows="1" placeholder="Untitled" spellcheck=${S.settings.spellcheck}
          onInput=${(e) => { autosize(e.target); saveTitle(e.target.value); }} onKeyDown=${onTitleKey} aria-label="Title"></textarea>
        <${NoteMeta} note=${note} />
        <div ref=${ed} class="editor prose" contenteditable="true" spellcheck=${S.settings.spellcheck} data-placeholder="Write, or type / for blocks and [[ to link a note"
          onInput=${onInput} onKeyDown=${onKeyDown} onKeyUp=${onKeyUp} onClick=${onClick} onPaste=${onPaste} onDrop=${onDrop}
          onBlur=${() => { setTimeout(() => setPopup(null), 150); if (linkifyElement(ed.current)) { hydrate(ed.current); changed(); } }}></div>
        ${codeBar && codeBar.pre.isConnected && html`<div class="code-bar" style=${`top:${codeBar.top + 6}px`} onMouseDown=${(e) => e.preventDefault()}>
          <button class="code-lang" title="Language" onClick=${(e) => openMenu(e, [{ label: 'Plain text', checked: !codeBar.lang, run: () => setLang(codeBar.pre, '') }, '-', ...CODE_LANGS.map((l) => ({ label: LANG_NAMES[l] || l, checked: codeBar.lang === l, run: () => setLang(codeBar.pre, l) }))], { align: 'right' })}>
            ${codeBar.lang ? LANG_NAMES[codeBar.lang] || codeBar.lang : 'Plain text'}<${Icon} name="chevronDown" size=${13} /></button>
          <button class="code-copy" title="Copy code" aria-label="Copy code" onClick=${() => copyCode(codeBar.pre)}><${Icon} name="copy" size=${15} /></button>
        </div>`}
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
    ${fmt && !popup && !S.settings.formatBar && html`
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
