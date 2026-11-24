import { type ExerciseType, isRepBased, METRICS_BY_TYPE } from "@leve/core";
import { storedSetMagnitude } from "./barcode.ts";
import { exerciseMatcher } from "./exercise-search.ts";
import { workoutMinutes } from "./time.ts";
import { startOfWeek } from "./train.ts";
import type { WithId, Workout, WorkoutEntry, WorkoutSet } from "./types.ts";
import { countsTowardTotals, setVolumeKg } from "./volume.ts";

export interface WorkoutSummary {
  id: string;
  title: string;
  startedAt: string;
  durationMinutes: number;
  volumeKg: number;
  sets: number;
  /** Reps of the counted sets of rep-based exercises. */
  reps: number;
  loggedWarmups: number;
  excludedWarmups: number;
  recordedSeconds: number | null;
  missingTimedSets: number;
  /** Lines such as "4 × Bench Press", in workout order, with each logged set for its barcode. */
  exercises: { id: string; name: string; sets: number; bars: SummaryBar[] }[];
}

/** A logged set as a barcode draws it (see model/barcode.ts). */
export interface SummaryBar {
  setId: string;
  magnitude: number;
  warmup: boolean;
}

export type RecordedSet = WithId<WorkoutSet> & {
  hasSyncConflict?: true;
  needsSyncReview?: true;
};

export interface WorkoutTree {
  workout: WithId<Workout>;
  entries: { entry: WithId<WorkoutEntry>; sets: RecordedSet[] }[];
}

export function summarize(
  tree: WorkoutTree,
  options: {
    countWarmups: boolean;
    bodyweightKg: number | null;
    usesBodyweight: (exerciseId: string) => boolean;
  },
): WorkoutSummary {
  const { workout } = tree;
  let volumeKg = 0;
  let sets = 0;
  let reps = 0;
  let loggedWarmups = 0;
  let recordedSeconds: number | null = null;
  let missingTimedSets = 0;
  const exercises: WorkoutSummary["exercises"] = [];
  for (const { entry, sets: entrySets } of tree.entries) {
    const logged = entrySets.filter((s) => s.content.completedAt !== null);
    const timed = METRICS_BY_TYPE[entry.content.exerciseType as ExerciseType]?.includes("duration");
    for (const { content } of logged) {
      if (content.type === "warmup") loggedWarmups++;
      if (content.durationSeconds !== null)
        recordedSeconds = (recordedSeconds ?? 0) + content.durationSeconds;
      else if (timed) missingTimedSets++;
    }
    const counted = logged.filter((s) => countsTowardTotals(s.content, options.countWarmups));
    sets += counted.length;
    if (isRepBased(entry.content.exerciseType as ExerciseType))
      for (const set of counted) reps += set.content.reps ?? 0;
    const usesBodyweight = options.usesBodyweight(entry.content.exerciseId);
    for (const set of counted) {
      volumeKg += setVolumeKg(set.content, entry.content, {
        usesBodyweight,
        bodyweightKg: options.bodyweightKg,
      });
    }
    if (logged.length)
      exercises.push({
        id: entry.id,
        name: entry.content.exerciseName,
        sets: counted.length,
        bars: [...logged]
          .sort((a, b) => a.content.position - b.content.position)
          .map((set) => ({
            setId: set.id,
            magnitude: storedSetMagnitude(set.content),
            warmup: set.content.type === "warmup",
          })),
      });
  }
  return {
    id: workout.id,
    title: workout.content.title,
    startedAt: workout.content.startedAt,
    durationMinutes: workoutMinutes(workout.content),
    volumeKg: Math.round(volumeKg * 10) / 10,
    sets,
    reps,
    exercises,
    loggedWarmups,
    excludedWarmups: options.countWarmups ? 0 : loggedWarmups,
    recordedSeconds,
    missingTimedSets,
  };
}

/** Finished workouts, newest first, grouped by the month they started in (local time). */
export function groupByMonth(
  summaries: WorkoutSummary[],
): { key: string; year: number; month: number; workouts: WorkoutSummary[] }[] {
  const groups = new Map<
    string,
    { key: string; year: number; month: number; workouts: WorkoutSummary[] }
  >();
  const sorted = [...summaries].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const summary of sorted) {
    const date = new Date(summary.startedAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, year: date.getFullYear(), month: date.getMonth(), workouts: [] };
      groups.set(key, group);
    }
    group.workouts.push(summary);
  }
  return [...groups.values()];
}

export function displayedWorkoutTitle(workout: WorkoutSummary) {
  return workout.title || "Workout";
}

export interface HistorySearchWorkout extends WorkoutSummary {
  matchingExerciseNames?: string[];
}

export function filterHistoryMonths(months: ReturnType<typeof groupByMonth>, query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return months;
  const matchExercise = exerciseMatcher(term);
  // A long history repeats the same movements across many sessions.
  const matchesByName = new Map<string, boolean>();
  const matchesName = (name: string) => {
    const cached = matchesByName.get(name);
    if (cached !== undefined) return cached;
    const matches = Boolean(matchExercise([name]));
    matchesByName.set(name, matches);
    return matches;
  };
  return months.flatMap((month) => {
    const workouts = month.workouts.flatMap<HistorySearchWorkout>((workout) => {
      const matchingExerciseNames = workout.exercises
        .filter((exercise) => matchesName(exercise.name))
        .map((exercise) => exercise.name);
      if (matchingExerciseNames.length) return [{ ...workout, matchingExerciseNames }];
      return displayedWorkoutTitle(workout).toLowerCase().includes(term) ? [workout] : [];
    });
    return workouts.length ? [{ ...month, workouts }] : [];
  });
}

export interface HistoryWeek {
  /** Local midnight of the week's first day, and of its last. */
  start: number;
  end: number;
  /** One entry per day, starting at the first weekday. */
  days: {
    start: number;
    date: number;
    letter: string;
    name: string;
    trained: boolean;
    today: boolean;
    sessions: WorkoutSummary[];
  }[];
  workouts: number;
  minutes: number;
  volumeKg: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Current week first, then the prior weeks with completed workouts. */
export function historyWeeks(
  summaries: WorkoutSummary[],
  now: number,
  firstWeekday: number,
): [HistoryWeek, ...HistoryWeek[]] {
  const current = startOfWeek(now, firstWeekday);
  const buckets = new Map<number, WorkoutSummary[]>();
  for (const workout of summaries) {
    const start = startOfWeek(Date.parse(workout.startedAt), firstWeekday);
    if (start > current) continue;
    const bucket = buckets.get(start);
    if (bucket) bucket.push(workout);
    else buckets.set(start, [workout]);
  }
  const today = new Date(now);
  const currentWeek = summarizeWeek(buckets.get(current) ?? [], new Date(current), today);
  buckets.delete(current);
  const previous = [...buckets]
    .sort(([a], [b]) => b - a)
    .map(([start, workouts]) => summarizeWeek(workouts, new Date(start), today));
  return [currentWeek, ...previous];
}

function summarizeWeek(summaries: WorkoutSummary[], first: Date, today: Date): HistoryWeek {
  const days = Array.from(
    { length: 7 },
    (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i),
  );
  const key = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const byDay = new Map<number, WorkoutSummary[]>();
  for (const session of [...summaries].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  )) {
    const day = new Date(session.startedAt).getDay();
    const sessions = byDay.get(day);
    if (sessions) sessions.push(session);
    else byDay.set(day, [session]);
  }
  const last = days[6] as Date;
  return {
    start: first.getTime(),
    end: last.getTime(),
    days: days.map((date) => ({
      start: date.getTime(),
      sessions: byDay.get(date.getDay()) ?? [],
      date: date.getDate(),
      letter: (DAY_NAMES[date.getDay()] as string)[0] as string,
      name: DAY_NAMES[date.getDay()] as string,
      trained: byDay.has(date.getDay()),
      today: key(date) === key(today),
    })),
    workouts: summaries.length,
    minutes: summaries.reduce((sum, s) => sum + s.durationMinutes, 0),
    volumeKg: summaries.reduce((sum, s) => sum + s.volumeKg, 0),
  };
}

/** A date in a month's grid, with the sessions that started on it. */
export interface MonthDay {
  date: number;
  /** Local midnight. */
  start: number;
  sessions: WorkoutSummary[];
  /** Any of its sessions holds a record. */
  record: boolean;
  today: boolean;
  /** After today. */
  ahead: boolean;
}

/** A month at a glance: its figures, and its dates laid out in weeks. */
export interface MonthOdometer {
  year: number;
  month: number;
  sessions: number;
  trainingDays: number;
  volumeKg: number;
  minutes: number;
  records: number;
  /** Whole weeks from the first weekday, with null before the 1st and after the last day. */
  cells: (MonthDay | null)[];
}

/**
 * A month's sessions, volume, time and records, with its dates in weeks starting at
 * `firstWeekday`. `recordsIn` says how many records a workout holds.
 */
export function monthOdometer(
  month: { year: number; month: number; workouts: WorkoutSummary[] },
  today: number,
  firstWeekday: number,
  recordsIn: (workoutId: string) => number,
): MonthOdometer {
  const byDate = new Map<number, WorkoutSummary[]>();
  for (const workout of month.workouts) {
    const date = new Date(workout.startedAt).getDate();
    const list = byDate.get(date);
    if (list) list.push(workout);
    else byDate.set(date, [workout]);
  }
  const now = new Date(today);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const lead = (new Date(month.year, month.month, 1).getDay() - firstWeekday + 7) % 7;
  const last = new Date(month.year, month.month + 1, 0).getDate();
  const cells: (MonthDay | null)[] = Array.from({ length: lead }, () => null);
  let records = 0;
  for (let date = 1; date <= last; date++) {
    const start = new Date(month.year, month.month, date).getTime();
    const sessions = byDate.get(date) ?? [];
    const held = sessions.reduce((sum, workout) => sum + recordsIn(workout.id), 0);
    records += held;
    cells.push({
      date,
      start,
      sessions,
      record: held > 0,
      today: start === midnight,
      ahead: start > midnight,
    });
  }
  while (cells.length % 7) cells.push(null);
  return {
    year: month.year,
    month: month.month,
    sessions: month.workouts.length,
    trainingDays: byDate.size,
    volumeKg: Math.round(month.workouts.reduce((sum, w) => sum + w.volumeKg, 0) * 10) / 10,
    minutes: month.workouts.reduce((sum, w) => sum + w.durationMinutes, 0),
    records,
    cells,
  };
}

/** The months with workouts, newest first, and the current month even before its first one. */
export function monthPages<T extends { key: string; year: number; month: number }>(
  months: (T & { workouts: WorkoutSummary[] })[],
  today: number,
): { key: string; year: number; month: number; workouts: WorkoutSummary[] }[] {
  const now = new Date(today);
  const year = now.getFullYear();
  const month = now.getMonth();
  if (months.some((page) => page.year === year && page.month === month)) return months;
  return [
    { year, month, key: `${year}-${String(month + 1).padStart(2, "0")}`, workouts: [] },
    ...months,
  ].sort((a, b) => b.year - a.year || b.month - a.month);
}
