import { Platform } from "react-native";
import { builtInServerConfigured, ownServerOffered, syncConfigured } from "./sync-server.ts";

export { builtInServerConfigured, syncServerUrl } from "./sync-server.ts";

/** Syncing needs a server and a sign-in, and syncing is on iOS only for now. */
export function syncEnabled(): boolean {
  return syncConfigured() && Platform.OS === "ios";
}

/** Whether Settings offers pairing with a server of the person's own. */
export function ownServerAvailable(): boolean {
  return ownServerOffered && Platform.OS === "ios";
}

/** Whether the signed-in Leve account can be chosen as a sync destination. */
export function leveSyncAvailable(): boolean {
  return builtInServerConfigured() && Platform.OS === "ios";
}
