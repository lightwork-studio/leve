export { workoutMinutes } from "@leve/core";

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
