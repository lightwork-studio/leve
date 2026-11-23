import { useSyncExternalStore } from "react";
import {
  readDevicePreference,
  subscribeDevicePreferences,
  writeDevicePreference,
} from "./device-preference-store.ts";

export type AppearanceSetting = "system" | "light" | "dark";

function readAppearanceSetting(): AppearanceSetting {
  const value = readDevicePreference("appearance");
  return value === "light" || value === "dark" ? value : "system";
}

export function useAppearanceSetting(): AppearanceSetting {
  return useSyncExternalStore(subscribeDevicePreferences, readAppearanceSetting, () => "system");
}

export function saveAppearanceSetting(value: AppearanceSetting): void {
  writeDevicePreference("appearance", value);
}
