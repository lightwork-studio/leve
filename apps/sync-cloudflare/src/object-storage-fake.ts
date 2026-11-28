// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { DatabaseSync } from "node:sqlite";
import type { ObjectSqlStorage } from "./do-sql.ts";

// For tests: a stand-in for a Durable Object's storage on Node's SQLite. Like the real one it
// refuses transaction statements, binds only ArrayBuffers, strings, numbers and null, and runs
// transactions through transactionSync. Its key-value calls and deleteAll work on the same
// database, as on a SQLite-backed object.

type Value = ArrayBuffer | string | number | null;

export function fakeObjectStorage() {
  const db = new DatabaseSync(":memory:");
  const steps = { rows: 0 };
  /** Set to make the next deleteAll fail before it removes anything, like a crash. */
  const faults = { deleteAll: false };
  const kv = new Map<string, unknown>();
  const storage: ObjectSqlStorage & {
    deleteAll(): Promise<void>;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  } = {
    sql: {
      exec(query, ...bindings) {
        if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) {
          throw new Error(`not allowed in a Durable Object: ${query}`);
        }
        for (const value of bindings as unknown[]) {
          if (!(value === null || ["string", "number"].includes(typeof value))) {
            if (!(value instanceof ArrayBuffer)) throw new TypeError("unsupported binding");
          }
        }
        let rows: Record<string, Value>[] = [];
        if (bindings.length === 0 && query.includes(";")) db.exec(query);
        else {
          const statement = db.prepare(query);
          const params = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
          if (statement.columns().length > 0) {
            rows = (statement.all(...params) as Record<string, unknown>[]).map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [
                  k,
                  v instanceof Uint8Array ? v.slice().buffer : (v as Value),
                ]),
              ),
            );
          } else statement.run(...params);
        }
        let index = 0;
        return {
          toArray() {
            steps.rows += rows.length - index;
            const rest = rows.slice(index);
            index = rows.length;
            return rest;
          },
          next() {
            if (index >= rows.length) return { done: true };
            steps.rows += 1;
            return { done: false, value: rows[index++] };
          },
          rowsRead: 0,
          rowsWritten: 0,
        };
      },
    },
    transactionSync(fn) {
      db.exec("SAVEPOINT object");
      try {
        const result = fn();
        db.exec("RELEASE object");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO object");
        db.exec("RELEASE object");
        throw error;
      }
    },
    async deleteAll() {
      if (faults.deleteAll) {
        faults.deleteAll = false;
        throw new Error("the object was reset");
      }
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
      kv.clear();
    },
    async get<T>(key: string) {
      return kv.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      kv.set(key, value);
    },
    async delete(key: string) {
      return kv.delete(key);
    },
  };
  /** The tables the object's database holds. */
  const tables = () =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map(({ name }) => name);
  return { storage, steps, faults, tables };
}
