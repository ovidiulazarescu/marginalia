import { html, useState } from './lib.js';
import { S, emit, open, setWs, setSettings, childNotebooks, notesIn, countDeep, allTags, liveNotes, currentId, openPalette, openCapture, moveNote, updateNotebook, importPdf, nbStyle } from './store.js';
import { Icon, typeIcon } from './icons.js';
import { openMenu } from './dialogs.js';
import { newPage, newCanvas, importPdfs, newNotebook, noteMenu, notebookMenu, importAny } from './actions.js';
import { TEMPLATES } from './templates.js';
import { importFiles } from './export.js';
import { cls, mod, natCompare, fmtRelative, MOD, ALT, SHIFT } from './util.js';

export const SYNC_LABEL = {
  checking: 'Connecting…', syncing: 'Syncing…', idle: 'Synced', offline: 'Offline', token: 'Needs sync token',
  expired: 'Sign-in expired', error: 'Sync problem', off: 'This device only',
};
function SyncDot() {
  const y = S.sync;
  if (y.state === 'off') return null;
  const tone = { idle: 'ok', syncing: 'busy', checking: 'busy', offline: 'warn', token: 'bad', expired: 'bad', error: 'bad' }[y.state];
  const label = y.state === 'idle' && y.pending ? `${y.pending} waiting` : SYNC_LABEL[y.state];
  const title = [label, y.last && `Last synced ${fmtRelative(y.last)}`, y.error].filter(Boolean).join(' · ');
  return html`<button class=${'sync-dot ' + tone} title=${title} aria-label=${'Sync: ' + title} onClick=${() => open('settings')}>
    <${Icon} name=${y.state === 'offline' || tone === 'bad' ? 'cloudOff' : 'cloud'} size=${16} /><span class="sd-label">${label}</span></button>`;
}

const dragNote = (e, id) => { e.dataTransfer.setData('application/x-note-id', id); e.dataTransfer.setData('text/plain', S.notes.get(id)?.title || ''); e.dataTransfer.effectAllowed = 'copyMove'; };
function dropHandlers(target, setOver) {
  return {
    onDragOver: (e) => { const t = e.dataTransfer.types; if (t.includes('application/x-note-id') || t.includes('application/x-nb-id') || t.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false);
      const nid = e.dataTransfer.getData('application/x-note-id');
      const bid = e.dataTransfer.getData('application/x-nb-id');
      if (nid || bid || e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); }
      if (nid) moveNote(nid, target);
      else if (bid && bid !== target) updateNotebook(bid, { parentId: target });
      else if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files], target);
    },
  };
}

// tint: colour the icon with the note's notebook colour (used for pinned notes, which sit outside their notebook).
function NoteRow({ n, depth = 0, cur, tint }) {
  return html`<a href=${'#' + n.id} draggable="true" class=${cls('sb-row note-row', cur === n.id && 'active')} style=${`--d:${depth};${tint ? nbStyle(n.notebookId) : ''}`}
    onDragStart=${(e) => dragNote(e, n.id)}
    onClick=${(e) => { e.preventDefault(); open(n.id, { split: mod(e), newTab: e.altKey }); }}
    onAuxClick=${(e) => { if (e.button === 1) { e.preventDefault(); open(n.id, { newTab: true }); } }}
    onContextMenu=${(e) => openMenu(e, noteMenu(n, { inList: true }), { at: 'pointer' })}>
    <${Icon} name=${typeIcon(n.type)} size=${15} class=${tint ? 'nb-ic' : ''} /><span class="sb-label">${n.title || 'Untitled'}</span>
  </a>`;
}

function NbNode({ nb, depth, cur }) {
  const [over, setOver] = useState(false);
  const exp = !!S.ws.expanded[nb.id];
  const kids = childNotebooks(nb.id);
  const notes = exp ? notesIn(nb.id).sort((a, b) => natCompare(a.title, b.title)) : [];
  const toggle = (e) => { e?.stopPropagation(); e?.preventDefault(); S.ws.expanded[nb.id] = !exp; setWs({}); };
  return html`<div class="sb-node">
    <a href=${'#nb:' + nb.id} draggable="true" class=${cls('sb-row nb-row', cur === 'nb:' + nb.id && 'active', over && 'drop')} style=${`--d:${depth};${nbStyle(nb.id)}`}
      onDragStart=${(e) => { e.dataTransfer.setData('application/x-nb-id', nb.id); e.dataTransfer.effectAllowed = 'move'; }}
      ...${dropHandlers(nb.id, setOver)}
      onClick=${(e) => { e.preventDefault(); open('nb:' + nb.id, { split: mod(e) }); if (!exp) toggle(); }}
      onContextMenu=${(e) => openMenu(e, notebookMenu(nb), { at: 'pointer' })}>
      <button class=${cls('chev', exp && 'open')} onClick=${toggle} aria-label=${exp ? 'Collapse' : 'Expand'} tabIndex="-1"><${Icon} name="chevron" size=${13} /></button>
      <${Icon} name="book" size=${15} class="nb-ic" /><span class="sb-label">${nb.name}</span><span class="sb-count">${countDeep(nb.id) || ''}</span>
    </a>
    ${exp && html`<div class="sb-children">
      ${kids.map((k) => html`<${NbNode} key=${k.id} nb=${k} depth=${depth + 1} cur=${cur} />`)}
      ${notes.map((n) => html`<${NoteRow} key=${n.id} n=${n} depth=${depth + 1} cur=${cur} />`)}
      ${!kids.length && !notes.length && html`<div class="sb-empty" style=${`--d:${depth + 1}`}>Empty. Drop notes here.</div>`}
    </div>`}
  </div>`;
}

export function Sidebar() {
  const cur = currentId();
  const [overInbox, setOverInbox] = useState(false);
  const [overRoot, setOverRoot] = useState(false);
  const live = liveNotes();
  const inbox = live.filter((n) => !n.notebookId).length;
  const pinned = live.filter((n) => n.pinned).sort((a, b) => natCompare(a.title, b.title));
  const tags = allTags();
  const trash = [...S.notes.values()].filter((n) => n.trashed).length;
  const dark = S.settings.theme === 'dark' || (S.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const newMenu = (e) => openMenu(e, [
    { label: 'Page', icon: 'page', kbd: `${ALT}N`, run: () => newPage() },
    { label: 'Canvas', icon: 'canvas', kbd: `${ALT}C`, run: () => newCanvas() },
    { label: 'Import PDF…', icon: 'pdf', kbd: `${ALT}P`, run: () => importPdfs() },
    { label: 'Notebook…', icon: 'book', run: () => newNotebook() },
    '-',
    { header: 'From a template' },
    ...TEMPLATES.map((t) => ({ label: t.label, icon: 'file', run: () => newPage(undefined, { template: t.id }) })),
    '-',
    { label: 'Import files…', icon: 'upload', run: () => importAny() },
    { label: 'Import a folder of Markdown…', icon: 'folder', run: () => importAny(undefined, true) },
  ]);
  const navRow = (id, icon, label, count, extra = {}) => html`<a href=${'#' + id} class=${cls('sb-row nav-row', cur === id && 'active', extra.over && 'drop')} onClick=${(e) => { e.preventDefault(); open(id, { split: mod(e) }); }} ...${extra.handlers || {}}>
    <${Icon} name=${icon} size=${16} /><span class="sb-label">${label}</span>${count ? html`<span class="sb-count">${count}</span>` : ''}</a>`;

  return html`<aside class=${cls('sidebar', S.ui.sidebarOpenMobile && 'mobile-open')} aria-label="Sidebar">
    <div class="sb-top">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>Marginalia</div>
      <button class="icon-btn" title=${`Hide sidebar (${MOD}\\)`} aria-label="Hide sidebar" onClick=${() => { if (innerWidth < 760) { S.ui.sidebarOpenMobile = false; emit(); } else setSettings({ sidebar: false }); }}><${Icon} name="sidebar" size=${17} /></button>
    </div>
    <button class="sb-search" onClick=${() => openPalette()}><${Icon} name="search" size=${16} /><span>Search</span><kbd>${MOD}K</kbd></button>
    <div class="sb-actions">
      <button class="btn primary sb-new" onClick=${() => newPage()} title=${`New page (${ALT}N)`}><${Icon} name="plus" size=${16} />New page</button>
      <button class="btn sb-more" onClick=${newMenu} aria-label="More ways to create" title="Canvas, PDF, notebook, templates, import"><${Icon} name="chevronDown" size=${16} /></button>
      <button class="btn sb-cap" onClick=${() => openCapture()} title=${`Quick capture (${MOD}${SHIFT}Space)`} aria-label="Quick capture"><${Icon} name="bolt" size=${16} /></button>
    </div>
    <nav class="sb-scroll">
      <div class="sb-group">
        ${navRow('home', 'home', 'Home')}
        ${navRow('inbox', 'inbox', 'Inbox', inbox, { over: overInbox, handlers: dropHandlers(null, setOverInbox) })}
        ${navRow('all', 'layers', 'All notes', live.length)}
      </div>
      ${pinned.length > 0 && html`<div class="sb-group">
        <button class="sb-head" onClick=${() => setWs({ pinnedOpen: !S.ws.pinnedOpen })}><${Icon} name=${S.ws.pinnedOpen ? 'chevronDown' : 'chevron'} size=${12} />Pinned</button>
        ${S.ws.pinnedOpen && pinned.map((n) => html`<${NoteRow} key=${n.id} n=${n} cur=${cur} tint />`)}
      </div>`}
      <div class="sb-group">
        <div class=${cls('sb-head-row', overRoot && 'drop')} ...${dropHandlers(null, setOverRoot)}>
          <span class="sb-head static">Notebooks</span>
          <button class="icon-btn tiny" title="New notebook" aria-label="New notebook" onClick=${() => newNotebook()}><${Icon} name="plus" size=${14} /></button>
        </div>
        ${childNotebooks(null).map((nb) => html`<${NbNode} key=${nb.id} nb=${nb} depth=${0} cur=${cur} />`)}
        ${!S.notebooks.size && html`<button class="sb-row muted" onClick=${() => newNotebook()}><${Icon} name="plus" size=${15} /><span class="sb-label">Create a notebook for a class</span></button>`}
      </div>
      ${tags.length > 0 && html`<div class="sb-group">
        <button class="sb-head" onClick=${() => setWs({ tagsOpen: !S.ws.tagsOpen })}><${Icon} name=${S.ws.tagsOpen ? 'chevronDown' : 'chevron'} size=${12} />Tags</button>
        ${S.ws.tagsOpen && html`<div class="tag-cloud">${tags.map(([t, c]) => html`<a href=${'#tag:' + t} class=${cls('tag-pill', cur === 'tag:' + t && 'active')} onClick=${(e) => { e.preventDefault(); open('tag:' + t, { split: mod(e) }); }}>#${t}<span>${c}</span></a>`)}</div>`}
      </div>`}
    </nav>
    <div class="sb-foot">
      ${navRow('trash', 'trash', 'Trash', trash)}
      <${SyncDot} />
      <div class="sb-foot-btns">
        <button class="icon-btn" title="Settings" aria-label="Settings" onClick=${() => open('settings')}><${Icon} name="settings" size=${17} /></button>
        <button class="icon-btn" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick=${() => { S.ui.help = true; emit(); }}><${Icon} name="keyboard" size=${17} /></button>
        <button class="icon-btn" title=${dark ? 'Light theme' : 'Dark theme'} aria-label="Toggle theme" onClick=${() => setSettings({ theme: dark ? 'light' : 'dark' })}><${Icon} name=${dark ? 'sun' : 'moon'} size=${17} /></button>
      </div>
    </div>
  </aside>`;
}
