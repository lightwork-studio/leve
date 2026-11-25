import { expect, it } from "vitest";
import { summarize, type WorkoutTree } from "../src/model/past-workouts.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import {
  bestSet,
  changeSince,
  effortComparison,
  loggedExercises,
} from "../src/model/workout-done.ts";
import { workoutEffort } from "../src/ui/format.ts";

type SetSpec = {
  seconds?: number;
  kg?: number | null;
  reps?: number | null;
  warmup?: boolean;
  done?: boolean;
};

const workout = (entries: { name: string; type?: string; sets: SetSpec[] }[]): WorkoutTree => ({
  workout: {
    id: "w",
    content: {
      title: "Push",
      startedAt: "2026-11-12T17:00:00.000Z",
      endedAt: "2026-11-12T18:00:00.000Z",
      routineId: null,
    },
  },
  entries: entries.map((e, i) => ({
    entry: {
      id: `e${i}`,
      content: {
        workoutId: "w",
        exerciseId: `x${i}`,
        exerciseName: e.name,
        exerciseType: e.type ?? "weight_reps",
        position: i + 1,
        supersetId: null,
        restSeconds: 90,
        doubleDumbbellVolume: false,
      },
    },
    sets: e.sets.map((s, j): { id: string; content: WorkoutSet } => ({
      id: `e${i}s${j}`,
      content: {
        workoutExerciseId: `e${i}`,
        position: j + 1,
        type: s.warmup ? "warmup" : "normal",
        weightKg: s.kg ?? null,
        reps: s.reps ?? null,
        distanceMeters: null,
        durationSeconds: s.seconds ?? null,
        count: null,
        rpe: null,
        completedAt: s.done === false ? null : "2026-11-12T17:30:00.000Z",
      },
    })),
  })),
});

it("picks the set with the highest estimated one-rep max across exercises", () => {
  const tree = workout([
    // 100 × 5 → 116.7; 110 × 1 → 110.
    {
      name: "Squat",
      sets: [
        { kg: 100, reps: 5 },
        { kg: 110, reps: 1 },
      ],
    },
    // 82.5 × 8 → 104.5; 90 × 10 → 120, the best.
    {
      name: "Bench Press",
      sets: [
        { kg: 82.5, reps: 8 },
        { kg: 90, reps: 10 },
      ],
    },
  ]);
  const best = bestSet(tree, false);
  expect(best).toMatchObject({
    entryId: "e1",
    exerciseName: "Bench Press",
    weightKg: 90,
    reps: 10,
  });
  expect(best?.oneRepMaxKg).toBeCloseTo(120, 6);
});

it("takes a single rep at its own weight", () => {
  const best = bestSet(workout([{ name: "Deadlift", sets: [{ kg: 180, reps: 1 }] }]), false);
  expect(best).toMatchObject({ weightKg: 180, reps: 1, oneRepMaxKg: 180 });
});

it("keeps the first of two equal sets", () => {
  const tree = workout([
    { name: "Row", sets: [{ kg: 60, reps: 10 }] },
    { name: "Press", sets: [{ kg: 60, reps: 10 }] },
  ]);
  expect(bestSet(tree, false)?.exerciseName).toBe("Row");
});

it("leaves out sets that don't count, and other exercise types", () => {
  const tree = workout([
    {
      name: "Bench Press",
      sets: [
        // Unfinished, and a warm-up while warm-ups don't count: both heavier than the rest.
        { kg: 140, reps: 5, done: false },
        { kg: 120, reps: 5, warmup: true },
        { kg: 60, reps: 8 },
        // No weight, or no reps: no estimate.
        { kg: 0, reps: 20 },
        { kg: 200, reps: 0 },
      ],
    },
    // A weighted dip has a weight but no estimate.
    { name: "Dip", type: "weighted_bodyweight", sets: [{ kg: 100, reps: 10 }] },
  ]);
  expect(bestSet(tree, false)).toMatchObject({ weightKg: 60, reps: 8 });
  // Counting warm-ups lets the warm-up win.
  expect(bestSet(tree, true)).toMatchObject({ weightKg: 120, reps: 5 });
});

it("has no best set without a weight-and-reps set that counts", () => {
  expect(bestSet(workout([]), false)).toBeNull();
  expect(
    bestSet(
      workout([{ name: "Plank", type: "duration", sets: [{ kg: null, reps: null }] }]),
      false,
    ),
  ).toBeNull();
  expect(
    bestSet(workout([{ name: "Curl", sets: [{ kg: 20, reps: 10, done: false }] }]), false),
  ).toBeNull();
});

it("says how a figure changed since last time, in whole units", () => {
  expect(changeSince(6480, 5630)).toEqual({ direction: "up", amount: 850 });
  expect(changeSince(52, 64)).toEqual({ direction: "down", amount: 12 });
  expect(changeSince(17, 17)).toEqual({ direction: "same", amount: 0 });
  // Differences the screen can't show are the same.
  expect(changeSince(100.4, 99.6)).toEqual({ direction: "same", amount: 0 });
  expect(changeSince(100.6, 99.6)).toEqual({ direction: "up", amount: 1 });
});

it("lists a timed warm-up alongside working sets and leaves unlogged exercises out of the receipt", () => {
  const tree = workout([
    {
      name: "Press",
      sets: [
        { kg: 20, reps: 8 },
        { kg: 10, reps: 6, warmup: true },
      ],
    },
    {
      name: "Plank",
      type: "duration",
      sets: [
        { seconds: 30, warmup: true },
        { seconds: 60, done: false },
      ],
    },
    { name: "Curl", sets: [{ done: false }] },
  ]);
  expect(loggedExercises(tree)).toEqual([
    { id: "e0", name: "Press", otherSets: 1, warmups: 1, seconds: null, partialTime: false },
    { id: "e1", name: "Plank", otherSets: 0, warmups: 1, seconds: 30, partialTime: false },
  ]);
});

it("preserves measured time after another logged set loses its duration", () => {
  const tree = workout([
    { name: "Press", sets: [{ reps: 8 }] },
    { name: "Row", sets: [{ reps: 6 }] },
    { name: "Curl", sets: [{ reps: 10 }] },
    { name: "Plank", type: "duration", sets: [{ warmup: true, seconds: 30 }, { seconds: 60 }] },
  ]);
  expect(loggedExercises(tree)).toHaveLength(4);
  expect(loggedExercises(tree)[3]).toMatchObject({
    name: "Plank",
    seconds: 90,
    partialTime: false,
  });
  const corrected = tree.entries[3]?.sets[1];
  if (!corrected) throw new Error("Missing second plank set");
  corrected.content.durationSeconds = null;
  expect(loggedExercises(tree)[3]).toMatchObject({
    warmups: 1,
    otherSets: 1,
    seconds: 30,
    partialTime: true,
  });
});

it("keeps known time and withholds change when either session is only partly timed", () => {
  const options = { countWarmups: false, bodyweightKg: null, usesBodyweight: () => false };
  const session = (sets: SetSpec[]) =>
    summarize(
      workout([
        { name: "Plank", type: "duration", sets },
        { name: "Push-up", type: "bodyweight_reps", sets: [{ reps: 5 }] },
      ]),
      options,
    );
  const partial = session([{ seconds: 30, warmup: true }, {}]);
  const complete = session([{ seconds: 30 }, { seconds: 30 }, { done: false }]);
  const unknown = session([{}]);
  expect(partial.excludedWarmups).toBe(1);
  expect(workoutEffort(partial, "kg")).toEqual({ label: "Partial time", amount: "0:30", unit: "" });
  expect(workoutEffort(unknown, "kg").amount).toBe("—");
  expect(effortComparison(partial, complete, "kg")).toBeNull();
  expect(effortComparison(complete, partial, "kg")).toBeNull();
  expect(effortComparison(complete, unknown, "kg")).toBeNull();
  expect(effortComparison(complete, session([{ seconds: 45 }]), "kg")).toEqual({
    metric: "time",
    now: 60,
    before: 45,
  });
});
