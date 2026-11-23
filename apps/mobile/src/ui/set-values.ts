import {
  type ExerciseType,
  METRICS_BY_TYPE,
  type SetDistanceUnit,
  type SetMetric,
  type WeightUnit,
} from "@leve/core";
import { storedValue } from "../model/log-values.ts";
import type { WorkoutSet } from "../model/types.ts";
import {
  type DistancePreferences,
  distanceInput,
  distanceLabel,
  durationLabel,
  weightInput,
  weightValue,
} from "./format.ts";

type Unit = "kg" | "lbs";

/** The columns an exercise type records, with their headings. */
export function setColumns(type: string, unit: Unit): { metric: SetMetric; heading: string }[] {
  const metrics = METRICS_BY_TYPE[type as ExerciseType] ?? ["weight", "reps"];
  const sign = type === "assisted_bodyweight" ? "−" : type === "weighted_bodyweight" ? "+" : "";
  const headings: Record<SetMetric, string> = {
    weight: `${sign}${unit.toUpperCase()}`,
    reps: "REPS",
    duration: "TIME",
    distance: "DIST",
    count: type === "steps_duration" ? "STEPS" : "FLOORS",
  };
  return metrics.map((metric) => ({ metric, heading: headings[metric] }));
}

/** One value of a set as shown in a table, or a dash when it is missing. */
export function setCell(
  set: WorkoutSet,
  metric: SetMetric,
  unit: Unit,
  prefs: DistancePreferences,
): string {
  switch (metric) {
    case "weight":
      return set.weightKg === null ? "—" : weightValue(set.weightKg, unit);
    case "reps":
      return set.reps === null ? "—" : String(set.reps);
    case "duration":
      return set.durationSeconds === null ? "—" : durationLabel(set.durationSeconds);
    case "distance":
      return set.distanceMeters === null ? "—" : distanceLabel(set.distanceMeters, prefs);
    case "count":
      return set.count === null ? "—" : String(set.count);
  }
}

export function reserveLabel(reps: number): string {
  return `${reps} ${reps === 1 ? "rep" : "reps"} in reserve`;
}

/** A history row carries its units with it, so it can be read on its own. */
export function sessionSetLabel(
  type: string,
  set: WorkoutSet,
  unit: Unit,
  prefs: DistancePreferences,
): string {
  const columns = setColumns(type, unit);
  const recordsReps = columns.some(({ metric }) => metric === "reps");
  const measures = columns
    .map(({ metric, heading }) => {
      const value = setCell(set, metric, unit, prefs);
      switch (metric) {
        case "weight": {
          const sign = value === "—" ? "" : heading.slice(0, -unit.length);
          return `${sign}${value} ${unit}`;
        }
        case "reps":
          return `${value} ${set.reps === 1 ? "rep" : "reps"}`;
        case "count": {
          const noun = type === "steps_duration" ? "step" : "floor";
          return `${value} ${noun}${set.count === 1 ? "" : "s"}`;
        }
        case "duration":
          return value === "—" ? "— time" : value;
      }
      return value === "—" ? "— distance" : value;
    })
    .join(recordsReps ? " × " : " · ");
  return recordsReps && set.repsInReserve != null
    ? `${measures} · ${reserveLabel(set.repsInReserve)}`
    : measures;
}

export function inputValue(
  set: Pick<WorkoutSet, "weightKg" | "durationSeconds" | "reps" | "distanceMeters" | "count">,
  metric: SetMetric,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
) {
  const value = storedValue(set, metric);
  if (value === null) return "";
  if (metric === "distance") return distanceInput(value, distanceUnit);
  if (metric === "duration") return durationLabel(value);
  return metric === "weight" ? weightInput(value, unit) : String(value);
}
