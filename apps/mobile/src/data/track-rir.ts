import type { DeviceStore } from "@leve/storage";
import { useAppData } from "./app-data.tsx";
import { useSettings } from "./queries.ts";
import { readSettings } from "./read.ts";
import { SettingsError, saveSettings } from "./settings-actions.ts";

// Whether to ask for reps in reserve after each set. Every read and write of the setting goes
// through this module. It is part of the synced settings record (`trackRepsInReserve`), so it
// follows the lifter to their other devices. Builds before that kept it on the device only; that
// copy is no longer read, so the setting starts off again until it is turned on.

/** Whether Track RIR is on. Off unless turned on. */
export function readTrackRir(store: DeviceStore): boolean {
  return readSettings(store).trackRepsInReserve;
}

/**
 * Whether Track RIR can be changed: always on this device alone, and when connected only while the
 * server supports the setting and no download that must come first is still running.
 */
export function canChangeTrackRir(store: DeviceStore): boolean {
  const { account, release, refreshFrom, restoring } = store.syncState();
  return (
    account === null ||
    (!refreshFrom &&
      !restoring &&
      release !== null &&
      store.contract.featureAvailable("track_reps_in_reserve", release))
  );
}

/**
 * Turns Track RIR on or off. Choosing what it already reads as saves nothing, so turning off a
 * setting nobody chose leaves it not set. Throws a SettingsError while it can't be changed.
 */
export function saveTrackRir(store: DeviceStore, on: boolean): void {
  if (readTrackRir(store) === on) return;
  if (!canChangeTrackRir(store)) {
    throw new SettingsError("Track RIR can be changed once the connected server supports it.");
  }
  saveSettings(store, { trackRepsInReserve: on });
}

/** Track RIR and a way to change it, for a screen. */
export function useTrackRir(): [boolean, (on: boolean) => void] {
  const { change } = useAppData();
  const on = useSettings().trackRepsInReserve;
  return [on, (next) => change((store) => saveTrackRir(store, next))];
}
