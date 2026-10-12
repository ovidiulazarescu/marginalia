// Background sync with the Marginalia server (serve.py). The browser keeps a full
// local copy in IndexedDB; this module pushes local changes and pulls everyone else's.
//
// Conflicts are resolved per record on the server: the newest edit wins, and for notes
// the losing edit is kept as a version in that note's history.
import { db, SYNCED, syncKey, setDirtyListener } from './db.js';

const TOKEN_KEY = 'marginalia.syncToken';
const PULL_EVERY = 30e3;
const BATCH_BYTES = 4e6;

// Shared with the UI through store.js (S.sync).
export const sync = { state: 'checking', last: 0, pending: 0, error: '', auth: false };
let hooks = { emit() {}, apply() {}, flush() {} };
let available = false;
let running = null;
let again = false;
let timer = null;

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY); } catch {}
  start(hooks);
}

class SyncError extends Error { constructor(state, msg) { super(msg); this.state = state; } }

async function api(path, { method = 'GET', body, json = true, timeout = 30e3 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    const headers = {};
    const tok = getToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    if (body !== undefined && json) headers['Content-Type'] = 'application/json';
    res = await fetch(`api/${path}`, { method, headers, body: body === undefined ? undefined : json ? JSON.stringify(body) : body, signal: ctl.signal, redirect: 'manual', cache: 'no-store' });
  } catch (e) {
    throw new SyncError('offline', 'The server can’t be reached.');
  } finally { clearTimeout(t); }
  // Cloudflare Access (or another proxy) redirecting to its login page.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new SyncError('expired', 'Your sign-in expired. Reload the page to sign in again.');
  if (res.status === 401) throw new SyncError('token', getToken() ? 'The sync token was rejected.' : 'This server needs a sync token.');
  if (res.status === 404 && path === 'health') throw new SyncError('off', '');
  if (!res.ok) throw new SyncError('error', `The server answered ${res.status}.`);
  if (!json) return res;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new SyncError(path === 'health' ? 'off' : 'error', 'Unexpected response from the server.');
  return res.json();
}

async function probe() {
  const h = await api('health', { timeout: 4000 });
  if (h?.app !== 'marginalia') throw new SyncError('off', '');
  sync.auth = !!h.auth;
  if (h.auth && !getToken()) throw new SyncError('token', 'This server needs a sync token.');
  available = true;
  return h;
}

const getKV = async (k) => (await db.get('kv', k))?.value;
const setKV = (k, v) => db.put('kv', { key: k, value: v });

// Records already in this browser before sync was enabled get queued once.
async function queueExisting() {
  if (await getKV('syncQueued')) return;
  const known = new Set((await db.all('sync')).map((e) => e.key));
  const now = Date.now();
  const add = [];
  for (const s of SYNCED) for (const r of await db.all(s)) {
    const key = syncKey(s, r.id);
    if (!known.has(key)) add.push({ key, store: s, id: r.id, dirty: 1, deleted: 0, m: now, b: null, up: 0 });
  }
  await db.putMany('sync', add, { remote: true });
  await setKV('syncQueued', true);
}

// Each server database has a permanent ID. If it changes (the server was reset, its data
// folder replaced, or this browser now points at a different server), everything this
// browser holds is sent again and the server's copy is read back from the start.
let serverId = null;
async function adoptServer(id) {
  if (!id) return false;
  serverId = id;
  const prev = await getKV('syncServer');
  if (prev === id) return false;
  const cursor = (await getKV('syncCursor')) || 0;
  const changed = !!prev || cursor > 0;
  if (changed) {
    const entries = await db.all('sync');
    const keep = [];
    for (const e of entries) {
      if (e.deleted) { if (!e.dirty) await db.del('sync', e.key, { remote: true }); continue; }
      if (!e.dirty) { e.dirty = 1; e.resync = 1; e.b = e.m; }
      if (e.store === 'files') e.up = 0;
      keep.push(e);
    }
    await db.putMany('sync', keep, { remote: true });
    await setKV('syncQueued', false); // also queue any record that never had a sync entry
    await queueExisting();
    await setKV('syncCursor', 0);
  }
  await setKV('syncServer', id);
  return changed;
}

async function countPending() { sync.pending = (await db.byIndex('sync', 'dirty', 1)).length; }

/* ---------- push ---------- */
async function push() {
  const dirty = await db.byIndex('sync', 'dirty', 1);
  let batch = [], size = 0;
  const send = async () => {
    if (!batch.length) return;
    const res = await api('push', { method: 'POST', body: { records: batch.map((x) => x.rec) } });
    const remote = [];
    for (const [i, r] of res.results.entries()) {
      const { entry, rec } = batch[i];
      const cur = await db.get('sync', entry.key);
      if (!cur) continue;
      if (r.ok) cur.b = rec.m;
      else {
        // Someone else's newer edit won; take it.
        cur.b = r.record.m;
        remote.push(await applyLocal(r.record));
      }
      if (cur.m === entry.m) { cur.dirty = 0; cur.resync = 0; }
      await db.put('sync', cur, { remote: true });
    }
    if (remote.length) hooks.apply(remote.filter(Boolean));
    batch = []; size = 0;
  };
  for (const entry of dirty) {
    let data = null;
    if (!entry.deleted) {
      data = await db.get(entry.store, entry.id);
      if (!data) continue;
      if (entry.store === 'files') {
        const { blob, ...meta } = data;
        if (blob && !entry.up) {
          await api(`files/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: blob, json: false, timeout: 10 * 60e3 });
          const cur = await db.get('sync', entry.key);
          if (cur) { cur.up = 1; await db.put('sync', cur, { remote: true }); }
        }
        data = meta;
      }
    }
    const rec = { store: entry.store, id: entry.id, m: entry.m, b: entry.b ?? null, deleted: !!entry.deleted, data, resync: !!entry.resync };
    const bytes = JSON.stringify(rec).length;
    if (size + bytes > BATCH_BYTES) await send();
    batch.push({ entry, rec });
    size += bytes;
  }
  await send();
}

/* ---------- pull ---------- */
// Writes a server record into IndexedDB and returns the change for the live UI.
async function applyLocal(r) {
  if (!SYNCED.has(r.store)) return null;
  if (r.deleted) { await db.del(r.store, r.id, { remote: true }); return { store: r.store, id: r.id, deleted: true }; }
  let data = r.data;
  if (r.store === 'files') {
    const local = await db.get('files', r.id);
    if (local?.blob) data = { ...data, blob: local.blob };
  }
  await db.put(r.store, data, { remote: true });
  return { store: r.store, id: r.id, data };
}

async function pull() {
  let since = (await getKV('syncCursor')) || 0;
  for (;;) {
    const res = await api(`changes?since=${since}&limit=400`);
    if (res.instance && serverId && res.instance !== serverId) {
      // The server changed underneath us: re-send everything, then read it all back.
      await adoptServer(res.instance);
      again = true;
      return;
    }
    const changes = [];
    for (const r of res.records) {
      const key = syncKey(r.store, r.id);
      const cur = await db.get('sync', key);
      // A local edit is still waiting to be pushed; the server will settle it on the next push.
      if (cur?.dirty) continue;
      // Already have exactly this version (for example, one this browser just uploaded).
      if (cur && !r.deleted && cur.m === r.m && cur.b === r.m) continue;
      const c = await applyLocal(r);
      if (c) changes.push(c);
      await db.put('sync', { key, store: r.store, id: r.id, dirty: 0, deleted: r.deleted ? 1 : 0, m: r.m, b: r.m, up: 1 }, { remote: true });
    }
    since = res.next;
    await setKV('syncCursor', since);
    if (changes.length) hooks.apply(changes);
    if (!res.more) break;
  }
}

/* ---------- loop ---------- */
function setState(state, error = '') {
  sync.state = state;
  sync.error = error;
  hooks.emit();
}

export function syncNow() {
  if (!available) return start(hooks);
  if (running) { again = true; return running; }
  running = (async () => {
    setState('syncing');
    try {
      await hooks.flush();
      await push();
      await pull();
      sync.last = Date.now();
      await countPending();
      setState('idle');
    } catch (e) {
      await countPending().catch(() => {});
      setState(e.state || 'error', e.message || String(e));
    } finally {
      running = null;
      if (again) { again = false; syncNow(); }
    }
  })();
  return running;
}

const soon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => syncNow(), 1500); }; })();

// Called once the app has loaded. hooks: { emit, apply(changes), flush }
export async function start(h) {
  hooks = h;
  clearInterval(timer);
  available = false;
  setState('checking');
  let health;
  try {
    health = await probe();
  } catch (e) {
    setState(e.state || 'offline', e.message || '');
    if (e.state === 'offline') timer = setInterval(() => start(hooks), PULL_EVERY);
    return;
  }
  await queueExisting();
  await adoptServer(health.instance);
  setDirtyListener(() => { countPending().then(hooks.emit); soon(); });
  timer = setInterval(syncNow, PULL_EVERY);
  syncNow();
}

addEventListener('online', () => start(hooks));
document.addEventListener('visibilitychange', () => { if (!document.hidden && available) syncNow(); });

// First run on a new device: fetch everything from the server before deciding to add sample notes.
export async function bootstrap() {
  try {
    const h = await probe();
    serverId = h.instance || null;
    if (h.instance) await setKV('syncServer', h.instance);
    await pull();
    await setKV('syncQueued', true);
    return true;
  } catch { return false; }
}

// PDFs are uploaded once and downloaded on demand by other devices.
export async function fetchFileBlob(id) {
  if (!available) { try { await probe(); } catch { return null; } }
  try {
    const res = await api(`files/${encodeURIComponent(id)}`, { json: false, timeout: 10 * 60e3 });
    return await res.blob();
  } catch { return null; }
}
