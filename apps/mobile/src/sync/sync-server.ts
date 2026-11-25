import { clerkPublishableKey } from "../account/clerk-key.ts";

/**
 * The sync server this build uses, from `EXPO_PUBLIC_SYNC_URL`. Builds without it never sync: the
 * App Store build for now, local development without the variable, and browsers. Trailing slashes
 * are dropped: the phone's data is tied to this exact string, and the same server written another
 * way would count as another server.
 */
export const syncServerUrl = (process.env.EXPO_PUBLIC_SYNC_URL ?? "").trim().replace(/\/+$/, "");

/**
 * Whether the build has a sync server and a sign-in. Apart from `syncEnabled` (sync-config.ts) so
 * the data layer can ask without loading React Native.
 */
export function syncConfigured(): boolean {
  return !!syncServerUrl && !!clerkPublishableKey;
}
