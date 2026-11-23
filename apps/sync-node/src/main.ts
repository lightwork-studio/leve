// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, readFileSync } from "node:fs";
import type { SqlEngine } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { sharedTokenAuth } from "./auth.ts";
import { createSyncServer } from "./server.ts";

/*
 * The sync service as one Node process, one SQLite file per account. BENCHMARK ONLY: one shared
 * token and an account header stand in for real sign-in, as in the Cloudflare spike, so the same
 * load script runs against both.
 *
 *   LEVE_DATA=/var/lib/leve/accounts LEVE_TOKEN_FILE=… PORT=8787 node src/main.ts
 */

const directory = process.env.LEVE_DATA ?? "data";
mkdirSync(directory, { recursive: true });

/**
 * LEVE_SQLITE_WAL=1 opens account databases in write-ahead-log mode: still durable with
 * synchronous=FULL, but a commit costs one disk sync instead of several. A benchmark switch.
 */
function engine(): SqlEngine {
  const base = createNodeSqliteEngine();
  if (process.env.LEVE_SQLITE_WAL !== "1") return base;
  return {
    ...base,
    open(path, options) {
      const connection = base.open(path, options);
      if (!options?.readOnly) {
        connection.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      }
      return connection;
    },
  };
}

const storage = new ServerStorage({
  engine: engine(),
  directory,
  appVersion: "sync-node-benchmark",
});
const server = createSyncServer({
  storage,
  authenticate: sharedTokenAuth(readFileSync(process.env.LEVE_TOKEN_FILE ?? "", "utf8").trim()),
});

// Nothing that fails while handling a request may take the whole server down.
process.on("unhandledRejection", (error) => console.error("unhandled failure", error));

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(`sync listening on ${host}:${port}, data in ${directory}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    void storage.close().then(() => process.exit(0));
  });
}
