// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ServerStorage } from "@leve/storage/server";
import { createSyncHttpHandler, SyncService } from "@leve/sync/server";

export interface SyncServerOptions {
  storage: ServerStorage;
  authenticate(request: IncomingMessage): string | null;
  onError?: (error: unknown) => void;
}

/** The sync endpoints plus a stats route for benchmarks, with a server-side timing header. */
export function createSyncServer(options: SyncServerOptions): Server {
  const { storage, authenticate } = options;
  const onError = options.onError ?? ((error) => console.error("request failed", error));
  const sync = createSyncHttpHandler({
    service: new SyncService({ storage }),
    authenticate,
    onError,
  });

  return createServer((request, response) => {
    const started = performance.now();
    // Time spent handling the request, for comparison with the Worker's timing header. Waiting
    // for the single thread before the request event is not included.
    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((status: number, ...rest: unknown[]) => {
      response.setHeader("x-server-ms", String(Math.round(performance.now() - started)));
      return (writeHead as (...args: unknown[]) => typeof response)(status, ...rest);
    }) as typeof response.writeHead;

    if (request.url !== "/admin/stats" || request.method !== "POST") {
      sync(request, response);
      return;
    }
    const account = authenticate(request);
    if (!account) {
      response.writeHead(401).end();
      return;
    }
    request.resume();
    // A failure here (a full disk, a damaged database) must answer, not take the server down.
    storage
      .account(account)
      .then((store) => {
        const count = (sql: string) => Number(store.db.get(sql)?.n ?? 0);
        return {
          revision: store.headRevision(),
          records: count("SELECT count(*) AS n FROM records"),
          receipts: count("SELECT count(*) AS n FROM receipts"),
          contentBytes: count("SELECT coalesce(sum(length(content)), 0) AS n FROM records"),
          databaseBytes: count(
            "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
          ),
        };
      })
      .then(
        (stats) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(stats));
        },
        (error) => {
          onError(error);
          response.writeHead(503).end();
        },
      );
  });
}
