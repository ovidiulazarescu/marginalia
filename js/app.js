import { html, render, useEffect, useState } from './lib.js';
import { S, emit, load, useStore, openPalette, openCapture, closeTab, newTabCmd, selectTab, previousNote, back, forward, toggleSplit, setSettings, setWs, currentId, flushAll } from './store.js';
import { Sidebar } from './sidebar.js';
import { Pane } from './views.js';
import { Palette } from './palette.js';
import { QuickCapture } from './capture.js';
import { Dialog, Menu, Toasts, Help } from './dialogs.js';
import { newPage, newCanvas, importPdfs, saveVersion, contextNotebook } from './actions.js';
import { importFiles } from './export.js';
import { mod, cls } from './util.js';

function onKey(e) {
  if (e.defaultPrevented) return;
  const k = e.key.toLowerCase(), c = e.code;
  const overlay = S.ui.palette || S.ui.dialog || S.ui.capture;
  if (e.key === 'Escape') {
    if (S.ui.help) { S.ui.help = false; emit(); return; }
    if (S.ui.capture) { S.ui.capture = null; emit(); return; }
    if (S.ui.sidebarOpenMobile) { S.ui.sidebarOpenMobile = false; emit(); return; }
  }
  if (mod(e) && !e.altKey && (k === 'k' || (k === 'p' && !e.shiftKey))) { e.preventDefault(); openPalette(); return; }
  if (mod(e) && e.shiftKey && k === 'p') { e.preventDefault(); openPalette('command'); return; }
  if ((mod(e) && e.shiftKey && c === 'Space') || (e.altKey && !mod(e) && c === 'KeyQ')) { e.preventDefault(); if (!overlay) openCapture(); return; }
  if (overlay) return;
  if (mod(e) && (k === '/' || c === 'Slash')) { e.preventDefault(); S.ui.help = !S.ui.help; emit(); return; }
  if (e.altKey && !mod(e)) {
    const map = { KeyN: () => newPage(), KeyC: () => newCanvas(), KeyP: () => importPdfs(), KeyT: () => newTabCmd(), KeyW: () => closeTab(), Backquote: previousNote };
    if (map[c]) { e.preventDefault(); map[c](); return; }
    const d = c.match(/^Digit([1-9])$/);
    if (d) { e.preventDefault(); const p = S.ws.panes[S.ws.active]; selectTab(S.ws.active, Math.min(+d[1], p.tabs.length) - 1); return; }
  }
  if (mod(e) && c === 'Backslash') { e.preventDefault(); e.shiftKey ? toggleSplit() : setSettings({ sidebar: !S.settings.sidebar }); return; }
  if (mod(e) && !e.shiftKey && c === 'BracketLeft') { e.preventDefault(); back(); return; }
  if (mod(e) && !e.shiftKey && c === 'BracketRight') { e.preventDefault(); forward(); return; }
  if (mod(e) && !e.shiftKey && k === 's') { e.preventDefault(); saveVersion(currentId()); return; }
  if (mod(e) && e.shiftKey && k === 'i') { e.preventDefault(); setWs({ inspector: !S.ws.inspector }); return; }
}

function App() {
  useStore();
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    addEventListener('keydown', onKey);
    let depth = 0;
    const isFiles = (e) => e.dataTransfer?.types?.includes('Files');
    const enter = (e) => { if (isFiles(e)) { depth++; setDropping(true); } };
    const leave = (e) => { if (isFiles(e) && --depth <= 0) { depth = 0; setDropping(false); } };
    const over = (e) => { if (isFiles(e)) e.preventDefault(); };
    const drop = (e) => { depth = 0; setDropping(false); if (!isFiles(e) || e.defaultPrevented) return; e.preventDefault(); importFiles([...e.dataTransfer.files], contextNotebook()); };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const mqh = () => emit();
    mq.addEventListener?.('change', mqh);
    return () => { removeEventListener('keydown', onKey); removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, []);
  if (!S.ready) return html`<div class="boot"><span class="brand-mark"></span>Opening your notebooks…</div>`;
  return html`<div class=${cls('app', !S.settings.sidebar && 'no-sidebar', S.ws.panes.length > 1 && 'split')}>
    <${Sidebar} />
    ${S.ui.sidebarOpenMobile && html`<div class="mobile-scrim" onClick=${() => { S.ui.sidebarOpenMobile = false; emit(); }}></div>`}
    <main class="workspace">${S.ws.panes.map((p, i) => html`<${Pane} key=${p.id} pane=${p} index=${i} />`)}</main>
    ${!S.persistent && html`<div class="storage-warn">Storage is blocked in this window, so notes won't be saved after you close it.</div>`}
    ${dropping && html`<div class="drop-overlay"><div>Drop PDFs, Markdown or text files to import them</div></div>`}
    <${QuickCapture} /><${Palette} /><${Dialog} /><${Menu} /><${Help} /><${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
load().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="boot">Marginalia couldn't start: ${String(e.message || e)}</div>`; });
