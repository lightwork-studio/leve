// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { Authenticator } from "@leve/sync/server";
import { ACCOUNT_ID, inTime, verifiedJwt } from "./session-token.ts";

/**
 * Checks an OAuth access token that Clerk, as the authorization server, issued to an MCP client.
 * Clerk signs them as JWTs (RFC 9068) with the instance's key, so they are checked without a
 * network call, like session tokens. They are told apart by their type: an access token is
 * `at+jwt`, a session token plain `JWT`, so neither passes the other's check.
 */

export interface AccessTokenConfig {
  /** The Clerk instance's Frontend API URL, which is also its OAuth issuer. */
  issuer: string;
  /** The instance's public key (PEM). */
  publicKeyPem: string;
  /** This MCP server's canonical URL. A token is only good here if its audience names it. */
  resource: string;
}

export interface AccessToken {
  account: string;
  clientId: string;
  scopes: string[];
}

const ACCESS_TOKEN_TYPES = ["at+jwt", "application/at+jwt"];

/** Scopes as Clerk writes them: a `scp` list, or a space-separated `scope` string. */
function scopesOf(claims: Record<string, unknown>): string[] | null {
  if (claims.scp !== undefined) {
    if (!Array.isArray(claims.scp) || !claims.scp.every((s) => typeof s === "string")) return null;
    return [...claims.scp];
  }
  if (claims.scope !== undefined) {
    if (typeof claims.scope !== "string") return null;
    return claims.scope.split(" ").filter(Boolean);
  }
  return [];
}

/**
 * The account, client and scopes of a still valid access token issued for this server, or null.
 * Throws when the configured key can't be used. `now` is in milliseconds.
 */
export async function verifyAccessToken(
  token: string,
  config: AccessTokenConfig,
  now = Date.now(),
): Promise<AccessToken | null> {
  const verified = await verifiedJwt(token, config.publicKeyPem, (typ) =>
    ACCESS_TOKEN_TYPES.includes(String(typ).toLowerCase()),
  );
  if (!verified) return null;
  const { claims } = verified;
  if (claims.iss !== config.issuer) return null;
  if (!inTime(claims, now)) return null;
  // Issued for this server (RFC 8707): a token for another resource of the same instance, or one
  // without an audience, is refused.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.resource)) return null;
  if (typeof claims.sub !== "string" || !ACCOUNT_ID.test(claims.sub)) return null;
  if (typeof claims.client_id !== "string" || claims.client_id === "") return null;
  const scopes = scopesOf(claims);
  if (!scopes) return null;
  return { account: claims.sub, clientId: claims.client_id, scopes };
}

/**
 * MCP clients signing in through Clerk's OAuth server: a good access token is an agent acting for
 * its user, with the scopes the user granted.
 */
export function clerkAgents(config: AccessTokenConfig): Authenticator {
  return async (token) => {
    const access = await verifyAccessToken(token, config);
    if (!access) return { refused: true };
    return {
      principal: {
        account: access.account,
        client: { kind: "agent", id: access.clientId },
        scopes: access.scopes,
      },
    };
  };
}
