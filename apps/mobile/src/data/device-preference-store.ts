import { loadDevicePreference, saveDevicePreference } from "./device-preferences";

const cached = new Map<string, unknown>();
const unsaved = new Set<string>();
const listeners = new Set<() => void>();

export function readDevicePreference(key: string): unknown {
  if (!cached.has(key)) cached.set(key, loadDevicePreference(key));
  return cached.get(key);
}

export function writeDevicePreference(key: string, value: boolean | string): void {
  cached.set(key, value);
  if (saveDevicePreference(key, value)) unsaved.delete(key);
  else unsaved.add(key);
  for (const listener of listeners) listener();
}

/** Whether the latest change to this preference exists only in memory. */
export function hasUnsavedDevicePreference(key: string): boolean {
  return unsaved.has(key);
}

export function subscribeDevicePreferences(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function forgetDevicePreferences(): void {
  cached.clear();
  unsaved.clear();
}
