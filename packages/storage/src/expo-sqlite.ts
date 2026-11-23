import {
  checkParams,
  type OpenOptions,
  type SqlConnection,
  type SqlEngine,
  type SqlRow,
  type SqlValue,
} from "./driver.ts";

/**
 * The phone's storage engine on expo-sqlite's synchronous API. The app passes in the expo modules
 * (this package doesn't depend on them), so the mapping below is tested with a stand-in that has
 * the same API on Node's SQLite; the engine itself must still be checked on a device.
 *
 * Paths such as `/leve/device.db` become file names in expo-sqlite's database directory, with "/"
 * turned into "__" (`leve__device.db`), so SQLite's own journal (`…-journal`, `…-wal`) and the
 * storage code's sidecar files (`….snapshot-v2`) keep the same relationship as on a filesystem.
 */

/** The part of an expo-sqlite database this engine uses. */
export interface ExpoSqliteDatabase {
  execSync(source: string): void;
  runSync(source: string, params: ExpoBindValue[]): { changes: number };
  getAllSync(source: string, params: ExpoBindValue[]): Record<string, unknown>[];
  getFirstSync(source: string, params: ExpoBindValue[]): Record<string, unknown> | null;
  closeSync(): void;
}

export type ExpoBindValue = string | number | null | Uint8Array;

/** The expo-sqlite and file functions the engine needs, by database file name. */
export interface ExpoSqliteApi {
  /** Opens a new connection (never a shared one) to a database file, creating it if missing. */
  openDatabase(name: string): ExpoSqliteDatabase;
  /** A private scratch directory for examining an interrupted database without replaying its journal in place. */
  createInspectionDirectory(): {
    copyFromDatabaseDirectory(name: string): void;
    openDatabase(name: string): ExpoSqliteDatabase;
    remove(): void;
  };
  backupDatabaseAsync(options: {
    sourceDatabase: ExpoSqliteDatabase;
    destDatabase: ExpoSqliteDatabase;
  }): Promise<void>;
  backupDatabaseSync(options: {
    sourceDatabase: ExpoSqliteDatabase;
    destDatabase: ExpoSqliteDatabase;
  }): void;
  exists(name: string): boolean;
  /** Deletes a file; does nothing if it is missing. */
  remove(name: string): void;
}

/** The file name a path is stored under. Paths with "__" are refused, as they wouldn't map back. */
export const expoFileName = (path: string): string => {
  if (path.includes("__")) throw new Error(`${path}: paths can't contain "__" on this engine`);
  return path.replace(/^\/+/, "").replaceAll("/", "__");
};

/** The path a file name stands for (the reverse of `expoFileName`). */
export const expoPath = (name: string): string => `/${name.replaceAll("__", "/")}`;

function bind(params: readonly SqlValue[]): ExpoBindValue[] {
  return params.map((value) => {
    if (typeof value !== "bigint") return value;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("integers beyond 2^53 are not supported by this engine");
    }
    return Number(value);
  });
}

class ExpoConnection implements SqlConnection {
  readonly path: string;
  readonly native: ExpoSqliteDatabase;
  #closed = false;
  readonly #onClose?: () => void;

  constructor(path: string, native: ExpoSqliteDatabase, readOnly: boolean, onClose?: () => void) {
    this.path = path;
    this.native = native;
    this.#onClose = onClose;
    // Like the server's engine: wait for a busy file instead of failing, and enforce references.
    native.execSync("PRAGMA busy_timeout = 5000");
    native.execSync("PRAGMA foreign_keys = ON");
    // expo-sqlite has no read-only open; SQLite refuses writes on this connection instead.
    if (readOnly) native.execSync("PRAGMA query_only = ON");
  }

  exec(sql: string): void {
    this.native.execSync(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): { changes: number } {
    checkParams(params);
    return { changes: this.native.runSync(sql, bind(params)).changes };
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    checkParams(params);
    return this.native.getAllSync(sql, bind(params)) as SqlRow[];
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    checkParams(params);
    return (this.native.getFirstSync(sql, bind(params)) ?? undefined) as SqlRow | undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.native.closeSync();
    } finally {
      this.#onClose?.();
    }
  }
}

export function createExpoSqliteEngine(api: ExpoSqliteApi): SqlEngine {
  return {
    open(path: string, options: OpenOptions = {}): SqlConnection {
      const name = expoFileName(path);
      const readOnly = options.readOnly ?? false;
      // Opening creates a missing file, which a read-only open must never do.
      if (readOnly && !api.exists(name)) throw new Error(`${path}: unable to open database file`);
      if (readOnly && options.exclusiveInspection) {
        const journals = [name + "-wal", name + "-journal"].filter((file) => api.exists(file));
        if (journals.length) {
          // SQLite may recover a journal or checkpoint a WAL even with query_only enabled.
          // The shared-memory index belongs to the old process. SQLite rebuilds it on the copy.
          const copy = api.createInspectionDirectory();
          try {
            for (const file of [name, ...journals]) copy.copyFromDatabaseDirectory(file);
            const native = copy.openDatabase(name);
            try {
              return new ExpoConnection(path, native, true, () => copy.remove());
            } catch (error) {
              native.closeSync();
              throw error;
            }
          } catch (error) {
            copy.remove();
            throw error;
          }
        }
      }
      return new ExpoConnection(path, api.openDatabase(name), readOnly);
    },

    async backup(source, destinationPath, onStep) {
      if (!(source instanceof ExpoConnection)) {
        throw new Error("backup needs a connection from this engine");
      }
      const destination = api.openDatabase(expoFileName(destinationPath));
      try {
        // SQLite's online backup, in one step; the destination changes in one transaction.
        await api.backupDatabaseAsync({ sourceDatabase: source.native, destDatabase: destination });
        onStep?.(1);
      } finally {
        destination.closeSync();
      }
    },

    exists: (path) => api.exists(expoFileName(path)),
    remove: (path) => api.remove(expoFileName(path)),
    // There is no atomic file replace on phones (expo-file-system's move with overwrite deletes the
    // target first), and storage only renames finished databases (an upgrade snapshot into place).
    // So the rename copies with SQLite's backup, which changes the target in one transaction, then
    // deletes the source. A crash in between leaves the finished copy and a leftover source that the
    // next upgrade removes. The database is copied twice per upgrade, fine at phone sizes.
    rename: (from, to) => {
      if (from === to) return;
      const source = expoFileName(from);
      const target = expoFileName(to);
      if (!api.exists(source)) throw new Error(`${from}: no such file`);
      const sourceDb = api.openDatabase(source);
      const targetDb = api.openDatabase(target);
      try {
        api.backupDatabaseSync({ sourceDatabase: sourceDb, destDatabase: targetDb });
      } finally {
        sourceDb.closeSync();
        targetDb.closeSync();
      }
      api.remove(source);
    },
  };
}
