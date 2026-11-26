import {
  type BuiltInExercise,
  builtInExercise,
  exerciseLibrary,
  type MuscleGroup,
} from "@leve/core";
import { exerciseMatcher } from "../model/exercise-search.ts";
import type { MuscleTargets } from "../model/muscle-map.ts";

// The library itself (catalogue, Leve's names and types) is in @leve/core, shared with the server.
export { type BuiltInExercise, builtInExercise, EXERCISES, exerciseLibrary } from "@leve/core";

const TARGETS_BY_ID = new Map(
  exerciseLibrary.map(({ id, primaryMuscles, secondaryMuscles }) => [
    id,
    { primaryMuscles, secondaryMuscles },
  ]),
);

export interface PickerExercise extends BuiltInExercise {
  equipment: string;
  catalogName?: string;
  muscles: string[];
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
}

export function findExercises(
  query: string,
  muscle: string,
  library: readonly PickerExercise[] = exerciseLibrary,
) {
  const filtered = muscle
    ? library.filter((e) => [...e.primaryMuscles, ...e.secondaryMuscles].some((g) => g === muscle))
    : library;
  if (!query.trim()) return filtered.slice();

  const match = exerciseMatcher(query);
  const exact: PickerExercise[] = [];
  const partial: PickerExercise[] = [];
  for (const exercise of filtered) {
    const names = [exercise.name];
    if (exercise.catalogName && exercise.catalogName !== exercise.name)
      names.push(exercise.catalogName);
    const details = [
      exercise.equipment,
      ...exercise.muscles,
      ...exercise.primaryMuscles,
      ...exercise.secondaryMuscles,
    ].join(" ");
    const result = match(names, details);
    if (result === "exact") exact.push(exercise);
    if (result === "partial") partial.push(exercise);
  }
  return exact.concat(partial);
}

/** Search logged rows in their existing, most-recent-first order, including old saved names. */
export function findLoggedExercises<T extends { exerciseId: string; name: string }>(
  query: string,
  logged: readonly T[],
): readonly T[] {
  if (!query.trim()) return logged;
  const match = exerciseMatcher(query);
  return logged.filter((entry) => {
    const builtIn = builtInExercise(entry.exerciseId);
    const names = builtIn ? [entry.name, builtIn.name, builtIn.catalogName] : [entry.name];
    return Boolean(match(names));
  });
}

export function builtInTargets(id: string): MuscleTargets | undefined {
  return TARGETS_BY_ID.get(id);
}
