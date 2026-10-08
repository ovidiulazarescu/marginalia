// First-run example content so the app opens in a realistic state. Everything is tagged #sample
// and can be removed in Settings.
import { S, createNote, createNotebook, persistNote, search } from './store.js';
import { db } from './db.js';
import { loadPdfLib } from './lib.js';
import { uid } from './util.js';

const H = 3600e3, D = 24 * H;
const ellipse = (cx, cy, rx, ry, n = 48, jitter = 1.2, turns = 1.08) => Array.from({ length: n }, (_, i) => {
  const a = (i / (n - 1)) * Math.PI * 2 * turns - 0.4;
  return [+(cx + Math.cos(a) * rx + (Math.random() - 0.5) * jitter).toFixed(1), +(cy + Math.sin(a) * ry + (Math.random() - 0.5) * jitter).toFixed(1), 0.5];
});
const line = (x1, y1, x2, y2, n = 16) => Array.from({ length: n }, (_, i) => [+(x1 + ((x2 - x1) * i) / (n - 1)).toFixed(1), +(y1 + ((y2 - y1) * i) / (n - 1) + Math.sin(i / 2) * 0.6).toFixed(1), 0.5]);
const zigzag = (x, y, w, h, k) => Array.from({ length: k * 6 + 1 }, (_, i) => [+(x + (w * i) / (k * 6)).toFixed(1), +(y + (Math.sin((i / 6) * Math.PI * 2) * h) / 2).toFixed(1), 0.5]);
const stroke = (points, color = 'ink', size = 3, tool = 'pen') => ({ id: uid('s'), tool, color, size, sim: true, points });

export async function seed() {
  const bio = createNotebook('BIO 201 · Cell Biology');
  const w1 = createNotebook('Week 1 · Membranes', bio.id);
  const w2 = createNotebook('Week 2 · Metabolism', bio.id);
  const read = createNotebook('Reading list');
  for (const b of [bio, w1, w2, read]) { b.sample = true; db.put('notebooks', b); }
  S.ws.expanded[bio.id] = true; S.ws.expanded[w1.id] = true;

  const id = { welcome: uid('n'), membrane: uid('n'), transport: uid('n'), atp: uid('n'), map: uid('n'), pdf: uid('n'), idea: uid('n'), article: uid('n'), pdfNotes: uid('n') };
  const L = (k, t, page) => `<a class="wikilink" data-note-id="${id[k]}" href="#${id[k]}"${page ? ` data-page="${page}"` : ''}>${t}</a>`;

  createNote({ id: id.welcome, title: 'Welcome to Marginalia', pinned: true, tags: ['sample'], content: { html:
    `<p>Marginalia is a notebook for studying: pages for writing, canvases for mapping ideas, and PDFs you can highlight and write on. Everything stays in this browser.</p>
<h2>Try these</h2>
<ul class="tasks">
<li data-checked="false">Press <code>⌘K</code> (or <code>Ctrl K</code>) and type <code>membr</code> to search notes and PDF text at once</li>
<li data-checked="false">Open ${L('pdf', 'Lecture 3 — Membranes')}, select a sentence and choose <strong>To notes</strong></li>
<li data-checked="false">Open ${L('map', 'Week 1 concept map')} and drag a note from the sidebar onto it</li>
<li data-checked="false">Type <code>[[</code> below to link a note, or <code>/</code> to insert a sketch</li>
<li data-checked="false">Press <code>⌘⇧Space</code> anywhere for quick capture</li>
</ul>
<h2>Where things live</h2>
<p><strong>Notebooks</strong> nest as deep as you like: a class, then weeks or chapters, then topics. <strong>Tags</strong> cut across notebooks. <strong>Pinned</strong> notes stay at the top of the sidebar, and the <strong>Inbox</strong> holds quick captures until you file them.</p>
<div class="callout"><p>Every note keeps its own version history. Open the clock icon in the top-right of a note to compare or restore.</p></div>
<p>When you're done exploring, remove these examples in Settings.</p>` } , silent: true });

  createNote({ id: id.membrane, title: 'Cell membrane structure', notebookId: w1.id, tags: ['sample', 'membranes', 'exam'], content: { html:
    `<p>Source: ${L('pdf', 'Lecture 3 — Membranes, p. 1', 1)} · textbook ch. 7</p>
<h2>Fluid mosaic model</h2>
<p>The membrane is a <mark>phospholipid bilayer</mark> with proteins floating in it. Hydrophilic heads face the water on both sides; hydrophobic tails face each other in the middle.</p>
<ul><li><strong>Integral proteins</strong> span the bilayer (channels, carriers)</li><li><strong>Peripheral proteins</strong> sit on the surface, often anchored to integral ones</li><li><strong>Cholesterol</strong> buffers fluidity: less fluid when warm, stops packing when cold</li><li><strong>Glycolipids &amp; glycoproteins</strong> act as recognition tags</li></ul>
<h2>Selective permeability</h2>
<p>Small nonpolar molecules (O₂, CO₂) cross freely. Ions and large polar molecules need proteins. See ${L('transport', 'Membrane transport')}.</p>
<blockquote><p>Membranes are not static sheets; they are fluid structures with a mosaic of various proteins embedded in or attached to a double layer of phospholipids.</p></blockquote>
<h2>Questions</h2>
<ul class="tasks"><li data-checked="true">Why are tails hydrophobic? (nonpolar hydrocarbon chains)</li><li data-checked="false">How do unsaturated fatty acids change fluidity?</li></ul>` }, silent: true });

  createNote({ id: id.transport, title: 'Membrane transport', notebookId: w1.id, tags: ['sample', 'membranes', 'exam'], content: { html:
    `<p>Builds on ${L('membrane', 'Cell membrane structure')}.</p>
<table><thead><tr><th></th><th>Passive</th><th>Active</th></tr></thead><tbody><tr><td>Energy</td><td>None</td><td>ATP or ion gradient</td></tr><tr><td>Direction</td><td>Down the gradient</td><td>Against the gradient</td></tr><tr><td>Examples</td><td>Diffusion, osmosis, facilitated diffusion</td><td>Na⁺/K⁺ pump, proton pump</td></tr></tbody></table>
<h2>Osmosis</h2>
<p>Water moves toward the <em>hypertonic</em> side. Animal cells lyse in hypotonic solutions; plant cells become turgid, which is what they want.</p>
<h2>The sodium–potassium pump</h2>
<ol><li>3 Na⁺ bind inside</li><li>ATP phosphorylates the pump, which changes shape</li><li>Na⁺ released outside, 2 K⁺ bind</li><li>Phosphate leaves, pump returns, K⁺ released inside</li></ol>
<p>The ATP comes from ${L('atp', 'ATP and cellular respiration')}.</p>` }, silent: true });

  const sketch = { w: 680, h: 240, s: [
    stroke(ellipse(250, 120, 190, 82, 64, 1.5), 'ink', 3),
    stroke(zigzag(110, 120, 280, 70, 4), '#d6453d', 2.5),
    stroke(line(470, 118, 600, 70), 'ink', 2.5), stroke(line(600, 70, 585, 86, 5), 'ink', 2.5), stroke(line(600, 70, 579, 69, 5), 'ink', 2.5),
    stroke(line(130, 205, 380, 205, 20), '#ffd84d', 16, 'marker'),
  ] };
  createNote({ id: id.atp, title: 'ATP and cellular respiration', notebookId: w2.id, tags: ['sample', 'metabolism'], content: { html:
    `<p>Glucose + O₂ → CO₂ + H₂O + ~30 ATP. Three stages, each in a different place.</p>
<h2>1. Glycolysis</h2><p>Cytoplasm. Glucose → 2 pyruvate. Net 2 ATP, 2 NADH. No oxygen needed.</p>
<h2>2. Citric acid cycle</h2><p>Mitochondrial matrix. Pyruvate is oxidized; makes NADH, FADH₂ and a little ATP.</p>
<h2>3. Oxidative phosphorylation</h2><p>Inner membrane (the folded <em>cristae</em>, red in the sketch). Electrons move down the transport chain, protons are pumped out, and ATP synthase lets them back in.</p>
<div class="ink-block" contenteditable="false" data-ink='${JSON.stringify(sketch)}'></div>
<p>Links back to transport: the proton gradient is the same idea as the pump in ${L('transport', 'Membrane transport')}, just run in reverse.</p>
<ul class="tasks"><li data-checked="false">Memorize ATP yield per stage</li><li data-checked="false">Practice question set 2</li></ul>` }, silent: true });

  createNote({ id: id.idea, title: 'Osmosis demo: egg in vinegar, then corn syrup', tags: ['sample', 'idea'], content: { html: '<p>Saw this in a video. Shell dissolves in vinegar, then the egg shrinks in syrup. Could explain hypertonic vs hypotonic better than the slides do.</p>' }, silent: true });

  createNote({ id: id.article, title: 'Reading: How cells keep their shape', notebookId: read.id, tags: ['sample', 'reading'], content: { html:
    `<p><strong>Author:</strong> Science magazine feature<br><strong>Read on:</strong> last week</p><h2>Main argument</h2><p>The cytoskeleton is dynamic: actin and microtubules constantly assemble and disassemble, which is how cells move and divide.</p><h2>My take</h2><p>Connects to membrane fluidity in ${L('membrane', 'Cell membrane structure')}. The membrane and cytoskeleton push on each other.</p><h2>Follow-ups</h2><ul class="tasks"><li data-checked="false">Look up motor proteins (kinesin, dynein)</li></ul>` }, silent: true });

  const items = [
    { id: 'f1', kind: 'frame', text: 'The membrane', color: 'none', x: -40, y: -70, w: 700, h: 470 },
    { id: 'c1', kind: 'note', noteId: id.membrane, color: 'none', x: 0, y: 0, w: 260, h: 120 },
    { id: 'c2', kind: 'text', text: 'Bilayer: heads out, tails in.\nProteins drift sideways like boats.', color: 'blue', x: 340, y: 0, w: 260, h: 84 },
    { id: 'c3', kind: 'sticky', text: 'Exam: compare passive vs active transport, with one example each!', color: 'yellow', x: 20, y: 190, w: 210, h: 160 },
    { id: 'c4', kind: 'note', noteId: id.transport, color: 'none', x: 340, y: 200, w: 260, h: 120 },
    { id: 'c5', kind: 'sticky', text: 'Why does cholesterol matter for fluidity? Ask in section.', color: 'pink', x: 760, y: -20, w: 200, h: 150 },
    { id: 'c6', kind: 'note', noteId: id.atp, color: 'none', x: 740, y: 220, w: 260, h: 120 },
    { id: 'c7', kind: 'note', noteId: id.pdf, color: 'none', x: 760, y: 390, w: 240, h: 110 },
  ];
  const edges = [{ id: 'e1', from: 'c1', to: 'c2' }, { id: 'e2', from: 'c1', to: 'c4' }, { id: 'e3', from: 'c4', to: 'c6' }];
  const strokes = [stroke(ellipse(125, 270, 128, 96, 56, 2), '#d6453d', 3), stroke(line(240, 375, 600, 375, 28), '#ffd84d', 18, 'marker')];
  createNote({ id: id.map, type: 'canvas', title: 'Week 1 concept map', notebookId: w1.id, tags: ['sample', 'membranes'], content: { items, edges, strokes }, silent: true });

  try { await seedPdf(id, w1.id, L); } catch (e) { console.warn('sample PDF skipped', e); }

  // Spread timestamps so Home looks lived-in.
  const t = Date.now();
  const times = { welcome: [3 * D, 2 * H, 5 * 60e3], membrane: [6 * D, 26 * H, 40 * 60e3], transport: [5 * D, 3 * H, 3 * H], atp: [2 * D, 20 * H, 20 * H], map: [4 * D, 50 * H, 2 * 60e3], pdf: [6 * D, 26 * H, 30 * 60e3], idea: [D, D, D], article: [9 * D, 8 * D, 8 * D], pdfNotes: [6 * D, 25 * H, 25 * H] };
  for (const [k, [c, u, o]] of Object.entries(times)) {
    const n = S.notes.get(id[k]);
    if (!n) continue;
    n.created = t - c; n.updated = t - u; n.opened = t - o;
    persistNote(n.id, 0);
  }
  S.ws.panes[0].tabs[0].cur = 'home';
}

async function seedPdf(id, nbId, L) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  pdf.setTitle('Lecture 3 — Membranes');
  const reg = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, Hh = 792;
  const slides = [
    { title: 'Lecture 3: Membranes', lines: ['BIO 201 · Cell Biology', '', 'Today', '• The fluid mosaic model', '• Lipids, proteins and carbohydrates in the membrane', '• What makes a membrane selectively permeable', '• Passive and active transport'] },
    { title: 'The fluid mosaic model', lines: ['Membranes are fluid structures with a mosaic of proteins', 'embedded in or attached to a phospholipid bilayer.', '', '• Phospholipids are amphipathic: a hydrophilic head and', '  two hydrophobic fatty acid tails.', '• Lipids and many proteins drift laterally within the layer.', '• Unsaturated tails have kinks that keep the membrane fluid.', '• Cholesterol reduces fluidity at warm temperatures and', '  prevents tight packing at cold temperatures.'] },
    { title: 'Transport across membranes', lines: ['Passive transport needs no energy from the cell.', '• Diffusion: movement down a concentration gradient', '• Osmosis: diffusion of water across a membrane', '• Facilitated diffusion: through channel or carrier proteins', '', 'Active transport uses energy to move solutes against', 'their gradient.', '• The sodium-potassium pump moves 3 Na+ out and 2 K+ in', '  for each ATP it uses.', '• Pumps create the membrane potential used by nerve cells.'] },
  ];
  const texts = [];
  const pos = [];
  slides.forEach((sl, pi) => {
    const page = pdf.addPage([W, Hh]);
    page.drawRectangle({ x: 0, y: Hh - 8, width: W, height: 8, color: rgb(0.06, 0.48, 0.37) });
    page.drawText(sl.title, { x: 56, y: Hh - 96, size: 26, font: bold, color: rgb(0.1, 0.12, 0.11) });
    let y = Hh - 150;
    const lines = [];
    for (const l of sl.lines) {
      if (l) page.drawText(l, { x: 56, y, size: 15, font: reg, color: rgb(0.2, 0.22, 0.21) });
      lines.push({ text: l, y, w: reg.widthOfTextAtSize(l, 15) });
      y -= 26;
    }
    page.drawText(`BIO 201 · Lecture 3 · ${pi + 1}`, { x: 56, y: 40, size: 10, font: reg, color: rgb(0.5, 0.53, 0.51) });
    texts.push([sl.title, ...sl.lines.filter(Boolean)].join('\n'));
    pos.push(lines);
  });
  const bytes = await pdf.save();
  const fileId = uid('f');
  await db.put('files', { id: fileId, name: 'Lecture 3 - Membranes.pdf', size: bytes.length, blob: new Blob([bytes], { type: 'application/pdf' }) });
  const rect = (pg, li) => { const l = pos[pg][li]; return [56, +(Hh - l.y - 15 * 0.72 - 2).toFixed(1), +l.w.toFixed(1), +(15 * 0.93 + 4).toFixed(1)]; };
  const ann = [
    { id: uid('a'), kind: 'hl', style: 'highlight', page: 2, color: '#ffd84d', rects: [rect(1, 0), rect(1, 1)], text: 'Membranes are fluid structures with a mosaic of proteins embedded in or attached to a phospholipid bilayer.', comment: 'Definition to memorize', created: Date.now() },
    { id: uid('a'), kind: 'hl', style: 'highlight', page: 2, color: '#7ee0a6', rects: [rect(1, 7), rect(1, 8)], text: 'Cholesterol reduces fluidity at warm temperatures and prevents tight packing at cold temperatures.', comment: '', created: Date.now() },
    { id: uid('a'), kind: 'hl', style: 'underline', page: 3, color: '#d6453d', rects: [rect(2, 7)], text: 'The sodium-potassium pump moves 3 Na+ out and 2 K+ in', comment: '', created: Date.now() },
    { id: uid('a'), kind: 'ink', tool: 'pen', page: 3, color: '#d6453d', size: 1.8, sim: true, points: ellipse(300, Hh - pos[2][7].y - 6, 260, 30, 56, 1.2), created: Date.now() },
    { id: uid('a'), kind: 'text', page: 3, x: 330, y: 470, w: 230, size: 13, color: '#2f6fde', text: 'Uses 1 ATP per cycle.\nSee my transport notes.', created: Date.now() },
  ];
  createNote({ id: id.pdf, type: 'pdf', title: 'Lecture 3 — Membranes', notebookId: nbId, tags: ['sample', 'membranes', 'lecture'], content: { fileId, fileName: 'Lecture 3 - Membranes.pdf', pages: 3, ann, lastPage: 2, companionId: id.pdfNotes }, silent: true });
  S.notes.get(id.pdf).view = { page: 2 };
  S.pdfText.set(id.pdf, texts);
  await db.put('pdftext', { id: id.pdf, pages: texts });
  search.addPdf(id.pdf, texts);
  createNote({ id: id.pdfNotes, title: 'Lecture 3 — Membranes — notes', notebookId: nbId, tags: ['sample', 'membranes', 'lecture'], content: { html:
    `<p>Notes on ${L('pdf', 'Lecture 3 — Membranes')}</p><blockquote><p>Membranes are fluid structures with a mosaic of proteins embedded in or attached to a phospholipid bilayer.</p></blockquote><p>${L('pdf', 'Lecture 3 — Membranes, p. 2', 2)} — Definition to memorize</p><p>Professor said this exact wording shows up on the midterm. Expanded in ${L('membrane', 'Cell membrane structure')}.</p>` }, silent: true });
}
