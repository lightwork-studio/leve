// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthOutcome } from "@leve/sync/server";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * BENCHMARK ONLY: one shared token and an account header stand in for real sign-in, so the
 * Cloudflare load script runs against this server too. Anyone with the token reaches every
 * account. The server starts it only with LEVE_AUTH=benchmark.
 */
export function sharedTokenAuth(token: string): (request: IncomingMessage) => AuthOutcome {
  const expected = Buffer.from(token);
  if (expected.length < 32) throw new Error("the token must be long and random");
  return (request) => {
    const given = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { refused: true };
    }
    const account = request.headers["x-leve-account"];
    if (typeof account !== "string" || !ACCOUNT_ID.test(account)) return { refused: true };
    return { principal: { account, client: { kind: "device", id: "benchmark" } } };
  };
}
