/**
 * The small SQL surface that storage code is written against. One implementation wraps Node's
 * built-in SQLite (server and tests); the phone gets an expo-sqlite implementation.
 *
 * Statements are synchronous. Copying a whole database (snapshot and restore) is asynchronous
 * because SQLite's online backup runs in steps.
 */

/**
 * Text values never contain U+0000: some SQLite bindings (node:sqlite before Node 24) cut such text
 * off when reading it back, so every engine refuses it instead of returning less than it was
 * given. Stored JSON escapes the character, and ids can't contain it.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

export class SqlValueError extends Error {
  override name = "SqlValueError";
}

/** Throws for a text value an engine can't store exactly. */
export function checkParams(params: readonly SqlValue[]): void {
  for (const value of params) {
    if (typeof value === "string" && value.includes("\u0000")) {
      throw new SqlValueError("text values can't contain U+0000");
    }
  }
}
export type SqlRow = Record<string, SqlValue>;

export interface SqlConnection {
  readonly path: string;
  /** Runs one or more statements without parameters. */
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  get(sql: string, params?: readonly SqlValue[]): SqlRow | undefined;
  /**
   * Runs `fn` in one write transaction, for engines that refuse BEGIN statements (such as
   * Cloudflare Durable Objects). Without it, transactions use BEGIN IMMEDIATE and COMMIT.
   */
  transaction?<T>(fn: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** Opens without write access. Used to inspect a database before deciding to touch it. */
  readOnly?: boolean;
  /** Exclusive version inspection at startup; a detached read of recovery files is safe here. */
  exclusiveInspection?: boolean;
}

export interface SqlEngine {
  open(path: string, options?: OpenOptions): SqlConnection;
  /**
   * Copies the database behind `source` into the file at `destinationPath` with SQLite's online
   * backup, replacing whatever the destination held. The destination is written in one SQLite
   * transaction, so an interrupted copy leaves the destination as it was. `onStep` is called after
   * each backup step.
   */
  backup(
    source: SqlConnection,
    destinationPath: string,
    onStep?: (step: number) => void,
  ): Promise<void>;
  exists(path: string): boolean;
  /** Removes a file; does nothing if it is missing. */
  remove(path: string): void;
  /** Atomically renames a file, replacing the target. */
  rename(from: string, to: string): void;
}
