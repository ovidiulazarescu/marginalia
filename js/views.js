import { html, useState, useEffect, useRef, useMemo, diffWords } from './lib.js';
import {
  S, emit, open, back, forward, selectTab, closeTab, moveTab, toggleSplit, newTabCmd, setWs, setSettings, updateNote, restoreNote, destroyNote, emptyTrash,
  notebookPath, childNotebooks, notesIn, countDeep, liveNotes, backlinks, unlinkedMentions, listVersions, restoreVersion, recentNotes, descendants,
  openCapture, createNote, toast, flushAll, nbPathString, allTags, renameTag, moveNote, noteText, nbStyle,
} from './store.js';
import { Icon, typeIcon } from './icons.js';
import { openMenu, confirmDialog, promptDialog } from './dialogs.js';
import { PageEditor } from './editor.js';
import { CanvasView } from './canvas.js';
import { PdfView } from './pdfview.js';
import { NoteMeta } from './meta.js';
import { noteMenu, notebookMenu, newPage, newCanvas, importPdfs, newNotebook, togglePin, saveVersion, moveNoteDialog, importAny } from './actions.js';
import { backupAll, exportNotebookZip, restoreBackup } from './export.js';
import { cls, mod, fmtRelative, fmtDateTime, dayBucket, groupBy, natCompare, today, parseHTML, escapeHtml, bytes, MOD, ALT, SHIFT, pickFiles, debounce } from './util.js';
import { db } from './db.js';
import { syncNow, setToken, getToken } from './sync.js';
import { SYNC_LABEL } from './sidebar.js';

export function titleFor(id) {
  if (id === 'home') return ['Home', 'home'];
  if (id === 'inbox') return ['Inbox', 'inbox'];
  if (id === 'all') return ['All notes', 'layers'];
  if (id === 'trash') return ['Trash', 'trash'];
  if (id === 'settings') return ['Settings', 'settings'];
  if (id.startsWith('nb:')) return [S.notebooks.get(id.slice(3))?.name || 'Notebook', 'book'];
  if (id.startsWith('tag:')) return ['#' + id.slice(4), 'hash'];
  const n = S.notes.get(id);
  return n ? [n.title || 'Untitled', typeIcon(n.type)] : ['Missing note', 'file'];
}
// The notebook colour for a tab: the notebook itself, or the notebook a note is in.
const tabStyle = (id) => id.startsWith('nb:') ? nbStyle(id.slice(3)) : nbStyle(S.notes.get(id)?.notebookId);
// A small dot in a notebook's colour, or nothing when it has none.
const NbDot = ({ id }) => { const st = nbStyle(id); return st ? html`<span class="nb-dot" style=${st}></span>` : null; };

/* ---------------- panes & tabs ---------------- */
export function Pane({ pane, index }) {
  const tab = pane.tabs[pane.active];
  const isActive = S.ws.active === index;
  const [over, setOver] = useState(false);
  return html`<section class=${cls('pane', isActive && S.ws.panes.length > 1 && 'active')} data-pane=${index}
      onPointerDownCapture=${() => { if (S.ws.active !== index) { S.ws.active = index; emit(); } }}>
    <div class=${cls('tabbar', over && 'drop')} onDragOver=${(e) => { if (e.dataTransfer.types.includes('application/x-tab')) { e.preventDefault(); setOver(true); } }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { setOver(false); const d = e.dataTransfer.getData('application/x-tab'); if (!d) return; const [pi, ti] = d.split(':').map(Number); if (pi !== index) moveTab(pi, ti, index); }}>
      ${index === 0 && (!S.settings.sidebar || innerWidth < 760) && html`<button class="icon-btn" title=${`Show sidebar (${MOD}\\)`} aria-label="Show sidebar" onClick=${() => { if (innerWidth < 760) { S.ui.sidebarOpenMobile = true; emit(); } else setSettings({ sidebar: true }); }}><${Icon} name="sidebar" size=${17} /></button>`}
      <button class="icon-btn nav-btn" title=${`Back (${MOD}[)`} aria-label="Back" disabled=${!tab.back.length} onClick=${() => { S.ws.active = index; back(); }}><${Icon} name="left" size=${17} /></button>
      <button class="icon-btn nav-btn" title=${`Forward (${MOD}])`} aria-label="Forward" disabled=${!tab.fwd.length} onClick=${() => { S.ws.active = index; forward(); }}><${Icon} name="right" size=${17} /></button>
      <div class="tabs" role="tablist">
        ${pane.tabs.map((t, ti) => {
          const [title, icon] = titleFor(t.cur);
          return html`<div key=${t.id} role="tab" aria-selected=${ti === pane.active} class=${cls('tab', ti === pane.active && 'on')} style=${tabStyle(t.cur)} draggable="true" title=${title}
            onDragStart=${(e) => e.dataTransfer.setData('application/x-tab', `${index}:${ti}`)}
            onClick=${() => selectTab(index, ti)} onAuxClick=${(e) => e.button === 1 && closeTab(index, ti)}>
            <${Icon} name=${icon} size=${14} class="nb-ic" /><span class="tab-title">${title}</span>
            <button class="tab-x" aria-label=${'Close ' + title} onClick=${(e) => { e.stopPropagation(); closeTab(index, ti); }}><${Icon} name="x" size=${13} /></button>
          </div>`;
        })}
        <button class="icon-btn tiny new-tab" title=${`New tab (${ALT}T)`} aria-label="New tab" onClick=${() => { S.ws.active = index; newTabCmd(); }}><${Icon} name="plus" size=${15} /></button>
      </div>
      ${index === S.ws.panes.length - 1 && html`<button class=${cls('icon-btn', S.ws.panes.length > 1 && 'on')} title=${`Split view (${MOD}${SHIFT}\\)`} aria-label="Toggle split view" onClick=${toggleSplit}><${Icon} name="split" size=${17} /></button>`}
    </div>
    <div class="pane-body"><${View} key=${tab.cur} id=${tab.cur} pane=${index} /></div>
  </section>`;
}

function View({ id, pane }) {
  if (id === 'home') return html`<${Home} />`;
  if (id === 'settings') return html`<${Settings} />`;
  if (['inbox', 'all', 'trash'].includes(id) || id.startsWith('nb:') || id.startsWith('tag:')) return html`<${ListView} id=${id} pane=${pane} />`;
  const n = S.notes.get(id);
  if (!n) return html`<div class="empty-state"><${Icon} name="file" size=${32} /><h3>This note no longer exists</h3><p>It may have been deleted forever.</p><button class="btn" onClick=${() => open('home')}>Go home</button></div>`;
  return html`<${NoteView} note=${n} pane=${pane} />`;
}

/* ---------------- note view ---------------- */
function NoteView({ note, pane }) {
  const inspector = S.ws.inspector && innerWidth > 900;
  const bl = backlinks(note.id).length;
  const path = notebookPath(note.notebookId);
  const [title, setTitle] = useState(note.title);
  useEffect(() => setTitle(note.title), [note.id, note.rev]);
  const saveTitle = useMemo(() => debounce((t) => updateNote(note.id, { title: t }), 250), [note.id]);
  const crumbs = html`<div class="crumbs">${path.length > 0 && html`<${NbDot} id=${note.notebookId} />`}${path.length ? path.map((b, i) => html`${i > 0 && html`<span class="crumb-sep">/</span>`}<button class="crumb" onClick=${() => open('nb:' + b.id)}>${b.name}</button>`) : html`<button class="crumb" onClick=${() => open('inbox')}>Inbox</button>`}</div>`;
  const actions = html`<div class="note-actions">
      <button class=${cls('icon-btn', note.pinned && 'on')} title=${note.pinned ? 'Unpin' : 'Pin'} aria-label=${note.pinned ? 'Unpin' : 'Pin'} aria-pressed=${!!note.pinned} onClick=${() => togglePin(note.id)}><${Icon} name="pin" size=${17} /></button>
      <button class=${cls('btn ghost small links-btn', inspector && S.ws.inspectorTab === 'links' && 'on')} title=${`Backlinks and related notes (${MOD}${SHIFT}I)`} onClick=${() => setWs({ inspector: !(inspector && S.ws.inspectorTab === 'links'), inspectorTab: 'links' })}><${Icon} name="link" size=${16} />${bl}</button>
      <button class=${cls('icon-btn', inspector && S.ws.inspectorTab === 'history' && 'on')} title="Version history" aria-label="Version history" onClick=${() => setWs({ inspector: !(inspector && S.ws.inspectorTab === 'history'), inspectorTab: 'history' })}><${Icon} name="history" size=${17} /></button>
      <button class="icon-btn" title="More" aria-label="More actions" onClick=${(e) => openMenu(e, noteMenu(note), { align: 'right' })}><${Icon} name="more" size=${17} /></button>
  </div>`;
  return html`<div class=${cls('note-view', 'type-' + note.type)}>
    ${note.trashed && html`<div class="banner">This note is in the Trash.
      <button class="btn small" onClick=${() => restoreNote(note.id)}>Restore</button>
      <button class="btn small danger" onClick=${async () => { if (await confirmDialog('Delete forever?', 'This cannot be undone.', 'Delete forever', true)) destroyNote(note.id); }}>Delete forever</button></div>`}
    ${note.type !== 'page' && html`<header class="note-bar">
      <div class="bar-title">
        <${Icon} name=${typeIcon(note.type)} size=${17} />
        <input class="note-title-input" id=${'title-' + note.id} value=${title} placeholder=${note.type === 'pdf' ? 'Untitled PDF' : 'Untitled canvas'} aria-label="Title"
          onInput=${(e) => { setTitle(e.target.value); saveTitle(e.target.value); }} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); }} onBlur=${() => saveTitle.flush()} />
        <${NoteMeta} note=${note} compact />
      </div>
      <span class="spacer"></span>
      ${actions}
    </header>`}
    <div class="note-main">
      <div class="note-content">
        ${note.type === 'page' && html`<${PageEditor} note=${note} pane=${pane} crumbs=${crumbs} actions=${actions} />`}
        ${note.type === 'canvas' && html`<${CanvasView} note=${note} />`}
        ${note.type === 'pdf' && html`<${PdfView} note=${note} />`}
      </div>
      ${inspector && html`<${Inspector} note=${note} pane=${pane} />`}
    </div>
  </div>`;
}

/* ---------------- inspector ---------------- */
function Inspector({ note, pane }) {
  const tab = S.ws.inspectorTab;
  const tabs = [['links', 'Links'], note.type === 'page' && ['outline', 'Outline'], ['history', 'History'], ['info', 'Info']].filter(Boolean);
  return html`<aside class="inspector" aria-label="Note details">
    <div class="seg">
      ${tabs.map(([k, l]) => html`<button class=${cls(tab === k && 'on')} onClick=${() => setWs({ inspectorTab: k })}>${l}</button>`)}
      <button class="icon-btn tiny" aria-label="Close panel" onClick=${() => setWs({ inspector: false })}><${Icon} name="x" size=${14} /></button>
    </div>
    <div class="insp-body scroll">
      ${tab === 'links' && html`<${LinksPanel} note=${note} />`}
      ${tab === 'outline' && note.type === 'page' && html`<${OutlinePanel} note=${note} pane=${pane} />`}
      ${tab === 'history' && html`<${HistoryPanel} note=${note} />`}
      ${tab === 'info' && html`<${InfoPanel} note=${note} />`}
    </div>
  </aside>`;
}

function linkContext(src, targetId) {
  if (src.type === 'canvas') return 'Card on this canvas';
  if (src.type === 'pdf') return src.content.companionId === targetId ? 'Notes page for this PDF' : 'Mentioned in an annotation';
  const body = parseHTML(src.content.html || '');
  const a = body.querySelector(`a[data-note-id="${targetId}"]`);
  const blk = a?.closest('p,li,h1,h2,h3,blockquote,td');
  const t = (blk || a)?.textContent?.trim() || '';
  return t.length > 160 ? t.slice(0, 157) + '…' : t;
}
function NoteLink({ n, sub, extra }) {
  return html`<div class="link-card">
    <button class="link-main" onClick=${(e) => open(n.id, { split: mod(e) })} title="Open (hold ${MOD} to open beside)">
      <span class="link-title"><${Icon} name=${typeIcon(n.type)} size=${14} />${n.title || 'Untitled'}</span>
      ${sub && html`<span class="link-sub">${sub}</span>`}
    </button>${extra}
  </div>`;
}
function linkMention(src, target) {
  const body = parseHTML(src.content.html || '');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = w.nextNode())) {
    if (node.parentElement.closest('a,code,pre')) continue;
    const m = node.data.match(re);
    if (!m) continue;
    const start = m.index + m[1].length;
    const after = node.splitText(start);
    after.splitText(m[2].length);
    const a = document.createElement('a');
    a.className = 'wikilink'; a.setAttribute('data-note-id', target.id); a.setAttribute('href', '#' + target.id);
    a.textContent = after.data;
    after.replaceWith(a);
    flushAll();
    updateNote(src.id, { content: { html: body.innerHTML } }, { external: true });
    toast(`Linked in “${src.title || 'Untitled'}”`);
    return;
  }
  toast('Could not find the mention to link.');
}
function LinksPanel({ note }) {
  const bl = backlinks(note.id);
  const out = (note.links || []).map((id) => S.notes.get(id)).filter((n) => n && !n.trashed);
  const um = useMemo(() => unlinkedMentions(note).slice(0, 12), [note.id, note.title, S.rev >> 4]);
  const related = useMemo(() => {
    if (!note.tags?.length) return [];
    const linked = new Set([...bl.map((n) => n.id), ...out.map((n) => n.id), note.id]);
    return liveNotes().filter((n) => !linked.has(n.id)).map((n) => ({ n, s: (n.tags || []).filter((t) => note.tags.includes(t)).length })).filter((x) => x.s).sort((a, b) => b.s - a.s || b.n.updated - a.n.updated).slice(0, 6);
  }, [note.id, note.tags?.join()]);
  return html`
    <section class="insp-sec"><h4>Linked from <span class="count">${bl.length}</span></h4>
      ${bl.length ? bl.map((n) => html`<${NoteLink} n=${n} sub=${linkContext(n, note.id)} />`) : html`<p class="insp-empty">No notes link here yet. Type <kbd>[[</kbd> in another note to link to this one.</p>`}
    </section>
    <section class="insp-sec"><h4>Links to <span class="count">${out.length}</span></h4>
      ${out.length ? out.map((n) => html`<${NoteLink} n=${n} />`) : html`<p class="insp-empty">This note doesn't link to anything.</p>`}
    </section>
    ${um.length > 0 && html`<section class="insp-sec"><h4>Mentioned without a link <span class="count">${um.length}</span></h4>
      ${um.map((n) => html`<${NoteLink} n=${n} sub=${(() => { const i = n.text.toLowerCase().indexOf(note.title.toLowerCase()); return (i > 40 ? '…' : '') + n.text.slice(Math.max(0, i - 40), i + note.title.length + 60).replace(/\s+/g, ' ') + '…'; })()}
        extra=${n.type === 'page' && html`<button class="btn small ghost" onClick=${() => linkMention(n, note)}>Link</button>`} />`)}
    </section>`}
    ${related.length > 0 && html`<section class="insp-sec"><h4>Shares tags</h4>${related.map(({ n }) => html`<${NoteLink} n=${n} sub=${(n.tags || []).filter((t) => note.tags.includes(t)).map((t) => '#' + t).join(' ')} />`)}</section>`}
  `;
}
function OutlinePanel({ note, pane }) {
  const heads = [...parseHTML(note.content.html || '').querySelectorAll('h1,h2,h3')].map((h, i) => ({ i, level: +h.tagName[1], text: h.textContent.trim() })).filter((h) => h.text);
  const go = (i) => { const el = document.querySelectorAll(`.pane[data-pane="${pane}"] .editor :is(h1,h2,h3)`)[i]; el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return html`<section class="insp-sec">
    ${heads.length ? heads.map((h) => html`<button class=${'outline-row lvl' + h.level} onClick=${() => go(h.i)}>${h.text}</button>`) : html`<p class="insp-empty">Headings you add with <kbd>#</kbd>, <kbd>##</kbd> or <kbd>###</kbd> appear here.</p>`}
  </section>`;
}
function InfoPanel({ note }) {
  const rows = [
    ['Type', { page: 'Page', canvas: 'Canvas', pdf: 'PDF' }[note.type]],
    ['Notebook', nbPathString(note.notebookId) || 'Inbox'],
    ['Created', fmtDateTime(note.created)],
    ['Edited', fmtDateTime(note.updated)],
    ['Opened', note.opened ? fmtDateTime(note.opened) : '—'],
    note.type === 'page' && ['Words', note.words.toLocaleString()],
    note.type === 'page' && ['Characters', (note.text || '').length.toLocaleString()],
    note.type === 'canvas' && ['Cards', note.content.items.length],
    note.type === 'canvas' && ['Ink strokes', note.content.strokes.length],
    note.type === 'pdf' && ['Pages', note.content.pages],
    note.type === 'pdf' && ['Annotations', (note.content.ann || []).length],
    note.type === 'pdf' && ['File', note.content.fileName || '—'],
    ['Links', `${(note.links || []).length} out · ${backlinks(note.id).length} in`],
  ].filter(Boolean);
  return html`<section class="insp-sec"><dl class="info">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
    <button class="btn small" onClick=${() => moveNoteDialog(note.id)}><${Icon} name="move" size=${15} />Move to…</button></section>`;
}

function HistoryPanel({ note }) {
  const [versions, setVersions] = useState(null);
  const [open_, setOpen] = useState(null);
  useEffect(() => { let alive = true; listVersions(note.id).then((v) => alive && setVersions(v)); return () => { alive = false; }; }, [note.id, S.vrev]);
  if (!versions) return html`<p class="insp-empty">Loading history…</p>`;
  const groups = groupBy(versions, (v) => dayBucket(v.ts));
  return html`<section class="insp-sec">
    <button class="btn small full" onClick=${() => saveVersion(note.id)}><${Icon} name="save" size=${15} />Save a version now <kbd>${MOD}S</kbd></button>
    <p class="insp-hint">Marginalia also keeps a version automatically every ${S.settings.snapshotMinutes} minutes while you edit, and when you leave a note you changed.</p>
    ${!versions.length && html`<p class="insp-empty">No earlier versions yet.</p>`}
    ${[...groups.entries()].map(([g, vs]) => html`<div class="hist-group"><h5>${g}</h5>
      ${vs.map((v, i) => html`<button class="hist-row" onClick=${() => setOpen(v)}>
        <span class="hist-time">${new Date(v.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${g !== 'Today' && g !== 'Yesterday' ? ' · ' + new Date(v.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}</span>
        <span class=${'hist-kind ' + v.reason}>${v.reason === 'manual' ? v.label || 'Saved version' : v.reason === 'restore' ? 'Before restore' : v.reason === 'conflict' ? 'From another device' : 'Autosave'}</span>
        <span class="hist-words">${v.reason === 'conflict' ? 'Replaced by a newer edit' : v.type === 'pdf' ? `${(v.content.ann || []).length} marks` : v.type === 'canvas' ? `${v.content.items?.length || 0} cards` : `${(v.words || 0).toLocaleString()} words`}</span>
      </button>`)}
    </div>`)}
    ${open_ && html`<${VersionModal} v=${open_} note=${note} close=${() => setOpen(null)} />`}
  </section>`;
}
function VersionModal({ v, note, close }) {
  const [mode, setMode] = useState('changes');
  const vText = v.text ?? noteText(v);
  const parts = useMemo(() => diffWords(vText || '', note.text || ''), [v.id]);
  const added = parts.filter((p) => p.added).reduce((s, p) => s + p.value.split(/\s+/).filter(Boolean).length, 0);
  const removed = parts.filter((p) => p.removed).reduce((s, p) => s + p.value.split(/\s+/).filter(Boolean).length, 0);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()} onKeyDown=${(e) => e.key === 'Escape' && close()}>
    <div class="dialog version" role="dialog" aria-label="Version preview">
      <div class="version-head">
        <div><h2 class="dialog-title">${v.title || 'Untitled'}</h2><p class="dialog-msg">${fmtDateTime(v.ts)}${v.label ? ' · ' + v.label : ''}</p></div>
        <div class="seg small">
          <button class=${cls(mode === 'changes' && 'on')} onClick=${() => setMode('changes')}>Changes</button>
          <button class=${cls(mode === 'full' && 'on')} onClick=${() => setMode('full')}>This version</button>
        </div>
      </div>
      ${mode === 'changes' && html`<p class="diff-stat"><span class="add">+${added} words added</span> <span class="del">−${removed} words removed</span> since this version${v.title !== note.title ? html` · title was “${v.title}”` : ''}</p>`}
      <div class="version-body scroll">
        ${mode === 'changes'
          ? html`<div class="diff">${parts.map((p, i) => {
              if (p.added || p.removed) return html`<span class=${p.added ? 'ins' : 'del'}>${p.value}</span>`;
              const v = p.value;
              if (v.length < 420) return html`<span>${v}</span>`;
              // Long unchanged stretches are folded so the edits stand out.
              const head = i > 0 ? v.slice(0, 160) : '', tail = i < parts.length - 1 ? v.slice(-160) : '';
              return html`<span>${head}</span><span class="fold">⋯ ${(v.length - head.length - tail.length).toLocaleString()} unchanged characters ⋯</span><span>${tail}</span>`;
            })}</div>`
          : v.type === 'page' ? html`<div class="prose" dangerouslySetInnerHTML=${{ __html: v.content.html || '<p class="muted">Empty</p>' }}></div>`
          : html`<pre class="diff">${vText || '(no text)'}</pre>`}
      </div>
      <div class="dialog-actions">
        <button class="btn" onClick=${close}>Close</button>
        <button class="btn primary" onClick=${async () => { await restoreVersion(v); close(); }}><${Icon} name="restore" size=${15} />Restore this version</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- shared note list ---------------- */
function NoteCard({ n, showNb = true }) {
  const progress = n.type === 'pdf' && n.content.pages ? Math.round(((n.view?.page || 1) / n.content.pages) * 100) : null;
  const st = nbStyle(n.notebookId);
  return html`<button class=${cls('note-card t-' + n.type, st && 'has-nbc')} style=${st} draggable="true" onDragStart=${(e) => e.dataTransfer.setData('application/x-note-id', n.id)}
    onClick=${(e) => open(n.id, { split: mod(e) })} onContextMenu=${(e) => openMenu(e, noteMenu(n, { inList: true }), { at: 'pointer' })}>
    <span class="nc-type"><${Icon} name=${typeIcon(n.type)} size=${14} />${n.type === 'pdf' ? `PDF · p. ${n.view?.page || 1} of ${n.content.pages || '?'}` : n.type === 'canvas' ? 'Canvas' : 'Page'}${n.pinned ? html`<${Icon} name="pin" size=${12} class="pin-ic" />` : ''}</span>
    <span class="nc-title">${n.title || 'Untitled'}</span>
    <span class="nc-ex">${(n.text || '').slice(0, 140) || (n.type === 'canvas' ? `${n.content.items?.length || 0} cards` : '')}</span>
    ${progress !== null && html`<span class="nc-progress" aria-label=${`${progress}% read`}><span style=${`width:${progress}%`}></span></span>`}
    <span class="nc-foot">${showNb && html`<span class="nc-nb"><${NbDot} id=${n.notebookId} />${notebookPath(n.notebookId).map((b) => b.name).slice(-1)[0] || 'Inbox'}</span>`}<span>${fmtRelative(n.opened || n.updated)}</span></span>
  </button>`;
}
function NoteRowItem({ n, showNb, active, onFocus, trash }) {
  const ref = useRef();
  useEffect(() => { if (active) ref.current?.focus({ preventScroll: false }); }, [active]);
  return html`<div ref=${ref} tabIndex="-1" class=${cls('list-row', active && 'on')} draggable=${!trash} onDragStart=${(e) => e.dataTransfer.setData('application/x-note-id', n.id)}
    onClick=${(e) => !trash && open(n.id, { split: mod(e) })} onFocus=${onFocus}
    onContextMenu=${(e) => openMenu(e, noteMenu(n, { inList: true }), { at: 'pointer' })}>
    <span class="lr-icon"><${Icon} name=${typeIcon(n.type)} size=${17} /></span>
    <span class="lr-main">
      <span class="lr-title">${n.title || 'Untitled'}${n.pinned && html`<${Icon} name="pin" size=${12} class="pin-ic" />`}</span>
      <span class="lr-ex">${n.type === 'pdf' ? `${n.content.pages || '?'} pages · ${(n.content.ann || []).length} annotations` : (n.text || '').slice(0, 160) || html`<span class="muted">No text yet</span>`}</span>
    </span>
    <span class="lr-meta">
      ${(n.tags || []).slice(0, 3).map((t) => html`<span class="mini-tag">#${t}</span>`)}
      ${showNb && html`<span class="lr-nb"><${NbDot} id=${n.notebookId} />${nbPathString(n.notebookId) || 'Inbox'}</span>`}
      <span class="lr-time">${trash ? 'Deleted ' + fmtRelative(n.trashed) : fmtRelative(n.updated)}</span>
    </span>
    ${trash && html`<span class="lr-actions"><button class="btn small" onClick=${(e) => { e.stopPropagation(); restoreNote(n.id); }}>Restore</button>
      <button class="btn small ghost danger" onClick=${async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete “${n.title || 'Untitled'}” forever?`, 'This cannot be undone.', 'Delete forever', true)) destroyNote(n.id); }}>Delete</button></span>`}
  </div>`;
}

/* ---------------- list views ---------------- */
const SORTS = { edited: ['Last edited', (a, b) => b.updated - a.updated], opened: ['Last opened', (a, b) => (b.opened || 0) - (a.opened || 0)], title: ['Title', (a, b) => natCompare(a.title, b.title)], created: ['Created', (a, b) => b.created - a.created] };
function ListView({ id }) {
  const [filter, setFilter] = useState('');
  const [idx, setIdx] = useState(-1);
  const prefs = S.ws.listMode[id] || {};
  const sort = prefs.sort || (id.startsWith('nb:') ? 'title' : 'edited');
  const mode = prefs.mode || 'list';
  const setPref = (p) => { S.ws.listMode[id] = { ...prefs, ...p }; setWs({}); };
  let notes, title, icon, sub = null, nb = null, deep = false;
  const [showDeep, setShowDeep] = useState(() => { const b = id.startsWith('nb:') && S.notebooks.get(id.slice(3)); return !!b && childNotebooks(b.id).length > 0; });
  if (id === 'inbox') { notes = liveNotes().filter((n) => !n.notebookId); title = 'Inbox'; icon = 'inbox'; sub = 'Quick captures and notes that aren’t in a notebook yet. Drag them onto a notebook in the sidebar to file them.'; }
  else if (id === 'all') { notes = liveNotes(); title = 'All notes'; icon = 'layers'; }
  else if (id === 'trash') { notes = [...S.notes.values()].filter((n) => n.trashed).sort((a, b) => b.trashed - a.trashed); title = 'Trash'; icon = 'trash'; sub = 'Notes stay here until you delete them.'; }
  else if (id.startsWith('tag:')) { const t = id.slice(4); notes = liveNotes().filter((n) => n.tags?.includes(t)); title = '#' + t; icon = 'hash'; }
  else {
    nb = S.notebooks.get(id.slice(3));
    if (!nb) return html`<div class="empty-state"><h3>This notebook was deleted</h3><button class="btn" onClick=${() => open('home')}>Go home</button></div>`;
    deep = showDeep;
    const ids = new Set([nb.id, ...(deep ? descendants(nb.id) : [])]);
    notes = liveNotes().filter((n) => ids.has(n.notebookId));
    title = nb.name; icon = 'book';
  }
  if (id !== 'trash') notes = notes.sort(SORTS[sort][1]);
  if (filter.trim()) { const f = filter.toLowerCase(); notes = notes.filter((n) => (n.title || '').toLowerCase().includes(f) || (n.text || '').toLowerCase().includes(f)); }
  const kids = nb ? childNotebooks(nb.id) : [];
  const path = nb ? notebookPath(nb.id) : [];
  const showNb = !nb || deep;
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' && !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(idx + 1, notes.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(idx - 1, 0)); }
    if (e.key === 'Enter' && notes[Math.max(0, idx)]) { e.preventDefault(); open(notes[Math.max(0, idx)].id, { split: mod(e) }); }
  };
  let grouped;
  if (nb && deep && mode === 'list' && !filter) {
    // A class overview: notes grouped by section, in notebook order.
    const rel = (n) => notebookPath(n.notebookId).slice(path.length).map((b) => b.name).join(' / ');
    grouped = groupBy([...notes].sort((a, b) => natCompare(rel(a), rel(b))), (n) => rel(n) || 'In this notebook');
  } else grouped = sort === 'edited' && id !== 'trash' && mode === 'list' && !filter ? groupBy(notes, (n) => dayBucket(n.updated)) : new Map([['', notes]]);
  let k = -1;
  return html`<div class="list-view scroll" onKeyDown=${onKey}>
    <div class="list-inner">
      ${nb && path.length > 1 && html`<div class="crumbs">${path.slice(0, -1).map((b) => html`<button class="crumb" onClick=${() => open('nb:' + b.id)}>${b.name}</button><span class="crumb-sep">/</span>`)}</div>`}
      <header class="list-head">
        <h1 style=${nb ? nbStyle(nb.id) : ''}><${Icon} name=${icon} size=${24} class=${nb ? 'nb-ic' : ''} />${title}</h1>
        <span class="list-count">${notes.length} ${notes.length === 1 ? 'note' : 'notes'}</span>
        <span class="spacer"></span>
        ${id === 'trash' ? notes.length > 0 && html`<button class="btn danger small" onClick=${async () => { if (await confirmDialog('Empty the Trash?', `${notes.length} notes will be deleted forever.`, 'Empty Trash', true)) emptyTrash(); }}>Empty Trash</button>`
          : html`
            ${(nb || id === 'inbox') && html`<button class="btn small" onClick=${() => newPage(nb?.id || null)}><${Icon} name="page" size=${15} />Page</button>
              <button class="btn small" onClick=${() => newCanvas(nb?.id || null)}><${Icon} name="canvas" size=${15} />Canvas</button>
              <button class="btn small" onClick=${() => importPdfs(nb?.id || null)}><${Icon} name="pdf" size=${15} />PDF</button>`}
            ${id.startsWith('tag:') && html`<button class="btn small ghost" onClick=${async () => { const t = await promptDialog('Rename tag', id.slice(4), { confirmLabel: 'Rename' }); if (t) { renameTag(id.slice(4), t); open('tag:' + t.replace(/^#/, '').toLowerCase()); } }}>Rename tag</button>`}
            ${nb && html`<button class="icon-btn" aria-label="Notebook actions" onClick=${(e) => openMenu(e, notebookMenu(nb), { align: 'right' })}><${Icon} name="more" /></button>`}`}
      </header>
      ${sub && html`<p class="list-sub">${sub}</p>`}
      ${kids.length > 0 && html`<div class="nb-grid">
        ${kids.map((b) => html`<button class="nb-card" style=${nbStyle(b.id)} onClick=${(e) => open('nb:' + b.id, { split: mod(e) })} onContextMenu=${(e) => openMenu(e, notebookMenu(b), { at: 'pointer' })}>
          <${Icon} name="book" size=${18} /><span class="nb-name">${b.name}</span><span class="nb-meta">${countDeep(b.id)} notes${childNotebooks(b.id).length ? ` · ${childNotebooks(b.id).length} sections` : ''}</span></button>`)}
        <button class="nb-card add" onClick=${() => newNotebook(nb.id)}><${Icon} name="plus" size=${18} /><span class="nb-name">New section</span></button>
      </div>`}
      <div class="list-tools">
        <label class="filter"><${Icon} name="search" size=${15} /><input id=${'filter-' + id} placeholder="Filter these notes" value=${filter} onInput=${(e) => { setFilter(e.target.value); setIdx(-1); }} /></label>
        ${nb && kids.length > 0 && html`<label class="check"><input type="checkbox" id=${'deep-' + id} checked=${showDeep} onChange=${(e) => setShowDeep(e.target.checked)} />Include sections</label>`}
        <span class="spacer"></span>
        ${id !== 'trash' && html`<select class="select" id=${'sort-' + id} value=${sort} onChange=${(e) => setPref({ sort: e.target.value })} aria-label="Sort">${Object.entries(SORTS).map(([k2, [l]]) => html`<option value=${k2}>${l}</option>`)}</select>
        <div class="seg small icons">
          <button class=${cls(mode === 'list' && 'on')} aria-label="List view" title="List" onClick=${() => setPref({ mode: 'list' })}><${Icon} name="list" size=${15} /></button>
          <button class=${cls(mode === 'cards' && 'on')} aria-label="Card view" title="Cards" onClick=${() => setPref({ mode: 'cards' })}><${Icon} name="grid" size=${15} /></button>
        </div>`}
      </div>
      ${!notes.length && html`<div class="empty-inline">${filter ? 'No notes match that filter.' : id === 'trash' ? 'The Trash is empty.' : id === 'inbox' ? 'Inbox zero. Everything is filed.' : html`Nothing here yet. Create a page, a canvas, or drop a PDF onto this window.`}</div>`}
      ${mode === 'cards' && id !== 'trash'
        ? html`<div class="card-grid">${notes.map((n) => html`<${NoteCard} key=${n.id} n=${n} showNb=${showNb} />`)}</div>`
        : [...grouped.entries()].map(([g, ns]) => html`${g && html`<h3 class="group-h">${g}</h3>`}<div class="list">${ns.map((n) => { k++; const my = k; return html`<${NoteRowItem} key=${n.id} n=${n} showNb=${showNb} active=${idx === my} onFocus=${() => setIdx(my)} trash=${id === 'trash'} />`; })}</div>`)}
    </div>
  </div>`;
}

/* ---------------- home ---------------- */
function Home() {
  const live = liveNotes();
  const recent = recentNotes(8);
  const pinned = live.filter((n) => n.pinned).sort((a, b) => natCompare(a.title, b.title));
  const edited = [...live].sort((a, b) => b.updated - a.updated).slice(0, 14);
  const inbox = live.filter((n) => !n.notebookId).sort((a, b) => b.created - a.created);
  const pdfs = live.filter((n) => n.type === 'pdf');
  const reading = pdfs.filter((n) => n.content.pages > 1 && (n.view?.page || 1) > 1 && (n.view?.page || 1) < n.content.pages).sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, 4);
  const roots = childNotebooks(null);
  const [cap, setCap] = useState('');
  const saveCap = () => {
    const t = cap.trim();
    if (!t) return;
    const lines = t.split('\n');
    const tags = [...new Set((t.match(/(^|\s)#([\p{L}\p{N}_/-]+)/gu) || []).map((x) => x.trim().slice(1).toLowerCase()))];
    const body = lines.length > 1 ? lines.slice(1) : [];
    createNote({ title: lines[0].replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, '').trim().slice(0, 140) || 'Quick note', tags, content: { html: body.map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('') } });
    setCap('');
    toast('Saved to Inbox');
  };
  const hour = new Date().getHours();
  return html`<div class="home scroll">
    <div class="home-inner">
      <header class="home-head">
        <p class="eyebrow">${today()}</p>
        <h1>${hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}</h1>
        <p class="home-stats">${live.length} ${live.length === 1 ? 'note' : 'notes'} · ${pdfs.length} ${pdfs.length === 1 ? 'PDF' : 'PDFs'} · ${S.notebooks.size} ${S.notebooks.size === 1 ? 'notebook' : 'notebooks'}${inbox.length ? html` · <button class="linklike" onClick=${() => open('inbox')}>${inbox.length} in Inbox</button>` : ''}</p>
      </header>
      <div class="home-capture">
        <${Icon} name="bolt" size=${18} />
        <textarea id="home-capture" rows="1" placeholder="Capture a thought, a question, or a link. Enter saves it to your Inbox." value=${cap}
          onInput=${(e) => { setCap(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveCap(); } }}></textarea>
        <span class="hint">${SHIFT}↵ new line · #tag</span>
      </div>

      ${S.settings.homeSections.recent && recent.length > 0 && html`<section class="home-sec">
        <div class="sec-head"><h2>Jump back in</h2><button class="linklike" onClick=${() => open('all')}>All notes</button></div>
        <div class="card-grid">${recent.map((n) => html`<${NoteCard} key=${n.id} n=${n} />`)}</div>
      </section>`}

      ${reading.length > 0 && html`<section class="home-sec">
        <div class="sec-head"><h2>Keep reading</h2></div>
        <div class="reading-list">${reading.map((n) => { const p = n.view?.page || 1; return html`<button class="reading-row" onClick=${() => open(n.id, { page: p })}>
          <${Icon} name="pdf" size=${18} /><span class="rr-title">${n.title}</span><span class="rr-meta">Page ${p} of ${n.content.pages}</span>
          <span class="nc-progress"><span style=${`width:${Math.round((p / n.content.pages) * 100)}%`}></span></span></button>`; })}</div>
      </section>`}

      ${S.settings.homeSections.pinned && pinned.length > 0 && html`<section class="home-sec">
        <div class="sec-head"><h2>Pinned</h2></div>
        <div class="pin-row">${pinned.map((n) => html`<button class="pin-chip" onClick=${(e) => open(n.id, { split: mod(e) })}><${Icon} name=${typeIcon(n.type)} size=${15} />${n.title || 'Untitled'}</button>`)}</div>
      </section>`}

      <div class="home-cols">
        ${S.settings.homeSections.edited && html`<section class="home-sec">
          <div class="sec-head"><h2>Recently edited</h2></div>
          <div class="list compact">${[...groupBy(edited, (n) => dayBucket(n.updated)).entries()].map(([g, ns]) => html`<h3 class="group-h">${g}</h3>${ns.map((n) => html`<${NoteRowItem} key=${n.id} n=${n} showNb=${true} />`)}`)}</div>
          ${!edited.length && html`<p class="empty-inline">Nothing yet. Press ${ALT}N to start a page.</p>`}
        </section>`}
        <div>
          ${S.settings.homeSections.inbox && html`<section class="home-sec">
            <div class="sec-head"><h2>Inbox</h2>${inbox.length > 0 && html`<span class="count">${inbox.length}</span>`}</div>
            ${inbox.length ? html`<div class="inbox-list">${inbox.slice(0, 6).map((n) => html`<div class="inbox-row">
                <button class="ir-main" onClick=${() => open(n.id)}><span class="ir-title">${n.title || 'Untitled'}</span><span class="ir-time">${fmtRelative(n.created)}</span></button>
                <button class="btn small ghost" onClick=${() => moveNoteDialog(n.id)} title="File into a notebook"><${Icon} name="move" size=${15} />File</button></div>`)}
                ${inbox.length > 6 && html`<button class="linklike" onClick=${() => open('inbox')}>See all ${inbox.length}</button>`}</div>`
              : html`<p class="empty-inline">Inbox zero. Quick captures land here until you file them.</p>`}
          </section>`}
          ${S.settings.homeSections.notebooks && html`<section class="home-sec">
            <div class="sec-head"><h2>Notebooks</h2><button class="linklike" onClick=${() => newNotebook()}>New</button></div>
            <div class="nb-list">${roots.map((b) => {
              const last = liveNotes().filter((n) => [b.id, ...descendants(b.id)].includes(n.notebookId)).sort((x, y) => y.updated - x.updated)[0];
              return html`<button class="nb-line" style=${nbStyle(b.id)} onClick=${(e) => open('nb:' + b.id, { split: mod(e) })} onContextMenu=${(e) => openMenu(e, notebookMenu(b), { at: 'pointer' })}><${Icon} name="book" size=${16} class="nb-ic" /><span class="nb-name">${b.name}</span><span class="nb-meta">${countDeep(b.id)} · ${last ? fmtRelative(last.updated) : 'empty'}</span></button>`;
            })}</div>
          </section>`}
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------- settings ---------------- */
function Settings() {
  const st = S.settings;
  const [usage, setUsage] = useState(null);
  useEffect(() => { navigator.storage?.estimate?.().then(setUsage).catch(() => {}); }, []);
  const opt = (key, val, label) => html`<button class=${cls(st[key] === val && 'on')} onClick=${() => setSettings({ [key]: val })}>${label}</button>`;
  const sample = liveNotes().filter((n) => n.tags?.includes('sample'));
  return html`<div class="list-view scroll"><div class="list-inner settings">
    <header class="list-head"><h1><${Icon} name="settings" size=${24} />Settings</h1></header>
    <section class="set-sec"><h2>Appearance</h2>
      <div class="set-row"><div><b>Theme</b></div><div class="seg">${opt('theme', 'system', 'System')}${opt('theme', 'light', 'Light')}${opt('theme', 'dark', 'Dark')}</div></div>
      <div class="set-row"><div><b>Writing font</b><p>Used for page notes.</p></div><div class="seg">${opt('editorFont', 'sans', 'Sans')}${opt('editorFont', 'serif', 'Serif')}${opt('editorFont', 'mono', 'Mono')}</div></div>
      <div class="set-row"><div><b>PDF pages</b><p>Dark inverts the page colours for reading at night. Exports keep the original colours.</p></div><div class="seg">${opt('pdfTheme', 'light', 'Light')}${opt('pdfTheme', 'dark', 'Dark')}${opt('pdfTheme', 'auto', 'Match theme')}</div></div>
      <div class="set-row"><div><b>Page width</b></div><div class="seg">${opt('editorWidth', 'narrow', 'Narrow')}${opt('editorWidth', 'normal', 'Normal')}${opt('editorWidth', 'wide', 'Wide')}</div></div>
    </section>
    <section class="set-sec"><h2>Stylus and touch</h2>
      <div class="set-row"><div><b>Pen draws, finger scrolls</b><p>With a stylus, the pen writes on PDFs and sketches in any tool, and touch only scrolls or pans. This keeps your palm from leaving marks.</p></div>
        <label class="switch"><input type="checkbox" id="set-pen" checked=${st.penOnly} onChange=${(e) => setSettings({ penOnly: e.target.checked })} /><span></span></label></div>
    </section>
    <section class="set-sec"><h2>Writing</h2>
      <div class="set-row"><div><b>Formatting toolbar</b><p>Shows text styles, lists, links and code blocks above every page. When off, a smaller toolbar appears over selected text instead.</p></div>
        <label class="switch"><input type="checkbox" id="set-formatbar" checked=${st.formatBar} onChange=${(e) => setSettings({ formatBar: e.target.checked })} /><span></span></label></div>
      <div class="set-row"><div><b>Spellcheck</b></div><label class="switch"><input type="checkbox" id="set-spell" checked=${st.spellcheck} onChange=${(e) => setSettings({ spellcheck: e.target.checked })} /><span></span></label></div>
      <div class="set-row"><div><b>Automatic versions</b><p>How often Marginalia keeps a version while you edit a note.</p></div>
        <select class="select" id="set-snap" value=${st.snapshotMinutes} onChange=${(e) => setSettings({ snapshotMinutes: +e.target.value })}>${[2, 5, 10, 20, 30].map((m) => html`<option value=${m}>Every ${m} minutes</option>`)}</select></div>
    </section>
    <section class="set-sec"><h2>Home</h2>
      ${[['recent', 'Jump back in'], ['pinned', 'Pinned'], ['edited', 'Recently edited'], ['inbox', 'Inbox'], ['notebooks', 'Notebooks']].map(([k, l]) => html`<div class="set-row"><div><b>${l}</b></div>
        <label class="switch"><input type="checkbox" id=${'home-' + k} checked=${st.homeSections[k]} onChange=${(e) => setSettings({ homeSections: { ...st.homeSections, [k]: e.target.checked } })} /><span></span></label></div>`)}
    </section>
    <${SyncSettings} />
    <section class="set-sec"><h2>Your data</h2>
      <p class="set-note">${S.sync.state === 'off' ? 'Everything is stored in this browser on this device' : 'This browser keeps a full copy of your notes so the app works offline'}${S.persistent ? '' : ' — but storage is unavailable here, so changes will be lost when you close the page'}. ${S.sync.state === 'off' ? 'Back up regularly, especially before clearing browser data.' : 'A backup file is still useful as a second copy.'}
        ${usage && html` Using ${bytes(usage.usage || 0)}${usage.quota ? ` of ${bytes(usage.quota)} available` : ''}.`}</p>
      <div class="set-buttons">
        <button class="btn" onClick=${backupAll}><${Icon} name="download" size=${16} />Download full backup</button>
        <button class="btn" onClick=${async () => { const [f] = await pickFiles('.zip', false); if (f) restoreBackup(f); }}><${Icon} name="upload" size=${16} />Restore from backup</button>
        <button class="btn" onClick=${() => exportNotebookZip(null)}><${Icon} name="download" size=${16} />Export everything as Markdown + PDFs</button>
        <button class="btn" onClick=${() => importAny(null)}><${Icon} name="upload" size=${16} />Import files</button>
        <button class="btn" onClick=${() => importAny(null, true)}><${Icon} name="folder" size=${16} />Import a Markdown folder</button>
      </div>
      ${sample.length > 0 && html`<div class="set-row"><div><b>Sample notes</b><p>${sample.length} example notes about cell biology were added on first launch.</p></div>
        <button class="btn danger small" onClick=${async () => { if (await confirmDialog('Remove the sample notes?', 'They move to the Trash, along with the sample notebooks if they end up empty.', 'Remove samples', true)) { sample.forEach((n) => { n.trashed = Date.now(); db.put('notes', (({ text, links, words, rev, ...r }) => r)(n)); }); for (const b of [...S.notebooks.values()]) if (b.sample && !countDeep(b.id)) { S.notebooks.delete(b.id); db.del('notebooks', b.id); } emit(); toast('Sample notes moved to Trash'); } }}>Remove samples</button></div>`}
    </section>
    <section class="set-sec"><h2>About</h2><p class="set-note">Marginalia is a local-first notebook for studying. No accounts, no tracking, no AI. Press <kbd>${MOD}/</kbd> for keyboard shortcuts.</p></section>
  </div></div>`;
}

function SyncSettings() {
  const y = S.sync;
  const [tok, setTok] = useState(getToken());
  if (y.state === 'off') return html`<section class="set-sec"><h2>Sync</h2>
    <p class="set-note">Not connected to a sync server, so notes stay in this browser. To sync across devices, run the app with <code>serve.py</code> (see the README). It stores notes on your own machine and keeps every browser up to date.</p></section>`;
  const needsToken = y.state === 'token' || y.auth;
  return html`<section class="set-sec"><h2>Sync</h2>
    <div class="set-row"><div><b class=${'sync-state ' + y.state}>${SYNC_LABEL[y.state]}</b>
      <p>${y.error || (y.state === 'idle' ? `Notes are saved on your server and in this browser.${y.last ? ` Last synced ${fmtRelative(y.last)}.` : ''}` : y.state === 'offline' ? 'Changes are kept in this browser and will sync when the server is back.' : 'Notes are saved on your server and in this browser.')}
        ${y.pending ? ` ${y.pending} ${y.pending === 1 ? 'change is' : 'changes are'} waiting to upload.` : ''}</p></div>
      <button class="btn small" disabled=${y.state === 'syncing'} onClick=${() => syncNow()}><${Icon} name="refresh" size=${15} />Sync now</button></div>
    ${y.state === 'expired' && html`<div class="set-row"><div><b>Sign in again</b><p>Your Cloudflare Access session ended. Reloading the page takes you to the sign-in screen.</p></div><button class="btn small" onClick=${() => location.reload()}>Reload</button></div>`}
    ${needsToken && html`<div class="set-row"><div><b>Sync token</b><p>The server was started with a token. Enter the same value here, once per browser.</p></div>
      <form class="token-form" onSubmit=${(e) => { e.preventDefault(); setToken(tok); toast('Token saved'); }}>
        <input class="input" id="sync-token" type="password" autocomplete="off" value=${tok} placeholder="Token" onInput=${(e) => setTok(e.target.value)} />
        <button class="btn small primary" type="submit">Save</button></form></div>`}
  </section>`;
}
