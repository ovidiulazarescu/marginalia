import { useState, useEffect, loadPdfjs } from './lib.js';
import { db, initDB, persistent } from './db.js';
import { uid, now, htmlToText, wordCount, natCompare, debounce } from './util.js';
import * as search from './search.js';
import { sync, start as startSync, bootstrap as syncBootstrap, fetchFileBlob } from './sync.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', pdfTheme: 'light', formatBar: true, editorFont: 'sans', editorWidth: 'normal', penOnly: true, sidebar: true,
  spellcheck: true, snapshotMinutes: 10, homeSections: { recent: true, pinned: true, edited: true, inbox: true, notebooks: true },
};
const newTab = (cur) => ({ id: uid('t'), cur, back: [], fwd: [] });
const newPane = (cur) => ({ id: uid('p'), tabs: [newTab(cur)], active: 0 });

export const S = {
  ready: false,
  persistent: true,
  notes: new Map(),
  notebooks: new Map(),
  pdfText: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  ws: { panes: [newPane('home')], active: 0, inspector: false, inspectorTab: 'links', expanded: {}, tagsOpen: true, pinnedOpen: true, listMode: {} },
  ui: { palette: null, capture: null, dialog: null, toasts: [], help: false, sidebarOpenMobile: false },
  jump: {},
  sync,
  rev: 0,
};

/* ---------- reactivity ---------- */
const listeners = new Set();
let queued = false;
export function emit() {
  S.rev++;
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; listeners.forEach((l) => l()); });
}
export function useStore() {
  const [, set] = useState(0);
  const seen = S.rev;
  useEffect(() => {
    const l = () => set((x) => x + 1);
    listeners.add(l);
    if (S.rev !== seen) l(); // caught up on anything emitted before we subscribed
    return () => listeners.delete(l);
  }, []);
  return S;
}

/* ---------- persistence ---------- */
const pending = new Map();
export function persistNote(id, delay = 350) {
  clearTimeout(pending.get(id));
  pending.set(id, setTimeout(() => { pending.delete(id); const n = S.notes.get(id); if (n) db.put('notes', strip(n)); }, delay));
}
const strip = (n) => { const { text, links, words, rev, ...rest } = n; return rest; };
export function flushAll() {
  flushers.forEach((f) => f());
  const writes = [];
  for (const [id, t] of pending) { clearTimeout(t); const n = S.notes.get(id); if (n) writes.push(db.put('notes', strip(n))); }
  pending.clear();
  return Promise.all(writes);
}
// Editors register flush callbacks so pending keystrokes reach the store before navigation/export.
export const flushers = new Set();
const saveWs = debounce(() => db.put('kv', { key: 'ws', value: S.ws }), 300);
const saveSettings = () => db.put('kv', { key: 'settings', value: S.settings });
window.addEventListener('beforeunload', () => { flushAll(); saveWs.flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { flushAll(); saveWs.flush(); } });

/* ---------- derived note data ---------- */
export function findByTitle(title) {
  const t = (title || '').trim().toLowerCase();
  if (!t) return null;
  for (const n of S.notes.values()) if (!n.trashed && (n.title || '').trim().toLowerCase() === t) return n;
  return null;
}
const wikiRe = /\[\[([^\]\n]{1,200})\]\]/g;
function wikiLinks(text) { const ids = []; for (const m of text.matchAll(wikiRe)) { const n = findByTitle(m[1].split('|')[0]); if (n) ids.push(n.id); } return ids; }

export function noteText(n) {
  const c = n.content || {};
  if (n.type === 'page') return htmlToText(c.html || '');
  if (n.type === 'canvas') return (c.items || []).map((i) => (i.kind === 'note' ? '' : i.text || '')).filter(Boolean).join('\n');
  if (n.type === 'pdf') return (c.ann || []).map((a) => [a.text, a.comment].filter(Boolean).join(' — ')).filter(Boolean).join('\n');
  return '';
}
function noteLinks(n, text) {
  const c = n.content || {};
  let ids = [];
  if (n.type === 'page') for (const m of (c.html || '').matchAll(/data-note-id="([^"]+)"/g)) ids.push(m[1]);
  if (n.type === 'canvas') ids = (c.items || []).filter((i) => i.kind === 'note' && i.noteId).map((i) => i.noteId);
  if (n.type === 'pdf' && c.companionId) ids.push(c.companionId);
  ids.push(...wikiLinks(text));
  return [...new Set(ids)].filter((x) => x !== n.id);
}
function derive(n) {
  n.text = noteText(n);
  n.links = noteLinks(n, n.text);
  n.words = wordCount(n.text);
}
export function backlinks(id) {
  const out = [];
  for (const n of S.notes.values()) if (!n.trashed && n.links?.includes(id)) out.push(n);
  return out.sort((a, b) => b.updated - a.updated);
}
export function unlinkedMentions(note) {
  const t = (note.title || '').trim();
  if (t.length < 3) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu');
  const out = [];
  for (const n of S.notes.values()) {
    if (n.trashed || n.id === note.id || n.links?.includes(note.id)) continue;
    if (re.test(n.text || '')) out.push(n);
  }
  return out;
}

/* ---------- load ---------- */
export async function load() {
  await initDB();
  S.persistent = persistent;
  // A new device signed in to a sync server starts from the server's notes, not the samples.
  if (!(await db.get('kv', 'seeded')) && !(await db.all('notes')).length) {
    if ((await syncBootstrap()) && (await db.all('notes')).length) await db.put('kv', { key: 'seeded', value: true });
  }
  const [notes, nbs, kv, pdft] = await Promise.all([db.all('notes'), db.all('notebooks'), db.all('kv'), db.all('pdftext')]);
  for (const nb of nbs) S.notebooks.set(nb.id, nb);
  for (const n of notes) S.notes.set(n.id, n);
  for (const n of notes) derive(n); // second pass so wiki links resolve against all titles
  for (const p of pdft) S.pdfText.set(p.id, p.pages);
  const kvm = Object.fromEntries(kv.map((k) => [k.key, k.value]));
  if (kvm.settings) S.settings = { ...DEFAULT_SETTINGS, ...kvm.settings, homeSections: { ...DEFAULT_SETTINGS.homeSections, ...(kvm.settings.homeSections || {}) } };
  if (kvm.ws?.panes?.length) S.ws = { ...S.ws, ...kvm.ws };
  search.build([...S.notes.values()], S.pdfText);
  if (!kvm.seeded && !notes.length) {
    try { const { seed } = await import('./seed.js'); await seed(); } catch (e) { console.warn('seed failed', e); }
    db.put('kv', { key: 'seeded', value: true });
  }
  S.ready = true;
  applyTheme();
  emit();
  startSync({ emit, apply: applyRemote, flush: flushAll });
}

// Changes pulled from the sync server (already written to IndexedDB) applied to the live app.
export function applyRemote(changes) {
  let relink = false;
  for (const c of changes) {
    if (c.store === 'notes') {
      const old = S.notes.get(c.id);
      if (c.deleted) { S.notes.delete(c.id); search.remove(c.id); continue; }
      const n = { ...c.data };
      derive(n);
      const changed = !old || old.title !== n.title || JSON.stringify(old.content) !== JSON.stringify(n.content);
      n.rev = (old?.rev || 0) + (changed ? 1 : 0); // reloads open editors
      S.notes.set(n.id, n);
      search.upsert(n);
      if (!old || old.title !== n.title) relink = true;
    } else if (c.store === 'notebooks') {
      if (c.deleted) S.notebooks.delete(c.id); else S.notebooks.set(c.id, c.data);
    } else if (c.store === 'pdftext') {
      if (c.deleted) S.pdfText.delete(c.id);
      else { S.pdfText.set(c.id, c.data.pages); search.addPdf(c.id, c.data.pages); }
    } else if (c.store === 'versions') S.vrev = (S.vrev || 0) + 1;
  }
  if (relink) relinkByTitle();
  emit();
}

/* ---------- notes ---------- */
export const defaultContent = (type) => ({
  page: { html: '' },
  canvas: { items: [], strokes: [], edges: [], view: { x: 0, y: 0, z: 1 } },
  pdf: { fileId: null, pages: 0, ann: [], lastPage: 1 },
}[type]);

export function createNote({ id, type = 'page', title = '', notebookId = null, content, tags = [], pinned = false, silent } = {}) {
  const t = now();
  const n = { id: id || uid('n'), type, title, notebookId, tags, pinned, created: t, updated: t, opened: t, trashed: null, content: content ?? defaultContent(type), rev: 0 };
  derive(n);
  S.notes.set(n.id, n);
  db.put('notes', strip(n));
  search.upsert(n);
  // Titles of other notes may now resolve their [[links]].
  if (title) relinkByTitle();
  if (!silent) emit();
  return n;
}
const relinkByTitle = debounce(() => {
  let changed = false;
  for (const n of S.notes.values()) if (n.type !== 'page' || /\[\[/.test(n.text)) { const before = (n.links || []).join(); n.links = noteLinks(n, n.text); if (n.links.join() !== before) changed = true; }
  if (changed) emit();
}, 400);

const reindex = new Map();
function scheduleIndex(n) {
  clearTimeout(reindex.get(n.id));
  reindex.set(n.id, setTimeout(() => { reindex.delete(n.id); if (S.notes.has(n.id)) search.upsert(S.notes.get(n.id)); }, 500));
}

export function updateNote(id, patch, { external = false } = {}) {
  const n = S.notes.get(id);
  if (!n) return;
  const contentChanged = 'content' in patch;
  if (contentChanged) maybeSnapshotBefore(n);
  Object.assign(n, patch);
  if (contentChanged || 'title' in patch) {
    n.updated = now();
    derive(n);
    scheduleIndex(n);
    if ('title' in patch) relinkByTitle();
  } else if ('tags' in patch) scheduleIndex(n);
  if (external) n.rev = (n.rev || 0) + 1;
  persistNote(id);
  emit();
}

export function touchOpened(id) {
  const n = S.notes.get(id);
  if (!n) return;
  n.opened = now();
  persistNote(id, 1000);
}

export function trashNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  n.trashed = now();
  persistNote(id, 0);
  toast(`Moved “${n.title || 'Untitled'}” to Trash`, { label: 'Undo', run: () => restoreNote(id) });
  emit();
}
export function restoreNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  n.trashed = null;
  if (n.notebookId && !S.notebooks.has(n.notebookId)) n.notebookId = null;
  persistNote(id, 0);
  emit();
}
export async function destroyNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  S.notes.delete(id);
  search.remove(id);
  await db.del('notes', id);
  const vs = await db.byIndex('versions', 'noteId', id);
  await Promise.all(vs.map((v) => db.del('versions', v.id)));
  if (n.type === 'pdf') {
    S.pdfText.delete(id);
    await db.del('pdftext', id);
    const fid = n.content?.fileId;
    if (fid && ![...S.notes.values()].some((x) => x.content?.fileId === fid)) await db.del('files', fid);
  }
  emit();
}
export async function emptyTrash() {
  for (const n of [...S.notes.values()]) if (n.trashed) await destroyNote(n.id);
  toast('Trash emptied');
}
export function duplicateNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  const c = createNote({ type: n.type, title: `${n.title || 'Untitled'} copy`, notebookId: n.notebookId, tags: [...(n.tags || [])], content: structuredClone(n.content) });
  if (n.type === 'pdf' && S.pdfText.has(id)) { S.pdfText.set(c.id, S.pdfText.get(id)); db.put('pdftext', { id: c.id, pages: S.pdfText.get(id) }); search.addPdf(c.id, S.pdfText.get(id)); }
  return c;
}

/* ---------- version history ---------- */
const snapInfo = new Map();
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; };
const sigOf = (n) => hash(n.title + '\u0000' + JSON.stringify(n.content));
function maybeSnapshotBefore(n) {
  const info = snapInfo.get(n.id);
  if (!info || now() - info.ts > S.settings.snapshotMinutes * 60e3) snapshot(n.id, 'auto');
}
export function snapshotIfChanged(id) {
  const n = S.notes.get(id);
  const info = snapInfo.get(id);
  if (n && info && n.updated > info.ts) snapshot(id, 'auto');
}
export async function snapshot(id, reason = 'auto', label = '') {
  const n = S.notes.get(id);
  if (!n) return;
  const sig = sigOf(n);
  const v = { id: uid('v'), noteId: id, ts: now(), title: n.title, type: n.type, content: structuredClone(n.content), text: n.text, words: n.words, reason, label, sig };
  snapInfo.set(id, { ts: v.ts, sig });
  const vs = (await db.byIndex('versions', 'noteId', id)).sort((a, b) => b.ts - a.ts);
  if (vs[0] && vs[0].sig === sig && reason !== 'manual') return null;
  if (vs[0] && vs[0].sig === sig && reason === 'manual') { vs[0].reason = 'manual'; vs[0].label = label || vs[0].label; await db.put('versions', vs[0]); S.vrev = (S.vrev || 0) + 1; emit(); return vs[0]; }
  await db.put('versions', v);
  S.vrev = (S.vrev || 0) + 1; emit();
  const autos = vs.filter((x) => x.reason !== 'manual');
  for (const old of autos.slice(149)) db.del('versions', old.id);
  return v;
}
export const listVersions = async (id) => (await db.byIndex('versions', 'noteId', id)).sort((a, b) => b.ts - a.ts);
export async function restoreVersion(v) {
  const n = S.notes.get(v.noteId);
  if (!n) return;
  flushAll();
  await snapshot(n.id, 'restore', 'Before restoring');
  snapInfo.set(n.id, { ts: now(), sig: 0 });
  updateNote(n.id, { title: v.title, content: structuredClone(v.content) }, { external: true });
  toast(`Restored version from ${new Date(v.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`);
}

/* ---------- notebooks ---------- */
export function createNotebook(name, parentId = null) {
  const nb = { id: uid('b'), name: name || 'Untitled notebook', parentId, created: now() };
  S.notebooks.set(nb.id, nb);
  db.put('notebooks', nb);
  if (parentId) S.ws.expanded[parentId] = true;
  saveWs(); emit();
  return nb;
}
export function updateNotebook(id, patch) {
  const nb = S.notebooks.get(id);
  if (!nb) return;
  if ('parentId' in patch && (patch.parentId === id || descendants(id).includes(patch.parentId))) return;
  Object.assign(nb, patch);
  db.put('notebooks', nb);
  for (const n of S.notes.values()) if (n.notebookId && descendants(id).concat(id).includes(n.notebookId)) scheduleIndex(n);
  emit();
}
export function deleteNotebook(id) {
  const nb = S.notebooks.get(id);
  if (!nb) return;
  for (const c of S.notebooks.values()) if (c.parentId === id) { c.parentId = nb.parentId; db.put('notebooks', c); }
  for (const n of S.notes.values()) if (n.notebookId === id) { n.notebookId = nb.parentId; persistNote(n.id); }
  S.notebooks.delete(id);
  db.del('notebooks', id);
  emit();
}
export const childNotebooks = (parentId) => [...S.notebooks.values()].filter((b) => (b.parentId || null) === (parentId || null)).sort((a, b) => natCompare(a.name, b.name));
export function descendants(id) {
  const out = [];
  const walk = (p) => { for (const c of S.notebooks.values()) if (c.parentId === p) { out.push(c.id); walk(c.id); } };
  walk(id);
  return out;
}
export function notebookPath(id) {
  const out = [];
  let cur = S.notebooks.get(id);
  let guard = 0;
  while (cur && guard++ < 50) { out.unshift(cur); cur = S.notebooks.get(cur.parentId); }
  return out;
}
export const nbPathString = (id) => notebookPath(id).map((b) => b.name).join(' / ');
export const notesIn = (id) => [...S.notes.values()].filter((n) => !n.trashed && (n.notebookId || null) === (id || null));
export const countDeep = (id) => { const ids = new Set([id, ...descendants(id)]); let c = 0; for (const n of S.notes.values()) if (!n.trashed && ids.has(n.notebookId)) c++; return c; };
export const liveNotes = () => [...S.notes.values()].filter((n) => !n.trashed);
export function moveNote(id, notebookId) { updateNote(id, { notebookId: notebookId || null }); scheduleIndex(S.notes.get(id)); }

/* ---------- tags ---------- */
export function allTags() {
  const m = new Map();
  for (const n of S.notes.values()) if (!n.trashed) for (const t of n.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => natCompare(a[0], b[0]));
}
export const normTag = (t) => t.trim().replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
export function renameTag(from, to) {
  to = normTag(to);
  for (const n of S.notes.values()) if (n.tags?.includes(from)) updateNote(n.id, { tags: [...new Set(n.tags.map((t) => (t === from ? to : t)))] });
}

/* ---------- navigation ---------- */
export const activePane = () => S.ws.panes[S.ws.active] || S.ws.panes[0];
export const activeTab = (pi = S.ws.active) => { const p = S.ws.panes[pi]; return p.tabs[p.active]; };
export const currentId = () => activeTab()?.cur;
function leave(id) { if (S.notes.has(id)) { flushAll(); snapshotIfChanged(id); } }

export function open(target, opts = {}) {
  if (!target) return;
  if (opts.split) {
    if (S.ws.panes.length < 2) { S.ws.panes.push(newPane(target)); S.ws.active = 1; }
    else { S.ws.active = S.ws.active === 0 ? 1 : 0; go(S.ws.active, target); }
  } else if (opts.newTab) {
    const p = activePane();
    const ex = p.tabs.findIndex((t) => t.cur === target);
    if (ex >= 0) p.active = ex;
    else { p.tabs.splice(p.active + 1, 0, newTab(target)); p.active++; }
  } else {
    const pi = opts.pane ?? S.ws.active;
    S.ws.active = pi;
    const p = S.ws.panes[pi];
    const ex = p.tabs.findIndex((t) => t.cur === target);
    if (ex >= 0 && ex !== p.active) p.active = ex;
    else go(pi, target);
  }
  if (opts.page) S.jump[target] = { page: opts.page, ts: now() };
  if (opts.focus) S.jump[target] = { ...(S.jump[target] || {}), focus: opts.focus, ts: now() };
  touchOpened(target);
  S.ui.sidebarOpenMobile = false;
  saveWs(); emit();
}
function go(pi, target) {
  const p = S.ws.panes[pi];
  const tab = p.tabs[p.active];
  if (tab.cur === target) return;
  leave(tab.cur);
  tab.back.push(tab.cur);
  if (tab.back.length > 60) tab.back.shift();
  tab.fwd = [];
  tab.cur = target;
}
export function back() {
  const tab = activeTab();
  if (!tab.back.length) return;
  leave(tab.cur);
  tab.fwd.push(tab.cur); tab.cur = tab.back.pop();
  touchOpened(tab.cur); saveWs(); emit();
}
export function forward() {
  const tab = activeTab();
  if (!tab.fwd.length) return;
  leave(tab.cur);
  tab.back.push(tab.cur); tab.cur = tab.fwd.pop();
  touchOpened(tab.cur); saveWs(); emit();
}
export function newTabCmd(target = 'home') { open(target, { newTab: true }); }
export function selectTab(pi, ti) { const p = S.ws.panes[pi]; if (!p || !p.tabs[ti]) return; p.active = ti; S.ws.active = pi; touchOpened(p.tabs[ti].cur); saveWs(); emit(); }
export function closeTab(pi = S.ws.active, ti) {
  const p = S.ws.panes[pi];
  if (!p) return;
  ti ??= p.active;
  leave(p.tabs[ti]?.cur);
  p.tabs.splice(ti, 1);
  if (!p.tabs.length) {
    if (S.ws.panes.length > 1) { S.ws.panes.splice(pi, 1); S.ws.active = 0; }
    else p.tabs.push(newTab('home'));
  }
  p.active = Math.min(p.active > ti ? p.active - 1 : p.active, p.tabs.length - 1);
  saveWs(); emit();
}
export function moveTab(pi, ti, toPi) {
  const p = S.ws.panes[pi];
  const [t] = p.tabs.splice(ti, 1);
  if (toPi >= S.ws.panes.length) S.ws.panes.push({ id: uid('p'), tabs: [t], active: 0 });
  else { const q = S.ws.panes[toPi]; q.tabs.push(t); q.active = q.tabs.length - 1; }
  if (!p.tabs.length) { S.ws.panes.splice(pi, 1); } else p.active = Math.min(p.active, p.tabs.length - 1);
  S.ws.active = Math.min(toPi, S.ws.panes.length - 1);
  saveWs(); emit();
}
export function toggleSplit() {
  if (S.ws.panes.length > 1) {
    const [a, b] = S.ws.panes;
    for (const t of b.tabs) if (!a.tabs.some((x) => x.cur === t.cur)) a.tabs.push(t);
    S.ws.panes = [a]; S.ws.active = 0;
  } else {
    const cur = currentId();
    const recent = recentNotes(4).find((n) => n.id !== cur);
    S.ws.panes.push(newPane(recent?.id || 'home'));
    S.ws.active = 1;
  }
  saveWs(); emit();
}
// Jump to the previously viewed note (like Alt-Tab for notes).
export function previousNote() {
  const cur = currentId();
  const r = recentNotes(2).find((n) => n.id !== cur);
  if (r) open(r.id);
}
export const recentNotes = (k = 10) => liveNotes().sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, k);
export function setWs(patch) { Object.assign(S.ws, patch); saveWs(); emit(); }
export function setSettings(patch) { Object.assign(S.settings, patch); saveSettings(); applyTheme(); emit(); }
export const appIsDark = () => S.settings.theme === 'dark' || (S.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
// PDF pages can be shown light, dark, or following the app theme.
export const pdfIsDark = () => S.settings.pdfTheme === 'dark' || (S.settings.pdfTheme === 'auto' && appIsDark());
export function applyTheme() {
  const t = S.settings.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  document.documentElement.dataset.font = S.settings.editorFont;
  document.documentElement.dataset.width = S.settings.editorWidth;
}

/* ---------- ui helpers ---------- */
export function toast(msg, action) {
  const t = { id: uid('x'), msg, action };
  S.ui.toasts = [...S.ui.toasts.slice(-2), t];
  emit();
  setTimeout(() => { S.ui.toasts = S.ui.toasts.filter((x) => x !== t); emit(); }, action ? 6000 : 3200);
}
export function ask(opts) {
  return new Promise((resolve) => { S.ui.dialog = { ...opts, resolve: (v) => { S.ui.dialog = null; emit(); resolve(v); } }; emit(); });
}
export function openPalette(mode = 'search', extra = {}) { S.ui.palette = { mode, q: extra.q ?? (mode === 'command' ? '>' : ''), ...extra }; emit(); }
export function closePalette() { S.ui.palette = null; emit(); }
export function pickNote(opts = {}) { return new Promise((resolve) => openPalette('pick', { ...opts, resolve })); }
export function openCapture(opts = {}) { S.ui.capture = { ...opts }; emit(); }

/* ---------- PDFs ---------- */
const docCache = new Map();
export async function getFile(id) {
  let f = await db.get('files', id);
  if (!f?.blob) {
    // Uploaded from another device: download it once and keep a local copy.
    const blob = await fetchFileBlob(id);
    if (blob) { f = { ...(f || { id, name: 'document.pdf' }), size: blob.size, blob: new Blob([blob], { type: 'application/pdf' }) }; await db.put('files', f, { remote: true }); }
  }
  return f;
}
export function getPdfDoc(fileId) {
  if (docCache.has(fileId)) { const p = docCache.get(fileId); docCache.delete(fileId); docCache.set(fileId, p); return p; }
  const p = (async () => {
    const [pdfjs, f] = await Promise.all([loadPdfjs(), getFile(fileId)]);
    if (!f) throw new Error('The PDF file is missing from storage.');
    const data = new Uint8Array(await f.blob.arrayBuffer());
    return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  })();
  p.catch(() => docCache.delete(fileId));
  docCache.set(fileId, p);
  while (docCache.size > 5) { const [k, v] = docCache.entries().next().value; docCache.delete(k); v.then((d) => d.destroy()).catch(() => {}); }
  return p;
}
export async function importPdf(file, { notebookId = null, openIt = true, title } = {}) {
  const buf = await file.arrayBuffer();
  const fileId = uid('f');
  await db.put('files', { id: fileId, name: file.name, size: buf.byteLength, blob: new Blob([buf], { type: 'application/pdf' }) });
  const pdfjs = await loadPdfjs();
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise; }
  catch (e) { await db.del('files', fileId); toast(`Couldn't open ${file.name}: it may be damaged or password-protected.`); return null; }
  const n = createNote({ type: 'pdf', title: title || file.name.replace(/\.pdf$/i, ''), notebookId, content: { fileId, fileName: file.name, pages: doc.numPages, ann: [], lastPage: 1 } });
  if (openIt) open(n.id);
  extractText(doc, n.id).finally(() => doc.destroy());
  return n;
}
async function extractText(doc, noteId) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const pg = await doc.getPage(i);
      const tc = await pg.getTextContent();
      let s = '';
      for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : ' ');
      pages.push(s.replace(/[ \t]+/g, ' ').trim());
      pg.cleanup();
    } catch { pages.push(''); }
  }
  S.pdfText.set(noteId, pages);
  await db.put('pdftext', { id: noteId, pages });
  search.addPdf(noteId, pages);
  emit();
}
export { search };
