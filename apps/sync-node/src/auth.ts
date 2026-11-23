// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * BENCHMARK ONLY: one shared token and an account header stand in for real sign-in. Returns the
 * account a request belongs to, or null.
 */
export function sharedTokenAuth(token: string): (request: IncomingMessage) => string | null {
  const expected = Buffer.from(token);
  if (expected.length < 32) throw new Error("the token must be long and random");
  return (request) => {
    const given = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const account = request.headers["x-leve-account"];
    return typeof account === "string" && ACCOUNT_ID.test(account) ? account : null;
  };
}
