import type { SqlConnection, SqlEngine, SqlValue } from "./driver.ts";
import { META_TABLE_SQL, readStorageMeta, type StorageMeta, writeStorageMeta } from "./meta.ts";

export function rollbackQuietly(db: SqlConnection): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction was active.
  }
}

/** Moves storage from version `from` to `from + 1`. Runs inside the upgrade transaction. */
export interface UpgradeStep {
  from: number;
  description: string;
  run(db: SqlConnection): void;
}

export interface CreateContext {
  randomId(): string;
}

/** One side's storage format: how to create it at the current version and how to upgrade to it. */
export interface StorageDefinition {
  name: string;
  version: number;
  /** The oldest stored version this build can upgrade from. */
  oldestUpgradable: number;
  /** Creates every table at `version`, except the metadata record. */
  create(db: SqlConnection, context: CreateContext): void;
  steps: readonly UpgradeStep[];
  /** Tables whose row counts an upgrade must preserve. They exist at every supported version. */
  countedTables: readonly string[];
  /** Decodes all stored content at `version` and returns the problems found. */
  verify(db: SqlConnection): string[];
  /** Additional invariants that need the unchanged pre-upgrade copy. */
  verifyPreserved?(before: SqlConnection, after: SqlConnection): string[];
  /** Value of the unsynced-work flag, computed from stored data at `version`. */
  unsyncedWork(db: SqlConnection): boolean;
}

/** Points where tests inject crashes. Production code never passes a hook. */
export type Checkpoint =
  | "snapshot:step"
  | "snapshot:written"
  | "snapshot:ready"
  | "upgrade:write"
  | "upgrade:committed"
  | "verify:passed"
  | "restore:step"
  | "restore:done"
  | "account-restore:step"
  | "account-restore:staged"
  | "account-restore:kept"
  | "account-restore:cleared"
  | "account-restore:renamed";

export interface OpenStorageOptions {
  engine: SqlEngine;
  path: string;
  definition: StorageDefinition;
  appVersion: string;
  randomId?: () => string;
  onCheckpoint?: (point: Checkpoint, count: number) => void;
}

export interface OpenedStorage {
  db: SqlConnection;
  meta: StorageMeta;
  /** Set when this open upgraded the storage. */
  upgradedFrom?: number;
}

/** Storage newer than this build. Only SQLite's required hot-journal recovery may have written. */
export class StorageTooNewError extends Error {
  override name = "StorageTooNewError";
  readonly found: StorageMeta;
  readonly supported: number;
  constructor(path: string, found: StorageMeta, supported: number) {
    super(
      `${path} uses storage version ${found.storageVersion} (written by ${found.appVersion}); ` +
        `this build reads up to version ${supported}`,
    );
    this.found = found;
    this.supported = supported;
  }
}

/** Storage too old to upgrade. Only SQLite's required hot-journal recovery may have written. */
export class StorageTooOldError extends Error {
  override name = "StorageTooOldError";
}

/**
 * An upgrade failed. The data is as it was before the upgrade: either the upgrade transaction
 * rolled back, or verification failed and the snapshot was restored.
 */
export class UpgradeFailedError extends Error {
  override name = "UpgradeFailedError";
  readonly from: number;
  readonly to: number;
  readonly problems: readonly string[];
  readonly restoredSnapshot: boolean;
  constructor(from: number, to: number, problems: readonly string[], restoredSnapshot: boolean) {
    super(`storage upgrade ${from} → ${to} failed: ${problems.slice(0, 5).join("; ")}`);
    this.from = from;
    this.to = to;
    this.problems = problems;
    this.restoredSnapshot = restoredSnapshot;
  }
}

/** Recovery could not finish, for example because its snapshot is missing or damaged. */
export class StorageRecoveryError extends Error {
  override name = "StorageRecoveryError";
}

export function snapshotPath(path: string, version: number): string {
  return `${path}.snapshot-v${version}`;
}

/** Recorded in the upgrade transaction and cleared once the result has been verified. */
interface UpgradeMarker {
  from: number;
  to: number;
  counts: Record<string, number>;
}

const MARKER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS storage_upgrade (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  counts TEXT NOT NULL
)`;

function readMarker(db: SqlConnection): UpgradeMarker | null {
  const table = db.get(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'storage_upgrade'",
  );
  if (!table) return null;
  const row = db.get("SELECT from_version, to_version, counts FROM storage_upgrade WHERE id = 1");
  if (!row) return null;
  return {
    from: Number(row.from_version),
    to: Number(row.to_version),
    counts: JSON.parse(String(row.counts)) as Record<string, number>,
  };
}

export function hasPendingStorageUpgrade(db: SqlConnection): boolean {
  return readMarker(db) !== null;
}

function countRows(db: SqlConnection, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = Number(db.get(`SELECT count(*) AS n FROM "${table}"`)?.n ?? 0);
  }
  return counts;
}

/** SQLite's integrity check; damage bad enough to stop the check is reported as a problem too. */
export function integrityProblems(db: SqlConnection): string[] {
  try {
    const rows = db.all("PRAGMA integrity_check");
    const messages = rows.map((row) => String(Object.values(row)[0]));
    if (messages.length !== 1 || messages[0] !== "ok") return messages;
    // integrity_check does not look at foreign keys.
    return db
      .all("PRAGMA foreign_key_check")
      .map((row) => `foreign key violation in ${String(row.table)} row ${String(row.rowid)}`);
  } catch (error) {
    return [`integrity check failed: ${(error as Error).message}`];
  }
}

/** A connection that reports every write made through it. */
function countingWrites(db: SqlConnection, onWrite: (count: number) => void): SqlConnection {
  let writes = 0;
  const wrote = () => {
    writes += 1;
    onWrite(writes);
  };
  return {
    path: db.path,
    exec(sql) {
      db.exec(sql);
      wrote();
    },
    run(sql, params?: readonly SqlValue[]) {
      const result = db.run(sql, params);
      wrote();
      return result;
    },
    all: (sql, params) => db.all(sql, params),
    get: (sql, params) => db.get(sql, params),
    close: () => db.close(),
  };
}

function checkDefinition(definition: StorageDefinition): void {
  const { version, oldestUpgradable, steps } = definition;
  if (!Number.isInteger(version) || version < 1 || oldestUpgradable > version) {
    throw new Error(`invalid storage definition ${definition.name}`);
  }
  for (let from = oldestUpgradable; from < version; from++) {
    if (steps.filter((step) => step.from === from).length !== 1) {
      throw new Error(`${definition.name} storage needs exactly one upgrade step from ${from}`);
    }
  }
}

/**
 * Finishes SQLite's own crash recovery. A process killed during a large write leaves a journal
 * that only a read-write connection can roll back; until then no read-only connection can read
 * the file. Rolling back only returns the file to its last committed state, which is what any
 * build (including a newer one) does on its first read. Nothing else is written.
 */
export function recoverInterruptedWrite(engine: SqlEngine, path: string): void {
  if (!engine.exists(`${path}-journal`) && !engine.exists(`${path}-wal`)) return;
  // A readable WAL must stay untouched until the storage version has been checked. A sidecar's
  // existence alone does not mean recovery is necessary.
  try {
    const inspect = engine.open(path, { readOnly: true, exclusiveInspection: true });
    try {
      inspect.get("SELECT count(*) AS n FROM sqlite_master");
    } finally {
      inspect.close();
    }
    return;
  } catch (error) {
    // SQLITE_READONLY_ROLLBACK: SQLite could read only after rolling back a hot journal.
    if ((error as { errcode?: number }).errcode !== 776) throw error;
  }
  const db = engine.open(path);
  try {
    db.get("SELECT count(*) AS n FROM sqlite_master");
  } finally {
    db.close();
  }
}

/**
 * Opens storage, creating or upgrading it first. Storage written by a newer build is refused
 * without modifying the file (apart from SQLite finishing the rollback of an interrupted write,
 * see `recoverInterruptedWrite`). Upgrades follow a fixed sequence: snapshot with SQLite's
 * backup, all steps in one transaction, verify, and restore the snapshot if verification fails.
 *
 * Nothing else may have the file open while this runs.
 */
export async function openStorage(options: OpenStorageOptions): Promise<OpenedStorage> {
  const { engine, path, definition } = options;
  checkDefinition(definition);

  let meta: StorageMeta | null = null;
  let marker: UpgradeMarker | null = null;
  if (engine.exists(path)) {
    recoverInterruptedWrite(engine, path);
    const inspect = engine.open(path, { readOnly: true, exclusiveInspection: true });
    try {
      meta = readStorageMeta(inspect);
      if (meta && meta.storageVersion > definition.version) {
        throw new StorageTooNewError(path, meta, definition.version);
      }
      marker = meta ? readMarker(inspect) : null;
    } finally {
      inspect.close();
    }
  }
  if (!meta) return create(options);

  let version = meta.storageVersion;
  let upgradedFrom: number | undefined;
  const tooOld = (found: number) =>
    new StorageTooOldError(
      `${path} uses storage version ${found}; this build upgrades from ${definition.oldestUpgradable}`,
    );
  if (marker && marker.to !== definition.version && marker.from < definition.oldestUpgradable) {
    throw tooOld(marker.from);
  }
  if (marker) {
    // A previous run committed an upgrade but did not finish verifying it.
    if (marker.to === definition.version) {
      await finishUpgrade(options, marker);
      upgradedFrom = marker.from;
    } else {
      // Written by another build; verify by restoring and upgrading again with this build.
      await restoreSnapshot(options, snapshotPath(options.path, marker.from));
      version = marker.from;
    }
  }
  if (version < definition.version) {
    if (version < definition.oldestUpgradable) throw tooOld(version);
    await upgrade(options, version);
    upgradedFrom = version;
  }

  const db = engine.open(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = readStorageMeta(db);
      if (current && current.appVersion !== options.appVersion) {
        writeStorageMeta(db, { ...current, appVersion: options.appVersion });
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
    const opened = readStorageMeta(db);
    if (!opened) throw new Error("storage metadata is missing");
    return upgradedFrom === undefined ? { db, meta: opened } : { db, meta: opened, upgradedFrom };
  } catch (error) {
    db.close();
    throw error;
  }
}

function create(options: OpenStorageOptions): OpenedStorage {
  const { engine, path, definition } = options;
  const db = engine.open(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(META_TABLE_SQL);
      definition.create(db, { randomId: options.randomId ?? (() => crypto.randomUUID()) });
      const meta: StorageMeta = {
        storageVersion: definition.version,
        appVersion: options.appVersion,
        unsyncedWork: false,
      };
      writeStorageMeta(db, meta);
      db.exec("COMMIT");
      return { db, meta };
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

async function upgrade(options: OpenStorageOptions, from: number): Promise<void> {
  const { engine, path, definition } = options;
  const checkpoint = options.onCheckpoint ?? (() => {});
  const snapshot = snapshotPath(path, from);
  const pending = `${snapshot}.tmp`;

  const db = engine.open(path);
  try {
    // 1. Snapshot. A crash here leaves only an incomplete temporary file, removed on retry.
    engine.remove(pending);
    engine.remove(`${pending}-journal`);
    await engine.backup(db, pending, (step) => checkpoint("snapshot:step", step));
    checkpoint("snapshot:written", 1);
    const copy = engine.open(pending, { readOnly: true });
    try {
      const problems = integrityProblems(copy);
      if (readStorageMeta(copy)?.storageVersion !== from) problems.push("wrong version");
      if (problems.length > 0) {
        throw new UpgradeFailedError(from, definition.version, ["snapshot", ...problems], false);
      }
    } finally {
      copy.close();
    }
    engine.rename(pending, snapshot);
    checkpoint("snapshot:ready", 1);

    // 2. Every step and the marker in one transaction.
    db.exec("BEGIN IMMEDIATE");
    try {
      const counts = countRows(db, definition.countedTables);
      const tx = countingWrites(db, (count) => checkpoint("upgrade:write", count));
      for (let version = from; version < definition.version; version++) {
        const step = definition.steps.find((s) => s.from === version);
        step?.run(tx);
      }
      tx.exec(MARKER_TABLE_SQL);
      tx.run(
        "INSERT INTO storage_upgrade (id, from_version, to_version, counts) VALUES (1, ?, ?, ?)",
        [from, definition.version, JSON.stringify(counts)],
      );
      writeStorageMeta(tx, {
        storageVersion: definition.version,
        appVersion: options.appVersion,
        unsyncedWork: definition.unsyncedWork(tx),
      });
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      if (error instanceof UpgradeFailedError) throw error;
      throw new UpgradeFailedError(from, definition.version, [String(error)], false);
    }
    checkpoint("upgrade:committed", 1);
  } finally {
    db.close();
  }

  // 3. Verify, restoring the snapshot on failure.
  const marker = readMarkerFrom(engine, path);
  if (!marker) throw new Error("upgrade marker is missing after commit");
  await finishUpgrade(options, marker);
}

function readMarkerFrom(engine: SqlEngine, path: string): UpgradeMarker | null {
  const db = engine.open(path, { readOnly: true });
  try {
    return readMarker(db);
  } finally {
    db.close();
  }
}

function verify(db: SqlConnection, definition: StorageDefinition, marker: UpgradeMarker): string[] {
  const problems = integrityProblems(db);
  if (problems.length > 0) return problems;
  const version = readStorageMeta(db)?.storageVersion;
  if (version !== marker.to) problems.push(`storage version is ${version}, expected ${marker.to}`);
  const counts = countRows(db, definition.countedTables);
  for (const table of definition.countedTables) {
    if (counts[table] !== marker.counts[table]) {
      problems.push(`${table} has ${counts[table]} rows, expected ${marker.counts[table]}`);
    }
  }
  problems.push(...definition.verify(db));
  return problems;
}

async function finishUpgrade(options: OpenStorageOptions, marker: UpgradeMarker): Promise<void> {
  const { engine, path, definition } = options;
  const checkpoint = options.onCheckpoint ?? (() => {});
  const db = engine.open(path);
  let problems: string[];
  try {
    try {
      problems = verify(db, definition, marker);
      if (problems.length === 0 && definition.verifyPreserved) {
        const snapshot = engine.open(snapshotPath(path, marker.from), { readOnly: true });
        try {
          problems.push(...definition.verifyPreserved(snapshot, db));
        } finally {
          snapshot.close();
        }
      }
    } catch (error) {
      problems = [String(error)];
    }
    if (problems.length === 0) {
      checkpoint("verify:passed", 1);
      db.run("DELETE FROM storage_upgrade WHERE id = 1");
    }
  } finally {
    db.close();
  }
  if (problems.length === 0) {
    // The snapshot of this upgrade is kept until the next one succeeds; older ones go now.
    for (let version = 1; version < marker.from; version++) {
      engine.remove(snapshotPath(path, version));
    }
    return;
  }
  await restoreSnapshot(options, snapshotPath(options.path, marker.from));
  throw new UpgradeFailedError(marker.from, marker.to, problems, true);
}

async function restoreSnapshot(options: OpenStorageOptions, snapshot: string): Promise<void> {
  const { engine, path } = options;
  const checkpoint = options.onCheckpoint ?? (() => {});
  if (!engine.exists(snapshot)) {
    throw new StorageRecoveryError(`cannot restore ${path}: snapshot ${snapshot} is missing`);
  }
  const source = engine.open(snapshot, { readOnly: true });
  try {
    const problems = integrityProblems(source);
    if (problems.length > 0) {
      throw new StorageRecoveryError(`snapshot ${snapshot} is damaged: ${problems.join("; ")}`);
    }
    await engine.backup(source, path, (step) => checkpoint("restore:step", step));
  } finally {
    source.close();
  }
  checkpoint("restore:done", 1);
}
