// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { errorReply } from "@leve/sync/server";
import { verifySessionToken } from "./session-token.ts";

/** Names the account inside the Worker. Set by the gate, never taken from the client. */
export const ACCOUNT_HEADER = "x-leve-account";
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
}

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
  if (request.method !== "POST") return reply(400, errorReply("invalid_request", "use POST").body);
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";

  let account: string;
  if (url.pathname.startsWith("/sync/")) {
    if (!env.CLERK_ISSUER || !env.CLERK_JWT_KEY) {
      console.error("sign-in is not configured: set CLERK_ISSUER and CLERK_JWT_KEY");
      return reply(503, errorReply("unavailable", "sync is temporarily unavailable").body);
    }
    let session: { account: string } | null;
    try {
      session = await verifySessionToken(bearer, {
        issuer: env.CLERK_ISSUER,
        publicKeyPem: env.CLERK_JWT_KEY,
        authorizedParties: (env.CLERK_AUTHORIZED_PARTIES ?? "")
          .split(",")
          .map((party) => party.trim())
          .filter(Boolean),
      });
    } catch (error) {
      // A broken key would otherwise send every client back to sign in, again and again.
      console.error("CLERK_JWT_KEY can't be used", error);
      return reply(503, errorReply("unavailable", "sync is temporarily unavailable").body);
    }
    if (!session) return unauthorized();
    account = session.account;
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return reply(400, errorReply("invalid_request", "send application/json").body);
    }
  } else if (url.pathname.startsWith("/admin/")) {
    const operator = env.ADMIN_TOKEN ?? "";
    if (operator.length < 32 || !sameSecret(bearer, operator)) return unauthorized();
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

  // The object learns its account from this header, so it is always the one checked above.
  const forwarded = new Request(request);
  forwarded.headers.set(ACCOUNT_HEADER, account);
  forwarded.headers.delete("authorization");

  const started = Date.now();
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account));
  const response = await stub.fetch(forwarded);
  const timed = new Response(response.body, response);
  timed.headers.set("x-worker-ms", String(Date.now() - started));
  timed.headers.set("x-colo", String((request.cf as { colo?: string } | undefined)?.colo ?? ""));
  return timed;
}
