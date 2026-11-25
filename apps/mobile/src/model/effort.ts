import { type EffortScale, RIR_MAX, RPE_VALUES } from "@leve/core";

export const effortLabel = (scale: EffortScale) => (scale === "rpe" ? "RPE" : "RIR");
export const effortField = (scale: EffortScale) => (scale === "rpe" ? "rpe" : "repsInReserve");

type EffortValues = { rpe?: number | null; repsInReserve?: number | null };

export { RIR_MAX };

export function parseEffort(text: string, scale: "rpe"): (typeof RPE_VALUES)[number] | null;
export function parseEffort(text: string, scale: EffortScale): number | null;
export function parseEffort(text: string, scale: EffortScale): number | null {
  const value = text.trim().replace(",", ".");
  if (!value) return null;
  if (scale === "rir") {
    if (!/^\d+$/.test(value) || Number(value) > RIR_MAX)
      throw new Error(`Enter a whole number from 0 to ${RIR_MAX} for reps in reserve.`);
    return Number(value);
  }
  const rpe = RPE_VALUES.find((rating) => rating === Number(value));
  if (rpe === undefined || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error("Enter an RPE from 1 to 10 in steps of 0.5, or leave it empty.");
  return rpe;
}

export function effortValue(values: EffortValues | undefined, scale: EffortScale): number | null {
  return values?.[effortField(scale)] ?? null;
}

/** Older workouts can contain either score, regardless of their planned effort. */
export function setEffortScale(values: EffortValues, captured?: EffortScale): EffortScale {
  return captured ?? (values.rpe != null && values.repsInReserve == null ? "rpe" : "rir");
}

/** Before the workout scale was captured, RPE targets could accompany logged RIR. */
export function effortCaption(
  values: EffortValues | undefined,
  scale?: EffortScale,
): string | null {
  if (!scale && values?.rpe != null) return `RPE ${values.rpe}`;
  const value = effortValue(values, scale ?? "rir");
  return value === null ? null : String(value);
}

/** RPE was the only target scale on routines before the setting existed. */
export function routineEffortScale(routine: {
  readonly effortScale?: unknown;
  readonly exercises: readonly { sets: readonly EffortValues[] }[];
}): EffortScale {
  if (routine.effortScale === "rpe" || routine.effortScale === "rir") return routine.effortScale;
  return routine.exercises.some(({ sets }) => sets.some((set) => set.rpe != null)) ? "rpe" : "rir";
}

/**
 * Match only whole-number equivalents: RIR 0 to 9 is RPE 10 to 1. Half-step RPE and RIR 10 have
 * none.
 */
export function equivalentEffort(value: number, to: EffortScale): number | null {
  const reserve = to === "rir" ? 10 - value : value;
  return Number.isInteger(reserve) && reserve >= 0 && reserve <= 9
    ? to === "rir"
      ? reserve
      : 10 - reserve
    : null;
}
