// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { DurableObject } from "cloudflare:workers";
import type { ServerAccountStore } from "@leve/storage/server";
import { errorReply, type Reply, SyncService } from "@leve/sync/server";
import { openAccountDatabase, readSyncBody, startNewLineage, syncResponse } from "./account-db.ts";
import { durableObjectConnection, type SqlMeter } from "./do-sql.ts";

const ROUTES = { "/sync/hello": "hello", "/sync/push": "push", "/sync/pull": "pull" } as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Remembers, outside the account's own database, that the account is being restored to an earlier
 * point in time. A restore rolls back everything in the account's database, so the note that a new
 * lineage is due can't live there. One marker object per account.
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
}

/**
 * One account: its SQLite database and the sync service in front of it. Cloudflare routes every
 * request for the account to this single object, so writes never race across machines.
 */
export class AccountObject extends DurableObject<Env> {
  readonly #meter: SqlMeter = { rowsRead: 0, rowsWritten: 0 };
  readonly #db = durableObjectConnection(this.ctx.storage, this.#meter);
  #store: ServerAccountStore | null = openAccountDatabase(this.#db, false);
  readonly #service = new SyncService({
    storage: {
      account: async () => {
        // A request that was waiting while the account was deleted must not bring it back.
        if (this.#closed) throw new Error("the account is closed");
        this.#store ??= openAccountDatabase(this.#db, true);
        return this.#store as ServerAccountStore;
      },
    },
  });
  #requests = 0;
  /** Checked once per session, before anything else: a restore may have just happened. */
  #restoreChecked: Promise<void> | null = null;
  /** Set once the account is deleted or restoring; the object answers nothing until it restarts. */
  #closed = false;

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

  /** After a restore, starts the new lineage before the restored account answers anything. */
  #finishRestore(account: string): Promise<void> {
    this.#restoreChecked ??= (async () => {
      const marker = this.#marker(account);
      if (!(await marker.pending())) return;
      if (this.#store) startNewLineage(this.#store);
      await marker.clear();
    })().catch((error) => {
      this.#restoreChecked = null;
      throw error;
    });
    return this.#restoreChecked;
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const account = request.headers.get("x-leve-account") ?? "";
    if (this.#closed) {
      return json(503, errorReply("unavailable", "this account is not available").body);
    }
    await this.#finishRestore(account);
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
