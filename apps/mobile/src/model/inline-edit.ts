import type { SetDistanceUnit, SetMetric, WeightUnit } from "@leve/core";
import { parseTyped } from "./log-values.ts";

// Typing a set's values on the logging screen's own number pad, one field at a time, and moving
// from field to field through the list.

/** A key on the number pad that changes the text. */
export type PadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "delete";

/** Whether a field takes a decimal point (weights and distances do; reps, counts and times don't). */
export const takesDecimal = (metric: SetMetric) => metric === "weight" || metric === "distance";

/** How many whole digits and decimals each field takes. */
const LIMITS: Record<SetMetric, { whole: number; decimals: number }> = {
  weight: { whole: 4, decimals: 3 },
  distance: { whole: 5, decimals: 3 },
  reps: { whole: 4, decimals: 0 },
  count: { whole: 6, decimals: 0 },
  // A time is typed as digits from the right: seconds, then minutes, then hours.
  duration: { whole: 6, decimals: 0 },
};

/** A time's digits, read from the right as seconds, minutes and hours: "130" is 1:30. */
export function durationText(digits: string): string {
  if (!digits) return "";
  const s = digits.slice(-2).padStart(2, "0");
  const m = digits.slice(-4, -2);
  const h = digits.slice(0, -4);
  if (h) return `${Number(h)}:${m.padStart(2, "0")}:${s}`;
  return `${Number(m || "0")}:${s}`;
}

/** The digits behind a time as it is shown or was typed ("1:05" or "65" seconds both give "105"). */
export function durationDigits(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let digits: string;
  if (trimmed.includes(":")) digits = trimmed.replace(/\D/g, "");
  else {
    const seconds = parseTyped("duration", trimmed, "kg");
    if (typeof seconds !== "number") digits = trimmed.replace(/\D/g, "");
    else {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const pad = (n: number) => String(n).padStart(2, "0");
      digits = h ? `${h}${pad(m)}${pad(s)}` : `${m}${pad(s)}`;
    }
  }
  return digits.replace(/^0+/, "");
}

/**
 * The text after a key on the number pad, or null when the key does nothing there (a second
 * decimal point, or one digit too many). When the field has just opened (`fresh`), the first key
 * replaces what it showed instead of adding to it.
 */
export function typeKey(
  metric: SetMetric,
  text: string,
  key: PadKey,
  fresh: boolean,
): string | null {
  const limits = LIMITS[metric];
  if (metric === "duration") {
    let digits = fresh ? "" : durationDigits(text);
    if (key === "delete") digits = digits.slice(0, -1);
    else if (key === ".") return null;
    else {
      if (digits.length >= limits.whole) return null;
      digits = `${digits}${key}`.replace(/^0+/, "");
    }
    return durationText(digits);
  }
  let typed = fresh ? "" : text.trim().replace(",", ".");
  if (key === "delete") return typed.slice(0, -1);
  if (key === ".") {
    if (!takesDecimal(metric) || typed.includes(".")) return null;
    return `${typed || "0"}.`;
  }
  const [whole = "", decimals] = typed.split(".");
  if (decimals !== undefined ? decimals.length >= limits.decimals : whole.length >= limits.whole)
    return null;
  if (typed === "0") typed = "";
  return `${typed}${key}`;
}

/**
 * How far the − and + buttons (on the dock and the pad) move a field, in the units it is shown in.
 * Every step rule lives here; `weightStep` lets a chosen weight step replace the default one.
 */
export function stepSize(
  metric: SetMetric,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
  weightStep?: number,
) {
  switch (metric) {
    case "weight":
      return weightStep ?? (unit === "lbs" ? 5 : 2.5);
    case "distance":
      return distanceUnit === "km" || distanceUnit === "miles" ? 0.1 : 10;
    case "duration":
      return 5;
    default:
      return 1;
  }
}

/** A step as shown next to its field and on the pad: "2.5", "5 s". */
export function stepLabel(metric: SetMetric, unit: WeightUnit, distanceUnit: SetDistanceUnit) {
  const step = stepSize(metric, unit, distanceUnit);
  return metric === "duration" ? `${step} s` : String(step);
}

/**
 * The text for a field moved one step down or up from `shown` (a number in the units it is shown
 * in, or null when it has none yet). It never goes below zero.
 */
export function stepText(
  metric: SetMetric,
  shown: number | null,
  direction: -1 | 1,
  unit: WeightUnit,
  distanceUnit: SetDistanceUnit,
): string {
  const step = stepSize(metric, unit, distanceUnit);
  const value = Math.max(0, Math.round(((shown ?? 0) + direction * step) * 1000) / 1000);
  if (metric === "duration") {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.floor(value % 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  return String(value);
}

/** One field of one set in the list. */
export interface Field {
  setId: string;
  metric: SetMetric;
}

/** A field in reading order, with where it is. */
export interface PlacedField extends Field {
  entryIndex: number;
  setIndex: number;
}

/**
 * Every field the pad can reach, in reading order: an exercise's sets top to bottom, each set's
 * fields left to right, then the next exercise. Sets that `skip` leaves out (those waiting for a
 * sync review, say) aren't reached.
 */
export function fieldOrder(
  entries: { metrics: readonly SetMetric[]; sets: { id: string }[] }[],
  skip: (setId: string, metric: SetMetric) => boolean = () => false,
): PlacedField[] {
  const order: PlacedField[] = [];
  entries.forEach(({ metrics, sets }, entryIndex) => {
    sets.forEach((set, setIndex) => {
      for (const metric of metrics)
        if (!skip(set.id, metric)) order.push({ setId: set.id, metric, entryIndex, setIndex });
    });
  });
  return order;
}

/** The field after (or before) `current` in `order`, or null at either end. */
export function nextField(
  order: PlacedField[],
  current: Field,
  direction: -1 | 1 = 1,
): PlacedField | null {
  const index = order.findIndex((f) => f.setId === current.setId && f.metric === current.metric);
  if (index < 0) return null;
  return order[index + direction] ?? null;
}
