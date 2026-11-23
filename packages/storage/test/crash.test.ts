import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEVICE_STORAGE_VERSION } from "../src/device-schema.ts";
import {
  createDeviceFixture,
  createLargeDeviceFixture,
  definitions,
  dumpFile,
  engine,
  largeEngine,
  NEW_APP,
  needsRollback,
  OLD_APP,
  openWith,
  removeTempDirs,
  runCrashChild,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { readDeviceFile } from "../src/test-support/logical.ts";
import { deviceV1, deviceV2, deviceV2Corrupting } from "../src/test-support/versions.ts";
import {
  type Checkpoint,
  openStorage,
  type StorageDefinition,
  StorageTooNewError,
  snapshotPath,
  UpgradeFailedError,
} from "../src/upgrade.ts";
import { EXPECTED_FIXTURE } from "./expected-fixture.ts";
import { deviceFixture, failure, meaning } from "./helpers.ts";

// Each case runs an upgrade in a child process that kills itself with SIGKILL at one checkpoint,
// then reopens the file with the old build and with the new build and checks that nothing was lost.

afterAll(removeTempDirs);

const CRASH_TIMEOUT = 60_000;

/** Every checkpoint an uninterrupted open reaches, once per count. */
async function reachedCheckpoints(
  definition: StorageDefinition,
  seed: (path: string) => Promise<void>,
  onEngine = engine,
): Promise<[Checkpoint, number][]> {
  const path = join(tempDir(), "device.db");
  await seed(path);
  const reached = new Map<Checkpoint, number>();
  await openStorage({
    engine: onEngine,
    path,
    definition,
    appVersion: NEW_APP,
    onCheckpoint: (point, n) => reached.set(point, Math.max(reached.get(point) ?? 0, n)),
  }).then(
    (opened) => opened.db.close(),
    () => {},
  );
  return [...reached].flatMap(([point, max]) =>
    Array.from({ length: max }, (_, i): [Checkpoint, number] => [point, i + 1]),
  );
}

async function crashAt(path: string, mode: string, point: string, count: number, kind?: "large") {
  const outcome = await runCrashChild({ path, mode, point, count }, kind);
  expect(outcome.signal, `child did not crash: ${outcome.output}`).toBe("SIGKILL");
}

/** Nothing of the upgrade is committed before these checkpoints. */
const BEFORE_COMMIT = /^(snapshot:|upgrade:write)/;

const originalPath = await deviceFixture();
const original = dumpFile(originalPath);
const originalRaw = readDeviceFile(originalPath).rawContent;

const upgradedPath = await deviceFixture();
await openWith(upgradedPath, deviceV2, NEW_APP);
const upgraded = dumpFile(upgradedPath);

const upgradeCases = await reachedCheckpoints(deviceV2, createDeviceFixture);
const failingCases = await reachedCheckpoints(deviceV2Corrupting, createDeviceFixture);
const lastRestoreStep = failingCases.filter(([point]) => point === "restore:step").length;

function expectUpgradedFixture(path: string): void {
  const logical = readDeviceFile(path);
  expect(logical.storageVersion).toBe(2);
  expect(meaning(logical)).toEqual(EXPECTED_FIXTURE);
  expect(logical.rawContent).toEqual(originalRaw);
  expect(dumpFile(path)).toEqual(upgraded);
}

it.each(["snapshot:ready", "upgrade:write", "upgrade:committed", "verify:passed"])(
  "retains every record and in-flight payload across interruption of the production device upgrade at %s",
  async (point) => {
    const path = await deviceFixture();
    await crashAt(path, "device-current", point, 1);
    await openWith(path, definitions["device-current"] as StorageDefinition, NEW_APP);
    const logical = readDeviceFile(path);
    expect(logical.storageVersion).toBe(DEVICE_STORAGE_VERSION);
    expect(meaning(logical)).toEqual(EXPECTED_FIXTURE);
    expect(logical.rawContent).toEqual(originalRaw);
    expect(dumpFile(snapshotPath(path, 1))).toEqual(original);
  },
  CRASH_TIMEOUT,
);

describe("crash during a successful upgrade", () => {
  it("covers every checkpoint of the upgrade", () => {
    const points = new Set(upgradeCases.map(([point]) => point));
    expect([...points].sort()).toEqual(
      [
        "snapshot:step",
        "snapshot:written",
        "snapshot:ready",
        "upgrade:write",
        "upgrade:committed",
        "verify:passed",
      ].sort(),
    );
    expect(upgradeCases.filter(([point]) => point === "snapshot:step").length).toBeGreaterThan(3);
    expect(upgradeCases.filter(([point]) => point === "upgrade:write").length).toBeGreaterThan(10);
  });

  it.concurrent.each(upgradeCases)(
    "%s #%i",
    async (point, count) => {
      const path = await deviceFixture();
      await crashAt(path, "device-v2", point, count);

      if (BEFORE_COMMIT.test(point)) {
        // Nothing was committed: the old build opens its data unchanged.
        await openWith(path, deviceV1, OLD_APP);
        expect(dumpFile(path)).toEqual(original);
        expect(meaning(readDeviceFile(path))).toEqual(EXPECTED_FIXTURE);
      } else {
        // The upgrade was committed: the old build refuses the newer storage.
        expect(await failure(openWith(path, deviceV1, OLD_APP))).toBeInstanceOf(StorageTooNewError);
      }

      // The new build finishes the upgrade with everything preserved.
      await openWith(path, deviceV2, NEW_APP);
      expectUpgradedFixture(path);
      expect(dumpFile(snapshotPath(path, 1))).toEqual(original);
      expect(engine.exists(`${snapshotPath(path, 1)}.tmp`)).toBe(false);
    },
    CRASH_TIMEOUT,
  );
});

describe("crash during an upgrade that fails verification", () => {
  it("covers the restore after the failed verification", () => {
    const points = new Set(failingCases.map(([point]) => point));
    expect(points).toContain("upgrade:committed");
    expect(points).toContain("restore:done");
    expect(points).not.toContain("verify:passed");
    expect(failingCases.filter(([point]) => point === "restore:step").length).toBeGreaterThan(3);
  });

  it.concurrent.each(failingCases)(
    "%s #%i",
    async (point, count) => {
      const path = await deviceFixture();
      await crashAt(path, "device-v2-corrupting", point, count);

      // The restore's last step finishes the copy, so from then on the file is version 1 again.
      const restored =
        point === "restore:done" || (point === "restore:step" && count === lastRestoreStep);
      if (!BEFORE_COMMIT.test(point) && !restored) {
        expect(await failure(openWith(path, deviceV1, OLD_APP))).toBeInstanceOf(StorageTooNewError);
      } else {
        await openWith(path, deviceV1, OLD_APP);
        expect(dumpFile(path)).toEqual(original);
      }

      // The broken build fails again, restores the snapshot and loses nothing.
      const error = await failure(openWith(path, deviceV2Corrupting, NEW_APP));
      expect(error).toBeInstanceOf(UpgradeFailedError);
      expect((error as UpgradeFailedError).restoredSnapshot).toBe(true);
      expect(dumpFile(path)).toEqual(original);

      // A fixed build then upgrades with everything preserved.
      await openWith(path, deviceV2, NEW_APP);
      expectUpgradedFixture(path);
    },
    CRASH_TIMEOUT,
  );
});

describe("crash in the middle of large writes", () => {
  // Bigger than the page cache, so SQLite writes to the database file before committing and the
  // crash leaves a hot rollback journal that a read-only connection cannot get past.
  let largeOriginal: Record<string, unknown[]>;
  let largeUpgraded: Record<string, unknown[]>;
  let cases: [mode: string, point: Checkpoint, count: number][];

  const at = (all: [Checkpoint, number][], point: Checkpoint, fraction: number): number => {
    const max = all.filter(([p]) => p === point).length;
    return Math.max(1, Math.floor(max * fraction));
  };

  it(
    "prepares the large fixtures",
    async () => {
      const before = join(tempDir(), "device.db");
      await createLargeDeviceFixture(before);
      largeOriginal = dumpFile(before, largeEngine);
      const after = join(tempDir(), "device.db");
      await createLargeDeviceFixture(after);
      await openWith(after, deviceV2, NEW_APP, largeEngine);
      largeUpgraded = dumpFile(after, largeEngine);

      const upgrading = await reachedCheckpoints(deviceV2, createLargeDeviceFixture, largeEngine);
      const failing = await reachedCheckpoints(
        deviceV2Corrupting,
        createLargeDeviceFixture,
        largeEngine,
      );
      cases = [
        ["device-v2", "upgrade:write", at(upgrading, "upgrade:write", 0.5)],
        ["device-v2", "upgrade:write", at(upgrading, "upgrade:write", 0.95)],
        ["device-v2-corrupting", "restore:step", at(failing, "restore:step", 0.5)],
        ["device-v2-corrupting", "restore:step", at(failing, "restore:step", 0.9)],
      ];
    },
    CRASH_TIMEOUT,
  );

  it(
    "rolls back the interrupted write on the next open and loses nothing",
    async () => {
      await Promise.all(
        cases.map(async ([mode, point, count]) => {
          const path = join(tempDir(), "device.db");
          await createLargeDeviceFixture(path);
          await crashAt(path, mode, point, count, "large");
          expect(needsRollback(path, largeEngine), `${mode} ${point} #${count}`).toBe(true);

          if (mode === "device-v2") {
            // Interrupted before the commit: the old build gets its data back.
            await openWith(path, deviceV1, OLD_APP, largeEngine);
            expect(dumpFile(path, largeEngine)).toEqual(largeOriginal);
            await openWith(path, deviceV2, NEW_APP, largeEngine);
            expect(dumpFile(path, largeEngine)).toEqual(largeUpgraded);
          } else {
            // Interrupted while restoring: the committed (broken) upgrade is still there.
            expect(await failure(openWith(path, deviceV1, OLD_APP, largeEngine))).toBeInstanceOf(
              StorageTooNewError,
            );
            const error = await failure(openWith(path, deviceV2Corrupting, NEW_APP, largeEngine));
            expect(error).toBeInstanceOf(UpgradeFailedError);
            expect(dumpFile(path, largeEngine)).toEqual(largeOriginal);
          }
        }),
      );
    },
    CRASH_TIMEOUT,
  );
});
