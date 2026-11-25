import { describe, expect, it } from "vitest";
import type { WorkoutTree } from "../src/model/past-workouts.ts";
import {
  barAxisTop,
  buildProgress,
  chartSeries,
  durationAxisTop,
  type ExerciseMetric,
  emptyLead,
  estimatedOneRepMax,
  exerciseMetrics,
  exerciseRecords,
  lineAxis,
  METRIC_AXIS,
  mainLifts,
  metricPoints,
  monthMarks,
  monthStarts,
  type ProgressOptions,
  rangeStart,
  recentRecords,
  seriesLead,
  sessionBest,
  trainingFrequency,
  weekTotals,
  workoutRecords,
} from "../src/model/progress.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import { chartName, metricTick } from "../src/ui/exercise-metrics.ts";
import { sessionSetLabel } from "../src/ui/set-values.ts";

// Dates are built in local time, so the tests hold in any time zone. 12 Nov 2026 is a Thursday.
const local = (y: number, m: number, d: number, h = 18, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 11, 12, 20);
const MONDAY = 1;

type SetSpec = {
  kg?: number | null;
  reps?: number | null;
  type?: WorkoutSet["type"];
  done?: boolean;
  seconds?: number | null;
  meters?: number | null;
};

const set = (s: SetSpec, position = 1): WorkoutSet => ({
  workoutExerciseId: "e",
  position,
  type: s.type ?? "normal",
  weightKg: s.kg ?? null,
  reps: s.reps ?? null,
  distanceMeters: s.meters ?? null,
  durationSeconds: s.seconds ?? null,
  count: null,
  rpe: null,
  completedAt: s.done === false ? null : "2026-11-12T18:00:00.000Z",
});

type EntrySpec = {
  exerciseId: string;
  name?: string;
  type?: string;
  double?: boolean;
  sets: SetSpec[];
};

let ids = 0;
/** A workout tree; `minutes: null` leaves it unfinished. */
function tree(
  start: number,
  minutes: number | null,
  entries: EntrySpec[],
  title = "W",
): WorkoutTree {
  const workoutId = `w${++ids}`;
  return {
    workout: {
      id: workoutId,
      content: {
        title,
        startedAt: new Date(start).toISOString(),
        endedAt: minutes === null ? null : new Date(start + minutes * 60_000).toISOString(),
        routineId: null,
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
            exerciseName: e.name ?? e.exerciseId,
            exerciseType: e.type ?? "weight_reps",
            position: i + 1,
            supersetId: null,
            restSeconds: 120,
            doubleDumbbellVolume: e.double ?? false,
          },
        },
        sets: e.sets.map((s, j) => ({
          id: `${entryId}-s${j}`,
          content: { ...set(s, j + 1), workoutExerciseId: entryId },
        })),
      };
    }),
  };
}

const options = (over: Partial<ProgressOptions> = {}): ProgressOptions => ({
  countWarmups: false,
  bodyweightAt: () => 80,
  usesBodyweight: (id) => id === "pullup",
  ...over,
});

it("counts local training dates once in the most recent and previous 28 calendar days", () => {
  const index = buildProgress(
    [
      tree(local(2026, 11, 13), 30, []), // Tomorrow.
      tree(local(2026, 11, 12, 23), 75, []), // Crosses midnight.
      tree(local(2026, 11, 12, 7), 15, []),
      tree(local(2026, 11, 11), null, []), // Still running.
      tree(local(2026, 10, 16, 0), 20, []),
      tree(local(2026, 10, 15, 23), 20, []),
      tree(local(2026, 10, 15, 8), 20, []),
      tree(local(2026, 10, 1), 20, []),
      tree(local(2026, 9, 18, 0), 20, []),
      tree(local(2026, 9, 17, 23), 20, []),
    ],
    options(),
  );
  expect(trainingFrequency(index.workouts, local(2026, 11, 12, 0))).toEqual({
    recent: 2,
    previous: 3,
  });
  expect(trainingFrequency([], NOW)).toEqual({ recent: 0, previous: 0 });
});

describe("estimated one-rep max (Epley)", () => {
  it("is weight × (1 + reps / 30), and the weight itself for a single", () => {
    expect(estimatedOneRepMax(100, 5)).toBeCloseTo(116.667, 3);
    expect(estimatedOneRepMax(80, 10)).toBeCloseTo(106.667, 3);
    expect(estimatedOneRepMax(60, 30)).toBe(120);
    expect(estimatedOneRepMax(140, 1)).toBe(140);
  });

  it("has no estimate without a weight or a rep", () => {
    expect(estimatedOneRepMax(null, 5)).toBeNull();
    expect(estimatedOneRepMax(0, 5)).toBeNull();
    expect(estimatedOneRepMax(100, 0)).toBeNull();
    expect(estimatedOneRepMax(100, null)).toBeNull();
  });
});

describe("a session's bests", () => {
  const barbell = { exerciseType: "weight_reps", doubleDumbbellVolume: false };
  const plain = { countWarmups: false, usesBodyweight: false, bodyweightKg: 80 };

  it("takes completed working sets only, leaving out warm-ups by default", () => {
    const { best, counted } = sessionBest(
      [
        set({ kg: 120, reps: 10, type: "warmup" }),
        set({ kg: 100, reps: 5 }),
        set({ kg: 90, reps: 8, type: "failure" }),
        set({ kg: 70, reps: 12, type: "drop" }),
        set({ kg: 150, reps: 3, done: false }),
      ],
      barbell,
      plain,
    );
    expect(counted).toBe(3);
    expect(best.heaviestKg).toBe(100);
    // 100 × (1 + 5/30) = 116.67; 90 × (1 + 8/30) = 114; 70 × (1 + 12/30) = 98.
    expect(best.oneRepMaxKg).toBeCloseTo(116.667, 3);
    // 500, 720 and 840.
    expect(best.bestSetVolumeKg).toBe(840);
    expect(best.volumeKg).toBe(2060);
    expect(best.mostReps).toBe(12);
    expect(best.reps).toBe(25);
  });

  it("counts warm-ups when the setting says so", () => {
    const { best, counted } = sessionBest(
      [set({ kg: 120, reps: 10, type: "warmup" }), set({ kg: 100, reps: 5 })],
      barbell,
      { ...plain, countWarmups: true },
    );
    expect(counted).toBe(2);
    expect(best.heaviestKg).toBe(120);
    expect(best.oneRepMaxKg).toBe(160);
    expect(best.volumeKg).toBe(1700);
  });

  it("doesn't count a weight lifted for no reps as the heaviest", () => {
    const { best } = sessionBest(
      [set({ kg: 200, reps: 0 }), set({ kg: 100, reps: 3 })],
      barbell,
      plain,
    );
    expect(best.heaviestKg).toBe(100);
    expect(best.oneRepMaxKg).toBeCloseTo(110, 6);
  });

  it("follows the volume rules: doubled dumbbells and bodyweight", () => {
    const dumbbells = sessionBest(
      [set({ kg: 20, reps: 10 })],
      { exerciseType: "weight_reps", doubleDumbbellVolume: true },
      plain,
    );
    // The heaviest is the dumbbell's own weight; volume counts both.
    expect(dumbbells.best.heaviestKg).toBe(20);
    expect(dumbbells.best.volumeKg).toBe(400);

    const pullups = sessionBest(
      [set({ reps: 8 }), set({ reps: 6 })],
      { exerciseType: "bodyweight_reps", doubleDumbbellVolume: false },
      { countWarmups: false, usesBodyweight: true, bodyweightKg: 80 },
    );
    expect(pullups.best.heaviestKg).toBeNull();
    expect(pullups.best.oneRepMaxKg).toBeNull();
    expect(pullups.best.volumeKg).toBe(1120);
    expect(pullups.best.bestSetVolumeKg).toBe(640);
    expect(pullups.best.mostReps).toBe(8);

    const assisted = sessionBest(
      [set({ kg: 30, reps: 10 })],
      { exerciseType: "assisted_bodyweight", doubleDumbbellVolume: false },
      { countWarmups: false, usesBodyweight: true, bodyweightKg: 80 },
    );
    // Less help is harder, so the assistance is never a "heaviest".
    expect(assisted.best.heaviestKg).toBeNull();
    expect(assisted.best.volumeKg).toBe(500);
  });

  it("keeps the longest time and distance for timed types", () => {
    const { best } = sessionBest(
      [set({ seconds: 45 }), set({ seconds: 60 }), set({ seconds: 30 })],
      { exerciseType: "duration", doubleDumbbellVolume: false },
      plain,
    );
    expect(best.longestSeconds).toBe(60);
    expect(best.volumeKg).toBeNull();
    expect(best.reps).toBeNull();

    const run = sessionBest(
      [set({ meters: 5000, seconds: 1500 }), set({ meters: 3000, seconds: 1700 })],
      { exerciseType: "distance_duration", doubleDumbbellVolume: false },
      plain,
    );
    expect(run.best.longestMeters).toBe(5000);
    expect(run.best.longestSeconds).toBe(1700);
  });
});

describe("building the progress index", () => {
  it("skips unfinished workouts and totals each workout", () => {
    const index = buildProgress(
      [
        tree(local(2026, 11, 10), 60, [
          {
            exerciseId: "bench",
            sets: [
              { kg: 100, reps: 5 },
              { kg: 100, reps: 5 },
            ],
          },
          { exerciseId: "plank", type: "duration", sets: [{ seconds: 60 }] },
        ]),
        tree(local(2026, 11, 12), null, [{ exerciseId: "bench", sets: [{ kg: 200, reps: 1 }] }]),
      ],
      options(),
    );
    expect(index.workouts).toHaveLength(1);
    expect(index.workouts[0]).toMatchObject({ minutes: 60, volumeKg: 1000, reps: 10 });
    expect(index.byExercise.get("bench")?.sessions).toHaveLength(1);
    expect(index.byExercise.get("bench")?.sessions[0]?.best.heaviestKg).toBe(100);
  });

  it("makes one session of an exercise done twice in a workout", () => {
    const index = buildProgress(
      [
        tree(local(2026, 11, 10), 60, [
          { exerciseId: "bench", sets: [{ kg: 100, reps: 5 }] },
          { exerciseId: "row", sets: [{ kg: 60, reps: 10 }] },
          {
            exerciseId: "bench",
            sets: [
              { kg: 80, reps: 10 },
              { kg: 80, reps: 9 },
            ],
          },
        ]),
      ],
      options(),
    );
    const bench = index.byExercise.get("bench");
    expect(bench?.sessions).toHaveLength(1);
    expect(bench?.sets).toBe(3);
    expect(bench?.sessions[0]?.sets).toHaveLength(3);
    expect(bench?.sessions[0]?.best).toMatchObject({
      heaviestKg: 100,
      volumeKg: 2020,
      bestSetVolumeKg: 800,
      mostReps: 10,
      reps: 24,
    });
    expect(index.workouts[0]?.volumeKg).toBe(2620);
  });

  it("orders sessions and exercises newest first and names each by its latest session", () => {
    const index = buildProgress(
      [
        tree(local(2026, 11, 10), 50, [
          { exerciseId: "bench", name: "Bench Press", sets: [{ kg: 100, reps: 5 }] },
        ]),
        tree(local(2026, 11, 2), 50, [
          { exerciseId: "bench", name: "Bench", sets: [{ kg: 90, reps: 5 }] },
          { exerciseId: "row", sets: [{ kg: 60, reps: 10 }] },
        ]),
        tree(local(2026, 11, 11), 50, [{ exerciseId: "squat", sets: [{ kg: 120, reps: 5 }] }]),
      ],
      options(),
    );
    expect(index.workouts.map((w) => w.time)).toEqual([
      local(2026, 11, 2),
      local(2026, 11, 10),
      local(2026, 11, 11),
    ]);
    expect(index.exercises.map((e) => e.exerciseId)).toEqual(["squat", "bench", "row"]);
    const bench = index.byExercise.get("bench");
    expect(bench?.name).toBe("Bench Press");
    expect(bench?.sessions.map((s) => s.time)).toEqual([local(2026, 11, 10), local(2026, 11, 2)]);
  });

  it("uses the bodyweight on record at each workout", () => {
    const index = buildProgress(
      [
        tree(local(2026, 10, 1), 30, [
          { exerciseId: "pullup", type: "bodyweight_reps", sets: [{ reps: 10 }] },
        ]),
        tree(local(2026, 11, 1), 30, [
          { exerciseId: "pullup", type: "bodyweight_reps", sets: [{ reps: 10 }] },
        ]),
      ],
      options({ bodyweightAt: (time) => (time < local(2026, 10, 15) ? 80 : 78) }),
    );
    expect(index.workouts.map((w) => w.volumeKg)).toEqual([800, 780]);
  });
});

it("counts each completed set once in weekly and monthly Progress totals", () => {
  const workouts = [
    tree(local(2025, 1, 3), 20, []),
    tree(NOW, 60, [
      { exerciseId: "bench", sets: [{ reps: 10 }, { reps: 8, type: "drop" }] },
      { exerciseId: "bench", sets: [{ reps: 5, type: "warmup" }, { done: false }] },
      { exerciseId: "plank", type: "duration", sets: [{ seconds: 30 }] },
    ]),
    tree(NOW, null, [{ exerciseId: "squat", sets: [{ reps: 9 }] }]),
  ];
  for (const [countWarmups, expected] of [
    [false, 3],
    [true, 4],
  ] as const) {
    const index = buildProgress(workouts, options({ countWarmups }));
    expect(weekTotals(index.workouts, NOW, MONDAY).sets).toBe(expected);
    for (const range of ["3M", "All"] as const) {
      const series = chartSeries(index.workouts, range, NOW, MONDAY);
      expect(series.unit).toBe(range === "All" ? "month" : "week");
      expect(series.buckets.at(-1)?.sets).toBe(expected);
      expect(series.buckets.at(-2)?.sets).toBe(0);
    }
  }
});

describe("weekly totals", () => {
  const workouts = buildProgress(
    [
      // This week (Mon 9 – Sun 15 Nov), with Monday as the first day.
      tree(local(2026, 11, 9), 60, [{ exerciseId: "bench", sets: [{ kg: 100, reps: 5 }] }]),
      tree(local(2026, 11, 12, 7), 45, [{ exerciseId: "squat", sets: [{ kg: 100, reps: 10 }] }]),
      // Sunday 8 Nov: last week with Monday first, this week with Sunday first.
      tree(local(2026, 11, 8), 30, [{ exerciseId: "row", sets: [{ kg: 50, reps: 10 }] }]),
      // Three weeks back, and long ago.
      tree(local(2026, 10, 20), 40, [{ exerciseId: "row", sets: [{ kg: 60, reps: 10 }] }]),
      tree(local(2025, 3, 4), 50, [{ exerciseId: "row", sets: [{ kg: 40, reps: 10 }] }]),
      // After now: a clock ahead on another device.
      tree(local(2026, 11, 20), 50, [{ exerciseId: "row", sets: [{ kg: 40, reps: 10 }] }]),
    ],
    options(),
  ).workouts;

  it("sums this week from its first day", () => {
    expect(weekTotals(workouts, NOW, MONDAY)).toEqual({
      start: local(2026, 11, 9, 0),
      end: local(2026, 11, 16, 0),
      workouts: 2,
      minutes: 105,
      volumeKg: 1500,
      reps: 15,
      sets: 2,
    });
    expect(weekTotals(workouts, NOW, 0)).toMatchObject({
      start: local(2026, 11, 8, 0),
      workouts: 3,
      minutes: 135,
      volumeKg: 2000,
    });
  });

  it("gives three months as twelve weeks, the current one last, empty weeks as zeros", () => {
    const series = chartSeries(workouts, "3M", NOW, MONDAY);
    expect(series.unit).toBe("week");
    expect(series.buckets).toHaveLength(12);
    expect(series.buckets[0]?.start).toBe(local(2026, 8, 24, 0));
    expect(series.buckets[11]?.start).toBe(local(2026, 11, 9, 0));
    expect(series.buckets.map((b) => b.minutes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 30, 105]);
    expect(series.buckets.map((b) => b.workouts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 2]);
    expect(series.buckets[10]?.volumeKg).toBe(500);
  });

  it("gives a year as 52 weeks", () => {
    const series = chartSeries(workouts, "1Y", NOW, MONDAY);
    expect(series.buckets).toHaveLength(52);
    expect(series.buckets[0]?.start).toBe(local(2025, 11, 17, 0));
    expect(series.buckets.reduce((sum, b) => sum + b.workouts, 0)).toBe(4);
  });

  it("gives all time by month once it covers more than a year", () => {
    const series = chartSeries(workouts, "All", NOW, MONDAY);
    expect(series.unit).toBe("month");
    // March 2025 to November 2026.
    expect(series.buckets).toHaveLength(21);
    expect(series.buckets[0]?.start).toBe(local(2025, 3, 1, 0));
    expect(series.buckets[0]?.workouts).toBe(1);
    expect(series.buckets[19]?.minutes).toBe(40);
    // The current month runs to its end, like the current week (the 20th's workout counts).
    expect(series.buckets[20]?.minutes).toBe(185);
  });

  it("gives all time by week, at least twelve, for a short history", () => {
    const recent = workouts.filter((w) => w.time > local(2026, 1, 1));
    const series = chartSeries(recent, "All", NOW, MONDAY);
    expect(series.unit).toBe("week");
    expect(series.buckets).toHaveLength(12);
    expect(chartSeries([], "All", NOW, MONDAY).buckets).toHaveLength(12);
  });

  it("names each month under the week that holds its first day", () => {
    const marks = monthMarks(chartSeries(workouts, "3M", NOW, MONDAY));
    // Weeks from Mon 24 Aug: the first ends in August; 31 Aug–6 Sep holds 1 Sep, 28 Sep–4 Oct
    // holds 1 Oct and 26 Oct–1 Nov holds 1 Nov.
    expect(marks.map((m) => [m.index, m.month])).toEqual([
      [0, 7],
      [1, 8],
      [5, 9],
      [9, 10],
    ]);
  });
});

describe("chart axes", () => {
  it("picks a bar top with a round middle line", () => {
    expect(barAxisTop(0)).toBe(2);
    expect(barAxisTop(3)).toBe(4);
    expect(barAxisTop(7.5)).toBe(8);
    expect(barAxisTop(9)).toBe(10);
    expect(barAxisTop(23_400)).toBe(40_000);
    expect(barAxisTop(51_000)).toBe(60_000);
  });

  it("picks a duration top in round minutes, then in even hours", () => {
    expect(durationAxisTop(0)).toBe(60);
    expect(durationAxisTop(25)).toBe(30);
    expect(durationAxisTop(59)).toBe(60);
    expect(durationAxisTop(192)).toBe(240);
    expect(durationAxisTop(250)).toBe(360);
  });

  it("puts three round lines around a line's values", () => {
    expect(lineAxis([88, 92.5, 101.9])).toEqual({ low: 85, step: 10, high: 105 });
    expect(lineAxis([8, 10, 12])).toEqual({ low: 8, step: 2, high: 12 });
    expect(lineAxis([100])).toEqual({ low: 95, step: 5, high: 105 });
    expect(lineAxis([])).toEqual({ low: 0, step: 1, high: 2 });
  });

  it("marks month starts, or only years over a long span", () => {
    const short = monthStarts(local(2026, 8, 12, 0), local(2026, 11, 13, 0));
    expect(short.map((m) => m.month)).toEqual([8, 9, 10]);
    const long = monthStarts(local(2024, 5, 1, 0), local(2026, 11, 13, 0));
    expect(long.map((m) => m.year)).toEqual([2025, 2026]);
    expect(long.every((m) => m.yearly && m.month === 0)).toBe(true);
  });
});

describe("an exercise's chart and records", () => {
  const index = buildProgress(
    [
      tree(local(2025, 6, 1), 60, [{ exerciseId: "bench", sets: [{ kg: 100, reps: 8 }] }]),
      tree(local(2026, 9, 1), 60, [{ exerciseId: "bench", sets: [{ kg: 100, reps: 3 }] }]),
      tree(local(2026, 10, 1), 60, [
        {
          exerciseId: "bench",
          sets: [
            { kg: 110, reps: 1 },
            { kg: 60, reps: 15 },
          ],
        },
      ]),
      tree(local(2026, 11, 1), 60, [{ exerciseId: "bench", sets: [{ kg: 100, reps: 8 }] }]),
      tree(local(2026, 11, 3), 40, [
        { exerciseId: "pullup", type: "bodyweight_reps", sets: [{ reps: 12 }] },
        { exerciseId: "dips", type: "bodyweight_reps", sets: [{ reps: 15 }] },
      ]),
    ],
    options(),
  );
  const bench = index.byExercise.get("bench");
  if (!bench) throw new Error("bench missing");

  it("keeps the first session that reached each record", () => {
    const records = exerciseRecords(bench);
    expect(records.map((r) => [r.metric, r.value, r.startedAt])).toEqual([
      ["heaviest", 110, new Date(local(2026, 10, 1)).toISOString()],
      // 100 × (1 + 8/30) = 126.67, first reached in June 2025 and only matched since.
      ["oneRepMax", 100 * (1 + 8 / 30), new Date(local(2025, 6, 1)).toISOString()],
      ["bestSetVolume", 900, new Date(local(2026, 10, 1)).toISOString()],
      ["sessionVolume", 1010, new Date(local(2026, 10, 1)).toISOString()],
      ["mostReps", 15, new Date(local(2026, 10, 1)).toISOString()],
    ]);
  });

  it("gives bodyweight exercises volume records only when they count bodyweight", () => {
    const pullup = index.byExercise.get("pullup");
    const dips = index.byExercise.get("dips");
    if (!pullup || !dips) throw new Error("missing");
    expect(exerciseRecords(pullup).map((r) => [r.metric, r.value])).toEqual([
      ["bestSetVolume", 960],
      ["sessionVolume", 960],
      ["mostReps", 12],
    ]);
    expect(exerciseRecords(dips).map((r) => [r.metric, r.value])).toEqual([["mostReps", 15]]);
    expect(exerciseMetrics("duration", false)).toEqual(["longestDuration"]);
  });

  it("charts sessions oldest first from the start of the range", () => {
    const since = rangeStart("3M", NOW);
    expect(since).toBe(local(2026, 8, 12, 0));
    expect(metricPoints(bench.sessions, "heaviest", since).map((p) => p.value)).toEqual([
      100, 110, 100,
    ]);
    expect(metricPoints(bench.sessions, "heaviest", rangeStart("All", NOW))).toHaveLength(4);
    expect(rangeStart("1Y", NOW)).toBe(local(2025, 11, 12, 0));
  });

  it("makes one point of a day's sessions, that day's best", () => {
    const sameDay = buildProgress(
      [
        tree(local(2026, 11, 2, 7), 30, [{ exerciseId: "row", sets: [{ kg: 60, reps: 10 }] }]),
        tree(local(2026, 11, 2, 18), 30, [{ exerciseId: "row", sets: [{ kg: 70, reps: 5 }] }]),
        tree(local(2026, 11, 2, 21), 30, [{ exerciseId: "row", sets: [{ kg: 65, reps: 12 }] }]),
        // Just after midnight is the next day.
        tree(local(2026, 11, 3, 0, 30), 30, [{ exerciseId: "row", sets: [{ kg: 50, reps: 8 }] }]),
      ],
      options(),
    ).byExercise.get("row");
    if (!sameDay) throw new Error("row missing");
    const heaviest = metricPoints(sameDay.sessions, "heaviest", rangeStart("All", NOW));
    expect(heaviest.map((p) => [p.time, p.value])).toEqual([
      [local(2026, 11, 2, 18), 70],
      [local(2026, 11, 3, 0, 30), 50],
    ]);
    // Each metric takes its own best of the day: 65 × 12 beats 60 × 10 and 70 × 5.
    const volume = metricPoints(sameDay.sessions, "bestSetVolume", rangeStart("All", NOW));
    expect(volume.map((p) => [p.time, p.value])).toEqual([
      [local(2026, 11, 2, 21), 780],
      [local(2026, 11, 3, 0, 30), 400],
    ]);
  });

  it("keeps the first of a day's sessions that reached its best", () => {
    const tie = buildProgress(
      [
        tree(local(2026, 11, 4, 8), 30, [{ exerciseId: "curl", sets: [{ kg: 20, reps: 10 }] }]),
        tree(local(2026, 11, 4, 19), 30, [{ exerciseId: "curl", sets: [{ kg: 20, reps: 8 }] }]),
      ],
      options(),
    ).byExercise.get("curl");
    if (!tie) throw new Error("curl missing");
    const points = metricPoints(tie.sessions, "heaviest", rangeStart("All", NOW));
    expect(points.map((p) => p.time)).toEqual([local(2026, 11, 4, 8)]);
  });
});

describe("an empty start of a chart", () => {
  it("is named only once it takes a third of the chart", () => {
    expect(emptyLead(0.5)).toBe(0.5);
    expect(emptyLead(1 / 3)).toBe(1 / 3);
    expect(emptyLead(0.3)).toBeNull();
    expect(emptyLead(0)).toBeNull();
    expect(emptyLead(undefined)).toBeNull();
    expect(emptyLead(null)).toBeNull();
  });

  it("starts at the first week with a workout in a year's bars", () => {
    const recent = [
      tree(local(2026, 9, 16), 45, [{ exerciseId: "bench", sets: [{ kg: 80, reps: 5 }] }]),
      tree(local(2026, 11, 10), 45, [{ exerciseId: "bench", sets: [{ kg: 80, reps: 5 }] }]),
    ];
    const index = buildProgress(recent, options());
    // 52 weeks, the last (index 51) the week of 9 Nov; 16 Sep is in the week of 14 Sep, eight back.
    expect(seriesLead(chartSeries(index.workouts, "1Y", NOW, MONDAY))).toEqual({
      share: 43 / 52,
      start: local(2026, 9, 14, 0),
    });
    // Over three months the data starts four weeks in: not worth a note.
    expect(seriesLead(chartSeries(index.workouts, "3M", NOW, MONDAY))).toBeNull();
    expect(seriesLead(chartSeries([], "1Y", NOW, MONDAY))).toBeNull();
  });
});

describe("line chart ticks", () => {
  /** A metric's axis around some values, its three lines named from the bottom up. */
  const ticks = (
    metric: ExerciseMetric,
    values: number[],
    prefs: { distanceUnit: "km" | "miles"; shortDistanceUnit: "m" | "yd" } = {
      distanceUnit: "km",
      shortDistanceUnit: "m",
    },
  ) => {
    const axis = lineAxis(values, METRIC_AXIS[metric]);
    return [0, 1, 2].map((i) => metricTick(metric, axis.low + i * axis.step, axis, prefs, "en-US"));
  };

  it("names lines between whole weights with the decimal they need", () => {
    expect(ticks("heaviest", [100, 105])).toEqual(["100", "102.5", "105"]);
    expect(ticks("heaviest", [10, 10.5])).toEqual(["10", "10.25", "10.5"]);
    // The lowest line on half a step.
    expect(ticks("oneRepMax", [97.5, 107])).toEqual(["97.5", "102.5", "107.5"]);
    expect(ticks("heaviest", [88, 92.5, 101.9])).toEqual(["85", "95", "105"]);
  });

  it("names thousands as exactly as their lines are spaced", () => {
    expect(ticks("sessionVolume", [12_000, 12_500])).toEqual(["12k", "12.25k", "12.5k"]);
    expect(ticks("sessionVolume", [4_000, 8_000])).toEqual(["4k", "6k", "8k"]);
    expect(ticks("bestSetVolume", [900, 1_100])).toEqual(["900", "1k", "1.1k"]);
    // Lines a few units apart in the thousands are written out rather than rounded in "k".
    expect(ticks("sessionVolume", [4_000, 4_005])).toEqual(["4,000", "4,002.5", "4,005"]);
    expect(ticks("sessionVolume", [1_000, 1_001])).toEqual(["1,000", "1,000.5", "1,001"]);
  });

  it("treats values equal but for float noise as one value", () => {
    // 580.6 padded by 5% either side (551.57–609.63): the first fitting lines are 50 apart.
    expect(ticks("sessionVolume", [580.6, 580.5999999999999])).toEqual(["550", "600", "650"]);
    expect(ticks("sessionVolume", [580.6])).toEqual(["550", "600", "650"]);
  });

  it("puts reps on whole numbers only", () => {
    expect(ticks("mostReps", [10, 15])).toEqual(["10", "15", "20"]);
    expect(ticks("mostReps", [2, 3])).toEqual(["2", "3", "4"]);
    expect(ticks("mostReps", [1])).toEqual(["0", "1", "2"]);
    expect(ticks("sessionReps", [24, 31])).toEqual(["20", "30", "40"]);
  });

  it("puts times on whole seconds a clock reads easily", () => {
    expect(ticks("longestDuration", [100, 105])).toEqual(["1:40", "1:45", "1:50"]);
    expect(ticks("longestDuration", [45])).toEqual(["0:40", "0:45", "0:50"]);
    // Two-minute lines from a minute, on the half step.
    expect(ticks("longestDuration", [90, 300])).toEqual(["1:00", "3:00", "5:00"]);
    expect(ticks("longestDuration", [3_000, 4_000])).toEqual(["50:00", "1:00:00", "1:10:00"]);
  });

  it("puts distances on whole metres", () => {
    const imperial = { distanceUnit: "miles", shortDistanceUnit: "yd" } as const;
    expect(ticks("longestDistance", [950, 1050], imperial)).toEqual([
      "0.59 mi",
      "0.621 mi",
      "0.652 mi",
    ]);
    expect(ticks("longestDistance", [950, 1050])).toEqual(["0.95 km", "1 km", "1.05 km"]);
    expect(ticks("longestDistance", [100, 105], imperial)).toEqual([
      "109.361 yd",
      "114.829 yd",
      "120.297 yd",
    ]);
    expect(ticks("longestDistance", [5_000, 5_050], imperial)).toEqual([
      "3.107 mi",
      "3.122 mi",
      "3.138 mi",
    ]);
    expect(ticks("longestDistance", [100, 105])).toEqual(["100 m", "105 m", "110 m"]);
    expect(ticks("longestDistance", [5_000, 5_050])).toEqual(["5 km", "5.025 km", "5.05 km"]);
  });
});

describe("records with rounding", () => {
  it("treats the same sets in another order as a tie, even when the sums differ in the last digit", () => {
    // 95, 135 and 135 lb × 5, stored in kilograms: added in the opposite order, the second sum
    // comes out a hair larger than the first.
    const kg = (lb: number) => lb / 2.20462;
    const sets = [95, 135, 135].map((lb) => ({ kg: kg(lb), reps: 5 }));
    const index = buildProgress(
      [
        tree(local(2026, 10, 1), 60, [{ exerciseId: "bench", sets }]),
        tree(local(2026, 11, 1), 60, [{ exerciseId: "bench", sets: [...sets].reverse() }]),
      ],
      options(),
    );
    const bench = index.byExercise.get("bench");
    if (!bench) throw new Error("bench missing");
    const [newer, older] = bench.sessions;
    // The premise: the sums aren't equal as floats.
    expect(newer?.best.volumeKg).toBeGreaterThan(older?.best.volumeKg ?? 0);
    const volume = exerciseRecords(bench).find((r) => r.metric === "sessionVolume");
    expect(volume?.startedAt).toBe(new Date(local(2026, 10, 1)).toISOString());
  });
});

describe("range starts in short months", () => {
  it("falls back to the last day of a shorter month", () => {
    expect(rangeStart("3M", local(2026, 5, 31, 9))).toBe(local(2026, 2, 28, 0));
    expect(rangeStart("3M", local(2028, 5, 31, 9))).toBe(local(2028, 2, 29, 0));
    expect(rangeStart("3M", local(2026, 3, 31, 9))).toBe(local(2025, 12, 31, 0));
    expect(rangeStart("3M", local(2026, 11, 30, 9))).toBe(local(2026, 8, 30, 0));
    expect(rangeStart("1Y", local(2028, 2, 29, 9))).toBe(local(2027, 2, 28, 0));
    expect(rangeStart("1Y", local(2027, 2, 28, 9))).toBe(local(2026, 2, 28, 0));
  });
});

describe("weeks at the edges of the calendar", () => {
  const withZone = (zone: string, fn: () => void) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  };
  const at = (time: number) =>
    tree(time, 60, [{ exerciseId: "row", sets: [{ kg: 50, reps: 10 }] }]);

  it("splits a day's sessions at local midnight, not at midnight UTC", () => {
    // Auckland is 13 hours ahead of UTC in December: 00:30 there is still the previous day in UTC,
    // and 23:30 the day before is the same UTC day as 12:00.
    withZone("Pacific/Auckland", () => {
      const row = (time: number, kg: number) =>
        tree(time, 30, [{ exerciseId: "row", sets: [{ kg, reps: 5 }] }]);
      const history = buildProgress(
        [
          row(new Date(2026, 11, 1, 23, 30).getTime(), 80),
          row(new Date(2026, 11, 2, 0, 30).getTime(), 60),
          row(new Date(2026, 11, 2, 12).getTime(), 70),
        ],
        options(),
      ).byExercise.get("row");
      if (!history) throw new Error("row missing");
      const points = metricPoints(history.sessions, "heaviest", rangeStart("All", NOW));
      expect(points.map((p) => p.value)).toEqual([80, 70]);
    });
  });

  it("keeps a week whole when the clocks go back", () => {
    // Berlin goes back an hour early on Sunday 25 October 2026: that week has 169 hours.
    withZone("Europe/Berlin", () => {
      const workouts = buildProgress(
        [
          at(local(2026, 10, 19, 0, 30)),
          at(local(2026, 10, 25, 23, 30)),
          at(local(2026, 10, 26, 0, 30)),
        ],
        options(),
      ).workouts;
      const now = local(2026, 10, 27, 12);
      const series = chartSeries(workouts, "3M", now, MONDAY);
      const [before, after] = series.buckets.slice(-2);
      expect(before).toMatchObject({ start: local(2026, 10, 19, 0), workouts: 2 });
      expect(after).toMatchObject({ start: local(2026, 10, 26, 0), workouts: 1 });
      expect((after?.start ?? 0) - (before?.start ?? 0)).toBe(169 * 3_600_000);
      expect(weekTotals(workouts, now, MONDAY).workouts).toBe(1);
    });
  });

  it("keeps a week whole when the clocks go forward", () => {
    // Berlin skips from 02:00 to 03:00 on Sunday 29 March 2026: that week has 167 hours.
    withZone("Europe/Berlin", () => {
      const workouts = buildProgress(
        [at(local(2026, 3, 29, 23, 30)), at(local(2026, 3, 30, 0, 30))],
        options(),
      ).workouts;
      const series = chartSeries(workouts, "3M", local(2026, 4, 2, 12), MONDAY);
      expect(series.buckets.map((b) => b.workouts).slice(-2)).toEqual([1, 1]);
      expect(series.buckets.at(-1)?.start).toBe(local(2026, 3, 30, 0));
    });
  });

  it("finds a week whose first midnight doesn't exist", () => {
    // Santiago skips from 00:00 to 01:00 on Sunday 6 September 2026.
    withZone("America/Santiago", () => {
      const workouts = buildProgress(
        [at(local(2026, 9, 6, 10)), at(local(2026, 9, 8, 10))],
        options(),
      ).workouts;
      const series = chartSeries(workouts, "3M", local(2026, 9, 9, 12), 0);
      expect(series.buckets).toHaveLength(12);
      expect(series.buckets.at(-1)).toMatchObject({ workouts: 2 });
      expect(new Date(series.buckets.at(-1)?.start ?? 0).getDate()).toBe(6);
    });
  });

  it("runs a week across the new year", () => {
    // Monday 28 December 2026 to Sunday 3 January 2027.
    const workouts = buildProgress(
      [at(local(2026, 12, 27)), at(local(2026, 12, 28)), at(local(2027, 1, 2))],
      options(),
    ).workouts;
    const now = local(2027, 1, 1, 12);
    expect(weekTotals(workouts, now, MONDAY)).toMatchObject({
      start: local(2026, 12, 28, 0),
      end: local(2027, 1, 4, 0),
      workouts: 2,
    });
    const series = chartSeries(workouts, "3M", now, MONDAY);
    expect(series.buckets.map((b) => b.workouts).slice(-2)).toEqual([1, 2]);
    // That week holds 1 January, so it carries January's name, in 2027.
    expect(monthMarks(series).at(-1)).toEqual({ index: 11, month: 0, year: 2027 });
  });

  it("switches all time to months once the first workout is more than 52 weeks back", () => {
    // The 52nd week back from the week of Thu 12 Nov 2026 starts on Mon 17 Nov 2025.
    const inYear = chartSeries(
      buildProgress([at(local(2025, 11, 17, 10))], options()).workouts,
      "All",
      NOW,
      MONDAY,
    );
    expect(inYear.unit).toBe("week");
    expect(inYear.buckets).toHaveLength(52);
    expect(inYear.buckets[0]?.workouts).toBe(1);
    const dayBefore = chartSeries(
      buildProgress([at(local(2025, 11, 16, 10))], options()).workouts,
      "All",
      NOW,
      MONDAY,
    );
    expect(dayBefore.unit).toBe("month");
    // November 2025 to November 2026.
    expect(dayBefore.buckets).toHaveLength(13);
    expect(dayBefore.buckets[0]).toMatchObject({ start: local(2025, 11, 1, 0), workouts: 1 });
  });
});

describe("weighted bodyweight exercises", () => {
  // Weighted dips counting bodyweight (80 kg), with added weight on some sets.
  const index = buildProgress(
    [
      tree(local(2026, 11, 2), 45, [
        {
          exerciseId: "dip",
          type: "weighted_bodyweight",
          sets: [
            { kg: 20, reps: 8 },
            { kg: 0, reps: 10 },
            { kg: 25, reps: 5 },
          ],
        },
      ]),
    ],
    options({ usesBodyweight: (id) => id === "dip" }),
  );
  const dip = index.byExercise.get("dip");
  if (!dip) throw new Error("dip missing");

  it("charts added weight, reps and volume, with no one-rep max", () => {
    expect(exerciseMetrics("weighted_bodyweight", true)).toEqual([
      "heaviest",
      "mostReps",
      "sessionReps",
      "bestSetVolume",
      "sessionVolume",
    ]);
    expect(chartName("heaviest", "weighted_bodyweight")).toBe("Most added weight");
    // Volumes: (80 + 20) × 8 = 800, 80 × 10 = 800, (80 + 25) × 5 = 525.
    expect(dip.sessions[0]?.best).toEqual({
      heaviestKg: 25,
      oneRepMaxKg: null,
      bestSetVolumeKg: 800,
      volumeKg: 2125,
      mostReps: 10,
      reps: 23,
      longestSeconds: null,
      longestMeters: null,
    });
  });

  it("keeps its records", () => {
    expect(exerciseRecords(dip).map((r) => [r.metric, r.value])).toEqual([
      ["heaviest", 25],
      ["bestSetVolume", 800],
      ["sessionVolume", 2125],
      ["mostReps", 10],
    ]);
  });
});

it("reads each set with the recorded measures and units", () => {
  const prefs = { distanceUnit: "miles", shortDistanceUnit: "yd" } as const;
  const sample = { ...set({ kg: 25, reps: 9, seconds: 70, meters: 500 }), count: 1 };
  expect(sessionSetLabel("weight_reps", { ...sample, repsInReserve: 0 }, "kg", prefs)).toBe(
    "25 kg × 9 reps · 0 reps in reserve",
  );
  expect(sessionSetLabel("bodyweight_reps", { ...sample, repsInReserve: 1 }, "kg", prefs)).toBe(
    "9 reps · 1 rep in reserve",
  );
  expect(sessionSetLabel("steps_duration", { ...sample, repsInReserve: 2 }, "kg", prefs)).toBe(
    "1 step · 1:10",
  );
  expect(sessionSetLabel("weight_reps", sample, "kg", prefs)).toBe("25 kg × 9 reps");
  expect(sessionSetLabel("assisted_bodyweight", sample, "lbs", prefs)).toBe(
    `−${(55.1).toLocaleString()} lbs × 9 reps`,
  );
  expect(sessionSetLabel("weighted_bodyweight", sample, "kg", prefs)).toBe("+25 kg × 9 reps");
  expect(sessionSetLabel("bodyweight_reps", { ...sample, reps: 1 }, "kg", prefs)).toBe("1 rep");
  expect(sessionSetLabel("distance_duration", sample, "kg", prefs)).toBe("547 yd · 1:10");
  expect(
    sessionSetLabel("distance_duration", { ...sample, distanceMeters: 4828.02 }, "kg", prefs),
  ).toBe("3 mi · 1:10");
  expect(sessionSetLabel("steps_duration", sample, "kg", prefs)).toBe("1 step · 1:10");
  expect(sessionSetLabel("weight_reps", set({ reps: 0 }), "kg", prefs)).toBe("— kg × 0 reps");
});

it("marks records at the time earned, keeping earlier ties and combining repeated entries", () => {
  const bench = (kg: number, reps: number) => ({
    exerciseId: "bench",
    name: "Bench Press",
    sets: [{ kg, reps }],
  });
  const earlier = tree(1000, 1, [bench(90, 10)]);
  const saved = tree(2000, 1, [
    bench(95, 2),
    { ...bench(140, 2), sets: [{ kg: 140, reps: 2, type: "warmup" }] },
    { exerciseId: "plank", type: "duration", sets: [{ seconds: 45 }] },
  ]);
  const tied = tree(3000, 1, [bench(95, 2)]);
  const later = tree(4000, 1, [bench(105, 12)]);
  const index = buildProgress([later, tied, earlier, saved], options());
  expect(
    workoutRecords(index, saved).map(({ exerciseId, records }) => [
      exerciseId,
      records.map((r) => [r.metric, r.value]),
    ]),
  ).toEqual([
    ["bench", [["heaviest", 95]]],
    ["plank", [["longestDuration", 45]]],
  ]);
  expect(workoutRecords(index, tied)).toEqual([]);
});

describe("Progress lists", () => {
  it("lists the latest records newest workout first, up to the limit", () => {
    const first = tree(local(2026, 10, 1), 30, [
      { exerciseId: "bench", sets: [{ kg: 60, reps: 5 }] },
    ]);
    const second = tree(local(2026, 10, 8), 30, [
      { exerciseId: "bench", sets: [{ kg: 70, reps: 5 }] },
    ]);
    const flat = tree(local(2026, 10, 15), 30, [
      { exerciseId: "bench", sets: [{ kg: 50, reps: 5 }] },
    ]);
    const index = buildProgress([first, second, flat], options());
    const records = recentRecords(index, 3);
    // The flat session beat nothing; the second beat the first on each measure it applies to.
    expect(records.every((r) => r.workoutId === second.workout.id)).toBe(true);
    expect(records).toHaveLength(3);
    expect(records[0]?.before).not.toBeNull();
    expect(recentRecords(index, 50).at(-1)?.workoutId).toBe(first.workout.id);
    expect(recentRecords(buildProgress([], options()), 5)).toEqual([]);
  });

  it("picks the lifts trained most in three months, with their first measure's recent trend", () => {
    const w = (day: number, entries: EntrySpec[]) => tree(local(2026, 11, day), 30, entries);
    const index = buildProgress(
      [
        // Long ago, many squats: they count only after the recent ones.
        ...[1, 2, 3, 4].map((m) =>
          tree(local(2025, m, 1), 30, [{ exerciseId: "squat", sets: [{ kg: 100, reps: 5 }] }]),
        ),
        w(2, [{ exerciseId: "bench", sets: [{ kg: 60, reps: 5 }] }]),
        w(5, [
          { exerciseId: "bench", sets: [{ kg: 65, reps: 5 }] },
          { exerciseId: "pullup", type: "bodyweight_reps", sets: [{ reps: 8 }] },
        ]),
        w(9, [{ exerciseId: "bench", sets: [{ kg: 70, reps: 1 }] }]),
      ],
      options(),
    );
    const lifts = mainLifts(index, NOW, 2);
    expect(lifts.map((l) => l.history.exerciseId)).toEqual(["bench", "pullup"]);
    const bench = lifts[0];
    expect(bench?.metric).toBe("oneRepMax");
    expect(bench?.values).toEqual([70, 65 * (1 + 5 / 30), 60 * (1 + 5 / 30)].reverse());
    expect(bench?.latest).toBe(70);
    expect(bench?.change).toBeCloseTo(70 - 70);
    expect(lifts[1]?.metric).toBe("mostReps");
    expect(mainLifts(index, NOW, 5).map((l) => l.history.exerciseId)).toEqual([
      "bench",
      "pullup",
      "squat",
    ]);
  });
});
