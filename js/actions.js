// Shared commands used by the sidebar, palette, list views and keyboard shortcuts.
import { S, createNote, open, importPdf, createNotebook, updateNotebook, deleteNotebook, trashNote, restoreNote, destroyNote, updateNote, duplicateNote, moveNote, snapshot, toast, setWs, notebookPath, currentId, countDeep, flushAll } from './store.js';
import { promptDialog, confirmDialog, pickNotebook } from './dialogs.js';
import { pickFiles } from './util.js';
import { TEMPLATES } from './templates.js';
import { exportNote, EXPORTS, exportNotebookZip, importFiles } from './export.js';

// New notes land in whatever notebook you're looking at.
export function contextNotebook() {
  const cur = currentId() || '';
  if (cur.startsWith('nb:')) return cur.slice(3);
  const n = S.notes.get(cur);
  return n && !n.trashed ? n.notebookId : null;
}
export function newPage(nb = contextNotebook(), opts = {}) {
  const t = opts.template && TEMPLATES.find((x) => x.id === opts.template);
  const n = createNote({ type: 'page', notebookId: nb, title: t ? t.title() : opts.title || '', content: { html: t ? t.html() : opts.html || '' } });
  open(n.id, { split: opts.split });
  return n;
}
export function newCanvas(nb = contextNotebook()) {
  const n = createNote({ type: 'canvas', notebookId: nb, title: '' });
  open(n.id);
  setTimeout(() => document.querySelector('.note-title-input')?.focus(), 60);
  return n;
}
export async function importPdfs(nb = contextNotebook()) {
  const files = await pickFiles('application/pdf,.pdf');
  let first = null;
  for (const f of files) { const n = await importPdf(f, { notebookId: nb, openIt: false }); first ||= n; }
  if (first) open(first.id);
}
export async function importAny(nb = contextNotebook(), folder = false) {
  const files = folder ? await pickFolder() : await pickFiles('.md,.markdown,.txt,.html,.htm,.pdf,.zip');
  if (files.length) importFiles(files, nb);
}
function pickFolder() {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.webkitdirectory = true; i.onchange = () => res([...i.files]); i.click(); });
}
export async function newNotebook(parentId = null) {
  const name = await promptDialog(parentId ? `New notebook inside “${S.notebooks.get(parentId)?.name}”` : 'New notebook', '', { placeholder: 'e.g. BIO 201, Chapter 3, or Reading list', confirmLabel: 'Create' });
  if (!name) return;
  const nb = createNotebook(name, parentId);
  open('nb:' + nb.id);
}
export async function renameNotebook(id) {
  const nb = S.notebooks.get(id);
  const name = await promptDialog('Rename notebook', nb.name, { confirmLabel: 'Rename' });
  if (name) updateNotebook(id, { name });
}
export async function removeNotebook(id) {
  const nb = S.notebooks.get(id);
  const c = countDeep(id);
  const ok = await confirmDialog(`Delete “${nb.name}”?`, c ? `Its ${c} notes and any sub-notebooks move up to ${nb.parentId ? `“${S.notebooks.get(nb.parentId)?.name}”` : 'the Inbox'}. No notes are deleted.` : 'This notebook is empty.', 'Delete notebook', true);
  if (ok) { deleteNotebook(id); if (currentId() === 'nb:' + id) open(nb.parentId ? 'nb:' + nb.parentId : 'home'); }
}
export async function moveNoteDialog(id) {
  const n = S.notes.get(id);
  const nb = await pickNotebook('Move to notebook', n.notebookId);
  if (nb !== undefined) { moveNote(id, nb); toast(`Moved to ${nb ? S.notebooks.get(nb).name : 'Inbox'}`); }
}
export async function renameNote(id) {
  const n = S.notes.get(id);
  const t = await promptDialog('Rename note', n.title, { confirmLabel: 'Rename' });
  if (t) updateNote(id, { title: t }, { external: true });
}
export async function saveVersion(id) {
  if (!id || !S.notes.has(id)) return;
  flushAll();
  const label = await promptDialog('Save a version', '', { placeholder: 'Optional label, e.g. “Before exam edits”', confirmLabel: 'Save version', allowEmpty: true });
  if (label === undefined) return;
  await snapshot(id, 'manual', label);
  toast('Version saved');
  S.ws.inspectorTab === 'history' && setWs({});
}
export function togglePin(id) { const n = S.notes.get(id); updateNote(id, { pinned: !n.pinned }); toast(n.pinned ? 'Pinned' : 'Unpinned'); }
export function showHistory() { setWs({ inspector: true, inspectorTab: 'history' }); }

export function noteMenu(n, { inList } = {}) {
  if (n.trashed) return [
    { label: 'Restore', icon: 'restore', run: () => restoreNote(n.id) },
    { label: 'Delete forever', icon: 'trash', danger: true, run: async () => { if (await confirmDialog(`Delete “${n.title || 'Untitled'}” forever?`, 'This removes the note and its version history. It cannot be undone.', 'Delete forever', true)) destroyNote(n.id); } },
  ];
  return [
    inList && { label: 'Open in new tab', icon: 'plus', run: () => open(n.id, { newTab: true }) },
    inList && { label: 'Open in split view', icon: 'split', run: () => open(n.id, { split: true }) },
    { label: n.pinned ? 'Unpin' : 'Pin', icon: n.pinned ? 'pinOff' : 'pin', run: () => togglePin(n.id) },
    { label: 'Rename…', icon: 'text', run: () => renameNote(n.id) },
    { label: 'Move to…', icon: 'move', run: () => moveNoteDialog(n.id) },
    { label: 'Duplicate', icon: 'duplicate', run: () => { const c = duplicateNote(n.id); if (c) open(c.id); } },
    '-',
    { header: 'Export' },
    ...EXPORTS[n.type].map(([f, l]) => ({ label: l, icon: 'download', run: () => exportNote(n, f) })),
    '-',
    !inList && { label: 'Version history', icon: 'history', run: showHistory },
    !inList && { label: 'Save a version…', icon: 'save', run: () => saveVersion(n.id) },
    { label: 'Move to Trash', icon: 'trash', danger: true, run: () => trashNote(n.id) },
  ];
}
export function notebookMenu(nb) {
  return [
    { label: 'New page here', icon: 'page', run: () => newPage(nb.id) },
    { label: 'New canvas here', icon: 'canvas', run: () => newCanvas(nb.id) },
    { label: 'Import PDF here…', icon: 'pdf', run: () => importPdfs(nb.id) },
    { label: 'New notebook inside…', icon: 'book', run: () => newNotebook(nb.id) },
    '-',
    { label: 'Rename…', icon: 'text', run: () => renameNotebook(nb.id) },
    { label: 'Move into…', icon: 'move', run: async () => { const p = await pickNotebook(`Move “${nb.name}” into`, nb.parentId); if (p !== undefined && p !== nb.id) updateNotebook(nb.id, { parentId: p }); } },
    { label: 'Export as ZIP', icon: 'download', run: () => exportNotebookZip(nb.id) },
    '-',
    { label: 'Delete notebook…', icon: 'trash', danger: true, run: () => removeNotebook(nb.id) },
  ];
}
