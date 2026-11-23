import { METRICS_BY_TYPE } from "@leve/core";
import { describe, expect, it } from "vitest";
import { builtInExercise } from "../src/data/exercises.ts";
import {
  correctionValues,
  missingMeasurements,
  parseTyped,
  resolveLog,
} from "../src/model/log-values.ts";
import type { RoutineSet, WorkoutSet } from "../src/model/types.ts";

const set: WorkoutSet = {
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
};
const target: RoutineSet = {
  id: "t",
  type: "normal",
  weightKg: 80,
  reps: null,
  repRangeMin: 6,
  repRangeMax: 8,
  durationSeconds: null,
};
const previous = {
  count: null,
  distanceMeters: null,
  weightKg: 90,
  reps: 8,
  durationSeconds: null,
};
/** `prev` null means no previous values (undefined would take the default). */
const log = (
  draft: Record<string, string>,
  unit: "kg" | "lbs" = "kg",
  prev: typeof previous | null = previous,
) =>
  resolveLog({
    set,
    metrics: ["weight", "reps"],
    draft,
    previous: prev ?? undefined,
    target,
    unit,
  });

describe("reading typed values", () => {
  it("takes decimals with a point or a comma, and converts pounds", () => {
    expect(parseTyped("weight", "82.5", "kg")).toBe(82.5);
    expect(parseTyped("weight", " 82,5 ", "kg")).toBe(82.5);
    expect(parseTyped("weight", "100", "lbs")).toBe(45.359);
    expect(parseTyped("weight", "", "kg")).toBeNull();
  });

  it("refuses what isn't a plain number", () => {
    for (const text of ["-5", "abc", "1,000.5", "8.5e2", "1 000"]) {
      expect(parseTyped("weight", text, "kg"), text).toBe("invalid");
    }
    expect(parseTyped("reps", "8.5", "kg")).toBe("invalid");
  });

  it("reads durations as seconds or minutes and seconds", () => {
    expect(parseTyped("duration", "90", "kg")).toBe(90);
    expect(parseTyped("duration", "1:30", "kg")).toBe(90);
    expect(parseTyped("duration", "1:02:03", "kg")).toBe(3723);
    expect(parseTyped("duration", "1:75", "kg")).toBe("invalid");
  });
});

describe("the values a set is logged with", () => {
  it("uses what was typed, else last time's values, else the routine's target", () => {
    expect(log({ weight: "82.5", reps: "7" })).toEqual({ values: { weightKg: 82.5, reps: 7 } });
    expect(log({})).toEqual({ values: { weightKg: 90, reps: 8 } });
    expect(log({}, "kg", null)).toEqual({ values: { weightKg: 80, reps: 6 } });
    expect(log({ weight: "200" }, "lbs")).toEqual({ values: { weightKg: 90.719, reps: 8 } });
  });

  it("keeps a new rep set open until there are reps, with or without a load", () => {
    const options = {
      set,
      metrics: ["weight", "reps"] as const,
      unit: "kg" as const,
      previous: undefined,
      target: undefined,
    };
    for (const draft of [{}, { weight: "20", reps: " " }]) {
      expect(resolveLog({ ...options, draft })).toMatchObject({
        missing: "reps",
        error: expect.any(String),
      });
    }
    expect(resolveLog({ ...options, draft: { weight: "20", reps: "8" } })).toEqual({
      values: { weightKg: 20, reps: 8 },
    });
    expect(resolveLog({ ...options, draft: { reps: "8" } })).toEqual({
      values: { weightKg: null, reps: 8 },
    });
  });

  it("logs the distance of a standing long jump without a load or time", () => {
    const jump = builtInExercise("builtin:standing-long-jump");
    if (!jump) throw new Error("Missing standing long jump");
    expect(
      resolveLog({
        set,
        metrics: METRICS_BY_TYPE[jump.type],
        unit: "kg",
        distanceUnit: "m",
        previous: undefined,
        target: undefined,
        draft: { distance: "2.4" },
      }),
    ).toEqual({ values: { weightKg: null, distanceMeters: 2.4 } });
  });

  it("requires time on timed sets and accepts the time shown in the field", () => {
    const options = {
      set,
      metrics: ["duration"] as const,
      unit: "kg" as const,
      previous: undefined,
      target: undefined,
      draft: {},
    };
    expect(resolveLog(options)).toMatchObject({ missing: "duration", error: expect.any(String) });
    expect(resolveLog({ ...options, draft: { duration: "1:30" } })).toEqual({
      values: { durationSeconds: 90 },
    });
    expect(resolveLog({ ...options, previous: { ...previous, durationSeconds: 60 } })).toEqual({
      values: { durationSeconds: 60 },
    });
    expect(resolveLog({ ...options, target: { ...target, durationSeconds: 30 } })).toEqual({
      values: { durationSeconds: 30 },
    });
  });

  it("keeps the displayed stored weight after undo or add-set until the lifter overrides it", () => {
    const options = {
      set: { ...set, weightKg: 100 },
      metrics: ["weight"] as const,
      target,
      unit: "kg" as const,
    };
    expect(resolveLog({ ...options, draft: {}, previous })).toEqual({ values: { weightKg: 100 } });
    expect(resolveLog({ ...options, draft: {}, previous: undefined })).toEqual({
      values: { weightKg: 100 },
    });
    expect(resolveLog({ ...options, draft: { weight: "95" }, previous })).toEqual({
      values: { weightKg: 95 },
    });
  });

  it("refuses text it can't read and values the contract doesn't allow", () => {
    expect(log({ weight: "heavy" })).toEqual({ error: "Enter the weight as a number." });
    expect(log({ weight: "2500" })).toEqual({ error: "That weight is out of range." });
    expect(log({ reps: "20000" })).toEqual({ error: "That reps is out of range." });
  });
});

it("corrects only touched metrics and distinguishes clearing a value from leaving it alone", () => {
  expect(correctionValues({ reps: "6" }, "lbs")).toEqual({ reps: 6 });
  expect(correctionValues({ weight: "", duration: "1:20" }, "kg")).toEqual({
    weightKg: null,
    durationSeconds: 80,
  });
  expect(() => correctionValues({ reps: "eight" }, "kg")).toThrow(/number/);
});

it("converts just the distance typed in the selected unit, preserving untouched metres", () => {
  const stored = { ...set, durationSeconds: 45, distanceMeters: 983.123456789 };
  const options = {
    set: stored,
    target: undefined,
    previous: undefined,
    unit: "kg" as const,
    metrics: ["distance", "duration"] as const,
    distanceUnit: "yd" as const,
  };
  expect(resolveLog({ ...options, draft: { duration: "30" } })).toEqual({
    values: { distanceMeters: 983.123456789, durationSeconds: 30 },
  });
  expect(resolveLog({ ...options, draft: { distance: "12,5" } })).toEqual({
    values: { distanceMeters: 11.43, durationSeconds: 45 },
  });
  expect(resolveLog({ ...options, distanceUnit: "miles", draft: { distance: "10000" } })).toEqual({
    error: "That distance is out of range.",
  });
  expect(
    resolveLog({
      ...options,
      set,
      draft: {},
      previous: { ...previous, durationSeconds: 60, distanceMeters: 3218.68 },
    }),
  ).toEqual({
    values: { distanceMeters: 3218.68, durationSeconds: 60 },
  });
  expect(
    resolveLog({
      ...options,
      set,
      draft: {},
      target: { ...target, durationSeconds: 75, distanceMeters: 1609.34 },
    }),
  ).toEqual({
    values: { distanceMeters: 1609.34, durationSeconds: 75 },
  });
  expect(correctionValues({ distance: "1.5" }, "kg", "km")).toEqual({ distanceMeters: 1500 });
  expect(correctionValues({ distance: "1" }, "kg", "miles")).toEqual({ distanceMeters: 1609.34 });
  expect(correctionValues({ distance: "" }, "kg", "yd")).toEqual({ distanceMeters: null });
  expect(correctionValues({ duration: "40" }, "kg", "yd")).toEqual({ durationSeconds: 40 });
});

it("logs weight and distance together using their independent units", () => {
  expect(
    resolveLog({
      set,
      metrics: ["weight", "distance"],
      draft: { weight: "100", distance: "50" },
      target: undefined,
      previous: undefined,
      unit: "lbs",
      distanceUnit: "yd",
    }),
  ).toEqual({ values: { weightKg: 45.359, distanceMeters: 45.72 } });
});

it("identifies missing measurements on logged sets, including after a correction", () => {
  const logged = { ...set, completedAt: "2026-11-18T10:00:00Z" };
  expect(missingMeasurements("weight_reps", set)).toEqual([]);
  expect(missingMeasurements("weight_reps", { ...logged, weightKg: 20 })).toEqual(["reps"]);
  expect(missingMeasurements("weight_reps", { ...logged, reps: 8 })).toEqual([]);
  expect(missingMeasurements("bodyweight_reps", { ...logged, reps: 0 })).toEqual([]);
  expect(missingMeasurements("duration", { ...logged, type: "warmup" })).toEqual(["duration"]);
  expect(missingMeasurements("distance_duration", { ...logged, distanceMeters: 30 })).toEqual([
    "duration",
  ]);
  expect(missingMeasurements("steps_duration", logged)).toEqual(["count", "duration"]);
});
