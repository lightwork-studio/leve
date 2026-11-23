import type { SqlJsFiles } from "@leve/storage/sqljs";
import { PREVIEW_STORAGE } from "./preview-storage.ts";

// Database files of the web build, kept in IndexedDB. Every file is loaded into memory at start;
// changes are written back shortly after they happen and when the page is hidden. A change made
// in the last moment before the tab is killed can be lost, which is acceptable for previews. A
// failed save is retried (reopening the database, which Safari can close in the background) and
// reported, never dropped.

const STORE = "files";
const SAVE_DELAY_MS = 250;
const RETRY_DELAY_MS = 2000;

export interface BrowserFiles extends SqlJsFiles {
  paths(): string[];
  saveSoon(path: string): void;
  /** Writes pending changes now. Resolves either way; failures go to `onSaveProblem`. */
  flush(): Promise<void>;
  /** Told when saving fails (with the reason) and when it works again (with null). */
  onSaveProblem(listener: (problem: string | null) => void): void;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const req = indexedDB.open(PREVIEW_STORAGE, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  return request(req);
}

async function readFiles(db: IDBDatabase): Promise<Map<string, Uint8Array>> {
  const read = db.transaction(STORE, "readonly").objectStore(STORE);
  const [keys, values] = await Promise.all([
    request(read.getAllKeys()),
    request(read.getAll() as IDBRequest<Uint8Array[]>),
  ]);
  const files = new Map<string, Uint8Array>();
  keys.forEach((key, index) => {
    const bytes = values[index];
    if (typeof key === "string" && bytes) files.set(key, new Uint8Array(bytes));
  });
  return files;
}

/** Read the last committed files in one transaction, even when this tab cannot open a writer. */
export async function readRecoveryFiles() {
  const opening = indexedDB.open(PREVIEW_STORAGE);
  // An export of an empty origin must not create or upgrade a database.
  opening.onupgradeneeded = () => opening.transaction?.abort();
  const db = await request(opening);
  try {
    const saved = await readFiles(db);
    return { paths: () => [...saved.keys()], get: (path: string) => saved.get(path) };
  } finally {
    db.close();
  }
}

/** Hold the browser lock for the page’s lifetime so another tab cannot overwrite its database. */
export async function claimBrowserData(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error(
      "Leve needs a secure connection and a browser with Web Locks to save workouts safely.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    navigator.locks
      .request(`${PREVIEW_STORAGE}-data`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error("Leve is open in another tab. Close it there, then reload this page."));
          return;
        }
        resolve();
        return new Promise<void>(() => {});
      })
      .catch(reject);
  });
}

export async function loadBrowserFiles(): Promise<BrowserFiles> {
  let db = await openDatabase();
  const files = await readFiles(db);

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let problem: string | null = null;
  const listeners: ((problem: string | null) => void)[] = [];
  const report = (next: string | null) => {
    if (next === problem) return;
    problem = next;
    for (const listener of listeners) listener(next);
  };

  /** Writes the current bytes of `paths` (or deletes them) in one transaction. */
  const write = (paths: string[]) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const path of paths) {
        const bytes = files.get(path);
        if (bytes) store.put(bytes, path);
        else store.delete(path);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("saving failed"));
      tx.onabort = () => reject(tx.error ?? new Error("saving was aborted"));
    });

  const schedule = (delay: number) => {
    if (!timer) timer = setTimeout(() => void flush(), delay);
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return writing;
    const paths = [...pending];
    pending.clear();
    writing = writing.then(async () => {
      try {
        try {
          await write(paths);
        } catch {
          // The connection may be gone; open it again and try once more.
          db = await openDatabase();
          await write(paths);
        }
        report(null);
      } catch (error) {
        for (const path of paths) pending.add(path);
        report((error as Error)?.message ?? "saving failed");
        schedule(RETRY_DELAY_MS);
      }
    });
    return writing;
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flush();
    });
  }
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => void flush());

  return {
    get: (path) => files.get(path),
    set: (path, bytes) => void files.set(path, bytes),
    delete: (path) => void files.delete(path),
    has: (path) => files.has(path),
    paths: () => [...files.keys()],
    saveSoon(path) {
      pending.add(path);
      schedule(SAVE_DELAY_MS);
    },
    flush,
    onSaveProblem(listener) {
      listeners.push(listener);
    },
  };
}
