import type { RecordContent } from "@leve/contract";
import type { EffortScale, RoutineExerciseContent as RoutineExercise } from "@leve/core";

// Workout and routine shapes are shared with the server, in @leve/core.
export type {
  PlanTargetContent as PlanTarget,
  RoutineExerciseContent as RoutineExercise,
  RoutineSetContent as RoutineSet,
  WithId,
  WorkoutContent as Workout,
  WorkoutEntryContent as WorkoutEntry,
  WorkoutPlanContent as WorkoutPlan,
  WorkoutSetContent as WorkoutSet,
} from "@leve/core";

// Shapes of record content as the screens read them (the contract validates them on write).

/** A note on a whole workout. `agent` is null when the lifter wrote it. */
export type WorkoutNote = Omit<RecordContent<"workout_note">, "workoutId" | "agent"> & {
  id: string;
  agent: string | null;
};

/** A note on an exercise, kept apart from any workout so a pinned one outlives the workout. */
export type ExerciseNote = Omit<RecordContent<"exercise_note">, "workoutId" | "agent"> & {
  id: string;
  workoutId: string | null;
  agent: string | null;
};

/** A comment on a workout or exercise note, by the lifter (`agent` null) or an agent. */
export interface NoteComment {
  id: string;
  noteId: string;
  text: string;
  createdAt: string;
  agent: string | null;
}

export interface Routine {
  effortScale?: EffortScale | null;
  title: string;
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
