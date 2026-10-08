export const uid = (p = '') => p + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 8);
export const now = () => Date.now();
export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const ALT = isMac ? '⌥' : 'Alt';
export const SHIFT = isMac ? '⇧' : 'Shift';
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const cls = (...a) => a.filter(Boolean).join(' ');
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const natCompare = (a, b) => collator.compare(a || '', b || '');

export function debounce(fn, ms) {
  let t, args;
  const d = (...a) => { args = a; clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export function isTyping(e) {
  const t = e.target;
  if (!t || !t.closest) return false;
  return !!t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

const parser = new DOMParser();
export function parseHTML(html) { return parser.parseFromString(`<body>${html || ''}</body>`, 'text/html').body; }

export function htmlToText(html) {
  const body = parseHTML(html);
  body.querySelectorAll('.ink-block svg').forEach((s) => s.remove());
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out.push(c.nodeValue);
      else if (c.nodeType === 1) {
        const block = /^(P|DIV|H1|H2|H3|LI|BLOCKQUOTE|PRE|TR|HR|FIGURE)$/.test(c.tagName);
        if (c.tagName === 'BR') out.push('\n');
        walk(c);
        if (block) out.push('\n');
        else if (c.tagName === 'TD' || c.tagName === 'TH') out.push(' \t ');
      }
    }
  };
  walk(body);
  return out.join('').replace(/​/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const wordCount = (t) => (t.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

const DAY = 864e5;
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 45e3) return 'just now';
  if (diff < 3600e3) return `${Math.round(diff / 60e3)} min ago`;
  const today = startOfDay(Date.now());
  if (ts >= today) return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString([], { weekday: 'long' });
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function dayBucket(ts) {
  const today = startOfDay(Date.now());
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return 'Earlier this week';
  if (ts >= today - 29 * DAY) return 'Earlier this month';
  return new Date(ts).toLocaleDateString([], { month: 'long', year: 'numeric' });
}
export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// Inside a hosted Claude artifact, files go through the viewer's save prompt;
// everywhere else a normal browser download is used.
let dlP;
const hostDownloads = () => (dlP ||= (window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null)));
export const inHostedArtifact = () => !!window.claude?.use;
export async function download(filename, data, type = 'application/octet-stream') {
  filename = filename.replace(/[\\/:*?"<>|]+/g, '-');
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const dl = await hostDownloads();
  if (dl) {
    try { await dl.save({ filename, data: blob }); }
    catch (e) {
      if (e?.code === 'declined') return;
      const { toast } = await import('./store.js');
      toast(e?.code === 'rejected_extension' || e?.code === 'extension_not_enabled' ? `This format can't be saved here. Try Markdown, HTML or PDF.` : `Couldn't save ${filename}.`);
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';

export function pickFiles(accept, multiple = true) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res([...i.files]);
    i.click();
  });
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
export async function dataURLToBlob(url) { return (await fetch(url)).blob(); }

// Downscale pasted/dropped images so notes stay light.
export async function imageToDataURL(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const png = file.type === 'image/png' || file.type === 'image/gif';
    return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Subsequence fuzzy score for quick switching ("lec4" → "Lecture 4").
export function fuzzyScore(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase(), t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 100 + q.length;
  if (idx > 0) return (/\W/.test(t[idx - 1]) ? 80 : 60) + q.length;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const f = t.indexOf(ch, ti);
    if (f < 0) return 0;
    streak = f === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (f === 0 || /\W/.test(t[f - 1]) ? 3 : 0);
    ti = f + 1;
  }
  return Math.min(55, score);
}

export function snippet(text, terms, len = 150) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { if (!t) continue; const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, len).replace(/\s+/g, ' ');
  const start = Math.max(0, at - 50);
  return (start > 0 ? '…' : '') + text.slice(start, start + len).replace(/\s+/g, ' ') + (start + len < text.length ? '…' : '');
}

export function highlightTerms(text, terms) {
  const safe = escapeHtml(text);
  const ts = terms.filter((t) => t && t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ts.length) return safe;
  return safe.replace(new RegExp(`(${ts.join('|')})`, 'gi'), '<mark>$1</mark>');
}

export const today = () => new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
