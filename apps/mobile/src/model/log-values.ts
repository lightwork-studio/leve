import { leveContract } from "@leve/contract";
import {
  distanceToMetres,
  type ExerciseType,
  METRICS_BY_TYPE,
  type SetDistanceUnit,
  type SetMetric,
  type WeightUnit,
  weightToKg,
} from "@leve/core";
import type { PreviousSet } from "./live.ts";
import type { PlanTarget, WorkoutSet } from "./types.ts";

/** What the user typed into a set's fields, by metric. */
export type Draft = Partial<Record<SetMetric, string>>;

const FIELD = {
  weight: "weightKg",
  reps: "reps",
  duration: "durationSeconds",
  distance: "distanceMeters",
  count: "count",
} as const satisfies Record<SetMetric, keyof WorkoutSet>;

export const storedValue = (set: Pick<WorkoutSet, (typeof FIELD)[SetMetric]>, metric: SetMetric) =>
  set[FIELD[metric]];

const NAMES: Record<SetMetric, string> = {
  weight: "weight",
  reps: "reps",
  duration: "time",
  distance: "distance",
  count: "count",
};

/** A logged set can carry a load without a record of how much work was done. */
export function missingMeasurements(type: string, set: WorkoutSet): SetMetric[] {
  if (set.completedAt === null) return [];
  const metrics = METRICS_BY_TYPE[type as ExerciseType] ?? ["weight", "reps"];
  return metrics.filter((metric) => metric !== "weight" && storedValue(set, metric) === null);
}

export function measurementName(metric: SetMetric, type: string): string {
  if (metric === "count") return type === "steps_duration" ? "steps" : "floors";
  return NAMES[metric];
}

/**
 * A typed value in stored units: null when empty, "invalid" when it isn't a number in the
 * expected form. Decimals take "." or ","; durations take seconds or m:ss / h:mm:ss; reps and
 * counts are whole numbers.
 */
export function parseTyped(
  metric: SetMetric,
  text: string,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit = "m",
): number | null | "invalid" {
  const value = text.trim();
  if (value === "") return null;
  if (metric === "duration" && value.includes(":")) {
    const parts = value.split(":");
    if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return "invalid";
    const numbers = parts.map(Number);
    if (numbers.slice(1).some((n) => n >= 60)) return "invalid";
    return numbers.reduce((total, n) => total * 60 + n, 0);
  }
  if (!/^\d+([.,]\d+)?$/.test(value)) return "invalid";
  const number = Number(value.replace(",", "."));
  if ((metric === "reps" || metric === "count") && !Number.isInteger(number)) return "invalid";
  if (metric === "distance") return distanceToMetres(number, distanceUnit);
  return metric === "weight" ? Math.round(weightToKg(number, unit) * 1000) / 1000 : number;
}

/** A correction writes only fields the lifter touched, preserving untouched precision and metadata. */
export function correctionValues(
  draft: Draft,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit = "m",
): Partial<Pick<WorkoutSet, (typeof FIELD)[SetMetric]>> {
  const patch: Partial<Pick<WorkoutSet, (typeof FIELD)[SetMetric]>> = {};
  for (const metric of Object.keys(draft) as SetMetric[]) {
    const parsed = parseTyped(metric, draft[metric] ?? "", unit, distanceUnit);
    if (parsed === "invalid") throw new Error(`Enter the ${NAMES[metric]} as a number.`);
    patch[FIELD[metric]] = parsed;
  }
  return patch;
}

/** The routine's target for a metric, if it sets one. */
export function targetValue(target: PlanTarget | undefined, metric: SetMetric): number | null {
  if (!target) return null;
  if (metric === "count") return target.count ?? null;
  if (metric === "distance") return target.distanceMeters ?? null;
  if (metric === "weight") return target.weightKg;
  if (metric === "reps") return target.repRangeMin ?? target.reps;
  if (metric === "duration") return target.durationSeconds;
  return null;
}

/** Last time's value for a metric, if known. */
export function previousValue(previous: PreviousSet | undefined, metric: SetMetric): number | null {
  return previous ? storedValue(previous, metric) : null;
}

/**
 * The values a set is logged with (provisional rule): what was typed, else the stored value, else last time's value at
 * that position, else the routine's target. Refuses text it can't read and values the contract
 * doesn't allow, so nothing invalid reaches the store.
 */
export function resolveLog(options: {
  set: WorkoutSet;
  metrics: readonly SetMetric[];
  draft: Draft;
  previous: PreviousSet | undefined;
  target: PlanTarget | undefined;
  unit: WeightUnit;
  distanceUnit?: SetDistanceUnit;
}): { values: Partial<WorkoutSet> } | { error: string; missing?: "reps" | "duration" } {
  const values: Partial<WorkoutSet> = {};
  for (const metric of options.metrics) {
    const typed = parseTyped(
      metric,
      options.draft[metric] ?? "",
      options.unit,
      options.distanceUnit,
    );
    if (typed === "invalid") return { error: `Enter the ${NAMES[metric]} as a number.` };
    const value =
      typed ??
      storedValue(options.set, metric) ??
      previousValue(options.previous, metric) ??
      targetValue(options.target, metric);
    if (value === null && (metric === "reps" || metric === "duration")) {
      return {
        error: metric === "reps" ? "Enter reps to log this set." : "Enter a time to log this set.",
        missing: metric,
      };
    }
    (values as Record<string, number | null>)[FIELD[metric]] = value;
  }
  const candidate = { ...options.set, ...values, completedAt: new Date(0).toISOString() };
  const error = setRangeError(candidate);
  return error ? { error } : { values };
}

export function setRangeError(candidate: WorkoutSet): string | undefined {
  const issues = leveContract.validateContent(
    "workout_set",
    leveContract.normalize("workout_set", candidate as never),
  );
  const issue = issues[0];
  if (issue) {
    const metric = (Object.keys(FIELD) as SetMetric[]).find((m) => issue.path.includes(FIELD[m]));
    return `That ${metric ? NAMES[metric] : "value"} is out of range.`;
  }
}
