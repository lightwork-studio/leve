import { compareReleases, type ReleaseId } from "./definition.ts";

import { contractThrough, leveContract } from "./leve.ts";

/*
 * Which protocol releases each side of this build speaks. The compatibility tests derive their
 * matrix from these lists, so adding or dropping a release here is an explicit, tested change.
 */

/** Releases the server accepts, oldest first. */
export const SERVER_RELEASES: readonly ReleaseId[] = ["1.0"];

/** Releases the client can speak, oldest first. */
export const CLIENT_RELEASES: readonly ReleaseId[] = ["1.0"];

/** An installed phone can save only the records understood by its own storage release. */
const latestClient = CLIENT_RELEASES[CLIENT_RELEASES.length - 1] as ReleaseId;
export const clientContract =
  latestClient === leveContract.latest ? leveContract : contractThrough(latestClient);

export type Negotiation =
  | { ok: true; release: ReleaseId }
  | { ok: false; update: "client" | "server"; serverReleases: readonly ReleaseId[] };

const isRelease = (value: string): value is ReleaseId => /^\d{1,4}\.\d{1,4}$/.test(value);

/** Picks the highest release both sides speak, or says which side has to update. */
export function negotiate(
  clientReleases: readonly string[],
  serverReleases: readonly ReleaseId[],
): Negotiation {
  const client = clientReleases.filter(isRelease).sort(compareReleases);
  const common = client.filter((release) => serverReleases.includes(release));
  const best = common[common.length - 1];
  if (best) return { ok: true, release: best };
  const clientNewest = client[client.length - 1];
  const serverNewest = serverReleases[serverReleases.length - 1];
  const serverIsBehind =
    clientNewest !== undefined &&
    serverNewest !== undefined &&
    compareReleases(clientNewest, serverNewest) > 0;
  return { ok: false, update: serverIsBehind ? "server" : "client", serverReleases };
}
