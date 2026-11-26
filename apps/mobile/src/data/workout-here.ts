import type { DeviceStore } from "@leve/storage";
import { readDevicePreference, writeDevicePreference } from "./device-preference-store.ts";

// The workout in progress syncs to every phone of the account, so each one sees it as running.
// Only the phone it is logged on should hold its sync questions back for it: this note, kept on
// this phone and never synced, says which workout that is.

const WORKOUT_HERE = "sync.workoutHere";

/** After a write to the workout in progress on this phone: remember it (or that none runs). */
export function noteWorkoutHere(store: DeviceStore): void {
  const id = store.activeWorkout()?.id ?? "";
  if (readDevicePreference(WORKOUT_HERE) !== id) writeDevicePreference(WORKOUT_HERE, id);
}

/** The workout in progress, if it was started or logged on this phone. */
export function workoutHere(store: DeviceStore) {
  const running = store.activeWorkout();
  return running && running.id === readDevicePreference(WORKOUT_HERE) ? running : null;
}
