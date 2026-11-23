/** Every entity has a client-generated UUID and sync timestamps (ISO 8601, UTC). */
export interface Synced {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the entity is deleted; kept as a tombstone for sync. */
  deletedAt: string | null;
}

export const SET_TYPES = ["normal", "warmup", "failure", "drop"] as const;
export type SetType = (typeof SET_TYPES)[number];

/** RPE values a user can pick. */
export const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;

/** Rest-timer presets in seconds. Individual exercises also support custom intervals. Zero means off. */
export const REST_TIMER_VALUES: readonly number[] = [
  0,
  ...Array.from({ length: 24 }, (_, i) => 5 + i * 5),
  ...Array.from({ length: 12 }, (_, i) => 135 + i * 15),
];

export const LIMITS = {
  titleLength: 100,
  descriptionLength: 2000,
  noteLength: 10_000,
  folderTitleLength: 30,
  routineMaxExercises: 50,
  routineMaxSets: 150,
} as const;

/** A note attached to an exercise. */
export interface ExerciseNote {
  id: string;
  text: string;
  createdAt: string;
}

/**
 * One logged set. All metrics are stored in base units: weight in kg, distance in metres,
 * duration in seconds. A metric the exercise type doesn't use is null, never 0.
 */
export interface WorkoutSet {
  id: string;
  type: SetType;
  /** kg. Added load for weighted bodyweight; assistance (positive) for assisted. */
  weight: number | null;
  reps: number | null;
  /** metres */
  distance: number | null;
  /** seconds */
  duration: number | null;
  /** Floors or steps, for the floors/steps exercise types. */
  count: number | null;
  rpe: number | null;
  /** When the set was ticked off; null if not completed. */
  completedAt: string | null;
}

export interface WorkoutExercise {
  id: string;
  exerciseId: string;
  /** Small integer unique within the workout; exercises sharing it form a superset. */
  supersetId: number | null;
  /** Rest timer in seconds, 0 = off. */
  restSeconds: number;
  notes: ExerciseNote[];
  /** Count dumbbell weight twice in volume (copied from the exercise setting when logged). */
  doubleDumbbellVolume: boolean;
  sets: WorkoutSet[];
}

export interface Workout extends Synced {
  title: string;
  description: string;
  startedAt: string;
  /** startedAt + active duration. */
  endedAt: string;
  routineId: string | null;
  exercises: WorkoutExercise[];
}

/** A routine set holds targets instead of logged values. */
export interface RoutineSet {
  id: string;
  type: SetType;
  weight: number | null;
  reps: number | null;
  repRange: { min: number | null; max: number | null } | null;
  distance: number | null;
  duration: number | null;
  count: number | null;
  rpe: number | null;
}

export interface RoutineExercise {
  id: string;
  exerciseId: string;
  supersetId: number | null;
  restSeconds: number;
  /** Notes shown every time this routine is logged. */
  notes: ExerciseNote[];
  /** Whether sets target a rep range instead of fixed reps. */
  useRepRange: boolean;
  sets: RoutineSet[];
}

export interface Routine extends Synced {
  title: string;
  notes: string;
  folderId: string | null;
  /** Lower comes first within a folder. */
  position: number;
  exercises: RoutineExercise[];
}

export interface RoutineFolder extends Synced {
  title: string;
  position: number;
}

export interface BodyMeasurement extends Synced {
  /** ISO date-time of the measurement. */
  takenAt: string;
  /** kg */
  bodyweight: number | null;
  fatPercent: number | null;
}
