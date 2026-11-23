import type { RecordContent } from "@leve/contract";

// Shapes of record content as the screens read them (the contract validates them on write).

export type PlanTarget = Omit<RoutineSet, "id">;
export interface WorkoutPlan {
  title: string;
  exercises: (Omit<RoutineExercise, "id" | "sets" | "notes"> & { sets: PlanTarget[] })[];
}

export type WorkoutNote = Omit<RecordContent<"workout_note">, "reply" | "workoutId"> & {
  id: string;
  reply: NonNullable<RecordContent<"workout_note">["reply"]> | null;
};

export interface Workout {
  initialPlan?: WorkoutPlan | null;
  title: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  routineId: string | null;
}

export interface WorkoutEntry {
  notes?: { id: string; text: string; createdAt: string }[];
  workoutId: string;
  exerciseId: string;
  exerciseName: string;
  exerciseType: string;
  position: number;
  supersetId: number | null;
  restSeconds: number;
  doubleDumbbellVolume: boolean;
}

export interface WorkoutSet {
  repsInReserve?: number | null;
  planSlot?: { exercise: number; set: number } | null;
  workoutExerciseId: string;
  position: number;
  type: "normal" | "warmup" | "failure" | "drop";
  weightKg: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  count: number | null;
  rpe: number | null;
  completedAt: string | null;
}

export interface RoutineSet {
  rpe?: number | null;
  count?: number | null;
  id: string;
  type: WorkoutSet["type"];
  weightKg: number | null;
  reps: number | null;
  distanceMeters?: number | null;
  repRangeMin: number | null;
  repRangeMax: number | null;
  durationSeconds: number | null;
}

export interface RoutineExercise {
  supersetId?: number | null;
  notes?: WorkoutEntry["notes"];
  id: string;
  exerciseId: string;
  exerciseName: string;
  exerciseType: string;
  restSeconds: number;
  useRepRange: boolean;
  sets: RoutineSet[];
}

export interface Routine {
  title: string;
  notes: string;
  folderId: string | null;
  position: number;
  exercises: RoutineExercise[];
}

export interface Folder {
  title: string;
  position: number;
}

export interface Settings {
  weightUnit: "kg" | "lbs";
  distanceUnit: "km" | "miles";
  shortDistanceUnit: "m" | "yd";
  measurementUnit: "cm" | "in";
  firstWeekday: number;
  defaultRestSeconds: number;
  countWarmups: boolean;
  previousValues: "any_workout" | "same_routine";
  /** Ask for reps in reserve after each logged set. */
  trackRepsInReserve: boolean;
}

/** A record as the model functions take it: its id and content. */
export type WithId<T> = { id: string; content: T };
