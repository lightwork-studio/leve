import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it } from "vitest";
import { EXERCISES } from "../src/data/exercises.ts";
import {
  applyAppChange,
  historyData,
  lastTime,
  liveData,
  progressData,
  sharedProgress,
  workoutDetail,
} from "../src/data/read.ts";
import { seedSyntheticData } from "../src/data/seed.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  discardWorkout,
  finishWorkout,
  logSet,
  updateSet,
} from "../src/data/workout-actions.ts";
import { periodMuscleActivity, periodMuscleSets } from "../src/model/muscle-map.ts";

const SQL = await initSqlJs();

it("reads the whole history with a fixed number of store reads", { timeout: 60_000 }, async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/history.db",
    appVersion: "test",
  });
  seedSyntheticData(store, new Date(2026, 10, 12, 20));
  const reads: string[] = [];
  const counting = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "list" || key === "get") {
        return (...args: unknown[]) => {
          reads.push(String(key));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DeviceStore;
  const { months } = historyData(counting);
  expect(months.flatMap((m) => m.workouts)).toHaveLength(40);
  // Settings, measurements, custom exercises, and one read each for sets, entries and workouts.
  expect(reads.length).toBeLessThanOrEqual(6);
  store.close();
});

it("compares a routine workout with the routine's previous session", {
  timeout: 60_000,
}, async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/last-time.db",
    appVersion: "test",
  });
  seedSyntheticData(store, new Date(2026, 10, 12, 20));
  const push = store
    .list("workout")
    .filter((w) => w.content?.routineId === "seed-routine-push" && w.content?.endedAt !== null)
    .sort(
      (a, b) => Date.parse(String(a.content?.startedAt)) - Date.parse(String(b.content?.startedAt)),
    );
  const [first, second, third] = push;
  if (!first || !second || !third) throw new Error("the seed has fewer push sessions");
  // The session before the third is the second; before the first, there is none.
  expect(lastTime(store, third.id)?.id).toBe(second.id);
  expect(lastTime(store, second.id)?.id).toBe(first.id);
  expect(lastTime(store, first.id)).toBeNull();
  // A workout outside any routine has nothing to compare with, and an unfinished session of the
  // routine is never the one compared with.
  const free = beginWorkout(store);
  addExercise(store, free, EXERCISES.squat, 120);
  const [entry] = store.list("workout_exercise", { parentId: free });
  const [set] = store.list("workout_set", { parentId: entry?.id as string });
  logSet(store, set?.id as string, { weightKg: 100, reps: 5 });
  finishWorkout(store, free, { title: "", description: "", countForRoutine: true });
  expect(lastTime(store, free)).toBeNull();
  const open = beginWorkout(store, "seed-routine-push");
  // Started now, its previous session is the latest finished one.
  expect(lastTime(store, open)?.id).toBe(push.at(-1)?.id);
  discardWorkout(store, open);
  store.close();
});

it("keeps live sets out of history and progress until finish, then reflects saved corrections", {
  timeout: 60000,
}, async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/active-history.db",
    appVersion: "test",
  });
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 120);
  const [set] = store.list("workout_set", { parentId: entry });
  if (!set) throw new Error("Missing first set");
  const recorded = () =>
    historyData(store)
      .months.flatMap((m) => m.workouts)
      .map((w) => w.volumeKg);
  const initial = sharedProgress(store, 0);
  const logged = applyAppChange(
    store,
    (s) => logSet(s, set.id, { weightKg: 50, reps: 8 }),
    "active-workout",
  );
  expect(sharedProgress(store, logged.historyVersion)).toBe(initial);
  const edited = applyAppChange(store, (s) => updateSet(s, set.id, { reps: 9 }), "active-workout");
  expect(sharedProgress(store, edited.historyVersion)).toBe(initial);
  expect(recorded()).toEqual([]);
  const finished = applyAppChange(store, (s) =>
    finishWorkout(s, workout, { title: "Bench", description: "", countForRoutine: false }),
  );
  const saved = sharedProgress(store, finished.historyVersion);
  expect(saved.index.exercises).toHaveLength(1);
  expect(recorded()).toEqual([450]);
  const corrected = applyAppChange(store, (s) => updateSet(s, set.id, { reps: 7 }));
  expect(sharedProgress(store, corrected.historyVersion)).not.toBe(saved);
  expect(recorded()).toEqual([350]);
  store.close();
});

it("tracks logged sets live and in history, and credits primary and secondary sets in the selected interval", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/muscle-map.db",
    appVersion: "test",
  });
  try {
    const id = beginWorkout(store);
    const bench = addExercise(store, id, EXERCISES.bench, 90);
    addExercise(store, id, EXERCISES.curl, 90);
    const set = store.list("workout_set", { parentId: bench })[0];
    if (!set) throw new Error("Missing bench set");
    expect(liveData(store)?.muscleSets).toEqual({});
    logSet(store, set.id, { weightKg: 40, reps: 8 });
    logSet(store, addSet(store, bench), { type: "warmup", weightKg: 15, reps: 3 });
    const plank = addExercise(store, id, EXERCISES.plank, 0);
    const timed = store.list("workout_set", { parentId: plank })[0];
    if (!timed) throw new Error("Missing plank set");
    logSet(store, timed.id, { durationSeconds: 30 });
    saveSettings(store, { countWarmups: true });
    expect(liveData(store)?.muscleSets).toEqual({
      chest: 2,
      shoulders: 1,
      triceps: 1,
      abdominals: 1,
    });
    saveSettings(store, { countWarmups: false });
    expect(liveData(store)?.muscleSets).toEqual({
      chest: 1,
      shoulders: 0.5,
      triceps: 0.5,
      abdominals: 1,
    });
    expect(progressData(store).index.exercises).toHaveLength(0);
    finishWorkout(store, id, { title: "Push", description: "", countForRoutine: true });
    expect(workoutDetail(store, id)?.muscleSets).toEqual({
      chest: 1,
      shoulders: 0.5,
      triceps: 0.5,
      abdominals: 1,
    });
    saveSettings(store, { countWarmups: true });
    expect(workoutDetail(store, id)?.muscleSets).toEqual({
      chest: 2,
      shoulders: 1,
      triceps: 1,
      abdominals: 1,
    });
    saveSettings(store, { countWarmups: false });
    const data = progressData(store);
    expect(data.muscleTargets(EXERCISES.bench.id)).toEqual({
      primaryMuscles: ["chest"],
      secondaryMuscles: ["shoulders", "triceps"],
    });
    const start = Date.parse(String(store.get("workout", id)?.content?.startedAt));
    expect(periodMuscleSets(data.index.exercises, start, start + 1, data.muscleTargets)).toEqual({
      chest: 1,
      shoulders: 0.5,
      triceps: 0.5,
      abdominals: 1,
    });
    const contributions = periodMuscleActivity(
      data.index.exercises,
      start,
      start + 1,
      data.muscleTargets,
    ).byGroup;
    expect(contributions.get("triceps")).toEqual([
      { exerciseId: EXERCISES.bench.id, name: "Bench Press", sets: 1, credit: 0.5 },
    ]);
    expect(contributions.get("abdominals")).toEqual([
      { exerciseId: EXERCISES.plank.id, name: "Plank", sets: 1, credit: 1 },
    ]);
    expect(
      periodMuscleActivity(data.index.exercises, start - 1, start, data.muscleTargets).byGroup.size,
    ).toBe(0);
    expect(data.index.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)).toBe(2);
    expect(
      periodMuscleSets(data.index.exercises, start, start + 1, (id) =>
        id === EXERCISES.bench.id
          ? {
              primaryMuscles: ["chest", "shoulders"],
              secondaryMuscles: ["chest", "triceps", "triceps"],
            }
          : undefined,
      ),
    ).toEqual({ chest: 1, shoulders: 1, triceps: 0.5, other: 1 });
    expect(periodMuscleSets(data.index.exercises, start - 1, start, data.muscleTargets)).toEqual(
      {},
    );
  } finally {
    store.close();
  }
});
