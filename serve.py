#!/usr/bin/env python3
"""Marginalia server: serves the app and stores synced notes.

    python3 serve.py                      # http://localhost:5178, data in ./data
    python3 serve.py --host 0.0.0.0 --port 8095 --data /data --token SECRET --no-open

Notes, notebooks, versions and PDF text live in SQLite (DATA/marginalia.db);
PDF files are stored as plain files in DATA/files/. Uses only the Python standard library.

Environment variables MARGINALIA_HOST, MARGINALIA_PORT, MARGINALIA_DATA and
MARGINALIA_TOKEN can be used instead of the flags. When a token is set, every
/api request must send "Authorization: Bearer <token>".
"""
import argparse, hmac, http.server, json, os, re, sqlite3, sys, threading, time, uuid, webbrowser
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STORES = {'notes', 'notebooks', 'versions', 'files', 'pdftext'}
FILE_ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
STATIC = re.compile(r'^/(index\.html|styles\.css|js/[A-Za-z0-9_-]+\.js)$')
TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'}
MAX_JSON = 64 * 1024 * 1024
MAX_FILE = 1024 * 1024 * 1024


class Store:
    def __init__(self, data_dir):
        self.dir = os.path.abspath(data_dir)
        self.files = os.path.join(self.dir, 'files')
        os.makedirs(self.files, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(os.path.join(self.dir, 'marginalia.db'), check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS records (
              store TEXT NOT NULL, id TEXT NOT NULL, data TEXT, m INTEGER NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (store, id));
            CREATE INDEX IF NOT EXISTS records_seq ON records (seq);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        ''')
        # A permanent ID for this database. Browsers compare it on every sync, so a reset
        # or replaced server (new ID) makes them upload everything they have again.
        row = self.db.execute("SELECT v FROM meta WHERE k = 'instance'").fetchone()
        if row:
            self.instance = row[0]
        else:
            self.instance = uuid.uuid4().hex
            with self.db:
                self.db.execute("INSERT INTO meta (k, v) VALUES ('instance', ?)", (self.instance,))
        self.seq = self.db.execute('SELECT COALESCE(MAX(seq), 0) FROM records').fetchone()[0]

    def _write(self, store, rid, data, m, deleted):
        self.seq += 1
        self.db.execute(
            'INSERT INTO records (store, id, data, m, deleted, seq) VALUES (?, ?, ?, ?, ?, ?) '
            'ON CONFLICT (store, id) DO UPDATE SET data = excluded.data, m = excluded.m, deleted = excluded.deleted, seq = excluded.seq',
            (store, rid, None if deleted else json.dumps(data, separators=(',', ':')), m, 1 if deleted else 0, self.seq))
        if store == 'files' and deleted:
            self.remove_blob(rid)

    def _keep_conflict(self, rid, loser, m):
        """The losing edit of a note becomes a version in its history."""
        if not loser or not isinstance(loser, dict):
            return
        version = {
            'id': 'vc' + uuid.uuid4().hex[:12], 'noteId': rid, 'ts': m, 'title': loser.get('title', ''),
            'type': loser.get('type', 'page'), 'content': loser.get('content'), 'reason': 'conflict',
            'label': 'Edit from another device', 'sig': 0,
        }
        self._write('versions', version['id'], version, int(time.time() * 1000), False)

    def push(self, records):
        results = []
        with self.lock, self.db:
            for r in records:
                store, rid = r.get('store'), str(r.get('id', ''))
                if store not in STORES or not rid or len(rid) > 200:
                    results.append({'ok': False, 'error': 'invalid'})
                    continue
                m, base, deleted, data = int(r.get('m') or 0), r.get('b'), bool(r.get('deleted')), r.get('data')
                # resync: a browser re-sending what it already had, not a new edit.
                resync = bool(r.get('resync'))
                row = self.db.execute('SELECT data, m, deleted FROM records WHERE store = ? AND id = ?', (store, rid)).fetchone()
                if resync and row is not None and row[1] == m and bool(row[2]) == deleted:
                    results.append({'ok': True})  # the server already has this exact version
                    continue
                if row is None or row[1] == base:
                    self._write(store, rid, data, m, deleted)  # new record, or a clean fast-forward
                    results.append({'ok': True})
                    continue
                # Two devices changed the same record: the newest edit wins.
                server = {'store': store, 'id': rid, 'data': None if row[2] else json.loads(row[0]), 'm': row[1], 'deleted': bool(row[2])}
                if m >= row[1]:
                    if store == 'notes' and not row[2] and not resync:
                        self._keep_conflict(rid, server['data'], row[1])
                    self._write(store, rid, data, m, deleted)
                    results.append({'ok': True})
                else:
                    if store == 'notes' and not deleted and not resync:
                        self._keep_conflict(rid, data, m)
                    results.append({'ok': False, 'record': server})
        return results

    def changes(self, since, limit):
        with self.lock:
            rows = self.db.execute(
                'SELECT store, id, data, m, deleted, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?', (since, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return {
            'records': [{'store': s, 'id': i, 'data': None if d else json.loads(x), 'm': m, 'deleted': bool(d)} for s, i, x, m, d, _ in rows],
            'next': rows[-1][5] if rows else since,
            'more': more,
            'instance': self.instance,
        }

    def blob_path(self, fid):
        return os.path.join(self.files, fid)

    def remove_blob(self, fid):
        if FILE_ID.match(fid):
            try: os.remove(self.blob_path(fid))
            except FileNotFoundError: pass

    def stats(self):
        with self.lock:
            rows = self.db.execute('SELECT store, COUNT(*) FROM records WHERE deleted = 0 GROUP BY store').fetchall()
        return dict(rows)


def make_handler(store, token):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'Marginalia'

        def log_message(self, *a):
            pass

        def send(self, code, body=b'', ctype='application/json', extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, separators=(',', ':')).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def authorized(self):
            if not token:
                return True
            got = self.headers.get('Authorization', '')
            return hmac.compare_digest(got.encode(), f'Bearer {token}'.encode())

        def body(self, limit):
            n = int(self.headers.get('Content-Length') or 0)
            if n > limit:
                raise ValueError('too large')
            return self.rfile.read(n)

        # ---- static app files (allowlist only; data and dotfiles are never served) ----
        def static(self, path):
            if path == '/':
                path = '/index.html'
            if not STATIC.match(path):
                return self.send(404, 'Not found', 'text/plain')
            full = os.path.join(ROOT, path.lstrip('/'))
            try:
                with open(full, 'rb') as f:
                    data = f.read()
            except FileNotFoundError:
                return self.send(404, 'Not found', 'text/plain')
            self.send(200, data, TYPES[os.path.splitext(full)[1]])

        def route(self):
            url = urlparse(self.path)
            path = url.path
            if not path.startswith('/api/'):
                if self.command in ('GET', 'HEAD'):
                    return self.static(path)
                return self.send(405, {'error': 'method not allowed'})
            if path == '/api/health':
                return self.send(200, {'app': 'marginalia', 'auth': bool(token), 'ok': True, 'instance': store.instance})
            if not self.authorized():
                return self.send(401, {'error': 'unauthorized'})
            if path == '/api/push' and self.command == 'POST':
                payload = json.loads(self.body(MAX_JSON) or b'{}')
                return self.send(200, {'results': store.push(payload.get('records') or [])})
            if path == '/api/changes' and self.command == 'GET':
                q = parse_qs(url.query)
                since = int((q.get('since') or ['0'])[0])
                limit = max(1, min(1000, int((q.get('limit') or ['400'])[0])))
                return self.send(200, store.changes(since, limit))
            if path == '/api/stats' and self.command == 'GET':
                return self.send(200, store.stats())
            m = re.match(r'^/api/files/([^/]+)$', path)
            if m:
                fid = m.group(1)
                if not FILE_ID.match(fid):
                    return self.send(400, {'error': 'bad file id'})
                fp = store.blob_path(fid)
                if self.command in ('GET', 'HEAD'):
                    if not os.path.exists(fp):
                        return self.send(404, {'error': 'not found'})
                    with open(fp, 'rb') as f:
                        return self.send(200, f.read(), 'application/pdf')
                if self.command == 'PUT':
                    data = self.body(MAX_FILE)
                    tmp = f'{fp}.{uuid.uuid4().hex}.tmp'
                    with open(tmp, 'wb') as f:
                        f.write(data)
                    os.replace(tmp, fp)
                    return self.send(200, {'ok': True, 'size': len(data)})
            return self.send(404, {'error': 'not found'})

        def handle_any(self):
            try:
                self.route()
            except ValueError as e:
                self.send(413 if 'large' in str(e) else 400, {'error': str(e)})
            except Exception as e:  # keep the server up; report the failure to the client
                print(f'error handling {self.command} {self.path}: {e!r}', file=sys.stderr)
                self.send(500, {'error': 'server error'})

        do_GET = do_HEAD = do_POST = do_PUT = handle_any

    return Handler


def main():
    env = os.environ.get
    p = argparse.ArgumentParser(description='Serve Marginalia and store synced notes.')
    p.add_argument('port_pos', nargs='?', type=int, help=argparse.SUPPRESS)
    p.add_argument('--host', default=env('MARGINALIA_HOST', '127.0.0.1'), help='address to listen on (use 0.0.0.0 in Docker)')
    p.add_argument('--port', type=int, default=int(env('MARGINALIA_PORT', '5178')))
    p.add_argument('--data', default=env('MARGINALIA_DATA', os.path.join(ROOT, 'data')), help='folder for the database and PDFs')
    p.add_argument('--token', default=env('MARGINALIA_TOKEN', ''), help='require this bearer token for /api')
    p.add_argument('--no-open', action='store_true', help="don't open a browser")
    a = p.parse_args()
    port = a.port_pos or a.port

    store = Store(a.data)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    httpd = http.server.ThreadingHTTPServer((a.host, port), make_handler(store, a.token))
    shown = 'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host
    url = f'http://{shown}:{port}'
    print(f'Marginalia is running at {url}  (Ctrl+C to stop)')
    print(f'Data folder: {store.dir}')
    if not a.token and a.host not in ('127.0.0.1', 'localhost'):
        print('Note: no --token set. Anyone who can reach this port can read and change your notes.')
    if not a.no_open:
        try: webbrowser.open(url)
        except Exception: pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
