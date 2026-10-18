// Universal search, quick switcher, command palette and note picker in one surface.
import { html, useState, useEffect, useRef, useMemo } from './lib.js';
import { S, emit, open, closePalette, search, nbPathString, recentNotes, currentId, liveNotes, allTags, createNote, findByTitle, toggleSplit, setSettings, setWs, openCapture, closeTab, newTabCmd, previousNote, childNotebooks, notebookPath, nbStyle } from './store.js';
import { Icon, typeIcon } from './icons.js';
import { newPage, newCanvas, importPdfs, newNotebook, saveVersion, togglePin, showHistory, moveNoteDialog, importAny, contextNotebook } from './actions.js';
import { exportNote, EXPORTS, backupAll } from './export.js';
import { TEMPLATES } from './templates.js';
import { cls, mod, fuzzyScore, highlightTerms, escapeHtml, fmtRelative, MOD, ALT, SHIFT } from './util.js';

function commands() {
  const n = S.notes.get(currentId());
  const C = [
    ['New page', 'page', `${ALT}N`, () => newPage()],
    ['New canvas', 'canvas', `${ALT}C`, () => newCanvas()],
    ['Import PDF', 'pdf', `${ALT}P`, () => importPdfs()],
    ['New notebook', 'book', '', () => newNotebook()],
    ['Quick capture', 'bolt', `${MOD}${SHIFT}Space`, () => openCapture()],
    ...TEMPLATES.map((t) => [`New from template: ${t.label}`, 'file', '', () => newPage(undefined, { template: t.id })]),
    ['Go to Home', 'home', '', () => open('home')],
    ['Go to Inbox', 'inbox', '', () => open('inbox')],
    ['Go to All notes', 'layers', '', () => open('all')],
    ['Go to Trash', 'trash', '', () => open('trash')],
    ['Jump to previous note', 'history', `${ALT}\``, previousNote],
    ['New tab', 'plus', `${ALT}T`, () => newTabCmd()],
    ['Close tab', 'x', `${ALT}W`, () => closeTab()],
    ['Toggle split view', 'split', `${MOD}${SHIFT}\\`, toggleSplit],
    ['Toggle sidebar', 'sidebar', `${MOD}\\`, () => setSettings({ sidebar: !S.settings.sidebar })],
    ['Toggle links & history panel', 'panel', `${MOD}${SHIFT}I`, () => setWs({ inspector: !S.ws.inspector })],
    ['Theme: light', 'sun', '', () => setSettings({ theme: 'light' })],
    ['Theme: dark', 'moon', '', () => setSettings({ theme: 'dark' })],
    ['Theme: match system', 'settings', '', () => setSettings({ theme: 'system' })],
    ['PDF pages: light', 'sun', '', () => setSettings({ pdfTheme: 'light' })],
    ['PDF pages: dark', 'moon', '', () => setSettings({ pdfTheme: 'dark' })],
    ['PDF pages: match app theme', 'settings', '', () => setSettings({ pdfTheme: 'auto' })],
    ['Import files (Markdown, text, HTML, PDF)', 'upload', '', () => importAny()],
    ['Download full backup', 'download', '', backupAll],
    ['Settings', 'settings', '', () => open('settings')],
    ['Keyboard shortcuts', 'keyboard', `${MOD}/`, () => { S.ui.help = true; emit(); }],
  ];
  if (n) {
    C.unshift(
      [n.pinned ? 'Unpin this note' : 'Pin this note', 'pin', '', () => togglePin(n.id)],
      ['Move this note to…', 'move', '', () => moveNoteDialog(n.id)],
      ['Show version history', 'history', '', showHistory],
      ['Save a version', 'save', `${MOD}S`, () => saveVersion(n.id)],
      ...EXPORTS[n.type].map(([f, l]) => [`Export: ${l}`, 'download', '', () => exportNote(n, f)]),
    );
  }
  return C.map(([label, icon, kbd, run]) => ({ kind: 'cmd', label, icon, kbd, run }));
}

export function Palette() {
  const p = S.ui.palette;
  if (!p) return null;
  return html`<${PaletteInner} key=${p.mode + (p.title || '')} p=${p} />`;
}
function PaletteInner({ p }) {
  const [q, setQ] = useState(p.q || '');
  const [idx, setIdx] = useState(0);
  const input = useRef();
  const list = useRef();
  const pick = p.mode === 'pick';
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const isCmd = !pick && q.startsWith('>');
  const { items, total } = useMemo(() => {
    if (isCmd) {
      const qq = q.slice(1).trim();
      const cs = commands();
      return { items: qq ? cs.map((c) => ({ ...c, s: fuzzyScore(qq, c.label) })).filter((c) => c.s > 0).sort((a, b) => b.s - a.s) : cs, total: 0 };
    }
    const out = [];
    const cur = currentId();
    if (!q.trim()) {
      recentNotes(14).filter((n) => n.id !== cur || pick).forEach((n) => out.push({ kind: 'note', n, snippet: '', terms: [] }));
      return { items: out, total: 0, recent: true };
    }
    const r = search.query(q, { notes: S.notes, pdfText: S.pdfText, nbPath: nbPathString }, 40);
    r.results.forEach((x) => out.push({ kind: 'note', ...x, n: x.note }));
    if (!pick) {
      const t = r.parsed.text;
      if (t && !r.parsed.tags.length) {
        for (const b of S.notebooks.values()) { const s = fuzzyScore(t, b.name); if (s >= 60) out.push({ kind: 'nb', b, s }); }
        for (const [tag, c] of allTags()) { const s = fuzzyScore(t.replace(/^#/, ''), tag); if (s >= 60) out.push({ kind: 'tag', tag, c, s }); }
      }
    }
    const title = q.trim();
    if ((!pick || p.allowCreate) && !/[#:]/.test(title) && !findByTitle(title)) out.push({ kind: 'create', title });
    return { items: out, total: r.total };
  }, [q]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const close = (v) => { if (pick) p.resolve(v ?? null); closePalette(); };
  const choose = (it, e = {}) => {
    if (!it) return;
    const opts = { split: mod(e), newTab: e.altKey };
    if (pick) {
      if (it.kind === 'note') close(it.n);
      else if (it.kind === 'create') close(createNote({ title: it.title, notebookId: contextNotebook(), silent: true }));
      return;
    }
    closePalette();
    if (it.kind === 'cmd') it.run();
    else if (it.kind === 'note') open(it.n.id, { ...opts, page: it.page && !it.titleHit ? it.page : undefined, focus: it.n.type === 'page' ? 'end' : undefined });
    else if (it.kind === 'nb') open('nb:' + it.b.id, opts);
    else if (it.kind === 'tag') open('tag:' + it.tag, opts);
    else if (it.kind === 'create') newPage(contextNotebook(), { title: it.title, split: opts.split });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setIdx((idx + 1) % Math.max(1, items.length)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setIdx((idx - 1 + items.length) % Math.max(1, items.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[idx], e); }
    else if (e.key === 'Tab' && !pick) { e.preventDefault(); setQ(q.startsWith('>') ? q.slice(1) : '>' + q); }
  };
  const ph = pick ? (p.title || 'Find a note') : isCmd ? 'Type a command' : 'Search notes, PDFs, notebooks and tags';
  let lastSection = null;
  const section = (s) => { if (s === lastSection) return null; lastSection = s; return html`<div class="pal-sec">${s}</div>`; };
  return html`<div class="scrim pal-scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="palette" role="dialog" aria-label=${pick ? p.title || 'Pick a note' : 'Search'}>
      <div class="pal-input">
        <${Icon} name=${isCmd ? 'command' : pick ? 'link' : 'search'} size=${19} />
        <input ref=${input} id="palette-input" value=${q} placeholder=${ph} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey} autocomplete="off" spellcheck="false" aria-label=${ph} />
        ${pick && html`<span class="pal-title">${p.title}</span>`}
      </div>
      <div class="pal-list" ref=${list} role="listbox">
        ${!items.length && html`<div class="pal-empty">${q.trim() ? 'No matches. Try fewer words, or filters like #tag, type:pdf, in:notebook.' : 'No notes yet.'}</div>`}
        ${items.map((it, i) => {
          const on = i === idx;
          const props = { class: cls('pal-item', on && 'on'), role: 'option', 'aria-selected': on, onMouseMove: () => idx !== i && setIdx(i), onClick: (e) => choose(it, e) };
          if (it.kind === 'cmd') return html`<div ...${props}><${Icon} name=${it.icon} size=${17} /><span class="pi-title">${it.label}</span>${it.kbd && html`<kbd>${it.kbd}</kbd>`}</div>`;
          if (it.kind === 'note') {
            const n = it.n;
            return html`${section(!q.trim() ? 'Recent' : 'Notes')}<div ...${props}>
              <${Icon} name=${typeIcon(n.type)} size=${17} />
              <span class="pi-main">
                <span class="pi-title" dangerouslySetInnerHTML=${{ __html: highlightTerms(n.title || 'Untitled', it.terms || []) }}></span>
                ${it.snippet && html`<span class="pi-snip" dangerouslySetInnerHTML=${{ __html: (it.page && !it.titleHit ? `<b>p. ${it.page}${it.pageCount > 1 ? ` +${it.pageCount - 1}` : ''}</b> ` : '') + highlightTerms(it.snippet, it.terms || []) }}></span>`}
              </span>
              <span class="pi-meta"><span class="pi-nb" style=${nbStyle(n.notebookId)}>${nbStyle(n.notebookId) && html`<span class="nb-dot"></span>`}<span class="pi-nb-t" title=${nbPathString(n.notebookId)}><bdi dir="ltr">${nbPathString(n.notebookId) || 'Inbox'}</bdi></span></span><span>${fmtRelative(n.opened || n.updated)}</span></span>
            </div>`;
          }
          if (it.kind === 'nb') return html`${section('Notebooks')}<div ...${props} style=${nbStyle(it.b.id)}><${Icon} name="book" size=${17} class="nb-ic" /><span class="pi-title">${notebookPath(it.b.id).map((b) => b.name).join(' / ')}</span></div>`;
          if (it.kind === 'tag') return html`${section('Tags')}<div ...${props}><${Icon} name="hash" size=${17} /><span class="pi-title">#${it.tag}</span><span class="pi-meta">${it.c} notes</span></div>`;
          if (it.kind === 'create') return html`${section('Create')}<div ...${props}><${Icon} name="plus" size=${17} /><span class="pi-title">${pick ? 'Create and link' : 'New page'} “${it.title}”</span></div>`;
        })}
      </div>
      <div class="pal-foot">
        ${isCmd ? html`<span><kbd>↵</kbd> run</span><span><kbd>Tab</kbd> back to search</span>`
          : pick ? html`<span><kbd>↵</kbd> choose</span><span><kbd>Esc</kbd> cancel</span>`
          : html`<span><kbd>↵</kbd> open</span><span><kbd>${MOD}↵</kbd> beside</span><span><kbd>${ALT}↵</kbd> new tab</span><span><kbd>></kbd> commands</span><span class="pf-filters">#tag · type:pdf · in:notebook · is:pinned</span>`}
        ${total > 40 && html`<span class="pf-total">Top 40 of ${total}</span>`}
      </div>
    </div>
  </div>`;
}
