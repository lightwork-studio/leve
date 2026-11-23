// Test-only helpers shared by the storage tests and the crash child process. Production code never
// imports this directory. It must not import vitest, because the crash child runs it under plain Node.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Change, Contract, JsonObject, ReleaseId, SubmissionResult } from "@leve/contract";
import { deviceStorageDefinition } from "../device-schema.ts";
import { type DeviceStore, openDeviceStore } from "../device-store.ts";
import type { SqlConnection, SqlEngine } from "../driver.ts";
import { createNodeSqliteEngine } from "../node-sqlite.ts";
import { openStorage, type StorageDefinition } from "../upgrade.ts";
import {
  deviceV1,
  deviceV2,
  deviceV2Corrupting,
  deviceV3,
  fixtureContract,
  historicalContract,
  release10,
} from "./versions.ts";

/**
 * The default test engine copies one page per backup step, so every page of a snapshot or restore
 * is a crash point, and keeps a tiny page cache, so SQLite writes to the database file before a
 * transaction commits and a crash leaves a journal that has to be rolled back. The "large" engine,
 * for fixtures of several megabytes, copies 64 pages per step to stay fast.
 */
export function testEngine(kind: string | undefined): SqlEngine {
  return kind === "large"
    ? createNodeSqliteEngine({ backupPagesPerStep: 64, cacheSizePages: 32 })
    : createNodeSqliteEngine({ backupPagesPerStep: 1, cacheSizePages: 8 });
}

/** Crash children pick their engine through LEVE_TEST_ENGINE, set by the parent test. */
export const engine: SqlEngine = testEngine(process.env.LEVE_TEST_ENGINE);
export const largeEngine: SqlEngine = testEngine("large");

const created: string[] = [];

/** A new, disposable directory for test databases. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leve-storage-"));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Definitions the crash child can open, by name. */
export const definitions: Record<string, StorageDefinition> = {
  "device-v1": deviceV1,
  "device-previous-preview": deviceStorageDefinition({ contract: historicalContract("2.0") }),
  "device-current": deviceStorageDefinition({ contract: fixtureContract }),
  "device-v2": deviceV2,
  "device-v2-corrupting": deviceV2Corrupting,
  "device-v3": deviceV3,
};

/** What server restores in these tests name the restored history and when they run. */
export const RESTORED_LINEAGE = "lineage-restored";
export const RESTORE_TIME = "2026-11-10T09:00:00.000Z";

export const OLD_APP = "0.1.0";
export const NEW_APP = "0.2.0";

export async function openWith(
  path: string,
  definition: StorageDefinition,
  appVersion: string,
  onEngine: SqlEngine = engine,
): Promise<void> {
  const opened = await openStorage({ engine: onEngine, path, definition, appVersion });
  opened.db.close();
}

/* ---------- the version-1 device fixture ---------- */

export const PHASE_TIMES = {
  created: "2026-11-10T08:00:00.000Z",
  pulled: "2026-11-10T08:05:00.000Z",
  answered: "2026-11-10T08:10:00.000Z",
  dispatched: "2026-11-10T08:15:00.000Z",
  edited: "2026-11-10T08:20:00.000Z",
} as const;

const RELEASE: ReleaseId = "1.0";

const exercise = (fields: JsonObject): JsonObject => ({
  supersetId: null,
  notes: [],
  doubleDumbbellVolume: false,
  ...fields,
});

const set = (fields: JsonObject): JsonObject => ({
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  ...fields,
});

const routineSet = (fields: JsonObject): JsonObject => ({
  weightKg: null,
  reps: null,
  repRangeMin: null,
  repRangeMax: null,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  ...fields,
});

/** Records the device creates and syncs first, with the revision the server gives each. */
const INITIAL: { kind: string; id: string; revision: number; content: JsonObject }[] = [
  {
    kind: "workout",
    id: "w-done",
    revision: 1,
    content: {
      title: "Push day",
      description: "Bench focus",
      startedAt: "2026-11-09T17:00:00.000Z",
      endedAt: "2026-11-09T18:05:30.000Z",
      routineId: "r-1",
    },
  },
  {
    kind: "workout_exercise",
    id: "e-bench",
    revision: 2,
    content: exercise({
      workoutId: "w-done",
      exerciseId: "barbell-bench-press",
      exerciseName: "Bench Press",
      exerciseType: "weight_reps",
      position: 1,
      restSeconds: 120,
      notes: [{ id: "n-1", text: "Elbows tucked", createdAt: "2026-11-09T17:02:00.000Z" }],
    }),
  },
  {
    kind: "workout_exercise",
    id: "e-row",
    revision: 3,
    content: exercise({
      workoutId: "w-done",
      exerciseId: "dumbbell-row",
      exerciseName: "Dumbbell Row",
      exerciseType: "weight_reps",
      position: 2,
      supersetId: 1,
      restSeconds: 90,
      doubleDumbbellVolume: true,
    }),
  },
  {
    kind: "workout_set",
    id: "s-1",
    revision: 4,
    content: set({
      workoutExerciseId: "e-bench",
      position: 1,
      type: "warmup",
      weightKg: 60,
      reps: 10,
      completedAt: "2026-11-09T17:05:00.000Z",
    }),
  },
  {
    kind: "workout_set",
    id: "s-2",
    revision: 5,
    content: set({
      workoutExerciseId: "e-bench",
      position: 2,
      type: "normal",
      weightKg: 102.05,
      reps: 5,
      rpe: 8.5,
      completedAt: "2026-11-09T17:10:00.000Z",
    }),
  },
  {
    kind: "workout_set",
    id: "s-3",
    revision: 6,
    content: set({
      workoutExerciseId: "e-bench",
      position: 1.5,
      type: "failure",
      weightKg: 0,
      reps: 0,
      completedAt: null,
    }),
  },
  {
    kind: "settings",
    id: "settings",
    revision: 7,
    content: {
      weightUnit: "lbs",
      distanceUnit: "miles",
      shortDistanceUnit: "yd",
      measurementUnit: "in",
      firstWeekday: 1,
      defaultRestSeconds: 90,
      rpeEnabled: true,
      countWarmups: false,
      previousValues: "same_routine",
      autoUpdateRoutineValues: false,
    },
  },
  {
    kind: "body_measurement",
    id: "bm-1",
    revision: 8,
    content: { takenAt: "2026-11-08T07:30:00.000Z", bodyweightKg: 81.25, fatPercent: null },
  },
  {
    kind: "custom_exercise",
    id: "cx-1",
    revision: 9,
    content: {
      name: "Landmine Press",
      type: "weight_reps",
      primaryMuscle: "shoulders",
      secondaryMuscles: ["chest", "triceps"],
      equipment: "barbell",
      usesBodyweight: false,
      archived: false,
    },
  },
  {
    kind: "routine",
    id: "r-old",
    revision: 10,
    content: { title: "Old split", notes: "", folderId: null, position: 2, exercises: [] },
  },
  {
    kind: "routine",
    id: "r-1",
    revision: 11,
    content: {
      title: "Push A",
      notes: "Heavy week",
      folderId: null,
      position: 1,
      exercises: [
        {
          id: "re-1",
          exerciseId: "barbell-bench-press",
          exerciseName: "Bench Press",
          exerciseType: "weight_reps",
          supersetId: null,
          restSeconds: 120,
          notes: [],
          useRepRange: true,
          sets: [
            routineSet({
              id: "rs-1",
              type: "warmup",
              weightKg: 60,
              repRangeMin: 8,
              repRangeMax: 12,
            }),
            routineSet({
              id: "rs-2",
              type: "normal",
              weightKg: 100,
              repRangeMin: 3,
              repRangeMax: 5,
              rpe: 9,
            }),
          ],
        },
        {
          id: "re-2",
          exerciseId: "plank",
          exerciseName: "Plank",
          exerciseType: "duration",
          supersetId: null,
          restSeconds: 60,
          notes: [],
          useRepRange: false,
          sets: [routineSet({ id: "rs-3", type: "normal", durationSeconds: 60 })],
        },
      ],
    },
  },
];

interface FixtureDriver {
  store: DeviceStore;
  setTime(time: string): void;
  /** The id the next new submission gets. */
  nextSubmissionId(id: string): void;
}

async function openFixtureStore(
  path: string,
  onEngine: SqlEngine,
  contract: Contract = fixtureContract,
): Promise<FixtureDriver> {
  let time: string = PHASE_TIMES.created;
  const queued: string[] = [];
  let generated = 0;
  const store = await openDeviceStore({
    engine: onEngine,
    path,
    appVersion: OLD_APP,
    contract,
    definition: deviceV1,
    now: () => time,
    randomId: () => queued.shift() ?? `sub-gen-${++generated}`,
  });
  return {
    store,
    setTime: (next) => {
      time = next;
    },
    nextSubmissionId: (id) => queued.push(id),
  };
}

/** Sends exactly one newly pending record, so its submission gets the id the fixture chose. */
function dispatchOne(driver: FixtureDriver, submissionId: string): void {
  driver.nextSubmissionId(submissionId);
  const before = driver.store.summary().inFlight;
  driver.store.prepareSubmissions(RELEASE);
  if (driver.store.summary().inFlight !== before + 1) {
    throw new Error(`fixture: expected one new submission for ${submissionId}`);
  }
}

/**
 * Builds realistic version-1 device storage through the real DeviceStore API. The result holds
 * synced records, a pending edit, a pending deletion, in-flight puts (one with a newer local edit)
 * and an in-flight delete listing the descendant it knew, a conflict with the kept local version, a partially synced record, an invalid record,
 * a deletion marker from the server and a workout still in progress.
 */
export async function buildDeviceFixture(
  path: string,
  onEngine: SqlEngine = engine,
  release: "1.0" | "partial-rehearsal" = "partial-rehearsal",
): Promise<void> {
  const driver = await openFixtureStore(
    path,
    onEngine,
    release === "1.0" ? release10 : fixtureContract,
  );
  const { store } = driver;
  try {
    // 1. Recorded on the phone, then synced in one batch.
    driver.setTime(PHASE_TIMES.created);
    store.bindAccount("https://sync.example.test", "acct-1");
    store.setNegotiated(
      RELEASE,
      ["body_measurements", "custom_exercises", "routines", "rpe", "workouts"],
      "lineage-1",
    );
    for (const record of INITIAL) store.put(record.kind, record.id, record.content);
    const revisions = new Map(INITIAL.map((r) => [`${r.kind}/${r.id}`, r.revision]));
    const results: SubmissionResult[] = store.prepareSubmissions(RELEASE).map(({ submission }) => {
      const revision = revisions.get(`${submission.kind}/${submission.id}`);
      if (revision === undefined) throw new Error(`fixture: unexpected ${submission.id}`);
      return { status: "accepted", submissionId: submission.submissionId, revision };
    });
    if (results.length !== INITIAL.length) throw new Error("fixture: not every record was sent");
    store.applyPushResults(results);

    // 2. A downloaded page: a measurement and a set from another device, and a routine deleted
    //    elsewhere. The page is applied only because cursor and lineage are still as requested.
    driver.setTime(PHASE_TIMES.pulled);
    const pulled: Change[] = [
      {
        state: "live",
        kind: "body_measurement",
        id: "bm-2",
        revision: 12,
        content: { takenAt: "2026-11-10T07:00:00.000Z", bodyweightKg: 80.6, fatPercent: 17.3 },
      },
      { state: "deleted", kind: "routine", id: "r-old", revision: 13 },
      {
        state: "live",
        kind: "workout_set",
        id: "s-row",
        revision: 14,
        content: set({
          workoutExerciseId: "e-row",
          position: 1,
          type: "normal",
          weightKg: 32.5,
          reps: 12,
          completedAt: "2026-11-09T17:40:00.000Z",
        }),
      },
    ];
    if (!store.applyPull(pulled, 14, { cursor: 0, lineage: "lineage-1" })) {
      throw new Error("fixture: the downloaded page was dropped");
    }

    // 3. Edits answered by the server: partially synced, rejected as stale, rejected as invalid.
    driver.setTime(PHASE_TIMES.answered);
    store.put("workout", "w-done", {
      ...(INITIAL[0]?.content as JsonObject),
      ...(release === "1.0" ? { description: "Edited after finishing" } : { perceivedEffort: 8 }),
    });
    dispatchOne(driver, "sub-w-done");
    store.put("custom_exercise", "cx-1", {
      ...(INITIAL[8]?.content as JsonObject),
      name: "Landmine Press (single arm)",
      secondaryMuscles: ["triceps", "chest"],
    });
    dispatchOne(driver, "sub-cx-1");
    store.put("routine_folder", "f-1", { title: "Strength", position: 1 });
    dispatchOne(driver, "sub-f-1");
    store.applyPushResults([
      { status: "accepted", submissionId: "sub-w-done", revision: 16 },
      {
        status: "conflict",
        submissionId: "sub-cx-1",
        reason: "stale",
        current: {
          state: "live",
          kind: "custom_exercise",
          id: "cx-1",
          revision: 15,
          content: {
            name: "Landmine Press",
            type: "weight_reps",
            primaryMuscle: "shoulders",
            secondaryMuscles: ["chest", "triceps", "upper_back"],
            equipment: "plate",
            usesBodyweight: false,
            archived: false,
          },
        },
      },
      {
        status: "invalid",
        submissionId: "sub-f-1",
        code: "invalid_content",
        message: "title is not allowed",
      },
    ]);

    // 4. Uploads sent but not yet answered, including a workout started just now.
    driver.setTime(PHASE_TIMES.dispatched);
    store.put("body_measurement", "bm-1", {
      takenAt: "2026-11-08T07:30:00.000Z",
      bodyweightKg: 80.9,
      fatPercent: null,
    });
    dispatchOne(driver, "sub-bm-1");
    const live = {
      title: "Leg day",
      description: "",
      startedAt: "2026-11-10T08:12:00.000Z",
      endedAt: null,
      routineId: null,
    };
    store.put("workout", "w-live", live);
    dispatchOne(driver, "sub-w-live");
    store.put(
      "workout_exercise",
      "e-live",
      exercise({
        workoutId: "w-live",
        exerciseId: "barbell-squat",
        exerciseName: "Squat",
        exerciseType: "weight_reps",
        position: 1,
        restSeconds: 180,
      }),
    );
    dispatchOne(driver, "sub-e-live");
    store.put(
      "workout_set",
      "s-live",
      set({
        workoutExerciseId: "e-live",
        position: 1,
        type: "normal",
        weightKg: 140,
        reps: 3,
        completedAt: null,
      }),
    );
    dispatchOne(driver, "sub-s-live");
    store.delete("workout_exercise", "e-row");
    dispatchOne(driver, "sub-e-row");

    // 5. Edits made while those uploads are in flight; they stay pending.
    driver.setTime(PHASE_TIMES.edited);
    store.put("workout", "w-live", { ...live, title: "Leg day (heavy)" });
    store.put("workout_set", "s-2", { ...(INITIAL[4]?.content as JsonObject), reps: 6 });
    store.delete("workout_set", "s-3");
  } finally {
    store.close();
  }
}

async function copyDatabase(from: string, to: string, onEngine: SqlEngine): Promise<void> {
  const source = onEngine.open(from, { readOnly: true });
  try {
    await onEngine.backup(source, to);
  } finally {
    source.close();
  }
}

let template: Promise<string> | undefined;

/**
 * A copy of the device fixture. It is built once per process with `buildDeviceFixture` and then
 * copied with SQLite's backup, which keeps every row as it is.
 */
export async function createDeviceFixture(path: string): Promise<void> {
  template ??= (async () => {
    const built = join(tempDir(), "template.db");
    await buildDeviceFixture(built);
    return built;
  })();
  await copyDatabase(await template, path, engine);
}

let largeTemplate: Promise<string> | undefined;

/**
 * The device fixture plus enough synced content to be larger than SQLite's page cache, so that big
 * writes spill to the database file before they commit. Built once per process, then copied with
 * SQLite's backup.
 */
export async function createLargeDeviceFixture(path: string): Promise<void> {
  largeTemplate ??= (async () => {
    const built = join(tempDir(), "large-template.db");
    await buildDeviceFixture(built, largeEngine);
    const driver = await openFixtureStore(built, largeEngine);
    try {
      driver.setTime(PHASE_TIMES.edited);
      const changes: Change[] = [];
      for (let i = 0; i < 800; i++) {
        changes.push({
          state: "live",
          kind: "workout_exercise",
          id: `e-bulk-${String(i).padStart(4, "0")}`,
          revision: 100 + i,
          content: exercise({
            workoutId: "w-done",
            exerciseId: "barbell-curl",
            exerciseName: "Barbell Curl",
            exerciseType: "weight_reps",
            position: 10 + i,
            restSeconds: 60,
            notes: [{ id: `n-${i}`, text: "x".repeat(4000), createdAt: PHASE_TIMES.edited }],
          }),
        });
      }
      driver.store.applyPull(changes, 899);
    } finally {
      driver.store.close();
    }
    return built;
  })();
  await copyDatabase(await largeTemplate, path, largeEngine);
}

/* ---------- inspecting files ---------- */

/** True when a read-only connection cannot read the file until SQLite rolls back a journal. */
export function needsRollback(path: string, onEngine: SqlEngine = engine): boolean {
  try {
    const db = onEngine.open(path, { readOnly: true });
    try {
      db.get("SELECT count(*) AS n FROM sqlite_master");
    } finally {
      db.close();
    }
    return false;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 776) return true;
    throw error;
  }
}

/** Every table's rows in a stable order, including the fixed metadata. */
export function dumpTables(db: SqlConnection): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  for (const { name } of tables) {
    if (typeof name !== "string" || name.startsWith("sqlite_")) continue;
    const columns = db.all(`PRAGMA table_info("${name}")`).map((_, i) => String(i + 1));
    dump[name] = db
      .all(`SELECT * FROM "${name}" ORDER BY ${columns.join(", ")}`)
      .map((row) => ({ ...row }));
  }
  return dump;
}

export function dumpFile(path: string, onEngine: SqlEngine = engine): Record<string, unknown[]> {
  const db = onEngine.open(path, { readOnly: true });
  try {
    return dumpTables(db);
  } finally {
    db.close();
  }
}

/** Table definitions, to show that a file still has the layout a build expects. */
export function schemaOf(path: string): string[] {
  const db = engine.open(path, { readOnly: true });
  try {
    return db
      .all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .map((row) => `${String(row.type)} ${String(row.name)}: ${String(row.sql)}`);
  } finally {
    db.close();
  }
}

/**
 * A digest of every file in a directory. Shared-memory files (`-shm`) are disposable lock
 * bookkeeping that read-only SQLite readers may update, so they are left out.
 */
export function durableFiles(dir: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith("-shm")) continue;
    state[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return state;
}

/** Writes the fixed metadata as a newer build would have, closing cleanly afterwards. */
export function markAsNewer(path: string, version: number, appVersion: string): void {
  const db = engine.open(path);
  try {
    db.run("UPDATE storage_meta SET storage_version = ?, app_version = ? WHERE id = 1", [
      version,
      appVersion,
    ]);
  } finally {
    db.close();
  }
}

/* ---------- crash child ---------- */

const crashChild = fileURLToPath(new URL("./crash-child.ts", import.meta.url));
let compileCache: string | undefined;

export interface ChildOutcome {
  signal: string | null;
  output: string;
}

/**
 * Runs `crash-child.ts` in a separate Node process, which kills itself with SIGKILL when it reaches
 * the chosen point. Resolves with the signal that ended it (null if it finished) and its output.
 */
export function runCrashChild(
  args: { path: string; mode: string; point?: string; count?: number },
  engineKind?: "large",
): Promise<ChildOutcome> {
  compileCache ??= tempDir();
  const cache = compileCache;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--no-warnings",
        crashChild,
        args.path,
        args.mode,
        args.point ?? "-",
        String(args.count ?? 0),
      ],
      {
        timeout: 60_000,
        env: {
          ...process.env,
          LEVE_TEST_ENGINE: engineKind ?? "",
          // Children share compiled modules, which roughly halves their start-up time.
          NODE_COMPILE_CACHE: cache,
        },
      },
      (error, stdout, stderr) => {
        const signal = (error as { signal?: string } | null)?.signal ?? null;
        resolve({ signal, output: `${stdout}${stderr}` });
      },
    );
  });
}
