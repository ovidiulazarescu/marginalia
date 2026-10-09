# Marginalia

A local-first notebook for studying from online courses, articles and PDFs. It has no accounts, no tracking and no AI features.

## Run it

```
python3 serve.py
```

This opens http://localhost:5178. It needs only Python 3 and has no other dependencies.

`serve.py` serves the app and also stores your notes: notebooks, notes, versions and PDF text go into SQLite at `data/marginalia.db`, and PDFs into `data/files/`. Use `--data` to choose another folder and `--port` to change the port.

Each browser keeps a full copy of your notes in IndexedDB, so the app is fast and works offline. It syncs with the server in the background every 30 seconds, shortly after each edit, and when you come back online. If two devices change the same note, the newest edit wins and the other one is kept in that note's version history, labelled "From another device". The status of the sync is shown at the bottom of the sidebar and in **Settings → Sync**.

When the app is served by a plain static web server instead, there is no sync: notes stay in that browser. **Settings → Download full backup** works either way.

No build step: the app is plain ES modules. Preact, pdf.js, pdf-lib, perfect-freehand, MiniSearch, jsdiff and JSZip load from jsDelivr at pinned versions (see `js/lib.js`), so the first load needs an internet connection.

## Self-host on TrueNAS with a Cloudflare tunnel

These steps run `serve.py` in a Python container on TrueNAS SCALE 24.10+ (Docker apps), reachable through a Cloudflare Zero Trust tunnel.

1. **Create two datasets**, for example:
   - `/mnt/tank/apps/marginalia/app` for the code
   - `/mnt/tank/apps/marginalia/data` for your notes. Keeping it separate means TrueNAS snapshots and replication can protect your notes on their own.

2. **Put the code in the app dataset.** Clone the repo directly into it, so updating later is a `git pull`:

   ```
   git clone git@github.com:ovidiulazarescu/marginalia.git /mnt/tank/apps/marginalia/app
   ```

   The repo is private, so add a read-only deploy key to it first. The folder must be empty or not exist yet. Copying with `rsync` also works:

   ```
   rsync -av --exclude .git --exclude .claude --exclude data ./ root@TRUENAS_IP:/mnt/tank/apps/marginalia/app/
   ```

3. **Create the app.** In TrueNAS go to **Apps → Discover Apps → ⋮ → Install via YAML** and paste:

   ```yaml
   services:
     marginalia:
       image: python:3.12-alpine
       restart: unless-stopped
       working_dir: /app
       command: ["python", "-u", "serve.py", "--host", "0.0.0.0", "--port", "8095", "--data", "/data", "--no-open"]
       environment:
         MARGINALIA_TOKEN: ""
       ports:
         - "8095:8095"
       volumes:
         - /mnt/tank/apps/marginalia/app:/app:ro
         - /mnt/tank/apps/marginalia/data:/data
   ```

   Change `tank` to your pool name and `8095` to a free port, then check `http://TRUENAS_IP:8095`. The app's logs should say `Marginalia is running` and show the data folder.

4. **Route a subdomain.** In Cloudflare Zero Trust go to **Networks → Tunnels**, choose your tunnel, then **Public Hostname → Add**. Set the subdomain (for example `notes`) and domain, with service `HTTP` and URL `TRUENAS_IP:8095`. If `cloudflared` isn't running yet, install the **Cloudflared** app from the TrueNAS catalog with your tunnel token.

5. **Restrict access.** The server stores your notes, so don't leave it open. Go to **Zero Trust → Access → Applications → Add → Self-hosted**, enter the hostname, and add an **Allow** policy that includes only your email address, with One-time PIN as the login method. The app's sync requests go to the same address, so this login protects them too. When the session expires, the sidebar says **Sign-in expired** and a reload signs you back in.

   Anyone on your LAN can still reach `TRUENAS_IP:8095` directly. To lock that down as well, set `MARGINALIA_TOKEN` to a long random value (for example the output of `openssl rand -hex 24`), then enter the same token once in each browser under **Settings → Sync**.

**First sync.** The first browser to connect uploads the notes it already has. A new device starts from the server's copy, so it doesn't get its own set of sample notes. Notes in a browser that used an older address (such as `localhost`) aren't on the server. Move them with **Settings → Download full backup** there and **Restore from backup** on the synced address, and they upload on the next sync.

**Updating.** Run `git pull` (or rerun `rsync`) in the app dataset, then restart the app in TrueNAS so the server picks up any changes to `serve.py`. Browsers load the new app files on their next reload.

**Backups.** Snapshot the data dataset. `marginalia.db` uses SQLite's WAL mode, so a snapshot of the dataset captures a consistent copy along with its `-wal` file.

### Other Docker hosts

On any machine with Docker Compose, run this from the repo root:

```
docker compose -f deploy/docker-compose.yml up -d
```

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) is the same service using relative paths: it serves the checkout on port 8095 and keeps notes in `deploy/data/`.

## What's in it

| Area | Where |
| --- | --- |
| Page editor: Markdown shortcuts, `/` blocks, `[[links]]`, checklists, tables, callouts, sketch blocks | `js/editor.js`, `js/ink.js` |
| Infinite canvas: cards, stickies, note cards, frames, arrows, pen and highlighter ink | `js/canvas.js` |
| PDF reader and annotator: highlights and underlines with comments, pen, highlighter, text boxes, eraser, outline, find, quote-to-notes | `js/pdfview.js` |
| Universal search, quick switcher and command palette (`⌘K`, `⌘⇧P`) | `js/search.js`, `js/palette.js` |
| Quick capture (`⌘⇧Space`) | `js/capture.js` |
| Notebooks (nested), tags, pinned notes, Inbox, Trash | `js/store.js`, `js/sidebar.js` |
| Local storage and change tracking, sync with the server | `js/db.js`, `js/sync.js` |
| Server: app files plus sync API on SQLite (`/api/health`, `/api/push`, `/api/changes`, `/api/files/<id>`) | `serve.py` |
| Home, list views, backlinks, outline, version history, settings | `js/views.js` |
| Export (Markdown, HTML, Word, PNG, SVG, annotated PDF, ZIP) and import (Markdown, text, HTML, PDF, folders, backups) | `js/export.js`, `js/md.js` |

Press `⌘/` (or `Ctrl /`) in the app to see every keyboard shortcut.
