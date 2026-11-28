import { signInAsync } from "expo-apple-authentication";

/*
 * Deleting the signed-in Leve account. The build's sync server deletes the account's synced data,
 * revokes its Sign in with Apple grant and deletes the sign-in itself. The phone keeps its workouts
 * as data that never synced. Apple only lets a server revoke a grant with a fresh authorization
 * code, so deleting starts with the Apple sheet. The server checks with Apple that the code is for
 * the account's own Apple ID before it deletes anything.
 */

/**
 * Something to tell the person, when deleting the account didn't work, and what the server had
 * deleted by then: nothing, the account's synced data (the sign-in is left), or it can't be told.
 */
export class DeletionProblem extends Error {
  readonly deleted: "nothing" | "data" | "unknown";
  constructor(message: string, deleted: "nothing" | "data" | "unknown" = "nothing") {
    super(message);
    this.deleted = deleted;
  }
}

export const DELETION_FAILED =
  "Leve couldn't delete your account. Check the connection and try again.";
const UNFINISHED =
  "Your synced workouts are deleted from the server, but deleting your account didn't finish. Try again to finish it.";
const OTHER_APPLE_ID =
  "Apple didn't confirm this account. Try again with the Apple ID you use for Leve.";
const APPLE_FAILED = "Apple couldn't confirm it's you. Try again.";
const NOT_AVAILABLE = "Deleting accounts isn't available right now. Try again later.";
const SIGN_IN_AGAIN = "Sign in again, then delete your account.";

/** What the Apple sheet gave for a deletion: a fresh code, and the app it was issued to. */
export interface AppleConfirmation {
  code: string;
  /** The bundle id (the identity token's audience), which the server redeems the code as. */
  clientId: string | null;
}

/** The audience of Apple's identity token: the bundle id of the app that asked. */
function audience(identityToken: string | null): string | null {
  try {
    const part = identityToken?.split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))) as {
      aud?: unknown;
    };
    return typeof claims.aud === "string" ? claims.aud : null;
  } catch {
    return null;
  }
}

/**
 * A fresh authorization code from the Apple sheet, or null when the person dismissed it. The server
 * revokes the grant it belongs to.
 */
export async function appleConfirmation(): Promise<AppleConfirmation | null> {
  try {
    const { authorizationCode, identityToken } = await signInAsync({ requestedScopes: [] });
    if (!authorizationCode) throw new DeletionProblem(DELETION_FAILED);
    return { code: authorizationCode, clientId: audience(identityToken) };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_REQUEST_CANCELED") return null;
    if (error instanceof DeletionProblem) throw error;
    throw new DeletionProblem(APPLE_FAILED);
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * Asks the server to delete the account. Resolves once everything is deleted; throws a
 * DeletionProblem otherwise, also when there was no answer.
 */
export async function requestAccountDeletion({
  server,
  token,
  apple,
  fetch: fetchFn = (url, init) => fetch(url, init),
}: {
  server: string;
  token: string;
  apple: AppleConfirmation;
  fetch?: Fetch;
}): Promise<void> {
  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetchFn(`${server}/account/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // Apple issues the code to this build's bundle id; the server needs it to redeem the code.
      body: JSON.stringify({
        appleAuthorizationCode: apple.code,
        ...(apple.clientId ? { appleClientId: apple.clientId } : {}),
      }),
    });
  } catch {
    // The request may have arrived: sync finds out (see accountBeingDeleted).
    throw new DeletionProblem(DELETION_FAILED, "unknown");
  }
  if (response.status === 200) return;
  if (response.status === 401) throw new DeletionProblem(SIGN_IN_AGAIN);
  // Which step failed: only `sign_in` comes after the server deleted the synced data.
  const body = (await response.json().catch(() => null)) as { step?: unknown } | null;
  switch (body?.step) {
    case "configuration":
      throw new DeletionProblem(NOT_AVAILABLE);
    case "apple":
      throw new DeletionProblem(OTHER_APPLE_ID);
    case "unavailable":
      throw new DeletionProblem(DELETION_FAILED);
    case "sign_in":
      throw new DeletionProblem(UNFINISHED, "data");
    default:
      // Say a server error partway through: whether anything was deleted is for sync to find out.
      throw new DeletionProblem(DELETION_FAILED, "unknown");
  }
}

/* While the app runs: accounts being deleted, or deleted, from this phone. Neither syncs, even
   while Clerk still lists its session (signing out after a deletion can fail offline). */

const states = new Map<string, "deleting" | "deleted">();
const listeners = new Set<() => void>();

export function accountDeletionState(account: string | null): "deleting" | "deleted" | null {
  return account === null ? null : (states.get(account) ?? null);
}

export function setAccountDeletionState(
  account: string,
  state: "deleting" | "deleted" | null,
): void {
  if (state === null) states.delete(account);
  else states.set(account, state);
  for (const listener of [...listeners]) listener();
}

export function subscribeAccountDeletion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests. */
export function forgetAccountDeletionStates(): void {
  states.clear();
}
