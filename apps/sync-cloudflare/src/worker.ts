// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { errorReply } from "@leve/sync/server";

export { AccountObject, RestoreMarker } from "./account-object.ts";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Constant-time comparison, so the token can't be guessed byte by byte from response times. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Checks the request and hands it to the account's Durable Object. SPIKE ONLY: one shared token
 * and an account header stand in for real sign-in, which will verify a session token instead.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return reply(400, errorReply("invalid_request", "use POST").body);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!env.SPIKE_TOKEN || !sameSecret(token, env.SPIKE_TOKEN)) {
      return reply(401, errorReply("unauthorized", "sign in again").body);
    }
    const account = request.headers.get("x-leve-account") ?? "";
    if (!ACCOUNT_ID.test(account))
      return reply(401, errorReply("unauthorized", "sign in again").body);
    const isSync = url.pathname.startsWith("/sync/");
    if (isSync) {
      const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        return reply(400, errorReply("invalid_request", "send application/json").body);
      }
    } else if (!url.pathname.startsWith("/admin/")) {
      return reply(400, errorReply("invalid_request", "unknown endpoint").body);
    }
    const started = Date.now();
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account));
    const response = await stub.fetch(request);
    const timed = new Response(response.body, response);
    timed.headers.set("x-worker-ms", String(Date.now() - started));
    timed.headers.set("x-colo", String((request.cf as { colo?: string } | undefined)?.colo ?? ""));
    return timed;
  },
} satisfies ExportedHandler<Env>;
