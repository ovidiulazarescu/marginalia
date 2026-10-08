// Minimal promise wrapper around IndexedDB, with an in-memory fallback
// for browsers or frames where storage is blocked.
const NAME = 'marginalia';
const STORES = ['notes', 'notebooks', 'versions', 'files', 'pdftext', 'kv'];
let dbp;
export let persistent = true;

function open() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(NAME, 1); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('notebooks', { keyPath: 'id' });
      d.createObjectStore('versions', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('pdftext', { keyPath: 'id' });
      d.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
}

const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
const memKey = (store, v) => (store === 'kv' ? v.key : v.id);
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
// Exported wrapper so callers always hit the active backend.
export const db = {
  get: (...a) => idb.get(...a), put: (...a) => idb.put(...a), putMany: (...a) => idb.putMany(...a),
  del: (...a) => idb.del(...a), all: (...a) => idb.all(...a), byIndex: (...a) => idb.byIndex(...a), clear: (...a) => idb.clear(...a),
};
