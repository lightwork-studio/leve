// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "./cli.ts";

/** The server's settings, read from its environment. See main.ts for what each one means. */
export interface Config {
  directory: string;
  socket: string;
  /** BENCHMARK ONLY: one shared token for every account. */
  benchmarkTokenFile: string | null;
  publicUrl: string | null;
  pairingOff: boolean;
  host: string;
  port: number;
  wal: boolean;
  /** Things worth telling the operator at start. */
  warnings: string[];
}

const PUBLIC_URL = /^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/;

export function readConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): Config {
  const directory = resolve(cwd, env.LEVE_DATA || "data");
  // Absolute, so a bare number is never taken for a TCP port. A relative setting resolves against
  // each process's own directory, so give the server and `leve-sync admin` absolute paths.
  const runtime = env.RUNTIME_DIRECTORY?.split(":")[0];
  const socket = resolve(cwd, env.LEVE_ADMIN_SOCKET || join(runtime || directory, "admin.sock"));
  const warnings: string[] = [];

  let benchmarkTokenFile: string | null = null;
  if (env.LEVE_AUTH === "benchmark") {
    if (!env.LEVE_TOKEN_FILE) throw new UsageError("LEVE_AUTH=benchmark needs LEVE_TOKEN_FILE");
    // The shared token reaches every account: never on a directory holding real accounts.
    if (existsSync(join(directory, "accounts.db"))) {
      throw new UsageError(
        `${directory} holds accounts (accounts.db); benchmark mode would open all of them to one shared token`,
      );
    }
    benchmarkTokenFile = env.LEVE_TOKEN_FILE;
  } else if (env.LEVE_AUTH !== undefined) {
    throw new UsageError(`unknown LEVE_AUTH=${env.LEVE_AUTH}; leave it unset`);
  } else if (env.LEVE_TOKEN_FILE) {
    warnings.push(
      "LEVE_TOKEN_FILE is ignored: phones sign in with their own tokens. The shared token is only for LEVE_AUTH=benchmark.",
    );
  }

  const publicUrl = env.LEVE_PUBLIC_URL?.trim() || null;
  if (publicUrl && !PUBLIC_URL.test(publicUrl)) {
    throw new UsageError("LEVE_PUBLIC_URL must be a URL such as https://sync.example.com");
  }
  if (!publicUrl && !benchmarkTokenFile) {
    warnings.push("LEVE_PUBLIC_URL isn't set: pairing gives a code to type in instead of a link.");
  }
  if (env.LEVE_PAIRING !== undefined && env.LEVE_PAIRING !== "off" && env.LEVE_PAIRING !== "on") {
    throw new UsageError(`LEVE_PAIRING is "on" or "off", not ${env.LEVE_PAIRING}`);
  }
  const portText = env.PORT?.trim() || "8787";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) {
    throw new UsageError(`PORT must be a port number, not ${env.PORT}`);
  }
  return {
    directory,
    socket,
    benchmarkTokenFile,
    publicUrl,
    pairingOff: env.LEVE_PAIRING === "off",
    host: env.HOST || "127.0.0.1",
    port,
    wal: env.LEVE_SQLITE_WAL === "1",
    warnings,
  };
}
