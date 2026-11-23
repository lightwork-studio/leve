import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { createSqlJsEngine, memoryFiles } from "../src/sqljs.ts";
import { describeSqlEngine } from "../src/test-support/sql-engine-suite.ts";

const SQL = await initSqlJs();
let paths = 0;
const newPath = (name: string) => `/leve/${++paths}/${name}`;

describeSqlEngine("sql.js", { createEngine: () => createSqlJsEngine(SQL), newPath });
describeSqlEngine("sql.js with 1 KB backup steps", {
  createEngine: () => createSqlJsEngine(SQL, { stepBytes: 1024 }),
  newPath,
});

it("keeps a device store's data in its files, ready to be saved and opened again", async () => {
  const files = memoryFiles();
  const changed = new Set<string>();
  const engine = createSqlJsEngine(SQL, { files, onChange: (path) => changed.add(path) });
  const store = await openDeviceStore({ engine, path: "/leve/device.db", appVersion: "web-test" });
  store.put("body_measurement", "m-1", {
    takenAt: "2026-11-12T08:00:00.000Z",
    bodyweightKg: 80.5,
    fatPercent: null,
  });
  store.close();
  expect(changed.has("/leve/device.db")).toBe(true);

  // Another session starts from the saved bytes only.
  const saved = memoryFiles([...files.entries()].map(([path, bytes]) => [path, bytes.slice()]));
  const again = await openDeviceStore({
    engine: createSqlJsEngine(SQL, { files: saved }),
    path: "/leve/device.db",
    appVersion: "web-test",
  });
  expect(again.get("body_measurement", "m-1")).toMatchObject({
    status: "pending",
    content: { bodyweightKg: 80.5 },
  });
  again.close();
});

it("lets only one connection write a file at a time", () => {
  const engine = createSqlJsEngine(SQL);
  const path = newPath("locked.db");
  const first = engine.open(path);
  const second = engine.open(path);
  try {
    first.exec("CREATE TABLE t (x)");
    first.exec("BEGIN IMMEDIATE");
    expect(() => second.run("INSERT INTO t VALUES (1)")).toThrow(/locked/);
    expect(() => second.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
    first.exec("COMMIT");
    expect(second.run("INSERT INTO t VALUES (2)")).toEqual({ changes: 1 });
  } finally {
    first.close();
    second.close();
  }
});

describe("transaction edge cases", () => {
  const setup = () => {
    const engine = createSqlJsEngine(SQL);
    const path = newPath("edge.db");
    const first = engine.open(path);
    first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT UNIQUE)");
    const second = engine.open(path);
    const labels = () => {
      const reader = engine.open(path, { readOnly: true });
      try {
        return reader.all("SELECT label FROM t ORDER BY id").map((r) => r.label);
      } finally {
        reader.close();
      }
    };
    return { engine, path, first, second, labels };
  };

  it("refuses transaction control mixed with other statements, and savepoints", () => {
    const { first, second, labels } = setup();
    expect(() => first.exec("BEGIN IMMEDIATE; INSERT INTO t (label) VALUES ('a'); COMMIT")).toThrow(
      /statements of their own/,
    );
    expect(() => first.exec("SAVEPOINT s")).toThrow(/savepoints/);
    // Nothing was left half-open: the other connection can still write.
    expect(second.run("INSERT INTO t (label) VALUES ('b')")).toEqual({ changes: 1 });
    expect(labels()).toEqual(["b"]);
    first.close();
    second.close();
  });

  it("only reads through all() and get()", () => {
    const { first, second } = setup();
    expect(() => first.all("INSERT INTO t (label) VALUES ('a') RETURNING id")).toThrow(/run\(\)/);
    expect(() => first.get("DELETE FROM t")).toThrow(/run\(\)/);
    expect(first.all("WITH x AS (SELECT 1 AS n) SELECT n FROM x")).toEqual([{ n: 1 }]);
    first.close();
    second.close();
  });

  it("keeps the lock when a nested BEGIN fails", () => {
    const { first, second, labels } = setup();
    first.exec("BEGIN IMMEDIATE");
    first.run("INSERT INTO t (label) VALUES ('a')");
    expect(() => first.exec("BEGIN IMMEDIATE")).toThrow();
    expect(() => second.run("INSERT INTO t (label) VALUES ('b')")).toThrow(/locked/);
    first.exec("COMMIT");
    expect(labels()).toEqual(["a"]);
    first.close();
    second.close();
  });

  it("recovers when SQLite rolls back on its own", () => {
    const { first, second, labels } = setup();
    first.run("INSERT INTO t (label) VALUES ('a')");
    first.exec("BEGIN IMMEDIATE");
    first.run("INSERT INTO t (label) VALUES ('b')");
    expect(() => first.run("INSERT OR ROLLBACK INTO t (label) VALUES ('a')")).toThrow();
    first.exec("ROLLBACK");
    // The lock is free and later writes are saved.
    expect(second.run("INSERT INTO t (label) VALUES ('c')")).toEqual({ changes: 1 });
    expect(first.run("INSERT INTO t (label) VALUES ('d')")).toEqual({ changes: 1 });
    expect(labels()).toEqual(["a", "c", "d"]);
    first.exec("BEGIN IMMEDIATE");
    expect(() => first.run("INSERT OR ROLLBACK INTO t (label) VALUES ('a')")).toThrow();
    expect(() => first.close()).not.toThrow();
    second.close();
  });

  it("gives a read-only transaction a stable snapshot", () => {
    const { engine, path, first, second } = setup();
    const reader = engine.open(path, { readOnly: true });
    reader.exec("BEGIN");
    first.run("INSERT INTO t (label) VALUES ('a')");
    expect(reader.get("SELECT count(*) AS n FROM t")).toEqual({ n: 0 });
    reader.exec("COMMIT");
    expect(reader.get("SELECT count(*) AS n FROM t")).toEqual({ n: 1 });
    reader.close();
    first.close();
    second.close();
  });

  it("refuses a backup over a file another connection is writing, and renames onto itself", async () => {
    const { engine, path, first, second, labels } = setup();
    first.run("INSERT INTO t (label) VALUES ('a')");
    const other = newPath("other.db");
    const writer = engine.open(other);
    writer.exec("CREATE TABLE x (n)");
    writer.exec("BEGIN IMMEDIATE");
    await expect(engine.backup(first, other)).rejects.toThrow(/locked/);
    writer.exec("ROLLBACK");
    writer.close();
    engine.rename(path, path);
    expect(engine.exists(path)).toBe(true);
    expect(labels()).toEqual(["a"]);
    first.close();
    second.close();
  });
});

it("reuses prepared reads without ever reading stale data", () => {
  const engine = createSqlJsEngine(SQL);
  const path = newPath("cache.db");
  const a = engine.open(path);
  const b = engine.open(path);
  a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const read = (c: typeof a) => c.all("SELECT v FROM t ORDER BY id").map((r) => r.v);
  expect(read(a)).toEqual([]);
  // The same read after this connection's own write, and after another connection's.
  a.run("INSERT INTO t (v) VALUES (?)", ["one"]);
  expect(read(a)).toEqual(["one"]);
  expect(read(b)).toEqual(["one"]);
  b.run("INSERT INTO t (v) VALUES (?)", ["two"]);
  expect(read(a)).toEqual(["one", "two"]);
  // Inside a transaction, a cached read sees the transaction's own writes.
  a.exec("BEGIN");
  a.run("INSERT INTO t (v) VALUES (?)", ["three"]);
  expect(read(a)).toEqual(["one", "two", "three"]);
  a.exec("ROLLBACK");
  expect(read(a)).toEqual(["one", "two"]);
  // More distinct reads than the cache holds, then the first again; a failed read leaves it usable.
  for (let i = 0; i < 100; i++) expect(a.get(`SELECT ${i} AS n`)?.n).toBe(i);
  expect(() => a.all("SELECT * FROM missing_table")).toThrow();
  expect(read(a)).toEqual(["one", "two"]);
  a.close();
  b.close();
});

it("names a cached read's columns as they are after a table is rebuilt", () => {
  const engine = createSqlJsEngine(SQL);
  const db = engine.open(newPath("rebuild.db"));
  db.exec("CREATE TABLE t (a TEXT, b TEXT)");
  db.run("INSERT INTO t VALUES ('A', 'B')");
  expect(db.all("SELECT * FROM t")).toEqual([{ a: "A", b: "B" }]);
  // As a migration would: rebuild the table with other columns, inside one transaction.
  db.exec("BEGIN");
  db.exec("CREATE TABLE t2 (b TEXT, c TEXT, a TEXT)");
  db.exec("INSERT INTO t2 SELECT b, 'C', a FROM t");
  db.exec("DROP TABLE t");
  db.exec("ALTER TABLE t2 RENAME TO t");
  expect(db.all("SELECT * FROM t")).toEqual([{ b: "B", c: "C", a: "A" }]);
  db.exec("ALTER TABLE t ADD COLUMN d TEXT");
  expect(db.all("SELECT * FROM t")).toEqual([{ b: "B", c: "C", a: "A", d: null }]);
  db.exec("COMMIT");
  db.close();
});
