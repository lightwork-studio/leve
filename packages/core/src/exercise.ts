/** How a set of this exercise is measured. Fixed when the exercise is created. */
export const EXERCISE_TYPES = [
  "weight_reps",
  "bodyweight_reps",
  "weighted_bodyweight",
  "assisted_bodyweight",
  "duration",
  "weight_duration",
  "distance_duration",
  "weight_distance",
  "floors_duration",
  "steps_duration",
] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/** Metric fields a set can carry. */
export type SetMetric = "weight" | "reps" | "distance" | "duration" | "count";

/** Which metric fields each exercise type uses. Unused fields stay null. */
export const METRICS_BY_TYPE: Record<ExerciseType, readonly SetMetric[]> = {
  weight_reps: ["weight", "reps"],
  bodyweight_reps: ["reps"],
  weighted_bodyweight: ["weight", "reps"],
  assisted_bodyweight: ["weight", "reps"],
  duration: ["duration"],
  weight_duration: ["weight", "duration"],
  distance_duration: ["distance", "duration"],
  weight_distance: ["weight", "distance"],
  floors_duration: ["count", "duration"],
  steps_duration: ["count", "duration"],
};

/** Exercise types whose sets count repetitions (RPE and rep ranges apply to these). */
export const REP_BASED_TYPES: readonly ExerciseType[] = [
  "weight_reps",
  "bodyweight_reps",
  "weighted_bodyweight",
  "assisted_bodyweight",
];

export const MUSCLE_GROUPS = [
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "lats",
  "lower_back",
  "upper_back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
  "cardio",
  "full_body",
  "other",
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

/** Coarse regions used for muscle-split charts. Muscles not listed belong to no region. */
export const MUSCLE_REGIONS = {
  core: ["abdominals"],
  shoulders: ["shoulders"],
  arms: ["biceps", "triceps", "forearms"],
  legs: ["quadriceps", "hamstrings", "calves", "glutes", "abductors", "adductors"],
  back: ["lats", "upper_back", "traps", "lower_back"],
  chest: ["chest"],
} as const satisfies Record<string, readonly MuscleGroup[]>;
export type MuscleRegion = keyof typeof MUSCLE_REGIONS;

export const EQUIPMENT = [
  "none",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "plate",
  "resistance_band",
  "suspension",
  "other",
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

export interface Exercise {
  id: string;
  name: string;
  type: ExerciseType;
  primaryMuscle: MuscleGroup;
  secondaryMuscles: MuscleGroup[];
  equipment: Equipment;
  /** Volume uses the lifter's full bodyweight (pull-ups, dips and their variants). */
  usesBodyweight: boolean;
  /** True for exercises the user created; false for the built-in library. */
  custom: boolean;
  /** Archived exercises are hidden from pickers but stay valid in history. */
  archived: boolean;
}

export const usesMetric = (type: ExerciseType, metric: SetMetric): boolean =>
  METRICS_BY_TYPE[type].includes(metric);

export const isRepBased = (type: ExerciseType): boolean => REP_BASED_TYPES.includes(type);
