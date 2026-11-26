import { channel } from "expo-updates";
import { clerkPublishableKey } from "../account/clerk-key.ts";
import { ownServer } from "./own-server-store.ts";

/**
 * The sync server this build uses, from `EXPO_PUBLIC_SYNC_URL`. Builds without it sync only with a
 * server the person paired themselves (see own-server.ts): the App Store build for now has neither,
 * nor do browsers. Trailing slashes are dropped: the phone's data is tied to this exact string, and
 * the same server written another way would count as another server.
 */
export const syncServerUrl = (process.env.EXPO_PUBLIC_SYNC_URL ?? "").trim().replace(/\/+$/, "");

/** Whether the build has its own server and a sign-in for it. */
export function builtInServerConfigured(): boolean {
  return !!syncServerUrl && !!clerkPublishableKey;
}

/**
 * Whether the person may pair the phone with a server they run. TestFlight (the "preview" update
 * channel) and development builds only, until Leve keeps real data. A build with no channel counts
 * as development unless it calls itself the App Store build, so a store build that lost its channel
 * still doesn't offer it.
 */
export const ownServerOffered =
  channel === "preview" || (!channel && process.env.EXPO_PUBLIC_BUILD_LABEL !== "App Store");

/**
 * Whether this build could ever sync: it has a server of its own, or it lets the person pair one
 * (on iOS, known at build time from `EXPO_OS`). Such a build never seeds made-up data, which
 * would otherwise go up to the account once it syncs.
 */
export function mayEverSync(): boolean {
  return builtInServerConfigured() || (ownServerOffered && process.env.EXPO_OS === "ios");
}

/**
 * Whether the phone has a server to sync with: the build's own, or one the person paired. Apart
 * from `syncEnabled` (sync-config.ts) so the data layer can ask without loading React Native; it
 * reads the keychain and the update channel, both native modules with stand-ins in tests.
 */
export function syncConfigured(): boolean {
  return builtInServerConfigured() || (ownServerOffered && ownServer() !== null);
}
