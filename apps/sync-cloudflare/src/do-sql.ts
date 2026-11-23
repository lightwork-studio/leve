// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  checkParams,
  type SqlConnection,
  type SqlRow,
  type SqlValue,
  SqlValueError,
} from "@leve/storage";

/** Rows SQLite read and wrote for the current request: Cloudflare bills Durable Object SQL by them. */
export interface SqlMeter {
  rowsRead: number;
  rowsWritten: number;
}

type ObjectValue = ArrayBuffer | string | number | null;

interface ObjectCursor {
  toArray(): Record<string, ObjectValue>[];
  next(): { done?: boolean; value?: Record<string, ObjectValue> };
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** The part of a Durable Object's storage the adapter uses. */
export interface ObjectSqlStorage {
  sql: { exec(query: string, ...bindings: ObjectValue[]): ObjectCursor };
  transactionSync<T>(fn: () => T): T;
}

function toRow(row: Record<string, ObjectValue>): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return out;
}

/** Objects bind ArrayBuffers and plain numbers, never typed arrays or bigints. */
function toBinding(value: SqlValue): ObjectValue {
  if (value instanceof Uint8Array) return value.slice().buffer;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new SqlValueError("integers beyond 2^53 can't be stored exactly");
    }
    return Number(value);
  }
  return value;
}

/**
 * The storage packages' SQL surface over a Durable Object's own SQLite database. Durable Objects
 * refuse BEGIN and COMMIT, so transactions go through `transactionSync`, which rolls back every
 * write when its callback throws.
 */
export function durableObjectConnection(storage: ObjectSqlStorage, meter: SqlMeter): SqlConnection {
  const sql = storage.sql;
  const open = (query: string, params: readonly SqlValue[] = []) => {
    checkParams(params);
    return sql.exec(query, ...params.map(toBinding));
  };
  const count = (cursor: ObjectCursor) => {
    meter.rowsRead += cursor.rowsRead;
    meter.rowsWritten += cursor.rowsWritten;
  };
  const all = (query: string, params?: readonly SqlValue[]) => {
    const cursor = open(query, params);
    const rows = cursor.toArray();
    count(cursor);
    return rows;
  };
  return {
    path: "durable-object",
    exec(query) {
      all(query);
    },
    run(query, params) {
      all(query, params);
      return { changes: Number(sql.exec("SELECT changes() AS n").toArray()[0]?.n ?? 0) };
    },
    all(query, params) {
      return all(query, params).map(toRow);
    },
    get(query, params) {
      // Only the first row is stepped to, as with other engines.
      const cursor = open(query, params);
      const first = cursor.next();
      count(cursor);
      return first.done || !first.value ? undefined : toRow(first.value);
    },
    transaction(fn) {
      return storage.transactionSync(fn);
    },
    close() {
      // The database belongs to the object and stays open for its lifetime.
    },
  };
}
