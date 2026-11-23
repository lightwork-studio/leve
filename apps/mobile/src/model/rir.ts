import { type ExerciseType, METRICS_BY_TYPE } from "@leve/core";
import type { PadKey } from "./inline-edit.ts";
import type { WorkoutSet } from "./types.ts";

// Reps in reserve (RIR) in the workout in progress: how many more reps a set had left. It is typed
// as a whole number from 0 to 10, and an empty one stays empty: it never takes last time's value.

/** The most reps in reserve that can be typed. Larger stored values still show as they are. */
export const RIR_MAX = 10;

/** The picks offered at once; the last stands for "5 or more" and leads on to the pad. */
export const RIR_PICKS = [0, 1, 2, 3, 4, 5] as const;

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
  set: Pick<WorkoutSet, "type" | "repsInReserve">;
}): boolean {
  const { trackRir, canStore, type, set } = options;
  return (
    trackRir && canStore && countsReps(type) && set.type !== "warmup" && set.repsInReserve == null
  );
}

/**
 * Whether an exercise's sets show an RIR column: it counts reps, and Track RIR is on or one of its
 * sets already has RIR (so nothing logged is ever hidden).
 */
export function showsRirColumn(options: {
  trackRir: boolean;
  type: string;
  sets: readonly { content: Pick<WorkoutSet, "repsInReserve"> }[];
}): boolean {
  const { trackRir, type, sets } = options;
  return countsReps(type) && (trackRir || sets.some((set) => set.content.repsInReserve != null));
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
 * RIR one step up or down, kept from 0 to RIR_MAX; down from 0 leaves it at 0. A value already past
 * RIR_MAX (from an import) can't go further up, and goes down to RIR_MAX.
 */
export function stepRir(text: string, direction: -1 | 1): string {
  const value = text.trim() === "" ? null : Number(text);
  if (value === null || Number.isNaN(value)) return direction > 0 ? "0" : "";
  if (value > RIR_MAX && direction > 0) return text;
  return String(Math.min(RIR_MAX, Math.max(0, Math.round(value) + direction)));
}
