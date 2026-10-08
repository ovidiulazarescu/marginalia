import { html, useState, useRef } from './lib.js';
import { S, updateNote, notebookPath, allTags, normTag, open, moveNote } from './store.js';
import { pickNotebook } from './dialogs.js';
import { Icon } from './icons.js';
import { fmtRelative } from './util.js';

// Notebook location + tags, shown under page titles and in canvas/PDF headers.
export function NoteMeta({ note, compact }) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const ref = useRef();
  const path = notebookPath(note.notebookId);
  const move = async () => { const id = await pickNotebook('Move to notebook', note.notebookId); if (id !== undefined) moveNote(note.id, id); };
  const addTag = (t) => {
    t = normTag(t);
    if (t && !(note.tags || []).includes(t)) updateNote(note.id, { tags: [...(note.tags || []), t] });
    setVal('');
  };
  const known = allTags().map(([t]) => t).filter((t) => !(note.tags || []).includes(t) && (!val || t.includes(normTag(val)))).slice(0, 6);
  return html`<div class=${'note-meta' + (compact ? ' compact' : '')}>
    ${compact && html`<button class="chip loc" onClick=${move} title="Move to another notebook">
      <${Icon} name=${path.length ? 'book' : 'inbox'} size=${14} />
      ${path.length ? path.map((b, i) => html`${i > 0 && html`<span class="crumb-sep">/</span>`}<span>${b.name}</span>`) : html`<span>Inbox</span>`}
    </button>`}
    ${(note.tags || []).map((t) => html`<span class="chip tag">
      <button class="tag-open" onClick=${() => open('tag:' + t)} title=${'Show notes tagged #' + t}>#${t}</button>
      <button class="tag-x" aria-label=${'Remove tag ' + t} onClick=${() => updateNote(note.id, { tags: note.tags.filter((x) => x !== t) })}><${Icon} name="x" size=${12} /></button>
    </span>`)}
    ${adding
      ? html`<span class="tag-add-wrap"><input ref=${(r) => { ref.current = r; r && r.focus(); }} id=${'tag-in-' + note.id} class="tag-input" value=${val} placeholder="tag name"
          onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(val); } if (e.key === 'Escape') { setAdding(false); setVal(''); } if (e.key === 'Backspace' && !val && note.tags?.length) updateNote(note.id, { tags: note.tags.slice(0, -1) }); }}
          onBlur=${() => setTimeout(() => { if (val.trim()) addTag(val); setAdding(false); }, 120)} />
          ${known.length > 0 && html`<span class="tag-sugg">${known.map((t) => html`<button onMouseDown=${(e) => { e.preventDefault(); addTag(t); }}>#${t}</button>`)}</span>`}</span>`
      : html`<button class="chip ghost" onClick=${() => setAdding(true)}><${Icon} name="tag" size=${13} />Add tag</button>`}
    ${!compact && html`<span class="meta-time" title=${new Date(note.updated).toLocaleString()}>Edited ${fmtRelative(note.updated)}</span>`}
  </div>`;
}
