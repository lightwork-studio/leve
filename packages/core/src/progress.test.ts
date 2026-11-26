import { describe, expect, it } from "vitest";
import { buildProgress, exerciseRecords } from "./progress.ts";
import type { WorkoutSetContent, WorkoutTree } from "./records.ts";

const set = (
  id: string,
  position: number,
  values: Partial<WorkoutSetContent>,
): { id: string; content: WorkoutSetContent } => ({
  id,
  content: {
    workoutExerciseId: "e",
    position,
    type: "normal",
    weightKg: null,
    reps: null,
    distanceMeters: null,
    durationSeconds: null,
    count: null,
    rpe: null,
    completedAt: "2026-11-02T10:10:00.000Z",
    ...values,
  },
});

function workout(id: string, startedAt: string, sets: ReturnType<typeof set>[]): WorkoutTree {
  return {
    workout: {
      id,
      content: {
        title: "Push",
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
        routineId: null,
      },
    },
    entries: [
      {
        entry: {
          id: `${id}-e`,
          content: {
            workoutId: id,
            exerciseId: "builtin:barbell-bench-press",
            exerciseName: "Bench Press",
            exerciseType: "weight_reps",
            position: 1,
            supersetId: null,
            restSeconds: 120,
            doubleDumbbellVolume: false,
          },
        },
        sets,
      },
    ],
  };
}

const options = { countWarmups: false, bodyweightAt: () => null, usesBodyweight: () => false };

describe("progress figures without the app", () => {
  it("measures finished workouts' sessions, bests and records", () => {
    const index = buildProgress(
      [
        workout("w1", "2026-11-02T10:00:00.000Z", [
          set("s1", 1, { type: "warmup", weightKg: 40, reps: 10 }),
          set("s2", 2, { weightKg: 80, reps: 5 }),
          set("s3", 3, { weightKg: 80, reps: 5 }),
        ]),
        workout("w2", "2026-11-09T10:00:00.000Z", [
          set("s4", 1, { weightKg: 85, reps: 2 }),
          set("s5", 2, { weightKg: 90, reps: 1, completedAt: null }),
        ]),
        // Still in progress: not counted.
        {
          ...workout("w3", "2026-11-16T10:00:00.000Z", [set("s6", 1, { weightKg: 120, reps: 1 })]),
          workout: {
            id: "w3",
            content: {
              title: "Push",
              startedAt: "2026-11-16T10:00:00.000Z",
              endedAt: null,
              routineId: null,
            },
          },
        },
      ],
      options,
    );

    expect(index.workouts.map((w) => [w.id, w.volumeKg, w.sets, w.minutes])).toEqual([
      ["w1", 800, 2, 45],
      ["w2", 170, 1, 45],
    ]);
    const bench = index.byExercise.get("builtin:barbell-bench-press");
    expect(bench?.sessions.map((s) => s.workoutId)).toEqual(["w2", "w1"]);
    // Epley: 80 × (1 + 5/30) = 93.3 beats 85 × (1 + 2/30) = 90.7.
    expect(bench?.sessions[1]?.best.oneRepMaxKg).toBeCloseTo(93.33, 2);
    expect(bench?.sessions[0]?.best.heaviestKg).toBe(85);

    const records = Object.fromEntries(
      exerciseRecords(bench as NonNullable<typeof bench>).map((r) => [r.metric, r.workoutId]),
    );
    expect(records).toMatchObject({ oneRepMax: "w1", heaviest: "w2", sessionVolume: "w1" });
  });
});
