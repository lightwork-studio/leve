import type { Change, JsonObject } from "@leve/contract";
import initSqlJs from "sql.js";
import { afterAll, describe, expect, it } from "vitest";
import { type DeviceStore, openDeviceStore } from "../src/device-store.ts";
import { createSqlJsEngine } from "../src/sqljs.ts";
import { OLD_APP, removeTempDirs } from "../src/test-support/fixtures.ts";
import { fixtureContract } from "../src/test-support/versions.ts";
import { openPhone } from "./helpers.ts";

// Listing reads the whole list in a few queries. These tests pin what it returns (written out by
// hand) and that the number of queries doesn't grow with the number of records, on the phones'
// engine family (node:sqlite here) and the browser's (sql.js).

const SQL = await initSqlJs();
let browserStores = 0;
const engines = {
  "node:sqlite": async () => (await openPhone()).store,
  "sql.js": () =>
    openDeviceStore({
      engine: createSqlJsEngine(SQL),
      path: `/leve/list-${++browserStores}.db`,
      appVersion: OLD_APP,
      contract: fixtureContract,
      now: () => "2026-11-10T08:00:00.000Z",
    }),
};

afterAll(removeTempDirs);

const T = "2026-11-10T08:00:00.000Z";
const workout: JsonObject = {
  title: "Push",
  startedAt: T,
  endedAt: T,
  routineId: null,
};
const entry = (workoutId: string, position = 1): JsonObject => ({
  workoutId,
  exerciseId: "barbell-bench-press",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position,
  supersetId: null,
  restSeconds: 120,
  doubleDumbbellVolume: false,
});
const set = (workoutExerciseId: string, position: number): JsonObject => ({
  workoutExerciseId,
  position,
  type: "normal",
  weightKg: 100,
  reps: 5,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
});

/** Counts the queries a call makes. */
function queries(store: DeviceStore, run: () => void): number {
  const { db } = store;
  const all = db.all.bind(db);
  const get = db.get.bind(db);
  let count = 0;
  db.all = (...args) => {
    count += 1;
    return all(...args);
  };
  db.get = (...args) => {
    count += 1;
    return get(...args);
  };
  try {
    run();
  } finally {
    db.all = all;
    db.get = get;
  }
  return count;
}

describe.each(Object.entries(engines))("on %s", (_name, open) => {
  it("hides records under a deleted or unavailable ancestor and shows those under a missing one", async () => {
    const store = await open();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-live", revision: 1, content: workout },
        { state: "deleted", kind: "workout", id: "w-deleted", revision: 2 },
        { state: "unavailable", kind: "workout", id: "w-new", revision: 3 },
        ...["w-live", "w-deleted", "w-new", "w-never-received"].map(
          (workoutId, i) =>
            ({
              state: "live",
              kind: "workout_exercise",
              id: `e-${workoutId}`,
              revision: 10 + i,
              content: entry(workoutId),
            }) as const,
        ),
        ...["w-live", "w-deleted", "w-new", "w-never-received"].map(
          (workoutId, i) =>
            ({
              state: "live",
              kind: "workout_set",
              id: `s-${workoutId}`,
              revision: 20 + i,
              content: set(`e-${workoutId}`, 1),
            }) as const,
        ),
      ],
      30,
    );
    // A local set under a live entry, and a locally deleted entry hiding its set.
    store.put("workout_exercise", "e-local", entry("w-live", 2));
    store.put("workout_set", "s-local", set("e-local", 1));
    store.put("workout_set", "s-under-removed", set("e-w-live", 2));
    store.put("workout_exercise", "e-removed", entry("w-live", 3));
    store.put("workout_set", "s-removed", set("e-removed", 1));
    store.delete("workout_exercise", "e-removed");

    expect(store.list("workout_set").map((r) => r.id)).toEqual([
      "s-local",
      "s-w-live",
      "s-w-never-received",
      "s-under-removed",
    ]);
    expect(store.list("workout_exercise").map((r) => r.id)).toEqual([
      "e-w-live",
      "e-w-never-received",
      "e-local",
    ]);
    expect(store.list("workout_set", { parentId: "e-w-live" }).map((r) => r.id)).toEqual([
      "s-w-live",
      "s-under-removed",
    ]);
    // Each listed record reads exactly as it does on its own, including whether it is uploading.
    store.prepareSubmissions("1.0");
    for (const kind of ["workout", "workout_exercise", "workout_set"]) {
      for (const record of store.list(kind)) expect(record).toEqual(store.get(kind, record.id));
    }
    expect(store.list("workout_set").some((r) => r.inFlight)).toBe(true);
    store.close();
  });

  it("lists in a few queries however many records and parents there are", {
    timeout: 60_000,
  }, async () => {
    const store = await open();
    let revision = 0;
    // Received from a server in one go, which is one transaction rather than one per record.
    const add = (workouts: number) => {
      const before = store.list("workout").length;
      const changes: Change[] = [];
      const live = (kind: string, id: string, content: JsonObject) =>
        changes.push({ state: "live", kind, id, revision: ++revision, content });
      for (let w = before; w < before + workouts; w++) {
        live("workout", `w-${w}`, workout);
        for (let e = 0; e < 3; e++) {
          live("workout_exercise", `e-${w}-${e}`, entry(`w-${w}`, e + 1));
          for (let s = 0; s < 3; s++)
            live("workout_set", `s-${w}-${e}-${s}`, set(`e-${w}-${e}`, s + 1));
        }
      }
      store.applyPull(changes, revision);
    };
    add(2);
    const few = queries(store, () => store.list("workout_set"));
    // Hundreds of parents more: still one query per ancestor level.
    add(200);
    let listed = 0;
    const many = queries(store, () => {
      listed = store.list("workout_set").length;
    });
    expect(listed).toBe(202 * 9);
    expect(few).toBeLessThanOrEqual(4);
    // The same queries for 18 sets as for 1818: nothing per record or per parent.
    expect(many).toBe(few);
    store.close();
  });

  it("lists the children of several parents at once, as one parent at a time would", async () => {
    const store = await open();
    store.put("workout", "w-1", workout);
    store.put("workout_exercise", "e-1", entry("w-1", 1));
    store.put("workout_exercise", "e-2", entry("w-1", 2));
    store.put("workout_exercise", "e-gone", entry("w-1", 3));
    store.put("workout_set", "s-1b", set("e-1", 2));
    store.put("workout_set", "s-1a", set("e-1", 1));
    store.put("workout_set", "s-2a", set("e-2", 1));
    store.put("workout_set", "s-gone", set("e-gone", 1));
    store.delete("workout_exercise", "e-gone");
    const ids = (parentIds: string[]) => store.list("workout_set", { parentIds }).map((r) => r.id);
    // Position order across all of them, hidden children left out, repeated ids read once.
    expect(ids(["e-1", "e-2", "e-gone", "e-1"])).toEqual(["s-1a", "s-2a", "s-1b"]);
    expect(ids(["e-2"])).toEqual(["s-2a"]);
    expect(ids([])).toEqual([]);
    store.close();
  });

  it("finds the running workout from its shown copy, however many are finished", async () => {
    const store = await open();
    const running = { ...workout, endedAt: null };
    store.applyPull(
      [
        // Running on the server, finished here: finished.
        { state: "live", kind: "workout", id: "w-a", revision: 1, content: running },
        // Finished on the server, resumed here: running.
        { state: "live", kind: "workout", id: "w-b", revision: 2, content: workout },
        // Running, but deleted here.
        { state: "live", kind: "workout", id: "w-c", revision: 3, content: running },
        ...Array.from({ length: 300 }, (_, i) => ({
          state: "live" as const,
          kind: "workout",
          id: `w-done-${i}`,
          revision: 10 + i,
          content: workout,
        })),
      ],
      400,
    );
    store.put("workout", "w-a", workout);
    store.delete("workout", "w-c");
    expect(store.activeWorkout()?.id).toBeUndefined();
    store.put("workout", "w-b", running);
    expect(store.activeWorkout()).toEqual(store.get("workout", "w-b"));

    // Only the unfinished ones are read, not the 300 finished ones.
    const { db } = store;
    const all = db.all.bind(db);
    let rows = 0;
    db.all = (...args) => {
      const result = all(...args);
      rows += result.length;
      return result;
    };
    store.activeWorkout();
    db.all = all;
    expect(rows).toBeLessThan(10);
    store.close();
  });
  it("stops looking for a hidden ancestor after 8 levels, however the walk is shared", async () => {
    const store = await open();
    // A chain c0 ← c1 ← … ← c11 written straight into the table (real kinds nest at most 3 deep),
    // with c0 deleted. Each record looks at itself and 7 ancestors, so c0 hides c0 to c7 only.
    for (let i = 0; i < 12; i++) {
      store.db.run(
        `INSERT INTO records (kind, id, parent_kind, parent_id, server_revision, server_state,
         server_content, local_state, local_content, local_base, local_seq, status, problem,
         problem_revision, problem_at, partial_fields, reoffered, kept_content, seen_on_server,
         updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, 0, 'synced', NULL, NULL, NULL,
         NULL, 0, NULL, 0, 't')`,
        [
          "workout_set",
          `c${i}`,
          i === 0 ? null : "workout_set",
          i === 0 ? null : `c${i - 1}`,
          i === 0 ? "deleted" : "live",
          i === 0 ? null : JSON.stringify({ position: i }),
        ],
      );
    }
    // Listed in id order (c1, c10, c11, c2 …), so deep records meet ancestors cached from shallow ones.
    expect(store.list("workout_set").map((r) => r.id)).toEqual(["c8", "c9", "c10", "c11"]);
    store.close();
  });
});
