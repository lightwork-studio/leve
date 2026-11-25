import type { JsonObject } from "@leve/contract";
import { routineEffortScale } from "./effort.ts";
import type { WorkoutTree } from "./past-workouts.ts";
import type { Routine, WithId, Workout, WorkoutEntry, WorkoutPlan, WorkoutSet } from "./types.ts";

// The rules of a workout in progress. Several are provisional choices for the first milestone
// (marked below) until the behaviour is settled.

export interface NewWorkout {
  workout: WithId<Workout>;
  entries: WithId<WorkoutEntry>[];
  sets: WithId<WorkoutSet>[];
}

export function emptyWorkoutSet(entryId: string): WorkoutSet {
  return {
    workoutExerciseId: entryId,
    position: 1,
    type: "normal",
    weightKg: null,
    reps: null,
    distanceMeters: null,
    durationSeconds: null,
    count: null,
    rpe: null,
    completedAt: null,
  };
}

/** An empty workout, or one with a routine's exercises and target sets, not yet done. */
export function startWorkout(options: {
  routine?: WithId<Routine>;
  now: number;
  newId: () => string;
}): NewWorkout {
  const { routine, now, newId } = options;
  const workout: WithId<Workout> = {
    id: newId(),
    content: {
      title: routine?.content.title ?? "",
      description: "",
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      routineId: routine?.id ?? null,
      initialPlan: routine
        ? {
            title: routine.content.title,
            effortScale: routineEffortScale(routine.content),
            exercises: routine.content.exercises.map(
              ({ id: _id, notes: _notes, sets, ...exercise }) => ({
                ...exercise,
                supersetId: exercise.supersetId ?? null,
                sets: sets.map(({ id: _id, ...target }) => ({
                  ...target,
                  rpe: target.rpe ?? null,
                  distanceMeters: target.distanceMeters ?? null,
                  count: target.count ?? null,
                })),
              }),
            ),
          }
        : null,
    },
  };
  const entries: WithId<WorkoutEntry>[] = [];
  const sets: WithId<WorkoutSet>[] = [];
  routine?.content.exercises.forEach((exercise, e) => {
    const entry: WithId<WorkoutEntry> = {
      id: newId(),
      content: {
        workoutId: workout.id,
        exerciseId: exercise.exerciseId,
        exerciseName: exercise.exerciseName,
        exerciseType: exercise.exerciseType,
        position: e + 1,
        supersetId: exercise.supersetId ?? null,
        notes: exercise.notes ?? [],
        restSeconds: exercise.restSeconds,
        doubleDumbbellVolume: false,
      },
    };
    entries.push(entry);
    exercise.sets.forEach((target, s) => {
      sets.push({
        id: newId(),
        content: {
          ...emptyWorkoutSet(entry.id),
          position: s + 1,
          planSlot: { exercise: e, set: s },
          type: target.type,
        },
      });
    });
  });
  return { workout, entries, sets };
}

/** The record content to store for a new or changed entry (the contract's full shape). */
export function entryContent(entry: WorkoutEntry): JsonObject {
  return { ...entry, notes: entry.notes ?? [] } as unknown as JsonObject;
}

/** Added sets and older workouts have no known original target. */
export function routineTarget(plan: WorkoutPlan | null, set: WorkoutSet) {
  const slot = set.planSlot;
  if (!slot) return undefined;
  const exercise = plan?.exercises[slot.exercise];
  const target = exercise?.sets[slot.set];
  if (!target) return undefined;
  // Only the selected rep mode supplies live hints and logging defaults.
  return exercise.useRepRange
    ? { ...target, reps: null }
    : { ...target, repRangeMin: null, repRangeMax: null };
}

/**
 * The target shown as a hint under a set. A routine's weight is where an exercise starts, so it is
 * hinted only until a weight was logged at that position; after that, last time's weight leads.
 * Reps, ranges, time, distance and effort stay goals and are always hinted.
 */
export function hintTarget(
  plan: WorkoutPlan | null,
  set: WorkoutSet,
  previous: PreviousSet | undefined,
) {
  const target = routineTarget(plan, set);
  if (!target || previous?.weightKg == null) return target;
  return { ...target, weightKg: null };
}

export type PreviousSet = Pick<
  WorkoutSet,
  "weightKg" | "reps" | "durationSeconds" | "distanceMeters" | "count"
>;

export interface PreviousExercise {
  sets: (PreviousSet | undefined)[];
  topOfRange: number | null;
}

/** Count the original working sets only when each has reached its own planned upper bound. */
export function topOfRepRanges(
  entry: WorkoutTree["entries"][number],
  plan: WorkoutPlan | null | undefined,
): number | null {
  const slot = entry.sets.find(({ content }) => content.planSlot)?.content.planSlot?.exercise;
  const exercise = slot === undefined ? undefined : plan?.exercises[slot];
  if (!exercise?.useRepRange || exercise.exerciseId !== entry.entry.content.exerciseId) return null;
  const targets = exercise.sets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => setGroup(target.type) === "normal");
  if (!targets.length) return null;
  for (const { target, index } of targets) {
    if (
      target.repRangeMin === null ||
      target.repRangeMax === null ||
      target.repRangeMin > target.repRangeMax
    )
      return null;
    const logged = entry.sets.find(
      ({ content }) => content.planSlot?.exercise === slot && content.planSlot?.set === index,
    );
    if (
      !logged ||
      logged.hasSyncConflict ||
      logged.content.completedAt === null ||
      setGroup(logged.content.type) !== "normal" ||
      logged.content.reps === null ||
      logged.content.reps < target.repRangeMax
    )
      return null;
  }
  return targets.length;
}

/** Normal and failure sets share working-set numbers on the logging screen. */
const setGroup = (type: WorkoutSet["type"]) => (type === "failure" ? "normal" : type);

/** Original plan positions for the same movement, even if the workout cards have since moved. */
function movementSlots(plan: WorkoutPlan | null | undefined, exerciseId: string) {
  return (
    plan?.exercises.flatMap((exercise, i) => (exercise.exerciseId === exerciseId ? [i] : [])) ?? []
  );
}

/**
 * What the user did last time for an exercise, set by set: from the latest finished workout that
 * has it, or only from workouts of the same routine when the setting says so.
 */
export function previousExercise(
  history: WorkoutTree[],
  exerciseId: string,
  options: {
    mode: "any_workout" | "same_routine";
    routineId: string | null;
    exceptWorkoutId: string;
    plannedTypes: WorkoutSet["type"][];
    plan?: WorkoutPlan | null;
    exerciseSlot?: number;
  },
): PreviousExercise {
  const slots = options.exerciseSlot === undefined ? [] : movementSlots(options.plan, exerciseId);
  const occurrence = slots.length > 1 ? slots.indexOf(options.exerciseSlot ?? -1) : -1;
  const candidates = history
    .filter((t) => t.workout.id !== options.exceptWorkoutId && t.workout.content.endedAt !== null)
    .filter(
      (t) => options.mode === "any_workout" || t.workout.content.routineId === options.routineId,
    )
    .sort(
      (a, b) => Date.parse(b.workout.content.startedAt) - Date.parse(a.workout.content.startedAt),
    );
  for (const tree of candidates) {
    const priorSlots =
      occurrence >= 0 ? movementSlots(tree.workout.content.initialPlan, exerciseId) : [];
    // When both snapshots contain repeated blocks, a skipped block cannot supply the other one's load.
    const matchingSlot = priorSlots.length > 1 ? priorSlots[occurrence] : undefined;
    if (priorSlots.length > 1 && matchingSlot === undefined) continue;
    const entry = tree.entries.find(
      (e) =>
        e.entry.content.exerciseId === exerciseId &&
        (matchingSlot === undefined ||
          e.sets.some((s) => s.content.planSlot?.exercise === matchingSlot)) &&
        e.sets.some((s) => s.content.completedAt !== null),
    );
    if (!entry) continue;
    const done = entry.sets.filter((s) => s.content.completedAt !== null);
    const byType = new Map<WorkoutSet["type"], PreviousSet[]>();
    for (const { content } of done.sort((a, b) => a.content.position - b.content.position)) {
      const group = byType.get(setGroup(content.type)) ?? [];
      group.push({
        count: content.count,
        weightKg: content.weightKg,
        distanceMeters: content.distanceMeters,
        reps: content.reps,
        durationSeconds: content.durationSeconds,
      });
      byType.set(setGroup(content.type), group);
    }
    return {
      sets: options.plannedTypes.map((type) => byType.get(setGroup(type))?.shift()),
      topOfRange: topOfRepRanges(entry, tree.workout.content.initialPlan),
    };
  }
  return { sets: [], topOfRange: null };
}

/**
 * The last finished session of an exercise that started before a moment, with the sets logged in
 * it in order: what a set logged after the fact can start from. Later sessions don't count, so
 * filling in an old workout suggests what came before it, not last week's numbers.
 */
export function sessionBefore(
  history: WorkoutTree[],
  exerciseId: string,
  options: { before: string; exceptWorkoutId: string },
): { startedAt: string; sets: WorkoutSet[] } | null {
  const before = Date.parse(options.before);
  const candidates = history
    .filter(
      (t) =>
        t.workout.id !== options.exceptWorkoutId &&
        t.workout.content.endedAt !== null &&
        Date.parse(t.workout.content.startedAt) < before,
    )
    .sort(
      (a, b) => Date.parse(b.workout.content.startedAt) - Date.parse(a.workout.content.startedAt),
    );
  for (const tree of candidates) {
    const entry = tree.entries.find(
      (e) =>
        e.entry.content.exerciseId === exerciseId &&
        e.sets.some((s) => s.content.completedAt !== null),
    );
    if (!entry) continue;
    const sets = entry.sets
      .filter((s) => s.content.completedAt !== null)
      .map((s) => s.content)
      .sort((a, b) => a.position - b.position);
    return { startedAt: tree.workout.content.startedAt, sets };
  }
  return null;
}

export function previousSets(
  ...args: Parameters<typeof previousExercise>
): (PreviousSet | undefined)[] {
  return previousExercise(...args).sets;
}

/** The exercise to work on: the first with a set still to do, or the last one when all are done. */
export function currentEntryIndex(tree: WorkoutTree): number {
  const index = tree.entries.findIndex((e) => e.sets.some((s) => s.content.completedAt === null));
  return index === -1 ? Math.max(0, tree.entries.length - 1) : index;
}

/** The set to log next within an entry, if any. */
export function nextSetIndex(sets: WithId<WorkoutSet>[]): number {
  return sets.findIndex((s) => s.content.completedAt === null);
}

/** Sets done and planned across the workout, for the header. */
export function setProgress(tree: WorkoutTree): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const { sets } of tree.entries) {
    total += sets.length;
    done += sets.filter((s) => s.content.completedAt !== null).length;
  }
  return { done, total };
}

/** Provisional: an untitled workout is named after the local time of day it started. */
export function autoTitle(startedAt: string): string {
  const hour = new Date(startedAt).getHours();
  if (hour >= 5 && hour < 12) return "Morning workout";
  if (hour >= 12 && hour < 17) return "Afternoon workout";
  if (hour >= 17 && hour < 22) return "Evening workout";
  return "Night workout";
}

/** A set's label: W for warm-up, D for drop, F for failure, otherwise its working-set number. */
export const setLabel = (type: WorkoutSet["type"], number: number) =>
  type === "warmup" ? "W" : type === "drop" ? "D" : type === "failure" ? "F" : String(number);

/** Working-set numbers for a list of sets: normal and failure sets count, warm-ups and drops don't. */
export function setNumbers(sets: { content: Pick<WorkoutSet, "type"> }[]): number[] {
  let number = 0;
  return sets.map((set) => {
    if (set.content.type === "normal" || set.content.type === "failure") number += 1;
    return number;
  });
}

/**
 * The set to log next: the first unlogged set in the selected exercise, or, when that exercise is
 * finished, in the first exercise with one left. Null when every set is logged.
 */
export function nextSet(
  tree: WorkoutTree,
  focusIndex: number,
): { entryIndex: number; setIndex: number } | null {
  let entryIndex = focusIndex;
  let entry = tree.entries[entryIndex];
  if (!entry || nextSetIndex(entry.sets) < 0) {
    entryIndex = currentEntryIndex(tree);
    entry = tree.entries[entryIndex];
  }
  if (!entry) return null;
  const setIndex = nextSetIndex(entry.sets);
  return setIndex < 0 ? null : { entryIndex, setIndex };
}

/** The next unlogged set in the selected exercise, or elsewhere if that exercise is finished. */
export function restCaption(tree: WorkoutTree, focusIndex: number): string {
  const next = nextSet(tree, focusIndex);
  const entry = next && tree.entries[next.entryIndex];
  const set = next && entry?.sets[next.setIndex];
  if (!next || !entry || !set) return "All sets logged";
  const label = setLabel(set.content.type, setNumbers(entry.sets)[next.setIndex] ?? 0);
  return `Next: ${entry.entry.content.exerciseName} · set ${label}`;
}
