# Marginalia

A local-first notebook for studying from online courses, articles and PDFs. It has no accounts, no tracking and no AI features.

## Run it

```
python3 serve.py
```

This opens http://localhost:5178. Notes are stored in your browser's IndexedDB for that address, so keep using the same URL. Back up from **Settings → Download full backup**.

No build step: the app is plain ES modules. Preact, pdf.js, pdf-lib, perfect-freehand, MiniSearch, jsdiff and JSZip load from jsDelivr at pinned versions (see `js/lib.js`), so the first load needs an internet connection.

## What's in it

| Area | Where |
| --- | --- |
| Page editor: Markdown shortcuts, `/` blocks, `[[links]]`, checklists, tables, callouts, sketch blocks | `js/editor.js`, `js/ink.js` |
| Infinite canvas: cards, stickies, note cards, frames, arrows, pen and highlighter ink | `js/canvas.js` |
| PDF reader and annotator: highlights and underlines with comments, pen, highlighter, text boxes, eraser, outline, find, quote-to-notes | `js/pdfview.js` |
| Universal search, quick switcher and command palette (`⌘K`, `⌘⇧P`) | `js/search.js`, `js/palette.js` |
| Quick capture (`⌘⇧Space`) | `js/capture.js` |
| Notebooks (nested), tags, pinned notes, Inbox, Trash | `js/store.js`, `js/sidebar.js` |
| Home, list views, backlinks, outline, version history, settings | `js/views.js` |
| Export (Markdown, HTML, Word, PNG, SVG, annotated PDF, ZIP) and import (Markdown, text, HTML, PDF, folders, backups) | `js/export.js`, `js/md.js` |

Press `⌘/` (or `Ctrl /`) in the app to see every keyboard shortcut.
