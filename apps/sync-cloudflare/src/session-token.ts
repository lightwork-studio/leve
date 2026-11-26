// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Authenticator } from "@leve/sync/server";

/**
 * Checks a Clerk session token without a network call: the signature against the instance's public
 * key, then who issued it, when it is valid and whose it is. The account is the signed-in user.
 */

export interface SessionKeys {
  /** The Clerk instance's Frontend API URL, which tokens name as their issuer. */
  issuer: string;
  /** The instance's public key, from the dashboard's "PEM public key" or the JWKS endpoint. */
  publicKeyPem: string;
  /** Origins allowed to have asked for the token. Tokens from the native app name none. */
  authorizedParties?: readonly string[];
}

/** Clerk session tokens live 60 seconds; this much clock difference is tolerated either way. */
const LEEWAY_SECONDS = 5;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const keys = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let key = keys.get(pem);
  if (!key) {
    const base64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s|\\n/g, "");
    key = crypto.subtle.importKey(
      "spki",
      bytesFromBase64(base64),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    // A key that fails to import is retried next time rather than remembered.
    key.catch(() => keys.delete(pem));
    keys.set(pem, key);
  }
  return key;
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fromBase64Url(part: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return bytesFromBase64(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}

function jsonPart(part: string): Record<string, unknown> | null {
  const bytes = fromBase64Url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The account a session token signs in, or null when the token isn't a still valid session token
 * this instance issued. Throws when the configured public key can't be used, which is the
 * operator's problem, not the client's. `now` is in milliseconds.
 */
export async function verifySessionToken(
  token: string,
  config: SessionKeys,
  now = Date.now(),
): Promise<{ account: string; session: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const key = await importKey(config.publicKeyPem);
  const header = jsonPart(headerPart);
  // Only the algorithm Clerk signs with: never "none" or a symmetric one keyed by the public key.
  if (header?.alg !== "RS256") return null;
  // Not an access token or another typed JWT, and no extensions this check doesn't understand.
  if (header.typ !== undefined && header.typ !== "JWT") return null;
  if (header.crit !== undefined) return null;
  const signature = fromBase64Url(signaturePart);
  if (!signature) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const claims = jsonPart(payloadPart);
  if (!claims) return null;
  const seconds = now / 1000;
  if (claims.iss !== config.issuer) return null;
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS <= seconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_SECONDS > seconds) return null;
  if (typeof claims.iat === "number" && claims.iat - LEEWAY_SECONDS > seconds) return null;
  // Only session tokens: the instance key also signs JWT templates, which can live for years and
  // are handed to other services. Session tokens name their session and its status; a session
  // with steps still to finish (for example accepting new terms) isn't signed in yet.
  if (typeof claims.sid !== "string" || claims.v !== 2) return null;
  if (claims.sts !== "active") return null;
  if (claims.azp !== undefined) {
    const allowed = config.authorizedParties ?? [];
    if (typeof claims.azp !== "string" || !allowed.includes(claims.azp)) return null;
  }
  if (typeof claims.sub !== "string" || !ACCOUNT_ID.test(claims.sub)) return null;
  return { account: claims.sub, session: claims.sid };
}

/**
 * Phones signing in with Clerk: a good session token is a device of its user. Throws (making the
 * request `unavailable`) when the configured key can't be used.
 */
export function clerkSessions(config: SessionKeys): Authenticator {
  return async (token) => {
    const session = await verifySessionToken(token, config);
    if (!session) return { refused: true };
    return {
      principal: { account: session.account, client: { kind: "device", id: session.session } },
    };
  };
}
