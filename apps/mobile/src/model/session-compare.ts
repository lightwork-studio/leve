import type { ExerciseType } from "@leve/core";
import { type BarcodeSet, storedSetMagnitude } from "./barcode.ts";
import type { WorkoutSummary, WorkoutTree } from "./past-workouts.ts";
import {
  beats,
  type ExerciseMetric,
  type ExerciseSession,
  exerciseMetrics,
  metricValue,
  type ProgressIndex,
} from "./progress.ts";

/*
 * How a finished workout compares with earlier ones, for its summary. Provisional rules:
 *
 * - Each exercise is compared with the last earlier session that had it, on its first measure (in
 *   the order the exercise's charts offer them: estimated 1RM for weight and reps, heaviest weight
 *   for weighted bodyweight, most reps in a set for bodyweight, longest time or distance) that both
 *   sessions have. It went up when this session's value beats last time's, by the same margin a
 *   record must; down when last time's beats this one; otherwise it is the same. An exercise
 *   without an earlier session, or without a measure both have, is left out.
 * - The volume change compares the workout with the last earlier session of the same routine, as
 *   a whole percentage. It is left out without such a session or when either has no volume.
 */

export interface ExerciseChange {
  exerciseId: string;
  exerciseName: string;
  type: ExerciseType;
  metric: ExerciseMetric;
  now: number;
  before: number;
  direction: "up" | "same" | "down";
}

export interface VersusLastTime {
  up: ExerciseChange[];
  same: ExerciseChange[];
  down: ExerciseChange[];
  volume: { nowKg: number; beforeKg: number; percent: number } | null;
}

/** This workout's session of an exercise, and the one before it, from the progress index. */
function sessionPair(index: ProgressIndex, exerciseId: string, workoutId: string) {
  const history = index.byExercise.get(exerciseId);
  if (!history) return null;
  const at = history.sessions.findIndex((session) => session.workoutId === workoutId);
  if (at < 0) return null;
  return {
    history,
    now: history.sessions[at] as ExerciseSession,
    before: history.sessions[at + 1] ?? null,
  };
}

/**
 * The workout against last time: which exercises went up, stayed the same or went down, and the
 * volume change since the routine's last session. Null when there is nothing to compare with.
 */
export function versusLastTime(
  index: ProgressIndex,
  tree: WorkoutTree,
  summary: Pick<WorkoutSummary, "volumeKg">,
  routineLast: Pick<WorkoutSummary, "volumeKg"> | null,
): VersusLastTime | null {
  const result: VersusLastTime = { up: [], same: [], down: [], volume: null };
  const seen = new Set<string>();
  for (const { entry } of tree.entries) {
    const { exerciseId, exerciseName } = entry.content;
    if (seen.has(exerciseId)) continue;
    seen.add(exerciseId);
    const pair = sessionPair(index, exerciseId, tree.workout.id);
    if (!pair?.before) continue;
    const type = entry.content.exerciseType as ExerciseType;
    const before = pair.before;
    const metric = exerciseMetrics(type, pair.history.usesBodyweight).find(
      (m) => metricValue(pair.now, m) !== null && metricValue(before, m) !== null,
    );
    if (!metric) continue;
    const now = metricValue(pair.now, metric) as number;
    const was = metricValue(before, metric) as number;
    const direction = beats(now, was) ? "up" : beats(was, now) ? "down" : "same";
    result[direction].push({ exerciseId, exerciseName, type, metric, now, before: was, direction });
  }
  if (routineLast && routineLast.volumeKg > 0 && summary.volumeKg > 0) {
    result.volume = {
      nowKg: summary.volumeKg,
      beforeKg: routineLast.volumeKg,
      percent: Math.round((summary.volumeKg / routineLast.volumeKg - 1) * 100),
    };
  }
  const empty = !result.up.length && !result.same.length && !result.down.length;
  return empty && !result.volume ? null : result;
}

/**
 * Each exercise's logged sets as a barcode, by workout exercise, with last time's matching set
 * behind each: the set in the same place among the logged sets of the exercise's previous
 * session. A second entry of the same exercise carries on where the first stopped. Sets in
 * `recordSets` are marked as records.
 */
export function compareBarcodes(
  index: ProgressIndex,
  tree: WorkoutTree,
  recordSets: ReadonlySet<string> = new Set(),
): Map<string, BarcodeSet[]> {
  const bars = new Map<string, BarcodeSet[]>();
  const used = new Map<string, number>();
  const entries = [...tree.entries].sort(
    (a, b) => a.entry.content.position - b.entry.content.position,
  );
  for (const { entry, sets } of entries) {
    const { exerciseId } = entry.content;
    const before = sessionPair(index, exerciseId, tree.workout.id)?.before;
    const previous = (before?.sets ?? []).filter((set) => set.content.completedAt !== null);
    const logged = sets
      .filter((set) => set.content.completedAt !== null)
      .sort((a, b) => a.content.position - b.content.position);
    const offset = used.get(exerciseId) ?? 0;
    used.set(exerciseId, offset + logged.length);
    bars.set(
      entry.id,
      logged.map((set, i) => {
        const last = previous[offset + i];
        return {
          magnitude: storedSetMagnitude(set.content),
          previous: last ? storedSetMagnitude(last.content) : null,
          warmup: set.content.type === "warmup",
          record: recordSets.has(set.id),
        };
      }),
    );
  }
  return bars;
}
