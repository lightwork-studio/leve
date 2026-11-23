// Shared conformance tests for any `SqlEngine`. They use only the engine interface, so the phone's
// engine can run the same suite (with its own way of making paths) before its durability is claimed.
import { describe, expect, it } from "vitest";
import type { SqlConnection, SqlEngine } from "../driver.ts";

export interface SqlEngineSuiteOptions {
  createEngine(): SqlEngine;
  /** A path in an empty, writable directory where no file exists yet. */
  newPath(name: string): string;
}

export function describeSqlEngine(name: string, options: SqlEngineSuiteOptions): void {
  describe(`SqlEngine conformance: ${name}`, () => {
    const engine = options.createEngine();

    const withDb = <T>(path: string, fn: (db: SqlConnection) => T, readOnly = false): T => {
      const db = engine.open(path, { readOnly });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };

    const seeded = (rows: number): string => {
      const path = options.newPath("seeded.db");
      withDb(path, (db) => {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)");
        for (let i = 1; i <= rows; i++)
          db.run("INSERT INTO t (id, label) VALUES (?, ?)", [i, `r${i}`]);
      });
      return path;
    };

    const labels = (path: string): string[] =>
      withDb(
        path,
        (db) => db.all("SELECT label FROM t ORDER BY id").map((r) => String(r.label)),
        true,
      );

    it("creates a file on open and keeps committed data after closing", () => {
      const path = options.newPath("new.db");
      expect(engine.exists(path)).toBe(false);
      withDb(path, (db) => {
        expect(db.path).toBe(path);
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
        db.run("INSERT INTO t (id, label) VALUES (?, ?)", [1, "kept"]);
      });
      expect(engine.exists(path)).toBe(true);
      expect(withDb(path, (db) => db.get("SELECT label FROM t WHERE id = 1"))).toEqual({
        label: "kept",
      });
    });

    it("runs several statements in one exec", () => {
      const path = options.newPath("exec.db");
      withDb(path, (db) => {
        db.exec(`
          CREATE TABLE a (x INTEGER);
          CREATE TABLE b (y INTEGER);
          INSERT INTO a VALUES (1);
          INSERT INTO b VALUES (2);
        `);
        expect(db.get("SELECT (SELECT x FROM a) AS x, (SELECT y FROM b) AS y")).toEqual({
          x: 1,
          y: 2,
        });
      });
    });

    it("binds and returns every value type without loss", () => {
      const path = options.newPath("values.db");
      withDb(path, (db) => {
        db.exec("CREATE TABLE v (id INTEGER PRIMARY KEY, n, r, s, b, z)");
        const bytes = new Uint8Array([0, 1, 254, 255]);
        db.run("INSERT INTO v (id, n, r, s, b, z) VALUES (?, ?, ?, ?, ?, ?)", [
          1,
          Number.MAX_SAFE_INTEGER,
          102.05,
          'text with "quotes", ünïcode and \\u0000 escapes',
          bytes,
          null,
        ]);
        db.run("INSERT INTO v (id, n) VALUES (?, ?)", [2, 42n]);
        const row = db.get("SELECT * FROM v WHERE id = 1");
        if (!row) throw new Error("row is missing");
        expect(Number(row.n)).toBe(Number.MAX_SAFE_INTEGER);
        expect(row.r).toBe(102.05);
        expect(row.s).toBe('text with "quotes", ünïcode and \\u0000 escapes');
        expect(row.b).toBeInstanceOf(Uint8Array);
        expect([...(row.b as Uint8Array)]).toEqual([0, 1, 254, 255]);
        expect(row.z).toBeNull();
        expect(Number(db.get("SELECT n FROM v WHERE id = 2")?.n)).toBe(42);
      });
    });

    it("refuses text with U+0000 instead of storing less of it", () => {
      const path = options.newPath("nul.db");
      withDb(path, (db) => {
        db.exec("CREATE TABLE v (id INTEGER PRIMARY KEY, s)");
        for (const call of [
          () => db.run("INSERT INTO v (id, s) VALUES (1, ?)", ["before\u0000after"]),
          () => db.get("SELECT * FROM v WHERE s = ?", ["a\u0000"]),
          () => db.all("SELECT * FROM v WHERE s = ?", ["\u0000"]),
        ]) {
          expect(call).toThrow(/U\+0000/);
        }
        expect(db.all("SELECT * FROM v")).toEqual([]);
      });
    });

    it("reports changed rows, a missing row and an empty result", () => {
      const path = seeded(3);
      withDb(path, (db) => {
        expect(db.run("UPDATE t SET label = label || '!' WHERE id >= ?", [2])).toEqual({
          changes: 2,
        });
        expect(db.run("DELETE FROM t WHERE id = ?", [99])).toEqual({ changes: 0 });
        expect(db.get("SELECT * FROM t WHERE id = ?", [99])).toBeUndefined();
        expect(db.all("SELECT * FROM t WHERE id > ?", [99])).toEqual([]);
        expect(db.all("SELECT id FROM t ORDER BY id").map((r) => Number(r.id))).toEqual([1, 2, 3]);
      });
    });

    it("rolls back every write of a transaction and keeps committed ones", () => {
      const path = seeded(2);
      withDb(path, (db) => {
        db.exec("BEGIN IMMEDIATE");
        db.run("INSERT INTO t (id, label) VALUES (3, 'r3')");
        db.run("DELETE FROM t WHERE id = 1");
        db.exec("ROLLBACK");

        db.exec("BEGIN IMMEDIATE");
        db.run("INSERT INTO t (id, label) VALUES (4, 'r4')");
        // A failing statement inside the transaction: the caller rolls back everything.
        expect(() => db.run("INSERT INTO t (id, label) VALUES (5, 'r2')")).toThrow();
        db.exec("ROLLBACK");

        db.exec("BEGIN IMMEDIATE");
        db.run("INSERT INTO t (id, label) VALUES (6, 'r6')");
        db.exec("COMMIT");
      });
      expect(labels(path)).toEqual(["r1", "r2", "r6"]);
    });

    it("makes committed writes visible to another connection, and only once committed", () => {
      const path = seeded(1);
      const writer = engine.open(path);
      const reader = engine.open(path, { readOnly: true });
      try {
        writer.exec("BEGIN IMMEDIATE");
        writer.run("INSERT INTO t (id, label) VALUES (2, 'r2')");
        expect(reader.all("SELECT label FROM t ORDER BY id").map((r) => r.label)).toEqual(["r1"]);
        writer.exec("COMMIT");
        expect(reader.all("SELECT label FROM t ORDER BY id").map((r) => r.label)).toEqual([
          "r1",
          "r2",
        ]);
      } finally {
        reader.close();
        writer.close();
      }
    });

    it("refuses writes on a read-only connection and never creates a missing file", () => {
      const path = seeded(1);
      withDb(
        path,
        (db) => {
          expect(db.get("SELECT label FROM t")).toEqual({ label: "r1" });
          expect(() => db.run("INSERT INTO t (id, label) VALUES (2, 'r2')")).toThrow();
          expect(() => db.exec("CREATE TABLE other (x)")).toThrow();
        },
        true,
      );
      expect(labels(path)).toEqual(["r1"]);

      const missing = options.newPath("missing.db");
      expect(() => engine.open(missing, { readOnly: true })).toThrow();
      expect(engine.exists(missing)).toBe(false);
    });

    it("copies a database with backup, replacing the destination, in observable steps", async () => {
      const source = seeded(200);
      const destination = options.newPath("copy.db");
      withDb(destination, (db) => db.exec("CREATE TABLE old (x); INSERT INTO old VALUES (1);"));

      const steps: number[] = [];
      const db = engine.open(source, { readOnly: true });
      try {
        await engine.backup(db, destination, (step) => steps.push(step));
        // The source connection stays usable.
        expect(db.get("SELECT count(*) AS n FROM t")).toEqual({ n: 200 });
      } finally {
        db.close();
      }
      expect(steps.length).toBeGreaterThan(0);
      expect(steps).toEqual(steps.map((_, i) => i + 1));
      expect(labels(destination)).toEqual(labels(source));
      expect(
        withDb(
          destination,
          (copy) => copy.get("SELECT name FROM sqlite_master WHERE name = 'old'"),
          true,
        ),
      ).toBeUndefined();
    });

    it("renames over an existing file and removes files, ignoring missing ones", () => {
      const from = seeded(1);
      const to = options.newPath("target.db");
      withDb(to, (db) => db.exec("CREATE TABLE replaced (x)"));
      engine.rename(from, to);
      expect(engine.exists(from)).toBe(false);
      expect(labels(to)).toEqual(["r1"]);

      engine.remove(to);
      expect(engine.exists(to)).toBe(false);
      expect(() => engine.remove(to)).not.toThrow();
      expect(() => engine.remove(options.newPath("never.db"))).not.toThrow();
    });
  });
}
