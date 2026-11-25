import { Platform } from "react-native";
import { syncConfigured } from "./sync-server.ts";

export { syncServerUrl } from "./sync-server.ts";

/** Syncing needs a server and a sign-in, and sign-in is on iOS only for now. */
export function syncEnabled(): boolean {
  return syncConfigured() && Platform.OS === "ios";
}
