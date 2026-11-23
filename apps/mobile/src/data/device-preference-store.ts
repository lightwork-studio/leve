import { loadDevicePreference, saveDevicePreference } from "./device-preferences";

const cached = new Map<string, unknown>();
const listeners = new Set<() => void>();

export function readDevicePreference(key: string): unknown {
  if (!cached.has(key)) cached.set(key, loadDevicePreference(key));
  return cached.get(key);
}

export function writeDevicePreference(key: string, value: boolean | string): void {
  cached.set(key, value);
  saveDevicePreference(key, value);
  for (const listener of listeners) listener();
}

export function subscribeDevicePreferences(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function forgetDevicePreferences(): void {
  cached.clear();
}
