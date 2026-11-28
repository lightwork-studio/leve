import { HEVY_WORKOUT_ID_PREFIX, type JsonObject } from "@leve/contract";
import {
  type BuiltInExercise,
  builtInExercise,
  type ExerciseType,
  exerciseLibrary,
  type SetMetric,
  usesMetric,
} from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { type HevyExercise, HevyImportError, parseHevyCsv } from "./hevy-csv.ts";

type RecordWrite = { kind: string; id: string; content: JsonObject };
type WorkoutImport = { id: string; records: RecordWrite[] };

function normalizedName(name: string) {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Hevy names that differ from the name of the same exercise in Leve's library. */
export const HEVY_ALIASES = new Map([
  ["bench press (barbell)", "builtin:barbell-bench-press"],
  ["bench press (dumbbell)", "builtin:dumbbell-bench-press"],
  ["incline bench press (barbell)", "builtin:barbell-incline-bench-press-medium-grip"],
  ["incline bench press (dumbbell)", "builtin:incline-dumbbell-press"],
  ["squat (barbell)", "builtin:back-squat"],
  ["overhead press (barbell)", "builtin:overhead-press"],
  ["triceps pushdown (cable)", "builtin:triceps-pushdown"],
  ["bicep curl (dumbbell)", "builtin:biceps-curl"],
  ["pull up", "builtin:pull-up"],
  ["running (treadmill)", "builtin:running-treadmill"],
]);

const exercisesByName = new Map<string, BuiltInExercise | null>();
for (const exercise of exerciseLibrary) {
  for (const label of new Set([
    normalizedName(exercise.name),
    normalizedName(exercise.catalogName),
  ])) {
    exercisesByName.set(label, exercisesByName.has(label) ? null : exercise);
  }
}

function matchExercise(name: string) {
  const alias = HEVY_ALIASES.get(name);
  if (alias) return builtInExercise(alias);
  const exact = exercisesByName.get(name);
  if (exact) return exact;
  const withEquipment = /^(.+) \((.+)\)$/.exec(name);
  return withEquipment ? exercisesByName.get(`${withEquipment[2]} ${withEquipment[1]}`) : undefined;
}

const METRIC_FIELDS = [
  ["weight", "weightKg"],
  ["reps", "reps"],
  ["distance", "distanceMeters"],
  ["duration", "durationSeconds"],
] as const;

function inferType(metrics: ReadonlySet<SetMetric>, name: string, assisted: boolean): ExerciseType {
  const weight = metrics.has("weight");
  if (metrics.has("reps") || !(metrics.has("distance") || metrics.has("duration"))) {
    if (assisted) return "assisted_bodyweight";
    if (!weight) return "bodyweight_reps";
    return /\bweighted\b/.test(name) ? "weighted_bodyweight" : "weight_reps";
  }
  if (metrics.has("distance")) return weight ? "weight_distance" : "distance_duration";
  return weight ? "weight_duration" : "duration";
}

function identifyExercise(exercise: HevyExercise) {
  const key = normalizedName(exercise.name);
  const builtIn = matchExercise(key);
  const metrics = new Set<SetMetric>();
  for (const set of exercise.sets) {
    for (const [metric, field] of METRIC_FIELDS) {
      const value = set[field];
      // Some bodyweight sets put a zero in the weight column.
      if (
        value !== null &&
        !(metric === "weight" && value === 0 && builtIn?.type === "bodyweight_reps")
      )
        metrics.add(metric);
    }
  }
  const assisted = /\bassisted\b/.test(key) || exercise.sets.some((set) => (set.weightKg ?? 0) < 0);
  const fits = (type: ExerciseType) =>
    (!assisted || type === "assisted_bodyweight") &&
    [...metrics].every((metric) => usesMetric(type, metric));
  if (builtIn && fits(builtIn.type)) return { key, type: builtIn.type, builtIn };
  const type = inferType(metrics, key, assisted);
  if (!fits(type)) {
    throw new HevyImportError(
      `Hevy CSV row ${exercise.row} combines measurements Leve cannot import.`,
    );
  }
  return { key, type, builtIn: null };
}

function note(
  kind: "workout_note" | "exercise_note",
  id: string,
  content: JsonObject,
): RecordWrite {
  return { kind, id, content: { ...content, pinned: false, agent: null } };
}

/** Parse and prepare records before opening the device write transaction. */
export async function prepareHevyImport(csv: string): Promise<WorkoutImport[]> {
  const workouts = parseHevyCsv(csv);
  const customIds = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const result: WorkoutImport[] = [];
  for (const workout of workouts) {
    const occurrence = (occurrences.get(workout.minute) ?? 0) + 1;
    occurrences.set(workout.minute, occurrence);
    const id = `${HEVY_WORKOUT_ID_PREFIX}${workout.minute}:${occurrence}`;
    const records: RecordWrite[] = [
      {
        kind: "workout",
        id,
        content: {
          title: workout.title,
          startedAt: workout.startedAt,
          endedAt: workout.endedAt,
          routineId: null,
        },
      },
    ];
    if (workout.description.trim()) {
      records.push(
        note("workout_note", `${id}:note`, {
          workoutId: id,
          text: workout.description,
          createdAt: workout.endedAt,
        }),
      );
    }
    for (const [entryIndex, exercise] of workout.exercises.entries()) {
      const { key, type, builtIn } = identifyExercise(exercise);
      const entryId = `${id}:e:${entryIndex + 1}`;
      let exerciseId = builtIn?.id ?? customIds.get(key);
      if (!exerciseId) {
        const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, key);
        exerciseId = `hevy:exercise:${digest.slice(0, 48)}`;
        customIds.set(key, exerciseId);
      }
      if (!builtIn) {
        records.push({
          kind: "custom_exercise",
          id: exerciseId,
          content: {
            name: exercise.name,
            type,
            primaryMuscle: "other",
            secondaryMuscles: [],
            equipment: "other",
            usesBodyweight: type === "weighted_bodyweight" || type === "assisted_bodyweight",
            archived: false,
          },
        });
      }
      records.push({
        kind: "workout_exercise",
        id: entryId,
        content: {
          workoutId: id,
          exerciseId,
          exerciseName: exercise.name,
          exerciseType: type,
          position: entryIndex + 1,
          supersetId: exercise.supersetId,
          restSeconds: 0,
          doubleDumbbellVolume: false,
        },
      });
      if (exercise.notes.trim()) {
        records.push(
          note("exercise_note", `${entryId}:note`, {
            exerciseId,
            workoutId: id,
            text: exercise.notes,
            createdAt: workout.endedAt,
          }),
        );
      }
      for (const [setIndex, set] of exercise.sets.entries()) {
        records.push({
          kind: "workout_set",
          id: `${entryId}:s:${setIndex + 1}`,
          content: {
            ...set,
            workoutExerciseId: entryId,
            position: setIndex + 1,
            weightKg:
              set.weightKg === null || !usesMetric(type, "weight") ? null : Math.abs(set.weightKg),
            count: null,
            completedAt: workout.endedAt,
          },
        });
      }
    }
    result.push({ id, records });
  }
  return result;
}

/** An existing or deleted workout owns its whole tree. Add the rest in one local transaction. */
export function importHevyWorkouts(store: DeviceStore, workouts: readonly WorkoutImport[]) {
  const writes: RecordWrite[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const workout of workouts) {
    if (store.editVersion("workout", workout.id) !== null) continue;
    for (const record of workout.records) {
      const key = `${record.kind}/${record.id}`;
      if (seen.has(key) || store.editVersion(record.kind, record.id) !== null) continue;
      seen.add(key);
      writes.push(record);
    }
    added++;
  }
  if (writes.length) store.putMany(writes);
  return { added, skipped: workouts.length - added };
}

const workoutCount = (count: number) => `${count} workout${count === 1 ? "" : "s"}`;

/** What an import did, in a sentence or two. */
export function hevyImportSummary({ added, skipped }: { added: number; skipped: number }) {
  if (added === 0) {
    return skipped === 1
      ? "The workout in this file is already in Leve."
      : `All ${skipped} workouts in this file are already in Leve.`;
  }
  const already =
    skipped === 0
      ? ""
      : ` ${workoutCount(skipped)} ${skipped === 1 ? "was" : "were"} already there.`;
  return `Added ${workoutCount(added)}.${already}`;
}
