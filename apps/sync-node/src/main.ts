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
import { type Config, readConfig } from "./config.ts";
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
 *   LEVE_PAIRING=off   stops pairing new phones; paired ones keep syncing (on by default)
 *   HOST, PORT         the public listener (default 127.0.0.1:8787; put HTTPS in front)
 *   LEVE_SQLITE_WAL=1  write-ahead logging for account databases
 *   LEVE_AUTH=benchmark with LEVE_TOKEN_FILE: BENCHMARK ONLY, one shared token for every account
 */

const env = process.env;

/**
 * LEVE_SQLITE_WAL=1 opens account databases in write-ahead-log mode: still durable with
 * synchronous=FULL, but a commit costs one disk sync instead of several.
 */
function engine(wal: boolean): SqlEngine {
  const base = createNodeSqliteEngine();
  if (!wal) return base;
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

async function serve(config: Config): Promise<void> {
  const { directory } = config;
  for (const warning of config.warnings) console.warn(warning);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sqlite = engine(config.wal);
  const storage = new ServerStorage({ engine: sqlite, directory, appVersion: "sync-node" });
  const servers: Server[] = [];
  let accounts: Accounts | null = null;
  let server: Server;
  if (config.benchmarkTokenFile) {
    console.warn(
      "BENCHMARK MODE: anyone with the shared token reaches every account. Never use it for real data.",
    );
    const token = readFileSync(config.benchmarkTokenFile, "utf8").trim();
    server = createSyncServer({ storage, authenticate: sharedTokenAuth(token), benchmark: true });
  } else {
    accounts = Accounts.open({ engine: sqlite, path: join(directory, "accounts.db") });
    const onError = (error: unknown) => console.error("request failed", error);
    server = createSyncServer({
      storage,
      authenticate: bearerAuthentication(deviceAuthenticator(accounts), onError),
      accounts,
      pairingOff: config.pairingOff,
      onError,
    });
    servers.push(
      await listenAdmin(config.socket, {
        accounts,
        ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
        onError: (error) => console.error("admin command failed", error),
      }),
    );
    console.log(`admin socket ${config.socket}`);
  }
  servers.push(server);

  // Nothing that fails while handling a request may take the whole server down.
  process.on("unhandledRejection", (error) => console.error("unhandled failure", error));

  server.listen(config.port, config.host, () => {
    console.log(`sync listening on ${config.host}:${config.port}, data in ${directory}`);
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
  if (command === "serve") await serve(readConfig(env));
  else if (command === "admin") console.log(await runAdmin(readConfig(env).socket, args));
  else throw new UsageError(`leve-sync serve | admin <command>\n\n${ADMIN_USAGE}`);
} catch (error) {
  console.error(
    error instanceof UsageError ? error.message : `leve-sync: ${(error as Error).message}`,
  );
  process.exit(error instanceof UsageError ? 2 : 1);
}
