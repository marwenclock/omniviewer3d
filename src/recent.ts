// Recently opened files, kept only in this browser (IndexedDB). Nothing is uploaded.

export interface RecentEntry {
  id: string;
  name: string;
  date: number;
  size: number;
  /** local files are stored as blobs; URL-opened models only store the links */
  files?: { name: string; blob: Blob }[];
  urls?: string[];
  /** small preview image (data URL) */
  thumb?: string;
}

const DB = 'omniviewer';
const STORE = 'recent';
const MAX_ENTRIES = 10;
const MAX_BYTES = 250 * 1024 * 1024; // keep the cache reasonable

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function listRecent(): Promise<RecentEntry[]> {
  try {
    const all = await tx<RecentEntry[]>('readonly', (s) => s.getAll() as IDBRequest<RecentEntry[]>);
    return all.sort((a, b) => b.date - a.date);
  } catch { return []; }
}

export async function addRecent(name: string, files: File[] | null, urls: string[] | null, thumb?: string) {
  try {
    const size = files ? files.reduce((n, f) => n + f.size, 0) : 0;
    const key = urls ? 'url:' + urls.join(',') : 'file:' + (files || []).map((f) => `${f.name}:${f.size}`).join(',');
    const entry: RecentEntry = {
      id: key, name, date: Date.now(), size,
      files: files && size <= MAX_BYTES ? files.map((f) => ({ name: f.name, blob: f })) : undefined,
      urls: urls || undefined,
      thumb,
    };
    if (!entry.files && !entry.urls) return; // too big to keep
    await tx('readwrite', (s) => s.put(entry));
    // Trim to the newest entries and the size budget.
    const all = await listRecent();
    let bytes = 0;
    for (const [i, e] of all.entries()) {
      bytes += e.size;
      if (i >= MAX_ENTRIES || bytes > MAX_BYTES) await tx('readwrite', (s) => s.delete(e.id));
    }
  } catch (e) { console.warn('recent files unavailable', e); }
}

export async function removeRecent(id: string) { try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ignore */ } }
export async function clearRecent() { try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ } }

export function entryFiles(e: RecentEntry): File[] {
  return (e.files || []).map((f) => new File([f.blob], f.name));
}
