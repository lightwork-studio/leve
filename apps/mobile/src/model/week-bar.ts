import { dayKey } from "./time.ts";
import { startOfWeek } from "./train.ts";
import type { Routine, WithId, Workout } from "./types.ts";

/**
 * Two letters for a workout's name, short enough for a day of the week bar: a short last word stays
 * with the first word's initial ("Upper Body A" → UA, "Day 2" → D2); otherwise the initials of the
 * first two words ("Lower Body" → LB, "Push-Pull" → PP), or a single word's first two letters
 * ("Push" → PU). Words without a letter or digit ("&") don't count. Empty for a name with no letter
 * or digit.
 */
export function monogram(name: string): string {
  const words = wordsOf(name);
  const first = words[0];
  if (!first) return "";
  const last = words.at(-1) as string;
  if (words.length > 1 && last.length <= 2) return first.slice(0, 1) + last;
  if (words.length > 1) return first.slice(0, 1) + (words[1] as string).slice(0, 1);
  return first.slice(0, 2);
}

/** The name's words in capitals, keeping only letters and digits. */
function wordsOf(name: string): string[] {
  return name
    .toLocaleUpperCase()
    .split(/[\s\-/]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
}

/**
 * Each routine's monogram, different from every other routine's where the names allow. Routines
 * claim their letters in the order they were first trained (those never trained come last), so a
 * new routine never changes the letters of one already in use. A routine whose letters are taken
 * keeps its first letter and tries the rest of its name's letters in order, then a number.
 */
export function routineMonograms(
  routines: WithId<Routine>[],
  workouts: WithId<Workout>[],
): Map<string, string> {
  const firstDone = new Map<string, number>();
  for (const w of workouts) {
    const { routineId, endedAt, startedAt } = w.content;
    if (!routineId || endedAt === null) continue;
    const at = Date.parse(startedAt);
    if (Number.isNaN(at)) continue;
    if (at < (firstDone.get(routineId) ?? Infinity)) firstDone.set(routineId, at);
  }
  const order = [...routines].sort(
    (a, b) =>
      (firstDone.get(a.id) ?? Infinity) - (firstDone.get(b.id) ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken = new Set<string>();
  const result = new Map<string, string>();
  for (const routine of order) {
    const wanted = monogram(routine.content.title);
    if (!wanted) {
      result.set(routine.id, "");
      continue;
    }
    const letters = wordsOf(routine.content.title).join("");
    const initial = wanted.slice(0, 1);
    const tries = [wanted, ...[...letters.slice(1)].map((letter) => initial + letter)];
    for (let n = 2; n < 100; n++) tries.push(`${initial}${n}`);
    const pick = tries.find((t) => !taken.has(t)) ?? wanted;
    taken.add(pick);
    result.set(routine.id, pick);
  }
  return result;
}

/** One workout on a day of the week bar. */
export interface WeekBarWorkout {
  id: string;
  title: string;
  monogram: string;
  records: number;
  volumeKg: number;
  /** The volume the last session of the same routine had; null without an earlier one. */
  lastVolumeKg: number | null;
}

export interface WeekBarDay {
  /** The day's local start. */
  start: number;
  /** The day of the month, as shown under the weekday. */
  date: number;
  letter: string;
  name: string;
  today: boolean;
  /** Later than today. */
  future: boolean;
  workouts: WeekBarWorkout[];
  /** Whether this weekday was trained in each of the four weeks before, oldest first. */
  habit: boolean[];
}

export interface WeekBar {
  /** The week's local start. */
  start: number;
  days: WeekBarDay[];
}

const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** How many weeks before this one the habit marks look back over. */
export const HABIT_WEEKS = 4;

/** A finished workout's volume and records, for the days of this week. */
export type WeekBarFigures = (workoutId: string) => { volumeKg: number; records: number };

/**
 * This week day by day: each day's finished workouts with their monograms, records and volume
 * against the last session of the same routine, and whether the same weekday was trained in each
 * of the weeks before. `lastVolume` gives the volume of a routine's latest finished session before
 * a moment, or null.
 */
export function weekBar(
  input: {
    workouts: WithId<Workout>[];
    routines: WithId<Routine>[];
    now: number;
    firstWeekday: number;
  },
  figures: WeekBarFigures,
  lastVolume: (routineId: string, before: number, workoutId: string) => number | null,
): WeekBar {
  const { workouts, routines, now, firstWeekday } = input;
  const start = startOfWeek(now, firstWeekday);
  const first = new Date(start);
  // Days come from the calendar date, so a change of clocks never shifts them.
  const dayAt = (offset: number) =>
    new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset);
  const monograms = routineMonograms(routines, workouts);
  const finished = workouts
    .filter((w) => w.content.endedAt !== null && !Number.isNaN(Date.parse(w.content.startedAt)))
    .sort(
      (a, b) =>
        Date.parse(a.content.startedAt) - Date.parse(b.content.startedAt) || (a.id < b.id ? -1 : 1),
    );
  const byDay = new Map<string, WithId<Workout>[]>();
  for (const w of finished) {
    const key = dayKey(Date.parse(w.content.startedAt));
    const list = byDay.get(key) ?? [];
    list.push(w);
    byDay.set(key, list);
  }
  const today = dayKey(now);
  const todayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const days = Array.from({ length: 7 }, (_, i): WeekBarDay => {
    const date = dayAt(i);
    const key = dayKey(date.getTime());
    const name = NAMES[date.getDay()] as string;
    return {
      start: date.getTime(),
      date: date.getDate(),
      letter: name.slice(0, 1),
      name,
      today: key === today,
      future: date.getTime() > todayStart && key !== today,
      workouts: (byDay.get(key) ?? []).map((w) => {
        const { routineId, title, startedAt } = w.content;
        const known = routineId ? monograms.get(routineId) : undefined;
        const { volumeKg, records } = figures(w.id);
        return {
          id: w.id,
          title: title || "Workout",
          monogram: known ?? monogram(title || "Workout"),
          records,
          volumeKg,
          lastVolumeKg: routineId ? lastVolume(routineId, Date.parse(startedAt), w.id) : null,
        };
      }),
      habit: Array.from({ length: HABIT_WEEKS }, (_, w) =>
        byDay.has(dayKey(dayAt(i - 7 * (HABIT_WEEKS - w)).getTime())),
      ),
    };
  });
  return { start, days };
}

/**
 * A day's volume against the last sessions of the same routines, as a whole percentage, from the
 * workouts that have an earlier session: null when none has, and "up" when those sessions moved
 * no weight and this day did (no percentage of nothing).
 */
export function dayChange(day: WeekBarDay): number | "up" | null {
  let now = 0;
  let before = 0;
  let earlier = false;
  for (const w of day.workouts) {
    if (w.lastVolumeKg === null) continue;
    earlier = true;
    now += w.volumeKg;
    before += w.lastVolumeKg;
  }
  if (!earlier) return null;
  if (before <= 0) return now > 0 ? "up" : 0;
  return Math.round((now / before - 1) * 100);
}

/** What the marks under the days show: the workouts on Train, the habit on History, change on Progress. */
export type WeekBarMode = "train" | "history" | "progress";

/** What a screen reader hears for a day: the date, then what the mark under it shows. */
export function weekBarDayLabel(day: WeekBarDay, mode: WeekBarMode): string {
  const parts = [`${day.name} ${day.date}`];
  if (day.today) parts.push("today");
  if (mode === "history") {
    const weeks = day.habit.filter(Boolean).length;
    parts.push(day.workouts.length > 0 ? "trained" : "not trained");
    parts.push(`trained ${weeks} of the ${HABIT_WEEKS} weeks before`);
  } else if (day.workouts.length === 0) {
    if (!day.future) parts.push("no workout");
  } else if (mode === "progress") {
    const change = dayChange(day);
    parts.push(
      change === null
        ? "no earlier session to compare"
        : change === "up"
          ? "volume up on last time"
          : change === 0
            ? "same volume as last time"
            : `volume ${change > 0 ? "up" : "down"} ${Math.abs(change)}% on last time`,
    );
  } else {
    parts.push(day.workouts.map((w) => w.title).join(", "));
    const records = day.workouts.reduce((sum, w) => sum + w.records, 0);
    if (records > 0) parts.push(`${records} ${records === 1 ? "record" : "records"}`);
  }
  return parts.join(", ");
}
