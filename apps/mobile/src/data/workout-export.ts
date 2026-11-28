import { type ExerciseType, LIMITS, usesMetric } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { builtInExercise } from "./exercises.ts";
import { formatHevyCsv, type HevyCsvWorkout } from "./hevy-csv.ts";
import { matchExercise, normalizedName } from "./hevy-import.ts";
import { readAllWorkoutTrees, readSettings } from "./read.ts";

export interface WorkoutExport {
  csv: string;
  /** How many workouts the file holds. */
  workouts: number;
  fileName: string;
}

type Note = { workoutId: string | null; exerciseId?: string; text: string; createdAt: string };

/** Note texts by key, oldest first, so a workout's notes read in the order they were written. */
function notesBy(store: DeviceStore, kind: string, key: (note: Note) => string | null) {
  const notes = store
    .list(kind)
    .map((record) => ({ id: record.id, ...(record.content as unknown as Note) }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byKey = new Map<string, string[]>();
  for (const note of notes) {
    const found = key(note);
    if (found === null || !note.text.trim()) continue;
    byKey.set(found, [...(byKey.get(found) ?? []), note.text]);
  }
  return byKey;
}

/**
 * The name each exercise goes out under. The import knows an exercise by its name alone, so a
 * custom exercise whose name it would read as a library exercise, or as an exercise named before
 * it, gets " (custom)" added (then " (custom 2)" and so on) to stay apart.
 */
function exportNames(exercises: ReadonlyMap<string, { name: string; builtIn: boolean }>) {
  const owners = new Map<string, string>();
  const names = new Map<string, string>();
  // Library exercises keep their names; custom ones follow in a stable order.
  const ordered = [...exercises].sort(
    ([a, x], [b, y]) => Number(y.builtIn) - Number(x.builtIn) || a.localeCompare(b),
  );
  for (const [id, { name, builtIn }] of ordered) {
    const free = (candidate: string) => {
      const key = normalizedName(candidate);
      const owner = owners.get(key);
      return builtIn || ((owner === undefined || owner === id) && !matchExercise(key));
    };
    let candidate = name;
    for (let n = 1; !free(candidate); n++) {
      const suffix = n === 1 ? " (custom)" : ` (custom ${n})`;
      candidate = `${name.trim().slice(0, LIMITS.titleLength - suffix.length)}${suffix}`;
    }
    owners.set(normalizedName(candidate), id);
    names.set(id, candidate);
  }
  return names;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Every finished workout as a CSV in the layout of Hevy's export, so Leve's import and other apps
 * can read it. Only logged sets go in, as history counts them. Weights and distances use the
 * person's units. Reads the store and writes nothing.
 */
export function exportWorkouts(store: DeviceStore, now = new Date()): WorkoutExport {
  const settings = readSettings(store);
  const customNames = new Map(
    store.list("custom_exercise").map((record) => [record.id, String(record.content?.name ?? "")]),
  );
  const workoutNotes = notesBy(store, "workout_note", (note) => note.workoutId);
  // An exercise note written outside a workout belongs to the exercise, not to a session.
  const exerciseNotes = notesBy(store, "exercise_note", (note) =>
    note.workoutId === null ? null : `${note.workoutId}\n${note.exerciseId}`,
  );

  const trees = readAllWorkoutTrees(store)
    .filter((tree) => tree.workout.content.endedAt !== null)
    .sort(
      (a, b) =>
        b.workout.content.startedAt.localeCompare(a.workout.content.startedAt) ||
        a.workout.id.localeCompare(b.workout.id),
    );
  const exercises = new Map<string, { name: string; builtIn: boolean }>();
  for (const { entries } of trees) {
    for (const { entry } of entries) {
      const { exerciseId, exerciseName } = entry.content;
      if (exercises.has(exerciseId)) continue;
      // The library's or custom exercise's current name, which the import matches by.
      const builtIn = builtInExercise(exerciseId);
      exercises.set(exerciseId, {
        name: builtIn?.name ?? customNames.get(exerciseId) ?? exerciseName,
        builtIn: builtIn !== undefined,
      });
    }
  }
  const names = exportNames(exercises);

  const workouts = trees.map(({ workout, entries }): HevyCsvWorkout => {
    const noted = new Set<string>();
    return {
      title: workout.content.title,
      startedAt: workout.content.startedAt,
      endedAt: workout.content.endedAt as string,
      description: (workoutNotes.get(workout.id) ?? []).join("\n\n"),
      exercises: entries.map(({ entry: { content: entry }, sets }) => {
        // Exercise notes name the exercise, not the entry: they go with its first entry.
        const key = `${workout.id}\n${entry.exerciseId}`;
        const notes = noted.has(key) ? [] : (exerciseNotes.get(key) ?? []);
        noted.add(key);
        const type = entry.exerciseType as ExerciseType;
        // Assistance goes out as negative weight, which the import reads as assisted.
        const sign = type === "assisted_bodyweight" ? -1 : 1;
        // Floors and steps go in the reps column, as Hevy writes them for its stair machines.
        const counted = usesMetric(type, "count");
        return {
          name: names.get(entry.exerciseId) ?? entry.exerciseName,
          notes: notes.join("\n\n"),
          supersetId: entry.supersetId,
          sets: sets
            .filter((set) => set.content.completedAt !== null)
            .map(({ content: set }) => ({
              type: set.type,
              weightKg: set.weightKg === null ? null : sign * set.weightKg,
              reps: counted ? set.count : set.reps,
              distanceMeters: set.distanceMeters,
              durationSeconds: set.durationSeconds,
              rpe: set.rpe,
            })),
        };
      }),
    };
  });
  return {
    csv: formatHevyCsv(workouts, { weight: settings.weightUnit, distance: settings.distanceUnit }),
    workouts: workouts.length,
    fileName: `leve-workouts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`,
  };
}
