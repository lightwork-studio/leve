import type { EffortScale } from "./workout.ts";

// Shapes of workout and routine record content as readers take them (the contract validates them
// on write). Shared by the app's screens and the server's MCP tools.

export type PlanTargetContent = Omit<RoutineSetContent, "id">;
export interface WorkoutPlanContent {
  title: string;
  effortScale?: EffortScale;
  exercises: (Omit<RoutineExerciseContent, "id" | "sets"> & { sets: PlanTargetContent[] })[];
}

export interface WorkoutContent {
  initialPlan?: WorkoutPlanContent | null;
  title: string;
  startedAt: string;
  endedAt: string | null;
  routineId: string | null;
}

export interface WorkoutEntryContent {
  workoutId: string;
  exerciseId: string;
  exerciseName: string;
  exerciseType: string;
  position: number;
  supersetId: number | null;
  restSeconds: number;
  doubleDumbbellVolume: boolean;
}

export interface WorkoutSetContent {
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

export interface RoutineSetContent {
  rpe?: number | null;
  repsInReserve?: number | null;
  count?: number | null;
  id: string;
  type: WorkoutSetContent["type"];
  weightKg: number | null;
  reps: number | null;
  distanceMeters?: number | null;
  repRangeMin: number | null;
  repRangeMax: number | null;
  durationSeconds: number | null;
}

export interface RoutineExerciseContent {
  supersetId?: number | null;
  id: string;
  exerciseId: string;
  exerciseName: string;
  exerciseType: string;
  restSeconds: number;
  useRepRange: boolean;
  sets: RoutineSetContent[];
}

/** A record as the model functions take it: its id and content. */
export type WithId<T> = { id: string; content: T };

/** A workout with its exercise entries and their sets. */
export interface WorkoutTree {
  workout: WithId<WorkoutContent>;
  entries: { entry: WithId<WorkoutEntryContent>; sets: WithId<WorkoutSetContent>[] }[];
}
