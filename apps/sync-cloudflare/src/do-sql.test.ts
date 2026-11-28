import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type JsonObject, MAX_REQUEST_BYTES } from "@leve/contract";
import { WRITTEN_REVISIONS_HEADER } from "@leve/sync";
import { SyncService } from "@leve/sync/server";
import { describe, expect, it } from "vitest";
import { openAccountDatabase, readSyncBody, startNewLineage, syncResponse } from "./account-db.ts";
import { durableObjectConnection, type ObjectSqlStorage, type SqlMeter } from "./do-sql.ts";

// A stand-in for a Durable Object's storage on Node's SQLite. Like the real one it refuses
// transaction statements, binds only ArrayBuffers, strings, numbers and null, and runs
// transactions through transactionSync.

type Value = ArrayBuffer | string | number | null;

function fakeObjectStorage(path = ":memory:") {
  const db = new DatabaseSync(path);
  const steps = { rows: 0 };
  const storage: ObjectSqlStorage = {
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
  };
  return { storage, steps, close: () => db.close() };
}

const meter = (): SqlMeter => ({ rowsRead: 0, rowsWritten: 0 });
const T = "2026-11-10T08:00:00.000Z";
const workout: JsonObject = {
  title: "Push",
  startedAt: T,
  endedAt: T,
  routineId: null,
  initialPlan: null,
};

describe("a Durable Object's database as account storage", () => {
  it("runs the sync service and answers like the self-hosted server", async () => {
    const { storage } = fakeObjectStorage();
    const db = durableObjectConnection(storage, meter());
    expect(openAccountDatabase(db, false)).toBeNull();
    const store = openAccountDatabase(db, true);
    if (!store) throw new Error("no store");
    const service = new SyncService({ storage: { account: async () => store } });

    const hello = await service.hello("a", { releases: ["1.0"], app: "test" });
    const lineage = (hello.body as { lineage: string }).lineage;
    const push = await service.push("a", {
      release: "1.0",
      lineage,
      submissions: [
        {
          submissionId: "s1",
          op: "put",
          kind: "workout",
          id: "w1",
          baseRevision: null,
          content: workout,
        },
      ],
    });
    expect(push.body).toMatchObject({ results: [{ status: "accepted", revision: 1 }] });
    const response = syncResponse(push);
    expect(response.headers.get(WRITTEN_REVISIONS_HEADER)).toBe("1");

    const pull = await service.pull("a", { release: "1.0", lineage, cursor: 0 });
    expect(pull.body).toMatchObject({ cursor: 1, changes: [{ kind: "workout", id: "w1" }] });
    expect(syncResponse(pull).headers.get(WRITTEN_REVISIONS_HEADER)).toBeNull();

    // The same database opened again is the same account, not a new one.
    expect(openAccountDatabase(durableObjectConnection(storage, meter()), false)?.lineage()).toBe(
      lineage,
    );
  });

  it("rolls back a failed transaction and counts changes", () => {
    const { storage } = fakeObjectStorage();
    const db = durableObjectConnection(storage, meter());
    const store = openAccountDatabase(db, true);
    if (!store) throw new Error("no store");
    expect(() =>
      store.transaction((tx) => {
        tx.writeLive("workout", "w1", workout);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(store.headRevision()).toBe(0);
    expect(store.db.get("SELECT count(*) AS n FROM records")).toEqual({ n: 0 });

    store.transaction((tx) => {
      tx.saveReceipt({
        submissionId: "old",
        kind: "workout",
        id: "w1",
        revision: 1,
        digest: "d",
        acceptedAt: "2020-01-01T00:00:00.000Z",
      });
    });
    expect(store.transaction((tx) => tx.pruneReceipts("2021-01-01T00:00:00.000Z"))).toBe(1);
  });

  it("starts a new lineage after a restore and keeps where it split", () => {
    const { storage } = fakeObjectStorage();
    const store = openAccountDatabase(durableObjectConnection(storage, meter()), true);
    if (!store) throw new Error("no store");
    store.transaction((tx) => tx.writeLive("workout", "w1", workout));
    const before = store.lineage();
    startNewLineage(store);
    expect(store.lineage()).not.toBe(before);
    expect(store.restoredFrom()).toEqual({ lineage: before, restorePoint: 1 });
  });

  it("binds bytes and safe integers, refuses others, and steps only to the first row", () => {
    const { storage, steps } = fakeObjectStorage();
    const db = durableObjectConnection(storage, meter());
    db.exec("CREATE TABLE t (b BLOB, n INTEGER); CREATE TABLE u (x INTEGER)");
    db.run("INSERT INTO t VALUES (?, ?)", [new Uint8Array([1, 2, 3]).subarray(1), 7n]);
    expect(db.get("SELECT b, n FROM t")).toEqual({ b: new Uint8Array([2, 3]), n: 7 });
    expect(() => db.run("INSERT INTO t VALUES (NULL, ?)", [2n ** 60n])).toThrow("2^53");

    for (let i = 0; i < 5; i++) db.run("INSERT INTO u VALUES (?)", [i]);
    steps.rows = 0;
    expect(db.get("SELECT x FROM u ORDER BY x")).toEqual({ x: 0 });
    expect(steps.rows).toBe(1);
  });
});

describe("reading a sync request", () => {
  const request = (text: string) =>
    new Request("https://sync.test/sync/push", { method: "POST", body: text });

  it("counts bytes, not characters", async () => {
    // Under the limit in characters, over it in UTF-8 bytes.
    const text = JSON.stringify({ note: "é".repeat(600_000) });
    expect(text.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(await readSyncBody(request(text))).toMatchObject({
      refused: { status: 400, body: { error: { message: "request body too large" } } },
    });
    expect(await readSyncBody(request(JSON.stringify({ note: "é" })))).toEqual({
      body: { note: "é" },
    });
    expect(await readSyncBody(request("{"))).toMatchObject({ refused: { status: 400 } });
  });
});

describe("an account database written by v1.0.0", () => {
  // The managed server opens the same account databases as the self-hosted one. A server storage
  // version after v1.0.0 needs an upgrade path here before it ships, or this fails.
  it("opens with its history, deletion markers and receipts, and keeps syncing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "leve-v1-account-"));
    const object = fakeObjectStorage(join(dir, "account.sqlite"));
    try {
      copyFileSync(
        new URL("../../../packages/storage/test/fixtures/v1.0.0/server.sqlite", import.meta.url),
        join(dir, "account.sqlite"),
      );
      const store = openAccountDatabase(durableObjectConnection(object.storage, meter()), false);
      if (!store) throw new Error("the v1.0.0 account was not found");
      expect(store.lineage()).toBe("v1-account-history");
      expect(store.transaction((tx) => tx.receipt("first-bench-set"))).toMatchObject({
        id: "bench-set",
        revision: 3,
        wroteRevision: true,
      });
      const service = new SyncService({ storage: { account: async () => store } });
      const pull = await service.pull("a", {
        release: "1.0",
        lineage: "v1-account-history",
        cursor: 0,
      });
      expect(pull.body).toMatchObject({
        cursor: 4,
        changes: [
          { kind: "workout", id: "strength", revision: 1, state: "live" },
          { kind: "workout_exercise", id: "bench-entry", revision: 2, state: "live" },
          { kind: "workout_set", id: "bench-set", revision: 3, content: { reps: 5 } },
          { kind: "body_measurement", id: "removed-measurement", revision: 4, state: "deleted" },
        ],
      });
      const push = await service.push("a", {
        release: "1.0",
        lineage: "v1-account-history",
        submissions: [
          {
            submissionId: "after-upgrade",
            op: "put",
            kind: "workout",
            id: "w-next",
            baseRevision: null,
            content: workout,
          },
        ],
      });
      expect(push.body).toMatchObject({ results: [{ status: "accepted", revision: 5 }] });
    } finally {
      object.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
