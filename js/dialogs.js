import { html, useState, useEffect, useRef } from './lib.js';
import { S, emit, ask, childNotebooks, createNotebook, notebookPath, nbStyle } from './store.js';
import { Icon } from './icons.js';
import { cls, fuzzyScore, MOD, ALT, SHIFT, isMac } from './util.js';

/* ---------- context menus ---------- */
export function openMenu(e, items, opts = {}) {
  e?.preventDefault?.(); e?.stopPropagation?.();
  const r = e?.currentTarget?.getBoundingClientRect?.();
  const x = opts.at === 'pointer' || !r || e.type === 'contextmenu' ? e.clientX : r.left;
  const y = opts.at === 'pointer' || !r || e.type === 'contextmenu' ? e.clientY : r.bottom + 4;
  S.ui.menu = { x, y, items: items.filter(Boolean), align: opts.align };
  emit();
}
export function Menu() {
  const m = S.ui.menu;
  const ref = useRef();
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!m) return;
    const el = ref.current;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = m.align === 'right' ? m.x - w : m.x;
    setPos({ x: Math.max(8, Math.min(x, innerWidth - w - 8)), y: m.y + h > innerHeight - 8 ? Math.max(8, m.y - h - 8) : m.y });
    const close = (e) => { if (!el.contains(e.target)) { S.ui.menu = null; emit(); } };
    const key = (e) => { if (e.key === 'Escape') { S.ui.menu = null; emit(); } };
    setTimeout(() => { addEventListener('pointerdown', close, true); addEventListener('keydown', key, true); });
    return () => { removeEventListener('pointerdown', close, true); removeEventListener('keydown', key, true); setPos(null); };
  }, [m]);
  if (!m) return null;
  return html`<div class="menu popover" ref=${ref} role="menu" style=${pos ? `left:${pos.x}px;top:${pos.y}px` : `left:-999px;top:0`}>
    ${m.items.map((it) => it === '-' ? html`<div class="menu-sep"></div>` : it.header ? html`<div class="menu-head">${it.header}</div>` : it.swatches ? html`
      <div class="menu-nb-colors" role="group" aria-label=${it.label}>
        ${it.swatches.map(([key, name]) => html`<button role="menuitemradio" aria-checked=${it.value === key} title=${name} aria-label=${name}
          class=${cls('nb-swatch', !key && 'none', !key && it.inherit && 'inherit', it.value === key && 'on')} style=${key || it.inherit ? `--nbc:var(--nb-${key || it.inherit})` : ''}
          onClick=${() => { S.ui.menu = null; emit(); it.pick(key); }}></button>`)}
      </div>` : html`
      <button role="menuitem" class=${cls('menu-item', it.danger && 'danger', it.checked && 'checked')} disabled=${it.disabled}
        onClick=${() => { S.ui.menu = null; emit(); it.run?.(); }}>
        ${it.icon ? html`<${Icon} name=${it.icon} size=${16} />` : html`<span class="icon-space"></span>`}
        <span class="menu-label">${it.label}</span>
        ${it.checked && html`<${Icon} name="check" size=${15} />`}
        ${it.kbd && html`<kbd>${it.kbd}</kbd>`}
      </button>`)}
  </div>`;
}

/* ---------- toasts ---------- */
export function Toasts() {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${S.ui.toasts.map((t) => html`<div class="toast" key=${t.id}>
      <span>${t.msg}</span>
      ${t.action && html`<button onClick=${() => { t.action.run(); S.ui.toasts = S.ui.toasts.filter((x) => x !== t); emit(); }}>${t.action.label}</button>`}
    </div>`)}
  </div>`;
}

/* ---------- dialogs ---------- */
export const confirmDialog = (title, message, confirmLabel = 'Confirm', danger = false) => ask({ kind: 'confirm', title, message, confirmLabel, danger });
export const promptDialog = (title, value = '', opts = {}) => ask({ kind: 'prompt', title, value, ...opts });
export const pickNotebook = (title = 'Move to notebook', current) => ask({ kind: 'notebook', title, current });

export function Dialog() {
  const d = S.ui.dialog;
  if (!d) return null;
  const close = (v) => d.resolve(v);
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close(undefined)}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label=${d.title} onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), close(undefined))}>
      ${d.kind === 'confirm' && html`<${Confirm} d=${d} close=${close} />`}
      ${d.kind === 'prompt' && html`<${Prompt} d=${d} close=${close} />`}
      ${d.kind === 'notebook' && html`<${NotebookPicker} d=${d} close=${close} />`}
    </div>
  </div>`;
}
function Confirm({ d, close }) {
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  return html`<h2 class="dialog-title">${d.title}</h2>
    ${d.message && html`<p class="dialog-msg">${d.message}</p>`}
    <div class="dialog-actions">
      <button class="btn" onClick=${() => close(false)}>Cancel</button>
      <button ref=${ref} class=${cls('btn', d.danger ? 'danger' : 'primary')} onClick=${() => close(true)}>${d.confirmLabel}</button>
    </div>`;
}
function Prompt({ d, close }) {
  const [v, setV] = useState(d.value || '');
  const ref = useRef();
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return html`<form onSubmit=${(e) => { e.preventDefault(); close(v.trim() || (d.allowEmpty ? '' : undefined)); }}>
    <h2 class="dialog-title">${d.title}</h2>
    ${d.message && html`<p class="dialog-msg">${d.message}</p>`}
    <input id="dialog-input" ref=${ref} class="input" value=${v} placeholder=${d.placeholder || ''} onInput=${(e) => setV(e.target.value)} />
    <div class="dialog-actions">
      <button type="button" class="btn" onClick=${() => close(undefined)}>Cancel</button>
      <button type="submit" class="btn primary">${d.confirmLabel || 'Save'}</button>
    </div>
  </form>`;
}
function NotebookPicker({ d, close }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  const flat = [];
  const walk = (pid, depth) => childNotebooks(pid).forEach((b) => { flat.push({ b, depth, path: notebookPath(b.id).map((x) => x.name).join(' / ') }); walk(b.id, depth + 1); });
  walk(null, 0);
  let rows = [{ inbox: true, depth: 0, path: 'Inbox' }, ...flat];
  if (q.trim()) rows = rows.map((r) => ({ ...r, s: fuzzyScore(q, r.path) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
  const canCreate = q.trim() && !flat.some((r) => r.b.name.toLowerCase() === q.trim().toLowerCase());
  const choose = (r) => close(r.inbox ? null : r.b.id);
  const create = () => { const nb = createNotebook(q.trim()); close(nb.id); };
  const total = rows.length + (canCreate ? 1 : 0);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((idx + 1) % total); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((idx - 1 + total) % total); }
    if (e.key === 'Enter') { e.preventDefault(); if (idx < rows.length) choose(rows[idx]); else if (canCreate) create(); }
  };
  return html`<h2 class="dialog-title">${d.title}</h2>
    <input id="nb-filter" ref=${ref} class="input" placeholder="Filter or create a notebook" value=${q} onInput=${(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown=${onKey} />
    <div class="picker-list">
      ${rows.map((r, i) => html`<button class=${cls('picker-row', i === idx && 'on', (r.inbox ? d.current == null : d.current === r.b.id) && 'current')} style=${(q ? '' : `padding-left:${12 + r.depth * 18}px;`) + (r.inbox ? '' : nbStyle(r.b.id))} onClick=${() => choose(r)} onMouseEnter=${() => setIdx(i)}>
        <${Icon} name=${r.inbox ? 'inbox' : 'book'} size=${16} class="nb-ic" /><span>${q || r.inbox ? r.path : r.b.name}</span></button>`)}
      ${canCreate && html`<button class=${cls('picker-row', idx === rows.length && 'on')} onClick=${create}><${Icon} name="plus" size=${16} /><span>Create notebook “${q.trim()}”</span></button>`}
    </div>`;
}

/* ---------- keyboard help ---------- */
const K = (...k) => k;
export const SHORTCUTS = [
  ['Navigate', [
    [K(MOD, 'K'), 'Search and switch notes'],
    [K(MOD, SHIFT, 'P'), 'Command palette'],
    [K(ALT, '`'), 'Jump to previous note'],
    [K(MOD, '['), 'Back'], [K(MOD, ']'), 'Forward'],
    [K(ALT, 'T'), 'New tab'], [K(ALT, 'W'), 'Close tab'], [K(ALT, '1–9'), 'Go to tab'],
    [K(MOD, '\\'), 'Toggle sidebar'], [K(MOD, SHIFT, '\\'), 'Toggle split view'], [K(MOD, SHIFT, 'I'), 'Toggle links & history panel'],
    [K(MOD, 'click'), 'Open link in the other pane'],
  ]],
  ['Create', [
    [K(MOD, SHIFT, 'Space'), 'Quick capture'], [K(ALT, 'N'), 'New page'], [K(ALT, 'C'), 'New canvas'], [K(ALT, 'P'), 'Import PDF'],
    [K(MOD, 'S'), 'Save a named version'],
  ]],
  ['Write', [
    [K('/'), 'Insert block'], [K('[['), 'Link a note'], [K('#', 'Space'), 'Heading (## and ### too)'], [K('-', 'Space'), 'Bullet list'],
    [K('[]', 'Space'), 'Checklist'], [K('>', 'Space'), 'Quote'], [K('```'), 'Code block'], [K('==text=='), 'Highlight'],
    [K(MOD, ALT, '1–3'), 'Headings'], [K(MOD, SHIFT, '7/8/9'), 'Numbered / bullet / checklist'], [K(MOD, 'Enter'), 'Toggle checkbox · leave block'],
    [K(MOD, SHIFT, 'H'), 'Highlight'], [K(MOD, 'E'), 'Inline code'], [K(MOD, SHIFT, 'L'), 'Link selection to note'],
  ]],
  ['Canvas & PDF', [
    [K('V'), 'Select'], [K('H'), 'Hand / pan'], [K('P'), 'Pen'], [K('M'), 'Highlighter'], [K('E'), 'Eraser'], [K('T'), 'Text'],
    [K('S'), 'Sticky (canvas)'], [K('N'), 'Note card (canvas)'], [K('A'), 'Arrow (canvas)'], [K('F'), 'Frame (canvas)'],
    [K(MOD, 'Z'), 'Undo'], [K(MOD, SHIFT, 'Z'), 'Redo'], [K('Space', 'drag'), 'Pan'], [K(MOD, 'scroll'), 'Zoom'], [K(SHIFT, '1'), 'Zoom to fit'],
  ]],
];
export function Help() {
  if (!S.ui.help) return null;
  const close = () => { S.ui.help = false; emit(); };
  return html`<div class="scrim" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="dialog help" role="dialog" aria-label="Keyboard shortcuts">
      <div class="help-head"><h2 class="dialog-title">Keyboard shortcuts</h2><button class="icon-btn" onClick=${close} aria-label="Close"><${Icon} name="x" /></button></div>
      <div class="help-grid">
        ${SHORTCUTS.map(([group, rows]) => html`<section><h3>${group}</h3>
          ${rows.map(([keys, label]) => html`<div class="help-row"><span>${label}</span><span class="keys">${keys.map((k) => html`<kbd>${k}</kbd>`)}</span></div>`)}
        </section>`)}
      </div>
      <p class="help-foot">With a stylus, the pen draws in any tool and your finger scrolls. Change this in Settings.</p>
    </div>
  </div>`;
}
