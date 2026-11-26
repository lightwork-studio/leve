import { type ExerciseType, isRepBased } from "./exercise.ts";
import type { WorkoutContent, WorkoutEntryContent, WorkoutSetContent } from "./records.ts";

/**
 * Volume of one completed set in kilograms. Provisional rules, following the field notes in
 * @leve/core: only sets that count reps have volume; an exercise that uses bodyweight counts the
 * lifter's bodyweight, plus added load or minus assistance; dumbbell weight counts twice when the
 * entry says so.
 */
export function setVolumeKg(
  set: WorkoutSetContent,
  entry: Pick<WorkoutEntryContent, "exerciseType" | "doubleDumbbellVolume">,
  options: { usesBodyweight: boolean; bodyweightKg: number | null },
): number {
  if (set.completedAt === null || set.reps === null) return 0;
  const type = entry.exerciseType as ExerciseType;
  if (!isRepBased(type)) return 0;
  const weight = (set.weightKg ?? 0) * (entry.doubleDumbbellVolume ? 2 : 1);
  const body = options.usesBodyweight ? (options.bodyweightKg ?? 0) : 0;
  const load = type === "assisted_bodyweight" ? body - weight : body + weight;
  return Math.max(0, load) * set.reps;
}

/** Whether a set counts toward a workout's figures (warm-ups only when the setting says so). */
export function countsTowardTotals(set: WorkoutSetContent, countWarmups: boolean): boolean {
  return set.completedAt !== null && (countWarmups || set.type !== "warmup");
}

/** A finished workout's length in whole minutes; never negative, whatever another device sent. */
export function workoutMinutes(workout: WorkoutContent): number {
  if (workout.endedAt === null) return 0;
  const ms = Date.parse(workout.endedAt) - Date.parse(workout.startedAt);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0;
}
