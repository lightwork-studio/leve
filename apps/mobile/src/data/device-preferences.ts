import { File, Paths } from "expo-file-system";

// Preferences kept on this phone only, never synced: a small JSON file beside the app's documents.
// The web build uses `device-preferences.web.ts` instead.

const FILE = "leve-device-preferences.json";

function readDevicePreferences(file: File): Record<string, unknown> {
  if (!file.exists) return {};
  const parsed: unknown = JSON.parse(file.textSync() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid device preferences");
  }
  return parsed as Record<string, unknown>;
}

export function loadDevicePreference(key: string): unknown {
  try {
    return readDevicePreferences(new File(Paths.document, FILE))[key];
  } catch {
    return undefined;
  }
}

/** Updates one preference. A failure keeps the value for this session only. */
export function saveDevicePreference(key: string, value: boolean | string): void {
  try {
    const file = new File(Paths.document, FILE);
    const preferences = { ...readDevicePreferences(file), [key]: value };
    if (!file.exists) file.create();
    file.writeSync(JSON.stringify(preferences));
  } catch {
    // Kept in memory until the app closes.
  }
}
