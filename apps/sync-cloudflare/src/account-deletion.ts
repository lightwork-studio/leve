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
  /** The app's bundle id, which Apple issued the authorization codes to. */
  appleClientId: string;
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
    appleClientId: env.APPLE_CLIENT_ID?.trim() ?? "",
  };
  return Object.values(config).every(Boolean) ? config : null;
}

/**
 * Which step of `POST /account/delete` failed, in its failure answers. `configuration`: the Worker
 * lacks a secret and deleted nothing. `apple`: the data is deleted, but Apple didn't accept the
 * authorization code (used, expired, or another Apple ID's); sign in with Apple again and retry.
 * `sign_in`: the data is deleted, but Apple or Clerk couldn't be reached or refused the Worker's
 * keys; retrying finishes it.
 */
export type DeletionStep = "configuration" | "apple" | "sign_in";

/** Why the sign-in part of a deletion didn't finish. */
export class DeletionError extends Error {
  override name = "DeletionError";
  /**
   * `apple`: Apple didn't accept the authorization code, or it belongs to another Apple ID than the
   * account's; the person can sign in with Apple again and retry. `unavailable`: Apple or Clerk
   * couldn't be reached or refused the Worker's keys; retrying later finishes it.
   */
  readonly reason: "apple" | "unavailable";
  constructor(reason: "apple" | "unavailable", message: string) {
    super(message);
    this.reason = reason;
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
export async function appleClientSecret(config: DeletionConfig, now = Date.now()): Promise<string> {
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
    sub: config.appleClientId,
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

/**
 * Deletes the Clerk user, after revoking its Sign in with Apple grant with `appleCode`, a fresh
 * authorization code the phone got from Apple for the same Apple ID. Run it after the account's
 * data is gone: the user is deleted last, so a retry (with a new code) can still sign in and
 * finish. A user Clerk no longer has counts as deleted.
 */
export async function deleteSignIn(
  config: DeletionConfig,
  account: string,
  appleCode: string | null,
  options: DeletionOptions = {},
): Promise<void> {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const clerk = (method: string) =>
    fetchFn(`${CLERK_API}/users/${encodeURIComponent(account)}`, {
      method,
      headers: { authorization: `Bearer ${config.clerkSecretKey}` },
    });
  const unavailable = (what: string, response?: Response) =>
    new DeletionError("unavailable", `${what}${response ? ` (HTTP ${response.status})` : ""}`);

  const found = await clerk("GET").catch(() => null);
  if (!found) throw unavailable("Clerk can't be reached");
  if (found.status === 404) return;
  if (!found.ok) throw unavailable("Clerk refused to read the user", found);
  const user = (await found.json().catch(() => null)) as {
    external_accounts?: ClerkExternalAccount[];
  } | null;
  if (!user) throw unavailable("Clerk sent an unreadable user");
  // The Backend API names providers `oauth_apple`; the Frontend API, plain `apple`.
  const apple = (user.external_accounts ?? []).find(
    (external) => external.provider === "oauth_apple" || external.provider === "apple",
  );

  if (apple) {
    if (!appleCode) throw new DeletionError("apple", "sign in with Apple again to delete");
    const form = (fields: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    const secret = await appleClientSecret(config, now());
    const exchanged = await fetchFn(
      `${APPLE_AUTH}/token`,
      form({
        client_id: config.appleClientId,
        client_secret: secret,
        code: appleCode,
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
      // A used, expired or foreign code: the person can sign in with Apple again. Anything else
      // (a wrong key, team or client id) is the operator's to fix.
      if (exchanged.status === 400 && tokens?.error === "invalid_grant") {
        throw new DeletionError("apple", "Apple didn't accept the authorization code");
      }
      throw unavailable("Apple refused the token request", exchanged);
    }
    // Straight from Apple over TLS, so its claims can be read without checking its signature.
    const identity =
      typeof tokens?.id_token === "string" ? decodeJsonPart(tokens.id_token.split(".")[1]) : null;
    if (!identity || identity.sub !== apple.provider_user_id) {
      throw new DeletionError("apple", "the authorization code is for another Apple ID");
    }
    const [token, hint] =
      typeof tokens?.refresh_token === "string"
        ? [tokens.refresh_token, "refresh_token"]
        : typeof tokens?.access_token === "string"
          ? [tokens.access_token, "access_token"]
          : [null, null];
    if (!token || !hint) throw unavailable("Apple sent no token to revoke");
    const revoked = await fetchFn(
      `${APPLE_AUTH}/revoke`,
      form({
        client_id: config.appleClientId,
        client_secret: secret,
        token,
        token_type_hint: hint,
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
