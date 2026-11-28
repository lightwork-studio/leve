import type { DeviceStore } from "@leve/storage";
import { builtInExercise } from "./exercises.ts";
import { formatHevyCsv, type HevyCsvWorkout } from "./hevy-csv.ts";
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
        // Assistance goes out as negative weight, which the import reads as assisted.
        const sign = entry.exerciseType === "assisted_bodyweight" ? -1 : 1;
        return {
          // The library's or custom exercise's current name, which the import matches by.
          name:
            builtInExercise(entry.exerciseId)?.name ??
            customNames.get(entry.exerciseId) ??
            entry.exerciseName,
          notes: notes.join("\n\n"),
          supersetId: entry.supersetId,
          sets: sets
            .filter((set) => set.content.completedAt !== null)
            .map(({ content: set }) => ({
              type: set.type,
              weightKg: set.weightKg === null ? null : sign * set.weightKg,
              reps: set.reps,
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
