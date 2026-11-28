import { useSyncExternalStore } from "react";
import {
  readDevicePreference,
  subscribeDevicePreferences,
  writeDevicePreference,
} from "./device-preference-store.ts";

/** Off until turned on. "unset" means Leve hasn't offered it yet. */
export type RestAlertSetting = "on" | "off" | "unset";

function readRestAlertSetting(): RestAlertSetting {
  const value = readDevicePreference("restAlert");
  return value === "on" || value === "off" ? value : "unset";
}

export function useRestAlertSetting(): RestAlertSetting {
  return useSyncExternalStore(subscribeDevicePreferences, readRestAlertSetting, () => "unset");
}

export function saveRestAlertSetting(on: boolean): void {
  writeDevicePreference("restAlert", on ? "on" : "off");
}
