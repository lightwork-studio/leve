import { readDevicePreference, writeDevicePreference } from "../data/device-preference-store.ts";

// Sync's own notes on this phone, kept beside the other device preferences and never synced.

const SIGN_IN_REMINDER = "sync.signInReminder";
const LAST_SYNCED = "sync.lastSynced";

/** How long "Remind me later" waits before asking to sign in again. */
export const REMIND_LATER_MS = 24 * 60 * 60_000;

/**
 * Whether to ask to sign in again now: not after the person signed out on purpose or chose to
 * ignore it, and not before a "Remind me later" has run out.
 */
export function signInReminderDue(now: number): boolean {
  const value = readDevicePreference(SIGN_IN_REMINDER);
  if (value === "off") return false;
  if (typeof value === "string" && value) {
    const after = Date.parse(value);
    if (Number.isFinite(after) && after > now) return false;
  }
  return true;
}

/** "off": don't ask (signed out on purpose, or ignored). A time: ask again after it. "": ask. */
export function setSignInReminder(value: "off" | "" | number): void {
  writeDevicePreference(
    SIGN_IN_REMINDER,
    typeof value === "number" ? new Date(value).toISOString() : value,
  );
}

export function readLastSynced(): number | null {
  const value = readDevicePreference(LAST_SYNCED);
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

export function writeLastSynced(time: number | null): void {
  writeDevicePreference(LAST_SYNCED, time === null ? "" : new Date(time).toISOString());
}
