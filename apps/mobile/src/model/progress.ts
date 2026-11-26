import {
  beats,
  type ExerciseHistory,
  type ExerciseMetric,
  type ExerciseSession,
  type ExerciseType,
  estimatedOneRepMax,
  exerciseMetrics,
  exerciseRecords,
  metricValue,
  type ProgressIndex,
  RECORD_METRICS,
  type WorkoutPoint,
} from "@leve/core";
import type { WorkoutTree } from "./past-workouts.ts";
import { calendarDaysBetween } from "./time.ts";
import { startOfWeek } from "./train.ts";
import type { WithId, WorkoutSet } from "./types.ts";

// The figures themselves (sessions, bests, records) are in @leve/core, shared with the server's
// MCP tools. This file adds what the screens need on top: local-time charts, axes and records.
export {
  beats,
  buildProgress,
  type ExerciseHistory,
  type ExerciseMetric,
  type ExerciseRecord,
  type ExerciseSession,
  estimatedOneRepMax,
  exerciseMetrics,
  exerciseRecords,
  METRIC_KIND,
  metricValue,
  type ProgressIndex,
  type ProgressOptions,
  type SessionBest,
  sessionBest,
  type WorkoutPoint,
} from "@leve/core";

/** Distinct local training days in adjacent four-week windows ending today. */
export function trainingFrequency(workouts: WorkoutPoint[], today: number) {
  const recent = new Set<number>();
  const previous = new Set<number>();
  for (const workout of workouts) {
    const age = calendarDaysBetween(workout.time, today);
    if (age < 0 || age >= 56) continue;
    (age < 28 ? recent : previous).add(age);
  }
  return { recent: recent.size, previous: previous.size };
}

// ——— Weekly chart ———

export type Range = "3M" | "1Y" | "All";
export const RANGES: readonly Range[] = ["3M", "1Y", "All"];

/** Weeks shown for a range: twelve for three months, 52 for a year. */
export const RANGE_WEEKS = { "3M": 12, "1Y": 52 } as const;

export interface Bucket {
  /** Local start, ms. */
  start: number;
  /** Local start of the next bucket, ms. */
  end: number;
  workouts: number;
  minutes: number;
  volumeKg: number;
  reps: number;
  sets: number;
}

export interface Series {
  unit: "week" | "month";
  /** Oldest first; the last is the current week (or month). */
  buckets: Bucket[];
}

const addDays = (time: number, days: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
};
const startOfMonth = (time: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};
const addMonths = (time: number, months: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth() + months, 1).getTime();
};

/**
 * Totals per week (or per month, for "All" over more than a year) up to the one containing `now`,
 * from one pass over the workouts. Weeks start on `firstWeekday`; empty weeks are zeros. "All"
 * starts at the first workout's week, but never shows fewer weeks than "3M".
 */
export function chartSeries(
  workouts: WorkoutPoint[],
  range: Range,
  now: number,
  firstWeekday: number,
): Series {
  const thisWeek = startOfWeek(now, firstWeekday);
  let unit: Series["unit"] = "week";
  let first: number;
  if (range === "All") {
    const earliest = workouts.reduce((min, w) => Math.min(min, w.time), now);
    const earliestWeek = startOfWeek(earliest, firstWeekday);
    const shortest = addDays(thisWeek, -7 * (RANGE_WEEKS["3M"] - 1));
    first = Math.min(earliestWeek, shortest);
    if (first < addDays(thisWeek, -7 * (RANGE_WEEKS["1Y"] - 1))) {
      unit = "month";
      first = startOfMonth(earliest);
    }
  } else first = addDays(thisWeek, -7 * (RANGE_WEEKS[range] - 1));

  const buckets: Bucket[] = [];
  const index = new Map<number, number>();
  const last = unit === "week" ? thisWeek : startOfMonth(now);
  for (let start = first; start <= last; ) {
    const end = unit === "week" ? addDays(start, 7) : addMonths(start, 1);
    index.set(start, buckets.length);
    buckets.push({ start, end, workouts: 0, minutes: 0, volumeKg: 0, reps: 0, sets: 0 });
    start = end;
  }
  for (const w of workouts) {
    if (w.time < first) continue;
    const key = unit === "week" ? startOfWeek(w.time, firstWeekday) : startOfMonth(w.time);
    const at = index.get(key);
    if (at === undefined) continue; // after now (a clock ahead elsewhere)
    const bucket = buckets[at] as Bucket;
    bucket.workouts += 1;
    bucket.minutes += w.minutes;
    bucket.volumeKg += w.volumeKg;
    bucket.reps += w.reps;
    bucket.sets += w.sets;
  }
  return { unit, buckets };
}

/** This week's totals: the week containing `now`. */
export function weekTotals(workouts: WorkoutPoint[], now: number, firstWeekday: number): Bucket {
  const start = startOfWeek(now, firstWeekday);
  const end = addDays(start, 7);
  const bucket: Bucket = { start, end, workouts: 0, minutes: 0, volumeKg: 0, reps: 0, sets: 0 };
  for (const w of workouts) {
    if (w.time < start || w.time >= end) continue;
    bucket.workouts += 1;
    bucket.minutes += w.minutes;
    bucket.volumeKg += w.volumeKg;
    bucket.reps += w.reps;
    bucket.sets += w.sets;
  }
  return bucket;
}

/**
 * Where month names go under a chart of buckets: the first bucket of each month (a week counts
 * for the month of its last day, so the week holding the 1st carries the name). Monthly charts
 * name Januaries by their year instead.
 */
export function monthMarks(series: Series): { index: number; month: number; year: number }[] {
  const marks: { index: number; month: number; year: number }[] = [];
  let previous = -1;
  series.buckets.forEach((bucket, index) => {
    const at = new Date(series.unit === "week" ? addDays(bucket.start, 6) : bucket.start);
    const key = at.getFullYear() * 12 + at.getMonth();
    if (key !== previous) {
      if (series.unit === "week" || at.getMonth() === 0 || index === 0) {
        marks.push({ index, month: at.getMonth(), year: at.getFullYear() });
      }
      previous = key;
    }
  });
  return marks;
}

// ——— Axes ———

/** A top for a bar axis whose halfway line is a round value: 1, 2, 4, 5, 6 or 8 × 10ⁿ. */
export function barAxisTop(max: number, whole = true): number {
  if (!(max > 0)) return whole ? 2 : 1;
  const steps = [1, 2, 4, 5, 6, 8, 10];
  let magnitude = 10 ** Math.floor(Math.log10(max));
  if (whole && magnitude < 1) magnitude = 1;
  for (const step of steps) {
    const top = step * magnitude;
    if (top >= max && (!whole || top >= 2)) return top;
  }
  return 10 * magnitude;
}

/** A top for an axis of minutes: 20, 30, 40 or 60 minutes, then even numbers of hours. */
export function durationAxisTop(minutes: number): number {
  if (!(minutes > 0)) return 60;
  for (const top of [20, 30, 40, 60]) if (minutes <= top) return top;
  return Math.ceil(minutes / 120) * 120;
}

/**
 * What a line chart's values count, which limits where its lines may go: any round number, whole
 * numbers only (reps, metres), or whole seconds in steps a clock reads easily.
 */
export type AxisKind = "decimal" | "whole" | "seconds";

/**
 * Three evenly spaced, round lines around a set of values, for a line chart: the step is
 * 1, 2, 2.5 or 5 × 10ⁿ (whole for a whole axis; 1 s to an hour in clock steps, then hours, for
 * seconds), the lowest line a multiple of the step or of half of it (whole, unless decimal), and
 * the lines cover every value as tightly as those allow. A single value sits on the middle line.
 */
export function lineAxis(
  values: number[],
  kind: AxisKind = "decimal",
): { low: number; step: number; high: number } {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { low: 0, step: 1, high: 2 };
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  // Values equal but for float noise (the same sets summed in another order) are one value; an
  // axis spanning only the noise would draw them at its top and bottom as if they were far apart.
  if (hi - lo <= 1e-9 * Math.max(1, Math.abs(hi))) {
    lo = hi;
    const pad = Math.abs(hi) * 0.05 || 1;
    lo -= pad;
    hi += pad;
  }
  for (const step of axisSteps(kind, hi - lo)) {
    for (const grain of [step, step / 2]) {
      // Lines of a whole axis fall on whole numbers.
      if (kind !== "decimal" && !Number.isInteger(grain)) continue;
      const low = Math.floor(lo / grain) * grain;
      if (low + 2 * step >= hi) return { low, step, high: low + 2 * step };
    }
  }
  return { low: lo, step: (hi - lo) / 2, high: hi };
}

/** Steps for an axis of seconds up to an hour; beyond that, hours that keep doubling. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600];

/**
 * The steps a line axis may use, smallest first, up to one that covers `span` (a step that large
 * always does).
 */
function axisSteps(kind: AxisKind, span: number): number[] {
  const steps: number[] = [];
  if (kind === "seconds") {
    steps.push(...SECOND_STEPS);
    for (let step = 7200; (steps.at(-1) ?? 0) < span; step *= 2) steps.push(step);
    return steps;
  }
  let magnitude = 10 ** Math.floor(Math.log10(span / 2));
  if (kind === "whole" && magnitude < 1) magnitude = 1;
  // A guard, not a case real data reaches: a vanishing span would give a magnitude of 0.
  if (!(magnitude > 0)) magnitude = 1e-9;
  for (let tries = 0; (steps.at(-1) ?? 0) < span && tries < 40; tries++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * magnitude;
      if (kind === "decimal" || Number.isInteger(step)) steps.push(step);
    }
    magnitude *= 10;
  }
  return steps;
}

/** The axis a metric is charted on: reps and metres are whole, times whole seconds. */
export const METRIC_AXIS: Record<ExerciseMetric, AxisKind> = {
  oneRepMax: "decimal",
  heaviest: "decimal",
  bestSetVolume: "decimal",
  sessionVolume: "decimal",
  mostReps: "whole",
  sessionReps: "whole",
  longestDuration: "seconds",
  longestDistance: "whole",
};

/**
 * One point per day with a value, oldest first, from `since` on. Sessions on the same local day
 * make one point, that day's best (the first session to reach it), so the line doesn't draw a
 * cliff between two points at almost the same time.
 */
export function metricPoints(
  sessions: ExerciseSession[],
  metric: ExerciseMetric,
  since: number,
): { time: number; value: number; workoutId: string }[] {
  const points: { time: number; value: number; workoutId: string }[] = [];
  let lastDay = Number.NaN;
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i] as ExerciseSession;
    if (session.time < since) continue;
    const value = metricValue(session, metric);
    if (value === null) continue;
    const day = startOfDay(session.time);
    const point = { time: session.time, value, workoutId: session.workoutId };
    if (day !== lastDay) points.push(point);
    else if (beats(value, (points.at(-1) as { value: number }).value)) {
      points[points.length - 1] = point;
    }
    lastDay = day;
  }
  return points;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** How much of a chart may stay empty at its start before it says so: a third. */
export const EMPTY_LEAD = 1 / 3;

/**
 * Where a chart's data starts, from 0 (its left edge) to 1, when everything before it is empty and
 * takes at least a third of the chart (see EMPTY_LEAD), so it can say "No workouts before …".
 * Null when the data starts sooner, or there is none.
 */
export function emptyLead(firstAt: number | null | undefined): number | null {
  if (firstAt === null || firstAt === undefined) return null;
  return firstAt >= EMPTY_LEAD && firstAt < 1 ? firstAt : null;
}

/** A bar chart's empty start (see emptyLead): the share of its buckets before the first workout. */
export function seriesLead(series: Series): { share: number; start: number } | null {
  const at = series.buckets.findIndex((bucket) => bucket.workouts > 0);
  if (at < 0) return null;
  const share = emptyLead(at / series.buckets.length);
  return share === null ? null : { share, start: (series.buckets[at] as Bucket).start };
}

/**
 * The first moment a range covers, given `now`: the start of the same day three months or a year
 * earlier, or of that month's last day when it is shorter (31 May → 28 Feb, 29 Feb → 28 Feb).
 */
export function rangeStart(range: Range, now: number): number {
  if (range === "All") return Number.NEGATIVE_INFINITY;
  const d = new Date(now);
  const month = d.getMonth() - (range === "3M" ? 3 : 12);
  // Day 0 of the month after is the last day of the month itself.
  const days = new Date(d.getFullYear(), month + 1, 0).getDate();
  return new Date(d.getFullYear(), month, Math.min(d.getDate(), days)).getTime();
}
/**
 * Records first reached in this workout, evaluated against the sessions through that date. Each
 * says what it beat: the best before this workout, or null the first time there was a value.
 */
export function workoutRecords(index: ProgressIndex, tree: WorkoutTree) {
  const seen = new Set<string>();
  return tree.entries.flatMap(({ entry }) => {
    const { exerciseId, exerciseName, exerciseType } = entry.content;
    if (seen.has(exerciseId)) return [];
    seen.add(exerciseId);
    const history = index.byExercise.get(exerciseId);
    if (!history) return [];
    const at = history.sessions.findIndex((session) => session.workoutId === tree.workout.id);
    if (at < 0) return [];
    const type = exerciseType as ExerciseType;
    const records = exerciseRecords({
      ...history,
      type,
      sessions: history.sessions.slice(at),
    }).filter((record) => record.workoutId === tree.workout.id);
    if (!records.length) return [];
    const earlier = exerciseRecords({ ...history, type, sessions: history.sessions.slice(at + 1) });
    const was = new Map(earlier.map((record) => [record.metric, record.value]));
    return [
      {
        exerciseId,
        exerciseName,
        type,
        records: records.map((record) => ({ ...record, before: was.get(record.metric) ?? null })),
      },
    ];
  });
}

// The index is rebuilt when the history changes, so its records are worked out once per index.
const recordCache = new WeakMap<ProgressIndex, Map<string, WorkoutRecord[]>>();

/** A record a workout reached: its value, what it beat, and the set that reached it. */
export interface WorkoutRecord {
  exerciseId: string;
  metric: ExerciseMetric;
  value: number;
  /** The best before this workout, or null the first time there was a value. */
  before: number | null;
  /** The first set to reach it, for a record one set holds; null for a session total. */
  setId: string | null;
}

/** What a set holds for a metric one set can reach on its own, or null. */
function setValue(set: WorkoutSet, metric: ExerciseMetric): number | null {
  switch (metric) {
    case "heaviest":
      return set.weightKg;
    case "oneRepMax":
      return estimatedOneRepMax(set.weightKg, set.reps);
    case "mostReps":
      return set.reps;
    case "longestDuration":
      return set.durationSeconds;
    case "longestDistance":
      return set.distanceMeters;
    default:
      return null;
  }
}

/** The first logged set reaching `value`, preferring working sets over warm-ups. */
function recordSet(session: ExerciseSession, metric: ExerciseMetric, value: number) {
  const logged = session.sets.filter((set) => set.content.completedAt !== null);
  const reaches = (set: WithId<WorkoutSet>) => {
    const own = setValue(set.content, metric);
    return own !== null && !beats(value, own);
  };
  const found =
    logged.find((set) => set.content.type !== "warmup" && reaches(set)) ?? logged.find(reaches);
  return found?.id ?? null;
}

/**
 * Every workout's records, from one pass over each exercise's sessions, oldest first. A
 * session holds a record where it beats every earlier session (or is the first with a value), the
 * same rule as `workoutRecords`, which looks at one workout.
 */
export function recordsByWorkout(index: ProgressIndex): Map<string, WorkoutRecord[]> {
  const known = recordCache.get(index);
  if (known) return known;
  const byWorkout = new Map<string, WorkoutRecord[]>();
  recordCache.set(index, byWorkout);
  for (const history of index.exercises) {
    const best = new Map<ExerciseMetric, number>();
    for (let i = history.sessions.length - 1; i >= 0; i--) {
      const session = history.sessions[i] as ExerciseSession;
      const applies = exerciseMetrics(session.exerciseType as ExerciseType, history.usesBodyweight);
      for (const metric of RECORD_METRICS) {
        const value = metricValue(session, metric);
        if (value === null) continue;
        const before = best.get(metric);
        if (before !== undefined && !beats(value, before)) continue;
        best.set(metric, value);
        if (!applies.includes(metric)) continue;
        const list = byWorkout.get(session.workoutId) ?? [];
        list.push({
          exerciseId: history.exerciseId,
          metric,
          value,
          before: before ?? null,
          setId: recordSet(session, metric, value),
        });
        byWorkout.set(session.workoutId, list);
      }
    }
  }
  return byWorkout;
}

/**
 * The first of each month between two moments, for names under a chart over time. Over more than
 * fifteen months only Januaries are named (by their year), so the names don't crowd.
 */
export function monthStarts(
  from: number,
  to: number,
): { time: number; month: number; year: number; yearly: boolean }[] {
  if (!(to > from)) return [];
  const yearly = to - from > 15 * 31 * 86_400_000;
  const marks: { time: number; month: number; year: number; yearly: boolean }[] = [];
  for (let time = addMonths(from, 1); time <= to; time = addMonths(time, 1)) {
    const d = new Date(time);
    if (!yearly || d.getMonth() === 0) {
      marks.push({ time, month: d.getMonth(), year: d.getFullYear(), yearly });
    }
  }
  return marks;
}

/** A record with the workout and time it was reached. */
export interface DatedRecord extends WorkoutRecord {
  workoutId: string;
  time: number;
}

/** The latest records, newest workout first (within a workout, in the order they were found). */
export function recentRecords(index: ProgressIndex, limit: number): DatedRecord[] {
  const byWorkout = recordsByWorkout(index);
  const found: DatedRecord[] = [];
  for (let i = index.workouts.length - 1; i >= 0 && found.length < limit; i--) {
    const workout = index.workouts[i] as WorkoutPoint;
    for (const record of byWorkout.get(workout.id) ?? []) {
      found.push({ ...record, workoutId: workout.id, time: workout.time });
    }
  }
  return found.slice(0, limit);
}

/** One of the lifts trained most, with its main measure over its latest sessions. */
export interface MainLift {
  history: ExerciseHistory;
  metric: ExerciseMetric;
  /** The measure in up to 12 latest sessions, oldest first. */
  values: number[];
  latest: number;
  /** Latest minus the first of those sessions. */
  change: number;
}

/**
 * The exercises trained most in the three months to `now` (then most overall, then most recently),
 * each with the first measure its type charts (estimated 1RM for weight and reps).
 */
export function mainLifts(index: ProgressIndex, now: number, limit: number): MainLift[] {
  const since = rangeStart("3M", now);
  const recent = (history: ExerciseHistory) =>
    history.sessions.filter((session) => session.time >= since).length;
  const ranked = index.exercises
    .map((history) => ({ history, recent: recent(history) }))
    .sort(
      (a, b) =>
        b.recent - a.recent ||
        b.history.sessions.length - a.history.sessions.length ||
        (b.history.sessions[0]?.time ?? 0) - (a.history.sessions[0]?.time ?? 0),
    );
  const lifts: MainLift[] = [];
  for (const { history } of ranked) {
    if (lifts.length >= limit) break;
    const metric = exerciseMetrics(history.type, history.usesBodyweight)[0];
    if (!metric) continue;
    const values = history.sessions
      .slice(0, 12)
      .map((session) => metricValue(session, metric))
      .filter((value): value is number => value !== null)
      .reverse();
    const latest = values.at(-1);
    if (latest === undefined) continue;
    lifts.push({ history, metric, values, latest, change: latest - (values[0] as number) });
  }
  return lifts;
}
