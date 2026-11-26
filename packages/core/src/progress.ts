import { type ExerciseType, isRepBased } from "./exercise.ts";
import type { WithId, WorkoutEntryContent, WorkoutSetContent, WorkoutTree } from "./records.ts";
import { countsTowardTotals, setVolumeKg, workoutMinutes } from "./volume.ts";

/*
 * Progress figures: weekly totals, each exercise's sessions, records and estimates. Provisional
 * rules, in one place so they can be changed together:
 *
 * - Only finished workouts count, and within them only sets that count toward a workout's totals
 *   (completed, and warm-ups only when the countWarmups setting is on). Drop and failure sets are
 *   working sets and count.
 * - Volume follows volume.ts. Reps are counted for rep-based exercise types only.
 * - Estimated one-rep max uses the Epley formula, weight × (1 + reps / 30), and a single rep is the
 *   weight itself. It applies to weight-and-reps exercises only, with no cap on the reps.
 * - Heaviest weight is the weight logged for one set (a dumbbell's own weight, not doubled), for
 *   types that carry a weight, other than assisted ones where less weight is harder.
 */

/** One finished workout, reduced to what the weekly chart needs. */
export interface WorkoutPoint {
  id: string;
  /** Start time, ms. */
  time: number;
  minutes: number;
  volumeKg: number;
  reps: number;
  sets: number;
}

/** A session's best values for one exercise. Null where the exercise type doesn't have one. */
export interface SessionBest {
  heaviestKg: number | null;
  oneRepMaxKg: number | null;
  bestSetVolumeKg: number | null;
  volumeKg: number | null;
  mostReps: number | null;
  reps: number | null;
  longestSeconds: number | null;
  longestMeters: number | null;
}

/** One workout's sets of one exercise. */
export interface ExerciseSession {
  workoutId: string;
  workoutTitle: string;
  exerciseType: string;
  startedAt: string;
  time: number;
  /** Every set as logged, in order (for the history list). */
  sets: WithId<WorkoutSetContent>[];
  /** Sets that count toward figures. */
  counted: number;
  best: SessionBest;
}

export interface ExerciseHistory {
  exerciseId: string;
  /** The name it had in its latest session. */
  name: string;
  type: ExerciseType;
  usesBodyweight: boolean;
  /** Sets that count, over all sessions. */
  sets: number;
  /** Newest first. */
  sessions: ExerciseSession[];
}

export interface ProgressIndex {
  /** Oldest first. */
  workouts: WorkoutPoint[];
  /** The exercises done, most recently done first. */
  exercises: ExerciseHistory[];
  byExercise: Map<string, ExerciseHistory>;
}

export interface ProgressOptions {
  countWarmups: boolean;
  /** The bodyweight on record at a moment, for exercises whose volume includes it. */
  bodyweightAt: (time: number) => number | null;
  usesBodyweight: (exerciseId: string) => boolean;
}

/** Estimated one-rep max (Epley). Null without a positive weight and at least one rep. */
export function estimatedOneRepMax(weightKg: number | null, reps: number | null): number | null {
  if (weightKg === null || reps === null || weightKg <= 0 || reps < 1) return null;
  if (reps === 1) return weightKg;
  return weightKg * (1 + reps / 30);
}

const HAS_WEIGHT_RECORD: readonly ExerciseType[] = [
  "weight_reps",
  "weighted_bodyweight",
  "weight_duration",
  "weight_distance",
];
const HAS_DURATION: readonly ExerciseType[] = [
  "duration",
  "weight_duration",
  "distance_duration",
  "floors_duration",
  "steps_duration",
];
const HAS_DISTANCE: readonly ExerciseType[] = ["distance_duration", "weight_distance"];

const max = (current: number | null, value: number | null) =>
  value === null ? current : current === null || value > current ? value : current;

/** A session's bests from its sets, for an exercise of `type`. */
export function sessionBest(
  sets: WorkoutSetContent[],
  entry: Pick<WorkoutEntryContent, "exerciseType" | "doubleDumbbellVolume">,
  options: { countWarmups: boolean; usesBodyweight: boolean; bodyweightKg: number | null },
): { best: SessionBest; counted: number } {
  const type = entry.exerciseType as ExerciseType;
  const repBased = isRepBased(type);
  const weighted = HAS_WEIGHT_RECORD.includes(type);
  const timed = HAS_DURATION.includes(type);
  const far = HAS_DISTANCE.includes(type);
  const best: SessionBest = {
    heaviestKg: null,
    oneRepMaxKg: null,
    bestSetVolumeKg: null,
    volumeKg: repBased ? 0 : null,
    mostReps: null,
    reps: repBased ? 0 : null,
    longestSeconds: null,
    longestMeters: null,
  };
  let counted = 0;
  for (const set of sets) {
    if (!countsTowardTotals(set, options.countWarmups)) continue;
    counted += 1;
    if (weighted && set.weightKg !== null && set.weightKg > 0) {
      // A weight lifted for no reps isn't a lift; timed and distance types have no reps.
      if (!repBased || (set.reps ?? 0) >= 1) best.heaviestKg = max(best.heaviestKg, set.weightKg);
    }
    if (type === "weight_reps") {
      best.oneRepMaxKg = max(best.oneRepMaxKg, estimatedOneRepMax(set.weightKg, set.reps));
    }
    if (repBased && set.reps !== null && set.reps > 0) {
      const volume = setVolumeKg(set, entry, options);
      best.volumeKg = (best.volumeKg ?? 0) + volume;
      if (volume > 0) best.bestSetVolumeKg = max(best.bestSetVolumeKg, volume);
      best.reps = (best.reps ?? 0) + set.reps;
      best.mostReps = max(best.mostReps, set.reps);
    }
    if (timed && set.durationSeconds !== null && set.durationSeconds > 0) {
      best.longestSeconds = max(best.longestSeconds, set.durationSeconds);
    }
    if (far && set.distanceMeters !== null && set.distanceMeters > 0) {
      best.longestMeters = max(best.longestMeters, set.distanceMeters);
    }
  }
  return { best, counted };
}

/**
 * Everything the progress screens show, from one pass over every set of every finished workout.
 * An exercise done twice in one workout is one session.
 */
export function buildProgress(trees: WorkoutTree[], options: ProgressOptions): ProgressIndex {
  const workouts: WorkoutPoint[] = [];
  const byExercise = new Map<string, ExerciseHistory>();
  const latestTime = new Map<string, number>();
  for (const { workout, entries } of trees) {
    if (workout.content.endedAt === null) continue;
    const time = Date.parse(workout.content.startedAt);
    if (!Number.isFinite(time)) continue;
    const bodyweightKg = options.bodyweightAt(time);
    const point: WorkoutPoint = {
      id: workout.id,
      time,
      minutes: workoutMinutes(workout.content),
      volumeKg: 0,
      reps: 0,
      sets: 0,
    };
    // This workout's sessions by exercise, so two entries of one exercise make one session. Each
    // entry's sets are measured with their own entry (dumbbell weight can count differently).
    const here = new Map<
      string,
      { entry: WorkoutEntryContent; sets: WithId<WorkoutSetContent>[]; part: Part }
    >();
    for (const { entry, sets } of inPositionOrder(entries, (e) => e.entry.content.position)) {
      if (!sets.length) continue;
      const id = entry.content.exerciseId;
      const own = inPositionOrder(sets, (s) => s.content.position);
      const part = sessionBest(
        own.map((s) => s.content),
        entry.content,
        {
          countWarmups: options.countWarmups,
          usesBodyweight: options.usesBodyweight(id),
          bodyweightKg,
        },
      );
      const group = here.get(id);
      if (group) {
        group.sets = [...group.sets, ...own];
        group.part = combine(group.part, part);
      } else here.set(id, { entry: entry.content, sets: own, part });
    }
    for (const [exerciseId, { entry, sets, part }] of here) {
      point.volumeKg += part.best.volumeKg ?? 0;
      point.reps += part.best.reps ?? 0;
      point.sets += part.counted;
      let history = byExercise.get(exerciseId);
      if (!history) {
        history = {
          exerciseId,
          name: entry.exerciseName,
          type: entry.exerciseType as ExerciseType,
          usesBodyweight: options.usesBodyweight(exerciseId),
          sets: 0,
          sessions: [],
        };
        byExercise.set(exerciseId, history);
      }
      // The latest session names the exercise (it may have been renamed since older ones).
      if (time >= (latestTime.get(exerciseId) ?? Number.NEGATIVE_INFINITY)) {
        latestTime.set(exerciseId, time);
        history.name = entry.exerciseName;
        history.type = entry.exerciseType as ExerciseType;
      }
      history.sets += part.counted;
      history.sessions.push({
        workoutId: workout.id,
        workoutTitle: workout.content.title,
        exerciseType: entry.exerciseType,
        startedAt: workout.content.startedAt,
        time,
        sets,
        counted: part.counted,
        best: part.best,
      });
    }
    point.volumeKg = Math.round(point.volumeKg * 10) / 10;
    workouts.push(point);
  }
  workouts.sort((a, b) => a.time - b.time);
  for (const history of byExercise.values()) history.sessions.sort((a, b) => b.time - a.time);
  const exercises = [...byExercise.values()].sort(
    (a, b) => (b.sessions[0]?.time ?? 0) - (a.sessions[0]?.time ?? 0),
  );
  return { workouts, exercises, byExercise };
}

type Part = { best: SessionBest; counted: number };

/** The items in position order: the list itself when it already is (the usual case), else a copy. */
function inPositionOrder<T>(items: T[], position: (item: T) => number): T[] {
  for (let i = 1; i < items.length; i++) {
    if (position(items[i - 1] as T) > position(items[i] as T)) {
      return [...items].sort((a, b) => position(a) - position(b));
    }
  }
  return items;
}

function combine(a: Part, b: Part): Part {
  const sum = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : x + y);
  return {
    counted: a.counted + b.counted,
    best: {
      heaviestKg: max(a.best.heaviestKg, b.best.heaviestKg),
      oneRepMaxKg: max(a.best.oneRepMaxKg, b.best.oneRepMaxKg),
      bestSetVolumeKg: max(a.best.bestSetVolumeKg, b.best.bestSetVolumeKg),
      volumeKg: sum(a.best.volumeKg, b.best.volumeKg),
      mostReps: max(a.best.mostReps, b.best.mostReps),
      reps: sum(a.best.reps, b.best.reps),
      longestSeconds: max(a.best.longestSeconds, b.best.longestSeconds),
      longestMeters: max(a.best.longestMeters, b.best.longestMeters),
    },
  };
}

export type ExerciseMetric =
  | "oneRepMax"
  | "heaviest"
  | "bestSetVolume"
  | "sessionVolume"
  | "mostReps"
  | "sessionReps"
  | "longestDuration"
  | "longestDistance";

const METRIC_FIELD: Record<ExerciseMetric, keyof SessionBest> = {
  oneRepMax: "oneRepMaxKg",
  heaviest: "heaviestKg",
  bestSetVolume: "bestSetVolumeKg",
  sessionVolume: "volumeKg",
  mostReps: "mostReps",
  sessionReps: "reps",
  longestDuration: "longestSeconds",
  longestDistance: "longestMeters",
};

/** The measure a metric's values are in. */
export const METRIC_KIND: Record<ExerciseMetric, "weight" | "count" | "seconds" | "meters"> = {
  oneRepMax: "weight",
  heaviest: "weight",
  bestSetVolume: "weight",
  sessionVolume: "weight",
  mostReps: "count",
  sessionReps: "count",
  longestDuration: "seconds",
  longestDistance: "meters",
};

/**
 * The metrics that mean something for an exercise, the chart's default first. Volume needs a
 * weight: for bodyweight types it needs the exercise to count bodyweight.
 */
export function exerciseMetrics(type: ExerciseType, usesBodyweight: boolean): ExerciseMetric[] {
  switch (type) {
    case "weight_reps":
      return ["oneRepMax", "heaviest", "bestSetVolume", "sessionVolume", "mostReps", "sessionReps"];
    case "weighted_bodyweight":
      return ["heaviest", "mostReps", "sessionReps", "bestSetVolume", "sessionVolume"];
    case "bodyweight_reps":
    case "assisted_bodyweight":
      return usesBodyweight
        ? ["mostReps", "sessionReps", "bestSetVolume", "sessionVolume"]
        : ["mostReps", "sessionReps"];
    case "weight_duration":
      return ["heaviest", "longestDuration"];
    case "weight_distance":
      return ["heaviest", "longestDistance"];
    case "distance_duration":
      return ["longestDistance", "longestDuration"];
    default:
      return ["longestDuration"];
  }
}

export const metricValue = (session: ExerciseSession, metric: ExerciseMetric): number | null => {
  const value = session.best[METRIC_FIELD[metric]];
  // A session total of zero (every set skipped, say) is no data rather than a dip to zero.
  return value === null || value <= 0 ? null : value;
};

export interface ExerciseRecord {
  metric: ExerciseMetric;
  value: number;
  /** Where it was first reached. */
  workoutId: string;
  startedAt: string;
}

/** The metrics a record can be set in, in the order records are listed. */
export const RECORD_METRICS: readonly ExerciseMetric[] = [
  "heaviest",
  "oneRepMax",
  "bestSetVolume",
  "sessionVolume",
  "mostReps",
  "longestDuration",
  "longestDistance",
];

/**
 * Whether `value` beats `best` by more than rounding. The same sets added in another order (in
 * pounds, say) can differ in their last digits, and that is still a tie.
 */
export const beats = (value: number, best: number) =>
  value > best + 1e-9 * Math.max(1, Math.abs(best));

/** All-time bests among the metrics that apply, each with the session that first reached it. */
export function exerciseRecords(history: ExerciseHistory): ExerciseRecord[] {
  const applies = new Set(exerciseMetrics(history.type, history.usesBodyweight));
  const records: ExerciseRecord[] = [];
  for (const metric of RECORD_METRICS) {
    if (!applies.has(metric)) continue;
    let best: ExerciseRecord | null = null;
    // Oldest first, and only a higher value replaces it: a tie keeps the first time.
    for (let i = history.sessions.length - 1; i >= 0; i--) {
      const session = history.sessions[i] as ExerciseSession;
      const value = metricValue(session, metric);
      if (value !== null && (best === null || beats(value, best.value))) {
        best = { metric, value, workoutId: session.workoutId, startedAt: session.startedAt };
      }
    }
    if (best) records.push(best);
  }
  return records;
}
