import {
  HEVY_EXERCISE_ID_PREFIX,
  HEVY_WORKOUT_ID_PREFIX,
  type JsonObject,
  leveContract,
} from "@leve/contract";
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

/**
 * How every entry of one exercise is stored: as the built-in exercise when all its sets fit it,
 * else as one custom exercise whose type fits the sets of every entry in the file.
 */
function identifyExercise(key: string, entries: readonly HevyExercise[]) {
  const builtIn = matchExercise(key);
  const sets = entries.flatMap((entry) => entry.sets);
  const metrics = new Set<SetMetric>();
  for (const set of sets) {
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
  const assisted = /\bassisted\b/.test(key) || sets.some((set) => (set.weightKg ?? 0) < 0);
  const fits = (type: ExerciseType) =>
    (!assisted || type === "assisted_bodyweight") &&
    [...metrics].every((metric) => usesMetric(type, metric));
  const name = entries[0]?.name ?? key;
  if (builtIn && fits(builtIn.type)) return { name, type: builtIn.type, builtIn };
  const type = inferType(metrics, key, assisted);
  if (!fits(type)) {
    throw new HevyImportError(
      `Hevy CSV row ${entries[0]?.row} combines measurements Leve cannot import.`,
    );
  }
  return { name, type, builtIn: null };
}

function note(
  kind: "workout_note" | "exercise_note",
  id: string,
  content: JsonObject,
): RecordWrite {
  return { kind, id, content: { ...content, pinned: false, agent: null } };
}

/** Stops at the first value Leve can't store, naming the CSV row it came from. */
function checkRecord(record: RecordWrite, row: number) {
  const content = leveContract.normalize(record.kind, record.content);
  const [issue] = leveContract.validateContent(record.kind, content, record.id);
  if (issue) {
    const field = issue.path.replace(/^\$\.?/, "") || record.kind;
    throw new HevyImportError(`Hevy CSV row ${row} has a value Leve can't store (${field}).`);
  }
}

type IdentifiedExercise = ReturnType<typeof identifyExercise> & {
  id: string;
  /** The custom exercise to create; null for a built-in one. */
  record: RecordWrite | null;
};

/** Parse and prepare records before opening the device write transaction. */
export async function prepareHevyImport(csv: string): Promise<WorkoutImport[]> {
  const workouts = parseHevyCsv(csv);
  const entriesByName = new Map<string, HevyExercise[]>();
  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      const key = normalizedName(exercise.name);
      const entries = entriesByName.get(key);
      if (entries) entries.push(exercise);
      else entriesByName.set(key, [exercise]);
    }
  }
  const exercises = new Map<string, IdentifiedExercise>();
  for (const [key, entries] of entriesByName) {
    const identified = identifyExercise(key, entries);
    if (identified.builtIn) {
      exercises.set(key, { ...identified, id: identified.builtIn.id, record: null });
      continue;
    }
    const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, key);
    const id = `${HEVY_EXERCISE_ID_PREFIX}${digest.slice(0, 48)}`;
    const record = {
      kind: "custom_exercise",
      id,
      content: {
        name: identified.name,
        type: identified.type,
        primaryMuscle: "other",
        secondaryMuscles: [],
        equipment: "other",
        usesBodyweight:
          identified.type === "weighted_bodyweight" || identified.type === "assisted_bodyweight",
        archived: false,
      },
    };
    checkRecord(record, entries[0]?.row ?? 0);
    exercises.set(key, { ...identified, id, record });
  }

  const occurrences = new Map<string, number>();
  const result: WorkoutImport[] = [];
  for (const workout of workouts) {
    const occurrence = (occurrences.get(workout.minute) ?? 0) + 1;
    occurrences.set(workout.minute, occurrence);
    const id = `${HEVY_WORKOUT_ID_PREFIX}${workout.minute}:${occurrence}`;
    const records: RecordWrite[] = [];
    const add = (record: RecordWrite, row: number) => {
      checkRecord(record, row);
      records.push(record);
    };
    add(
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
      workout.row,
    );
    if (workout.description.trim()) {
      add(
        note("workout_note", `${id}:note`, {
          workoutId: id,
          text: workout.description,
          createdAt: workout.endedAt,
        }),
        workout.row,
      );
    }
    for (const [entryIndex, exercise] of workout.exercises.entries()) {
      const identified = exercises.get(normalizedName(exercise.name));
      if (!identified) throw new HevyImportError(`Hevy CSV row ${exercise.row} has no exercise.`);
      const { type } = identified;
      const entryId = `${id}:e:${entryIndex + 1}`;
      // Written with the first workout that uses it, unless that one is skipped.
      if (identified.record) records.push(identified.record);
      add(
        {
          kind: "workout_exercise",
          id: entryId,
          content: {
            workoutId: id,
            exerciseId: identified.id,
            exerciseName: exercise.name,
            exerciseType: type,
            position: entryIndex + 1,
            supersetId: exercise.supersetId,
            restSeconds: 0,
            doubleDumbbellVolume: false,
          },
        },
        exercise.row,
      );
      if (exercise.notes.trim()) {
        add(
          note("exercise_note", `${entryId}:note`, {
            exerciseId: identified.id,
            workoutId: id,
            text: exercise.notes,
            createdAt: workout.endedAt,
          }),
          exercise.row,
        );
      }
      for (const [setIndex, set] of exercise.sets.entries()) {
        add(
          {
            kind: "workout_set",
            id: `${entryId}:s:${setIndex + 1}`,
            content: {
              ...set,
              workoutExerciseId: entryId,
              position: setIndex + 1,
              weightKg:
                set.weightKg === null || !usesMetric(type, "weight")
                  ? null
                  : Math.abs(set.weightKg),
              count: null,
              completedAt: workout.endedAt,
            },
          },
          exercise.setRows[setIndex] ?? exercise.row,
        );
      }
    }
    result.push({ id, records });
  }
  return result;
}

export interface HevyImportResult {
  added: number;
  /** Workouts already in Leve, left as they are. */
  existing: number;
  /** Workouts deleted in Leve, which an import never brings back. */
  deleted: number;
}

/** An existing or deleted workout owns its whole tree. Add the rest in one local transaction. */
export function importHevyWorkouts(
  store: DeviceStore,
  workouts: readonly WorkoutImport[],
): HevyImportResult {
  const writes: RecordWrite[] = [];
  const seen = new Set<string>();
  const result = { added: 0, existing: 0, deleted: 0 };
  for (const workout of workouts) {
    const current = store.get("workout", workout.id);
    if (current) {
      if (current.deleted) result.deleted++;
      else result.existing++;
      continue;
    }
    for (const record of workout.records) {
      const key = `${record.kind}/${record.id}`;
      if (seen.has(key) || store.editVersion(record.kind, record.id) !== null) continue;
      seen.add(key);
      writes.push(record);
    }
    result.added++;
  }
  if (writes.length) store.putMany(writes);
  return result;
}

const workoutCount = (count: number) => `${count} workout${count === 1 ? "" : "s"}`;
const were = (count: number) => (count === 1 ? "was" : "were");

/** What an import did, in a sentence or two. */
export function hevyImportSummary({ added, existing, deleted }: HevyImportResult) {
  const sentences = [
    added === 0 ? "No new workouts in this file." : `Added ${workoutCount(added)}.`,
  ];
  if (existing) sentences.push(`${workoutCount(existing)} ${were(existing)} already in Leve.`);
  if (deleted) {
    const stay = deleted === 1 ? "it stays" : "they stay";
    sentences.push(
      `${workoutCount(deleted)} ${were(deleted)} deleted in Leve, so ${stay} deleted.`,
    );
  }
  return sentences.join(" ");
}
