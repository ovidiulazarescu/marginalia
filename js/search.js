// Universal search: MiniSearch full-text index over notes and individual PDF pages,
// blended with a subsequence matcher on titles for fast switching.
import { MiniSearch } from './lib.js';
import { fuzzyScore, snippet } from './util.js';

let ms;
const pdfPages = new Map(); // noteId -> page count indexed

function make() {
  ms = new MiniSearch({
    fields: ['title', 'text', 'tags'],
    storeFields: ['noteId', 'page'],
    searchOptions: { prefix: true, boost: { title: 4, tags: 2 } },
    processTerm: (t) => t.toLowerCase().replace(/​/g, ''),
  });
}
make();

const docOf = (n) => ({ id: n.id, noteId: n.id, page: 0, title: n.title || '', text: n.text || '', tags: (n.tags || []).join(' ') });

export function build(notes, pdfText) {
  make(); pdfPages.clear();
  ms.addAll(notes.map(docOf));
  for (const [id, pages] of pdfText) addPdf(id, pages);
}
export function upsert(n) { if (ms.has(n.id)) ms.replace(docOf(n)); else ms.add(docOf(n)); }
export function remove(id) {
  if (ms.has(id)) ms.discard(id);
  removePdf(id);
}
export function addPdf(noteId, pages) {
  removePdf(noteId);
  const docs = [];
  pages.forEach((t, i) => { if (t && t.trim()) docs.push({ id: `${noteId}#${i + 1}`, noteId, page: i + 1, title: '', text: t, tags: '' }); });
  ms.addAll(docs);
  pdfPages.set(noteId, pages.length);
}
function removePdf(noteId) {
  const c = pdfPages.get(noteId);
  if (!c) return;
  for (let i = 1; i <= c; i++) { const id = `${noteId}#${i}`; if (ms.has(id)) ms.discard(id); }
  pdfPages.delete(noteId);
}

export function parseQuery(q) {
  const out = { text: '', tags: [], type: null, nb: null, pinned: false, terms: [] };
  const words = [];
  for (const tok of q.match(/\S+:"[^"]*"|"[^"]*"|\S+/g) || []) {
    let m;
    if ((m = tok.match(/^#(.+)/))) out.tags.push(m[1].toLowerCase());
    else if ((m = tok.match(/^type:(\w+)/i))) out.type = { note: 'page', page: 'page', pages: 'page', canvas: 'canvas', pdf: 'pdf', pdfs: 'pdf' }[m[1].toLowerCase()] || m[1];
    else if ((m = tok.match(/^(?:in|nb):"?([^"]*)"?/i))) out.nb = m[1].toLowerCase();
    else if (/^is:pinned$/i.test(tok)) out.pinned = true;
    else words.push(tok.replace(/^"|"$/g, ''));
  }
  out.text = words.join(' ');
  out.terms = words.flatMap((w) => w.split(/\s+/)).filter(Boolean);
  return out;
}

// ctx: { notes: Map, pdfText: Map, nbPath: (id)=>string }
export function query(q, ctx, limit = 40) {
  const p = parseQuery(q);
  const res = new Map();
  const pass = (n) => {
    if (!n || n.trashed) return false;
    if (p.type && n.type !== p.type) return false;
    if (p.pinned && !n.pinned) return false;
    if (p.tags.length && !p.tags.every((t) => (n.tags || []).some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(t + '/')))) return false;
    if (p.nb && !ctx.nbPath(n.notebookId).toLowerCase().includes(p.nb)) return false;
    return true;
  };
  if (p.text) {
    const hits = ms.search(p.text, { combineWith: 'AND', fuzzy: (t) => (t.length > 4 ? 0.18 : 0) });
    for (const h of hits) {
      const n = ctx.notes.get(h.noteId);
      if (!pass(n)) continue;
      let r = res.get(n.id);
      if (!r) res.set(n.id, (r = { note: n, score: 0, pages: [], terms: new Set() }));
      h.terms.forEach((t) => r.terms.add(t));
      if (h.page) { r.pages.push({ page: h.page, score: h.score }); r.score = Math.max(r.score, h.score * 0.9); }
      else r.score = Math.max(r.score, h.score);
    }
    for (const n of ctx.notes.values()) {
      const fs = fuzzyScore(p.text, n.title || 'Untitled');
      if (!fs || !pass(n)) continue;
      let r = res.get(n.id);
      if (!r) res.set(n.id, (r = { note: n, score: 0, pages: [], terms: new Set() }));
      r.score += fs * 0.35;
      r.titleHit = true;
    }
  } else {
    for (const n of ctx.notes.values()) if (pass(n)) res.set(n.id, { note: n, score: 0, pages: [], terms: new Set() });
  }
  const list = [...res.values()];
  list.sort((a, b) => b.score - a.score || (b.note.opened || b.note.updated) - (a.note.opened || a.note.updated));
  const terms = p.terms;
  return {
    parsed: p,
    total: list.length,
    results: list.slice(0, limit).map((r) => {
      const allTerms = [...terms, ...r.terms];
      r.pages.sort((a, b) => b.score - a.score);
      const page = r.pages[0]?.page;
      let snip = '';
      if (p.text) {
        if (page && !r.titleHit && !(r.note.text || '').toLowerCase().includes(terms[0]?.toLowerCase() || '\0')) snip = snippet(ctx.pdfText.get(r.note.id)?.[page - 1] || '', allTerms);
        else snip = snippet(r.note.text || '', allTerms);
      } else snip = (r.note.text || '').slice(0, 140);
      return { ...r, page, pageCount: r.pages.length, snippet: snip, terms: allTerms };
    }),
  };
}
