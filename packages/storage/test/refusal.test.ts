import { copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import {
  createLargeDeviceFixture,
  dumpFile,
  durableFiles,
  engine,
  largeEngine,
  markAsNewer,
  NEW_APP,
  needsRollback,
  OLD_APP,
  openWith,
  removeTempDirs,
  runCrashChild,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { deviceV1, deviceV2, fixtureContract } from "../src/test-support/versions.ts";
import { StorageTooNewError } from "../src/upgrade.ts";
import { deviceFixture, failure } from "./helpers.ts";

afterAll(removeTempDirs);

function storedMeta(path: string, onEngine = engine) {
  const db = onEngine.open(path, { readOnly: true });
  try {
    return readStorageMeta(db);
  } finally {
    db.close();
  }
}

describe("refusing storage written by a newer build", () => {
  it("refuses a clean file using only the fixed metadata and leaves it byte-identical", async () => {
    const path = await deviceFixture();
    markAsNewer(path, 7, "9.0.0");
    const dir = dirname(path);
    const before = durableFiles(dir);

    for (const [definition, supported] of [
      [deviceV1, 1],
      [deviceV2, 2],
    ] as const) {
      const error = await failure(openWith(path, definition, NEW_APP));
      expect(error).toBeInstanceOf(StorageTooNewError);
      expect((error as StorageTooNewError).found).toEqual({
        storageVersion: 7,
        appVersion: "9.0.0",
        unsyncedWork: true,
      });
      expect((error as StorageTooNewError).supported).toBe(supported);
      // No migration, snapshot, metadata update or reset happened.
      expect(durableFiles(dir)).toEqual(before);
    }

    // The device store's own entry point refuses in the same way.
    const viaStore = await failure(
      openDeviceStore({ engine, path, appVersion: OLD_APP, contract: fixtureContract }),
    );
    expect(viaStore).toBeInstanceOf(StorageTooNewError);
    expect(durableFiles(dir)).toEqual(before);
  });

  it("refuses a readable committed WAL without checkpointing it", async () => {
    const path = await deviceFixture();
    const dir = dirname(path);
    const outcome = await runCrashChild({ path, mode: "committed-wal" });
    expect(outcome.signal, outcome.output).toBe("SIGKILL");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

    // The newer metadata lives only in the WAL: the database file alone still says version 1.
    const alone = join(tempDir(), "alone.db");
    copyFileSync(path, alone);
    const copy = engine.open(alone);
    expect(readStorageMeta(copy)?.storageVersion).toBe(1);
    copy.close();
    // With its WAL the file is readable without any recovery and says version 7.
    expect(needsRollback(path)).toBe(false);
    expect(storedMeta(path)?.storageVersion).toBe(7);

    const before = durableFiles(dir);
    const error = await failure(openWith(path, deviceV1, OLD_APP));
    expect(error).toBeInstanceOf(StorageTooNewError);
    expect((error as StorageTooNewError).found).toEqual({
      storageVersion: 7,
      appVersion: "7.0.0",
      unsyncedWork: true,
    });
    // The database file and the WAL are byte-identical; only `-shm` bookkeeping may differ.
    expect(durableFiles(dir)).toEqual(before);
  });

  it("finishes SQLite's rollback of a hot journal, keeps every committed value, then refuses", async () => {
    const path = join(tempDir(), "device.db");
    await createLargeDeviceFixture(path);
    markAsNewer(path, 7, "9.0.0");
    const committed = dumpFile(path, largeEngine);

    // A newer build was killed in the middle of a large write transaction.
    const outcome = await runCrashChild({ path, mode: "interrupted-write", count: 400 }, "large");
    expect(outcome.signal, outcome.output).toBe("SIGKILL");
    expect(engine.exists(`${path}-journal`)).toBe(true);
    expect(needsRollback(path, largeEngine)).toBe(true);

    const error = await failure(openWith(path, deviceV1, OLD_APP, largeEngine));
    expect(error).toBeInstanceOf(StorageTooNewError);
    expect((error as StorageTooNewError).found).toEqual({
      storageVersion: 7,
      appVersion: "9.0.0",
      unsyncedWork: true,
    });

    // The rollback restored the last committed state: all application data, pending work and the
    // metadata are as committed, and nothing else was written (no snapshot, no marker).
    expect(needsRollback(path, largeEngine)).toBe(false);
    expect(engine.exists(`${path}-journal`)).toBe(false);
    expect(dumpFile(path, largeEngine)).toEqual(committed);
    expect(storedMeta(path, largeEngine)).toEqual({
      storageVersion: 7,
      appVersion: "9.0.0",
      unsyncedWork: true,
    });
    expect(readdirSync(dirname(path))).toEqual(["device.db"]);

    // Opening again is now a plain refusal of a clean file.
    const before = durableFiles(dirname(path));
    expect(await failure(openWith(path, deviceV1, OLD_APP, largeEngine))).toBeInstanceOf(
      StorageTooNewError,
    );
    expect(durableFiles(dirname(path))).toEqual(before);
  }, 60_000); // Builds a multi-megabyte fixture and runs a child process; slow under load.
});
