// Preferences kept in this browser only, never synced. Phones use `device-preferences.ts`.

import { buildInfo } from "../build-info.ts";

const KEY = "leve-device-preferences";

/** Track RIR stays in its original key, including for older builds. */
function readLegacyPreferences(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid device preferences");
  }
  return parsed as Record<string, unknown>;
}

export function loadDevicePreference(key: string): unknown {
  if (buildInfo.webDemo) return undefined;
  try {
    if (key === "trackRir") return readLegacyPreferences()[key];
    const stored = globalThis.localStorage?.getItem(`${KEY}:${key}`);
    return stored == null ? undefined : JSON.parse(stored);
  } catch {
    return undefined;
  }
}

/** Separate keys keep tabs from replacing each other's unrelated preferences. */
export function saveDevicePreference(key: string, value: boolean | string): boolean {
  if (buildInfo.webDemo) return false;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    if (key === "trackRir") {
      storage.setItem(KEY, JSON.stringify({ ...readLegacyPreferences(), [key]: value }));
    } else {
      storage.setItem(`${KEY}:${key}`, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}
