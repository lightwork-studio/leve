// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServerStorage } from "@leve/storage/server";
import { type AuthOutcome, createSyncHttpHandler, SyncService } from "@leve/sync/server";
import type { Accounts } from "./accounts.ts";
import { CONNECT_PAGE, CONNECT_PAGE_CSP } from "./connect-page.ts";

export interface SyncServerOptions {
  storage: ServerStorage;
  authenticate(request: IncomingMessage): AuthOutcome | Promise<AuthOutcome>;
  /** The server's accounts: phones pair with them at /auth/pair. Absent for the benchmark. */
  accounts?: Accounts;
  /** Pairing turned off: phones already paired keep syncing, new ones can't pair. */
  pairingOff?: boolean;
  /**
   * BENCHMARK ONLY: a stats route on the public listener and a server-side timing header, for
   * the Cloudflare load script.
   */
  benchmark?: boolean;
  onError?: (error: unknown) => void;
}

/**
 * A pairing request is tiny. Pairing codes have 128 random bits, so guessing one needs no rate
 * limit, and a limit shared by all clients would let anyone keep every new phone from pairing.
 */
const MAX_PAIR_BODY = 4096;

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};
const failure = (response: ServerResponse, status: number, code: string, message: string) =>
  json(response, status, { error: { code, message } });

/** Reads a small JSON body, giving up as soon as it is larger than `limit`. */
async function readSmallJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Error("too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * The public listener: the sync endpoints, pairing for new phones and the page a pairing link
 * opens. Administration is never served here; it has its own socket (admin.ts).
 */
export function createSyncServer(options: SyncServerOptions): Server {
  const { storage, authenticate, accounts } = options;
  const onError = options.onError ?? ((error) => console.error("request failed", error));
  const sync = createSyncHttpHandler({
    service: new SyncService({ storage }),
    authenticate,
    onError,
  });

  const pair = async (request: IncomingMessage, response: ServerResponse) => {
    if (!accounts) return failure(response, 400, "invalid_request", "unknown endpoint");
    if (options.pairingOff) {
      request.resume();
      return failure(response, 403, "pairing_off", "This server doesn't pair new phones now.");
    }
    const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      request.resume();
      return failure(response, 400, "invalid_request", "send application/json");
    }
    let body: unknown;
    try {
      body = await readSmallJson(request, MAX_PAIR_BODY);
    } catch {
      // Unread bytes may follow; the connection closes after the answer.
      response.setHeader("connection", "close");
      return failure(response, 400, "invalid_request", "send {code, device}");
    }
    const { code, device } = (body ?? {}) as { code?: unknown; device?: unknown };
    if (typeof code !== "string" || (device !== undefined && typeof device !== "string")) {
      return failure(response, 400, "invalid_request", "send {code, device}");
    }
    const paired = accounts.pair(code, device ?? "");
    if (!paired) {
      return failure(response, 401, "unauthorized", "This code doesn't work. Ask for a new one.");
    }
    return json(response, 200, paired);
  };

  return createServer((request, response) => {
    if (options.benchmark) {
      const started = performance.now();
      // Time spent handling the request, for comparison with the Worker's timing header.
      // Waiting for the single thread before the request event is not included.
      const writeHead = response.writeHead.bind(response);
      response.writeHead = ((status: number, ...rest: unknown[]) => {
        response.setHeader("x-server-ms", String(Math.round(performance.now() - started)));
        return (writeHead as (...args: unknown[]) => typeof response)(status, ...rest);
      }) as typeof response.writeHead;
    }
    const path = (request.url ?? "").split(/[?#]/)[0];

    if (path === "/auth/pair" && request.method === "POST") {
      pair(request, response).catch((error) => {
        onError(error);
        if (!response.headersSent) failure(response, 503, "unavailable", "try again later");
      });
      return;
    }
    if (path === "/connect" && request.method === "GET" && accounts) {
      request.resume();
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CONNECT_PAGE_CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      response.end(CONNECT_PAGE);
      return;
    }
    if (options.benchmark && path === "/admin/stats" && request.method === "POST") {
      benchmarkStats(request, response);
      return;
    }
    sync(request, response);
  });

  function benchmarkStats(request: IncomingMessage, response: ServerResponse) {
    request.resume();
    Promise.resolve(authenticate(request))
      .then((outcome) => {
        if (!("principal" in outcome)) {
          response.writeHead(401).end();
          return;
        }
        // A failure here (a full disk, a damaged database) must answer, not take the server down.
        return storage.account(outcome.principal.account).then((store) => {
          const count = (sql: string) => Number(store.db.get(sql)?.n ?? 0);
          json(response, 200, {
            revision: store.headRevision(),
            records: count("SELECT count(*) AS n FROM records"),
            receipts: count("SELECT count(*) AS n FROM receipts"),
            contentBytes: count("SELECT coalesce(sum(length(content)), 0) AS n FROM records"),
            databaseBytes: count(
              "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
            ),
          });
        });
      })
      .catch((error) => {
        onError(error);
        response.writeHead(503).end();
      });
  }
}
