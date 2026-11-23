import type { MuscleGroup } from "@leve/core";
import type { WorkoutTree } from "./past-workouts.ts";
import type { ExerciseHistory } from "./progress.ts";
import { countsTowardTotals } from "./volume.ts";

export interface MuscleTargets {
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
}
export type TargetLookup = (id: string) => MuscleTargets | undefined;
export type MuscleAmounts = Partial<Record<MuscleGroup, number>>;

/** How much a muscle is shaded, from 0 (untrained) to 4 (as much as the most-trained muscle). */
export type MuscleStep = 0 | 1 | 2 | 3 | 4;

/**
 * A value's shade among the others: ⌈4 × value ÷ max⌉, so the most-trained muscle is always the
 * darkest step and anything trained at all shows at least the first.
 */
export function muscleStep(value: number, max: number): MuscleStep {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.ceil((4 * value) / max)) as MuscleStep;
}

/** Each muscle's shade, measured against the largest amount. */
export function muscleSteps(amounts: MuscleAmounts): Map<string, MuscleStep> {
  const rows = Object.entries(amounts) as [string, number][];
  const max = Math.max(0, ...rows.map(([, value]) => value));
  return new Map(rows.map(([group, value]) => [group, muscleStep(value, max)]));
}

/** An exercise's own muscles as amounts: primary at the darkest step, secondary at the middle. */
export function targetAmounts(targets: MuscleTargets | undefined): MuscleAmounts {
  const amounts: MuscleAmounts = {};
  for (const group of targets?.secondaryMuscles ?? []) amounts[group] = 1;
  for (const group of targets?.primaryMuscles ?? []) amounts[group] = 2;
  return amounts;
}

/** Muscles with their amounts, most first; ties keep the order of the muscle's name. */
export function rankedMuscles(amounts: MuscleAmounts): [MuscleGroup, number][] {
  return (Object.entries(amounts) as [MuscleGroup, number][])
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A strip names at most this many muscles before it shortens to the first few and a count. */
export const STRIP_CAP = 4;
const STRIP_SHOWN = 3;

/**
 * The names a compact strip shows: every muscle up to four; past that the first three and how many
 * more there are (unless the whole list is open).
 */
export function stripNames<T>(rows: readonly T[], expanded = false): { shown: T[]; more: number } {
  if (rows.length <= STRIP_CAP || expanded) return { shown: [...rows], more: 0 };
  return { shown: rows.slice(0, STRIP_SHOWN), more: rows.length - STRIP_SHOWN };
}

function credit(amounts: MuscleAmounts, targets: MuscleTargets | undefined, value: number) {
  if (value <= 0) return;
  const primary = new Set(targets?.primaryMuscles ?? (["other"] as const));
  for (const group of primary) amounts[group] = (amounts[group] ?? 0) + value;
  for (const secondary of new Set(targets?.secondaryMuscles)) {
    if (!primary.has(secondary)) amounts[secondary] = (amounts[secondary] ?? 0) + value / 2;
  }
}

export function workoutMuscleSets(tree: WorkoutTree, countWarmups: boolean, lookup: TargetLookup) {
  const amounts: MuscleAmounts = {};
  for (const { entry, sets } of tree.entries) {
    credit(
      amounts,
      lookup(entry.content.exerciseId),
      sets.filter((set) => countsTowardTotals(set.content, countWarmups)).length,
    );
  }
  return amounts;
}

export interface MuscleContribution {
  exerciseId: string;
  name: string;
  /** Counted sets, or kilograms lifted when measuring volume. */
  sets: number;
  credit: number;
}

/** What a muscle total counts: counted sets, or the kilograms those sets lifted. */
export type MuscleMeasure = "sets" | "volume";

/**
 * Each muscle's share of a period's training. Every counted set (or its volume) adds in full to
 * each primary muscle of its exercise and half to each secondary one. `total` is the period's own
 * count, each set once, for shares of the whole.
 */
export function periodMuscleActivity(
  exercises: ExerciseHistory[],
  start: number,
  end: number,
  lookup: TargetLookup,
  measure: MuscleMeasure = "sets",
) {
  const amounts: MuscleAmounts = {};
  const byGroup = new Map<string, MuscleContribution[]>();
  let total = 0;
  for (const exercise of exercises) {
    let sets = 0;
    for (const session of exercise.sessions) {
      if (session.time >= start && session.time < end) {
        sets += measure === "sets" ? session.counted : (session.best.volumeKg ?? 0);
      }
    }
    if (!sets) continue;
    total += sets;
    const contributed: MuscleAmounts = {};
    credit(contributed, lookup(exercise.exerciseId), sets);
    for (const group of Object.keys(contributed) as MuscleGroup[]) {
      const value = contributed[group] ?? 0;
      amounts[group] = (amounts[group] ?? 0) + value;
      const row = { exerciseId: exercise.exerciseId, name: exercise.name, sets, credit: value };
      const rows = byGroup.get(group);
      if (rows) rows.push(row);
      else byGroup.set(group, [row]);
    }
  }
  for (const rows of byGroup.values()) {
    rows.sort(
      (a, b) =>
        b.credit - a.credit ||
        a.name.localeCompare(b.name) ||
        a.exerciseId.localeCompare(b.exerciseId),
    );
  }
  return { amounts, byGroup, total };
}

export function periodMuscleSets(
  exercises: ExerciseHistory[],
  start: number,
  end: number,
  lookup: TargetLookup,
) {
  return periodMuscleActivity(exercises, start, end, lookup).amounts;
}

/** A list of exercises under a heading, e.g. the ones that work a chosen muscle first. */
export interface ExerciseSection<T> {
  key: string;
  title: string;
  data: T[];
}

/**
 * Exercises split by a chosen muscle: the ones that target it first (primary), then the ones that
 * also work it (secondary). Each keeps the order it came in. Exercises without known muscles count
 * as "other". With no muscle chosen, one untitled list.
 */
export function muscleSections<T>(
  items: readonly T[],
  muscle: string,
  targets: (item: T) => MuscleTargets | undefined,
  name: (muscle: string) => string,
): ExerciseSection<T>[] {
  if (!muscle) return [{ key: "all", title: "", data: [...items] }];
  const primary: T[] = [];
  const also: T[] = [];
  for (const item of items) {
    const own = targets(item);
    const first: readonly string[] = own ? own.primaryMuscles : ["other"];
    if (first.includes(muscle)) primary.push(item);
    else if (own?.secondaryMuscles.some((group) => group === muscle)) also.push(item);
  }
  const label = name(muscle);
  return [
    { key: "primary", title: `${label} · primary`, data: primary },
    { key: "also", title: `Also works ${label.toLowerCase()}`, data: also },
  ].filter((section) => section.data.length > 0);
}

/** How far back the muscle breakdown looks. */
export type MusclePeriod = "7d" | "30d" | "3m";
export const MUSCLE_PERIODS: readonly { value: MusclePeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
];

/**
 * A period's bounds, given `now`: from the start of the day 6 or 29 days earlier (so today is the
 * seventh or thirtieth day), or of the same day three months earlier, to the end of today.
 */
export function musclePeriodBounds(period: MusclePeriod, now: number) {
  const d = new Date(now);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  if (period === "3m") {
    const month = d.getMonth() - 3;
    const days = new Date(d.getFullYear(), month + 1, 0).getDate();
    return { start: new Date(d.getFullYear(), month, Math.min(d.getDate(), days)).getTime(), end };
  }
  const back = period === "7d" ? 6 : 29;
  return { start: new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(), end };
}
