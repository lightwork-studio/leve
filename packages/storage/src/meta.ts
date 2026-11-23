import type { SqlConnection } from "./driver.ts";

/**
 * The metadata record every build can read. Its table and columns never change, so even a build
 * that refuses newer storage can say which version wrote it and whether unsynced work exists.
 */
export interface StorageMeta {
  storageVersion: number;
  appVersion: string;
  unsyncedWork: boolean;
}

export const META_TABLE_SQL = `CREATE TABLE storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  storage_version INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  unsynced_work INTEGER NOT NULL
)`;

export class StorageUnrecognizedError extends Error {
  override name = "StorageUnrecognizedError";
}

/** Returns null for a database with no tables at all (a new, empty file). */
export function readStorageMeta(db: SqlConnection): StorageMeta | null {
  const tables = db.get("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
  if (Number(tables?.n ?? 0) === 0) return null;
  const hasMeta = db.get(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'storage_meta'",
  );
  if (!hasMeta) throw new StorageUnrecognizedError(`${db.path} is not a Leve database`);
  const row = db.get(
    "SELECT storage_version, app_version, unsynced_work FROM storage_meta WHERE id = 1",
  );
  if (!row || typeof row.app_version !== "string") {
    throw new StorageUnrecognizedError(`${db.path} has no storage metadata`);
  }
  return {
    storageVersion: Number(row.storage_version),
    appVersion: row.app_version,
    unsyncedWork: Number(row.unsynced_work) !== 0,
  };
}

export function writeStorageMeta(db: SqlConnection, meta: StorageMeta): void {
  db.run(
    `INSERT INTO storage_meta (id, storage_version, app_version, unsynced_work) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET storage_version = excluded.storage_version,
       app_version = excluded.app_version, unsynced_work = excluded.unsynced_work`,
    [meta.storageVersion, meta.appVersion, meta.unsyncedWork ? 1 : 0],
  );
}
