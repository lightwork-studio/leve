import type { Database, SqlJsStatic, Statement } from "sql.js";
import {
  checkParams,
  type OpenOptions,
  type SqlConnection,
  type SqlEngine,
  type SqlRow,
  type SqlValue,
} from "./driver.ts";

/**
 * A storage engine on sql.js (SQLite compiled to WebAssembly), for the app's web build. Database
 * files live in memory as bytes; the caller decides how to keep them (the web app keeps them in
 * IndexedDB, see `onChange`).
 *
 * Each connection holds its own copy of the database, as SQLite connections see their own
 * snapshot. A connection publishes its copy when a write commits, and other connections load the
 * new version before their next statement outside a transaction. Only one connection may write a
 * file at a time, as with SQLite's write lock. The whole file is copied on every commit, which is
 * fine for a phone-sized database in a preview but not for large ones.
 */

/** The files an engine works on. */
export interface SqlJsFiles {
  get(path: string): Uint8Array | undefined;
  set(path: string, bytes: Uint8Array): void;
  delete(path: string): void;
  has(path: string): boolean;
}

export function memoryFiles(initial: Iterable<[string, Uint8Array]> = []): SqlJsFiles & {
  entries(): IterableIterator<[string, Uint8Array]>;
} {
  const files = new Map(initial);
  return {
    get: (path) => files.get(path),
    set: (path, bytes) => void files.set(path, bytes),
    delete: (path) => void files.delete(path),
    has: (path) => files.has(path),
    entries: () => files.entries(),
  };
}

export interface SqlJsEngineOptions {
  files?: SqlJsFiles;
  /** Told after a file's bytes changed, were added or were removed. */
  onChange?: (path: string) => void;
  /** Bytes per reported backup step. */
  stepBytes?: number;
}

type FileState = { version: number; writer: SqlJsConnection | null };

/**
 * Splits SQL into statements at semicolons outside quotes and comments. Enough for the SQL storage
 * code writes; CREATE TRIGGER bodies would be split too, and this engine doesn't support them.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i] as string;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
    } else if (char === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

type Kind = "begin" | "commit" | "rollback" | "other";

/**
 * What a piece of SQL does to the transaction. Transaction control has to be a statement of its
 * own, so the engine always knows whether a transaction is open; savepoints aren't supported.
 */
function classify(sql: string): Kind {
  const statements = splitStatements(sql);
  const kinds = statements.map((statement): Kind => {
    if (
      /^(SAVEPOINT|RELEASE)\b/i.test(statement) ||
      /^ROLLBACK\s+(TRANSACTION\s+)?TO\b/i.test(statement)
    ) {
      throw new Error("savepoints aren't supported by this engine");
    }
    if (/^BEGIN\b/i.test(statement)) return "begin";
    if (/^(COMMIT|END)\b/i.test(statement)) return "commit";
    if (/^ROLLBACK\b/i.test(statement)) return "rollback";
    return "other";
  });
  const control = kinds.find((kind) => kind !== "other");
  if (control && kinds.length > 1) {
    throw new Error("run BEGIN, COMMIT and ROLLBACK as statements of their own on this engine");
  }
  return control ?? "other";
}

/** Statements that only read; anything else must go through run() or exec(). */
const READ = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i;
const NO_TRANSACTION = /no transaction is active/i;

/** How many prepared reads a connection keeps; storage uses a few dozen distinct statements. */
const STATEMENT_CACHE = 64;

class SqlJsConnection implements SqlConnection {
  #db: Database;
  /** Prepared reads by their SQL, reused: preparing costs about as much as running a small read. */
  #statements = new Map<string, Statement>();
  #seen: number;
  #inTransaction = false;
  #closed = false;

  readonly path: string;
  private readonly sql: SqlJsStatic;
  private readonly readOnly: boolean;
  private readonly engine: SqlJsEngineInternals;

  constructor(path: string, sql: SqlJsStatic, readOnly: boolean, engine: SqlJsEngineInternals) {
    this.path = path;
    this.sql = sql;
    this.readOnly = readOnly;
    this.engine = engine;
    this.#db = this.#load();
    this.#seen = engine.state(path).version;
  }

  #load(): Database {
    const db = new this.sql.Database(this.engine.files.get(this.path) ?? null);
    this.#configure(db);
    return db;
  }

  #configure(db: Database): void {
    db.exec("PRAGMA foreign_keys = ON");
    if (this.readOnly) db.exec("PRAGMA query_only = ON");
  }

  /** Loads what others committed since this connection last looked. */
  #refresh(): void {
    if (this.#closed) throw new Error(`${this.path} is closed`);
    if (this.#inTransaction) return;
    const { version } = this.engine.state(this.path);
    if (version === this.#seen) return;
    this.#forgetStatements();
    this.#db.close();
    this.#db = this.#load();
    this.#seen = version;
  }

  /** Drops the cached statements; the caller closes or replaces the database, which frees them. */
  #forgetStatements(): void {
    this.#statements.clear();
  }

  #prepared(sql: string): Statement {
    const cached = this.#statements.get(sql);
    if (cached) {
      // Most recently used last, so the oldest is the one dropped when the cache is full.
      this.#statements.delete(sql);
      this.#statements.set(sql, cached);
      return cached;
    }
    const statement = this.#db.prepare(sql);
    if (this.#statements.size >= STATEMENT_CACHE) {
      const [oldest, dropped] = this.#statements.entries().next().value as [string, Statement];
      this.#statements.delete(oldest);
      dropped.free();
    }
    this.#statements.set(sql, statement);
    return statement;
  }

  #lock(): void {
    const state = this.engine.state(this.path);
    if (state.writer && state.writer !== this) throw new Error(`${this.path}: database is locked`);
    state.writer = this;
  }

  #unlock(): void {
    const state = this.engine.state(this.path);
    if (state.writer === this) state.writer = null;
  }

  /** Makes this connection's committed state the file's current version. */
  #publish(): void {
    // Older sql.js versions reopen the database on export, which frees prepared statements.
    for (const statement of this.#statements.values()) statement.free();
    this.#forgetStatements();
    const bytes = this.#db.export();
    // Some sql.js versions reopen the database on export, which resets its pragmas.
    this.#configure(this.#db);
    this.engine.files.set(this.path, bytes);
    const state = this.engine.state(this.path);
    state.version += 1;
    this.#seen = state.version;
    this.engine.changed(this.path);
  }

  /** Runs SQL that may write or control a transaction, keeping the lock and publication straight. */
  #write<T>(sql: string, run: () => T): T {
    const kind = classify(sql);
    if (kind === "begin") {
      // A nested BEGIN fails in SQLite and must leave the open transaction and its lock alone.
      if (this.#inTransaction) return run();
      this.#refresh();
      if (!this.readOnly) this.#lock();
      try {
        const result = run();
        this.#inTransaction = true;
        return result;
      } catch (error) {
        if (!this.readOnly) this.#unlock();
        throw error;
      }
    }
    if (kind === "commit" || kind === "rollback") {
      const open = this.#inTransaction;
      const end = () => {
        this.#inTransaction = false;
        this.#unlock();
      };
      let result: T;
      try {
        result = run();
      } catch (error) {
        // SQLite may already have rolled back on its own (INSERT OR ROLLBACK, out of memory):
        // a ROLLBACK then has nothing left to do, and a COMMIT has nothing to commit. Any other
        // failure (a COMMIT refused by a constraint) leaves the transaction open.
        if (!NO_TRANSACTION.test((error as Error).message)) throw error;
        end();
        if (kind === "rollback") return undefined as T;
        throw error;
      }
      if (kind === "commit" && open && !this.readOnly) this.#publish();
      end();
      return result;
    }
    this.#refresh();
    if (this.readOnly || this.#inTransaction) return run();
    this.#lock();
    try {
      const result = run();
      this.#publish();
      return result;
    } finally {
      this.#unlock();
    }
  }

  exec(sql: string): void {
    this.#write(sql, () => void this.#db.exec(sql));
  }

  run(sql: string, params: readonly SqlValue[] = []): { changes: number } {
    checkParams(params);
    return this.#write(sql, () => {
      this.#db.run(sql, bind(params));
      return { changes: this.#db.getRowsModified() };
    });
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    checkParams(params);
    // A write here would never be published, so reads stay reads.
    if (!READ.test(sql) || /\bRETURNING\b/i.test(sql)) {
      throw new Error("this engine runs statements that write through run() or exec() only");
    }
    this.#refresh();
    const statement = this.#prepared(sql);
    try {
      statement.bind(bind(params));
      // Rows as arrays, named here: sql.js's getAsObject asks for the column names on every row,
      // which made reads several times slower. The names are read after the first step: a schema
      // change re-prepares a cached statement there, and names read earlier would be the old ones.
      let names: string[] | undefined;
      const rows: SqlRow[] = [];
      while (statement.step()) {
        names ??= statement.getColumnNames();
        const values = statement.get();
        const row: SqlRow = {};
        for (let i = 0; i < names.length; i++) row[names[i] as string] = values[i] as SqlValue;
        rows.push(row);
      }
      return rows;
    } finally {
      // Kept for next time, reset so it holds no read open.
      statement.reset();
    }
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    return this.all(sql, params)[0];
  }

  /** The committed bytes this connection sees, for a backup. */
  snapshot(): Uint8Array {
    this.#refresh();
    if (this.#inTransaction) {
      // A backup copies committed data; inside a transaction that is the file's current version.
      return this.engine.files.get(this.path) ?? new this.sql.Database().export();
    }
    // As in #publish: an export may free prepared statements.
    for (const statement of this.#statements.values()) statement.free();
    this.#forgetStatements();
    const bytes = this.#db.export();
    this.#configure(this.#db);
    return bytes;
  }

  close(): void {
    if (this.#closed) return;
    if (this.#inTransaction) {
      try {
        this.#db.exec("ROLLBACK");
      } catch (error) {
        if (!NO_TRANSACTION.test((error as Error).message)) throw error;
      }
      this.#inTransaction = false;
    }
    this.#unlock();
    this.#forgetStatements();
    this.#db.close();
    this.#closed = true;
  }
}

/** sql.js binds numbers, text, blobs and null; a bigint is bound as a number when it fits. */
function bind(params: readonly SqlValue[]): (number | string | Uint8Array | null)[] {
  return params.map((value) => {
    if (typeof value !== "bigint") return value;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("integers beyond 2^53 are not supported by this engine");
    }
    return Number(value);
  });
}

interface SqlJsEngineInternals {
  files: SqlJsFiles;
  state(path: string): FileState;
  changed(path: string): void;
}

export function createSqlJsEngine(sql: SqlJsStatic, options: SqlJsEngineOptions = {}): SqlEngine {
  const files = options.files ?? memoryFiles();
  const states = new Map<string, FileState>();
  const internals: SqlJsEngineInternals = {
    files,
    state(path) {
      let state = states.get(path);
      if (!state) {
        state = { version: 0, writer: null };
        states.set(path, state);
      }
      return state;
    },
    changed(path) {
      options.onChange?.(path);
    },
  };
  const bump = (path: string) => {
    internals.state(path).version += 1;
    internals.changed(path);
  };
  const stepBytes = options.stepBytes ?? 64 * 1024;

  return {
    open(path: string, openOptions: OpenOptions = {}): SqlConnection {
      const readOnly = openOptions.readOnly ?? false;
      if (!files.has(path)) {
        if (readOnly) throw new Error(`${path}: unable to open database file`);
        files.set(path, new sql.Database().export());
        bump(path);
      }
      return new SqlJsConnection(path, sql, readOnly, internals);
    },

    async backup(source, destinationPath, onStep) {
      if (!(source instanceof SqlJsConnection)) {
        throw new Error("backup needs a connection from this engine");
      }
      // SQLite would report the destination busy while another connection writes to it.
      if (internals.state(destinationPath).writer) {
        throw new Error(`${destinationPath}: database is locked`);
      }
      const bytes = source.snapshot();
      const steps = Math.max(1, Math.ceil(bytes.length / stepBytes));
      for (let step = 1; step <= steps; step++) {
        await Promise.resolve();
        onStep?.(step);
      }
      // The destination changes in one step, so an interrupted copy leaves it as it was.
      files.set(destinationPath, bytes);
      bump(destinationPath);
    },

    exists: (path) => files.has(path),

    remove(path) {
      if (!files.has(path)) return;
      files.delete(path);
      bump(path);
    },

    rename(from, to) {
      if (from === to) return;
      const bytes = files.get(from);
      if (!bytes) throw new Error(`${from}: no such file`);
      files.set(to, bytes);
      files.delete(from);
      bump(to);
      bump(from);
    },
  };
}
