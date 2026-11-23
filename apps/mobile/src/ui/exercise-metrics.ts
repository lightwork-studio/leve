import { type ExerciseType, type WeightUnit, weightFromKg } from "@leve/core";
import { type ExerciseMetric, METRIC_KIND } from "../model/progress.ts";
import {
  type AxisLines,
  axisNumber,
  type DistancePreferences,
  distanceLabel,
  durationLabel,
  weightValue,
  wholeWeight,
} from "./format.ts";

// How an exercise's metrics are named and shown on its screen.

/** The name of a metric on the chart, e.g. "Estimated 1RM". */
export function chartName(metric: ExerciseMetric, type: ExerciseType): string {
  switch (metric) {
    case "oneRepMax":
      return "Estimated 1RM";
    case "heaviest":
      return type === "weighted_bodyweight" ? "Most added weight" : "Heaviest weight";
    case "bestSetVolume":
      return "Best set volume";
    case "sessionVolume":
      return "Session volume";
    case "mostReps":
      return "Most reps";
    case "sessionReps":
      return "Total reps";
    case "longestDuration":
      return "Longest time";
    case "longestDistance":
      return "Longest distance";
  }
}

/** The name of a metric as a record, e.g. "Best session volume". */
export function recordName(metric: ExerciseMetric, type: ExerciseType): string {
  switch (metric) {
    case "oneRepMax":
      return "Best estimated 1RM";
    case "sessionVolume":
      return "Best session volume";
    case "mostReps":
      return "Most reps in a set";
    default:
      return chartName(metric, type);
  }
}

/** A metric's value in the unit it is charted in (the user's weight unit for weights). */
export const chartValue = (metric: ExerciseMetric, value: number, unit: WeightUnit) =>
  METRIC_KIND[metric] === "weight" ? weightFromKg(value, unit) : value;

/** A metric's value with its unit, split so the number can be set large: ["101.9", "kg"]. */
export function metricParts(
  metric: ExerciseMetric,
  value: number,
  unit: WeightUnit,
  prefs: DistancePreferences,
): [string, string] {
  switch (METRIC_KIND[metric]) {
    case "weight":
      // Volumes are totals, shown whole; single weights keep their decimal.
      return metric === "bestSetVolume" || metric === "sessionVolume"
        ? [wholeWeight(value, unit), unit]
        : [weightValue(value, unit), unit];
    case "count":
      return [String(value), value === 1 ? "rep" : "reps"];
    case "seconds":
      return [durationLabel(value), ""];
    case "meters": {
      const [figure = "", suffix = ""] = distanceLabel(value, prefs).split(" ");
      return [figure, suffix];
    }
  }
}

export const metricLabel = (
  metric: ExerciseMetric,
  value: number,
  unit: WeightUnit,
  prefs: DistancePreferences,
) => metricParts(metric, value, unit, prefs).filter(Boolean).join(" ");

/**
 * A tick on a metric's chart axis, in charted units (see chartValue). The axis's lines let it show
 * each one exactly, e.g. "102.5" between 100 and 105.
 */
export function metricTick(
  metric: ExerciseMetric,
  value: number,
  lines: AxisLines & { high: number },
  prefs: DistancePreferences,
  locale?: string,
): string {
  switch (METRIC_KIND[metric]) {
    case "seconds":
      return durationLabel(value);
    case "meters":
      return distanceLabel(value, prefs, locale, lines);
    default:
      return axisNumber(value, locale, lines);
  }
}

/** How sets of a type are measured, for the line under an exercise's name. */
export const TYPE_NAMES: Record<ExerciseType, string> = {
  weight_reps: "Weight and reps",
  bodyweight_reps: "Bodyweight reps",
  weighted_bodyweight: "Weighted bodyweight",
  assisted_bodyweight: "Assisted bodyweight",
  duration: "Time",
  weight_duration: "Weight and time",
  distance_duration: "Distance and time",
  weight_distance: "Weight and distance",
  floors_duration: "Floors and time",
  steps_duration: "Steps and time",
};
