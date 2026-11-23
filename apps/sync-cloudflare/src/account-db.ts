// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { leveContract, MAX_REQUEST_BYTES } from "@leve/contract";
import {
  META_TABLE_SQL,
  readStorageMeta,
  type SqlConnection,
  writeStorageMeta,
} from "@leve/storage";
import {
  SERVER_STORAGE_VERSION,
  ServerAccountStore,
  serverStorageDefinition,
} from "@leve/storage/server";
import { WRITTEN_REVISIONS_HEADER } from "@leve/sync";
import { errorReply, type Reply } from "@leve/sync/server";

// The parts of an account object that don't need the Workers runtime, so they can be tested on Node.

const APP_VERSION = "sync-cloudflare-spike";

/** Runs `fn` in one transaction of the connection, which must bring its own transaction call. */
function inTransaction<T>(db: SqlConnection, fn: () => T): T {
  if (!db.transaction) throw new Error("the account database needs a transaction call");
  return db.transaction(fn);
}

/**
 * Opens the account's database. A database with no tables gets the current schema when `create` is
 * set; otherwise there is no account yet and the result is null.
 */
export function openAccountDatabase(db: SqlConnection, create: boolean): ServerAccountStore | null {
  const meta = readStorageMeta(db);
  if (!meta) {
    if (!create) return null;
    inTransaction(db, () => {
      db.exec(META_TABLE_SQL);
      serverStorageDefinition().create(db, { randomId: () => crypto.randomUUID() });
      writeStorageMeta(db, {
        storageVersion: SERVER_STORAGE_VERSION,
        appVersion: APP_VERSION,
        unsyncedWork: false,
      });
    });
  } else if (meta.storageVersion !== SERVER_STORAGE_VERSION) {
    // Upgrades would run here in one transaction, with a point-in-time bookmark as the snapshot.
    throw new Error(`storage version ${meta.storageVersion} needs an upgrade`);
  }
  return new ServerAccountStore(db, leveContract);
}

/**
 * After a point-in-time restore: gives the account a new lineage and records where the histories
 * split, as a restore on the self-hosted server does, so devices download everything again.
 */
export function startNewLineage(store: ServerAccountStore): void {
  store.transaction(() => {
    store.db.run(
      `UPDATE account SET restored_from = lineage, restore_point = revision, lineage = ?
       WHERE id = 1`,
      [crypto.randomUUID()],
    );
  });
}

/** The service's reply as an HTTP response, with the same headers as the self-hosted server. */
export function syncResponse(reply: Reply<unknown>): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (reply.writtenRevisions) {
    headers[WRITTEN_REVISIONS_HEADER] = reply.writtenRevisions;
    headers["access-control-expose-headers"] = WRITTEN_REVISIONS_HEADER;
  }
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
}

/** Reads a sync request's JSON body, refusing more than the protocol's request size in bytes. */
export async function readSyncBody(
  request: Request,
): Promise<{ body: unknown } | { refused: Reply<never> }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return { refused: errorReply("invalid_request", "request body too large") };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    return { refused: errorReply("invalid_request", "request body too large") };
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { refused: errorReply("invalid_request", "invalid JSON") };
  }
}
