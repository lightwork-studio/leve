import type { DeviceStore } from "@leve/storage";
import { useSyncExternalStore } from "react";
import { currentEntryIndex } from "../model/live.ts";
import type { WorkoutTree } from "../model/past-workouts.ts";

interface Selection {
  workoutId: string;
  entryId: string;
  /** A set picked to log next, if the lifter chose one rather than the exercise's next. */
  setId?: string;
}

const selections = new WeakMap<DeviceStore, Selection>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The selected exercise (and set) of the running workout on this device. It is restored when the
 * live workout opens again, and the minimised workout follows it too.
 */
export function useWorkoutSelection(store: DeviceStore, tree: WorkoutTree | undefined) {
  const read = () => selections.get(store);
  const selection = useSyncExternalStore(subscribe, read, read);
  const currentIndex = tree ? currentEntryIndex(tree) : 0;
  const mine = tree && selection?.workoutId === tree.workout.id ? selection : undefined;
  const selectedIndex = mine
    ? (tree?.entries.findIndex((entry) => entry.entry.id === mine.entryId) ?? -1)
    : -1;
  const choose = (next: Selection) => {
    selections.set(store, next);
    for (const listener of listeners) listener();
  };
  const focusExercise = (entryId: string) => {
    if (tree) choose({ workoutId: tree.workout.id, entryId });
  };
  const focusSet = (entryId: string, setId: string) => {
    if (tree) choose({ workoutId: tree.workout.id, entryId, setId });
  };
  return {
    currentIndex,
    focusIndex: selectedIndex >= 0 ? selectedIndex : currentIndex,
    pickedSetId: selectedIndex >= 0 ? mine?.setId : undefined,
    focusExercise,
    focusSet,
  };
}
