// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage, RequestListener } from "node:http";
import { MAX_REQUEST_BYTES } from "@leve/contract";
import { WRITTEN_REVISIONS_HEADER } from "../transport.ts";
import { errorReply, type Reply, type SyncService } from "./service.ts";

const MAX_BODY_BYTES = MAX_REQUEST_BYTES;

export interface SyncHttpOptions {
  service: SyncService;
  /**
   * Returns the account a request belongs to, or null to reject it. Real authentication is not
   * part of the sync layer; this is the seam it plugs into.
   */
  authenticate(request: IncomingMessage): string | null | Promise<string | null>;
  /** Told about every unexpected failure, which the client only sees as `unavailable`. */
  onError?: (error: unknown, request: IncomingMessage) => void | Promise<void>;
}

const ROUTES = {
  "/sync/hello": "hello",
  "/sync/push": "push",
  "/sync/pull": "pull",
} as const;

const TOO_LARGE = "request body too large";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Keep reading without keeping it, so the client gets the answer instead of a reset.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new Error(TOO_LARGE);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The sync HTTP endpoints. It only parses, authenticates and routes; the service decides. */
export function createSyncHttpHandler(options: SyncHttpOptions): RequestListener {
  return async (request, response) => {
    const send = (reply: Reply<unknown>) => {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.writtenRevisions
          ? {
              [WRITTEN_REVISIONS_HEADER]: reply.writtenRevisions,
              "access-control-expose-headers": WRITTEN_REVISIONS_HEADER,
            }
          : {}),
      });
      response.end(JSON.stringify(reply.body));
    };
    try {
      const path = (request.url ?? "").split("?")[0] as keyof typeof ROUTES;
      const route = ROUTES[path];
      if (!route || request.method !== "POST") {
        send(errorReply("invalid_request", "unknown endpoint"));
        return;
      }
      const accountId = await options.authenticate(request);
      if (!accountId) {
        send(errorReply("unauthorized", "sign in again"));
        return;
      }
      // JSON only: a cross-site form can't send it without the browser asking first.
      const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        send(errorReply("invalid_request", "send application/json"));
        return;
      }
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        send(errorReply("invalid_request", (error as Error).message.slice(0, 200)));
        return;
      }
      send(await options.service[route](accountId, body));
    } catch (error) {
      if ((error as Error)?.name === "AccountIdError") {
        send(errorReply("unauthorized", "sign in again"));
        return;
      }
      // Never leak internal errors; the account's data stays as the failed transaction left it.
      // A failing hook, even an async one, must not keep the client from getting its answer.
      Promise.resolve()
        .then(() => options.onError?.(error, request))
        .catch(() => {});
      send(errorReply("unavailable", "sync is temporarily unavailable"));
    }
  };
}
