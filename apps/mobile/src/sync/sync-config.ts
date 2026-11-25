import { Platform } from "react-native";
import { clerkPublishableKey } from "../account/clerk-key.ts";

/**
 * The sync server this build uses, from `EXPO_PUBLIC_SYNC_URL`. Builds without it never sync: the
 * App Store build for now, local development without the variable, and browsers. Trailing slashes
 * are dropped: the phone's data is tied to this exact string, and the same server written another
 * way would count as another server.
 */
export const syncServerUrl = (process.env.EXPO_PUBLIC_SYNC_URL ?? "").trim().replace(/\/+$/, "");

/** Syncing needs a server and a sign-in, and sign-in is on iOS only for now. */
export function syncEnabled(): boolean {
  return !!syncServerUrl && !!clerkPublishableKey && Platform.OS === "ios";
}
