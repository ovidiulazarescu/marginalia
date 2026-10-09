// Minimal promise wrapper around IndexedDB, with an in-memory fallback
// for browsers or frames where storage is blocked.
//
// Writes to synced stores are also recorded in the `sync` store, one entry per
// record: { key: "store/id", store, id, dirty: 0|1, deleted: 0|1, m, b, up }.
//   m  = local modification time of the latest change
//   b  = server modification time this device last saw (the edit's base)
//   up = 1 once a file's blob has been uploaded
// js/sync.js pushes dirty entries and marks them clean.
const NAME = 'marginalia';
const VERSION = 2;
const STORES = ['notes', 'notebooks', 'versions', 'files', 'pdftext', 'kv', 'sync'];
export const SYNCED = new Set(['notes', 'notebooks', 'versions', 'files', 'pdftext']);
let dbp;
export let persistent = true;

function open() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(NAME, VERSION); } catch (e) { rej(e); return; }
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('notes', { keyPath: 'id' });
        d.createObjectStore('notebooks', { keyPath: 'id' });
        d.createObjectStore('versions', { keyPath: 'id' }).createIndex('noteId', 'noteId');
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('pdftext', { keyPath: 'id' });
        d.createObjectStore('kv', { keyPath: 'key' });
      }
      if (e.oldVersion < 2) d.createObjectStore('sync', { keyPath: 'key' }).createIndex('dirty', 'dirty');
    };
    r.onsuccess = () => {
      const d = r.result;
      // Another tab is upgrading the database: step aside and reload into the new version.
      d.onversionchange = () => { d.close(); location.reload(); };
      res(d);
    };
    r.onerror = () => rej(r.error);
    // An older tab still has the database open; the upgrade continues once it reloads.
    r.onblocked = () => console.warn('Waiting for other Marginalia tabs to close or reload…');
  });
}

const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
const memKey = (store, v) => (store === 'kv' || store === 'sync' ? v.key : v.id);
const memDB = {
  get: async (s, k) => mem[s].get(k),
  put: async (s, v) => { mem[s].set(memKey(s, v), v); },
  putMany: async (s, vs) => { vs.forEach((v) => mem[s].set(memKey(s, v), v)); },
  del: async (s, k) => { mem[s].delete(k); },
  all: async (s) => [...mem[s].values()],
  byIndex: async (s, i, v) => [...mem[s].values()].filter((x) => x[i] === v),
  clear: async (s) => mem[s].clear(),
};

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function store(name, mode) { const d = await dbp; return d.transaction(name, mode).objectStore(name); }
function done(t) { return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

const realDB = {
  get: async (s, k) => req((await store(s, 'readonly')).get(k)),
  put: async (s, v) => req((await store(s, 'readwrite')).put(v)),
  putMany: async (s, vs) => { const os = await store(s, 'readwrite'); vs.forEach((v) => os.put(v)); return done(os.transaction); },
  del: async (s, k) => req((await store(s, 'readwrite')).delete(k)),
  all: async (s) => req((await store(s, 'readonly')).getAll()),
  byIndex: async (s, i, v) => req((await store(s, 'readonly')).index(i).getAll(v)),
  clear: async (s) => req((await store(s, 'readwrite')).clear()),
};

export let idb = realDB;
export async function initDB() {
  try {
    dbp = open();
    await dbp;
    try { navigator.storage?.persist?.(); } catch {}
  } catch (e) {
    console.warn('IndexedDB unavailable, using memory', e);
    idb = memDB; persistent = false;
  }
}

/* ---------- change tracking ---------- */
let onDirty = () => {};
export function setDirtyListener(fn) { onDirty = fn; }
export const syncKey = (store, id) => `${store}/${id}`;
async function track(s, id, deleted) {
  if (!SYNCED.has(s)) return;
  const key = syncKey(s, id);
  const e = (await idb.get('sync', key)) || { key, store: s, id, b: null };
  e.dirty = 1;
  e.deleted = deleted ? 1 : 0;
  e.m = Math.max(Date.now(), (e.m || 0) + 1);
  if (s === 'files' && !deleted) e.up = 0;
  await idb.put('sync', e);
  onDirty();
}

// Exported wrapper so callers always hit the active backend.
// Pass { remote: true } for writes that came from the server, so they aren't pushed back.
export const db = {
  get: (...a) => idb.get(...a),
  all: (...a) => idb.all(...a),
  byIndex: (...a) => idb.byIndex(...a),
  clear: (...a) => idb.clear(...a),
  async put(s, v, opts = {}) {
    const r = await idb.put(s, v);
    if (!opts.remote) await track(s, v.id, false);
    return r;
  },
  async putMany(s, vs, opts = {}) {
    await idb.putMany(s, vs);
    if (!opts.remote) for (const v of vs) await track(s, v.id, false);
  },
  async del(s, k, opts = {}) {
    await idb.del(s, k);
    if (!opts.remote) await track(s, k, true);
  },
};
