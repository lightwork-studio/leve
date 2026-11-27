import type { PairingLink } from "./own-server.ts";

/** Browser previews have neither account sign-in nor sync. */
export function SyncServerSection(_props: { link?: PairingLink | null }) {
  return null;
}
