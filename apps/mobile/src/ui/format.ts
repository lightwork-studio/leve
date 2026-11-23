import {
  distanceFromMetres,
  distanceToMetres,
  type SetDistanceUnit,
  type WeightUnit,
  weightFromKg,
} from "@leve/core";

import type { Settings } from "../model/types.ts";

export type DistancePreferences = Pick<Settings, "shortDistanceUnit" | "distanceUnit">;

export const distanceUnitFor = (meters: number, prefs: DistancePreferences) =>
  meters >= 1000 ? prefs.distanceUnit : prefs.shortDistanceUnit;

export const distanceSuffix = (unit: SetDistanceUnit) => (unit === "miles" ? "mi" : unit);

/** An editable weight in the selected unit without locale grouping. */
export const weightInput = (kg: number, unit: WeightUnit) =>
  String(Number(weightFromKg(kg, unit).toFixed(2)));

/** An ungrouped decimal for the editable distance column. */
export const distanceInput = (meters: number, unit: SetDistanceUnit) =>
  String(Number(distanceFromMetres(meters, unit).toFixed(6)));

import type { WorkoutSummary } from "../model/past-workouts.ts";

/** Describe the logged warm-ups without counting included ones twice. */
export function historySetLabel({ sets, loggedWarmups, excludedWarmups }: WorkoutSummary): string {
  const counted = `${sets} ${sets === 1 ? "set" : "sets"}`;
  if (!loggedWarmups) return counted;
  const warmups = `${loggedWarmups} ${loggedWarmups === 1 ? "warm-up" : "warm-ups"}`;
  if (sets + excludedWarmups === loggedWarmups) return warmups;
  return excludedWarmups ? `${counted} · ${warmups}` : `${counted} (${warmups})`;
}

// Every number shown goes through these, so screens agree with each other. `locale` is for tests;
// the app uses the device's.

const number = (value: number, decimals: number, locale?: string) =>
  value.toLocaleString(locale, { maximumFractionDigits: decimals });

/** A set's weight in the user's unit without the unit, e.g. "82.5". */
export const weightValue = (kg: number, unit: WeightUnit, locale?: string) =>
  number(weightFromKg(kg, unit), 1, locale);

/** A large total such as volume, rounded to a whole number, without the unit. */
export const wholeWeight = (kg: number, unit: WeightUnit, locale?: string) =>
  number(Math.round(weightFromKg(kg, unit)), 0, locale);

/** A large total with its unit, e.g. "6,659 kg". */
export const totalWeight = (kg: number, unit: WeightUnit, locale?: string) =>
  `${wholeWeight(kg, unit, locale)} ${unit}`;

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Like minutesLabel, split into numbers and their units so the numbers can be set large:
 * 64 → [["1", "h"], ["4", "min"]].
 */
export function minutesParts(minutes: number): [string, string][] {
  if (minutes < 60) return [[String(minutes), "min"]];
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? [[String(hours), "h"]]
    : [
        [String(hours), "h"],
        [String(rest), "min"],
      ];
}

/** A workout's length: like minutesLabel, but a workout under a minute reads "<1 min", not "0 min". */
export const workoutMinutesLabel = (minutes: number) =>
  minutes < 1 ? "<1 min" : minutesLabel(minutes);

/** A set's duration, e.g. "0:45" or "1:02:30". */
export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** The recorded work shown alongside the elapsed workout duration. */
export function workoutEffort(
  summary: Pick<WorkoutSummary, "volumeKg" | "recordedSeconds" | "missingTimedSets">,
  unit: WeightUnit,
  plannedTimedSession = false,
) {
  if (summary.volumeKg === 0 && summary.missingTimedSets > 0)
    return {
      label: "Partial time",
      amount: summary.recordedSeconds === null ? "—" : durationLabel(summary.recordedSeconds),
      unit: "",
    };
  if (summary.volumeKg === 0 && (summary.recordedSeconds !== null || plannedTimedSession))
    return { label: "Logged time", amount: durationLabel(summary.recordedSeconds ?? 0), unit: "" };
  return { label: "Volume", amount: wholeWeight(summary.volumeKg, unit), unit };
}

/** "Today", "Yesterday", or the date as dayLabel writes it. `today` is any moment of today. */
export function relativeDayLabel(iso: string, today: number, locale?: string): string {
  const date = new Date(iso);
  const now = new Date(today);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day === start) return "Today";
  if (day === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) {
    return "Yesterday";
  }
  return dayLabel(iso, locale, today);
}

/** A date such as "Thu, 12 Nov", with the year when it isn't this year's. */
export const dayLabel = (iso: string, locale?: string, now = Date.now()) => {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** A date without its weekday, such as "12 Nov", with the year when it isn't this year's. */
export const shortDay = (time: number, locale?: string, now = Date.now()) => {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** A clock time in the user's format, without a leading zero on the hour ("6:00 PM", "18:00"). */
export const timeLabel = (iso: string, locale?: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

export const monthLabel = (year: number, month: number, locale?: string) =>
  new Date(year, month, 1).toLocaleDateString(locale, { month: "long", year: "numeric" });

/** Evenly spaced lines on an axis: the lowest and the space between them. */
export interface AxisLines {
  low: number;
  step: number;
}

/** The fewest decimal places (up to `most`) that show `value` exactly, ignoring float noise. */
function decimalsOf(value: number, most = 3): number {
  for (let places = 0; places < most; places++) {
    const scaled = value * 10 ** places;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled))) {
      return places;
    }
  }
  return most;
}

/** Decimals (up to 3) that show every line exactly in units of `scale`, or null if none do. */
function exactDecimals(lines: AxisLines, scale: number): number | null {
  const fits = (value: number) => decimalsOf(value, 4) <= 3;
  return fits(lines.low / scale) && fits(lines.step / scale) ? linesDecimals(lines, scale) : null;
}

/** Decimals that show every line of an axis exactly, in units of `scale` (1000 for "k"). */
const linesDecimals = (lines: AxisLines, scale: number) =>
  Math.max(decimalsOf(lines.low / scale), decimalsOf(lines.step / scale));

/**
 * A number for a chart axis, in thousands from a thousand, e.g. "12.5k". Given the axis's lines,
 * it keeps as many decimals as they need to read exactly ("102.5", "12.25k"); otherwise it is
 * whole from ten and has one decimal below ten and in thousands.
 */
export const axisNumber = (value: number, locale?: string, lines?: AxisLines) => {
  // Thousands read as "k" only when that stays exact; lines a few units apart ("4,002.5") don't.
  const thousands = Math.abs(value) >= 1000 && (!lines || exactDecimals(lines, 1000) !== null);
  const scale = thousands ? 1000 : 1;
  const decimals = lines ? linesDecimals(lines, scale) : thousands || Math.abs(value) < 10 ? 1 : 0;
  return `${number(value / scale, decimals, locale)}${thousands ? "k" : ""}`;
};

/** A distance, e.g. "850 m" or "5.2 km"; on an axis, as exact as its lines need. */
export function distanceLabel(
  meters: number,
  prefs: DistancePreferences,
  locale?: string,
  lines?: AxisLines & { high: number },
) {
  const unit = distanceUnitFor(lines?.high ?? meters, prefs);
  const scale = distanceToMetres(1, unit);
  const step = lines && lines.step / scale;
  const decimals =
    lines && step
      ? Math.max(linesDecimals(lines, scale), Math.ceil(-Math.log10(step)))
      : meters >= 1000
        ? 2
        : 0;
  return `${number(distanceFromMetres(meters, unit), decimals, locale)} ${distanceSuffix(unit)}`;
}

/** A length of time on an axis, in minutes: "30 min", "2 h". */
export const axisMinutes = (minutes: number) =>
  minutes % 60 === 0 && minutes > 0 ? `${minutes / 60} h` : `${Math.round(minutes)} min`;

export const shortMonth = (month: number, locale?: string) =>
  new Date(2026, month, 1).toLocaleDateString(locale, { month: "short" });

/** A week as "9–15 Nov", or "30 Nov – 6 Dec" across months. */
export function weekLabel(start: number, locale?: string): string {
  const first = new Date(start);
  const last = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
  const month = (d: Date) => d.toLocaleDateString(locale, { month: "short" });
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${last.getDate()} ${month(last)}`
    : `${first.getDate()} ${month(first)} – ${last.getDate()} ${month(last)}`;
}

/**
 * A length of time for a readout: minutes under an hour ("45", "min"), then hours and minutes on
 * a clock face ("1:05", "h"), so the number stays short.
 */
export function readoutMinutes(minutes: number): { value: string; unit: string } {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return { value: minutes > 0 && whole === 0 ? "<1" : String(whole), unit: "min" };
  return {
    value: `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`,
    unit: "h",
  };
}

/** A large total for a readout, without the unit: whole up to 9,999, then thousands ("12.4k"). */
export function readoutWeight(kg: number, unit: WeightUnit, locale?: string): string {
  const value = Math.round(weightFromKg(kg, unit));
  if (value < 10_000) return number(value, 0, locale);
  return `${number(Math.floor(value / 100) / 10, 1, locale)}k`;
}
