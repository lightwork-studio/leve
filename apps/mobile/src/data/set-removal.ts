import type { JsonObject } from "@leve/contract";
import type { DeviceStore } from "@leve/storage";
import type { WorkoutTree } from "../model/past-workouts.ts";
import type { WithId, WorkoutEntry, WorkoutSet } from "../model/types.ts";
import { removeWorkoutSet } from "./workout-actions.ts";

// Removing a set in the workout in progress takes it away at once, with a few seconds to undo it.
// Deleting is permanent once it reaches the server, so the set isn't deleted until Undo is gone:
// until then it is only held back on this device, and left out of everything the workout shows.
// Undo simply stops holding it back, so sync never sees a removal that was undone; once the Undo
// is gone the set is deleted like any other. If the app is closed in between, the set stays.

interface HeldSet {
  workoutId: string;
  setId: string;
  /** The set as it was shown when removed: the deletion is refused if the stored one differs. */
  opened: {
    id: string;
    values: WorkoutSet;
    parent: JsonObject | null;
    exerciseType: string;
  };
}

const held = new WeakMap<DeviceStore, HeldSet>();

/** The set being held back for Undo, if any. */
export function heldSet(store: DeviceStore): HeldSet | undefined {
  return held.get(store);
}

/**
 * Takes a set out of the workout in progress, ready to be undone. A set held back before is
 * deleted first (see deleteHeldSet). `shown` is the set and its exercise as the lifter saw them
 * when removing it: the deletion checks against that, not against what is stored by then, so a
 * change that landed before the removal but never showed refuses it instead of being deleted unseen.
 */
export function holdSetRemoval(
  store: DeviceStore,
  workoutId: string,
  shown: { set: WithId<WorkoutSet>; entry: WithId<WorkoutEntry> },
): void {
  deleteHeldSet(store);
  const setId = shown.set.id;
  const set = store.get("workout_set", setId);
  if (!set?.content || set.deleted) return;
  held.set(store, {
    workoutId,
    setId,
    opened: {
      id: setId,
      values: shown.set.content,
      parent: shown.entry.content as unknown as JsonObject,
      exerciseType: shown.entry.content.exerciseType,
    },
  });
}

/** Puts the held set back, exactly as it was: nothing about it was changed. */
export function undoSetRemoval(store: DeviceStore): string | null {
  const set = held.get(store);
  held.delete(store);
  return set?.setId ?? null;
}

/**
 * Deletes the held set, now that it can no longer be undone. Throws (and forgets it, so it shows
 * again) if the set changed since it was removed.
 */
export function deleteHeldSet(store: DeviceStore): void {
  const set = held.get(store);
  if (!set) return;
  held.delete(store);
  const record = store.get("workout_set", set.setId);
  if (!record?.content || record.deleted) return;
  removeWorkoutSet(store, set.setId, set.opened);
}

/** The workout without the set held back for Undo. */
export function withoutHeldSet(store: DeviceStore, tree: WorkoutTree): WorkoutTree {
  const set = held.get(store);
  if (!set || set.workoutId !== tree.workout.id) return tree;
  return {
    ...tree,
    entries: tree.entries.map((entry) =>
      entry.sets.some((s) => s.id === set.setId)
        ? { ...entry, sets: entry.sets.filter((s) => s.id !== set.setId) }
        : entry,
    ),
  };
}
