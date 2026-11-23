import { type Exercise, LIMITS } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { exerciseLibrary } from "./exercises.ts";
import { newId } from "./ids.ts";

type StoredExercise = Omit<Exercise, "custom" | "id">;
export type CustomExerciseDraft = Omit<StoredExercise, "archived">;

export function choiceLabel(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1).replaceAll("_", " ");
}

export function createCustomExercise(store: DeviceStore, draft: CustomExerciseDraft) {
  const name = draft.name.trim();
  if (!name || name.length > LIMITS.titleLength) {
    throw new Error(`Enter an exercise name between 1 and ${LIMITS.titleLength} characters.`);
  }
  const id = newId();
  if (store.get("custom_exercise", id)) throw new Error("Please try creating the exercise again.");
  store.put("custom_exercise", id, { ...draft, name, archived: false });
  return { id, name, type: draft.type, usesBodyweight: draft.usesBodyweight };
}

export function pickerLibrary(store: DeviceStore) {
  const custom = store.list("custom_exercise").flatMap((record) => {
    const exercise = record.content as unknown as StoredExercise;
    if (exercise.archived) return [];
    return [
      {
        id: record.id,
        name: exercise.name,
        type: exercise.type,
        usesBodyweight: exercise.usesBodyweight,
        equipment: exercise.equipment === "none" ? "Bodyweight" : choiceLabel(exercise.equipment),
        primaryMuscles: [exercise.primaryMuscle],
        secondaryMuscles: exercise.secondaryMuscles,
        muscles: [exercise.primaryMuscle, ...exercise.secondaryMuscles].map(choiceLabel),
      },
    ];
  });
  return [...custom, ...exerciseLibrary];
}
