import { type EffortScale, type ExerciseType, METRICS_BY_TYPE, RPE_VALUES } from "@leve/core";
import { effortValue, RIR_MAX, setEffortScale } from "./effort.ts";
import type { PadKey } from "./inline-edit.ts";
import type { WorkoutSet } from "./types.ts";

// Reps in reserve (RIR) in the workout in progress: how many more reps a set had left. It is typed
// as a whole number from 0 to 10, and an empty one stays empty: it never takes last time's value.

export { RIR_MAX } from "./effort.ts";

/** The picks offered at once; the last stands for "5 or more" and leads on to the pad. */
export const RIR_PICKS = [0, 1, 2, 3, 4, 5] as const;

/**
 * The RPE picks offered at once; the first stands for "6 or less" and leads on to the pad, which
 * also takes the values between the picks below 7.
 */
export const RPE_PICKS = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;

/** The strip's pick for a value: what only the pad can enter shows on the pick that opens it. */
export function effortPick(value: number, scale: EffortScale): number {
  if (scale === "rpe") return value < 7 ? 6 : value;
  return Math.min(value, 5);
}

/** Whether an exercise counts reps, and so can have reps in reserve. */
export function countsReps(type: string): boolean {
  return (METRICS_BY_TYPE[type as ExerciseType] ?? ["weight", "reps"]).includes("reps");
}

/**
 * Whether logging this set asks for its reps in reserve: Track RIR is on, the account can store
 * it, the exercise counts reps, the set isn't a warm-up, and it has no RIR yet.
 */
export function asksRir(options: {
  trackRir: boolean;
  canStore: boolean;
  type: string;
  set: Pick<WorkoutSet, "type" | "repsInReserve"> & Partial<Pick<WorkoutSet, "rpe">>;
  scale?: EffortScale;
}): boolean {
  const { trackRir, canStore, type, set, scale = "rir" } = options;
  return (
    trackRir &&
    canStore &&
    countsReps(type) &&
    set.type !== "warmup" &&
    effortValue(set, scale) === null
  );
}

/**
 * Whether an exercise's sets show an RIR column: it counts reps, and Track RIR is on or one of its
 * sets already has RIR (so nothing logged is ever hidden).
 */
export function showsRirColumn(options: {
  trackRir: boolean;
  type: string;
  sets: readonly { content: Partial<Pick<WorkoutSet, "repsInReserve" | "rpe">> }[];
  scale?: EffortScale;
  hasTarget?: boolean;
}): boolean {
  const { trackRir, type, sets, scale, hasTarget } = options;
  return (
    countsReps(type) &&
    (trackRir ||
      !!hasTarget ||
      sets.some(({ content }) => effortValue(content, setEffortScale(content, scale)) !== null))
  );
}

/**
 * The RIR typed so far after a key on the pad, or null when the key is refused: no decimal point,
 * and nothing past RIR_MAX. A fresh field is replaced by the first digit.
 */
export function typeRir(text: string, key: PadKey, fresh: boolean): string | null {
  if (key === "delete") return fresh ? "" : text.slice(0, -1);
  if (key === ".") return null;
  const next = fresh ? key : `${text === "0" ? "" : text}${key}`;
  return Number(next) <= RIR_MAX ? next : null;
}

/**
 * The RPE typed so far after a key on the pad, or null when the key is refused: from 1 to 10 in
 * half steps. A fresh field is replaced by the first digit.
 */
export function typeRpe(text: string, key: PadKey, fresh: boolean): string | null {
  if (key === "delete") return fresh ? "" : text.slice(0, -1);
  if (fresh && key === ".") return null;
  const next = fresh ? key : `${text}${key}`;
  return /^(?:[1-9](?:\.[05]?)?|10(?:\.0?)?)$/.test(next) ? next : null;
}

/** The RPE on the pad, if it is one Leve can store; empty means none. */
export function typedRpe(text: string): number | null | undefined {
  const typed = text.trim();
  if (typed === "") return null;
  const value = Number(typed);
  return RPE_VALUES.find((rating) => rating === value);
}

/** RPE half a step up or down, kept from 1 to 10. Empty goes up to 1 and stays empty going down. */
export function stepRpe(text: string, direction: -1 | 1): string {
  const value = text.trim() === "" ? null : Number(text);
  if (value === null || Number.isNaN(value)) return direction > 0 ? "1" : "";
  const next = Math.round(value * 2) / 2 + direction / 2;
  return String(Math.min(10, Math.max(1, next)));
}

/**
 * RIR one step up or down, kept from 0 to RIR_MAX; down from 0 leaves it at 0.
 */
export function stepRir(text: string, direction: -1 | 1): string {
  const value = text.trim() === "" ? null : Number(text);
  if (value === null || Number.isNaN(value)) return direction > 0 ? "0" : "";
  return String(Math.min(RIR_MAX, Math.max(0, Math.round(value) + direction)));
}
