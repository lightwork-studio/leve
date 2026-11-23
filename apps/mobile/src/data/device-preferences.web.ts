// Preferences kept in this browser only, never synced. Phones use `device-preferences.ts`.

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
  try {
    if (key === "trackRir") return readLegacyPreferences()[key];
    const stored = globalThis.localStorage?.getItem(`${KEY}:${key}`);
    return stored == null ? undefined : JSON.parse(stored);
  } catch {
    return undefined;
  }
}

/** Separate keys keep tabs from replacing each other's unrelated preferences. */
export function saveDevicePreference(key: string, value: boolean | string): void {
  try {
    if (key === "trackRir") {
      globalThis.localStorage?.setItem(
        KEY,
        JSON.stringify({ ...readLegacyPreferences(), [key]: value }),
      );
    } else {
      globalThis.localStorage?.setItem(`${KEY}:${key}`, JSON.stringify(value));
    }
  } catch {
    // Kept in memory until the page closes.
  }
}
