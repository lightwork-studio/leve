import {
  EFFORT_SCALES,
  EQUIPMENT,
  EXERCISE_TYPES,
  LIMITS,
  MUSCLE_GROUPS,
  RPE_VALUES,
  SET_TYPES,
} from "@leve/core";
import {
  type ContentFor,
  type ContractDefinition,
  compareReleases,
  createContract,
  type ReleaseId,
} from "./definition.ts";
import {
  array,
  boolean,
  dateTime,
  enumOf,
  id,
  integer,
  nullable,
  number,
  object,
  string,
} from "./schema.ts";

/*
 * Leve's logical records. Field names carry their unit. Every field lists the protocol release that
 * introduced it. During development, additions go into the draft 1.0 contract. Once a release
 * ships, its schema and meanings are fixed, and optional additions take a new minor release.
 */

const MAX_KG = 2000;
const MAX_METRES = 10_000_000;
const MAX_SECONDS = 1_000_000;
const MAX_COUNT = 1_000_000;
const MAX_REPS = 10_000;
const MAX_REST_SECONDS = 3600;
export const MAX_POSITION = 1e15;

const v = "1.0" as const;
const req = <T>(schema: import("./schema.ts").Schema<T>) => ({
  schema,
  since: v,
  required: true as const,
});
const opt = <T>(schema: import("./schema.ts").Schema<T>) => ({
  schema: nullable(schema),
  since: v,
});

const note = object({
  id: id(),
  text: string({ maxLength: LIMITS.noteLength }),
  createdAt: dateTime(),
});
const notes = array(note, 100);
const position = number({ minimum: -MAX_POSITION, maximum: MAX_POSITION });
const weightKg = number({ minimum: 0, maximum: MAX_KG });
const reps = integer(0, MAX_REPS);
const distanceMeters = number({ minimum: 0, maximum: MAX_METRES });
const durationSeconds = number({ minimum: 0, maximum: MAX_SECONDS });
const count = integer(0, MAX_COUNT);
const rpe = enumOf(RPE_VALUES);
const effortScale = enumOf(EFFORT_SCALES);
const repsInReserve = integer(0, MAX_REPS);
const supersetId = integer(0, 1000);
const restSeconds = integer(0, MAX_REST_SECONDS);
const exerciseRef = {
  /** Built-in or custom exercise id. */
  exerciseId: req(string({ minLength: 1, maxLength: 100 })),
  /** Name and type at the time of logging, so the entry shows even if the exercise is gone. */
  exerciseName: req(string({ minLength: 1, maxLength: LIMITS.titleLength })),
  exerciseType: req(enumOf(EXERCISE_TYPES)),
};

const targetFields = {
  type: enumOf(SET_TYPES),
  weightKg: nullable(weightKg),
  reps: nullable(reps),
  repRangeMin: nullable(reps),
  repRangeMax: nullable(reps),
  distanceMeters: nullable(distanceMeters),
  durationSeconds: nullable(durationSeconds),
  count: nullable(count),
  rpe: nullable(rpe),
  repsInReserve: nullable(repsInReserve),
};

const routineSet = object({ id: id(), ...targetFields }, ["repsInReserve"]);

const routineExercise = object({
  id: id(),
  exerciseId: string({ minLength: 1, maxLength: 100 }),
  exerciseName: string({ minLength: 1, maxLength: LIMITS.titleLength }),
  exerciseType: enumOf(EXERCISE_TYPES),
  supersetId: nullable(supersetId),
  restSeconds,
  notes,
  useRepRange: boolean(),
  sets: array(routineSet, LIMITS.routineMaxSets),
});

export const LEVE_CONTRACT_DEFINITION = {
  releases: [v],
  kinds: {
    workout: {
      since: v,
      meanings: {
        initialPlan:
          "Routine title, effort scale, and ordered exercise and set targets captured at start; null when unknown or unplanned",
        title: "Workout name shown in history",
        description: "Free-text notes about the whole workout",
        startedAt: "When the workout started (UTC)",
        endedAt: "startedAt plus the active duration; null while the workout is in progress",
        routineId: "The routine the workout was started from, if any; a soft reference",
      },
      fields: {
        initialPlan: {
          since: v,
          schema: nullable(
            object(
              {
                title: string({ maxLength: LIMITS.titleLength }),
                effortScale,
                exercises: array(
                  object({
                    exerciseId: exerciseRef.exerciseId.schema,
                    exerciseName: exerciseRef.exerciseName.schema,
                    exerciseType: exerciseRef.exerciseType.schema,
                    restSeconds,
                    supersetId: nullable(supersetId),
                    useRepRange: boolean(),
                    sets: array(object(targetFields, ["repsInReserve"]), LIMITS.routineMaxSets),
                  }),
                  LIMITS.routineMaxExercises,
                ),
              },
              ["effortScale"],
            ),
          ),
        },
        title: req(string({ maxLength: LIMITS.titleLength })),
        description: req(string({ maxLength: LIMITS.descriptionLength })),
        startedAt: req(dateTime()),
        /** Null while the workout is in progress. */
        endedAt: opt(dateTime()),
        routineId: opt(id()),
      },
    },
    workout_rest: {
      since: v,
      parent: { kind: "workout", field: "workoutId", sharedId: true },
      meanings: {
        workoutId:
          "The workout to which this rest preference belongs; its record ID equals the workout ID",
        seconds:
          "Default rest in seconds for exercises added to this workout. Zero turns the timer off. Null uses account settings. Clear the preference by setting seconds to null; it is deleted with its workout.",
      },
      fields: {
        workoutId: { since: v, required: true, schema: id() },
        seconds: { since: v, schema: nullable(restSeconds) },
      },
    },
    workout_note: {
      since: v,
      parent: { kind: "workout", field: "workoutId" },
      meanings: {
        workoutId: "The workout in which this note was written",
        kind: "Session notes belong to one workout; sticky notes also appear in later workouts",
        text: "The lifter’s note",
        createdAt: "Time the note was written in UTC",
        reply:
          "Optional coach reply and time it was supplied, shown in the first eligible later workout",
      },
      fields: {
        workoutId: { since: v, required: true, schema: id() },
        kind: { since: v, required: true, schema: enumOf(["session", "sticky"] as const) },
        text: {
          since: v,
          required: true,
          schema: string({ minLength: 1, maxLength: LIMITS.noteLength }),
        },
        createdAt: { since: v, required: true, schema: dateTime() },
        reply: {
          since: v,
          schema: nullable(
            object({
              text: string({ minLength: 1, maxLength: LIMITS.noteLength }),
              createdAt: dateTime(),
            }),
          ),
        },
      },
    },
    workout_exercise: {
      since: v,
      meanings: {
        workoutId: "The workout this entry belongs to (parent)",
        exerciseId: "Built-in or custom exercise id; a soft reference",
        exerciseName: "The exercise's name when logged, shown if the exercise no longer exists",
        exerciseType: "How sets of this exercise are measured; decides which set values are used",
        position: "Order within the workout; lower first, ties ordered by id",
        supersetId: "Entries of one workout sharing this number form a superset; null if none",
        restSeconds: "Rest timer after a set in seconds; 0 means off",
        notes: "Notes on this entry, each with its own id and creation time",
        doubleDumbbellVolume: "Count the set weight twice in volume (one dumbbell per hand)",
      },
      parent: { kind: "workout", field: "workoutId" },
      fields: {
        workoutId: req(id()),
        ...exerciseRef,
        position: req(position),
        supersetId: opt(supersetId),
        restSeconds: req(restSeconds),
        notes: req(notes),
        /** Count dumbbell weight twice in volume. */
        doubleDumbbellVolume: req(boolean()),
      },
    },
    workout_set: {
      since: v,
      meanings: {
        repsInReserve:
          "Estimated additional repetitions possible when the set ended; zero means no repetitions remained, null means unrecorded",
        planSlot:
          "Zero-based exercise and set indices in the workout initial plan, independent of row order; null if unplanned or unknown",
        workoutExerciseId: "The exercise entry this set belongs to (parent)",
        position: "Order within the entry; lower first, ties ordered by id",
        type: "normal, warmup, failure or drop set",
        weightKg:
          "Weight in kilograms; for weighted bodyweight the added load, for assisted bodyweight the assistance; null when the exercise type has no weight",
        reps: "Repetitions; null when the exercise type doesn't count them",
        distanceMeters: "Distance in metres; null when unused",
        durationSeconds: "Duration in seconds; null when unused",
        count: "Floors or steps for those exercise types; null when unused",
        rpe: "Rate of perceived exertion; null if not given",
        completedAt: "When the set was ticked off (UTC); null if not completed",
      },
      parent: { kind: "workout_exercise", field: "workoutExerciseId" },
      fields: {
        repsInReserve: opt(repsInReserve),
        planSlot: {
          since: v,
          schema: nullable(
            object({
              exercise: integer(0, LIMITS.routineMaxExercises - 1),
              set: integer(0, LIMITS.routineMaxSets - 1),
            }),
          ),
        },
        workoutExerciseId: req(id()),
        position: req(position),
        type: req(enumOf(SET_TYPES)),
        /** Added load for weighted bodyweight; assistance for assisted exercises. */
        weightKg: opt(weightKg),
        reps: opt(reps),
        distanceMeters: opt(distanceMeters),
        durationSeconds: opt(durationSeconds),
        /** Floors or steps. */
        count: opt(count),
        rpe: opt(rpe),
        /** When the set was ticked off; null if not completed. */
        completedAt: opt(dateTime()),
      },
    },
    routine: {
      since: v,
      meanings: {
        title: "Routine name",
        notes: "Free-text notes on the routine",
        folderId: "The folder holding the routine; null when unfiled or the folder is gone",
        position: "Order within its folder; lower first, ties ordered by id",
        effortScale:
          "Effort scale for this routine's targets and workouts started from it; absent or null for older routines",
        exercises:
          "The routine's exercises in order, each with target sets (weights in kilograms, distances in metres, durations in seconds, rep ranges as min/max, and optional RPE or reps in reserve)",
      },
      fields: {
        title: req(string({ maxLength: LIMITS.titleLength })),
        notes: req(string({ maxLength: LIMITS.descriptionLength })),
        folderId: opt(id()),
        position: req(position),
        effortScale: opt(effortScale),
        exercises: req(array(routineExercise, LIMITS.routineMaxExercises)),
      },
    },
    routine_folder: {
      since: v,
      meanings: {
        title: "Folder name",
        position: "Order among folders; lower first, ties ordered by id",
      },
      fields: {
        title: req(string({ maxLength: LIMITS.folderTitleLength })),
        position: req(position),
      },
    },
    custom_exercise: {
      since: v,
      meanings: {
        name: "Exercise name",
        type: "How sets are measured; fixed once created",
        primaryMuscle: "Main muscle group trained",
        secondaryMuscles: "Other muscle groups trained",
        equipment: "Equipment used",
        usesBodyweight: "Volume includes the lifter's bodyweight",
        archived:
          "Hidden from pickers; stays valid in history (custom exercises are archived, never deleted)",
      },
      fields: {
        name: req(string({ minLength: 1, maxLength: LIMITS.titleLength })),
        type: req(enumOf(EXERCISE_TYPES)),
        primaryMuscle: req(enumOf(MUSCLE_GROUPS)),
        secondaryMuscles: req(array(enumOf(MUSCLE_GROUPS), MUSCLE_GROUPS.length)),
        equipment: req(enumOf(EQUIPMENT)),
        usesBodyweight: req(boolean()),
        archived: req(boolean()),
      },
    },
    body_measurement: {
      since: v,
      meanings: {
        takenAt: "When the measurement was taken (UTC)",
        bodyweightKg: "Bodyweight in kilograms; null if not measured",
        fatPercent: "Body fat in percent; null if not measured",
      },
      fields: {
        takenAt: req(dateTime()),
        bodyweightKg: opt(weightKg),
        fatPercent: opt(number({ minimum: 0, maximum: 100 })),
      },
    },
    settings: {
      since: v,
      meanings: {
        weightUnit: "Unit for showing and entering weight; stored values stay in kilograms",
        distanceUnit: "Unit for long distances; stored values stay in metres",
        shortDistanceUnit: "Unit for short distances; stored values stay in metres",
        measurementUnit: "Unit for body measurements",
        firstWeekday: "First day of the week, 0 = Sunday",
        defaultRestSeconds: "Rest timer for new exercise entries; 0 means off",
        rpeEnabled: "Legacy RPE preference retained for compatibility",
        countWarmups: "Whether warm-up sets count toward volume, set counts and records",
        previousValues:
          "Where 'previous' values come from while logging: any workout or the same routine",
        autoUpdateRoutineValues:
          "After a routine-based workout, copy the logged values back into the routine",
        trackRepsInReserve:
          "Whether the app prompts for effort in the workout's scale after logging a set; null means off",
      },
      singletonId: "settings",
      fields: {
        weightUnit: req(enumOf(["kg", "lbs"])),
        distanceUnit: req(enumOf(["km", "miles"])),
        shortDistanceUnit: req(enumOf(["m", "yd"])),
        measurementUnit: req(enumOf(["cm", "in"])),
        firstWeekday: req(integer(0, 6)),
        defaultRestSeconds: req(restSeconds),
        rpeEnabled: req(boolean()),
        countWarmups: req(boolean()),
        previousValues: req(enumOf(["any_workout", "same_routine"])),
        autoUpdateRoutineValues: req(boolean()),
        trackRepsInReserve: opt(boolean()),
      },
    },
  },
  features: {
    workouts: {
      since: v,
      description: "Log workouts, including ones in progress",
      fields: [["workout", "title"]],
    },
    routines: {
      since: v,
      description: "Routines and folders",
      fields: [["routine", "title"]],
    },
    custom_exercises: {
      since: v,
      description: "Exercises the user creates",
      fields: [["custom_exercise", "name"]],
    },
    body_measurements: {
      since: v,
      description: "Bodyweight and body fat",
      fields: [["body_measurement", "bodyweightKg"]],
    },
    workout_rest: {
      since: v,
      description: "Set a rest timer default for one workout",
      fields: [["workout_rest", "seconds"]],
    },
    workout_journal: {
      since: v,
      description: "Workout notes, pinned reminders and linked coach replies",
      fields: [["workout_note", "text"]],
    },
    reps_in_reserve: {
      since: v,
      description: "Record reps in reserve on a set",
      fields: [["workout_set", "repsInReserve"]],
    },
    track_reps_in_reserve: {
      since: v,
      description: "Choose whether the app prompts for effort in the workout's scale",
      fields: [["settings", "trackRepsInReserve"]],
    },
    rpe: {
      since: v,
      description: "Rate of perceived exertion on sets",
      fields: [["workout_set", "rpe"]],
    },
  },
} as const satisfies ContractDefinition;

export type LeveContractDefinition = typeof LEVE_CONTRACT_DEFINITION;
export type RecordKind = keyof LeveContractDefinition["kinds"];
export type RecordContent<K extends RecordKind> = ContentFor<LeveContractDefinition, K>;

/** The contract this build implements. */
export const leveContract = createContract(LEVE_CONTRACT_DEFINITION);

/** The record kinds, fields and features available to an app built through this release. */
export function contractThrough(
  release: ReleaseId,
  definition: ContractDefinition = LEVE_CONTRACT_DEFINITION,
) {
  const known = (since: ReleaseId) => compareReleases(since, release) <= 0;
  return createContract({
    releases: definition.releases.filter(known),
    features: Object.fromEntries(
      Object.entries(definition.features).filter(([, feature]) => known(feature.since)),
    ),
    kinds: Object.fromEntries(
      Object.entries(definition.kinds)
        .filter(([, kind]) => known(kind.since))
        .map(([name, kind]) => [
          name,
          {
            ...kind,
            fields: Object.fromEntries(
              Object.entries(kind.fields).filter(([, field]) => known(field.since)),
            ),
          },
        ]),
    ),
  });
}
