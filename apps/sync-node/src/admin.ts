// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { type Accounts, AccountsError } from "./accounts.ts";
import { accountStats, type BackupOptions, backupAll, restoreAccount } from "./backups.ts";

/*
 * Administration, on a Unix socket only the server's own user can open (mode 0600). File
 * permissions are the operator's credential: no token reaches these commands, and the public
 * listener doesn't serve them. The `leve-sync admin` command talks to this socket, so every change
 * happens inside the running server, which owns the open databases.
 */

export interface AdminOptions {
  accounts: Accounts;
  /** The account databases, for stats, backups and restores. */
  data?: Omit<BackupOptions, "accounts">;
  /** Where the server is reached from phones, for pairing links. */
  publicUrl?: string;
  onError?: (error: unknown) => void;
}

type Handler = (body: Record<string, unknown>) => unknown | Promise<unknown>;

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new AccountsError(`${name} is missing`);
  return value;
};

/** A pairing link: the server's page with the code in the fragment, which browsers never send. */
export function pairingLink(publicUrl: string, code: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/connect#code=${code}`;
}

export function adminRoutes(options: AdminOptions): Record<string, Handler> {
  const { accounts } = options;
  return {
    "/accounts/add": (body) => accounts.addAccount(text(body.name, "name")),
    "/accounts/list": () => accounts.listAccounts(),
    "/pair": (body) => {
      const pairing = accounts.createPairing(text(body.account, "account"));
      return {
        account: pairing.account.name,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        link: options.publicUrl ? pairingLink(options.publicUrl, pairing.code) : null,
      };
    },
    "/devices/list": (body) =>
      accounts.listDevices(body.account === undefined ? undefined : text(body.account, "account")),
    "/devices/revoke": (body) => {
      if (body.everyone === true) return { revoked: accounts.revokeEveryDevice() };
      if (body.all === true)
        return { revoked: accounts.revokeAllDevices(text(body.account, "account")) };
      const revoked = accounts.revokeDevice(text(body.device, "device"));
      if (!revoked) throw new AccountsError(`no device ${String(body.device)}`);
      return { revoked: 1 };
    },
    ...(options.data ? dataRoutes({ accounts, ...options.data }) : {}),
  };
}

function dataRoutes(options: BackupOptions): Record<string, Handler> {
  return {
    "/stats": (body) => accountStats(options, text(body.account, "account")),
    "/backup": (body) => backupAll(options, text(body.to, "to")),
    "/restore": (body) =>
      restoreAccount(
        options,
        text(body.account, "account"),
        text(body.from, "from"),
        body.otherAccount === true,
      ),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountsError("send a JSON object");
  return value as Record<string, unknown>;
}

/** Whether a server still answers on the socket. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ path: socketPath });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    // Only a refused connection means nobody listens. Anything else (no permission, a full
    // backlog) may be a live server, which must not lose its socket.
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "ECONNREFUSED"));
  });
}

/**
 * Listens on `socketPath`, replacing a socket a stopped server left behind. Refuses to replace
 * anything that isn't a socket, or a socket another server still answers on.
 */
export async function listenAdmin(socketPath: string, options: AdminOptions): Promise<Server> {
  const routes = adminRoutes(options);
  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const route = request.method === "POST" ? routes[request.url ?? ""] : undefined;
    if (!route) {
      request.resume();
      reply(404, { error: "unknown command" });
      return;
    }
    readJson(request)
      .then((body) => route(body))
      .then(
        (result) => reply(200, result ?? null),
        (error) => {
          if (error instanceof AccountsError || error instanceof SyntaxError) {
            reply(400, { error: (error as Error).message });
            return;
          }
          options.onError?.(error);
          reply(500, { error: "the command failed; see the server log" });
        },
      );
  });
  // A relative path or a bare number would be taken for something else (a port, say).
  if (!isAbsolute(socketPath))
    throw new Error(`the admin socket must be an absolute path: ${socketPath}`);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(socketPath);
  } catch {}
  if (existing) {
    if (!existing.isSocket()) throw new Error(`${socketPath} exists and isn't a socket`);
    if (await answers(socketPath)) {
      throw new Error(`another leve-sync server is running on ${socketPath}`);
    }
    rmSync(socketPath);
  }
  // Created without group or other access from the start, not only after the chmod below.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: socketPath }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  chmodSync(socketPath, 0o600);
  return server;
}

/** Sends one admin command to the server's socket. */
export function adminRequest(
  socketPath: string,
  command: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: command,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error(`unreadable answer (${response.statusCode})`));
            return;
          }
          if (response.statusCode === 200) resolve(parsed);
          else
            reject(
              new Error((parsed as { error?: string })?.error ?? `failed (${response.statusCode})`),
            );
        });
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new Error(`no server is listening on ${socketPath}; is leve-sync running?`)
          : error.code === "EACCES"
            ? new Error(`no permission to open ${socketPath}; run as the server's user`)
            : error,
      ),
    );
    request.end(payload);
  });
}
