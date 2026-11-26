// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { allows, authenticateBearer, errorReply, SCOPES } from "@leve/sync/server";
import { clerkAgents } from "./access-token.ts";
import { clerkSessions } from "./session-token.ts";

/** Names the account inside the Worker. Set by the gate, never taken from the client. */
export const ACCOUNT_HEADER = "x-leve-account";
/** For MCP requests: the signed-in client and its scopes. Set by the gate, never taken from the client. */
export const CLIENT_HEADER = "x-leve-client";
export const SCOPES_HEADER = "x-leve-scopes";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the gate needs from the Worker's environment. */
export interface GateEnv {
  ACCOUNTS: Pick<DurableObjectNamespace, "idFromName" | "get">;
  /** The Clerk instance's Frontend API URL. */
  CLERK_ISSUER?: string;
  /** The Clerk instance's PEM public key. */
  CLERK_JWT_KEY?: string;
  /** Comma-separated origins allowed to ask for tokens, for a web client. */
  CLERK_AUTHORIZED_PARTIES?: string;
  /** The operator's token for the admin endpoints, at least 32 characters. Without it they are closed. */
  ADMIN_TOKEN?: string;
  /**
   * This Worker's MCP endpoint as clients reach it, e.g. `https://leve-sync.example.workers.dev/mcp`.
   * Access tokens must name it as their audience. Without it MCP is off.
   */
  MCP_RESOURCE_URL?: string;
  /** Only the string "true" enables MCP writes. */
  MCP_WRITES_ENABLED?: string;
}

/** Where MCP lives, and where its protected-resource metadata (RFC 9728) is published. */
export const MCP_PATH = "/mcp";
const METADATA_PATH = "/.well-known/oauth-protected-resource";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = () => reply(401, errorReply("unauthorized", "sign in again").body);

/** Constant-time comparison, so a secret can't be guessed byte by byte from response times. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) difference |= (a[i] ?? 0) ^ (b[i] as number);
  return difference === 0;
}

/**
 * Decides which account a request may touch and hands it to that account's Durable Object.
 *
 * - `/sync/*` needs a Clerk session token; the account is the signed-in user, so a user can only
 *   ever reach their own account.
 * - `/admin/*` needs the operator's token and names the account in `x-leve-account`.
 */
export async function handleRequest(request: Request, env: GateEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === METADATA_PATH || url.pathname === `${METADATA_PATH}${MCP_PATH}`) {
    return protectedResourceMetadata(request, env);
  }
  if (url.pathname === MCP_PATH) return handleMcp(request, env);
  if (request.method !== "POST") return reply(400, errorReply("invalid_request", "use POST").body);
  const authorization = request.headers.get("authorization");

  let account: string;
  if (url.pathname.startsWith("/sync/")) {
    if (!env.CLERK_ISSUER || !env.CLERK_JWT_KEY) {
      console.error("sign-in is not configured: set CLERK_ISSUER and CLERK_JWT_KEY");
      return reply(503, errorReply("unavailable", "sync is temporarily unavailable").body);
    }
    const sessions = clerkSessions({
      issuer: env.CLERK_ISSUER,
      publicKeyPem: env.CLERK_JWT_KEY,
      authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
        .split(",")
        .map((party) => party.trim())
        .filter(Boolean),
    });
    // A broken key would otherwise send every client back to sign in, again and again.
    const outcome = await authenticateBearer(sessions, authorization, (error) =>
      console.error("CLERK_JWT_KEY can't be used", error),
    );
    if ("unavailable" in outcome) {
      return reply(503, errorReply("unavailable", "sync is temporarily unavailable").body);
    }
    // Only the lifter's own devices sync; agents get their own, scoped endpoints.
    if ("refused" in outcome || outcome.principal.client.kind !== "device") return unauthorized();
    account = outcome.principal.account;
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return reply(400, errorReply("invalid_request", "send application/json").body);
    }
  } else if (url.pathname.startsWith("/admin/")) {
    const operator = env.ADMIN_TOKEN ?? "";
    // Any characters, as before: the operator chose the token.
    const given = authorization?.match(/^Bearer (.+)$/i)?.[1] ?? "";
    if (operator.length < 32 || !sameSecret(given, operator)) return unauthorized();
    account = request.headers.get(ACCOUNT_HEADER) ?? "";
    if (!ACCOUNT_ID.test(account)) {
      return reply(
        400,
        errorReply("invalid_request", `name the account in ${ACCOUNT_HEADER}`).body,
      );
    }
  } else {
    return reply(400, errorReply("invalid_request", "unknown endpoint").body);
  }

  return forward(request, env, account);
}

/**
 * Hands the request to the account's object. The object learns its account (and, for MCP, the
 * client and its scopes) from headers set here, so they are always the ones checked above: any
 * `x-leve-*` header the client sent is dropped first.
 */
async function forward(
  request: Request,
  env: GateEnv,
  account: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  const forwarded = new Request(request);
  for (const name of [...forwarded.headers.keys()]) {
    if (name.toLowerCase().startsWith("x-leve-")) forwarded.headers.delete(name);
  }
  forwarded.headers.set(ACCOUNT_HEADER, account);
  for (const [name, value] of Object.entries(extra)) forwarded.headers.set(name, value);
  forwarded.headers.delete("authorization");

  const started = Date.now();
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account));
  const response = await stub.fetch(forwarded);
  const timed = new Response(response.body, response);
  timed.headers.set("x-worker-ms", String(Date.now() - started));
  timed.headers.set("x-colo", String((request.cf as { colo?: string } | undefined)?.colo ?? ""));
  return timed;
}

/** The MCP resource, when MCP is configured: its canonical URL and where its metadata is. */
export function mcpResource(env: GateEnv): { resource: string; metadata: string } | null {
  if (!env.CLERK_ISSUER || !env.CLERK_JWT_KEY || !env.MCP_RESOURCE_URL) return null;
  let url: URL;
  try {
    url = new URL(env.MCP_RESOURCE_URL);
  } catch {
    console.error("MCP_RESOURCE_URL isn't a URL");
    return null;
  }
  if (url.protocol !== "https:" || url.href !== `${url.origin}${MCP_PATH}`) {
    console.error(`MCP_RESOURCE_URL must be an https URL ending in ${MCP_PATH}`);
    return null;
  }
  return {
    resource: env.MCP_RESOURCE_URL,
    metadata: `${url.origin}${METADATA_PATH}${MCP_PATH}`,
  };
}

const mcpUnavailable = () =>
  reply(503, errorReply("unavailable", "MCP is not available on this server").body);

/** RFC 9728: tells MCP clients which authorization server to sign in with, and which scopes exist. */
function protectedResourceMetadata(request: Request, env: GateEnv): Response {
  if (request.method !== "GET") return reply(405, errorReply("invalid_request", "use GET").body);
  const mcp = mcpResource(env);
  if (!mcp) return mcpUnavailable();
  return new Response(
    JSON.stringify({
      resource: mcp.resource,
      authorization_servers: [env.CLERK_ISSUER],
      scopes_supported:
        env.MCP_WRITES_ENABLED === "true" ? [SCOPES.read, SCOPES.write] : [SCOPES.read],
      bearer_methods_supported: ["header"],
      resource_name: "Leve",
    }),
    {
      headers: {
        "content-type": "application/json",
        // Public, and browser-based MCP clients read it before signing in.
        "access-control-allow-origin": "*",
        "cache-control": "max-age=300",
      },
    },
  );
}

/**
 * `/mcp` needs an OAuth access token Clerk issued for this server. The account is the token's
 * user, so an MCP client only ever reaches the account of the person who signed it in, and only
 * with the scopes they granted. Phones' session tokens aren't accepted here, nor access tokens
 * at `/sync/*`.
 */
async function handleMcp(request: Request, env: GateEnv): Promise<Response> {
  const mcp = mcpResource(env);
  if (!mcp) return mcpUnavailable();
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(mcp.resource).origin) {
    return reply(403, { error: "invalid_origin" });
  }
  const authorization = request.headers.get("authorization");
  const agents = clerkAgents({
    issuer: env.CLERK_ISSUER as string,
    publicKeyPem: env.CLERK_JWT_KEY as string,
    resource: mcp.resource,
  });
  const outcome = await authenticateBearer(agents, authorization, (error) =>
    console.error("CLERK_JWT_KEY can't be used", error),
  );
  if ("unavailable" in outcome) return mcpUnavailable();
  const challenge = (params: Record<string, string>) =>
    `Bearer ${Object.entries({ ...params, resource_metadata: mcp.metadata })
      .map(([key, value]) => `${key}="${value}"`)
      .join(", ")}`;
  if ("refused" in outcome || outcome.principal.client.kind !== "agent") {
    // RFC 6750: no error code when the request had no token at all.
    const presented = authorization !== null && authorization.trim() !== "";
    const response = reply(401, errorReply("unauthorized", "sign in again").body);
    response.headers.set(
      "www-authenticate",
      challenge(
        presented ? { error: "invalid_token", scope: SCOPES.read } : { scope: SCOPES.read },
      ),
    );
    return response;
  }
  const { principal } = outcome;
  if (!allows(principal, SCOPES.read)) {
    const response = reply(403, { error: "insufficient_scope" });
    response.headers.set(
      "www-authenticate",
      challenge({ error: "insufficient_scope", scope: SCOPES.read }),
    );
    return response;
  }
  return forward(request, env, principal.account, {
    // Encoded: a client id is a URL for metadata-document clients, and headers must stay ASCII.
    [CLIENT_HEADER]: encodeURIComponent(principal.client.id),
    [SCOPES_HEADER]: Object.values(SCOPES)
      .filter((scope) => principal.scopes?.includes(scope))
      .join(" "),
  });
}
