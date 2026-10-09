# Marginalia

A local-first notebook for studying from online courses, articles and PDFs. It has no accounts, no tracking and no AI features.

## Run it

```
python3 serve.py
```

This opens http://localhost:5178. Notes are stored in your browser's IndexedDB for that address, so keep using the same URL. Back up from **Settings → Download full backup**.

No build step: the app is plain ES modules. Preact, pdf.js, pdf-lib, perfect-freehand, MiniSearch, jsdiff and JSZip load from jsDelivr at pinned versions (see `js/lib.js`), so the first load needs an internet connection.

## Self-host on TrueNAS with a Cloudflare tunnel

Marginalia is static files, so any web server works. These steps use nginx on TrueNAS SCALE 24.10+ (Docker apps) and a Cloudflare Zero Trust tunnel.

Notes live in each browser's IndexedDB, not on the server. Every device keeps its own notes, and nothing syncs between them. To move notes to a new address, use **Settings → Download full backup** on the old one and **Restore from backup** on the new one.

1. **Copy the files** into a dataset, for example `/mnt/tank/apps/marginalia/site`. Either clone the repo there with a read-only deploy key, or copy from your machine:

   ```
   rsync -av --exclude .git --exclude .claude ./ root@TRUENAS_IP:/mnt/tank/apps/marginalia/site/
   ```

2. **Create the app.** In TrueNAS go to **Apps → Discover Apps → ⋮ → Install via YAML** and paste the following. It uses [`deploy/nginx.conf`](deploy/nginx.conf) from the copied files, which blocks dotfiles such as `.git` and makes browsers check for updated files.

   ```yaml
   services:
     marginalia:
       image: nginx:1.27-alpine
       restart: unless-stopped
       ports:
         - "8095:80"
       volumes:
         - /mnt/tank/apps/marginalia/site:/usr/share/nginx/html:ro
         - /mnt/tank/apps/marginalia/site/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
   ```

   Change `tank` to your pool name and `8095` to a free port, then check `http://TRUENAS_IP:8095`.

3. **Route a subdomain.** In Cloudflare Zero Trust go to **Networks → Tunnels**, choose your tunnel, then **Public Hostname → Add**. Set the subdomain (for example `notes`) and domain, with service `HTTP` and URL `TRUENAS_IP:8095`. If `cloudflared` isn't running yet, install the **Cloudflared** app from the TrueNAS catalog with your tunnel token.

4. **Restrict access.** The app has no login of its own. Go to **Zero Trust → Access → Applications → Add → Self-hosted**, enter the hostname, and add an **Allow** policy that includes only your email address, with One-time PIN as the login method.

To update, run `git pull` (or rerun `rsync`) on the server. nginx serves the new files without a restart.

### Other Docker hosts

On any machine with Docker Compose, run this from the repo root:

```
docker compose -f deploy/docker-compose.yml up -d
```

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) serves the repo on port 8095 using relative paths, so it works wherever the repo is checked out. The TrueNAS YAML above is the same service with absolute paths, which TrueNAS requires.

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
