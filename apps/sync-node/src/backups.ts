// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { type SqlEngine, StorageRecoveryError, StorageTooNewError } from "@leve/storage";
import { accountDatabasePath, type ServerStorage } from "@leve/storage/server";
import { type Accounts, AccountsError } from "./accounts.ts";

/*
 * Backups and restores of a running server. A backup copies every account database and
 * accounts.db with SQLite's online backup, so it is consistent while phones keep syncing, and
 * writes a manifest. A restore puts one account back from such a copy through the storage's
 * restore command: it checks the copy before replacing anything, keeps the database it replaces,
 * and gives the account a new lineage, so its phones download everything again and offer back
 * what the backup lacks (docs/data-compatibility.md, "Server restores").
 */

export interface BackupOptions {
  accounts: Accounts;
  storage: ServerStorage;
  engine: SqlEngine;
  /** Where the account databases live. */
  directory: string;
  now?: () => Date;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  accounts: { id: string; name: string; file: string; revision: number; lineage: string }[];
  accountsFile: string;
}

const absolute = (path: unknown, name: string): string => {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new AccountsError(`${name} must be an absolute path`);
  }
  return path;
};

/**
 * Copies every account and accounts.db into a new folder under `into`, named for the time. The
 * folder is new, so a backup never overwrites an earlier one.
 */
export async function backupAll(
  options: BackupOptions,
  into: string,
): Promise<{ folder: string; manifest: BackupManifest }> {
  const { accounts, storage, engine, directory } = options;
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const folder = join(
    absolute(into, "the backup folder"),
    `leve-${createdAt.replace(/[:.]/g, "-")}`,
  );
  // Fails if it exists: two backups in the same millisecond don't mix.
  mkdirSync(into, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { mode: 0o700 });
  const manifest: BackupManifest = {
    format: 1,
    createdAt,
    accounts: [],
    accountsFile: "accounts.db",
  };
  for (const account of accounts.listAccounts()) {
    // An account no phone has synced with yet has no database; opening it here would make one.
    if (!engine.exists(accountDatabasePath(directory, account.id))) continue;
    const store = await storage.account(account.id);
    const file = basename(accountDatabasePath(directory, account.id));
    await engine.backup(store.db, join(folder, file));
    manifest.accounts.push({
      id: account.id,
      name: account.name,
      file,
      revision: store.headRevision(),
      lineage: store.lineage(),
    });
  }
  // Last, so every account in the copies has its row: a backup of accounts.db taken first could
  // miss an account created meanwhile.
  await engine.backup(accounts.db, join(folder, manifest.accountsFile));
  writeFileSync(join(folder, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { folder, manifest };
}

/**
 * Restores one account from a backed-up account database. The copy must be that account's: one
 * account's data never lands in another's unless the operator says so with `otherAccount`.
 */
export async function restoreAccount(
  options: BackupOptions,
  nameOrId: string,
  file: string,
  otherAccount = false,
): Promise<{ account: string; replaced: string | null; lineage: string; revision: number }> {
  const { accounts, storage } = options;
  const account = accounts.findAccount(nameOrId);
  if (!account) throw new AccountsError(`no account named ${nameOrId}`);
  const source = absolute(file, "the backup file");
  const expected = basename(accountDatabasePath(options.directory, account.id));
  if (basename(source) !== expected && !otherAccount) {
    throw new AccountsError(
      `${basename(source)} isn't a backup of ${account.name} (${expected}); add --other-account to restore it anyway`,
    );
  }
  let result: { replaced: string | null };
  try {
    result = await storage.restoreAccount(account.id, source);
  } catch (error) {
    // The copy was checked and refused before anything was replaced: the operator's to fix.
    if (error instanceof StorageRecoveryError || error instanceof StorageTooNewError) {
      throw new AccountsError((error as Error).message);
    }
    throw error;
  }
  const store = await storage.account(account.id);
  return {
    account: account.name,
    replaced: result.replaced,
    lineage: store.lineage(),
    revision: store.headRevision(),
  };
}

/** What an account holds, for the operator. */
export async function accountStats(options: BackupOptions, nameOrId: string) {
  const account = options.accounts.findAccount(nameOrId);
  if (!account) throw new AccountsError(`no account named ${nameOrId}`);
  if (!options.engine.exists(accountDatabasePath(options.directory, account.id))) {
    return { account: account.name, id: account.id, synced: false };
  }
  const store = await options.storage.account(account.id);
  const count = (sql: string) => Number(store.db.get(sql)?.n ?? 0);
  return {
    account: account.name,
    id: account.id,
    synced: true,
    revision: store.headRevision(),
    lineage: store.lineage(),
    restoredFrom: store.restoredFrom(),
    records: count("SELECT count(*) AS n FROM records"),
    liveRecords: count("SELECT count(*) AS n FROM records WHERE state = 'live'"),
    receipts: count("SELECT count(*) AS n FROM receipts"),
    contentBytes: count("SELECT coalesce(sum(length(content)), 0) AS n FROM records"),
    databaseBytes: count(
      "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
    ),
  };
}
