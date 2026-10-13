// HTML sanitising plus Markdown <-> HTML conversion for page notes.
import { parseHTML, escapeHtml } from './util.js';

const RENAME = { B: 'STRONG', I: 'EM', STRIKE: 'S', DEL: 'S', H4: 'H3', H5: 'H3', H6: 'H3', SECTION: 'DIV', ARTICLE: 'DIV', HEADER: 'DIV', FOOTER: 'DIV', MAIN: 'DIV', ASIDE: 'DIV', FIGURE: 'DIV' };
const KEEP = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'STRONG', 'EM', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'MARK', 'HR', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SUB', 'SUP', 'DIV']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE', 'HEAD', 'SVG', 'MATH', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'CANVAS', 'VIDEO', 'AUDIO']);
const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'TABLE', 'DIV']);

export function sanitizeHTML(html) {
  const src = parseHTML(html);
  const out = document.createElement('div');
  copyChildren(src, out);
  // Top-level stray inline content goes into paragraphs.
  let para = null;
  for (const c of [...out.childNodes]) {
    const isBlock = c.nodeType === 1 && BLOCK.has(c.tagName);
    if (isBlock) { para = null; continue; }
    if (c.nodeType === 3 && !c.data.trim() && !para) { c.remove(); continue; }
    if (!para) { para = document.createElement('p'); out.insertBefore(para, c); }
    para.appendChild(c);
  }
  return out.innerHTML;
}

function copyChildren(from, to) {
  for (const c of from.childNodes) {
    if (c.nodeType === 3) { to.appendChild(document.createTextNode(c.data)); continue; }
    if (c.nodeType !== 1) continue;
    let tag = c.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    const style = c.getAttribute('style') || '';
    if (tag === 'SPAN' || tag === 'FONT') {
      if (/background(-color)?:\s*(?!transparent|rgba\(0, 0, 0, 0\)|initial|inherit)/i.test(style)) tag = 'MARK';
      else if (/font-weight:\s*(bold|[6-9]00)/i.test(style)) tag = 'STRONG';
      else if (/font-style:\s*italic/i.test(style)) tag = 'EM';
      else { copyChildren(c, to); continue; }
    }
    if ((tag === 'B' || tag === 'STRONG') && /font-weight:\s*(normal|400)/i.test(style)) { copyChildren(c, to); continue; }
    tag = RENAME[tag] || tag;
    if (!KEEP.has(tag)) { copyChildren(c, to); continue; }
    if (tag === 'DIV') {
      const cl = c.classList;
      if (cl.contains('ink-block')) {
        const d = document.createElement('div');
        d.className = 'ink-block';
        d.setAttribute('contenteditable', 'false');
        d.setAttribute('data-ink', c.getAttribute('data-ink') || '{}');
        to.appendChild(d);
        continue;
      }
      if (cl.contains('callout')) { const d = document.createElement('div'); d.className = 'callout'; copyChildren(c, d); to.appendChild(d); continue; }
      const hasBlock = [...c.children].some((k) => BLOCK.has(k.tagName) || RENAME[k.tagName]);
      if (hasBlock) { copyChildren(c, to); continue; }
      tag = 'P';
    }
    const el = document.createElement(tag);
    if (tag === 'A') {
      const id = c.getAttribute('data-note-id');
      const href = c.getAttribute('href') || '';
      if (id) { el.className = 'wikilink'; el.setAttribute('data-note-id', id); el.setAttribute('href', '#' + id); const pg = c.getAttribute('data-page'); if (pg) el.setAttribute('data-page', pg); }
      else if (/^(https?:|mailto:)/i.test(href)) el.setAttribute('href', href);
      else { copyChildren(c, to); continue; }
    } else if (tag === 'IMG') {
      const s = c.getAttribute('src') || '';
      if (!/^(data:image\/|https?:)/i.test(s)) continue;
      el.setAttribute('src', s);
      if (c.getAttribute('alt')) el.setAttribute('alt', c.getAttribute('alt'));
    } else if (tag === 'UL' && c.classList.contains('tasks')) el.className = 'tasks';
    else if (tag === 'LI' && c.hasAttribute('data-checked')) el.setAttribute('data-checked', c.getAttribute('data-checked') === 'true' ? 'true' : 'false');
    else if (tag === 'OL' && c.getAttribute('start')) el.setAttribute('start', c.getAttribute('start'));
    else if (tag === 'PRE') {
      const lang = c.getAttribute('data-lang') || (c.querySelector('code[class*="language-"]')?.className.match(/language-([\w#+.-]+)/) || [])[1];
      if (lang && /^[\w#+.-]{1,20}$/.test(lang)) el.setAttribute('data-lang', lang.toLowerCase());
    }
    else if ((tag === 'TD' || tag === 'TH') && c.getAttribute('colspan')) el.setAttribute('colspan', c.getAttribute('colspan'));
    else if (tag === 'LI' && c.querySelector(':scope > input[type=checkbox]')) el.setAttribute('data-checked', c.querySelector('input').checked ? 'true' : 'false');
    copyChildren(c, el);
    if (tag === 'LI' && el.hasAttribute('data-checked') && to.tagName === 'UL') to.className = 'tasks';
    to.appendChild(el);
  }
}

/* ---------- Markdown -> HTML ---------- */
export function looksLikeMarkdown(t) {
  return /^(#{1,6} |[-*+] |\d+[.)] |> |```|- \[[ x]\] )/m.test(t) || /\*\*[^*]+\*\*|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)/.test(t);
}

function inlineMd(s, resolve) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => /^(https?:|data:image)/.test(u) ? `<img alt="${a}" src="${u}">` : '');
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, label) => {
    const n = resolve?.(t);
    return n ? `<a class="wikilink" data-note-id="${n.id}" href="#${n.id}">${label || escapeHtml(n.title || t)}</a>` : m;
  });
  s = s.replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

export function mdToHTML(md, resolve) {
  const lines = md.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const out = [];
  let i = 0;
  const isList = (l) => /^(\s*)([-*+]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const lang = (l.match(/^```\s*([\w#+.-]{1,20})/) || [])[1];
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre${lang ? ` data-lang="${lang.toLowerCase()}"` : ''}>${escapeHtml(buf.join('\n'))}</pre>`);
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { const n = Math.min(3, m[1].length); out.push(`<h${n}>${inlineMd(m[2], resolve)}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      const callout = buf[0]?.match(/^\[!(\w+)\]\s*(.*)/);
      if (callout) { buf[0] = callout[2]; out.push(`<div class="callout">${mdToHTML(buf.join('\n'), resolve)}</div>`); }
      else out.push(`<blockquote>${mdToHTML(buf.join('\n'), resolve)}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = (r, tag) => '<tr>' + r.replace(/^\||\|\s*$/g, '').split('|').map((c) => `<${tag}>${inlineMd(c.trim(), resolve)}</${tag}>`).join('') + '</tr>';
      let t = `<table><thead>${row(l, 'th')}</thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) t += row(lines[i++], 'td');
      out.push(t + '</tbody></table>');
      continue;
    }
    if (isList(l)) {
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const mm = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
        if (mm) items.push({ ind: mm[1].replace(/\t/g, '    ').length, ord: /\d/.test(mm[2]), text: mm[3] });
        else items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      out.push(buildList(items, 0, items.length, resolve));
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|.*\|\s*$)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${buf.map((b) => inlineMd(b, resolve)).join('<br>')}</p>`);
  }
  return out.join('');
}
function buildList(items, from, to, resolve) {
  if (from >= to) return '';
  const base = items[from].ind;
  const task = /^\[[ xX]\]\s/.test(items[from].text);
  const tag = items[from].ord ? 'ol' : 'ul';
  let h = `<${tag}${task && tag === 'ul' ? ' class="tasks"' : ''}>`;
  let i = from;
  while (i < to) {
    const it = items[i];
    let j = i + 1;
    while (j < to && items[j].ind > base) j++;
    let text = it.text, attr = '';
    const tm = text.match(/^\[([ xX])\]\s(.*)/);
    if (tm) { attr = ` data-checked="${tm[1] !== ' '}"`; text = tm[2]; }
    h += `<li${attr}>${inlineMd(text, resolve)}${buildList(items, i + 1, j, resolve)}</li>`;
    i = j;
  }
  return h + `</${tag}>`;
}

/* ---------- HTML -> Markdown ---------- */
export function htmlToMarkdown(html, { titleOf = () => null, ink = () => '' } = {}) {
  const body = parseHTML(html);
  const inline = (n) => {
    let s = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { s += c.data.replace(/\u200b/g, ''); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName, inner = () => inline(c);
      if (t === 'BR') s += '  \n';
      else if (t === 'STRONG' || t === 'B') s += wrap(inner(), '**');
      else if (t === 'EM' || t === 'I') s += wrap(inner(), '*');
      else if (t === 'S') s += wrap(inner(), '~~');
      else if (t === 'MARK') s += wrap(inner(), '==');
      else if (t === 'U') s += `<u>${inner()}</u>`;
      else if (t === 'CODE') s += '`' + c.textContent + '`';
      else if (t === 'SUB' || t === 'SUP') s += `<${t.toLowerCase()}>${inner()}</${t.toLowerCase()}>`;
      else if (t === 'IMG') s += `![${c.getAttribute('alt') || ''}](${c.getAttribute('src')})`;
      else if (t === 'A') {
        const id = c.getAttribute('data-note-id');
        if (id) { const title = titleOf(id) || c.textContent; s += title === c.textContent ? `[[${title}]]` : `[[${title}|${c.textContent}]]`; }
        else s += `[${inner()}](${c.getAttribute('href')})`;
      } else if (t === 'UL' || t === 'OL') { /* handled by list */ }
      else s += inner();
    }
    return s;
  };
  const wrap = (s, m) => { const t = s.trim(); return t ? s.replace(t, m + t + m) : s; };
  const list = (el, depth) => {
    let s = '', i = Number(el.getAttribute('start') || 1);
    for (const li of el.children) {
      if (li.tagName !== 'LI') { if (/^(UL|OL)$/.test(li.tagName)) s += list(li, depth + 1); continue; }
      const pad = '  '.repeat(depth);
      const mark = el.tagName === 'OL' ? `${i++}. ` : li.hasAttribute('data-checked') ? `- [${li.getAttribute('data-checked') === 'true' ? 'x' : ' '}] ` : '- ';
      const clone = li.cloneNode(true);
      clone.querySelectorAll(':scope > ul, :scope > ol').forEach((x) => x.remove());
      s += pad + mark + inline(clone).trim() + '\n';
      for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) s += list(sub, depth + 1);
    }
    return s;
  };
  const block = (n) => {
    let s = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (c.data.trim()) s += c.data.trim() + '\n\n'; continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) s += '#'.repeat(+t[1]) + ' ' + inline(c).trim() + '\n\n';
      else if (t === 'P') s += inline(c).trim() + '\n\n';
      else if (t === 'UL' || t === 'OL') s += list(c, 0) + '\n';
      else if (t === 'BLOCKQUOTE') s += block(c).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      else if (t === 'PRE') s += '```' + (c.getAttribute('data-lang') || '') + '\n' + preText(c).replace(/\n$/, '') + '\n```\n\n';
      else if (t === 'HR') s += '---\n\n';
      else if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map((r) => '| ' + [...r.children].map((x) => inline(x).trim().replace(/\|/g, '\\|').replace(/ {2}\n/g, ' ')).join(' | ') + ' |');
        if (rows.length) { const cols = c.querySelector('tr').children.length; rows.splice(1, 0, '|' + ' --- |'.repeat(cols)); }
        s += rows.join('\n') + '\n\n';
      } else if (t === 'DIV' && c.classList.contains('ink-block')) s += ink(c.getAttribute('data-ink')) + '\n\n';
      else if (t === 'DIV' && c.classList.contains('callout')) s += '> [!note]\n' + block(c).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      else if (t === 'IMG') s += inline({ childNodes: [c] }) + '\n\n';
      else if (t === 'DIV') s += block(c);
      else s += inline(c).trim() + '\n\n';
    }
    return s;
  };
  return block(body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------- code ---------- */
// Text of a code block: <br> and newline characters both count as line breaks.
export function preText(pre) {
  const c = pre.cloneNode(true);
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  return c.textContent.replace(/\u200b/g, '').replace(/\u00a0/g, ' ');
}

export const CODE_LANGS = ['yaml', 'json', 'bash', 'hcl', 'python', 'javascript', 'typescript', 'sql', 'html', 'css', 'xml', 'markdown', 'go', 'java', 'c', 'dockerfile', 'ini', 'toml'];

// Guesses whether pasted plain text is code, and which language. Returns '' for
// "code, language unknown" and null for ordinary prose.
export function detectCode(text) {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  if (/^\s*```/m.test(t)) return null; // Markdown with fenced code: let the Markdown importer handle it
  const share = (re) => lines.filter((l) => re.test(l)).length / lines.length;
  const indented = share(/^[ \t]+\S/);
  if (/^\s*[{[]/.test(t) && /[}\]]\s*$/.test(t)) { try { JSON.parse(t); return 'json'; } catch {} }
  const keyLines = share(/^\s*(- )?["']?[\w.\-/$]+["']?:(\s|$)/);
  const yamlish = share(/^\s*(- )?["']?[\w.\-/$]+["']?:(\s|$)|^\s*- \S|^\s*#|^---\s*$|^\.\.\.\s*$/);
  if (keyLines >= 0.4 && yamlish >= 0.85 && (indented > 0 || /^---/.test(t))) return 'yaml';
  if (share(/^\s*(resource|data|variable|output|provider|module|locals|terraform)\s+("|\{)/) > 0 && /[{}]/.test(t)) return 'hcl';
  if (/^#!.*\b(ba|z)?sh\b/.test(t) || share(/^\s*(\$ |sudo |cd |ls |git |npm |docker |kubectl |terraform |export |echo |curl |apt |brew )/) >= 0.5) return 'bash';
  if (share(/^\s*(def |class |import |from \S+ import|if __name__)/) > 0 && share(/:\s*$/) > 0) return 'python';
  if (share(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/i) > 0 && /;\s*$/.test(t)) return 'sql';
  if (share(/^\s*(FROM|RUN|COPY|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE)\s/) >= 0.4) return 'dockerfile';
  if (share(/^\s*(const|let|var|function|import|export|return)\b|=>|;\s*$/) >= 0.4) return /:\s*(string|number|boolean)\b|interface\s/.test(t) ? 'typescript' : 'javascript';
  if (share(/^\s*<[\w!/]/) >= 0.6) return /<!doctype html|<html|<div|<body/i.test(t) ? 'html' : 'xml';
  if (indented >= 0.3 || share(/[{};]\s*$/) >= 0.5) return '';
  return null;
}
