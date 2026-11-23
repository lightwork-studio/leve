import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import {
  createExpoSqliteEngine,
  type ExpoSqliteApi,
  type ExpoSqliteDatabase,
  expoFileName,
  expoPath,
} from "../src/expo-sqlite.ts";
import {
  createLargeDeviceFixture,
  dumpFile,
  largeEngine,
  markAsNewer,
  needsRollback,
  openWith,
  removeTempDirs,
  runCrashChild,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { describeSqlEngine } from "../src/test-support/sql-engine-suite.ts";
import { deviceV1 } from "../src/test-support/versions.ts";
import { StorageTooNewError } from "../src/upgrade.ts";

// A stand-in with expo-sqlite's synchronous API on Node's SQLite, so the engine's mapping runs the
// shared conformance suite here. It checks this engine's code, not expo-sqlite itself.

afterAll(removeTempDirs);

type Handle = { db: DatabaseSync; file: string };
const handles = new WeakMap<ExpoSqliteDatabase, Handle>();

function standIn(directory: string): ExpoSqliteApi {
  const file = (name: string) => join(directory, name);
  return {
    openDatabase(name) {
      const handle: Handle = { db: new DatabaseSync(file(name)), file: file(name) };
      const native: ExpoSqliteDatabase = {
        execSync: (source) => handle.db.exec(source),
        runSync: (source, params) => {
          const result = handle.db.prepare(source).run(...params);
          return { changes: Number(result.changes) };
        },
        getAllSync: (source, params) =>
          handle.db.prepare(source).all(...params) as Record<string, unknown>[],
        getFirstSync: (source, params) =>
          (handle.db.prepare(source).get(...params) as Record<string, unknown> | undefined) ?? null,
        closeSync: () => handle.db.close(),
      };
      handles.set(native, handle);
      return native;
    },
    createInspectionDirectory() {
      const scratch = mkdtempSync(join(directory, "inspection-"));
      return {
        copyFromDatabaseDirectory: (name) => copyFileSync(file(name), join(scratch, name)),
        openDatabase: (name) => standIn(scratch).openDatabase(name),
        remove: () => rmSync(scratch, { recursive: true }),
      };
    },
    async backupDatabaseAsync({ sourceDatabase, destDatabase }) {
      const source = handles.get(sourceDatabase) as Handle;
      const target = handles.get(destDatabase) as Handle;
      await backup(source.db, target.file);
    },
    // Node's SQLite has no synchronous backup: copy the whole database into the target's file.
    backupDatabaseSync({ sourceDatabase, destDatabase }) {
      const source = handles.get(sourceDatabase) as Handle;
      const target = handles.get(destDatabase) as Handle;
      target.db.close();
      rmSync(target.file, { force: true });
      source.db.exec(`VACUUM INTO '${target.file.replaceAll("'", "''")}'`);
      target.db = new DatabaseSync(target.file);
    },
    exists: (name) => existsSync(file(name)),
    remove: (name) => rmSync(file(name), { force: true }),
  };
}

let names = 0;
describeSqlEngine("expo-sqlite (Node stand-in)", {
  createEngine: () => createExpoSqliteEngine(standIn(tempDir())),
  newPath: (name) => `/leve/${++names}/${name}`,
});

it("reads committed WAL rows from an interrupted phone without modifying its recovery files", () => {
  const directory = tempDir();
  const name = expoFileName("/leve/device.db");
  const writer = spawnSync(process.execPath, [
    "-e",
    `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE kept(x); INSERT INTO kept VALUES(19)");
    process.kill(process.pid, "SIGKILL");
  `,
    join(directory, name),
  ]);
  expect(writer.signal).toBe("SIGKILL");
  const files = () =>
    readdirSync(directory)
      .sort()
      .map((file) => [file, readFileSync(join(directory, file))]);
  expect(existsSync(join(directory, name + "-wal"))).toBe(true);
  const before = files();
  const engine = createExpoSqliteEngine(standIn(directory));
  const inspection = engine.open("/leve/device.db", { readOnly: true, exclusiveInspection: true });
  try {
    expect(inspection.get("SELECT x FROM kept")).toEqual({ x: 19 });
    expect(() => inspection.run("DELETE FROM kept")).toThrow();
  } finally {
    inspection.close();
  }
  expect(files()).toEqual(before);
  const recovered = engine.open("/leve/device.db");
  expect(recovered.get("SELECT x FROM kept")).toEqual({ x: 19 });
  recovered.close();
});

it("keeps ordinary readers current while another connection commits into a live WAL", () => {
  const engine = createExpoSqliteEngine(standIn(tempDir()));
  const writer = engine.open("/leve/device.db");
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE counts(x); INSERT INTO counts VALUES(1)");
    const reader = engine.open("/leve/device.db", { readOnly: true });
    try {
      expect(reader.get("SELECT count(*) AS n FROM counts")).toEqual({ n: 1 });
      writer.exec("INSERT INTO counts VALUES(2)");
      expect(reader.get("SELECT count(*) AS n FROM counts")).toEqual({ n: 2 });
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
  }
});

it("refuses newer phone storage with a hot rollback journal and keeps its pending work recoverable", async () => {
  const directory = tempDir();
  const path = "/leve/device.db";
  const name = expoFileName(path);
  const file = join(directory, name);
  await createLargeDeviceFixture(file);
  markAsNewer(file, 7, "newer");
  const committed = dumpFile(file, largeEngine);
  const outcome = await runCrashChild(
    { path: file, mode: "interrupted-write", count: 400 },
    "large",
  );
  expect(outcome.signal, outcome.output).toBe("SIGKILL");
  expect(needsRollback(file, largeEngine)).toBe(true);
  const files = () =>
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name))]);
  const before = files();
  const engine = createExpoSqliteEngine(standIn(directory));
  await expect(openWith(path, deviceV1, "older", engine)).rejects.toBeInstanceOf(
    StorageTooNewError,
  );
  expect(files()).toEqual(before);
  const writer = engine.open(path);
  expect(writer.get("SELECT storage_version FROM storage_meta WHERE id=1")).toEqual({
    storage_version: 7,
  });
  writer.close();
  expect(dumpFile(file, largeEngine)).toEqual(committed);
  const supported = engine.open(path);
  supported.exec("CREATE TABLE recovered(x); INSERT INTO recovered VALUES(5)");
  supported.close();
  const reopened = engine.open(path);
  try {
    expect(reopened.get("SELECT x FROM recovered")).toEqual({ x: 5 });
  } finally {
    reopened.close();
  }
}, 60_000);

it("refuses to rename a missing file, leaving the target as it was", () => {
  const engine = createExpoSqliteEngine(standIn(tempDir()));
  const target = engine.open("/leve/target.db");
  target.exec("CREATE TABLE kept (x); INSERT INTO kept VALUES (1);");
  target.close();
  expect(() => engine.rename("/leve/missing.db", "/leve/target.db")).toThrow(/no such file/);
  expect(engine.exists("/leve/missing.db")).toBe(false);
  const reader = engine.open("/leve/target.db", { readOnly: true });
  expect(reader.get("SELECT x FROM kept")).toEqual({ x: 1 });
  reader.close();
});

it("names files so SQLite's journal and the storage code's sidecars stay beside them", () => {
  expect(() => expoFileName("/leve/a__b.db")).toThrow(/__/);
  expect(expoFileName("/leve/device.db")).toBe("leve__device.db");
  expect(expoFileName("/leve/device.db-journal")).toBe("leve__device.db-journal");
  expect(expoFileName("/leve/device.db.snapshot-v2")).toBe("leve__device.db.snapshot-v2");
  expect(expoPath("leve__device.db")).toBe("/leve/device.db");
});

it("opens a device store with the platform's id source only", { timeout: 30_000 }, async () => {
  const engine = createExpoSqliteEngine(standIn(tempDir()));
  let ids = 0;
  const original = globalThis.crypto.randomUUID;
  // Hermes has no crypto.randomUUID: opening must use the id source it is given.
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const store = await openDeviceStore({
      engine,
      path: "/leve/device.db",
      appVersion: "phone-test",
      randomId: () => `id-${++ids}`,
    });
    store.put("body_measurement", "m-1", {
      takenAt: "2026-11-12T08:00:00.000Z",
      bodyweightKg: 80,
      fatPercent: null,
    });
    expect(store.get("body_measurement", "m-1")?.status).toBe("pending");
    // Preparing an upload creates a submission id from the same source.
    expect(store.prepareSubmissions("1.0")).toHaveLength(1);
    store.close();
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
  }
  expect(ids).toBeGreaterThan(0);
});
