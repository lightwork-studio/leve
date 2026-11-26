// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import type { SqlEngine } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { bearerAuthentication } from "@leve/sync/server";
import { Accounts, deviceAuthenticator } from "./accounts.ts";
import { listenAdmin } from "./admin.ts";
import { sharedTokenAuth } from "./auth.ts";
import { ADMIN_USAGE, runAdmin, UsageError } from "./cli.ts";
import { createSyncServer } from "./server.ts";

/*
 * The self-hosted sync server: one Node process, one SQLite file per account.
 *
 *   leve-sync serve              runs the server (the default)
 *   leve-sync admin <command>    manages accounts and phones through the running server
 *
 * Settings come from the environment:
 *   LEVE_DATA          where account databases and accounts.db live (default ./data)
 *   LEVE_ADMIN_SOCKET  the admin socket (default $RUNTIME_DIRECTORY/admin.sock, else in LEVE_DATA)
 *   LEVE_PUBLIC_URL    how phones reach the server, for pairing links (https://sync.example.com)
 *   LEVE_PAIRING=off   stops pairing new phones; paired ones keep syncing
 *   HOST, PORT         the public listener (default 127.0.0.1:8787; put HTTPS in front)
 *   LEVE_SQLITE_WAL=1  write-ahead logging for account databases
 *   LEVE_AUTH=benchmark with LEVE_TOKEN_FILE: BENCHMARK ONLY, one shared token for every account
 */

const env = process.env;
const directory = env.LEVE_DATA ?? "data";
const socket =
  env.LEVE_ADMIN_SOCKET ?? join(env.RUNTIME_DIRECTORY?.split(":")[0] ?? directory, "admin.sock");

/**
 * LEVE_SQLITE_WAL=1 opens account databases in write-ahead-log mode: still durable with
 * synchronous=FULL, but a commit costs one disk sync instead of several.
 */
function engine(): SqlEngine {
  const base = createNodeSqliteEngine();
  if (env.LEVE_SQLITE_WAL !== "1") return base;
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

async function serve(): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const benchmark = env.LEVE_AUTH === "benchmark";
  if (env.LEVE_AUTH !== undefined && !benchmark) {
    throw new UsageError(`unknown LEVE_AUTH=${env.LEVE_AUTH}; leave it unset`);
  }
  const sqlite = engine();
  const storage = new ServerStorage({ engine: sqlite, directory, appVersion: "sync-node" });
  const servers: Server[] = [];
  let accounts: Accounts | null = null;
  let server: Server;
  if (benchmark) {
    console.warn(
      "BENCHMARK MODE: anyone with the shared token reaches every account. Never use it for real data.",
    );
    const token = readFileSync(env.LEVE_TOKEN_FILE ?? "", "utf8").trim();
    server = createSyncServer({ storage, authenticate: sharedTokenAuth(token), benchmark: true });
  } else {
    accounts = Accounts.open({ engine: sqlite, path: join(directory, "accounts.db") });
    const publicUrl = env.LEVE_PUBLIC_URL?.trim();
    if (publicUrl && !/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(publicUrl)) {
      throw new UsageError("LEVE_PUBLIC_URL must be a URL such as https://sync.example.com");
    }
    const onError = (error: unknown) => console.error("request failed", error);
    server = createSyncServer({
      storage,
      authenticate: bearerAuthentication(deviceAuthenticator(accounts), onError),
      accounts,
      pairingOff: env.LEVE_PAIRING === "off",
      onError,
    });
    servers.push(
      await listenAdmin(socket, {
        accounts,
        ...(publicUrl ? { publicUrl } : {}),
        onError: (error) => console.error("admin command failed", error),
      }),
    );
    console.log(`admin socket ${socket}`);
  }
  servers.push(server);

  // Nothing that fails while handling a request may take the whole server down.
  process.on("unhandledRejection", (error) => console.error("unhandled failure", error));

  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`sync listening on ${host}:${port}, data in ${directory}`);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const s of servers) s.close();
      void storage.close().then(() => {
        accounts?.close();
        process.exit(0);
      });
    });
  }
}

const [command = "serve", ...args] = process.argv.slice(2);
try {
  if (command === "serve") await serve();
  else if (command === "admin") console.log(await runAdmin(socket, args));
  else throw new UsageError(`leve-sync serve | admin <command>\n\n${ADMIN_USAGE}`);
} catch (error) {
  console.error(
    error instanceof UsageError ? error.message : `leve-sync: ${(error as Error).message}`,
  );
  process.exit(error instanceof UsageError ? 2 : 1);
}
