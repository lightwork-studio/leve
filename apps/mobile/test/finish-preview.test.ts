import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXERCISES } from "../src/data/exercises.ts";
import {
  finishPreview,
  lastTime,
  progressData,
  readSettings,
  workoutDetail,
} from "../src/data/read.ts";
import { createRoutine } from "../src/data/routine-actions.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  finishWorkout,
  logSet,
} from "../src/data/workout-actions.ts";
import { workoutAsSaved } from "../src/model/finish-preview.ts";
import { recordsByWorkout, workoutRecords } from "../src/model/progress.ts";
import { compareBarcodes, versusLastTime } from "../src/model/session-compare.ts";
import { bestSet, loggedExercises } from "../src/model/workout-done.ts";

const SQL = await initSqlJs();
let n = 0;
let store: DeviceStore;
let clock = Date.parse("2026-11-02T18:00:00.000Z");
beforeEach(async () => {
  clock = Date.parse("2026-11-02T18:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/finish-${n++}.db`,
    appVersion: "test",
  });
});
afterEach(() => {
  store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A day later, as the clock goes. */
const nextDay = () => {
  clock += 86_400_000;
  vi.setSystemTime(clock);
};

/** Logs `sets` (weight × reps) on a new exercise entry, leaving `unlogged` more sets unlogged. */
function bench(workout: string, sets: [number, number][], unlogged = 0) {
  const entry = addExercise(store, workout, EXERCISES.bench, 0);
  for (let i = 1; i < sets.length + unlogged; i++) addSet(store, entry);
  const rows = store.list("workout_set", { parentId: entry });
  sets.forEach(([weightKg, reps], i) => {
    const row = rows[i];
    if (!row) throw Error("Missing set");
    logSet(store, row.id, { weightKg, reps });
  });
  return entry;
}

function routine() {
  return createRoutine(
    store,
    "Push",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        useRepRange: false,
        sets: [{ id: "a", values: {} }],
      },
    ],
    readSettings(store),
  );
}

/** What the summary showed of the saved workout before (the old way): read after saving. */
function afterSaving(id: string) {
  const detail = workoutDetail(store, id);
  if (!detail) throw Error("Missing saved workout");
  const { index } = progressData(store);
  const last = lastTime(store, id);
  const held = recordsByWorkout(index).get(id) ?? [];
  const recordSets = new Set(held.flatMap((record) => (record.setId ? [record.setId] : [])));
  return {
    records: workoutRecords(index, detail.tree),
    versus: versusLastTime(index, detail.tree, detail.summary, last),
    bars: compareBarcodes(index, detail.tree, recordSets),
    best: bestSet(detail.tree, detail.settings.countWarmups),
    exercises: loggedExercises(detail.tree),
    summary: detail.summary,
    last,
  };
}

function preview(countForRoutine: boolean) {
  const shown = finishPreview(store, countForRoutine);
  if (!shown) throw Error("No preview");
  const { records, versus, bars, best, exercises, summary, last } = shown;
  return { records, versus, bars, best, exercises, summary, last };
}

it.each([true, false])(
  "shows before saving the records and comparison the saved workout has (counting for the routine: %s)",
  (countForRoutine) => {
    const plan = routine();
    const first = beginWorkout(store, plan);
    bench(first, [
      [100, 5],
      [100, 5],
    ]);
    finishWorkout(store, first, { countForRoutine: true });
    nextDay();
    const second = beginWorkout(store, plan);
    bench(second, [[90, 8]]);
    finishWorkout(store, second, { countForRoutine: true });
    nextDay();

    // This one beats the heaviest and the estimate, and leaves a set and an exercise unlogged.
    const current = beginWorkout(store, plan);
    bench(current, [[105, 5]], 1);
    addExercise(store, current, EXERCISES.ohp, 0);
    const before = preview(countForRoutine);
    expect(before.records[0]?.records.map((r) => [r.metric, r.value, r.before])).toContainEqual([
      "heaviest",
      105,
      100,
    ]);
    // Nothing is written by looking.
    expect(store.get("workout", current)?.content?.endedAt).toBeNull();
    expect(store.list("workout_exercise", { parentId: current })).toHaveLength(3);

    finishWorkout(store, current, { countForRoutine });
    const after = afterSaving(current);
    expect(before.records).toEqual(after.records);
    expect(before.versus).toEqual(after.versus);
    expect([...before.bars]).toEqual([...after.bars]);
    expect(before.best).toEqual(after.best);
    expect(before.exercises).toEqual(after.exercises);
    expect(before.summary).toEqual(after.summary);
    expect(before.last).toEqual(after.last);
  },
);

it("compares with last time when nothing is a record, as the saved workout does", () => {
  const plan = routine();
  const first = beginWorkout(store, plan);
  bench(first, [[120, 5]]);
  finishWorkout(store, first, { countForRoutine: true });
  nextDay();
  const current = beginWorkout(store, plan);
  bench(current, [[110, 5]]);
  const before = preview(true);
  expect(before.records).toEqual([]);
  expect(before.versus?.down.map((change) => change.exerciseName)).toEqual(["Bench Press"]);
  finishWorkout(store, current, { countForRoutine: true });
  expect(before.versus).toEqual(afterSaving(current).versus);
});

it("saves the workout as the preview describes it", () => {
  const id = beginWorkout(store);
  const kept = bench(id, [[60, 10]], 2);
  const dropped = addExercise(store, id, EXERCISES.ohp, 0);
  clock += 45 * 60_000;
  vi.setSystemTime(clock);
  const live = workoutDetail(store, id)?.tree;
  if (!live) throw Error("Missing workout");
  const saved = workoutAsSaved(live, { countForRoutine: false, now: clock });
  expect(saved.entries.map(({ entry }) => entry.id)).toEqual([kept]);
  expect(saved.entries[0]?.sets).toHaveLength(1);
  expect(saved.workout.content.endedAt).toBe(new Date(clock).toISOString());
  finishWorkout(store, id, { countForRoutine: false });
  const stored = workoutDetail(store, id)?.tree;
  expect(stored?.entries.map(({ entry }) => entry.id)).toEqual([kept]);
  expect(stored?.entries[0]?.sets.map((set) => set.id)).toEqual(
    saved.entries[0]?.sets.map((set) => set.id),
  );
  expect(stored?.workout.content.endedAt).toBe(saved.workout.content.endedAt);
  expect(store.get("workout_exercise", dropped)).toBeNull();
});

it("never ends a workout before it started, even with the clock behind", () => {
  const id = beginWorkout(store);
  bench(id, [[60, 10]]);
  const live = workoutDetail(store, id)?.tree;
  if (!live) throw Error("Missing workout");
  const saved = workoutAsSaved(live, { countForRoutine: true, now: clock - 60_000 });
  expect(saved.workout.content.endedAt).toBe(live.workout.content.startedAt);
});
