// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection, SqlEngine } from "@leve/storage";
import type { Authenticator } from "@leve/sync/server";

/*
 * Who may sync with a self-hosted server: the accounts its operator created and the phones paired
 * with them. A phone pairs once with a short-lived code the operator hands out, and from then on
 * signs in with a device token of its own. The server keeps only hashes of codes and tokens, so a
 * copy of this database can't be used to sign in. Account data lives in the account databases;
 * this file only says who reaches which one.
 */

/** This database's layout. A server refuses a database written by a newer one. */
export const ACCOUNTS_VERSION = 1;
/** How long a pairing code works. */
export const PAIRING_MS = 15 * 60_000;
/** How often a device's last use is written, so syncing isn't a write per request. */
const LAST_USED_EVERY_MS = 60 * 60_000;

const SCHEMA = `
CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX devices_account ON devices(account_id);
CREATE TABLE pairings (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
`;

/** Account names are for the operator: short, printable, no surprises in a terminal. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u;
/** What a phone calls itself; shown in the device list. */
const MAX_DEVICE_NAME = 64;
/** Account ids look like this; a name never does, so a name can never be mistaken for an id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A phone chooses its own name, and the operator reads it in a terminal: control characters and
 * other invisible ones go, and it is cut by characters, not UTF-16 units.
 */
export function cleanDeviceName(name: string): string {
  const visible = name
    .replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...visible].slice(0, MAX_DEVICE_NAME).join("").trim() || "Phone";
}

export class AccountsError extends Error {
  override name = "AccountsError";
}

export interface Account {
  id: string;
  name: string;
  createdAt: string;
  devices: number;
}

export interface Device {
  id: string;
  account: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
/** 256 bits for tokens, 128 for codes that live 15 minutes; base64url, so safe in a URL. */
const secret = (bytes: number) => randomBytes(bytes).toString("base64url");

export interface AccountsOptions {
  engine: SqlEngine;
  path: string;
  now?: () => Date;
}

export class Accounts {
  readonly #db: SqlConnection;
  readonly #now: () => Date;
  /** When each device's last use was written, so it is written about once an hour. */
  readonly #touched = new Map<string, number>();

  private constructor(db: SqlConnection, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  /** Opens the database, creating it on first start. Refuses one from a newer server. */
  static open(options: AccountsOptions): Accounts {
    const { engine, path } = options;
    const fresh = !engine.exists(path);
    const db = engine.open(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      if (fresh || !db.get("SELECT 1 FROM sqlite_master WHERE name = 'meta'")) {
        transaction(db, () => {
          db.exec(SCHEMA);
          db.run("INSERT INTO meta (id, version) VALUES (1, ?)", [ACCOUNTS_VERSION]);
        });
      }
      const version = Number(db.get("SELECT version FROM meta WHERE id = 1")?.version);
      if (version !== ACCOUNTS_VERSION) {
        throw new AccountsError(
          version > ACCOUNTS_VERSION
            ? `${path} was written by a newer Leve server (version ${version}); update this one`
            : `${path} has an unknown version ${version}`,
        );
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new Accounts(db, options.now ?? (() => new Date()));
  }

  close(): void {
    this.#db.close();
  }

  /** The connection, for backups. */
  get db(): SqlConnection {
    return this.#db;
  }

  addAccount(name: string): Account {
    const trimmed = name.trim();
    if (!NAME.test(trimmed) || UUID.test(trimmed)) {
      throw new AccountsError(
        "an account name is 1 to 64 letters, digits, spaces or . _ ' -, starting with a letter or digit",
      );
    }
    if (this.#db.get("SELECT 1 FROM accounts WHERE name = ?", [trimmed])) {
      throw new AccountsError(`there is already an account named ${trimmed}`);
    }
    // The id names the account's database file; it never comes from the operator or a phone.
    const id = randomUUID();
    const createdAt = this.#now().toISOString();
    this.#db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
      id,
      trimmed,
      createdAt,
    ]);
    return { id, name: trimmed, createdAt, devices: 0 };
  }

  listAccounts(): Account[] {
    return this.#db
      .all(
        `SELECT a.id, a.name, a.created_at, count(d.id) AS devices
         FROM accounts a LEFT JOIN devices d ON d.account_id = a.id
         GROUP BY a.id ORDER BY a.name`,
      )
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        createdAt: String(row.created_at),
        devices: Number(row.devices),
      }));
  }

  /** An account by its id or its name. */
  findAccount(nameOrId: string): Account | null {
    const all = this.listAccounts();
    return all.find((a) => a.id === nameOrId) ?? all.find((a) => a.name === nameOrId) ?? null;
  }

  #account(nameOrId: string): Account {
    const account = this.findAccount(nameOrId);
    if (!account) throw new AccountsError(`no account named ${nameOrId}`);
    return account;
  }

  /**
   * A one-time code that pairs one phone with the account. Codes run out after PAIRING_MS;
   * expired ones are cleared as new ones are made.
   */
  createPairing(nameOrId: string): { code: string; account: Account; expiresAt: string } {
    const account = this.#account(nameOrId);
    const now = this.#now();
    const code = secret(16);
    const expiresAt = new Date(now.getTime() + PAIRING_MS).toISOString();
    transaction(this.#db, () => {
      this.#db.run("DELETE FROM pairings WHERE expires_at <= ?", [now.toISOString()]);
      this.#db.run("INSERT INTO pairings (code_hash, account_id, expires_at) VALUES (?, ?, ?)", [
        hash(code),
        account.id,
        expiresAt,
      ]);
    });
    return { code, account, expiresAt };
  }

  /**
   * Trades a pairing code for a new device of its account. The code works once: it is deleted in
   * the same transaction that adds the device. Null when the code is unknown, used or expired.
   */
  pair(
    code: string,
    deviceName: string,
  ): { account: string; device: string; token: string } | null {
    if (typeof code !== "string" || code.length === 0 || code.length > 64) return null;
    const name = cleanDeviceName(deviceName);
    const now = this.#now().toISOString();
    const token = secret(32);
    const device = randomUUID();
    return transaction(this.#db, () => {
      const row = this.#db.get(
        "SELECT account_id FROM pairings WHERE code_hash = ? AND expires_at > ?",
        [hash(code), now],
      );
      // Used or not, an expired code goes.
      this.#db.run("DELETE FROM pairings WHERE code_hash = ?", [hash(code)]);
      if (!row) return null;
      const account = String(row.account_id);
      this.#db.run(
        "INSERT INTO devices (id, account_id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
        [device, account, name, hash(token), now, now],
      );
      return { account, device, token };
    });
  }

  /** Paired devices, of one account or of all. */
  listDevices(nameOrId?: string): Device[] {
    const account = nameOrId === undefined ? null : this.#account(nameOrId);
    return this.#db
      .all(
        `SELECT id, account_id, name, created_at, last_used_at FROM devices
         ${account ? "WHERE account_id = ?" : ""} ORDER BY created_at`,
        account ? [account.id] : [],
      )
      .map((row) => ({
        id: String(row.id),
        account: String(row.account_id),
        name: String(row.name),
        createdAt: String(row.created_at),
        lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      }));
  }

  /** Signs one device out for good; its token stops working at once. */
  revokeDevice(id: string): boolean {
    this.#touched.delete(id);
    return this.#db.run("DELETE FROM devices WHERE id = ?", [id]).changes > 0;
  }

  /** Signs every device of an account out, and drops its open pairing codes. */
  revokeAllDevices(nameOrId: string): number {
    const account = this.#account(nameOrId);
    return transaction(this.#db, () => {
      this.#db.run("DELETE FROM pairings WHERE account_id = ?", [account.id]);
      return this.#db.run("DELETE FROM devices WHERE account_id = ?", [account.id]).changes;
    });
  }

  /** Signs every device of every account out and drops all pairing codes: the off switch. */
  revokeEveryDevice(): number {
    this.#touched.clear();
    return transaction(this.#db, () => {
      this.#db.run("DELETE FROM pairings");
      return this.#db.run("DELETE FROM devices").changes;
    });
  }

  /** The device a token belongs to, or null. */
  deviceForToken(token: string): { account: string; device: string; name: string } | null {
    const row = this.#db.get("SELECT id, account_id, name FROM devices WHERE token_hash = ?", [
      hash(token),
    ]);
    if (!row) return null;
    const device = String(row.id);
    const now = this.#now();
    const last = this.#touched.get(device) ?? 0;
    if (now.getTime() - last > LAST_USED_EVERY_MS) {
      this.#touched.set(device, now.getTime());
      this.#db.run("UPDATE devices SET last_used_at = ? WHERE id = ?", [now.toISOString(), device]);
    }
    return { account: String(row.account_id), device, name: String(row.name) };
  }
}

function transaction<T>(db: SqlConnection, fn: () => T): T {
  if (db.transaction) return db.transaction(fn);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Signs phones in with their device token. The account is the one the token was paired with; a
 * request can't name another.
 */
export function deviceAuthenticator(accounts: Accounts): Authenticator {
  return async (token) => {
    const device = accounts.deviceForToken(token);
    if (!device) return { refused: true };
    return {
      principal: {
        account: device.account,
        client: { kind: "device", id: device.device, name: device.name },
      },
    };
  };
}
