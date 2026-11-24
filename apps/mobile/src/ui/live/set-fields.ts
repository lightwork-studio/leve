import {
  distanceFromMetres,
  type ExerciseType,
  METRICS_BY_TYPE,
  type SetDistanceUnit,
  type SetMetric,
  type WeightUnit,
  weightFromKg,
} from "@leve/core";
import type { PreviousSet } from "../../model/live.ts";
import {
  measurementName,
  missingMeasurements,
  parseTyped,
  previousValue,
  resolveLog,
  storedValue,
  targetValue,
} from "../../model/log-values.ts";
import type { PlanTarget, WorkoutSet } from "../../model/types.ts";
import {
  distanceInput,
  distanceSuffix,
  durationLabel,
  weightInput,
  weightValue,
} from "../format.ts";
import type { Measurement } from "../use-set-stopwatch.ts";
import type { SetDrafts } from "../use-workout-inputs.ts";
import type { Entry } from "./targets.ts";

// What a set's fields show on the logging screen, and the values a set is logged with. The list,
// the dock and the minimised workout all read them from here, so they always agree.

export type SetDraft = SetDrafts[string];
export type Target = PlanTarget | undefined;

export const metricsOf = (type: string): readonly SetMetric[] =>
  METRICS_BY_TYPE[type as ExerciseType] ?? ["weight", "reps"];

/** Weight and reps carry forward from the preceding set of this exercise, one field at a time. */
export function setDefaults(
  entry: Entry,
  index: number,
  drafts: SetDrafts,
  unit: WeightUnit,
  history: PreviousSet | undefined,
  correction?: SetDraft,
): PreviousSet | undefined {
  const prior = entry.sets[index - 1];
  if (!prior || prior.needsSyncReview) return history;
  const draft = prior.content.completedAt === null ? drafts[prior.id] : correction;
  const carry = (metric: "weight" | "reps") => {
    const typed = parseTyped(metric, draft?.[metric] ?? "", draft?.weightUnit ?? unit);
    return typeof typed === "number" ? typed : storedValue(prior.content, metric);
  };
  return {
    weightKg: carry("weight") ?? history?.weightKg ?? null,
    reps: carry("reps") ?? history?.reps ?? null,
    durationSeconds: history?.durationSeconds ?? null,
    distanceMeters: history?.distanceMeters ?? null,
    count: history?.count ?? null,
  };
}

/** A stored value in the user's units, for showing. */
export function show(
  metric: SetMetric,
  value: number | null,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): string {
  if (value === null) return "";
  if (metric === "weight") return weightValue(value, unit);
  if (metric === "distance") return distanceInput(value, distanceUnit);
  if (metric === "duration") return durationLabel(value);
  return String(value);
}

/** A stored value as a number in the units it is shown in. */
function shownNumber(
  metric: SetMetric,
  value: number | null,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): number | null {
  if (value === null) return null;
  if (metric === "weight") return weightFromKg(value, unit);
  if (metric === "distance") return distanceFromMetres(value, distanceUnit);
  return value;
}

/**
 * What typed text stands for, as a number in the units it is shown in, or null when it can't be
 * read. A decimal point typed last ("70.") counts as the number before it.
 */
export function typedNumber(
  metric: SetMetric,
  text: string,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): number | null {
  const trimmed = text.trim().replace(/[.,]$/, "");
  const parsed = parseTyped(metric, trimmed, unit, distanceUnit);
  if (typeof parsed !== "number") return null;
  // Read as typed, so a value in lbs or miles picks up no rounding from a round trip.
  if (metric === "weight" || metric === "distance") return Number(trimmed.replace(",", "."));
  return parsed;
}

/** A field's column heading and unit word. */
export function fieldUnit(metric: SetMetric, unit: WeightUnit, distanceUnit: SetDistanceUnit) {
  switch (metric) {
    case "weight":
      return unit;
    case "distance":
      return distanceSuffix(distanceUnit);
    case "duration":
      return "time";
    case "reps":
      return "reps";
    case "count":
      return "count";
  }
}

/** The routine's rep target as a hint: a range ("8–12") or a single number. */
export function repHint(target: Target): string | null {
  if (target && target.repRangeMin !== null)
    return target.repRangeMax !== null && target.repRangeMax !== target.repRangeMin
      ? `${target.repRangeMin}–${target.repRangeMax}`
      : String(target.repRangeMin);
  return target?.reps !== null && target?.reps !== undefined ? String(target.reps) : null;
}

export function targetCaption(
  target: Target,
  metric: SetMetric,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): string | null {
  return metric === "reps"
    ? repHint(target)
    : show(metric, targetValue(target, metric), unit, distanceUnit) || null;
}

/** The time typed or measured for a set, as text. */
export function timeText(timer: Measurement | undefined): string {
  return timer?.seconds === undefined ? (timer?.text ?? "") : durationLabel(timer.seconds);
}

/** What was typed into a field of an unlogged set, in the units on screen now. */
export function typedText(
  metric: SetMetric,
  draft: SetDraft | undefined,
  timer: Measurement | undefined,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): string {
  if (metric === "duration") return timeText(timer);
  const text = draft?.[metric] ?? "";
  if (metric === "weight" && draft?.weightUnit && draft.weightUnit !== unit) {
    const kg = parseTyped("weight", text, draft.weightUnit);
    if (typeof kg === "number") return weightInput(kg, unit);
  }
  if (metric === "distance" && draft?.distanceUnit && draft.distanceUnit !== distanceUnit) {
    const meters = parseTyped("distance", text, unit, draft.distanceUnit);
    if (typeof meters === "number") return distanceInput(meters, distanceUnit);
  }
  return text;
}

/** What a field shows. */
export interface FieldView {
  text: string;
  /** Typed or logged, rather than suggested (last time's value, the routine's target). */
  firm: boolean;
  /** As a number in the units shown, for − and + to start from; null when there is none. */
  value: number | null;
  /** A logged set without this measurement. */
  missing: boolean;
}

/**
 * A field of a set as the list and the dock show it. Logged sets show what was logged. Unlogged
 * sets show what was typed, else a suggestion: the stored value, the preceding set's input, last time's, then the routine's
 * target (the order Log uses when nothing is typed).
 */
export function fieldView(options: {
  set: WorkoutSet;
  metric: SetMetric;
  type: string;
  unit: WeightUnit;
  distanceUnit: SetDistanceUnit;
  draft: SetDraft | undefined;
  timer: Measurement | undefined;
  previous: PreviousSet | undefined;
  target: Target;
  ready: boolean;
}): FieldView {
  const { set, metric, unit, distanceUnit } = options;
  if (set.completedAt !== null) {
    const missing = missingMeasurements(options.type, set).includes(metric);
    const stored = storedValue(set, metric);
    return {
      text: missing
        ? `Add ${measurementName(metric, options.type)}`
        : show(metric, stored, unit, distanceUnit) || "–",
      firm: true,
      value: shownNumber(metric, stored, unit, distanceUnit),
      missing,
    };
  }
  const typed = typedText(metric, options.draft, options.timer, unit, distanceUnit);
  if (typed.trim()) {
    const parsed = parseTyped(metric, typed, unit, distanceUnit);
    return {
      text: typed,
      firm: true,
      value: typeof parsed === "number" ? shownNumber(metric, parsed, unit, distanceUnit) : null,
      missing: false,
    };
  }
  if (metric === "duration" && options.timer?.startedAt !== undefined)
    return { text: "Timing…", firm: false, value: null, missing: false };
  if (!options.ready) return { text: "…", firm: false, value: null, missing: false };
  const suggested =
    storedValue(set, metric) ??
    previousValue(options.previous, metric) ??
    targetValue(options.target, metric);
  return {
    text: show(metric, suggested, unit, distanceUnit) || (metric === "duration" ? "m:ss" : "–"),
    firm: false,
    value: shownNumber(metric, suggested, unit, distanceUnit),
    missing: false,
  };
}

/** Why a set can't be logged as it stands. */
export interface LogProblem {
  error: string;
  /** The field to fill in, if one is missing. */
  missing?: "reps" | "duration";
}

/**
 * The values to log a set with, or why it can't be logged yet. A running set timer must be
 * stopped first (null); a timer stopped under a second asks for a time.
 */
export function logValues(options: {
  set: WorkoutSet;
  type: string;
  unit: WeightUnit;
  distanceUnit: SetDistanceUnit;
  draft: SetDraft | undefined;
  timer: Measurement | undefined;
  previous: PreviousSet | undefined;
  target: Target;
}): { values: Partial<WorkoutSet> } | LogProblem | null {
  const { timer, draft } = options;
  if (timer?.startedAt !== undefined) return null;
  if (timer?.seconds === 0)
    return {
      error: "Less than one second timed. Enter a time or restart the timer.",
      missing: "duration",
    };
  return resolveLog({
    set: options.set,
    metrics: metricsOf(options.type),
    draft: { ...draft, duration: timeText(timer) },
    previous: options.previous,
    target: options.target,
    unit: draft?.weightUnit ?? options.unit,
    distanceUnit: draft?.distanceUnit ?? options.distanceUnit,
  });
}

/** A set's values in a line, as "60 × 8", "1:30" or "2 km · 10:00". */
export function valuesLine(views: { metric: SetMetric; view: FieldView }[], unit: WeightUnit) {
  const reps = views.some((v) => v.metric === "reps");
  return views
    .map(({ metric, view }) => (metric === "weight" && !reps ? `${view.text} ${unit}` : view.text))
    .join(reps ? " × " : " · ");
}
