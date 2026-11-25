import { describe, expect, it } from "vitest";
import { blankRow, followingRow, nextSetType, resolveRows } from "../src/model/historical-log.ts";
import {
  autoTitle,
  currentEntryIndex,
  hintTarget,
  previousSets,
  restCaption,
  routineTarget,
  sessionBefore,
  setProgress,
  startWorkout,
} from "../src/model/live.ts";
import type { WorkoutTree } from "../src/model/past-workouts.ts";
import type { Routine, WorkoutSet } from "../src/model/types.ts";

let n = 0;
const newId = () => `id-${++n}`;
const routine = {
  id: "push",
  content: {
    title: "Push day",
    notes: "",
    folderId: null,
    position: 1,
    exercises: [
      {
        id: "x1",
        exerciseId: "bench",
        exerciseName: "Bench Press",
        exerciseType: "weight_reps",
        restSeconds: 120,
        useRepRange: true,
        sets: [
          {
            id: "t1",
            type: "warmup",
            weightKg: 40,
            reps: null,
            repRangeMin: 10,
            repRangeMax: 10,
            durationSeconds: null,
          },
          {
            id: "t2",
            type: "normal",
            weightKg: 80,
            reps: null,
            repRangeMin: 6,
            repRangeMax: 8,
            durationSeconds: null,
          },
        ],
      },
    ],
  } satisfies Routine,
};
const set = (overrides: Partial<WorkoutSet>): WorkoutSet => ({
  workoutExerciseId: "e",
  position: 1,
  type: "normal",
  weightKg: null,
  reps: null,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
  ...overrides,
});
const tree = (
  id: string,
  startedAt: string,
  ended: boolean,
  routineId: string | null,
  sets: Partial<WorkoutSet>[],
): WorkoutTree => ({
  workout: {
    id,
    content: {
      title: id,
      description: "",
      startedAt,
      endedAt: ended ? startedAt : null,
      routineId,
    },
  },
  entries: [
    {
      entry: {
        id: `${id}-e`,
        content: {
          workoutId: id,
          exerciseId: "bench",
          exerciseName: "Bench Press",
          exerciseType: "weight_reps",
          position: 1,
          supersetId: null,
          restSeconds: 120,
          doubleDumbbellVolume: false,
        },
      },
      sets: sets.map((s, i) => ({ id: `${id}-s${i}`, content: set({ position: i + 1, ...s }) })),
    },
  ],
});

describe("starting a workout", () => {
  it("copies a routine's exercises and targets, with nothing done yet", () => {
    const started = startWorkout({ routine, now: Date.parse("2026-11-12T18:00:00.000Z"), newId });
    expect(started.workout.content).toMatchObject({
      title: "Push day",
      description: "",
      startedAt: "2026-11-12T18:00:00.000Z",
      endedAt: null,
      routineId: "push",
    });
    expect(
      started.entries.map((e) => [
        e.content.exerciseName,
        e.content.position,
        e.content.restSeconds,
      ]),
    ).toEqual([["Bench Press", 1, 120]]);
    expect(
      started.sets.map((s) => [
        s.content.type,
        s.content.weightKg,
        s.content.reps,
        s.content.completedAt,
      ]),
    ).toEqual([
      ["warmup", null, null, null],
      ["normal", null, null, null],
    ]);
  });

  it("keeps the working set target after removing its preceding warm-up", () => {
    const started = startWorkout({ routine, now: 0, newId });
    started.sets.shift();
    const [working] = started.sets;
    const [bench] = started.entries;
    if (!working || !bench) throw new Error("Expected a remaining working set");
    expect(
      routineTarget(started.workout.content.initialPlan ?? null, working.content),
    ).toMatchObject({
      type: "normal",
      weightKg: 80,
      repRangeMin: 6,
      repRangeMax: 8,
    });
  });

  it("hints the routine weight only until a weight was logged at that set", () => {
    const started = startWorkout({ routine, now: 0, newId });
    const plan = started.workout.content.initialPlan ?? null;
    const working = started.sets[1];
    if (!working) throw new Error("Expected a working set");
    const goals = { repRangeMin: 6, repRangeMax: 8 };
    expect(hintTarget(plan, working.content, undefined)).toMatchObject({ weightKg: 80, ...goals });
    const bodyweight = {
      weightKg: null,
      reps: 12,
      durationSeconds: null,
      distanceMeters: null,
      count: null,
    };
    expect(hintTarget(plan, working.content, bodyweight)).toMatchObject({ weightKg: 80, ...goals });
    const lifted = { ...bodyweight, weightKg: 92.5, reps: 6 };
    expect(hintTarget(plan, working.content, lifted)).toMatchObject({ weightKg: null, ...goals });
    // Logging defaults still read the full routine target.
    expect(routineTarget(plan, working.content)?.weightKg).toBe(80);
  });

  it("starts empty without a routine", () => {
    const started = startWorkout({ now: 0, newId });
    expect(started.workout.content.title).toBe("");
    expect(started.entries).toEqual([]);
  });
});

describe("while logging", () => {
  const done = "2026-11-12T18:05:00.000Z";
  const history = [
    tree("old", "2026-10-01T18:00:00.000Z", true, "push", [
      { weightKg: 70, reps: 8, completedAt: done },
    ]),
    tree("other", "2026-11-05T18:00:00.000Z", true, null, [
      { weightKg: 75, reps: 9, completedAt: done },
      { weightKg: 75, reps: null, completedAt: null },
    ]),
    tree("running", "2026-11-12T18:00:00.000Z", false, "push", []),
  ];

  it("takes previous values from the latest finished workout, or the same routine", () => {
    expect(
      previousSets(history, "bench", {
        mode: "any_workout",
        routineId: "push",
        exceptWorkoutId: "running",
        plannedTypes: ["normal"],
      }),
    ).toEqual([
      { weightKg: 75, reps: 9, durationSeconds: null, distanceMeters: null, count: null },
    ]);
    expect(
      previousSets(history, "bench", {
        mode: "same_routine",
        routineId: "push",
        exceptWorkoutId: "running",
        plannedTypes: ["normal"],
      }),
    ).toEqual([
      { weightKg: 70, reps: 8, durationSeconds: null, distanceMeters: null, count: null },
    ]);
    expect(
      previousSets(history, "squat", {
        mode: "any_workout",
        routineId: null,
        exceptWorkoutId: "running",
        plannedTypes: ["normal"],
      }),
    ).toEqual([]);
  });

  it("uses the latest recorded entry when the first occurrence of a lift was emptied", () => {
    const latest = tree("latest", done, true, "push", [
      { weightKg: 85, reps: 6, completedAt: done },
    ]);
    const recorded = latest.entries[0];
    if (!recorded) throw new Error("Missing recorded Bench Press");
    latest.entries.unshift({ entry: { ...recorded.entry, id: "emptied-bench" }, sets: [] });
    expect(
      previousSets([...history, latest], "bench", {
        mode: "any_workout",
        routineId: "push",
        exceptWorkoutId: "running",
        plannedTypes: ["normal"],
      }),
    ).toEqual([
      { weightKg: 85, reps: 6, durationSeconds: null, distanceMeters: null, count: null },
    ]);
  });

  it("pairs working sets and warm-ups independently and leaves missing suggestions empty", () => {
    const last = tree("last", done, true, "push", [
      { type: "warmup", weightKg: 47.5, reps: 10, completedAt: done },
      { weightKg: 92.5, reps: 8, completedAt: done },
      { type: "failure", weightKg: 92.5, reps: 7, completedAt: done },
    ]);
    const values = previousSets([last], "bench", {
      mode: "same_routine",
      routineId: "push",
      exceptWorkoutId: "running",
      plannedTypes: ["normal", "warmup", "drop", "normal", "normal"],
    });
    expect(values.map((s) => s && [s.weightKg, s.reps])).toEqual([
      [92.5, 8],
      [47.5, 10],
      undefined,
      [92.5, 7],
      undefined,
    ]);
  });

  it("renumbers the next set when a previous set becomes a warm-up", () => {
    const workout = tree("today", done, false, null, [{ completedAt: done }, {}, {}]);
    const entry = workout.entries[0];
    const first = entry?.sets[0];
    const next = entry?.sets[1];
    if (!first || !next) throw new Error("incomplete fixture");
    expect(restCaption(workout, 0)).toBe("Next: Bench Press · set 2");
    first.content.type = "warmup";
    expect(restCaption(workout, 0)).toBe("Next: Bench Press · set 1");
  });

  it("points back to the unfinished exercise when the last exercise is logged first", () => {
    const workout = tree("today", done, false, null, [{}]);
    const second = tree("press", done, false, null, [{}]).entries[0];
    const firstSet = workout.entries[0]?.sets[0];
    if (!second || !firstSet) throw new Error("Missing test fixture");
    second.entry.content.exerciseName = "Overhead Press";
    workout.entries.push(second);
    expect(restCaption(workout, 1)).toBe("Next: Overhead Press · set 1");
    const otherSet = second.sets[0];
    if (!otherSet) throw new Error("Missing second set");
    otherSet.content.completedAt = done;
    expect(restCaption(workout, 1)).toBe("Next: Bench Press · set 1");
    firstSet.content.completedAt = done;
    expect(restCaption(workout, 1)).toBe("All sets logged");
    second.sets.push({
      id: "added",
      content: { ...otherSet.content, position: 2, completedAt: null },
    });
    expect(restCaption(workout, 1)).toBe("Next: Overhead Press · set 2");
  });

  it("works on the first exercise with a set left, and counts progress", () => {
    const t = tree("w", "2026-11-12T18:00:00.000Z", false, null, [{ completedAt: done }, {}]);
    expect(currentEntryIndex(t)).toBe(0);
    expect(setProgress(t)).toEqual({ done: 1, total: 2 });
    const all = tree("w", "2026-11-12T18:00:00.000Z", false, null, [{ completedAt: done }]);
    expect(currentEntryIndex(all)).toBe(0);
  });

  it("names an untitled workout after the time of day it started", () => {
    const at = (h: number) => new Date(2026, 10, 12, h, 30).toISOString();
    expect([7, 13, 19, 23, 3].map((h) => autoTitle(at(h)))).toEqual([
      "Morning workout",
      "Afternoon workout",
      "Evening workout",
      "Night workout",
      "Night workout",
    ]);
  });
});

describe("filling in a finished workout", () => {
  it("starts from the latest finished session before it, never a later or unfinished one", () => {
    const history = [
      tree("older", "2026-11-04T08:00:00.000Z", true, null, [{ weightKg: 30, completedAt: "x" }]),
      tree("before", "2026-11-11T08:00:00.000Z", true, null, [
        { weightKg: 45, completedAt: "x", position: 2 },
        { weightKg: 99, completedAt: null },
        { type: "warmup", weightKg: 20, completedAt: "x", position: 1 },
      ]),
      tree("this", "2026-11-18T08:00:00.000Z", true, null, [{ weightKg: 70, completedAt: "x" }]),
      tree("later", "2026-11-22T08:00:00.000Z", true, null, [{ weightKg: 90, completedAt: "x" }]),
      tree("running", "2026-11-17T08:00:00.000Z", false, null, [
        { weightKg: 80, completedAt: "x" },
      ]),
    ];
    const found = sessionBefore(history, "bench", {
      before: "2026-11-18T08:00:00.000Z",
      exceptWorkoutId: "this",
    });
    expect(found?.startedAt).toBe("2026-11-11T08:00:00.000Z");
    expect(
      sessionBefore(history, "bench", {
        before: "2026-11-18T08:00:00.000Z",
        exceptWorkoutId: "before",
      })?.startedAt,
    ).toBe("2026-11-04T08:00:00.000Z");
    expect(found?.sets.map((s) => [s.type, s.weightKg])).toEqual([
      ["warmup", 20],
      ["normal", 45],
    ]);
    expect(
      sessionBefore(history, "bench", { before: "2026-11-04T08:00:00.000Z", exceptWorkoutId: "" }),
    ).toBeNull();
    expect(
      sessionBefore(history, "squat", { before: "2026-12-01T00:00:00.000Z", exceptWorkoutId: "" }),
    ).toBeNull();
  });

  it("repeats the row above, skips blank rows and names the exercise and set it refuses", () => {
    const warmup = {
      id: "a",
      type: "warmup" as const,
      draft: { weight: "20", reps: "10" },
      effort: "",
    };
    expect(followingRow([warmup], "b")).toEqual({
      id: "b",
      type: "normal",
      draft: { weight: "20", reps: "10" },
      effort: "",
    });
    expect(followingRow([], "c")).toEqual({ id: "c", type: "normal", draft: {}, effort: "" });
    expect(nextSetType("failure")).toBe("normal");
    const options = {
      exercise: "Bench Press",
      entryId: "entry",
      metrics: ["weight", "reps"] as const,
      unit: "kg" as const,
      distanceUnit: "m" as const,
      effortScale: "rir" as const,
      recordsEffort: true,
    };
    const blank = { id: "x", type: "normal" as const, draft: { weight: " " }, effort: "" };
    expect(blankRow(blank)).toBe(true);
    expect(resolveRows([blank], options)).toEqual({ error: "Enter a set for Bench Press." });
    const working = { id: "w", type: "normal" as const, draft: { weight: "60" }, effort: "" };
    expect(resolveRows([warmup, blank, working], options)).toEqual({
      error: "Bench Press, set 3: Enter reps to log this set.",
    });
    expect(
      resolveRows([{ ...working, draft: { weight: "60", reps: "5" }, effort: "11" }], options),
    ).toEqual({
      error: "Bench Press, set 1: Enter a whole number from 0 to 10 for reps in reserve.",
    });
    // Effort typed before it stopped being recordable isn't saved, and alone makes no set.
    const hidden = { ...options, recordsEffort: false };
    expect(resolveRows([{ ...blank, effort: "2" }], hidden)).toEqual({
      error: "Enter a set for Bench Press.",
    });
    const withoutEffort = resolveRows(
      [{ ...working, draft: { weight: "60", reps: "5" }, effort: "2" }],
      hidden,
    );
    expect("sets" in withoutEffort && withoutEffort.sets[0]?.content.repsInReserve).toBeUndefined();
    const resolved = resolveRows(
      [warmup, blank, { ...working, draft: { weight: "60", reps: "5" }, effort: "2" }],
      options,
    );
    expect(
      "sets" in resolved &&
        resolved.sets.map(({ id, content }) => [
          id,
          content.workoutExerciseId,
          content.type,
          content.weightKg,
          content.reps,
          content.repsInReserve,
        ]),
    ).toEqual([
      ["a", "entry", "warmup", 20, 10, undefined],
      ["w", "entry", "normal", 60, 5, 2],
    ]);
  });
});
