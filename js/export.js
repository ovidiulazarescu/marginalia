// Export (Markdown, HTML, Word, text, print-to-PDF, PNG/SVG, annotated PDF, ZIP) and import.
import { loadPdfLib, loadJSZip } from './lib.js';
import { S, getFile, flushAll, notebookPath, createNote, createNotebook, childNotebooks, importPdf, findByTitle, toast, liveNotes, nbPathString, open } from './store.js';
import { db } from './db.js';
import { htmlToMarkdown, mdToHTML, sanitizeHTML } from './md.js';
import { inkSVGString, strokePath, colorHex, strokeBounds } from './ink.js';
import { contentBounds, edgePath } from './canvas.js';
import { annBounds } from './pdfview.js';
import { download, safeName, escapeHtml, parseHTML, blobToDataURL, natCompare, inHostedArtifact } from './util.js';

const titleOf = (id) => S.notes.get(id)?.title || null;
const svgDataURI = (svg) => 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));

/* ---------- page notes ---------- */
export function pageToMarkdown(n, { frontMatter = true } = {}) {
  const fm = frontMatter ? `---\ntitle: "${(n.title || 'Untitled').replace(/"/g, '\\"')}"\n${n.tags?.length ? `tags: [${n.tags.join(', ')}]\n` : ''}${n.notebookId ? `notebook: "${nbPathString(n.notebookId)}"\n` : ''}created: ${new Date(n.created).toISOString()}\nupdated: ${new Date(n.updated).toISOString()}\n---\n\n` : '';
  return fm + `# ${n.title || 'Untitled'}\n\n` + htmlToMarkdown(n.content.html || '', { titleOf, ink: (j) => `![Sketch](${svgDataURI(inkSVGString(j, true))})` });
}
function pageBodyHTML(n) {
  const body = parseHTML(sanitizeHTML(n.content.html || ''));
  body.querySelectorAll('.ink-block').forEach((b) => { const f = document.createElement('figure'); f.className = 'sketch'; f.innerHTML = inkSVGString(b.getAttribute('data-ink'), true); b.replaceWith(f); });
  body.querySelectorAll('a.wikilink').forEach((a) => { const s = document.createElement('span'); s.className = 'wikilink'; s.textContent = a.textContent; a.replaceWith(s); });
  body.querySelectorAll('ul.tasks > li').forEach((li) => li.insertAdjacentHTML('afterbegin', li.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ '));
  body.querySelectorAll('img[data-w]').forEach((i) => { i.style.width = i.getAttribute('data-w') + '%'; });
  body.querySelectorAll('img[data-align="center"]').forEach((i) => { i.style.margin = '0 auto'; });
  return body.innerHTML;
}
const EXPORT_CSS = `body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1d2320;max-width:720px;margin:48px auto;padding:0 24px}
h1{font-size:2em;line-height:1.2;margin:0 0 .2em}h2{font-size:1.45em;margin:1.6em 0 .4em}h3{font-size:1.15em;margin:1.4em 0 .3em}
.meta{color:#6b746f;font-size:13px;margin-bottom:2em}blockquote{border-left:3px solid #cfd6d1;margin:1em 0;padding:.1em 1em;color:#4e5a53}
pre{background:#f2f4f2;padding:12px 14px;border-radius:8px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,monospace}code{background:#f2f4f2;padding:.1em .35em;border-radius:4px;font:.9em ui-monospace,Menlo,monospace}
pre code{background:none;padding:0}mark{background:#ffe58a;padding:0 .1em}.wikilink{color:#0f7b5f;font-weight:500}ul.tasks{list-style:none;padding-left:.4em}
.callout{background:#eef6f2;border-radius:8px;padding:.6em 1em;margin:1em 0}table{border-collapse:collapse}td,th{border:1px solid #dfe3e0;padding:6px 10px}img,svg{max-width:100%;height:auto}img{display:block}
figure.sketch{margin:1em 0;border:1px solid #e3e7e4;border-radius:8px}hr{border:0;border-top:1px solid #e3e7e4;margin:2em 0}@media print{body{margin:0}}`;
export function pageToHTMLDoc(n) {
  const meta = [n.notebookId && nbPathString(n.notebookId), n.tags?.map((t) => '#' + t).join(' '), new Date(n.updated).toLocaleDateString()].filter(Boolean).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(n.title || 'Untitled')}</title><style>${EXPORT_CSS}</style></head><body><article><h1>${escapeHtml(n.title || 'Untitled')}</h1><div class="meta">${escapeHtml(meta)}</div>${pageBodyHTML(n)}</article></body></html>`;
}
function printHTML(docHTML) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(docHTML); f.contentDocument.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { toast('Printing is blocked here. Export as HTML and print from your browser.'); } setTimeout(() => f.remove(), 2000); }, 300);
}

/* ---------- canvas ---------- */
const CARD_FILL = { none: '#ffffff', yellow: '#fff3b0', green: '#d9f2e3', blue: '#dbeafe', pink: '#fde0ea', purple: '#ebe3fb', gray: '#eceeed' };
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const t = line + w;
      if (ctx.measureText(t).width > maxW && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = t;
    }
    out.push(line);
  }
  return out;
}
async function loadImg(src) { return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }); }
function cardText(it) {
  if (it.kind === 'note') { const n = S.notes.get(it.noteId); return { title: n?.title || 'Missing note', body: (n?.text || '').slice(0, 200) }; }
  return { title: '', body: (it.text || '').replace(/\[\[([^\]]+)\]\]/g, '$1') };
}
export async function canvasToPNG(n, scale = 2) {
  const doc = n.content;
  const b = contentBounds(doc) || { x: 0, y: 0, w: 400, h: 300 };
  const pad = 48;
  const W = b.w + pad * 2, H = b.h + pad * 2;
  const k = Math.min(scale, 12000 / Math.max(W, H));
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(W * k); cv.height = Math.ceil(H * k);
  const ctx = cv.getContext('2d');
  ctx.scale(k, k);
  ctx.fillStyle = '#fbfbfa'; ctx.fillRect(0, 0, W, H);
  ctx.translate(pad - b.x, pad - b.y);
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  const font = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
  for (const it of doc.items.filter((i) => i.kind === 'frame')) {
    ctx.fillStyle = 'rgba(15,123,95,0.04)'; ctx.strokeStyle = '#b9c4be'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(it.x, it.y, it.w, it.h, 12); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#4e5a53'; ctx.font = `600 15px ${font}`; ctx.fillText(it.text || 'Frame', it.x + 4, it.y - 10);
  }
  ctx.strokeStyle = '#7d8a83'; ctx.lineWidth = 1.6; ctx.fillStyle = '#7d8a83';
  for (const e of doc.edges || []) {
    const a = byId.get(e.from), c = byId.get(e.to);
    if (!a || !c) continue;
    const p = edgePath(a, c);
    ctx.stroke(new Path2D(p.d));
    ctx.save(); ctx.translate(p.x2, p.y2); ctx.rotate(p.ang); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-10, -5); ctx.lineTo(-10, 5); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  for (const it of doc.items.filter((i) => i.kind !== 'frame')) {
    if (it.kind === 'image') { const img = await loadImg(it.src); if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h); continue; }
    ctx.fillStyle = CARD_FILL[it.kind === 'sticky' ? it.color || 'yellow' : it.color || 'none'] || '#fff';
    ctx.strokeStyle = '#dde2df'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(it.x, it.y, it.w, it.h, it.kind === 'sticky' ? 4 : 10); ctx.fill(); if (it.kind !== 'sticky') ctx.stroke();
    const { title, body } = cardText(it);
    let y = it.y + 14;
    ctx.save(); ctx.beginPath(); ctx.rect(it.x, it.y, it.w, it.h); ctx.clip();
    if (title) { ctx.fillStyle = '#1d2320'; ctx.font = `600 15px ${font}`; for (const l of wrapLines(ctx, title, it.w - 28).slice(0, 2)) { y += 18; ctx.fillText(l, it.x + 14, y); } y += 6; }
    ctx.fillStyle = title ? '#5b665f' : '#1d2320'; ctx.font = `${title ? 13 : 15}px ${font}`;
    const lh = title ? 18 : 21;
    for (const l of wrapLines(ctx, body, it.w - 28)) { y += lh; if (y > it.y + it.h - 6) break; ctx.fillText(l, it.x + 14, y); }
    ctx.restore();
  }
  for (const s of doc.strokes) {
    ctx.globalAlpha = s.tool === 'marker' ? 0.4 : 1;
    ctx.fillStyle = colorHex(s.color, false);
    ctx.fill(new Path2D(strokePath(s)));
  }
  ctx.globalAlpha = 1;
  return new Promise((res) => cv.toBlob(res, 'image/png'));
}
export function canvasToSVG(n) {
  const doc = n.content;
  const b = contentBounds(doc) || { x: 0, y: 0, w: 400, h: 300 };
  const pad = 48;
  const ctx = document.createElement('canvas').getContext('2d');
  const font = 'Helvetica, Arial, sans-serif';
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" font-family="${font}">`;
  out += `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7d8a83"/></marker></defs>`;
  out += `<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" fill="#fbfbfa"/>`;
  for (const it of doc.items.filter((i) => i.kind === 'frame')) out += `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="12" fill="rgba(15,123,95,0.04)" stroke="#b9c4be" stroke-dasharray="6 5"/><text x="${it.x + 4}" y="${it.y - 10}" font-size="15" font-weight="600" fill="#4e5a53">${escapeHtml(it.text || 'Frame')}</text>`;
  for (const e of doc.edges || []) { const a = byId.get(e.from), c = byId.get(e.to); if (a && c) out += `<path d="${edgePath(a, c).d}" fill="none" stroke="#7d8a83" stroke-width="1.6" marker-end="url(#ah)"/>`; }
  for (const it of doc.items.filter((i) => i.kind !== 'frame')) {
    if (it.kind === 'image') { out += `<image href="${it.src}" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}"/>`; continue; }
    out += `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="${it.kind === 'sticky' ? 4 : 10}" fill="${CARD_FILL[it.kind === 'sticky' ? it.color || 'yellow' : it.color || 'none'] || '#fff'}" stroke="${it.kind === 'sticky' ? 'none' : '#dde2df'}"/>`;
    const { title, body } = cardText(it);
    let y = it.y + 14;
    if (title) { ctx.font = `600 15px ${font}`; for (const l of wrapLines(ctx, title, it.w - 28).slice(0, 2)) { y += 18; out += `<text x="${it.x + 14}" y="${y}" font-size="15" font-weight="600" fill="#1d2320">${escapeHtml(l)}</text>`; } y += 6; }
    ctx.font = `${title ? 13 : 15}px ${font}`;
    for (const l of wrapLines(ctx, body, it.w - 28)) { y += title ? 18 : 21; if (y > it.y + it.h - 6) break; out += `<text x="${it.x + 14}" y="${y}" font-size="${title ? 13 : 15}" fill="${title ? '#5b665f' : '#1d2320'}">${escapeHtml(l)}</text>`; }
  }
  for (const s of doc.strokes) out += `<path d="${strokePath(s)}" fill="${colorHex(s.color, false)}"${s.tool === 'marker' ? ' opacity="0.4"' : ''}/>`;
  return out + '</svg>';
}

/* ---------- PDFs ---------- */
const hexRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const winAnsi = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
export async function annotatedPDF(n) {
  const [{ PDFDocument, rgb, StandardFonts, BlendMode }, f] = await Promise.all([loadPdfLib(), getFile(n.content.fileId)]);
  const pdf = await PDFDocument.load(await f.blob.arrayBuffer(), { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const a of n.content.ann || []) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const cb = page.getCropBox();
    const X = (x) => cb.x + x, Y = (y) => cb.y + cb.height - y;
    const col = rgb(...hexRgb(a.color === 'ink' ? '#1d2320' : a.color || '#ffd84d'));
    if (a.kind === 'hl') {
      for (const r of a.rects) {
        if (a.style === 'underline') page.drawRectangle({ x: X(r[0]), y: Y(r[1] + r[3]), width: r[2], height: 1.2, color: col });
        else if (a.style === 'strike') page.drawRectangle({ x: X(r[0]), y: Y(r[1] + r[3] / 2) - 0.6, width: r[2], height: 1.2, color: col });
        else page.drawRectangle({ x: X(r[0]), y: Y(r[1] + r[3]), width: r[2], height: r[3], color: col, opacity: 0.45, blendMode: BlendMode.Multiply });
      }
    } else if (a.kind === 'ink') {
      page.drawSvgPath(strokePath(a), { x: cb.x, y: cb.y + cb.height, color: col, opacity: a.tool === 'marker' ? 0.4 : 1, borderWidth: 0, ...(a.tool === 'marker' ? { blendMode: BlendMode.Multiply } : {}) });
    } else if (a.kind === 'text' && a.text) {
      const size = a.size || 13;
      page.drawText(winAnsi(a.text), { x: X(a.x + 4), y: Y(a.y + 3 + size), size, font, color: col, maxWidth: a.w - 8, lineHeight: size * 1.3 });
    }
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}
export function annotationsMarkdown(n) {
  const ann = [...(n.content.ann || [])].sort((a, b) => a.page - b.page || annBounds(a).y - annBounds(b).y);
  let s = `# ${n.title} — annotations\n\nSource: ${n.content.fileName || n.title + '.pdf'} · ${n.content.pages} pages · exported ${new Date().toLocaleDateString()}\n`;
  let pg = 0;
  for (const a of ann) {
    if (a.page !== pg) { pg = a.page; s += `\n## Page ${pg}\n\n`; }
    if (a.kind === 'hl') s += `> ${(a.text || '').trim()}\n${a.comment ? `\n${a.comment}\n` : ''}\n`;
    else if (a.kind === 'text') s += `- Note on page: ${a.text.replace(/\n/g, ' ')}\n`;
    else s += `- ${a.tool === 'marker' ? 'Highlighter mark' : 'Handwritten mark'}\n`;
  }
  return s;
}

/* ---------- single-note export entry point ---------- */
export const EXPORTS = {
  get page() { return [['md', 'Markdown (.md)'], ['html', 'Web page (.html)'], !inHostedArtifact() && ['doc', 'Word (.doc)'], ['txt', 'Plain text (.txt)'], !inHostedArtifact() && ['print', 'Print or save as PDF…']].filter(Boolean); },
  canvas: [['png', 'Image (.png)'], ['svg', 'Vector (.svg)'], ['md', 'Outline (.md)'], ['json', 'Canvas data (.json)']],
  pdf: [['pdf-annotated', 'PDF with annotations'], ['pdf-original', 'Original PDF'], ['md', 'Highlights and notes (.md)']],
};
export async function exportNote(n, fmt) {
  flushAll();
  const name = safeName(n.title);
  try {
    if (n.type === 'page') {
      if (fmt === 'md') download(name + '.md', pageToMarkdown(n), 'text/markdown');
      if (fmt === 'html') download(name + '.html', pageToHTMLDoc(n), 'text/html');
      if (fmt === 'doc') download(name + '.doc', pageToHTMLDoc(n).replace('<html>', '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">'), 'application/msword');
      if (fmt === 'txt') download(name + '.txt', `${n.title}\n\n${n.text}`, 'text/plain');
      if (fmt === 'print') printHTML(pageToHTMLDoc(n));
    } else if (n.type === 'canvas') {
      if (fmt === 'png') download(name + '.png', await canvasToPNG(n));
      if (fmt === 'svg') download(name + '.svg', canvasToSVG(n), 'image/svg+xml');
      if (fmt === 'json') download(name + '.canvas.json', JSON.stringify({ title: n.title, ...n.content }, null, 1), 'application/json');
      if (fmt === 'md') download(name + '.md', canvasOutline(n), 'text/markdown');
    } else if (n.type === 'pdf') {
      if (fmt === 'pdf-annotated') { toast('Preparing annotated PDF…'); download(name + ' (annotated).pdf', await annotatedPDF(n)); }
      if (fmt === 'pdf-original') { const f = await getFile(n.content.fileId); download(f.name || name + '.pdf', f.blob); }
      if (fmt === 'md') download(name + ' — annotations.md', annotationsMarkdown(n), 'text/markdown');
    }
  } catch (e) { console.error(e); toast(`Export failed: ${e.message || e}`); }
}
function canvasOutline(n) {
  const c = n.content;
  const frames = c.items.filter((i) => i.kind === 'frame');
  const inFrame = (i, f) => i.x >= f.x && i.y >= f.y && i.x + i.w <= f.x + f.w && i.y + i.h <= f.y + f.h;
  const line = (i) => i.kind === 'note' ? `- [[${titleOf(i.noteId) || 'Missing note'}]]` : i.kind === 'image' ? '- (image)' : `- ${(i.text || '').replace(/\n+/g, ' ')}`;
  let s = `# ${n.title}\n\n`;
  const used = new Set();
  for (const f of frames) { s += `## ${f.text || 'Frame'}\n\n`; c.items.filter((i) => i.kind !== 'frame' && inFrame(i, f)).sort((a, b) => a.y - b.y || a.x - b.x).forEach((i) => { used.add(i.id); s += line(i) + '\n'; }); s += '\n'; }
  const rest = c.items.filter((i) => i.kind !== 'frame' && !used.has(i.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (rest.length) s += (frames.length ? '## Other cards\n\n' : '') + rest.map(line).join('\n') + '\n';
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const label = (i) => i?.kind === 'note' ? titleOf(i.noteId) : (i?.text || '').split('\n')[0].slice(0, 60);
  if (c.edges?.length) s += '\n## Connections\n\n' + c.edges.map((e) => `- ${label(byId.get(e.from))} → ${label(byId.get(e.to))}`).join('\n') + '\n';
  return s;
}

/* ---------- ZIP: notebook export and full backup ---------- */
export async function exportNotebookZip(nbId) {
  flushAll();
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const ids = nbId ? new Set([nbId, ...descend(nbId)]) : null;
  const notes = liveNotes().filter((n) => !ids || ids.has(n.notebookId));
  const base = nbId ? notebookPath(nbId).length - 1 : 0;
  const used = new Set();
  const pathFor = (n, ext) => {
    const dir = notebookPath(n.notebookId).slice(base).map((b) => safeName(b.name)).join('/');
    let p = (dir ? dir + '/' : n.notebookId ? '' : 'Inbox/') + safeName(n.title) + ext, i = 2;
    while (used.has(p)) p = p.replace(/( \(\d+\))?(\.[^.]+)$/, ` (${i++})$2`);
    used.add(p);
    return p;
  };
  toast(`Exporting ${notes.length} notes…`);
  for (const n of notes) {
    if (n.type === 'page') zip.file(pathFor(n, '.md'), pageToMarkdown(n));
    else if (n.type === 'canvas') { zip.file(pathFor(n, '.png'), await canvasToPNG(n, 1.5)); zip.file(pathFor(n, '.canvas.md'), canvasOutline(n)); }
    else if (n.type === 'pdf') {
      try { zip.file(pathFor(n, '.pdf'), n.content.ann?.length ? await annotatedPDF(n) : (await getFile(n.content.fileId)).blob); } catch {}
      if (n.content.ann?.length) zip.file(pathFor(n, ' — annotations.md'), annotationsMarkdown(n));
    }
  }
  const name = nbId ? safeName(S.notebooks.get(nbId).name) : 'Marginalia export';
  download(name + '.zip', await zip.generateAsync({ type: 'blob' }));
}
function descend(id) { const out = []; const w = (p) => childNotebooks(p).forEach((b) => { out.push(b.id); w(b.id); }); w(id); return out; }

export async function backupAll() {
  flushAll();
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const [notes, notebooks, versions, pdftext, files] = await Promise.all([db.all('notes'), db.all('notebooks'), db.all('versions'), db.all('pdftext'), db.all('files')]);
  zip.file('marginalia.json', JSON.stringify({ app: 'marginalia', format: 1, exported: Date.now(), notes, notebooks, versions, pdftext, files: files.map(({ blob, ...f }) => f) }));
  for (const f of files) zip.file(`files/${f.id}.pdf`, f.blob);
  download(`Marginalia backup ${new Date().toISOString().slice(0, 10)}.zip`, await zip.generateAsync({ type: 'blob' }));
  toast('Backup downloaded');
}
export async function restoreBackup(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const meta = zip.file('marginalia.json');
  if (!meta) { toast("That ZIP isn't a Marginalia backup."); return false; }
  const data = JSON.parse(await meta.async('string'));
  const existing = new Map((await db.all('notes')).map((n) => [n.id, n]));
  let added = 0, updated = 0;
  for (const f of data.files || []) { const z = zip.file(`files/${f.id}.pdf`); if (z) await db.put('files', { ...f, blob: new Blob([await z.async('arraybuffer')], { type: 'application/pdf' }) }); }
  await db.putMany('notebooks', data.notebooks || []);
  const notes = (data.notes || []).filter((n) => { const e = existing.get(n.id); if (!e) { added++; return true; } if (n.updated > e.updated) { updated++; return true; } return false; });
  await db.putMany('notes', notes);
  await db.putMany('pdftext', data.pdftext || []);
  await db.putMany('versions', data.versions || []);
  toast(`Restored ${added} new and ${updated} updated notes. Reloading…`);
  setTimeout(() => location.reload(), 1200);
  return true;
}

/* ---------- import ---------- */
export async function importFiles(files, notebookId = null) {
  let count = 0, last = null;
  const folderCache = new Map();
  const folderFor = (rel) => {
    const parts = (rel || '').split('/').slice(0, -1);
    if (!parts.length) return notebookId;
    let parent = notebookId, key = '';
    for (const p of parts) {
      key += '/' + p;
      if (!folderCache.has(key)) {
        const ex = childNotebooks(parent).find((b) => b.name === p);
        folderCache.set(key, ex ? ex.id : createNotebook(p, parent).id);
      }
      parent = folderCache.get(key);
    }
    return parent;
  };
  const sorted = [...files].sort((a, b) => natCompare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
  for (const f of sorted) {
    const nb = folderFor(f.webkitRelativePath);
    const ext = f.name.split('.').pop().toLowerCase();
    if (f.name.startsWith('.')) continue;
    if (ext === 'zip') { await restoreBackup(f); return; }
    if (ext === 'pdf' || f.type === 'application/pdf') { last = await importPdf(f, { notebookId: nb, openIt: false }); count++; continue; }
    if (['md', 'markdown', 'txt', 'html', 'htm'].includes(ext)) {
      let text = await f.text();
      let title = f.name.replace(/\.[^.]+$/, '');
      let tags = [];
      let body;
      if (ext === 'html' || ext === 'htm') {
        const d = new DOMParser().parseFromString(text, 'text/html');
        title = d.querySelector('title')?.textContent?.trim() || d.querySelector('h1')?.textContent?.trim() || title;
        d.querySelector('h1')?.remove();
        body = sanitizeHTML(d.body.innerHTML);
      } else if (ext === 'txt') body = text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
      else {
        const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
        if (fm) {
          const t = fm[1].match(/^title:\s*"?(.+?)"?\s*$/m); if (t) title = t[1];
          const tg = fm[1].match(/^tags:\s*\[(.*)\]/m) || fm[1].match(/^tags:\s*(.+)$/m);
          if (tg) tags = tg[1].split(/[,\s]+/).map((x) => x.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
          text = text.slice(fm[0].length);
        }
        const h1 = text.match(/^\s*# (.+)\n/);
        if (h1) { title = h1[1].trim(); text = text.replace(h1[0], ''); }
        body = mdToHTML(text, findByTitle);
      }
      last = createNote({ type: 'page', title, notebookId: nb, tags, content: { html: body }, silent: true });
      count++;
    }
  }
  if (count) { toast(`Imported ${count} ${count === 1 ? 'note' : 'notes'}`); if (count === 1 && last) open(last.id); }
  else toast('Nothing to import. Marginalia reads PDF, Markdown, text, HTML and backup ZIP files.');
}
