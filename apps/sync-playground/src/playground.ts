// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type JsonObject, leveContract, type Submission } from "@leve/contract";
import { type DeviceStore, openDeviceStore, type Resolution } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { accountDatabasePath, ServerStorage } from "@leve/storage/server";
import { httpTransport, SyncClient, TransportError } from "@leve/sync";
import { createSyncHttpHandler, errorReply, SyncService } from "@leve/sync/server";

/*
 * A local playground for the data layer: one sync server, two simulated phones and an assistant
 * writer, all running the real packages on real SQLite files. The phones talk to the server over
 * HTTP; the assistant writes through the server's write service, as MCP tools will. A small
 * control API under /dev drives them, and the page at / shows and uses it.
 *
 * Development only: every request is signed in as the one demo account, and nothing here is
 * meant for real data.
 */

export const ACCOUNT = "demo";
export const DEVICE_NAMES = ["phone-a", "phone-b"] as const;
const RELEASE = "1.0";
const engine = createNodeSqliteEngine();

/** What the playground stores in its directory; resets remove only these. */
const DATA_ENTRIES = ["server", "devices", "backup.db"];

/** Removes the playground's data from `directory`, leaving anything else there alone. */
export function clearPlaygroundData(directory: string): void {
  for (const entry of DATA_ENTRIES)
    rmSync(join(directory, entry), { recursive: true, force: true });
}

export interface PlaygroundOptions {
  /** Where the server and device databases live. */
  directory: string;
  /** 0 picks a free port. */
  port?: number;
  /** The address to listen on; 127.0.0.1 by default. */
  host?: string;
}

export interface Playground {
  url: string;
  close(): Promise<void>;
}

interface Device {
  name: string;
  online: boolean;
  store: DeviceStore;
  client: SyncClient;
  lastOutcome: unknown;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

const text = (body: Body, field: string): string => {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new HttpError(400, `${field} is required`);
  return value;
};

const revisionOrNull = (body: Body, field: string): number | null => {
  const value = body[field];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) throw new HttpError(400, `${field} must be a revision`);
  return value as number;
};

/** The address to show for a listener: a wildcard address is reached through loopback. */
export function shownUrl(address: string, port: number): string {
  const host = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "::1" : address;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export async function startPlayground(options: PlaygroundOptions): Promise<Playground> {
  const { directory } = options;
  const serverDir = join(directory, "server");
  const deviceDir = join(directory, "devices");
  const backupPath = join(directory, "backup.db");
  const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");

  let storage: ServerStorage;
  let service: SyncService;
  let syncHandler: ReturnType<typeof createSyncHttpHandler> | null = null;
  const devices = new Map<string, Device>();
  const log: { at: string; text: string }[] = [];
  let backupTakenAt: string | null = null;
  let url = "";

  const note = (line: string) => {
    log.unshift({ at: new Date().toISOString(), text: line });
    log.length = Math.min(log.length, 50);
  };

  const startServer = () => {
    mkdirSync(serverDir, { recursive: true });
    storage = new ServerStorage({ engine, directory: serverDir, appVersion: "playground" });
    service = new SyncService({ storage });
    syncHandler = createSyncHttpHandler({
      service,
      // Local only: every request is a phone of the one account.
      authenticate: () => ({
        principal: { account: ACCOUNT, client: { kind: "device", id: "playground" } },
      }),
      onError: (error) => note(`server error: ${(error as Error).message}`),
    });
  };

  const stopServer = async () => {
    // Sync requests are answered "unavailable" until the server runs again.
    syncHandler = null;
    await storage.close();
  };

  const openDevice = async (name: string): Promise<Device> => {
    mkdirSync(deviceDir, { recursive: true });
    const store = await openDeviceStore({
      engine,
      path: join(deviceDir, `${name}.db`),
      appVersion: "playground",
    });
    const device: Device = { name, online: true, store, client: null as never, lastOutcome: null };
    const transport = httpTransport(url);
    device.client = new SyncClient({
      store,
      server: url,
      account: ACCOUNT,
      app: `playground-${name}`,
      transport: (path, body) => {
        if (!device.online) return Promise.reject(new TransportError("offline (playground)"));
        return transport(path, body);
      },
    });
    return device;
  };

  const startAll = async () => {
    startServer();
    for (const name of DEVICE_NAMES) devices.set(name, await openDevice(name));
  };

  const stopAll = async () => {
    for (const device of devices.values()) device.store.close();
    devices.clear();
    await stopServer();
  };

  // Dev actions run one at a time, so a restore never closes the server under a phone's sync.
  let lane: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lane.then(fn, fn);
    lane = run.catch(() => {});
    return run;
  };

  const state = async () => {
    const account = await storage.account(ACCOUNT);
    const rows = account.db.all("SELECT * FROM records ORDER BY revision").map((row) => ({
      kind: String(row.kind),
      id: String(row.id),
      revision: Number(row.revision),
      state: String(row.state),
      content: row.content === null ? null : (JSON.parse(String(row.content)) as JsonObject),
    }));
    return {
      account: ACCOUNT,
      server: {
        revision: account.headRevision(),
        lineage: account.lineage(),
        restoredFrom: account.restoredFrom(),
        backupTakenAt,
        records: rows,
      },
      devices: [...devices.values()].map((d) => ({
        name: d.name,
        online: d.online,
        sync: d.store.syncState(),
        unsynced: d.store.hasUnsyncedWork(),
        summary: d.store.summary(),
        lastOutcome: d.lastOutcome,
        records: leveContract.kindNames(RELEASE).flatMap((kind) => d.store.list(kind)),
        problems: d.store.problems(),
      })),
      log,
    };
  };

  const deviceActions = new Map<string, (d: Device, body: Body) => Promise<unknown>>([
    [
      "put",
      async (d, body) => {
        const kind = text(body, "kind");
        const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
        const record = d.store.put(kind, id, body.content as JsonObject);
        note(`${d.name}: saved ${kind} ${id.slice(0, 8)}`);
        return record;
      },
    ],
    [
      "delete",
      async (d, body) => {
        d.store.delete(text(body, "kind"), text(body, "id"));
        note(`${d.name}: deleted ${text(body, "kind")} ${text(body, "id").slice(0, 8)}`);
        return null;
      },
    ],
    [
      "sync",
      async (d) => {
        d.lastOutcome = await d.client.sync();
        note(`${d.name}: sync → ${JSON.stringify(d.lastOutcome)}`);
        return d.lastOutcome;
      },
    ],
    [
      "online",
      async (d, body) => {
        d.online = body.online === true;
        note(`${d.name}: ${d.online ? "online" : "offline"}`);
        return { online: d.online };
      },
    ],
    [
      "resolve",
      async (d, body) => {
        const choice = text(body, "choice");
        const resolution = (
          choice === "save_as_new"
            ? { choice, newId: typeof body.newId === "string" ? body.newId : crypto.randomUUID() }
            : { choice }
        ) as Resolution;
        const record = d.store.resolve(text(body, "kind"), text(body, "id"), resolution);
        note(`${d.name}: ${choice} on ${text(body, "kind")} ${text(body, "id").slice(0, 8)}`);
        return record;
      },
    ],
    [
      "resolve-restored",
      async (d) => {
        const count = d.store.resolveRestored();
        note(`${d.name}: kept the restored server's version of ${count} records`);
        return { resolved: count };
      },
    ],
  ]);

  const accountActions = new Map<string, (body: Body) => Promise<unknown>>([
    [
      // The assistant writes against the revision it read, and a deletion lists the descendants
      // it saw, as MCP tools do. A stale write is rejected with the current copy.
      "assistant",
      async (body) => {
        const kind = text(body, "kind");
        const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
        const baseRevision = revisionOrNull(body, "baseRevision");
        const submissionId = crypto.randomUUID();
        let submission: Submission;
        if (body.content === null) {
          if (!Array.isArray(body.descendants))
            throw new HttpError(400, "descendants are required");
          submission = {
            op: "delete",
            submissionId,
            kind,
            id,
            baseRevision,
            descendants: body.descendants as { kind: string; id: string; revision: number }[],
          };
        } else {
          const encoded = leveContract.encode(kind, body.content as JsonObject, RELEASE);
          if (encoded.issues.length > 0) {
            throw new HttpError(
              400,
              `${kind}: ${encoded.issues[0]?.path} ${encoded.issues[0]?.message}`,
            );
          }
          submission = {
            op: "put",
            submissionId,
            kind,
            id,
            baseRevision,
            content: encoded.content,
          };
        }
        const [result] = await service.submit(ACCOUNT, RELEASE, [submission]);
        note(`assistant: ${submission.op} ${kind} ${id.slice(0, 8)} → ${result?.status}`);
        return result;
      },
    ],
    [
      "backup",
      async () => {
        // SQLite's online backup, as the server's own backups will take it.
        const account = await storage.account(ACCOUNT);
        await engine.backup(account.db, backupPath);
        backupTakenAt = new Date().toISOString();
        note("server: backup taken");
        return { backupTakenAt };
      },
    ],
    [
      "restore",
      async (body) => {
        if (!backupTakenAt) throw new HttpError(400, "take a backup first");
        if (body.how === "copy") {
          // Files copied back by hand: the server notices only once a device is ahead of it.
          await stopServer();
          try {
            const path = accountDatabasePath(serverDir, ACCOUNT);
            rmSync(`${path}-journal`, { force: true });
            copyFileSync(backupPath, path);
          } finally {
            startServer();
          }
          note("server: backup copied back over the account file");
        } else {
          const result = await storage.restoreAccount(ACCOUNT, backupPath);
          note(`server: restored with the restore command (old copy kept: ${result.replaced})`);
        }
        return { restored: true };
      },
    ],
    [
      "reset",
      async () => {
        await stopAll();
        clearPlaygroundData(directory);
        backupTakenAt = null;
        log.length = 0;
        await startAll();
        note("everything reset");
        return { reset: true };
      },
    ],
  ]);

  const handleDev = async (request: IncomingMessage, response: ServerResponse, path: string) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === "GET" && path === "/dev/state") {
        send(200, await serial(state));
        return;
      }
      if (request.method !== "POST") throw new HttpError(404, "unknown");
      // JSON only, so a cross-site form or simple request can't post here. This is no defence
      // against DNS rebinding; the playground has no authentication and is for loopback use.
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new HttpError(415, "send application/json");
      }
      const deviceMatch = /^\/dev\/devices\/([\w-]+)\/([\w-]+)$/.exec(path);
      const accountMatch = /^\/dev\/([\w-]+)$/.exec(path);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Body;
      try {
        body = (raw ? JSON.parse(raw) : {}) as Body;
      } catch {
        throw new HttpError(400, "invalid JSON");
      }
      let run: () => Promise<unknown>;
      if (deviceMatch) {
        const action = deviceActions.get(deviceMatch[2] as string);
        if (!action) throw new HttpError(404, "unknown");
        run = () => {
          const found = devices.get(deviceMatch[1] as string);
          if (!found) throw new HttpError(404, `no device ${deviceMatch[1]}`);
          return action(found, body);
        };
      } else if (accountMatch) {
        const action = accountActions.get(accountMatch[1] as string);
        if (!action) throw new HttpError(404, "unknown");
        run = () => action(body);
      } else {
        throw new HttpError(404, "unknown");
      }
      send(200, { result: (await serial(run)) ?? null });
    } catch (error) {
      const known = error instanceof HttpError;
      // The stores refuse bad input with their own errors; anything else is a playground bug.
      const refused = (error as Error)?.name === "DeviceStoreError";
      send(known ? error.status : refused ? 400 : 500, { error: (error as Error).message });
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path.startsWith("/sync/")) {
      if (!syncHandler) {
        const reply = errorReply("unavailable", "the playground server is restarting");
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
        return;
      }
      void syncHandler(request, response);
      return;
    }
    if (path.startsWith("/dev/")) {
      void handleDev(request, response, path);
      return;
    }
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    response.writeHead(404).end();
  };

  const listen = (server: Server, port: number, host: string) =>
    new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address() as AddressInfo);
      });
    });
  // The page listens where it is asked to. The phones get their own loopback listener on a
  // random port, so they can sync whatever address the page uses.
  const http: Server = createServer(handle);
  const phoneHttp: Server = createServer(handle);
  let pageUrl: string;
  try {
    const { address, port } = await listen(http, options.port ?? 0, options.host ?? "127.0.0.1");
    pageUrl = shownUrl(address, port);
    url = `http://127.0.0.1:${(await listen(phoneHttp, 0, "127.0.0.1")).port}`;
    await startAll();
  } catch (error) {
    // A failed start leaves nothing listening or open behind.
    http.close();
    phoneHttp.close();
    await stopAll().catch(() => {});
    throw error;
  }

  let closing: Promise<void> | null = null;
  return {
    url: pageUrl,
    close() {
      closing ??= (async () => {
        await Promise.all(
          [http, phoneHttp].map(
            (server) => new Promise<void>((resolve) => server.close(() => resolve())),
          ),
        );
        await stopAll();
      })();
      return closing;
    },
  };
}
