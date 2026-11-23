import type { Workout } from "./types.ts";

/** The calendar day of `time` in local time, as "2026-11-12". */
export function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Whole calendar days from the day of `from` to the day of `to` (local time, DST-safe). */
export function calendarDaysBetween(from: number, to: number): number {
  const utc = (time: number) => {
    const d = new Date(time);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** A finished workout's length in whole minutes; never negative, whatever another device sent. */
export function workoutMinutes(workout: Workout): number {
  if (workout.endedAt === null) return 0;
  const ms = Date.parse(workout.endedAt) - Date.parse(workout.startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0;
}
