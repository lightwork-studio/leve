import {
  type EffortScale,
  type ExerciseType,
  isRepBased,
  LIMITS,
  RPE_VALUES,
  usesMetric,
} from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { routineEffortScale } from "../model/effort.ts";
import { newId } from "./ids.ts";
import { readWorkoutTree } from "./read.ts";
import { openPlan, type PlannedExercise, type StoredPlan } from "./routine-actions.ts";

export function routineFromWorkout(
  store: DeviceStore,
  workoutId: string,
): { name: string; plan: PlannedExercise[]; effortScale: EffortScale } | { error: string } {
  const tree = readWorkoutTree(store, workoutId);
  if (!tree?.workout.content.endedAt) return { error: "Choose a completed workout from History." };
  const entryIds = new Set(tree.entries.map(({ entry }) => entry.id));
  const unresolved = store
    .problems()
    .some(
      (row) =>
        (row.kind === "workout" && row.id === workoutId) ||
        (row.kind === "workout_exercise" &&
          [row.content, row.server?.content, row.keptContent].some(
            (copy) => copy?.workoutId === workoutId,
          )) ||
        (row.kind === "workout_set" &&
          [row.content, row.server?.content, row.keptContent].some(
            (copy) =>
              typeof copy?.workoutExerciseId === "string" && entryIds.has(copy.workoutExerciseId),
          )),
    );
  if (unresolved) return { error: "Resolve this workout’s sync issues before copying its sets." };

  const exercises: StoredPlan = [];
  for (const {
    entry: { content: entry },
    sets,
  } of tree.entries) {
    const logged = sets.filter(({ content }) => content.completedAt !== null);
    if (!logged.length) continue;
    if (exercises.length === LIMITS.routineMaxExercises || logged.length > LIMITS.routineMaxSets)
      return {
        error: `A routine can hold up to ${LIMITS.routineMaxExercises} exercises and ${LIMITS.routineMaxSets} sets per exercise.`,
      };
    const exerciseType = entry.exerciseType as ExerciseType;
    const repBased = isRepBased(exerciseType);
    exercises.push({
      id: newId(),
      exerciseId: entry.exerciseId,
      exerciseName: entry.exerciseName,
      exerciseType,
      restSeconds: entry.restSeconds,
      supersetId: entry.supersetId,
      notes: [],
      useRepRange: false,
      sets: logged.map(({ content: set }) => ({
        id: newId(),
        type: set.type,
        weightKg: usesMetric(exerciseType, "weight") ? set.weightKg : null,
        reps: repBased ? set.reps : null,
        durationSeconds: usesMetric(exerciseType, "duration") ? set.durationSeconds : null,
        distanceMeters: usesMetric(exerciseType, "distance") ? set.distanceMeters : null,
        count: usesMetric(exerciseType, "count") ? set.count : null,
        rpe: repBased ? (RPE_VALUES.find((value) => value === set.rpe) ?? null) : null,
        ...(repBased && set.repsInReserve != null && { repsInReserve: set.repsInReserve }),
        repRangeMin: null,
        repRangeMax: null,
      })),
    });
  }
  if (!exercises.length) return { error: "This workout has no logged sets to use in a routine." };
  return {
    name: tree.workout.content.title,
    plan: openPlan(exercises),
    effortScale: routineEffortScale({
      effortScale: tree.workout.content.initialPlan?.effortScale,
      exercises,
    }),
  };
}
