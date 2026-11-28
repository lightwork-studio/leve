// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

/*
 * The parts of deleting an account that live outside the account's own storage: the Clerk user it
 * signs in as, and the Sign in with Apple grant behind that user. Apple expects apps to revoke the
 * grant when an account is deleted. Clerk can't do it for Leve: its native Apple sign-in only ever
 * sees Apple's identity token, never the authorization code a revocation needs. So the phone asks
 * Apple for a fresh code when the person deletes their account, and the Worker trades it for a
 * token and revokes that.
 */

export const CLERK_API = "https://api.clerk.com/v1";
export const APPLE_AUTH = "https://appleid.apple.com/auth";

/** What deleting an account needs from the Worker's secrets. */
export interface DeletionConfig {
  /** The Clerk instance's secret key (`sk_…`), for its Backend API. */
  clerkSecretKey: string;
  /** The Apple developer team that owns the app. */
  appleTeamId: string;
  /** The id of the Sign in with Apple key. */
  appleKeyId: string;
  /** That key's private part (the `.p8` file: a PKCS #8 PEM). */
  applePrivateKey: string;
  /**
   * The bundle ids of the apps that may delete accounts here, which Apple issues authorization
   * codes to (one Worker can serve several builds, such as Leve Dev and Leve Preview).
   */
  appleClientIds: string[];
}

export interface DeletionEnv {
  CLERK_SECRET_KEY?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  APPLE_CLIENT_ID?: string;
}

/** The configuration for deleting accounts, or null while any of it is missing. */
export function deletionConfig(env: DeletionEnv): DeletionConfig | null {
  const config = {
    clerkSecretKey: env.CLERK_SECRET_KEY?.trim() ?? "",
    appleTeamId: env.APPLE_TEAM_ID?.trim() ?? "",
    appleKeyId: env.APPLE_KEY_ID?.trim() ?? "",
    applePrivateKey: env.APPLE_PRIVATE_KEY?.trim() ?? "",
  };
  const appleClientIds = (env.APPLE_CLIENT_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!Object.values(config).every(Boolean) || appleClientIds.length === 0) return null;
  return { ...config, appleClientIds };
}

/**
 * Which step of `POST /account/delete` failed, in its failure answers. Before the data is deleted:
 * `configuration` (the Worker lacks a secret or can't use its keys), `apple` (Apple didn't
 * accept the authorization code: used, expired, another app's or another Apple ID's; sign in with
 * Apple again), `unavailable` (Apple or Clerk couldn't be reached; try again). After it:
 * `sign_in` (the data is deleted, but revoking Apple's grant or deleting the Clerk user didn't
 * finish; trying again finishes it).
 */
export type DeletionStep = "configuration" | "apple" | "unavailable" | "sign_in";

/** Why a deletion didn't finish, and at which step (see DeletionStep). */
export class DeletionError extends Error {
  override name = "DeletionError";
  readonly step: DeletionStep;
  constructor(step: DeletionStep, message: string) {
    super(message);
    this.step = step;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DeletionOptions {
  fetch?: Fetch;
  /** In milliseconds. */
  now?: () => number;
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

function decodeJsonPart(part: string | undefined): Record<string, unknown> | null {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const value: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The client secret Apple's REST API wants from a native app: a short-lived ES256 JWT signed with
 * the Sign in with Apple key, naming the team, the key and the app.
 */
export async function appleClientSecret(
  config: DeletionConfig,
  clientId: string,
  now = Date.now(),
): Promise<string> {
  const der = Uint8Array.from(
    atob(config.applePrivateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s|\\n/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const issued = Math.floor(now / 1000);
  const body = `${encodeJson({ alg: "ES256", kid: config.appleKeyId })}.${encodeJson({
    iss: config.appleTeamId,
    iat: issued,
    exp: issued + 300,
    aud: "https://appleid.apple.com",
    sub: clientId,
  })}`;
  // Web Crypto signs ECDSA as r and s side by side, which is the form JWS uses.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(body),
    ),
  );
  return `${body}.${base64Url(signature)}`;
}

interface ClerkExternalAccount {
  provider?: unknown;
  provider_user_id?: unknown;
}

/** What the phone sends from the Apple sheet: a fresh authorization code, and which app asked. */
export interface AppleConfirmation {
  code: string;
  /** The bundle id of the app that got the code; one of the configured ones. */
  clientId: string | null;
}

/**
 * Deletes the account: checks with Apple that the person asking signs in with the account's Apple
 * ID, then deletes the account's data (`eraseData`), revokes the Sign in with Apple grant and
 * deletes the Clerk user, in that order. A failure before the data goes deletes nothing. Every step
 * can run again, so trying again (with a new code) after any failure finishes it. A user Clerk no
 * longer has counts as deleted only when `erasedBefore` says an earlier attempt already deleted
 * the data; otherwise it means the Worker's Clerk key is for another instance. Throws a
 * DeletionError naming the step that failed.
 */
export async function deleteAccount(
  config: DeletionConfig,
  account: string,
  apple: AppleConfirmation | null,
  erasedBefore: boolean,
  eraseData: () => Promise<void>,
  options: DeletionOptions = {},
): Promise<void> {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let erased = false;
  const unavailable = (what: string, response?: Response) =>
    new DeletionError(
      erased ? "sign_in" : "unavailable",
      `${what}${response ? ` (HTTP ${response.status})` : ""}`,
    );
  const clerk = (method: string) =>
    fetchFn(`${CLERK_API}/users/${encodeURIComponent(account)}`, {
      method,
      headers: { authorization: `Bearer ${config.clerkSecretKey}` },
    });
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  const found = await clerk("GET").catch(() => null);
  if (!found) throw unavailable("Clerk can't be reached");
  if (found.status === 404) {
    // An earlier attempt got this far, after deleting the data: make sure it is all gone.
    if (erasedBefore) {
      await eraseData();
      return;
    }
    throw new DeletionError("configuration", "Clerk doesn't know the user: check CLERK_SECRET_KEY");
  }
  if (found.status === 401 || found.status === 403) {
    throw new DeletionError("configuration", `Clerk refused the secret key (HTTP ${found.status})`);
  }
  if (!found.ok) throw unavailable("Clerk refused to read the user", found);
  const user = (await found.json().catch(() => null)) as {
    external_accounts?: ClerkExternalAccount[];
  } | null;
  if (!user) throw unavailable("Clerk sent an unreadable user");
  // The Backend API names providers `oauth_apple`; the Frontend API, plain `apple`.
  const appleAccount = (user.external_accounts ?? []).find(
    (external) => external.provider === "oauth_apple" || external.provider === "apple",
  );

  // The app signs in with Apple only, so a code without an Apple account on the user means the
  // Worker reads Clerk wrongly: fail before deleting rather than skip the check.
  if (apple && !appleAccount) {
    throw new DeletionError("configuration", "Clerk shows no Apple account for the user");
  }
  // Before anything is deleted: Apple confirms the code is for the account's own Apple ID.
  let revocation: { clientId: string; secret: string; token: string; hint: string } | null = null;
  if (appleAccount) {
    if (!apple) throw new DeletionError("apple", "sign in with Apple again to delete");
    const clientId =
      apple.clientId ?? (config.appleClientIds.length === 1 ? config.appleClientIds[0] : null);
    if (!clientId || !config.appleClientIds.includes(clientId)) {
      throw new DeletionError("apple", "the code is for an app this server doesn't know");
    }
    let secret: string;
    try {
      secret = await appleClientSecret(config, clientId, now());
    } catch {
      throw new DeletionError("configuration", "APPLE_PRIVATE_KEY can't be used");
    }
    const exchanged = await fetchFn(
      `${APPLE_AUTH}/token`,
      form({
        client_id: clientId,
        client_secret: secret,
        code: apple.code,
        grant_type: "authorization_code",
      }),
    ).catch(() => null);
    if (!exchanged) throw unavailable("Apple can't be reached");
    const tokens = (await exchanged.json().catch(() => null)) as {
      error?: unknown;
      refresh_token?: unknown;
      access_token?: unknown;
      id_token?: unknown;
    } | null;
    if (!exchanged.ok) {
      // A used, expired or foreign code: the person can sign in with Apple again. A wrong key,
      // team or client id is the operator's to fix.
      if (
        exchanged.status === 400 &&
        (tokens?.error === "invalid_grant" || tokens?.error === "invalid_request")
      ) {
        throw new DeletionError("apple", "Apple didn't accept the authorization code");
      }
      if (exchanged.status === 400 || exchanged.status === 401) {
        throw new DeletionError(
          "configuration",
          `Apple refused the client (HTTP ${exchanged.status})`,
        );
      }
      throw unavailable("Apple refused the token request", exchanged);
    }
    // Straight from Apple over TLS, so its claims can be read without checking its signature.
    const identity =
      typeof tokens?.id_token === "string" ? decodeJsonPart(tokens.id_token.split(".")[1]) : null;
    if (
      typeof identity?.sub !== "string" ||
      typeof appleAccount.provider_user_id !== "string" ||
      identity.sub !== appleAccount.provider_user_id
    ) {
      throw new DeletionError("apple", "the authorization code is for another Apple ID");
    }
    const [token, hint] =
      typeof tokens?.refresh_token === "string"
        ? [tokens.refresh_token, "refresh_token"]
        : typeof tokens?.access_token === "string"
          ? [tokens.access_token, "access_token"]
          : [null, null];
    if (!token || !hint) throw unavailable("Apple sent no token to revoke");
    revocation = { clientId, secret, token, hint };
  }

  await eraseData();
  erased = true;

  if (revocation) {
    const revoked = await fetchFn(
      `${APPLE_AUTH}/revoke`,
      form({
        client_id: revocation.clientId,
        client_secret: revocation.secret,
        token: revocation.token,
        token_type_hint: revocation.hint,
      }),
    ).catch(() => null);
    if (!revoked) throw unavailable("Apple can't be reached");
    if (!revoked.ok) throw unavailable("Apple refused to revoke the token", revoked);
  }

  const deleted = await clerk("DELETE").catch(() => null);
  if (!deleted) throw unavailable("Clerk can't be reached");
  if (!deleted.ok && deleted.status !== 404) {
    throw unavailable("Clerk refused to delete the user", deleted);
  }
}
