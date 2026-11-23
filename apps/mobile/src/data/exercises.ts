import { type ExerciseType, MUSCLE_GROUPS, type MuscleGroup } from "@leve/core";
import { exerciseMatcher } from "../model/exercise-search.ts";
import type { MuscleTargets } from "../model/muscle-map.ts";
import catalog from "./exercise-catalog.json";

export interface BuiltInExercise {
  id: string;
  name: string;
  type: ExerciseType;
  /** Volume includes the lifter's bodyweight (pull-ups, dips and their variants). */
  usesBodyweight?: boolean;
}

export const EXERCISES = {
  bench: { id: "builtin:barbell-bench-press", name: "Bench Press", type: "weight_reps" },
  ohp: { id: "builtin:overhead-press", name: "Overhead Press", type: "weight_reps" },
  incline: {
    id: "builtin:incline-dumbbell-press",
    name: "Incline Dumbbell Press",
    type: "weight_reps",
  },
  lateral: { id: "builtin:lateral-raise", name: "Lateral Raise", type: "weight_reps" },
  pushdown: { id: "builtin:triceps-pushdown", name: "Triceps Pushdown", type: "weight_reps" },
  deadlift: { id: "builtin:deadlift", name: "Deadlift", type: "weight_reps" },
  pullup: { id: "builtin:pull-up", name: "Pull-up", type: "bodyweight_reps", usesBodyweight: true },
  row: { id: "builtin:barbell-row", name: "Barbell Row", type: "weight_reps" },
  facepull: { id: "builtin:face-pull", name: "Face Pull", type: "weight_reps" },
  curl: { id: "builtin:biceps-curl", name: "Biceps Curl", type: "weight_reps" },
  squat: { id: "builtin:back-squat", name: "Squat", type: "weight_reps" },
  rdl: { id: "builtin:romanian-deadlift", name: "Romanian Deadlift", type: "weight_reps" },
  legpress: { id: "builtin:leg-press", name: "Leg Press", type: "weight_reps" },
  legcurl: { id: "builtin:leg-curl", name: "Leg Curl", type: "weight_reps" },
  calf: { id: "builtin:calf-raise", name: "Calf Raise", type: "weight_reps" },
  plank: { id: "builtin:plank", name: "Plank", type: "duration" },
  stretch: { id: "builtin:hip-flexor-stretch", name: "Hip Flexor Stretch", type: "duration" },
} as const satisfies Record<string, BuiltInExercise>;

// Equipment and muscles from free-exercise-db, under the Unlicense:
// https://github.com/yuhonas/free-exercise-db/tree/f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5
const seeded = new Map<string, BuiltInExercise>(Object.values(EXERCISES).map((e) => [e.id, e]));
export const exerciseLibrary = catalog.map((item) => ({
  ...item,
  catalogName: item.name,
  primaryMuscles: item.muscles.map(catalogueMuscle),
  secondaryMuscles: item.secondaryMuscles.map(catalogueMuscle),
  type: (item.type ?? "weight_reps") as ExerciseType,
  ...seeded.get(item.id),
}));
const BY_ID = new Map(exerciseLibrary.map((exercise) => [exercise.id, exercise]));

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
    const builtIn = BY_ID.get(entry.exerciseId);
    const names = builtIn ? [entry.name, builtIn.name, builtIn.catalogName] : [entry.name];
    return Boolean(match(names));
  });
}

export const builtInExercise = (id: string) => BY_ID.get(id);

// The upstream catalogue calls the upper back "Middle back".
function catalogueMuscle(label: string): MuscleGroup {
  const key = label.toLowerCase().replaceAll(" ", "_");
  return (
    MUSCLE_GROUPS.find((group) => group === (key === "middle_back" ? "upper_back" : key)) ?? "other"
  );
}

export function builtInTargets(id: string): MuscleTargets | undefined {
  const exercise = builtInExercise(id);
  return exercise
    ? {
        primaryMuscles: exercise.primaryMuscles,
        secondaryMuscles: exercise.secondaryMuscles,
      }
    : undefined;
}
