import { useSyncExternalStore } from "react";
import {
  readDevicePreference,
  subscribeDevicePreferences,
  writeDevicePreference,
} from "./device-preference-store.ts";

const key = "showTargets";
const read = () => readDevicePreference(key) !== false;

export function useShowTargets() {
  return useSyncExternalStore(subscribeDevicePreferences, read, () => true);
}

export function saveShowTargets(on: boolean) {
  writeDevicePreference(key, on);
}
