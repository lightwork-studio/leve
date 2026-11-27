import type { DeviceStore } from "@leve/storage";
import { readDevicePreference, writeDevicePreference } from "./device-preference-store.ts";

// The workout in progress syncs to every phone of the account, so each one sees it as running.
// Only the phone it is logged on should hold its sync questions back for it: this note, kept on
// this phone and never synced, says which workout that is ("" for none).

const WORKOUT_HERE = "sync.workoutHere";

/** After a write to the workout in progress on this phone: remember it (or that none runs). */
export function noteWorkoutHere(store: DeviceStore): void {
  const id = store.activeWorkout()?.id ?? "";
  if (readDevicePreference(WORKOUT_HERE) !== id) writeDevicePreference(WORKOUT_HERE, id);
}

/**
 * Starts the note on a phone that never wrote one, once no workout runs: from then on only a
 * workout logged here counts. (Until then, see workoutHere.)
 */
export function startNotingWorkoutHere(store: DeviceStore): void {
  if (readDevicePreference(WORKOUT_HERE) === undefined && !store.activeWorkout())
    writeDevicePreference(WORKOUT_HERE, "");
}

/** The workout in progress, if it was started or logged on this phone. */
export function workoutHere(store: DeviceStore) {
  const running = store.activeWorkout();
  if (!running) return null;
  const noted = readDevicePreference(WORKOUT_HERE);
  // Never noted: a workout that was already running when this version first opened. It may be
  // logged here, so it is taken as this phone's (questions wait, with a note, until it ends).
  if (noted === undefined) return running;
  return running.id === noted ? running : null;
}
