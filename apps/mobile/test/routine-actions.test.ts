import type { JsonObject } from "@leve/contract";
import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { World } from "../../../packages/sync/test/support/harness.ts";
import { liveData, readSettings, workoutDetail } from "../src/data/read.ts";
import { createRoutine, type PlannedExercise, writePlan } from "../src/data/routine-actions.ts";
import { routineFromWorkout } from "../src/data/routine-from-workout.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  finishWorkout,
  logSet,
  removeWorkoutSet,
  updateSet,
} from "../src/data/workout-actions.ts";
import { routineTarget } from "../src/model/live.ts";
import { targetValue } from "../src/model/log-values.ts";
import { leaveSuperset, pairWithPrevious } from "../src/model/supersets.ts";

const SQL = await initSqlJs();
const plan: [PlannedExercise, PlannedExercise] = [
  {
    id: "entry-1",
    exercise: { id: "run", name: "Run", type: "distance_duration" },
    sets: [{ id: "set-1", values: { distance: "3", duration: "25:30" } }],
  },
  {
    id: "entry-2",
    exercise: { id: "stairs", name: "Stairs", type: "steps_duration" },
    sets: [{ id: "set-2", values: { count: "200", duration: "4:00" } }],
  },
];

it("reopens a user-created routine and starts its ordered plan, retaining imperial distance and step targets", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/plan.db", appVersion: "test" });
  let store = await open();
  store.put("routine_folder", "folder", { title: "Cardio", position: 1 });
  const settings = {
    ...readSettings(store),
    distanceUnit: "miles" as const,
    defaultRestSeconds: 90,
  };
  const id = createRoutine(store, "  Run and stairs ", "folder", plan, settings);
  store.close();
  store = await open();
  expect(store.get("routine", id)?.content).toMatchObject({
    title: "Run and stairs",
    folderId: "folder",
    exercises: [
      {
        exerciseId: "run",
        restSeconds: 90,
        sets: [{ distanceMeters: expect.closeTo(4828.02, 8), durationSeconds: 1530 }],
      },
      { exerciseId: "stairs", sets: [{ count: 200, durationSeconds: 240 }] },
    ],
  });
  expect(store.prepareSubmissions("1.0").some((item) => item.submission.id === id)).toBe(true);
  beginWorkout(store, id);
  const live = liveData(store);
  expect(live?.tree.entries.map((e) => e.entry.content.exerciseName)).toEqual(["Run", "Stairs"]);
  expect(targetValue(live?.initialPlan?.exercises[1]?.sets[0], "count")).toBe(200);
  store.close();
});

it("keeps an invalid draft out of the store and outbox", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/invalid.db",
    appVersion: "test",
  });
  const settings = readSettings(store);
  expect(() => createRoutine(store, " ", null, plan, settings)).toThrow(/name/);
  expect(() => createRoutine(store, "A", null, [], settings)).toThrow(/exercise/);
  expect(() => createRoutine(store, "A", "removed", plan, settings)).toThrow(/folder/);
  expect(() =>
    createRoutine(
      store,
      "A",
      null,
      [{ ...plan[0], sets: [{ id: "s", values: { distance: "oops" } }] }],
      settings,
    ),
  ).toThrow(/distance/);
  expect(store.list("routine")).toEqual([]);
  expect(store.prepareSubmissions("1.0")).toEqual([]);
  store.close();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected workout fixture data");
  return value;
}

it("keeps A's targets through a template edit, restart and finish, then starts B from the edited plan", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/snapshot.db", appVersion: "test" });
  let store = await open();
  const movement = { id: "press", name: "Press", type: "weight_reps" as const };
  const routine = createRoutine(
    store,
    "First plan",
    null,
    [
      {
        id: "first",
        exercise: movement,
        sets: [
          { id: "s1", values: { weight: "10", reps: "8" } },
          { id: "s2", values: { weight: "20", reps: "6" } },
        ],
      },
      {
        id: "second",
        exercise: movement,
        sets: [{ id: "s3", values: { weight: "30", reps: "4" } }],
      },
    ],
    { ...readSettings(store), weightUnit: "kg" },
  );
  const a = beginWorkout(store, routine);
  const original = required(store.get("routine", routine)?.content);
  const [first, second] = original.exercises as JsonObject[];
  store.put("routine", routine, {
    ...original,
    title: "Later plan",
    exercises: [required(second), { ...first, sets: [] }],
  });
  store.close();
  store = await open();
  const live = required(liveData(store));
  expect(live.tree.workout.id).toBe(a);
  const [left, right] = live.tree.entries;
  removeWorkoutSet(store, required(left?.sets[0]).id);
  const retained = required(left?.sets[1]);
  updateSet(store, retained.id, { position: 7, weightKg: 19 });
  const added = addSet(store, required(left).entry.id);
  const reread = required(liveData(store));
  const targets = reread.tree.entries.flatMap((e) =>
    e.sets.map((s) => routineTarget(reread.initialPlan, s.content)?.weightKg),
  );
  expect(targets).toEqual([20, undefined, 30]);
  expect(reread.tree.entries[0]?.sets[1]?.id).toBe(added);
  logSet(store, retained.id, { weightKg: 19, reps: 5 });
  logSet(store, required(right?.sets[0]).id, { weightKg: 28, reps: 3 });
  finishWorkout(store, a, { title: "Actual session", countForRoutine: true });
  const b = beginWorkout(store, routine);
  store.delete("routine", routine);
  store.close();
  store = await open();
  const historical = required(workoutDetail(store, a));
  expect(historical.routineTitle).toBe("First plan");
  expect(
    historical.tree.workout.content.initialPlan?.exercises.map((e) =>
      e.sets.map((s) => s.weightKg),
    ),
  ).toEqual([[10, 20], [30]]);
  expect(
    historical.tree.entries.flatMap((e) => e.sets.map((s) => [s.content.weightKg, s.content.reps])),
  ).toEqual([
    [19, 5],
    [28, 3],
  ]);
  expect(liveData(store)?.tree.workout.id).toBe(b);
  expect(liveData(store)?.initialPlan).toMatchObject({
    title: "Later plan",
    exercises: [{ sets: [{ weightKg: 30 }] }, { sets: [] }],
  });
  store.close();
});

it("shows stored legacy rows and logged values with unknown original targets and source title", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/legacy.db",
    appVersion: "test",
  });
  const routine = createRoutine(store, "Changed", null, plan, readSettings(store));
  const a = beginWorkout(store, routine);
  const tree = required(liveData(store)).tree;
  const first = required(tree.entries[0]?.sets[0]);
  logSet(store, first.id, { distanceMeters: 123, durationSeconds: 45 });
  // Actual 1.0 JSON has no metadata keys, including on rows still pending upload.
  store.db.run(
    "UPDATE records SET local_content=json_remove(local_content,'$.initialPlan','$.planSlot') WHERE kind IN ('workout','workout_set')",
  );
  const legacy = required(liveData(store));
  expect(legacy.initialPlan).toBeNull();
  expect(legacy.tree.entries.flatMap((e) => e.sets.map((s) => s.id))).toEqual(
    tree.entries.flatMap((e) => e.sets.map((s) => s.id)),
  );
  expect(required(legacy.tree.entries[0]?.sets[0]).content).toMatchObject({
    distanceMeters: 123,
    durationSeconds: 45,
  });
  expect(
    routineTarget(legacy.initialPlan, required(legacy.tree.entries[0]?.sets[0]).content),
  ).toBeUndefined();
  expect(workoutDetail(store, a)?.routineTitle).toBeNull();
  store.close();
});

it("refuses incomplete or disputed sources and preserves unavailable measurements when copying a workout", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/session-draft",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    expect(routineFromWorkout(store, workout)).toEqual({
      error: "Choose a completed workout from History.",
    });
    const entry = addExercise(
      store,
      workout,
      { id: "imported", name: "Carry", type: "weight_distance" },
      75,
    );
    const record = store.list("workout_set", { parentId: entry })[0];
    if (!record) throw Error("Missing set");
    logSet(store, record.id, { weightKg: 32, distanceMeters: null });
    finishWorkout(store, workout, { countForRoutine: false });
    const draft = routineFromWorkout(store, workout);
    if (!("plan" in draft)) throw Error("Missing routine draft");
    const target = writePlan(draft.plan, readSettings(store))[0]?.sets[0];
    expect(target).toMatchObject({ weightKg: 32, distanceMeters: null, reps: null });
    const submission = store
      .prepareSubmissions("1.0")
      .find(({ submission }) => submission.id === record.id);
    if (!submission) throw Error("Missing set submission");
    store.applyPushResults([
      {
        status: "invalid",
        submissionId: submission.submission.submissionId,
        code: "invalid_content",
        message: "Needs correction",
      },
    ]);
    expect(routineFromWorkout(store, workout)).toEqual({
      error: "Resolve this workout’s sync issues before copying its sets.",
    });
    expect(store.list("routine")).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("copies only targets the saved movement can use and preserves mixed source measurements", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/mixed-session-draft",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const actual = {
      weightKg: 10,
      reps: 7,
      durationSeconds: 45,
      distanceMeters: 30,
      count: 4,
      rpe: 8,
    };
    const expected = [
      ["duration", [null, null, 45, null, null, null]],
      ["bodyweight_reps", [null, 7, null, null, null, 8]],
      ["steps_duration", [null, null, 45, null, 4, null]],
      ["weight_distance", [10, null, null, 30, null, null]],
    ] as const;
    const originalIds: string[] = [];
    for (const [type] of expected) {
      const entry = addExercise(store, workout, { id: type, name: type, type }, 60);
      const set = store.list("workout_set", { parentId: entry })[0];
      if (!set) throw Error("Missing set");
      logSet(store, set.id, actual);
      originalIds.push(set.id);
    }
    finishWorkout(store, workout, { countForRoutine: false });
    const draft = routineFromWorkout(store, workout);
    if (!("plan" in draft)) throw Error("Missing routine draft");
    const stored = writePlan(draft.plan, readSettings(store));
    expect(
      stored.map(({ sets }) => {
        const target = sets[0];
        if (!target) throw Error("Missing target");
        return [
          target.weightKg,
          target.reps,
          target.durationSeconds,
          target.distanceMeters,
          target.count,
          target.rpe,
        ];
      }),
    ).toEqual(expected.map(([, targets]) => targets));
    for (const id of originalIds)
      expect(store.get("workout_set", id)?.content).toMatchObject(actual);
  } finally {
    store.close();
  }
});

it.each(["1.0", "2.0"] as const)(
  "syncs a new superset and starts the same grouped workout on release %s",
  async (release) => {
    const world = new World(release === "2.0" ? previewContract : undefined);
    try {
      const server = world.server({ releases: [release] });
      const account = { server: "s", account: "lifter", transport: server.transport("lifter") };
      const writer = await world.phone("writer", account);
      const reader = await world.phone("reader", account);
      const source = [
        { ...plan[0], supersetId: 0 },
        { ...plan[1], supersetId: 0 },
        { ...plan[0], id: "row", supersetId: null },
        { ...plan[1], id: "pull", supersetId: null },
        { ...plan[0], id: "carry", supersetId: null },
      ];
      const pair = pairWithPrevious(source, "row", "pull");
      const triple = pairWithPrevious(pair, "pull", "carry");
      const finished = leaveSuperset(triple, "pull");
      const id = createRoutine(
        writer.store,
        "Paired session",
        null,
        finished,
        readSettings(writer.store),
      );
      await writer.restart();
      await writer.sync();
      await reader.sync();
      await reader.restart();
      expect(reader.store.get("routine", id)?.content?.exercises).toMatchObject([
        { supersetId: 0 },
        { supersetId: 0 },
        { supersetId: 1 },
        { supersetId: null },
        { supersetId: 1 },
      ]);
      const session = beginWorkout(reader.store, id);
      expect(
        reader.store
          .list("workout_exercise", { parentId: session })
          .map((e) => e.content?.supersetId),
      ).toEqual([0, 0, 1, null, 1]);
    } finally {
      await world.dispose();
    }
  },
);

it("adds a routine in no folder after the routines whose folder is gone", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/unfiled-add.db",
    appVersion: "test",
  });
  const settings = readSettings(store);
  store.put("routine_folder", "kept", { title: "Kept", position: 1 });
  const loose = createRoutine(store, "Loose", null, plan, settings);
  const orphan = createRoutine(store, "Orphan", "kept", plan, settings);
  // Filed far down its folder, which is then deleted: it joins the routines in no folder.
  const orphaned = store.get("routine", orphan)?.content;
  store.put("routine", orphan, { ...orphaned, position: 9 });
  store.delete("routine_folder", "kept");
  const added = createRoutine(store, "Added", null, plan, settings);
  expect(store.get("routine", loose)?.content?.position).toBe(1);
  expect(store.get("routine", added)?.content?.position).toBe(10);
  // A folder's own count starts again from 1.
  store.put("routine_folder", "new", { title: "New", position: 2 });
  const first = createRoutine(store, "First", "new", plan, settings);
  expect(store.get("routine", first)?.content?.position).toBe(1);
  store.close();
});
