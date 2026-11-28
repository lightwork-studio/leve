// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { DurableObject } from "cloudflare:workers";
import type { ServerAccountStore } from "@leve/storage/server";
import { createMcpEndpoint } from "@leve/sync/mcp";
import { errorReply, type Principal, type Reply, SyncService } from "@leve/sync/server";
import { openAccountDatabase, readSyncBody, startNewLineage, syncResponse } from "./account-db.ts";
import {
  DeletionError,
  type DeletionStep,
  deleteSignIn,
  deletionConfig,
} from "./account-deletion.ts";
import { durableObjectConnection, type SqlMeter } from "./do-sql.ts";
import {
  ACCOUNT_DELETE_PATH,
  CLIENT_HEADER,
  MCP_PATH,
  mcpResource,
  SCOPES_HEADER,
} from "./gate.ts";

const ROUTES = { "/sync/hello": "hello", "/sync/push": "push", "/sync/pull": "pull" } as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function configuredClientName(clientId: string, names: string | undefined): string | undefined {
  if (!names) return undefined;
  try {
    const entries: unknown = JSON.parse(names);
    if (!entries || typeof entries !== "object" || !Object.hasOwn(entries, clientId))
      return undefined;
    const value = (entries as Record<string, unknown>)[clientId];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remembers, outside the account's own database, what that database can't keep itself: that the
 * account is being restored to an earlier point in time (a restore rolls back everything in it, so
 * the note that a new lineage is due can't live there), and that the account was deleted (deleting
 * it removes the whole database). One marker object per account.
 */
export class RestoreMarker extends DurableObject<Env> {
  async mark(): Promise<void> {
    await this.ctx.storage.put("pending", true);
  }
  async pending(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>("pending")) === true;
  }
  async clear(): Promise<void> {
    await this.ctx.storage.delete("pending");
  }
  /** For good: the account's id never holds data again. Only the time of the deletion is kept. */
  async markDeleted(): Promise<void> {
    if ((await this.ctx.storage.get<string>("deleted")) === undefined) {
      await this.ctx.storage.put("deleted", new Date().toISOString());
    }
  }
  async status(): Promise<{ pending: boolean; deleted: boolean }> {
    const [pending, deleted] = await Promise.all([
      this.ctx.storage.get<boolean>("pending"),
      this.ctx.storage.get<string>("deleted"),
    ]);
    return { pending: pending === true, deleted: deleted !== undefined };
  }
}

const deletedResponse = () =>
  json(410, errorReply("account_deleted", "This account was deleted").body);

/**
 * One account: its SQLite database and the sync service in front of it. Cloudflare routes every
 * request for the account to this single object, so writes never race across machines.
 */
export class AccountObject extends DurableObject<Env> {
  readonly #meter: SqlMeter = { rowsRead: 0, rowsWritten: 0 };
  readonly #db = durableObjectConnection(this.ctx.storage, this.#meter);
  #store: ServerAccountStore | null = openAccountDatabase(this.#db, false);
  readonly #service = new SyncService({
    existingAccount: async () => {
      if (this.#closed || this.#deleted) throw new Error("the account is closed");
      return this.#store;
    },
    storage: {
      account: async () => {
        // A request that was waiting while the account was deleted must not bring it back.
        if (this.#closed || this.#deleted) throw new Error("the account is closed");
        this.#store ??= openAccountDatabase(this.#db, true);
        return this.#store as ServerAccountStore;
      },
      deleteAccount: (account) => this.#erase(account),
    },
  });
  readonly #mcp = createMcpEndpoint({
    service: this.#service,
    version: "1",
    writesEnabled: this.env.MCP_WRITES_ENABLED === "true",
    resourceMetadataUrl: mcpResource(this.env)?.metadata,
  });
  #requests = 0;
  /** Checked once per session, before anything else: a restore or a deletion may have happened. */
  #markerChecked: Promise<void> | null = null;
  /**
   * Set once the operator deleted the account or it is restoring; the object answers nothing until
   * it restarts.
   */
  #closed = false;
  /** The person deleted the account: from now on it answers `account_deleted`. */
  #deleted = false;

  override async fetch(request: Request): Promise<Response> {
    const before = { ...this.#meter };
    const warm = this.#requests++ > 0;
    let response: Response;
    try {
      response = await this.#handle(request);
    } catch (error) {
      console.error("sync failed", error);
      response = json(503, errorReply("unavailable", "sync is temporarily unavailable").body);
    }
    // Measurements for the spike: what this request cost and whether the object was already awake.
    // (Time inside the object can't be measured here: the clock only moves across I/O.)
    response.headers.set("x-rows-read", String(this.#meter.rowsRead - before.rowsRead));
    response.headers.set("x-rows-written", String(this.#meter.rowsWritten - before.rowsWritten));
    response.headers.set("x-object-warm", warm ? "1" : "0");
    return response;
  }

  #marker(account: string) {
    return this.env.RESTORES.get(this.env.RESTORES.idFromName(account));
  }

  /**
   * Before the account answers anything: after a restore, starts the new lineage; after a deletion,
   * makes sure nothing of the account is left, in case the deletion stopped halfway.
   */
  #checkMarker(account: string): Promise<void> {
    this.#markerChecked ??= (async () => {
      const marker = this.#marker(account);
      const { pending, deleted } = await marker.status();
      if (deleted) {
        this.#deleted = true;
        this.#store = null;
        await this.ctx.storage.deleteAll();
        return;
      }
      if (!pending) return;
      if (this.#store) startNewLineage(this.#store);
      await marker.clear();
    })().catch((error) => {
      this.#markerChecked = null;
      throw error;
    });
    return this.#markerChecked;
  }

  /**
   * Deletes the account's data for good. The marker comes first: it lives outside the storage this
   * removes, so a deletion that stops halfway is finished by the next request (see #checkMarker),
   * and the account can never be created again under its id.
   */
  async #erase(account: string): Promise<void> {
    await this.#marker(account).markDeleted();
    this.#deleted = true;
    this.#store = null;
    await this.ctx.storage.deleteAll();
  }

  /**
   * The signed-in person deletes their account: its data, then its Sign in with Apple grant and
   * its Clerk user (see account-deletion.ts). Every step can be repeated, so trying again after a
   * failure finishes the deletion. Nothing is deleted while the Worker can't do all of it.
   */
  async #deleteAccount(request: Request, account: string): Promise<Response> {
    // Failures name the step that failed, so the phone knows whether the data is already gone.
    const failed = (status: number, reply: Reply<never>, step: DeletionStep) =>
      json(status, { ...(reply.body as object), step });
    const config = deletionConfig(this.env);
    if (!config) {
      console.error("account deletion is not configured: set CLERK_SECRET_KEY and APPLE_*");
      return failed(
        503,
        errorReply("unavailable", "account deletion is not available"),
        "configuration",
      );
    }
    const read = await readSyncBody(request);
    if ("refused" in read) return syncResponse(read.refused);
    const code = (read.body as { appleAuthorizationCode?: unknown } | null)?.appleAuthorizationCode;
    if (code !== undefined && (typeof code !== "string" || code === "" || code.length > 4096)) {
      return json(400, errorReply("invalid_request", "appleAuthorizationCode").body);
    }
    const erased = await this.#service.deleteAccount(account);
    if (erased.status !== 200) return syncResponse(erased);
    try {
      await deleteSignIn(config, account, code ?? null);
    } catch (error) {
      if (!(error instanceof DeletionError)) throw error;
      console.error("deleting the sign-in didn't finish:", error.message);
      return error.reason === "apple"
        ? failed(400, errorReply("invalid_request", error.message), "apple")
        : failed(503, errorReply("unavailable", "deleting the sign-in didn't finish"), "sign_in");
    }
    return json(200, { deleted: true });
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const account = request.headers.get("x-leve-account") ?? "";
    if (this.#closed) {
      return json(503, errorReply("unavailable", "this account is not available").body);
    }
    await this.#checkMarker(account);
    if (path === ACCOUNT_DELETE_PATH) return this.#deleteAccount(request, account);
    if (this.#deleted) return deletedResponse();
    if (path === MCP_PATH) {
      // The gate checked the access token and set these; the object trusts only the gate.
      const id = decodeURIComponent(request.headers.get(CLIENT_HEADER) ?? "");
      const principal: Principal = {
        account,
        client: {
          kind: "agent",
          id,
          name: configuredClientName(id, this.env.MCP_CLIENT_NAMES),
        },
        scopes: (request.headers.get(SCOPES_HEADER) ?? "").split(" ").filter(Boolean),
      };
      return this.#mcp(request, principal);
    }
    const route = ROUTES[path as keyof typeof ROUTES];
    if (route) {
      const read = await readSyncBody(request);
      if ("refused" in read) return syncResponse(read.refused);
      const reply: Reply<unknown> = await this.#service[route](account, read.body);
      return syncResponse(reply);
    }
    // Admin requests never create an account.
    const store = this.#store;
    if (!store) return json(404, errorReply("invalid_request", "no such account").body);
    switch (path) {
      case "/admin/stats":
        return json(200, this.#stats(store));
      case "/admin/export":
        return this.#export(store);
      case "/admin/bookmark":
        return json(200, { bookmark: await this.ctx.storage.getCurrentBookmark() });
      case "/admin/restore": {
        // Point-in-time recovery. The marker is set first, so the restored object starts a new
        // lineage before it answers anything; then the object restarts on the bookmark's state.
        const { bookmark } = (await request.json()) as { bookmark: string };
        const marker = this.#marker(account);
        await marker.mark();
        let undo: string;
        try {
          undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
        } catch (error) {
          // Nothing was scheduled, so the account keeps its lineage.
          await marker.clear().catch(() => {});
          throw error;
        }
        // Restart after answering: aborting inside the request turns the answer into an error page.
        this.#closed = true;
        setTimeout(() => this.ctx.abort("restoring"), 100);
        return json(200, { undo });
      }
      case "/admin/delete":
        // Removes every row and the object's storage. Aborting here would throw away the not yet
        // confirmed delete, so the object just stops answering instead.
        await this.ctx.storage.deleteAll();
        this.#store = null;
        this.#closed = true;
        return json(200, { deleted: true });
      default:
        return json(400, errorReply("invalid_request", "unknown endpoint").body);
    }
  }

  #stats(store: ServerAccountStore) {
    const count = (sql: string) => Number(store.db.get(sql)?.n ?? 0);
    return {
      revision: store.headRevision(),
      lineage: store.lineage(),
      restoredFrom: store.restoredFrom(),
      records: count("SELECT count(*) AS n FROM records"),
      liveRecords: count("SELECT count(*) AS n FROM records WHERE state = 'live'"),
      receipts: count("SELECT count(*) AS n FROM receipts"),
      contentBytes: count("SELECT coalesce(sum(length(content)), 0) AS n FROM records"),
      databaseBytes: this.ctx.storage.sql.databaseSize,
    };
  }

  /** Every live record as one JSON line each, for the account's data export. */
  #export(store: ServerAccountStore): Response {
    const rows = store.db.all(
      "SELECT kind, id, revision, content FROM records WHERE state = 'live' ORDER BY revision",
    );
    const body = rows
      .map((row) =>
        JSON.stringify({
          kind: row.kind,
          id: row.id,
          revision: row.revision,
          content: JSON.parse(String(row.content)),
        }),
      )
      .join("\n");
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  }
}
