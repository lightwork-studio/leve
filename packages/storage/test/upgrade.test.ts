import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEVICE_STORAGE_VERSION,
  deviceStorageDefinition,
  verifyDeviceRecords,
} from "../src/device-schema.ts";
import { openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import { addReleaseRefresh } from "../src/migrations/1.0/storage-v2.ts";
import {
  buildDeviceFixture,
  dumpFile,
  durableFiles,
  engine,
  NEW_APP,
  OLD_APP,
  openWith,
  removeTempDirs,
  runCrashChild,
  schemaOf,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { readDeviceFile } from "../src/test-support/logical.ts";
import { maximumWorkout } from "../src/test-support/max-workout.ts";
import {
  deviceV1,
  deviceV2,
  deviceV2Corrupting,
  deviceV2Throwing,
  deviceV3,
  fixtureContract,
  historicalContract,
} from "../src/test-support/versions.ts";
import {
  openStorage,
  type StorageDefinition,
  StorageTooNewError,
  snapshotPath,
  UpgradeFailedError,
} from "../src/upgrade.ts";
import { EXPECTED_FIXTURE, UNFINISHED_WORKOUT } from "./expected-fixture.ts";
import { deviceFixture, failure, meaning } from "./helpers.ts";

afterAll(removeTempDirs);

const openOldStore = (path: string) =>
  openDeviceStore({
    engine,
    path,
    appVersion: OLD_APP,
    contract: fixtureContract,
    definition: deviceV1,
  });

describe("the version-1 device fixture", () => {
  it("holds every kind of state, written through the real device store", async () => {
    const path = await deviceFixture();
    const logical = readDeviceFile(path);
    expect(logical.storageVersion).toBe(1);
    expect(logical.appVersion).toBe(OLD_APP);
    expect(meaning(logical)).toEqual(EXPECTED_FIXTURE);

    const store = await openOldStore(path);
    expect(store.summary()).toEqual({
      synced: 7,
      pending: 7,
      conflict: 1,
      partial: 1,
      invalid: 1,
      inFlight: 5,
    });
    expect(store.activeWorkout()?.id).toBe(UNFINISHED_WORKOUT);
    store.close();
  });
});

describe("upgrading device storage to a test-only version 2", () => {
  it("keeps the meaning of every record, upload and the sync state", async () => {
    const path = await deviceFixture();
    const before = readDeviceFile(path);
    const original = dumpFile(path);

    const opened = await openStorage({ engine, path, definition: deviceV2, appVersion: NEW_APP });
    expect(opened.upgradedFrom).toBe(1);
    expect(opened.meta).toEqual({ storageVersion: 2, appVersion: NEW_APP, unsyncedWork: true });
    opened.db.close();

    const after = readDeviceFile(path);
    expect(after.storageVersion).toBe(2);
    expect(meaning(after)).toEqual(EXPECTED_FIXTURE);
    // Content is carried over as stored text, not re-encoded.
    expect(after.rawContent).toEqual(before.rawContent);
    expect(after.submissions.map((s) => s.wireContent)).toEqual(
      before.submissions.map((s) => s.wireContent),
    );

    // The layout really changed: moved columns are gone, new tables hold their values.
    const schema = schemaOf(path).join("\n");
    expect(schema).toContain("table record_partial_fields");
    expect(schema).toContain("table submission_payloads");
    expect(schema).not.toMatch(/partial_fields TEXT/);
    expect(schema).not.toMatch(/wire_content TEXT,/);
    // The verified upgrade left no unfinished marker, and the snapshot holds the old data.
    expect(dumpFile(path).storage_upgrade).toEqual([]);
    expect(dumpFile(snapshotPath(path, 1))).toEqual(original);
    expect(engine.exists(`${snapshotPath(path, 1)}.tmp`)).toBe(false);
  });

  it("upgrades directly across a skipped version", async () => {
    const path = await deviceFixture();
    const opened = await openStorage({ engine, path, definition: deviceV3, appVersion: NEW_APP });
    expect(opened.upgradedFrom).toBe(1);
    opened.db.close();
    const after = readDeviceFile(path);
    expect(after.storageVersion).toBe(3);
    expect(meaning(after)).toEqual(EXPECTED_FIXTURE);
    expect(schemaOf(path).join("\n")).toContain("index records_display_order");
  });

  it("keeps the pre-upgrade snapshot until the next successful upgrade", async () => {
    const path = await deviceFixture();
    await openWith(path, deviceV2, NEW_APP);
    expect(engine.exists(snapshotPath(path, 1))).toBe(true);

    await openWith(path, deviceV3, "0.3.0");
    expect(engine.exists(snapshotPath(path, 2))).toBe(true);
    expect(engine.exists(snapshotPath(path, 1))).toBe(false);
    expect(meaning(readDeviceFile(path))).toEqual(EXPECTED_FIXTURE);
  });

  it("rolls back a step that throws halfway, leaving the old build's data", async () => {
    const path = await deviceFixture();
    const original = dumpFile(path);
    const error = await failure(openWith(path, deviceV2Throwing, NEW_APP));
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).restoredSnapshot).toBe(false);
    expect(dumpFile(path)).toEqual(original);
    await openWith(path, deviceV1, OLD_APP);
    expect(meaning(readDeviceFile(path))).toEqual(EXPECTED_FIXTURE);
  });

  it("records the unsynced-work flag of the upgraded data in the fixed metadata", async () => {
    const path = await deviceFixture();
    await openWith(path, deviceV2, NEW_APP);
    const db = engine.open(path, { readOnly: true });
    expect(readStorageMeta(db)).toEqual({
      storageVersion: 2,
      appVersion: NEW_APP,
      unsyncedWork: true,
    });
    db.close();
  });
});

describe("an upgrade that fails verification", () => {
  it("restores the snapshot, reports the failure and succeeds with a fixed build", async () => {
    const path = await deviceFixture();
    const original = dumpFile(path);

    const error = await failure(openWith(path, deviceV2Corrupting, NEW_APP));
    expect(error).toBeInstanceOf(UpgradeFailedError);
    const failed = error as UpgradeFailedError;
    expect(failed.restoredSnapshot).toBe(true);
    expect([failed.from, failed.to]).toEqual([1, 2]);
    // The broken step truncated the first in-flight payload (sub-bm-1 sorts first).
    expect(failed.problems).toContain("submission sub-bm-1: payload is invalid JSON");

    // Data is exactly as before, and the build that wrote it still opens it.
    expect(dumpFile(path)).toEqual(original);
    await openWith(path, deviceV1, OLD_APP);
    expect(dumpFile(path)).toEqual(original);

    // Retrying the broken build fails the same way without losing anything.
    expect(await failure(openWith(path, deviceV2Corrupting, NEW_APP))).toBeInstanceOf(
      UpgradeFailedError,
    );
    expect(dumpFile(path)).toEqual(original);

    // A fixed release resolves it.
    await openWith(path, deviceV2, NEW_APP);
    const after = readDeviceFile(path);
    expect(after.storageVersion).toBe(2);
    expect(meaning(after)).toEqual(EXPECTED_FIXTURE);
  });
});

describe("a rehearsed restore of the pre-upgrade snapshot", () => {
  it("brings back version-1 data that the old build reads", async () => {
    const path = await deviceFixture();
    await openWith(path, deviceV2, NEW_APP);
    // After the upgrade only the new build can read the database.
    expect(await failure(openWith(path, deviceV1, OLD_APP))).toBeInstanceOf(StorageTooNewError);

    // Restore the kept snapshot into a throwaway database with SQLite's backup.
    const restored = join(tempDir(), "restored.db");
    const snapshot = engine.open(snapshotPath(path, 1), { readOnly: true });
    try {
      await engine.backup(snapshot, restored);
    } finally {
      snapshot.close();
    }

    // The restored copy is version-1 storage. Builds that read version 1 (the old build) open it
    // as it is; builds with version 2 or later upgrade it again on open, as with any v1 data.
    const logical = readDeviceFile(restored);
    expect(logical.storageVersion).toBe(1);
    expect(meaning(logical)).toEqual(EXPECTED_FIXTURE);

    const store = await openOldStore(restored);
    expect(store.activeWorkout()?.id).toBe(UNFINISHED_WORKOUT);
    expect(store.get("workout_set", "s-2")?.content?.reps).toBe(6);
    expect(store.get("custom_exercise", "cx-1")?.status).toBe("conflict");
    expect(store.summary().inFlight).toBe(5);
    store.close();
    expect(meaning(readDeviceFile(restored))).toEqual(EXPECTED_FIXTURE);

    await openWith(restored, deviceV2, NEW_APP);
    expect(meaning(readDeviceFile(restored))).toEqual(EXPECTED_FIXTURE);
  });
});

describe("verification of the version-1 layout after an upgrade", () => {
  /** A test-only version 2 that keeps the v1 layout (and its verification) but damages one value. */
  const damaging = (sql: string): StorageDefinition => ({
    ...deviceV1,
    name: "device (test v2, same layout)",
    version: 2,
    oldestUpgradable: 1,
    steps: [
      {
        from: 1,
        description: "test: add an index, then damage one stored value",
        run(db) {
          db.exec("CREATE INDEX records_updated ON records (updated_at)");
          db.exec(sql);
        },
      },
    ],
  });

  it.each([
    [
      "a server copy that no longer decodes",
      "UPDATE records SET server_content = '{\"weightUnit\":\"stone\"}' WHERE kind = 'settings'",
      /^settings\/settings server_content: /,
    ],
    [
      "a partially synced field list",
      "UPDATE records SET partial_fields = '[\"perceivedEffort\"' WHERE id = 'w-done'",
      /^workout\/w-done partial_fields: invalid JSON$/,
    ],
    [
      "the omitted fields of an upload in flight",
      "UPDATE submissions SET omitted = '\"perceivedEffort\"' WHERE submission_id = 'sub-bm-1'",
      /^submission sub-bm-1 omitted: not a list of names$/,
    ],
    [
      "the descendants of a deletion in flight",
      `UPDATE submissions SET descendants = '[{"kind":"workout_set","id":"s-row"}]'
       WHERE submission_id = 'sub-e-row'`,
      /^submission sub-e-row descendants: not a list of records$/,
    ],
    [
      "a valid but different workout on the same dispatched submission",
      "UPDATE submissions SET wire_content=json_set(wire_content,'$.title','Changed after dispatch') WHERE submission_id='sub-w-live'",
      /^submission sub-w-live: upload identity or edit sequence changed during upgrade/,
    ],
    [
      "a valid but different omission on the same dispatched submission",
      `UPDATE submissions SET omitted=CASE WHEN omitted='[]' THEN '["perceivedEffort"]' ELSE '[]' END WHERE submission_id='sub-w-live'`,
      /^submission sub-w-live: upload identity or edit sequence changed during upgrade/,
    ],
    [
      "a queued workout containing a field only permitted in release 1.1",
      `UPDATE submissions SET wire_content = json_set(wire_content, '$.perceivedEffort', NULL)
       WHERE submission_id = 'sub-w-live'`,
      /^submission sub-w-live wire_content:/,
    ],
    [
      "a queued upload whose saved release is unavailable",
      "UPDATE submissions SET release='9.0' WHERE submission_id='sub-bm-1'",
      /^submission sub-bm-1: .* unavailable on release 9.0$/,
    ],
    [
      "a deletion naming an unknown descendant kind",
      `UPDATE submissions SET descendants='[{"kind":"missing","id":"s-row","revision":1}]'
       WHERE submission_id='sub-e-row'`,
      /^submission sub-e-row: descendant unavailable on release/,
    ],
    [
      "a saved deletion losing its original descendants",
      "UPDATE submissions SET descendants='[]' WHERE submission_id='sub-e-row'",
      /^submission sub-e-row: upload identity or edit sequence changed during upgrade/,
    ],
    [
      "an old receipt changed to acknowledge its owner's later edit",
      "UPDATE submissions SET local_seq=2 WHERE submission_id='sub-w-live'",
      /^submission sub-w-live: upload identity or edit sequence changed during upgrade/,
    ],
    [
      "a child's local deletion detached from its known parent",
      "UPDATE records SET parent_kind=NULL,parent_id=NULL WHERE id='s-3'",
      /^workout_set\/s-3: invalid parent index/,
    ],
    [
      "a local deletion retaining an invalid parent ID",
      "UPDATE records SET parent_id='bad id' WHERE id='s-3'",
      /^workout_set\/s-3: invalid parent index/,
    ],
    [
      "a receipt ahead of its current local edit",
      "UPDATE submissions SET local_seq=999 WHERE submission_id='sub-w-live'",
      /^submission sub-w-live: invalid owner or edit sequence/,
    ],
    [
      "an upload detached from its set",
      "UPDATE submissions SET id='s-unrelated' WHERE submission_id='sub-s-live'",
      /^submission sub-s-live: invalid owner or edit sequence/,
    ],
    [
      "a deletion indexed as its own parent",
      "UPDATE records SET parent_kind='workout_set',parent_id='s-3' WHERE id='s-3'",
      /^workout_set\/s-3: invalid parent index/,
    ],
    [
      "an unpaired parent on a pending deletion",
      "UPDATE records SET parent_id=NULL WHERE id='s-3'",
      /^workout_set\/s-3: invalid parent index/,
    ],
    [
      "a descendant at a nonpositive revision",
      "UPDATE submissions SET descendants=json_set(descendants,'$[0].revision',0) WHERE submission_id='sub-e-row'",
      /^submission sub-e-row envelope:/,
    ],
    [
      "an invalid base revision on a queued put",
      "UPDATE submissions SET base_revision=-1 WHERE submission_id='sub-w-live'",
      /^submission sub-w-live envelope:/,
    ],
    [
      "an invalid ID on a queued put",
      "UPDATE submissions SET submission_id='bad id' WHERE submission_id='sub-w-live'",
      /^submission bad id envelope:/,
    ],
    [
      "a deletion listing an unrelated kind",
      "UPDATE submissions SET descendants=json_set(descendants,'$[0].kind','settings') WHERE submission_id='sub-e-row'",
      /^submission sub-e-row: invalid descendant/,
    ],
    [
      "a deletion listing the same set twice",
      "UPDATE submissions SET descendants=json_insert(descendants,'$[#]',json_extract(descendants,'$[0]')) WHERE submission_id='sub-e-row'",
      /^submission sub-e-row: invalid descendant/,
    ],
    [
      "an unknown omission",
      "UPDATE submissions SET omitted=json_array('unknownField') WHERE submission_id='sub-s-live'",
      /^submission sub-s-live omitted: invalid field/,
    ],
    [
      "an omission understood by the saved release",
      "UPDATE submissions SET omitted=json_array('title') WHERE submission_id='sub-w-live'",
      /^submission sub-w-live omitted: invalid field/,
    ],
    [
      "an omission on a deletion",
      "UPDATE submissions SET omitted=json_array('restSeconds') WHERE submission_id='sub-e-row'",
      /^submission sub-e-row omitted: invalid field/,
    ],
    [
      "a set indexed under a different exercise",
      `UPDATE records SET parent_id='e-live' WHERE kind='workout_set' AND id='s-2'`,
      /^workout_set\/s-2: parent index differs from current content$/,
    ],
    [
      "the negotiated features",
      "UPDATE sync_state SET features = 'workouts'",
      /^sync_state features: invalid JSON$/,
    ],
  ])("catches %s and restores the snapshot", async (_what, sql, problem) => {
    const path = await deviceFixture();
    const original = dumpFile(path);
    const error = await failure(openWith(path, damaging(sql), NEW_APP));
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).restoredSnapshot).toBe(true);
    expect((error as UpgradeFailedError).problems.some((p) => problem.test(p))).toBe(true);
    expect(dumpFile(path)).toEqual(original);
  });

  it("keeps the original v1 database when an undispatched local record has a malformed ID", async () => {
    const path = await deviceFixture();
    const db = engine.open(path);
    try {
      db.run("DELETE FROM submissions WHERE id='bm-1'");
      expect(db.run("UPDATE records SET id='bad id' WHERE id='bm-1'").changes).toBe(1);
    } finally {
      db.close();
    }
    const original = dumpFile(path);
    const error = await failure(
      openWith(path, deviceStorageDefinition({ contract: fixtureContract }), NEW_APP),
    );
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).problems).toContain(
      "body_measurement/bad id: invalid record identity",
    );
    expect(dumpFile(path)).toEqual(original);
  });

  it("restores a v3 receipt choice if an upgrade loses the user's decision", async () => {
    const path = await deviceFixture();
    const definition = deviceStorageDefinition({ contract: fixtureContract });
    await openWith(
      path,
      { ...definition, version: 3, steps: definition.steps.filter((step) => step.from < 3) },
      NEW_APP,
    );
    const db = engine.open(path);
    expect(
      db.run("UPDATE submissions SET choice_after_dispatch=1 WHERE submission_id='sub-w-live'")
        .changes,
    ).toBe(1);
    db.close();
    const before = dumpFile(path);
    const corrupted = {
      ...definition,
      steps: definition.steps.map((step) =>
        step.from !== 3
          ? step
          : {
              ...step,
              run(db: Parameters<typeof step.run>[0]) {
                step.run(db);
                db.run(
                  "UPDATE submissions SET choice_after_dispatch=0 WHERE submission_id='sub-w-live'",
                );
              },
            },
      ),
    };
    const error = await failure(openWith(path, corrupted, NEW_APP));
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).problems).toContain(
      "submission sub-w-live: upload identity or edit sequence changed during upgrade",
    );
    expect(dumpFile(path)).toEqual(before);
  });

  it("rechecks the original receipt sequence when a committed upgrade reopens", async () => {
    const path = await deviceFixture();
    const original = dumpFile(path);
    const definition = damaging(
      "UPDATE submissions SET local_seq=2 WHERE submission_id='sub-w-live'",
    );
    await expect(
      openStorage({
        engine,
        path,
        definition,
        appVersion: NEW_APP,
        onCheckpoint(point) {
          if (point === "upgrade:committed") throw new Error("interrupted after commit");
        },
      }),
    ).rejects.toThrow("interrupted after commit");
    expect(dumpFile(path).storage_upgrade).toHaveLength(1);
    const error = await failure(openWith(path, definition, NEW_APP));
    expect(error).toMatchObject({
      restoredSnapshot: true,
      problems: ["submission sub-w-live: upload identity or edit sequence changed during upgrade"],
    });
    expect(dumpFile(path)).toEqual(original);
  });

  it("keeps a moved then deleted set and the original omission on a superseded upload", async () => {
    const path = await deviceFixture();
    const store = await openOldStore(path);
    const set = store.get("workout_set", "s-2")?.content;
    const workout = store.get("workout", "w-live")?.content;
    if (!set || !workout) throw new Error("missing fixture rows");
    store.put("workout_set", "s-2", { ...set, workoutExerciseId: "e-live" });
    store.delete("workout_set", "s-2");
    store.put("workout", "w-effort", { ...workout, perceivedEffort: 6 });
    store.prepareSubmissions("1.0");
    store.put("workout", "w-effort", { ...workout, perceivedEffort: null });
    store.close();
    const before = readDeviceFile(path);
    expect(before.records.find((r) => r.id === "s-2")).toMatchObject({
      parent: "workout_exercise/e-live",
      local: { state: "deleted" },
    });
    const upload = before.submissions.find((s) => s.record === "workout/w-effort");
    expect(upload).toMatchObject({ release: "1.0", omitted: '["perceivedEffort"]' });
    await openWith(path, damaging("SELECT 1"), NEW_APP);
    const after = readDeviceFile(path);
    expect(after.records).toEqual(before.records);
    expect(after.submissions).toEqual(before.submissions);
  });

  it("passes the undamaged fixture", async () => {
    const path = await deviceFixture();
    const dataOf = (dump: Record<string, unknown[]>) => ({
      records: dump.records,
      submissions: dump.submissions,
      sync_state: dump.sync_state,
    });
    const before = dataOf(dumpFile(path));
    await openWith(path, damaging("SELECT 1"), NEW_APP);
    expect(dataOf(dumpFile(path))).toEqual(before);
  });
});

describe("upgrading device storage during a server restore", () => {
  it("keeps which records are offered again, kept server copies and the unfinished download", async () => {
    const path = join(tempDir(), "device.db");
    const store = await openOldStore(path);
    const workout = {
      title: "Legs",
      startedAt: "2026-11-09T07:00:00.000Z",
      endedAt: "2026-11-09T08:00:00.000Z",
      routineId: null,
    };
    store.setNegotiated("1.0", ["workouts"], "lineage-1");
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-a", revision: 3, content: workout },
        { state: "live", kind: "workout", id: "w-b", revision: 8, content: workout },
      ],
      8,
    );
    store.put("workout", "w-c", workout);
    store.put("workout", "w-b", { ...workout, title: "Legs, edited" });
    // The server was restored: w-a is offered again, w-b keeps its server copy beside the user's
    // edit, w-c is the user's new record.
    store.resetForServerRestore();
    store.close();
    const before = readDeviceFile(path);

    await openWith(path, deviceV2, NEW_APP);
    const after = readDeviceFile(path);
    expect(after.storageVersion).toBe(2);
    expect(
      after.records.map((r) => [r.id, r.status, r.server, r.reoffered, r.keptContent]),
    ).toEqual([
      ["w-a", "pending", null, true, null],
      ["w-b", "pending", null, false, { ...workout, perceivedEffort: null }],
      ["w-c", "pending", null, false, null],
    ]);
    expect(after.sync).toMatchObject({
      cursor: 0,
      restoring: 1,
      lineage: "lineage-1",
    });
    expect(meaning(after)).toEqual(meaning(before));
  });
});

describe("checking the pre-upgrade snapshot", () => {
  /** Damages the finished snapshot copy before the upgrade checks it. */
  const damages: Record<string, (tmp: string) => void> = {
    damaged: (tmp) => {
      const db = engine.open(tmp, { readOnly: true });
      const page = Number(
        db.get("SELECT rootpage FROM sqlite_master WHERE name = 'records_status'")?.rootpage,
      );
      const pageSize = Number(db.get("PRAGMA page_size")?.page_size);
      db.close();
      const fd = openSync(tmp, "r+");
      writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, (page - 1) * pageSize);
      closeSync(fd);
    },
    "of the wrong version": (tmp) => {
      const db = engine.open(tmp);
      db.run("UPDATE storage_meta SET storage_version = 9 WHERE id = 1");
      db.close();
    },
  };

  it.each(Object.keys(damages))("refuses to upgrade when the snapshot is %s", async (how) => {
    const path = await deviceFixture();
    const live = durableFiles(dirname(path))["device.db"];
    const error = await failure(
      openStorage({
        engine,
        path,
        definition: deviceV2,
        appVersion: NEW_APP,
        onCheckpoint(point) {
          if (point === "snapshot:written") damages[how]?.(`${snapshotPath(path, 1)}.tmp`);
        },
      }),
    );
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).restoredSnapshot).toBe(false);
    expect((error as UpgradeFailedError).problems[0]).toBe("snapshot");
    // Nothing was upgraded and no unusable snapshot was kept as the restore point.
    expect(engine.exists(snapshotPath(path, 1))).toBe(false);
    expect(durableFiles(dirname(path))["device.db"]).toBe(live);
    expect(meaning(readDeviceFile(path))).toEqual(EXPECTED_FIXTURE);

    // The next attempt takes a fresh snapshot and upgrades.
    await openWith(path, deviceV2, NEW_APP);
    expect(meaning(readDeviceFile(path))).toEqual(EXPECTED_FIXTURE);
    expect(readDeviceFile(snapshotPath(path, 1)).storageVersion).toBe(1);
  });
});

it("registers the exact migration source for each released storage upgrade", () => {
  const root = new URL("../src/migrations/", import.meta.url);
  const registry = JSON.parse(readFileSync(new URL("registry.json", root), "utf8")) as {
    releases: { files: Record<string, string> }[];
  };
  const files = Object.assign({}, ...registry.releases.map((r) => r.files)) as Record<
    string,
    string
  >;
  expect(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.split(sep).join("/"))
      .sort(),
  ).toEqual(Object.keys(files).sort());
  for (const [file, digest] of Object.entries(files)) {
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(file, root)))
        .digest("hex"),
    ).toBe(digest);
  }
});

it("reopens a genuine 1.0 device after an interrupted production migration and resumes sync", async () => {
  const path = join(tempDir(), "old-phone.db");
  await buildDeviceFixture(path, engine, "1.0");
  const before = readDeviceFile(path);
  expect(before.records.find((r) => r.id === "w-live")?.local?.content).toEqual({
    title: "Leg day (heavy)",
    startedAt: "2026-11-10T08:12:00.000Z",
    endedAt: null,
    routineId: null,
  });
  expect(
    (
      await runCrashChild({
        path,
        mode: "device-previous-preview",
        point: "upgrade:committed",
        count: 1,
      })
    ).signal,
  ).toBe("SIGKILL");
  const store = await openDeviceStore({
    engine,
    path,
    appVersion: NEW_APP,
    contract: historicalContract("2.0"),
  });
  const after = readDeviceFile(path);
  expect(meaning(after)).toEqual(meaning(before));
  expect(after.rawContent).toEqual(before.rawContent);
  expect(after.storageVersion).toBe(DEVICE_STORAGE_VERSION);
  expect(store.activeWorkout()?.id).toBe("w-live");
  expect(store.get("workout", "w-done")?.content).not.toHaveProperty("initialPlan");
  expect(store.get("workout_set", "s-2")?.content).toMatchObject({ reps: 6, weightKg: 102.05 });
  expect(store.get("workout_set", "s-2")?.content).not.toHaveProperty("planSlot");
  expect(store.summary()).toMatchObject({ inFlight: 5, conflict: 1, invalid: 1, pending: 7 });
  store.setNegotiated("1.1", [], "lineage-1");
  expect(store.prepareSubmissions("1.1")).toEqual([]);
  const server = store.get("workout", "w-done")?.server;
  if (!server?.content) throw new Error("missing historical workout");
  store.applyPull(
    [
      {
        state: "live",
        kind: "workout",
        id: "w-done",
        revision: server.revision,
        content: { ...server.content, initialPlan: null },
      },
    ],
    server.revision,
    { cursor: 0, lineage: "lineage-1", release: "1.1", lastPage: true },
  );
  store.put("workout", "w-new", {
    ...server.content,
    initialPlan: { title: "New template", exercises: [] },
  });
  const uploads = store.prepareSubmissions("1.1");
  expect(uploads.find((s) => s.submission.id === "w-new")).toMatchObject({
    release: "1.1",
    submission: { content: { initialPlan: { title: "New template", exercises: [] } } },
  });
  expect(uploads.find((s) => s.submission.submissionId === "sub-w-live")).toMatchObject({
    release: "1.0",
    submission: { content: { title: "Leg day" } },
  });
  expect(
    uploads.find((s) => s.submission.submissionId === "sub-w-live")?.submission,
  ).not.toHaveProperty("content.initialPlan");
  store.close();
});

it.each([2, 3] as const)(
  "restores a version-%i phone with pending, in-flight and partially synced records",
  async (version) => {
    const path = join(tempDir(), "previous-device.db");
    await buildDeviceFixture(path, engine, "1.0");
    const contract = historicalContract(version === 2 ? "1.1" : "1.2");
    const definition = deviceStorageDefinition({ contract });
    const previous = {
      ...definition,
      steps: definition.steps.filter((step) => step.from < version),
      version,
    };
    const prior = await openDeviceStore({
      engine,
      path,
      definition: previous,
      contract,
      appVersion: "previous",
    });
    const plan = { title: "Original strength session", exercises: [] };
    try {
      const workout = prior.get("workout", "w-done")?.content;
      if (!workout) throw new Error("Missing completed workout in the fixture");
      if (version === 3) {
        const set = prior.get("workout_set", "s-2")?.content;
        if (!set) throw Error("Missing workout set");
        prior.put("workout_set", "s-2", { ...set, repsInReserve: 0 });
        prior.put("workout", "at-limit", maximumWorkout());
      }
      prior.put("workout", "w-done", { ...workout, initialPlan: plan });
      const upload = prior
        .prepareSubmissions("1.0")
        .find(({ submission }) => submission.id === "w-done");
      if (!upload) throw new Error("Missing workout upload");
      prior.applyPushResults([
        { status: "accepted", submissionId: upload.submission.submissionId, revision: 25 },
      ]);
      expect(prior.get("workout", "w-done")).toMatchObject({
        status: "partial",
        partialFields: ["initialPlan"],
      });
    } finally {
      prior.close();
    }
    const before = readDeviceFile(path);
    expect(before.storageVersion).toBe(version);
    expect(
      (
        await runCrashChild({
          path,
          mode: "device-previous-preview",
          point: "upgrade:committed",
          count: 1,
        })
      ).signal,
    ).toBe("SIGKILL");
    const store = await openDeviceStore({
      engine,
      path,
      appVersion: NEW_APP,
      contract: historicalContract("2.0"),
    });
    try {
      const after = readDeviceFile(path);
      expect(after.storageVersion).toBe(DEVICE_STORAGE_VERSION);
      expect(meaning(after)).toEqual(meaning(before));
      expect(after.rawContent).toEqual(before.rawContent);
      if (version === 3) {
        expect(store.get("workout_set", "s-2")?.content?.repsInReserve).toBe(0);
        expect(store.get("workout", "at-limit")?.content).toEqual(maximumWorkout());
      } else expect(store.get("workout_set", "s-2")?.content).not.toHaveProperty("repsInReserve");
      expect(store.get("workout", "w-done")?.content).not.toHaveProperty("journal");
      expect(store.get("workout", "w-done")).toMatchObject({
        status: "partial",
        partialFields: ["initialPlan"],
        content: { initialPlan: plan },
      });
      expect(store.summary()).toMatchObject({ conflict: 1, invalid: 1, partial: 1 });
      expect(store.summary().inFlight).toBeGreaterThan(0);
    } finally {
      store.close();
    }
    expect(await failure(openWith(path, previous, "previous"))).toBeInstanceOf(StorageTooNewError);
    expect(meaning(readDeviceFile(snapshotPath(path, version)))).toEqual(meaning(before));
  },
);

it("detects a rest record or queued upload stored under a different ID on the device", async () => {
  const store = await openDeviceStore({
    engine,
    path: join(tempDir(), "bad-owner.db"),
    appVersion: NEW_APP,
  });
  try {
    store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
    store.prepareSubmissions("1.0");
    store.db.run("UPDATE records SET id='wrong' WHERE kind='workout_rest'");
    store.db.run("UPDATE submissions SET id='wrong' WHERE kind='workout_rest'");
    const problems = verifyDeviceRecords(store.db);
    expect(
      problems.some((text) => text.includes("local_content") && /parent.*ID/i.test(text)),
    ).toBe(true);
    expect(problems.some((text) => text.includes("submission") && /parent.*ID/i.test(text))).toBe(
      true,
    );
  } finally {
    store.close();
  }
});

it.each(["index", "release", "missing field"])(
  "detects a malformed pending rest relationship (%s)",
  async (damage) => {
    const store = await openDeviceStore({
      engine,
      path: join(tempDir(), "pending-rest.db"),
      appVersion: NEW_APP,
    });
    try {
      store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
      store.prepareSubmissions("1.0");
      if (damage === "index")
        store.db.run("UPDATE records SET parent_id='other' WHERE kind='workout_rest'");
      if (damage === "release")
        store.db.run("UPDATE submissions SET release='1.2' WHERE kind='workout_rest'");
      if (damage === "missing field")
        store.db.run("UPDATE submissions SET wire_content=? WHERE kind='workout_rest'", [
          JSON.stringify({ workoutId: "w" }),
        ]);
      const issues = verifyDeviceRecords(store.db);
      expect(
        issues.some((message) => message.includes(damage === "index" ? "parent" : "submission")),
      ).toBe(true);
    } finally {
      store.close();
    }
  },
);

it.each(["release", "wrong shared ID", "foreign note"])(
  "detects a damaged descendant in a queued workout deletion (%s)",
  async (damage) => {
    const store = await openDeviceStore({
      engine,
      path: join(tempDir(), "queued-delete.db"),
      appVersion: NEW_APP,
      contract: historicalContract("2.0"),
    });
    try {
      store.applyPull(
        [
          {
            kind: "workout",
            id: "w",
            state: "live",
            revision: 1,
            content: {
              title: "Session",
              startedAt: "2026-11-10T09:00:00.000Z",
              endedAt: null,
              routineId: null,
              initialPlan: null,
            },
          },
          {
            kind: "workout_rest",
            id: "w",
            state: "live",
            revision: 2,
            content: { workoutId: "w", seconds: 30 },
          },
        ],
        2,
      );
      if (damage === "foreign note") {
        const parent = store.get("workout", "w")?.content;
        if (!parent) throw Error("Missing workout");
        store.applyPull(
          [
            { state: "live", kind: "workout", id: "other", revision: 3, content: parent },
            {
              state: "live",
              kind: "workout_note",
              id: "foreign",
              revision: 4,
              content: {
                workoutId: "other",
                text: "Another workout",
                pinned: false,
                createdAt: "2026-11-10T09:00:00.000Z",
                agent: null,
              },
            },
          ],
          4,
        );
      }
      store.delete("workout", "w");
      expect(store.prepareSubmissions("2.0")[0]?.submission).toMatchObject({
        op: "delete",
        descendants: [{ kind: "workout_rest", id: "w", revision: 2 }],
      });
      expect(verifyDeviceRecords(store.db, store.contract)).toEqual([]);
      if (damage === "release") store.db.run("UPDATE submissions SET release='1.2'");
      else if (damage === "foreign note")
        store.db.run("UPDATE submissions SET descendants=?", [
          JSON.stringify([{ kind: "workout_note", id: "foreign", revision: 4 }]),
        ]);
      else
        store.db.run("UPDATE submissions SET descendants=?", [
          JSON.stringify([{ kind: "workout_rest", id: "other", revision: 2 }]),
        ]);
      expect(verifyDeviceRecords(store.db, store.contract)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            damage === "release"
              ? "descendant unavailable on release 1.2"
              : damage === "foreign note"
                ? "invalid descendant workout_note/foreign"
                : "invalid descendant workout_rest/other",
          ),
        ]),
      );
    } finally {
      store.close();
    }
  },
);

it("accepts detached rest tombstones but rejects one indexed under another workout", async () => {
  const store = await openDeviceStore({
    engine,
    path: join(tempDir(), "rest-marker.db"),
    appVersion: NEW_APP,
  });
  try {
    store.applyPull([{ kind: "workout_rest", id: "w", state: "deleted", revision: 1 }], 1);
    expect(verifyDeviceRecords(store.db)).toEqual([]);
    store.db.run(
      "UPDATE records SET parent_kind='workout',parent_id='other' WHERE kind='workout_rest'",
    );
    expect(verifyDeviceRecords(store.db)).toContain("workout_rest/w: invalid parent index");
  } finally {
    store.close();
  }
});

it("recovers the previous storage version with pending and in-flight records before recording set effort", async () => {
  const path = join(tempDir(), "previous-device.db");
  await buildDeviceFixture(path, engine, "1.0");
  const contract = historicalContract("2.0");
  const previous = {
    ...deviceStorageDefinition({ steps: [addReleaseRefresh], contract }),
    version: 2,
  };
  const prior = await openDeviceStore({
    engine,
    path,
    definition: previous,
    contract,
    appVersion: "previous",
  });
  const plan = { title: "Original strength session", exercises: [] };
  try {
    const workout = prior.get("workout", "w-done")?.content;
    if (!workout) throw new Error("Missing completed workout in the fixture");
    prior.put("workout", "w-on-wire", { ...workout, initialPlan: plan });
    prior.put("workout", "w-done", { ...workout, initialPlan: plan });
    const upload = prior
      .prepareSubmissions("1.0")
      .find(({ submission }) => submission.id === "w-done");
    if (!upload) throw new Error("Missing workout upload");
    prior.applyPushResults([
      { status: "accepted", submissionId: upload.submission.submissionId, revision: 25 },
    ]);
    expect(prior.db.get("SELECT omitted FROM submissions WHERE id = 'w-on-wire'")?.omitted).toBe(
      '["initialPlan"]',
    );
    // The v2 writer stored a first edit from a projected copy without an
    // omitted field marker or envelope before its next upload.
    const oldSet = prior.get("workout_set", "s-1")?.content;
    if (!oldSet) throw new Error("Missing acknowledged set");
    prior.db.run(
      `UPDATE records SET local_state='live', local_seq=local_seq+1,
      local_base=server_revision, local_content=?, partial_fields=NULL, status='pending'
      WHERE kind='workout_set' AND id='s-1'`,
      [JSON.stringify({ ...oldSet, planSlot: { exercise: 0, set: 1 } })],
    );
    expect(prior.db.get("SELECT id FROM submissions WHERE id='s-1'")).toBeUndefined();
    expect(prior.get("workout", "w-done")).toMatchObject({
      status: "partial",
      partialFields: ["initialPlan"],
    });
  } finally {
    prior.close();
  }
  const before = readDeviceFile(path);
  expect(before.storageVersion).toBe(2);
  expect(
    (
      await runCrashChild({
        path,
        mode: "device-previous-preview",
        point: "upgrade:committed",
        count: 1,
      })
    ).signal,
  ).toBe("SIGKILL");
  const store = await openDeviceStore({ engine, path, appVersion: NEW_APP, contract });
  try {
    const after = readDeviceFile(path);
    expect(after.storageVersion).toBe(4);
    expect(meaning(after)).toEqual(meaning(before));
    expect(after.rawContent).toEqual(before.rawContent);
    expect(
      store.db.all(
        "SELECT id, uncertain_fields FROM records WHERE id IN ('w-done','w-on-wire') ORDER BY id",
      ),
    ).toEqual([
      { id: "w-done", uncertain_fields: '["initialPlan"]' },
      { id: "w-on-wire", uncertain_fields: '["initialPlan"]' },
    ]);
    expect(after.submissions).toEqual(before.submissions);
    expect(store.get("workout_set", "s-2")?.content).not.toHaveProperty("repsInReserve");
    expect(store.get("workout", "w-done")).toMatchObject({
      status: "partial",
      partialFields: ["initialPlan"],
      content: { initialPlan: plan },
    });
    expect(store.summary()).toMatchObject({ conflict: 1, invalid: 1, partial: 1 });
    expect(store.summary().inFlight).toBeGreaterThan(0);
    const baseline = store.get("workout_set", "s-1")?.server;
    if (!baseline?.content) throw new Error("Missing historical server copy");
    store.setNegotiated("1.1", [], "lineage-1");
    store.applyPull(
      [
        {
          kind: "workout_set",
          id: "s-1",
          state: "live",
          revision: baseline.revision,
          content: { ...baseline.content, planSlot: null },
        },
      ],
      baseline.revision,
      { cursor: 0, lineage: "lineage-1", release: "1.1", lastPage: true },
    );
    expect(store.get("workout_set", "s-1")).toMatchObject({
      status: "conflict",
      content: { planSlot: { exercise: 0, set: 1 } },
      server: { content: { planSlot: null } },
    });
  } finally {
    store.close();
  }
  expect(await failure(openWith(path, previous, "previous"))).toBeInstanceOf(StorageTooNewError);
  expect(meaning(readDeviceFile(snapshotPath(path, 2)))).toEqual(meaning(before));
});
