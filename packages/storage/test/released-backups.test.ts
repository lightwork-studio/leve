import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import { ServerStorage } from "../src/server-store.ts";
import { engine, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";
import { readDeviceFile } from "../src/test-support/logical.ts";

afterEach(removeTempDirs);

it("opens the v1.0.0 phone backup with the current release and keeps local work and the outbox", async () => {
  const backup = new URL("fixtures/v1.0.0/device.sqlite", import.meta.url);
  const path = join(tempDir(), "phone.db");
  copyFileSync(backup, path);
  const original = readDeviceFile(path);
  expect(original).toMatchObject({
    storageVersion: 5,
    appVersion: "1.0.0",
    unsyncedWork: true,
    sync: { cursor: 4, lineage: "v1-account-history" },
  });
  const phone = await openDeviceStore({ engine, path, appVersion: "compatibility-test" });
  try {
    expect(phone.activeWorkout()?.id).toBe("next-session");
    expect(phone.get("workout_set", "bench-set")).toMatchObject({
      content: { weightKg: 102.05, reps: 7, repsInReserve: 0 },
      server: { revision: 3, content: { reps: 5 } },
    });
  } finally {
    phone.close();
  }
  const reopened = readDeviceFile(path);
  expect(reopened.submissions).toEqual(original.submissions);
  expect(reopened.submissions).toMatchObject([
    {
      submissionId: "pending-bench-edit",
      record: "workout_set/bench-set",
      baseRevision: 3,
      release: "1.0",
    },
  ]);
  const [submission] = reopened.submissions;
  expect(JSON.parse(submission?.wireContent ?? "null")).toMatchObject({
    reps: 6,
    repsInReserve: 0,
  });
});

it("restores a v1.0.0 server backup with its records, deletion markers and receipts", async () => {
  const backup = new URL("fixtures/v1.0.0/server.sqlite", import.meta.url);
  const path = join(tempDir(), "backup.db");
  copyFileSync(backup, path);
  const source = engine.open(path, { readOnly: true });
  try {
    expect(readStorageMeta(source)).toMatchObject({ storageVersion: 4, appVersion: "1.0.0" });
  } finally {
    source.close();
  }
  const storage = new ServerStorage({
    engine,
    directory: tempDir(),
    appVersion: "compatibility-test",
  });
  try {
    const live = await storage.account("account");
    expect(live.lineage()).not.toBe("v1-account-history");
    const result = await storage.restoreAccount("account", path, {
      randomId: () => "restored-history",
    });
    expect(result.replaced).not.toBeNull();
    const restored = await storage.account("account");
    expect(restored.lineage()).toBe("restored-history");
    expect(restored.restoredFrom()).toEqual({ lineage: "v1-account-history", restorePoint: 4 });
    expect(restored.changesAfter(0, 10).records).toMatchObject([
      { kind: "workout", id: "strength", revision: 1, state: "live" },
      { kind: "workout_exercise", id: "bench-entry", revision: 2, state: "live" },
      {
        kind: "workout_set",
        id: "bench-set",
        revision: 3,
        state: "live",
        content: { weightKg: 102.05, reps: 5, repsInReserve: 0 },
      },
      { kind: "body_measurement", id: "removed-measurement", revision: 4, state: "deleted" },
    ]);
    expect(restored.transaction((tx) => tx.receipt("first-bench-set"))).toMatchObject({
      id: "bench-set",
      revision: 3,
      digest: "a".repeat(64),
      wroteRevision: true,
    });
  } finally {
    await storage.close();
  }
});
