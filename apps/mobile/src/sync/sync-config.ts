import { Platform } from "react-native";
import { ownServerOffered, syncConfigured } from "./sync-server.ts";

export { builtInServerConfigured, syncServerUrl } from "./sync-server.ts";

/** Syncing needs a server and a sign-in, and syncing is on iOS only for now. */
export function syncEnabled(): boolean {
  return syncConfigured() && Platform.OS === "ios";
}

/** Whether Settings offers pairing with a server of the person's own. */
export function ownServerAvailable(): boolean {
  return ownServerOffered && Platform.OS === "ios";
}
