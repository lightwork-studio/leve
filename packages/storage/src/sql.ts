import type { SqlConnection, SqlValue } from "./driver.ts";
import { rollbackQuietly } from "./upgrade.ts";

/** Runs `fn` in one write transaction; any error rolls everything back. */
export function transaction<T>(db: SqlConnection, fn: () => T): T {
  if (db.transaction) return db.transaction(fn);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

export const json = (value: unknown): string => JSON.stringify(value);

export function parseJson<T>(value: SqlValue | undefined, what: string): T {
  if (typeof value !== "string") throw new Error(`${what}: expected JSON text`);
  return JSON.parse(value) as T;
}

export const text = (value: SqlValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

export const int = (value: SqlValue | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
