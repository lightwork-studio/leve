import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SqlConnection } from "../src/driver.ts";
import { transaction } from "../src/sql.ts";
import { engine, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";

// Some engines (Cloudflare Durable Objects) refuse BEGIN and COMMIT and run transactions through
// their own call instead. Storage code must then never send those statements itself.

afterAll(removeTempDirs);

function withHook(db: SqlConnection) {
  const sent: string[] = [];
  let hooked = 0;
  const wrapped: SqlConnection = {
    path: db.path,
    exec: (sql) => {
      sent.push(sql);
      db.exec(sql);
    },
    run: (sql, params) => db.run(sql, params),
    all: (sql, params) => db.all(sql, params),
    get: (sql, params) => db.get(sql, params),
    close: () => db.close(),
    transaction: (fn) => {
      hooked += 1;
      // Stands in for the engine's own transaction: a savepoint rolled back on error.
      db.exec("SAVEPOINT hook");
      try {
        const result = fn();
        db.exec("RELEASE hook");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO hook");
        db.exec("RELEASE hook");
        throw error;
      }
    },
  };
  return { wrapped, sent, hooked: () => hooked };
}

describe("a connection with its own transactions", () => {
  it("runs transactions through it, commits and rolls back", () => {
    const db = engine.open(join(tempDir(), "hook.db"));
    db.exec("CREATE TABLE t (n INTEGER)");
    const { wrapped, sent, hooked } = withHook(db);

    expect(transaction(wrapped, () => wrapped.run("INSERT INTO t VALUES (1)").changes)).toBe(1);
    expect(() =>
      transaction(wrapped, () => {
        wrapped.run("INSERT INTO t VALUES (2)");
        throw new Error("stop");
      }),
    ).toThrow("stop");

    expect(hooked()).toBe(2);
    expect(sent.filter((sql) => /BEGIN|COMMIT|ROLLBACK/i.test(sql))).toEqual([]);
    expect(db.all("SELECT n FROM t")).toEqual([{ n: 1 }]);
    db.close();
  });
});
