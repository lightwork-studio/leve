import { describe, expect, it } from "vitest";
import type { WorkoutTree } from "../src/model/past-workouts.ts";
import { buildProgress, recordsByWorkout, workoutRecords } from "../src/model/progress.ts";
import { compareBarcodes, versusLastTime } from "../src/model/session-compare.ts";
import type { WorkoutSet } from "../src/model/types.ts";

// Expected values below are worked out by hand from the sets, not with the app's own helpers.

type SetSpec = { kg?: number; reps?: number; seconds?: number; warmup?: boolean; done?: boolean };
type EntrySpec = { exerciseId: string; type?: string; sets: SetSpec[] };

let ids = 0;
function tree(day: number, entries: EntrySpec[], routineId: string | null = null): WorkoutTree {
  const workoutId = `w${++ids}`;
  const start = new Date(2026, 10, day, 18).getTime();
  return {
    workout: {
      id: workoutId,
      content: {
        title: `Day ${day}`,
        description: "",
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 3_600_000).toISOString(),
        routineId,
      },
    },
    entries: entries.map((e, i) => {
      const entryId = `${workoutId}-e${i}`;
      return {
        entry: {
          id: entryId,
          content: {
            workoutId,
            exerciseId: e.exerciseId,
            exerciseName: e.exerciseId,
            exerciseType: e.type ?? "weight_reps",
            position: i + 1,
            supersetId: null,
            restSeconds: 120,
            doubleDumbbellVolume: false,
          },
        },
        sets: e.sets.map((s, j) => ({
          id: `${entryId}-s${j}`,
          content: {
            workoutExerciseId: entryId,
            position: j + 1,
            type: s.warmup ? "warmup" : "normal",
            weightKg: s.kg ?? null,
            reps: s.reps ?? null,
            distanceMeters: null,
            durationSeconds: s.seconds ?? null,
            count: null,
            rpe: null,
            completedAt: s.done === false ? null : "2026-11-12T18:00:00.000Z",
          } satisfies WorkoutSet,
        })),
      };
    }),
  };
}

const options = {
  countWarmups: false,
  bodyweightAt: () => 80,
  usesBodyweight: () => false,
};

describe("versus last time", () => {
  it("compares each exercise with the last session that had it, on its first shared measure", () => {
    const first = tree(1, [
      { exerciseId: "bench", sets: [{ kg: 100, reps: 5 }] },
      { exerciseId: "row", sets: [{ kg: 60, reps: 10 }] },
    ]);
    // Row is skipped on day 3, so day 5 compares it with day 1.
    const second = tree(3, [
      { exerciseId: "bench", sets: [{ kg: 100, reps: 6 }] },
      { exerciseId: "plank", type: "duration", sets: [{ seconds: 60 }] },
    ]);
    const today = tree(5, [
      // 102.5 × 5: 1RM 102.5 × (1 + 5/30) = 119.58; day 3 was 100 × (1 + 6/30) = 120.
      { exerciseId: "bench", sets: [{ kg: 102.5, reps: 5 }] },
      // 60 × 12: 60 × 1.4 = 84, against 60 × (1 + 10/30) = 80.
      { exerciseId: "row", sets: [{ kg: 60, reps: 12 }] },
      { exerciseId: "plank", type: "duration", sets: [{ seconds: 60 }] },
      // Never done before: left out.
      { exerciseId: "curl", sets: [{ kg: 12, reps: 10 }] },
    ]);
    const index = buildProgress([first, second, today], options);
    const result = versusLastTime(index, today, { volumeKg: 1952.5 }, null);
    const brief = (list: NonNullable<typeof result>["up"]) =>
      list.map((c) => [c.exerciseId, c.metric, Number(c.now.toFixed(2)), c.before]);
    expect(brief(result?.up ?? [])).toEqual([["row", "oneRepMax", 84, 80]]);
    expect(brief(result?.down ?? [])).toEqual([["bench", "oneRepMax", 119.58, 120]]);
    expect(brief(result?.same ?? [])).toEqual([["plank", "longestDuration", 60, 60]]);
    expect(result?.volume).toBeNull();
  });

  it("falls back to the next measure when last time had no estimate, and gives the volume change", () => {
    const last = tree(2, [{ exerciseId: "bench", sets: [{ kg: 0, reps: 12 }] }], "push");
    const today = tree(4, [{ exerciseId: "bench", sets: [{ kg: 20, reps: 10 }] }], "push");
    const index = buildProgress([last, today], options);
    // Day 2 has no weight, so no 1RM or heaviest weight; most reps is the first measure both have.
    const result = versusLastTime(index, today, { volumeKg: 2050 }, { volumeKg: 1900 });
    expect(result?.down.map((c) => [c.metric, c.now, c.before])).toEqual([["mostReps", 10, 12]]);
    // 2,050 against 1,900 is 7.9% more, shown whole.
    expect(result?.volume).toEqual({ nowKg: 2050, beforeKg: 1900, percent: 8 });
  });

  it("leaves the comparison out when there is nothing earlier to compare with", () => {
    const only = tree(6, [{ exerciseId: "squat", sets: [{ kg: 140, reps: 3 }] }]);
    const index = buildProgress([only], options);
    expect(versusLastTime(index, only, { volumeKg: 420 }, null)).toBeNull();
    // A routine's earlier session without volume gives no percentage either.
    expect(versusLastTime(index, only, { volumeKg: 420 }, { volumeKg: 0 })).toBeNull();
  });
});

describe("records with what they beat", () => {
  const day1 = tree(1, [{ exerciseId: "bench", sets: [{ kg: 100, reps: 5 }] }]);
  const day2 = tree(2, [
    {
      exerciseId: "bench",
      sets: [
        { kg: 110, reps: 2, warmup: true },
        { kg: 110, reps: 3 },
        { kg: 105, reps: 8 },
      ],
    },
  ]);
  const day3 = tree(3, [{ exerciseId: "bench", sets: [{ kg: 110, reps: 3 }] }]);
  const index = buildProgress([day3, day1, day2], options);

  it("says what each record beat, and nothing the first time", () => {
    const records = (t: WorkoutTree) =>
      workoutRecords(index, t).flatMap((g) => g.records.map((r) => [r.metric, r.before]));
    // Day 2: heaviest 110 (was 100); 1RM 105 × (1 + 8/30) = 133 (was 100 × 7/6 = 116.67);
    // best set 105 × 8 = 840 (was 500), and the session 330 + 840 = 1,170 (was 500); 8 reps (was 5).
    expect(records(day2)).toEqual([
      ["heaviest", 100],
      ["oneRepMax", 100 * (1 + 5 / 30)],
      ["bestSetVolume", 500],
      ["sessionVolume", 500],
      ["mostReps", 5],
    ]);
    expect(records(day1).every(([, before]) => before === null)).toBe(true);
    // Day 3 only matches day 2's 110 kg: a tie is no record.
    expect(records(day3)).toEqual([]);
  });

  it("finds the same records for every workout in one pass, with the set that reached each", () => {
    const all = recordsByWorkout(index);
    const day2Records = all.get(day2.workout.id) ?? [];
    expect(day2Records.map((r) => [r.metric, r.before, r.setId])).toEqual([
      // The 110 kg working set, not the warm-up at the same weight.
      ["heaviest", 100, `${day2.workout.id}-e0-s1`],
      ["oneRepMax", 100 * (1 + 5 / 30), `${day2.workout.id}-e0-s2`],
      ["bestSetVolume", 500, null],
      ["sessionVolume", 500, null],
      ["mostReps", 5, `${day2.workout.id}-e0-s2`],
    ]);
    expect(all.get(day3.workout.id)).toBeUndefined();
    for (const t of [day1, day2, day3]) {
      const one = workoutRecords(index, t).flatMap((g) =>
        g.records.map((r) => [g.exerciseId, r.metric, r.value, r.before]),
      );
      const pass = (all.get(t.workout.id) ?? []).map((r) => [
        r.exerciseId,
        r.metric,
        r.value,
        r.before,
      ]);
      expect(pass).toEqual(one);
    }
  });
});

describe("compare barcodes", () => {
  it("puts last time's set in the same place behind each of this time's sets", () => {
    const last = tree(1, [
      {
        exerciseId: "squat",
        sets: [
          { kg: 60, reps: 5, warmup: true },
          { kg: 100, reps: 5 },
        ],
      },
    ]);
    const today = tree(2, [
      {
        exerciseId: "squat",
        sets: [
          { kg: 60, reps: 5, warmup: true },
          { kg: 105, reps: 5 },
          { kg: 0, reps: 0, done: false },
        ],
      },
      // The same exercise again carries on from the third of last time's sets: there is none.
      { exerciseId: "squat", sets: [{ kg: 80, reps: 8 }] },
      { exerciseId: "plank", type: "duration", sets: [{ seconds: 45 }] },
    ]);
    const index = buildProgress([last, today], options);
    const bars = compareBarcodes(index, today, new Set([`${today.workout.id}-e0-s1`]));
    expect([...bars.values()]).toEqual([
      [
        { magnitude: 300, previous: 300, warmup: true, record: false },
        { magnitude: 525, previous: 500, warmup: false, record: true },
      ],
      [{ magnitude: 640, previous: null, warmup: false, record: false }],
      [{ magnitude: 45, previous: null, warmup: false, record: false }],
    ]);
  });
});
