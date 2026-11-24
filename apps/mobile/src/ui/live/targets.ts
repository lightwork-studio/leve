import type { SetDistanceUnit, SetMetric } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import { restTimer } from "../../data/rest-timer.ts";
import { type PreviousExercise, previousExercise, setLabel, setNumbers } from "../../model/live.ts";
import type { WorkoutTree } from "../../model/past-workouts.ts";
import type { Settings, WorkoutPlan } from "../../model/types.ts";
import type { DistancePreferences } from "../format.ts";
import { clearSetStopwatch } from "../use-set-stopwatch.ts";
import type { UpdateSetDrafts } from "../use-workout-inputs.ts";

// Which set the live workout logs next, what it is compared with, and what happens around a log.
// Shared by the logging screen and the minimised workout, so they always agree.

export type Entry = WorkoutTree["entries"][number];
export type LiveSet = Entry["sets"][number];

/** The distance unit an exercise's column shows: the one chosen for it, or the usual one. */
export function entryDistanceUnit(
  type: string,
  chosen: SetDistanceUnit | undefined,
  prefs: DistancePreferences,
): SetDistanceUnit {
  return chosen ?? (type === "distance_duration" ? prefs.distanceUnit : prefs.shortDistanceUnit);
}

function originalExerciseSlot(sets: Entry["sets"]) {
  return sets.find((set) => set.content.planSlot)?.content.planSlot?.exercise;
}

/** What changes the previous values: which exercises are in the workout, not what was logged. */
export function previousKey(
  tree: WorkoutTree,
  settings: Pick<Settings, "previousValues">,
  plan: WorkoutPlan | null,
): string {
  return [
    settings.previousValues,
    tree.workout.id,
    tree.workout.content.routineId,
    plan?.exercises.map((e) => e.exerciseId).join(","),
    ...tree.entries.map(
      (e) =>
        `${e.entry.id}:${e.entry.content.exerciseId}:${originalExerciseSlot(e.sets) ?? ""}:${e.sets.map((s) => s.content.type).join(",")}`,
    ),
  ].join("|");
}

/** Last time's sets for every exercise of the workout, by entry. */
export function previousForWorkout(
  history: WorkoutTree[],
  tree: WorkoutTree,
  settings: Pick<Settings, "previousValues">,
  plan: WorkoutPlan | null,
): Map<string, PreviousExercise> {
  const map = new Map<string, PreviousExercise>();
  for (const { entry, sets } of tree.entries) {
    map.set(
      entry.id,
      previousExercise(history, entry.content.exerciseId, {
        mode: settings.previousValues,
        routineId: tree.workout.content.routineId,
        exceptWorkoutId: tree.workout.id,
        plannedTypes: sets.map((s) => s.content.type),
        plan,
        exerciseSlot: originalExerciseSlot(sets),
      }),
    );
  }
  return map;
}

export interface DockTarget {
  entry: Entry;
  entryIndex: number;
  set: LiveSet;
  setIndex: number;
  /** W, D, F or the working-set number. */
  label: string;
}

const loggable = (set: LiveSet) => set.content.completedAt === null && !set.needsSyncReview;

/** A set's label in its exercise: W, D, F or its working-set number. */
export function labelOf(entry: Entry, setIndex: number): string {
  const set = entry.sets[setIndex];
  return set ? setLabel(set.content.type, setNumbers(entry.sets)[setIndex] ?? 0) : "";
}

/**
 * The set the dock logs next: the one picked, else the next of the selected exercise, else the
 * next anywhere in the workout. Nothing when every set is logged.
 */
export function dockTarget(
  tree: WorkoutTree,
  focusIndex: number,
  pickedSetId?: string,
): DockTarget | null {
  const at = (entryIndex: number, setIndex: number): DockTarget | null => {
    const entry = tree.entries[entryIndex];
    const set = entry?.sets[setIndex];
    if (!entry || !set) return null;
    return { entry, entryIndex, set, setIndex, label: labelOf(entry, setIndex) };
  };
  const focused = tree.entries[focusIndex];
  if (focused && pickedSetId) {
    const picked = focused.sets.findIndex((set) => set.id === pickedSetId);
    const set = focused.sets[picked];
    if (set && loggable(set)) return at(focusIndex, picked);
  }
  for (const entryIndex of [focusIndex, ...tree.entries.keys()]) {
    const next = tree.entries[entryIndex]?.sets.findIndex(loggable) ?? -1;
    if (next >= 0) return at(entryIndex, next);
  }
  return null;
}

/** After a set is logged: its rest starts, and what was typed for it is cleared. */
export function afterLog(
  store: DeviceStore,
  workoutId: string,
  entry: Entry,
  setId: string,
  setDrafts: UpdateSetDrafts,
) {
  clearSetStopwatch(store, workoutId, setId);
  setDrafts((drafts) => {
    const { [setId]: _, ...rest } = drafts;
    return rest;
  });
  restTimer.start(store, workoutId, setId, entry.entry.content.restSeconds);
}

/**
 * A field the live workout should open for typing when it is shown next: Log from the minimised
 * workout couldn't log a set without it.
 */
export interface Ask {
  workoutId: string;
  entryId: string;
  setId: string;
  metric: SetMetric;
  message: string;
}
const asks = new WeakMap<DeviceStore, Ask>();
export const pendingAsk = {
  set(store: DeviceStore, ask: Ask) {
    asks.set(store, ask);
  },
  take(store: DeviceStore, workoutId: string): Ask | undefined {
    const ask = asks.get(store);
    asks.delete(store);
    return ask?.workoutId === workoutId ? ask : undefined;
  },
};
