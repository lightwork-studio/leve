import { readDevicePreference, writeDevicePreference } from "../data/device-preference-store.ts";

// Sync's own notes on this phone, kept beside the other device preferences and never synced.

/**
 * Kept under its old name. "off" means signed out from Settings on purpose; an earlier version
 * also wrote it for "Ignore" on the sign-in question, which now reads the same: every screen says
 * the phone isn't syncing, with Sign in.
 */
const SIGNED_OUT = "sync.signInReminder";
const PAUSED = "sync.paused";
const LAST_SYNCED = "sync.lastSynced";

/**
 * Whether the person signed out from Settings on purpose. Then the app doesn't ask them to sign in
 * again: it says, on every screen, that this phone's data isn't syncing. A sign-in that ran out by
 * itself always asks. (Values an earlier version left here, such as a "Remind me later" time, read
 * as false, so the question comes back.)
 */
export function signedOutOnPurpose(): boolean {
  return readDevicePreference(SIGNED_OUT) === "off";
}

export function setSignedOutOnPurpose(value: boolean): void {
  writeDevicePreference(SIGNED_OUT, value ? "off" : "");
}

/**
 * Whether the person paused sync: the way out of a question that can't be answered yet, such as an
 * update this phone can't install right now. Nothing syncs and nothing is asked until they resume,
 * and every screen says so.
 */
export function syncPaused(): boolean {
  return readDevicePreference(PAUSED) === true;
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
