import { type WeightUnit, weightFromKg } from "@leve/core";
import type { WorkoutSummary, WorkoutTree } from "./past-workouts.ts";
import { estimatedOneRepMax } from "./progress.ts";
import { countsTowardTotals } from "./volume.ts";

/*
 * What the saved summary picks out of a finished workout. Provisional rules:
 *
 * - The best set is the set with the highest estimated one-rep max (see estimatedOneRepMax), among
 *   the sets that count toward the workout's figures, of weight-and-reps exercises only (the only
 *   type that has an estimate). The first such set wins a tie. A workout without one has no best
 *   set.
 * - A change since last time compares whole numbers in the unit shown, so a difference the screen
 *   can't show reads as the same.
 */

/** All recorded exercises appear on the receipt, including sessions made up of warm-ups. */
export function loggedExercises(tree: WorkoutTree) {
  return tree.entries.flatMap(({ entry, sets }) => {
    const logged = sets.filter((set) => set.content.completedAt !== null);
    if (!logged.length) return [];
    const warmups = logged.filter((set) => set.content.type === "warmup").length;
    const durations = logged
      .map((set) => set.content.durationSeconds)
      .filter((seconds) => seconds !== null);
    return [
      {
        id: entry.id,
        name: entry.content.exerciseName,
        otherSets: logged.length - warmups,
        warmups,
        seconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
        partialTime: durations.length > 0 && durations.length < logged.length,
      },
    ];
  });
}

export interface BestSet {
  /** The workout exercise it belongs to. */
  entryId: string;
  exerciseId: string;
  exerciseName: string;
  weightKg: number;
  reps: number;
  oneRepMaxKg: number;
}

/** The workout's standout set, or null when no set has an estimated one-rep max. */
export function bestSet(tree: WorkoutTree, countWarmups: boolean): BestSet | null {
  let best: BestSet | null = null;
  for (const { entry, sets } of tree.entries) {
    if (entry.content.exerciseType !== "weight_reps") continue;
    for (const { content: set } of sets) {
      if (!countsTowardTotals(set, countWarmups)) continue;
      const oneRepMaxKg = estimatedOneRepMax(set.weightKg, set.reps);
      if (oneRepMaxKg === null || (best !== null && oneRepMaxKg <= best.oneRepMaxKg)) continue;
      best = {
        entryId: entry.id,
        exerciseId: entry.content.exerciseId,
        exerciseName: entry.content.exerciseName,
        weightKg: set.weightKg as number,
        reps: set.reps as number,
        oneRepMaxKg,
      };
    }
  }
  return best;
}

export interface Change {
  direction: "up" | "down" | "same";
  /** How much it changed by, as a whole number of the unit shown (never negative). */
  amount: number;
}

/** How a figure changed since last time, both given in the unit shown. */
export function changeSince(now: number, before: number): Change {
  const difference = Math.round(now) - Math.round(before);
  if (difference === 0) return { direction: "same", amount: 0 };
  return { direction: difference > 0 ? "up" : "down", amount: Math.abs(difference) };
}

/** Only compare set durations when both workouts report complete measurements. */
export function effortComparison(now: WorkoutSummary, before: WorkoutSummary, unit: WeightUnit) {
  if (now.volumeKg === 0 && before.volumeKg === 0) {
    if (now.missingTimedSets || before.missingTimedSets) return null;
    if (now.recordedSeconds !== null && before.recordedSeconds !== null)
      return { metric: "time" as const, now: now.recordedSeconds, before: before.recordedSeconds };
  }
  return {
    metric: "volume" as const,
    now: Math.round(weightFromKg(now.volumeKg, unit)),
    before: Math.round(weightFromKg(before.volumeKg, unit)),
  };
}
