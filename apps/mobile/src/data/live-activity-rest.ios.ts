import { requireOptionalNativeModule } from "expo";
import type { LiveActivityRest } from "./live-activity-rest.ts";

const widgets = requireOptionalNativeModule<{
  leveRestChange?(key: string): LiveActivityRest | null;
}>("ExpoWidgets");

export function readLiveActivityRest(key: string): LiveActivityRest | null {
  return widgets?.leveRestChange?.(key) ?? null;
}
