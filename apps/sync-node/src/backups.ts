// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  type SqlConnection,
  type SqlEngine,
  StorageRecoveryError,
  StorageTooNewError,
} from "@leve/storage";
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
  /** Accounts that couldn't be copied, for example a database that fails to open. */
  failed: { id: string; name: string; error: string }[];
  /**
   * Account databases in the data directory that no account names, for example after accounts.db
   * was restored from an older backup. Not copied: the operator decides what they are.
   */
  unknown: string[];
  accountsFile: string;
}

/**
 * Finishes a copy: back to a rollback journal, so it opens anywhere, even read-only and without
 * the -wal and -shm files a write-ahead-log copy needs; readable by its owner only; and the
 * revision and lineage it actually holds, which a sync after the copy can't move.
 */
function seal<T>(engine: SqlEngine, path: string, read: (copy: SqlConnection) => T): T {
  const copy = engine.open(path);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    chmodSync(path, 0o600);
    return read(copy);
  } finally {
    copy.close();
  }
}

const accountPoint = (copy: SqlConnection) => {
  const row = copy.get("SELECT revision, lineage FROM account WHERE id = 1");
  return { revision: Number(row?.revision ?? 0), lineage: String(row?.lineage ?? "") };
};

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
    failed: [],
    unknown: [],
    accountsFile: "accounts.db",
  };
  for (const account of accounts.listAccounts()) {
    // An account no phone has synced with yet has no database; opening it here would make one.
    if (!engine.exists(accountDatabasePath(directory, account.id))) continue;
    const file = basename(accountDatabasePath(directory, account.id));
    // One account that can't be opened (a failed upgrade, a damaged file) is reported, and the
    // others are still copied: it affects only that account, as everywhere else.
    try {
      const store = await storage.account(account.id);
      await engine.backup(store.db, join(folder, file));
      manifest.accounts.push({
        id: account.id,
        name: account.name,
        file,
        ...seal(engine, join(folder, file), accountPoint),
      });
    } catch (error) {
      rmSync(join(folder, file), { force: true });
      manifest.failed.push({ id: account.id, name: account.name, error: (error as Error).message });
    }
  }
  const known = new Set(
    accounts.listAccounts().map((a) => basename(accountDatabasePath(directory, a.id))),
  );
  manifest.unknown = readdirSync(directory)
    .filter((name) => /^account-[A-Za-z0-9_-]{1,64}\.db$/.test(name) && !known.has(name))
    .sort();
  // Last, so every account in the copies has its row: a backup of accounts.db taken first could
  // miss an account created meanwhile.
  await engine.backup(accounts.db, join(folder, manifest.accountsFile));
  seal(engine, join(folder, manifest.accountsFile), () => undefined);
  // The manifest is written last: a folder without one is an unfinished backup.
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
  const path = absolute(file, "the backup file");
  let source: string;
  try {
    source = realpathSync(path);
  } catch {
    throw new AccountsError(`cannot restore: the backup file at ${path} is unavailable`);
  }
  const live = accountDatabasePath(options.directory, account.id);
  const copyStat = statSync(source, { bigint: true });
  const liveStat = statSync(live, { bigint: true, throwIfNoEntry: false });
  const name = basename(source);
  if (liveStat && copyStat.dev === liveStat.dev && copyStat.ino === liveStat.ino) {
    throw new AccountsError(`${name} is ${account.name}'s live database, not a backup`);
  }
  // The account's own backups, the copies restores keep, and storage upgrade snapshots.
  const expected = basename(live);
  const own =
    name === expected ||
    name.startsWith(`${expected}.replaced-`) ||
    new RegExp(`^${expected.replace(/[.]/g, "\\.")}\\.snapshot-v\\d+$`).test(name);
  if ((!own || copyStat.nlink > 1n) && !otherAccount) {
    throw new AccountsError(
      `${name} isn't a backup of ${account.name} (${expected}); add --other-account to restore it anyway`,
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
    contentBytes: count("SELECT coalesce(sum(length(CAST(content AS BLOB))), 0) AS n FROM records"),
    databaseBytes: count(
      "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
    ),
  };
}
