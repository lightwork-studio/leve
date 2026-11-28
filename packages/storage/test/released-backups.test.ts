import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import { accountDatabasePath, ServerStorage } from "../src/server-store.ts";
import {
  dumpFile,
  engine,
  removeTempDirs,
  schemaOf,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { readDeviceFile } from "../src/test-support/logical.ts";

// Backups written by v1.0.0, the first release that keeps real data (fixtures/v1.0.0/capture.ts).
// Every later release must open them without losing or changing what they hold.

afterEach(removeTempDirs);

const fixture = (name: string) => new URL(`fixtures/v1.0.0/${name}`, import.meta.url);

/** A database's tables and indexes, without the bookkeeping table an upgrade leaves behind. */
function layoutOf(path: string): string[] {
  return schemaOf(path).filter((line) => !line.startsWith("table storage_upgrade:"));
}

/**
 * The tables and indexes a new install gets. An opened v1.0.0 database must end up with the same
 * layout, so a schema change without a new storage version and migration fails here.
 */
async function freshLayout(side: "device" | "server"): Promise<string[]> {
  const directory = tempDir();
  if (side === "device") {
    const path = join(directory, "fresh.db");
    (await openDeviceStore({ engine, path, appVersion: "compatibility-test" })).close();
    return layoutOf(path);
  }
  const storage = new ServerStorage({ engine, directory, appVersion: "compatibility-test" });
  try {
    await storage.account("fresh");
  } finally {
    await storage.close();
  }
  return layoutOf(accountDatabasePath(directory, "fresh"));
}

/**
 * Every stored value of the backup is still there after the current code opened it. A later layout
 * may add tables and columns, but it keeps each v1.0.0 value; a migration that has to transform one
 * replaces this comparison with explicit expectations for the transformed rows.
 */
function expectEveryValueKept(before: Record<string, unknown[]>, path: string): void {
  const after = dumpFile(path);
  for (const [table, rows] of Object.entries(before)) {
    if (table === "storage_meta") continue;
    expect(after[table], table).toMatchObject(rows);
  }
}

it("opens the v1.0.0 phone backup and keeps every record, upload and sync position", async () => {
  const path = join(tempDir(), "phone.db");
  copyFileSync(fixture("device.sqlite"), path);
  const before = dumpFile(path);
  const original = readDeviceFile(path);
  expect(original).toMatchObject({
    storageVersion: 5,
    appVersion: "1.0.0",
    unsyncedWork: true,
    sync: { account: "acct-1", cursor: 20, release: "1.0", lineage: "lineage-1" },
  });

  const phone = await openDeviceStore({ engine, path, appVersion: "compatibility-test" });
  try {
    expect(phone.summary()).toMatchObject({
      synced: 11,
      pending: 10,
      conflict: 1,
      invalid: 1,
      inFlight: 5,
    });
    expect(phone.hasUnsyncedWork()).toBe(true);
    expect(phone.syncState()).toMatchObject({ cursor: 20, release: "1.0", lineage: "lineage-1" });
    // The running workout, recorded offline and edited while its upload was in flight.
    expect(phone.activeWorkout()).toMatchObject({
      id: "w-live",
      content: { title: "Leg day (heavy)", endedAt: null },
      status: "pending",
      inFlight: true,
      server: null,
    });
    // A stale edit the server refused keeps both versions for the person to choose.
    expect(phone.get("custom_exercise", "cx-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "stale", revision: 15 },
      content: { name: "Landmine Press (single arm)" },
      server: { revision: 15, content: { name: "Landmine Press" } },
    });
    expect(phone.get("routine_folder", "f-1")).toMatchObject({
      status: "invalid",
      content: { title: "Strength" },
    });
    // A pending deletion, an in-flight deletion and a deletion downloaded from the server.
    expect(phone.get("workout_set", "s-3")).toMatchObject({ deleted: true, status: "pending" });
    expect(phone.get("workout_exercise", "e-row")).toMatchObject({ deleted: true, inFlight: true });
    expect(phone.get("routine", "r-old")).toMatchObject({ deleted: true, status: "synced" });
    // Notes, a reply from an agent and rest preferences, synced and pending.
    expect(phone.get("workout_note", "wn-1")).toMatchObject({
      status: "synced",
      content: { workoutId: "w-done", pinned: true },
    });
    expect(phone.get("workout_note_comment", "wc-1")).toMatchObject({
      content: { noteId: "wn-1", agent: "Coach" },
    });
    expect(phone.get("exercise_note", "xn-1")).toMatchObject({
      content: { exerciseId: "barbell-squat", workoutId: null },
    });
    expect(phone.get("workout_rest", "w-done")).toMatchObject({ content: { seconds: 150 } });
    expect(phone.get("workout_rest", "w-live")).toMatchObject({
      status: "pending",
      content: { seconds: 210 },
    });
    expect(phone.get("workout_note", "wn-live")).toMatchObject({ status: "pending" });
    // An unsent routine edit with the server copy it started from.
    expect(phone.get("routine", "r-1")).toMatchObject({
      status: "pending",
      content: { title: "Push A (deload)" },
      server: { revision: 11, content: { title: "Push A" } },
    });
  } finally {
    phone.close();
  }

  expectEveryValueKept(before, path);
  expect(layoutOf(path)).toEqual(await freshLayout("device"));
  const reopened = readDeviceFile(path);
  expect(reopened.unsyncedWork).toBe(true);
  expect(reopened.records).toEqual(original.records);
  expect(reopened.submissions).toEqual(original.submissions);
  expect(reopened.submissions.map((s) => [s.submissionId, s.op, s.baseRevision])).toEqual([
    ["sub-bm-1", "put", 8],
    ["sub-e-live", "put", null],
    ["sub-e-row", "delete", 3],
    ["sub-s-live", "put", null],
    ["sub-w-live", "put", null],
  ]);
});

const SERVER_RECORDS = [
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
];

it("opens a v1.0.0 account database in place with its history, deletions and receipts", async () => {
  const directory = tempDir();
  const path = accountDatabasePath(directory, "account");
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(fixture("server.sqlite"), path);
  const before = dumpFile(path);
  const storage = new ServerStorage({ engine, directory, appVersion: "compatibility-test" });
  try {
    const account = await storage.account("account");
    expect(account.lineage()).toBe("v1-account-history");
    expect(account.headRevision()).toBe(4);
    expect(account.changesAfter(0, 10).records).toMatchObject(SERVER_RECORDS);
    expect(account.transaction((tx) => tx.receipt("first-bench-set"))).toMatchObject({
      id: "bench-set",
      revision: 3,
      digest: "a".repeat(64),
      wroteRevision: true,
    });
  } finally {
    await storage.close();
  }
  expectEveryValueKept(before, path);
  expect(layoutOf(path)).toEqual(await freshLayout("server"));
});

it("restores a v1.0.0 server backup with its records, deletion markers and receipts", async () => {
  const path = join(tempDir(), "backup.db");
  copyFileSync(fixture("server.sqlite"), path);
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
    expect(restored.changesAfter(0, 10).records).toMatchObject(SERVER_RECORDS);
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
