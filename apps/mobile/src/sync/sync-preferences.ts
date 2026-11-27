import {
  hasUnsavedDevicePreference,
  readDevicePreference,
  writeDevicePreference,
} from "../data/device-preference-store.ts";

// Sync's own notes on this phone, kept beside the other device preferences and never synced.

/**
 * Written only by a deliberate sign-out. Earlier versions kept "sync.signInReminder" instead, which
 * "Ignore" and "Remind me later" on the sign-in question wrote too. It is no longer read, so
 * whatever it holds, a lapsed sign-in asks again (once, for someone who had signed out on purpose).
 */
const SIGNED_OUT = "sync.signedOut";
const PAUSED = "sync.paused";
const LAST_SYNCED = "sync.lastSynced";

/**
 * Whether the person signed out on purpose (from Settings, or to keep data that isn't the signed-in
 * account's). Then the app doesn't ask them to sign in again: it says, on every screen, that this
 * phone's data isn't syncing. A sign-in that ran out by itself always asks.
 */
export function signedOutOnPurpose(): boolean {
  return readDevicePreference(SIGNED_OUT) === true;
}

export function setSignedOutOnPurpose(value: boolean): void {
  writeDevicePreference(SIGNED_OUT, value);
}

/**
 * Whether the person paused sync: the way out of a question that can't be answered yet, such as an
 * update this phone can't install right now. Nothing syncs and nothing is asked until they resume,
 * and every screen says so.
 */
export function syncPaused(): boolean {
  return readDevicePreference(PAUSED) === true;
}

export function syncPauseIsTemporary(): boolean {
  return hasUnsavedDevicePreference(PAUSED);
}

export function setSyncPaused(value: boolean): void {
  writeDevicePreference(PAUSED, value);
}

export function readLastSynced(): number | null {
  const value = readDevicePreference(LAST_SYNCED);
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

export function writeLastSynced(time: number | null): void {
  writeDevicePreference(LAST_SYNCED, time === null ? "" : new Date(time).toISOString());
}
