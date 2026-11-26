// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from "node:path";
import {
  type Contract,
  type JsonObject,
  leveContract,
  MAX_REVISION,
  s,
  validate,
} from "@leve/contract";
import type { SqlConnection, SqlEngine, SqlRow } from "./driver.ts";
import { readStorageMeta } from "./meta.ts";
import { serverWorkoutPlans } from "./migrations/1.0/storage-v2.ts";
import { storeSetEffort } from "./migrations/1.0/storage-v3.ts";
import { storeWorkoutJournals } from "./migrations/1.0/storage-v4.ts";
import { json, parseJson, transaction } from "./sql.ts";
import {
  type Checkpoint,
  hasPendingStorageUpgrade,
  integrityProblems,
  openStorage,
  type StorageDefinition,
  StorageRecoveryError,
  snapshotPath,
  type UpgradeStep,
} from "./upgrade.ts";

/*
 * One SQLite database per account on the server. Records hold current content or, once deleted,
 * a marker without content. Every accepted change takes the next value of the account's revision
 * counter in the same transaction, together with the submission's receipt.
 */

export const SERVER_STORAGE_VERSION = 4;

export const SERVER_SCHEMA_V1 = `
CREATE TABLE account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  lineage TEXT NOT NULL,
  restored_from TEXT,
  restore_point INTEGER,
  CHECK ((restored_from IS NULL) = (restore_point IS NULL))
);

CREATE TABLE records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('live', 'deleted')),
  content TEXT,
  parent_kind TEXT,
  parent_id TEXT,
  PRIMARY KEY (kind, id),
  CHECK ((state = 'live') = (content IS NOT NULL)),
  CHECK (state = 'live' OR (parent_kind IS NULL AND parent_id IS NULL))
);
CREATE INDEX records_parent ON records (parent_kind, parent_id);

CREATE TABLE receipts (
  submission_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE INDEX receipts_accepted_at ON receipts (accepted_at);
`;

export interface StoredRecord {
  kind: string;
  id: string;
  revision: number;
  state: "live" | "deleted";
  content: JsonObject | null;
}

export interface Receipt {
  submissionId: string;
  kind: string;
  id: string;
  revision: number;
  digest: string;
  acceptedAt: string;
  /** This exact submission wrote the revision. Older or equivalent-content receipts omit it. */
  wroteRevision?: true;
}

/** Only unconditional binary keys enforce the IDs used for record upserts and receipt replay. */
function hasUniqueBinaryKey(db: SqlConnection, table: string, ...names: string[]) {
  const indexes = db.all("SELECT name FROM pragma_index_list(?) WHERE [unique]=1 AND partial=0", [
    table,
  ]);
  const keys = indexes.map((index) =>
    db.all("SELECT name, coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno", [
      String(index.name),
    ]),
  );
  return keys.some(
    (columns) =>
      columns.length === names.length &&
      columns.every((column, i) => column.name === names[i] && column.coll === "BINARY"),
  );
}

export function serverStorageDefinition(
  options: { contract?: Contract; steps?: readonly UpgradeStep[] } = {},
): StorageDefinition {
  const contract = options.contract ?? leveContract;
  return {
    name: "server",
    version: SERVER_STORAGE_VERSION,
    oldestUpgradable: 1,
    create(db, context) {
      db.exec(SERVER_SCHEMA_V1);
      storeSetEffort.run(db);
      db.run("INSERT INTO account (id, revision, lineage) VALUES (1, 0, ?)", [context.randomId()]);
    },
    steps: options.steps ?? [serverWorkoutPlans, storeSetEffort, storeWorkoutJournals],
    countedTables: ["records", "receipts"],
    verify(db) {
      const problems: string[] = [];
      if (
        !hasUniqueBinaryKey(db, "records", "kind", "id") ||
        !hasUniqueBinaryKey(db, "records", "revision")
      )
        problems.push("invalid records identity or revision constraint");
      const receiptColumns = new Map(
        db.all("PRAGMA table_info(receipts)").map((column) => [column.name, column]),
      );
      // A stronger constraint (e.g. NOCASE) can still reject distinct requests despite the
      // binary key. Every supported receipt schema uses text IDs and one unique index.
      const uniqueReceiptIndexes = db.get(
        "SELECT count(*) AS n FROM pragma_index_list('receipts') WHERE [unique]=1",
      );
      // An INTEGER PRIMARY KEY on another column is a rowid alias, absent from index_list.
      const submissionKey = receiptColumns.get("submission_id");
      if (
        submissionKey?.type !== "TEXT" ||
        submissionKey.pk !== 1 ||
        uniqueReceiptIndexes?.n !== 1 ||
        !hasUniqueBinaryKey(db, "receipts", "submission_id")
      )
        problems.push("invalid receipt submission ID constraint");
      const required = ["submission_id", "kind", "id", "revision", "digest", "accepted_at"];
      if ((readStorageMeta(db)?.storageVersion ?? 0) >= 3) required.push("wrote_revision");
      for (const name of required) {
        if (!receiptColumns.has(name)) problems.push(`missing receipts.${name}`);
      }
      const proof = receiptColumns.get("wrote_revision");
      if (
        proof &&
        (proof.type !== "INTEGER" ||
          proof.notnull !== 0 ||
          proof.dflt_value !== null ||
          proof.pk !== 0)
      ) {
        problems.push("invalid receipts.wrote_revision");
      }
      const recordId = s.id();
      const revision = s.integer(1, MAX_REVISION);
      const records = db.all(`
        SELECT child.kind, child.id, child.revision, child.state, child.content, child.parent_kind, child.parent_id,
               instr(child.kind || child.id, char(0)) AS identity_nul, parent.state AS parent_state
        FROM records child
        LEFT JOIN records parent ON parent.kind = child.parent_kind AND parent.id = child.parent_id`);
      for (const row of records) {
        const kind = String(row.kind);
        if (
          // Older SQLite drivers truncate text at NUL when returning it to JS.
          row.identity_nul !== 0 ||
          !contract.hasKind(kind) ||
          validate(recordId, row.id).length ||
          (contract.kind(kind).singletonId !== undefined &&
            (contract.kind(kind).singletonId !== row.id || row.state === "deleted")) ||
          validate(revision, row.revision).length
        ) {
          problems.push(`${kind}/${String(row.id)}: invalid record identity or revision`);
          continue;
        }
        if (row.state === "deleted") continue;
        try {
          const content = JSON.parse(String(row.content));
          const issues = contract.validateContent(
            kind,
            contract.normalize(kind, content),
            String(row.id),
          );
          const record = `${kind}/${String(row.id)}`;
          if (issues.length > 0) {
            problems.push(`${record}: ${issues[0]?.message}`);
            continue;
          }
          const parent = contract.parentOf(kind, content);
          if ((parent?.kind ?? null) !== row.parent_kind || (parent?.id ?? null) !== row.parent_id)
            problems.push(`${record}: parent index differs from content`);
          else if (parent && row.parent_state !== "live")
            problems.push(`${record}: missing live parent`);
        } catch {
          problems.push(`${kind}/${String(row.id)}: invalid JSON`);
        }
      }
      for (const kind of contract.kindNames()) {
        const parent = contract.kind(kind).parent;
        if (!parent?.sharedId) continue;
        const orphan = db.get(
          `SELECT child.id FROM records child WHERE child.kind = ? AND child.state = 'deleted'
           AND NOT EXISTS (SELECT 1 FROM records owner WHERE owner.kind = ?
             AND owner.id = child.id AND owner.state = 'deleted') LIMIT 1`,
          [kind, parent.kind],
        );
        if (orphan) problems.push(`${kind}/${String(orphan.id)}: missing deleted parent`);
      }
      const account = db.get(
        "SELECT revision, lineage, instr(lineage,char(0)) AS lineage_nul FROM account WHERE id=1",
      );
      if (account?.lineage_nul !== 0 || validate(recordId, account.lineage).length)
        problems.push("invalid account lineage");
      if (validate(s.integer(0, MAX_REVISION), account?.revision).length)
        problems.push("invalid account revision");
      const head = Number(account?.revision);
      if (required.every((name) => receiptColumns.has(name))) {
        const revisionOwners = new Map(
          records.map((record) => [record.revision, record.kind + "/" + record.id]),
        );
        const writingRevisions = new Set<number>();
        const timestamp = s.dateTime();
        const receipts =
          db.all(`SELECT r.submission_id, r.revision, r.kind, r.id, r.digest, instr(r.digest,char(0)) AS digest_nul, owner.revision AS owner_revision,
          instr(r.submission_id,char(0)) AS submission_nul, r.accepted_at,
          instr(r.accepted_at,char(0)) AS time_nul, ${proof ? "r.wrote_revision" : "NULL"} AS wrote_revision
          FROM receipts r LEFT JOIN records owner ON owner.kind=r.kind AND owner.id=r.id`);
        for (const receipt of receipts) {
          const owner = receipt.kind + "/" + receipt.id;
          const known = revisionOwners.get(receipt.revision);
          if (
            receipt.submission_nul !== 0 ||
            receipt.digest_nul !== 0 ||
            typeof receipt.digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(receipt.digest) ||
            validate(recordId, receipt.submission_id).length ||
            validate(revision, receipt.revision).length ||
            receipt.owner_revision == null ||
            (known !== undefined && known !== owner) ||
            Number(receipt.revision) > Number(receipt.owner_revision)
          ) {
            problems.push("invalid receipt identity or revision");
            break;
          }
          if (receipt.time_nul !== 0 || validate(timestamp, receipt.accepted_at).length) {
            problems.push("invalid receipt timestamp");
            break;
          }
          if (receipt.wrote_revision !== null) {
            if (receipt.wrote_revision !== 1 || writingRevisions.has(Number(receipt.revision))) {
              problems.push("invalid proof or multiple writing receipts for one revision");
              break;
            }
            writingRevisions.add(Number(receipt.revision));
          }
          revisionOwners.set(receipt.revision, owner);
        }
      }
      const highest = Number(db.get("SELECT max(revision) AS r FROM records")?.r ?? 0);
      if (head !== highest)
        problems.push(`invalid account revision: expected ${highest}, found ${head}`);
      return problems;
    },
    unsyncedWork: () => false,
  };
}

function toStored(row: SqlRow): StoredRecord {
  return {
    kind: String(row.kind),
    id: String(row.id),
    revision: Number(row.revision),
    state: String(row.state) as "live" | "deleted",
    content: row.content === null ? null : parseJson<JsonObject>(row.content, "content"),
  };
}

/** Reads and writes inside one transaction of the account's database. */
export class ServerTransaction {
  readonly #db: SqlConnection;
  readonly #contract: Contract;

  constructor(db: SqlConnection, contract: Contract) {
    this.#db = db;
    this.#contract = contract;
  }

  get(kind: string, id: string): StoredRecord | null {
    const row = this.#db.get("SELECT * FROM records WHERE kind = ? AND id = ?", [kind, id]);
    return row ? toStored(row) : null;
  }

  headRevision(): number {
    return Number(this.#db.get("SELECT revision FROM account WHERE id = 1")?.revision ?? 0);
  }

  /** Stores live content under the next revision and returns that revision. */
  writeLive(kind: string, id: string, content: JsonObject): number {
    const revision = this.#nextRevision();
    const parent = this.#contract.parentOf(kind, content);
    this.#db.run(
      `INSERT INTO records (kind, id, revision, state, content, parent_kind, parent_id)
       VALUES (?, ?, ?, 'live', ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, state = 'live',
         content = excluded.content, parent_kind = excluded.parent_kind,
         parent_id = excluded.parent_id`,
      [kind, id, revision, json(content), parent?.kind ?? null, parent?.id ?? null],
    );
    return revision;
  }

  /** Replaces a record and, recursively, its live children with deletion markers. */
  writeDeleted(kind: string, id: string): number {
    for (const child of this.liveChildren(kind, id)) this.writeDeleted(child.kind, child.id);
    const revision = this.#nextRevision();
    this.#db.run(
      `INSERT INTO records (kind, id, revision, state, content, parent_kind, parent_id)
       VALUES (?, ?, ?, 'deleted', NULL, NULL, NULL)
       ON CONFLICT (kind, id) DO UPDATE SET revision = excluded.revision, state = 'deleted',
         content = NULL, parent_kind = NULL, parent_id = NULL`,
      [kind, id, revision],
    );
    return revision;
  }

  /** Every live record of a kind, in id order (the primary key's order). */
  live(kind: string): StoredRecord[] {
    return this.#db
      .all("SELECT * FROM records WHERE kind = ? AND state = 'live' ORDER BY id", [kind])
      .map(toStored);
  }

  /** Select workout roots before reading their children. Sync timestamps use canonical UTC. */
  liveWorkouts(query: WorkoutReadQuery): StoredRecord[] {
    const start = "json_extract(w.content, '$.startedAt')";
    const clauses = ["w.kind = 'workout'", "w.state = 'live'"];
    const args: string[] = [];
    if (query.from) {
      clauses.push(`${start} >= ?`);
      args.push(query.from);
    }
    if (query.to) {
      clauses.push(`${start} < ?`);
      args.push(query.to);
    }
    if (query.cursor) {
      clauses.push(`(${start} < ? OR (${start} = ? AND w.id > ?))`);
      args.push(query.cursor.startedAt, query.cursor.startedAt, query.cursor.id);
    }
    if (query.finished) clauses.push("json_extract(w.content, '$.endedAt') IS NOT NULL");
    if (query.exerciseId) {
      clauses.push(`EXISTS (
        SELECT 1 FROM records e
        WHERE e.parent_kind = 'workout' AND e.parent_id = w.id
          AND e.kind = 'workout_exercise' AND e.state = 'live'
          AND json_extract(e.content, '$.exerciseId') = ?
      )`);
      args.push(query.exerciseId);
    }
    return this.#db
      .all(
        `SELECT w.* FROM records w WHERE ${clauses.join(" AND ")}
       ORDER BY ${start} DESC, w.id ASC LIMIT ?`,
        [...args, query.limit ?? -1],
      )
      .map(toStored);
  }

  /** Exercise notes use a soft reference, so they're outside the indexed workout tree. */
  liveExerciseNotesForWorkout(workoutId: string): StoredRecord[] {
    return this.#db
      .all(
        "SELECT * FROM records WHERE kind = 'exercise_note' AND state = 'live' AND json_extract(content, '$.workoutId') = ?",
        [workoutId],
      )
      .map(toStored);
  }

  /** Bodyweight lookup needs measurements during the selected workouts and one preceding them. */
  liveBodyweightForWorkouts(first: string, last: string): StoredRecord[] {
    const time = "json_extract(content, '$.takenAt')";
    const bodyweight =
      "kind = 'body_measurement' AND state = 'live' AND json_extract(content, '$.bodyweightKg') IS NOT NULL";
    return this.#db
      .all(
        `SELECT * FROM records WHERE ${bodyweight} AND ${time} <= ? AND (
         ${time} >= ? OR id = (
          SELECT id FROM records WHERE ${bodyweight} AND ${time} < ?
          ORDER BY ${time} DESC, id DESC LIMIT 1
         )
       ) ORDER BY id`,
        [last, first, first],
      )
      .map(toStored);
  }

  liveChildren(kind: string, id: string, childKind?: string): StoredRecord[] {
    return this.#db
      .all(
        `SELECT * FROM records WHERE parent_kind = ? AND parent_id = ? AND state = 'live'${childKind === undefined ? "" : " AND kind = ?"}`,
        childKind === undefined ? [kind, id] : [kind, id, childKind],
      )
      .map(toStored);
  }

  #nextRevision(): number {
    this.#db.run("UPDATE account SET revision = revision + 1 WHERE id = 1");
    return this.headRevision();
  }

  receipt(submissionId: string): Receipt | null {
    const row = this.#db.get("SELECT * FROM receipts WHERE submission_id COLLATE BINARY = ?", [
      submissionId,
    ]);
    if (!row) return null;
    return {
      submissionId: String(row.submission_id),
      kind: String(row.kind),
      id: String(row.id),
      revision: Number(row.revision),
      digest: String(row.digest),
      ...(row.wrote_revision === 1 ? { wroteRevision: true as const } : {}),
      acceptedAt: String(row.accepted_at),
    };
  }

  saveReceipt(receipt: Receipt): void {
    const proof = receipt.wroteRevision === true;
    this.#db.run(
      `INSERT INTO receipts (submission_id, kind, id, revision, digest, accepted_at${proof ? ", wrote_revision" : ""})
       VALUES (?, ?, ?, ?, ?, ?${proof ? ", 1" : ""})`,
      [
        receipt.submissionId,
        receipt.kind,
        receipt.id,
        receipt.revision,
        receipt.digest,
        receipt.acceptedAt,
      ],
    );
  }

  /**
   * Gives the account a new lineage, so devices reset instead of trusting old revisions. Where the
   * histories split is unknown here (for example after files were copied back), so no restore
   * point is kept.
   */
  setLineage(lineage: string): void {
    this.#db.run(
      "UPDATE account SET lineage = ?, restored_from = NULL, restore_point = NULL WHERE id = 1",
      [lineage],
    );
  }

  lineage(): string {
    return String(this.#db.get("SELECT lineage FROM account WHERE id = 1")?.lineage);
  }

  /** Forgets receipts accepted before `cutoff` (an ISO timestamp). */
  pruneReceipts(cutoff: string): number {
    return this.#db.run("DELETE FROM receipts WHERE accepted_at < ?", [cutoff]).changes;
  }
}

export interface WorkoutReadQuery {
  from?: string;
  to?: string;
  cursor?: { startedAt: string; id: string };
  finished?: boolean;
  exerciseId?: string;
  limit?: number;
}

/** One account's database. */
export class ServerAccountStore {
  readonly db: SqlConnection;
  readonly contract: Contract;

  constructor(db: SqlConnection, contract: Contract) {
    this.db = db;
    this.contract = contract;
  }

  /** Runs `fn` in one write transaction. Any error rolls back every write it made. */
  transaction<T>(fn: (tx: ServerTransaction) => T): T {
    return transaction(this.db, () => fn(new ServerTransaction(this.db, this.contract)));
  }

  headRevision(): number {
    return Number(this.db.get("SELECT revision FROM account WHERE id = 1")?.revision ?? 0);
  }

  /** The account history's id; a restore from backup gives it a new one. */
  lineage(): string {
    return String(this.db.get("SELECT lineage FROM account WHERE id = 1")?.lineage);
  }

  /**
   * After a restore from a backup: the lineage the backup belonged to and its revision. Revisions
   * up to it mean the same in that lineage and the current one. Null when the account was never
   * restored, or the split point is unknown.
   */
  restoredFrom(): { lineage: string; restorePoint: number } | null {
    const row = this.db.get("SELECT restored_from, restore_point FROM account WHERE id = 1");
    if (!row || row.restored_from === null || row.restore_point === null) return null;
    return { lineage: String(row.restored_from), restorePoint: Number(row.restore_point) };
  }

  /** Records changed after `cursor`, in revision order. */
  changesAfter(cursor: number, limit: number): { records: StoredRecord[]; hasMore: boolean } {
    const rows = this.db
      .all("SELECT * FROM records WHERE revision > ? ORDER BY revision LIMIT ?", [
        cursor,
        limit + 1,
      ])
      .map(toStored);
    return { records: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  close(): void {
    this.db.close();
  }
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class AccountIdError extends Error {
  override name = "AccountIdError";
}

export function accountDatabasePath(directory: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new AccountIdError("invalid account id");
  return join(directory, `account-${accountId}.db`);
}

export interface RestoreResult {
  /** A copy of the database the restore replaced, or null if the account had none. */
  replaced: string | null;
}

export interface ServerStorageOptions {
  engine: SqlEngine;
  directory: string;
  appVersion: string;
  contract?: Contract;
  definition?: StorageDefinition;
  onCheckpoint?: (point: Checkpoint, count: number) => void;
}

/**
 * Opens account databases on demand, upgrading each before its first use. A failure opening one
 * account (for example a failed upgrade) affects only that account.
 */
export class ServerStorage {
  readonly #options: ServerStorageOptions;
  readonly #open = new Map<string, Promise<ServerAccountStore>>();
  readonly #restoring = new Set<string>();

  constructor(options: ServerStorageOptions) {
    this.#options = options;
  }

  account(accountId: string): Promise<ServerAccountStore> {
    let opening = this.#open.get(accountId);
    if (!opening) {
      opening = this.#openAccount(accountId);
      this.#open.set(accountId, opening);
      opening.catch(() => this.#open.delete(accountId));
    }
    return opening;
  }

  async #openAccount(accountId: string): Promise<ServerAccountStore> {
    const contract = this.#options.contract ?? leveContract;
    const opened = await openStorage({
      engine: this.#options.engine,
      path: accountDatabasePath(this.#options.directory, accountId),
      definition: this.#options.definition ?? serverStorageDefinition({ contract }),
      appVersion: this.#options.appVersion,
      ...(this.#options.onCheckpoint ? { onCheckpoint: this.#options.onCheckpoint } : {}),
    });
    return new ServerAccountStore(opened.db, contract);
  }

  /**
   * Restores an account from a backup made with SQLite's backup (for example a pre-upgrade
   * snapshot) and gives it a new lineage, so devices download everything again instead of trusting
   * revisions from the history that was rolled back. The backup is checked before anything is
   * replaced, the replaced database is kept next to it, and requests for the account wait until
   * the restore is done.
   */
  restoreAccount(
    accountId: string,
    backupPath: string,
    options: { randomId?: () => string; now?: () => Date } = {},
  ): Promise<RestoreResult> {
    if (this.#restoring.has(accountId)) {
      return Promise.reject(new StorageRecoveryError(`${accountId} is already being restored`));
    }
    this.#restoring.add(accountId);
    const previous = this.#open.get(accountId);
    let previousClosed = false;
    const closePrevious = async () => {
      previousClosed = true;
      if (previous) (await previous.catch(() => null))?.close();
    };
    const restoring = this.#restore(accountId, backupPath, closePrevious, options).finally(() =>
      this.#restoring.delete(accountId),
    );
    // A refused restore leaves the account as it was: requests that waited get the open one.
    const reopened = restoring.then(
      () => this.#openAccount(accountId),
      (error) => {
        if (previous && !previousClosed) return previous;
        throw error;
      },
    );
    this.#open.set(accountId, reopened);
    reopened.catch(() => {
      if (this.#open.get(accountId) === reopened) this.#open.delete(accountId);
    });
    return restoring;
  }

  async #restore(
    accountId: string,
    backupPath: string,
    closePrevious: () => Promise<void>,
    options: { randomId?: () => string; now?: () => Date },
  ): Promise<RestoreResult> {
    const { engine } = this.#options;
    const checkpoint = this.#options.onCheckpoint ?? (() => {});
    const definition =
      this.#options.definition ??
      serverStorageDefinition({ contract: this.#options.contract ?? leveContract });
    const path = accountDatabasePath(this.#options.directory, accountId);
    const staging = `${path}.restore`;
    const discardStaging = () => {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) engine.remove(staging + suffix);
    };
    discardStaging();
    // A previous process may have stopped while checking an older backup in staging.
    for (let version = definition.oldestUpgradable; version < definition.version; version++) {
      const snapshot = snapshotPath(staging, version);
      engine.remove(snapshot);
      engine.remove(`${snapshot}.tmp`);
    }
    let sourceVersion: number;
    let source: SqlConnection;
    try {
      source = engine.open(backupPath, { readOnly: true });
    } catch (error) {
      throw new StorageRecoveryError(
        `cannot restore from ${backupPath}: ${(error as Error).message}`,
      );
    }
    try {
      const problems = integrityProblems(source);
      let meta: ReturnType<typeof readStorageMeta> = null;
      try {
        meta = readStorageMeta(source);
      } catch (error) {
        problems.push((error as Error).message);
      }
      if (!meta) problems.push("not a Leve server database");
      else if (meta.storageVersion > definition.version) {
        problems.push(`storage version ${meta.storageVersion} is newer than this server`);
      } else if (meta.storageVersion < definition.oldestUpgradable) {
        problems.push(`storage version ${meta.storageVersion} is too old to upgrade`);
      }
      if (!meta || problems.length > 0) {
        throw new StorageRecoveryError(`cannot restore from ${backupPath}: ${problems.join("; ")}`);
      }
      sourceVersion = meta.storageVersion;
      await engine.backup(source, staging, (step) => checkpoint("account-restore:step", step));
    } finally {
      source.close();
    }
    // The online backup can observe a newer snapshot than the source preflight.
    // Verify the staged image that will actually replace the live account.
    try {
      const staged = engine.open(staging, { readOnly: true });
      try {
        const problems = integrityProblems(staged);
        if (readStorageMeta(staged)?.storageVersion !== sourceVersion)
          problems.push("storage version changed during backup");
        else if (hasPendingStorageUpgrade(staged))
          problems.push("backup contains an unfinished storage upgrade");
        else if (sourceVersion === definition.version) problems.push(...definition.verify(staged));
        if (problems.length) throw new Error(problems.join("; "));
      } finally {
        staged.close();
      }
    } catch (error) {
      discardStaging();
      throw new StorageRecoveryError(
        `cannot restore from ${backupPath}: ${(error as Error).message}`,
      );
    }
    if (sourceVersion < definition.version) {
      // Verify the upgrade on the disposable copy before closing or replacing the live account.
      try {
        const upgraded = await openStorage({
          engine,
          path: staging,
          definition,
          appVersion: this.#options.appVersion,
        });
        upgraded.db.close();
      } catch (error) {
        discardStaging();
        throw new StorageRecoveryError(
          `cannot restore from ${backupPath}: ${(error as Error).message}`,
        );
      } finally {
        engine.remove(snapshotPath(staging, sourceVersion));
        engine.remove(`${snapshotPath(staging, sourceVersion)}.tmp`);
      }
    }
    const copy = engine.open(staging);
    try {
      // The backup's own lineage and revision say where the restored history splits off.
      copy.run(
        `UPDATE account SET restored_from = lineage, restore_point = revision, lineage = ?
         WHERE id = 1`,
        [(options.randomId ?? (() => crypto.randomUUID()))()],
      );
    } finally {
      copy.close();
    }
    checkpoint("account-restore:staged", 1);

    // Requests for the account wait for `reopened`; close what was open before.
    await closePrevious();
    let replaced: string | null = null;
    if (engine.exists(path)) {
      const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
      replaced = `${path}.replaced-${stamp}`;
      const live = engine.open(path);
      try {
        await engine.backup(live, replaced);
      } finally {
        live.close();
      }
      checkpoint("account-restore:kept", 1);
    }
    // A journal left by the replaced database must never be applied to the restored one.
    engine.remove(`${path}-journal`);
    engine.remove(`${path}-wal`);
    engine.remove(`${path}-shm`);
    checkpoint("account-restore:cleared", 1);
    engine.rename(staging, path);
    checkpoint("account-restore:renamed", 1);
    return { replaced };
  }

  async close(): Promise<void> {
    const stores = await Promise.allSettled(this.#open.values());
    this.#open.clear();
    for (const store of stores) if (store.status === "fulfilled") store.value.close();
  }
}
