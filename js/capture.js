// Quick capture: jot something down from anywhere, into the Inbox or onto the end of an existing note.
import { html, useState, useEffect, useRef } from './lib.js';
import { S, emit, createNote, updateNote, toast, recentNotes, currentId, pickNote, flushAll, open, nbStyle } from './store.js';
import { pickNotebook } from './dialogs.js';
import { Icon, typeIcon } from './icons.js';
import { cls, escapeHtml, mod, MOD, SHIFT } from './util.js';

const tagRe = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
export function QuickCapture() {
  const c = S.ui.capture;
  if (!c) return null;
  return html`<${CaptureInner} c=${c} />`;
}
function CaptureInner({ c }) {
  const curNote = S.notes.get(currentId());
  const defaultAppend = curNote && curNote.type === 'page' && !curNote.trashed ? curNote : recentNotes(10).find((n) => n.type === 'page');
  const [text, setText] = useState(c.text || '');
  const [mode, setMode] = useState('new');
  const [nb, setNb] = useState(null);
  const [target, setTarget] = useState(defaultAppend || null);
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  const close = () => { S.ui.capture = null; emit(); };
  const tags = [...new Set([...text.matchAll(tagRe)].map((m) => m[2].toLowerCase()))];
  const save = (openAfter = false) => {
    const t = text.trim();
    if (!t) { close(); return; }
    if (mode === 'append' && target) {
      flushAll();
      const n = S.notes.get(target.id);
      const stamp = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const body = `<p><em>Captured ${stamp}</em></p>` + t.split('\n').map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
      updateNote(n.id, { content: { html: (n.content.html || '').replace(/(<p><br><\/p>)+$/, '') + body }, tags: [...new Set([...(n.tags || []), ...tags])] }, { external: true });
      toast(`Added to “${n.title || 'Untitled'}”`);
      close();
      if (openAfter) open(n.id);
      return;
    }
    const lines = t.split('\n');
    const first = lines[0].replace(tagRe, '$1').trim();
    const title = first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '…' : first || 'Quick note';
    const rest = (first.length > 90 ? [first, ...lines.slice(1)] : lines.slice(1));
    const html_ = rest.map((l) => { const e = escapeHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>'); return `<p>${e || '<br>'}</p>`; }).join('');
    const n = createNote({ title, notebookId: nb, tags, content: { html: html_ } });
    toast(nb ? `Saved to ${S.notebooks.get(nb).name}` : 'Saved to Inbox', { label: 'Open', run: () => open(n.id) });
    close();
    if (openAfter) open(n.id);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter' && mod(e)) { e.preventDefault(); save(e.shiftKey); }
  };
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="dialog capture" role="dialog" aria-label="Quick capture" onKeyDown=${onKey}>
      <div class="cap-head">
        <span class="cap-title"><${Icon} name="bolt" size=${17} />Quick capture</span>
        <div class="seg small">
          <button class=${cls(mode === 'new' && 'on')} onClick=${() => setMode('new')}>New note</button>
          <button class=${cls(mode === 'append' && 'on')} onClick=${() => setMode('append')} disabled=${!target && !S.notes.size}>Add to a note</button>
        </div>
      </div>
      <textarea ref=${ref} id="capture-text" class="cap-text" rows="6" value=${text} onInput=${(e) => setText(e.target.value)}
        placeholder=${mode === 'new' ? 'The first line becomes the title. Add #tags anywhere.' : 'This is added to the end of the note, with a timestamp.'}></textarea>
      <div class="cap-row">
        ${mode === 'new'
          ? html`<button class="chip" style=${nbStyle(nb)} onClick=${async () => { const r = await pickNotebook('Save to', nb); if (r !== undefined) setNb(r); }}><${Icon} name=${nb ? 'book' : 'inbox'} size=${14} class="nb-ic" />${nb ? S.notebooks.get(nb)?.name : 'Inbox'}<${Icon} name="chevronDown" size=${13} /></button>`
          : html`<button class="chip" onClick=${async () => { const n = await pickNote({ title: 'Add to which note?' }); if (n) setTarget(n); S.ui.capture = c; emit(); }}><${Icon} name=${target ? typeIcon(target.type) : 'page'} size=${14} />${target ? target.title || 'Untitled' : 'Choose a note'}<${Icon} name="chevronDown" size=${13} /></button>`}
        ${tags.map((t) => html`<span class="chip tag static">#${t}</span>`)}
        <span class="spacer"></span>
        <span class="hint"><kbd>${MOD}↵</kbd> save · <kbd>${MOD}${SHIFT}↵</kbd> save and open</span>
      </div>
      <div class="dialog-actions">
        <button class="btn" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!text.trim() || (mode === 'append' && !target)} onClick=${() => save(false)}>Save</button>
      </div>
    </div>
  </div>`;
}
