import { existsSync, renameSync, rmSync } from "node:fs";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
  checkParams,
  type OpenOptions,
  type SqlConnection,
  type SqlEngine,
  type SqlRow,
  type SqlValue,
} from "./driver.ts";

class NodeSqliteConnection implements SqlConnection {
  readonly path: string;
  readonly db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string, options: OpenOptions, cacheSizePages: number | undefined) {
    this.path = path;
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    // A second connection (another request, a test's competing writer) waits instead of failing.
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (cacheSizePages !== undefined) this.db.exec(`PRAGMA cache_size = ${cacheSizePages}`);
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlValue[] = []): { changes: number } {
    checkParams(params);
    const result = this.#prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  all(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    checkParams(params);
    return this.#prepare(sql).all(...params) as SqlRow[];
  }

  get(sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
    checkParams(params);
    return this.#prepare(sql).get(...params) as SqlRow | undefined;
  }

  close(): void {
    this.#statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}

export interface NodeSqliteEngineOptions {
  /** Pages copied per backup step. Small values make steps observable in tests. */
  backupPagesPerStep?: number;
  /**
   * Page cache size per connection. A tiny cache makes SQLite write to the database file before a
   * transaction commits, which tests use to leave behind journals that need rolling back.
   */
  cacheSizePages?: number;
}

/** Storage engine on Node's built-in `node:sqlite` module, for the server and for tests. */
export function createNodeSqliteEngine(options: NodeSqliteEngineOptions = {}): SqlEngine {
  const rate = options.backupPagesPerStep ?? 100;
  const cache = options.cacheSizePages;
  if (cache !== undefined && !Number.isSafeInteger(cache)) throw new Error("invalid cache size");
  return {
    open: (path, openOptions = {}) => new NodeSqliteConnection(path, openOptions, cache),
    async backup(source, destinationPath, onStep) {
      if (!(source instanceof NodeSqliteConnection)) {
        throw new TypeError("backup source must come from the same engine");
      }
      let step = 0;
      await backup(source.db, destinationPath, {
        rate,
        progress: () => {
          step += 1;
          onStep?.(step);
        },
      });
      // Node reports every step except the one that finishes the copy.
      onStep?.(step + 1);
    },
    exists: (path) => existsSync(path),
    remove: (path) => rmSync(path, { force: true }),
    rename: (from, to) => renameSync(from, to),
  };
}
