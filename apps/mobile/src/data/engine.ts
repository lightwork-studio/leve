import type { SqlEngine } from "@leve/storage";
import { createExpoSqliteEngine, type ExpoSqliteApi, expoPath } from "@leve/storage/expo-sqlite";
import { Directory, File } from "expo-file-system";
import {
  backupDatabaseAsync,
  backupDatabaseSync,
  defaultDatabaseDirectory,
  openDatabaseSync,
  type SQLiteDatabase,
} from "expo-sqlite";
import { PREVIEW_STORAGE } from "./preview-storage.ts";

export interface OpenedEngine {
  engine: SqlEngine;
  /** Every database file the engine holds, so a reset can remove them all. */
  paths(): string[];
  /** Copy database and recovery files to a user-selected local destination. */
  exportRecovery(): Promise<void>;
  /** Writes pending changes to durable storage now. */
  flush(): Promise<void>;
  /** Told when saving fails (with the reason) and when it works again (with null). */
  onSaveProblem(listener: (problem: string | null) => void): void;
}

/** The app's files share expo-sqlite's database folder with their own prefix. */
const PREFIX = `${PREVIEW_STORAGE}__`;

function databaseFolder() {
  const root = String(defaultDatabaseDirectory);
  return new Directory(root.startsWith("file://") ? root : `file://${root}`);
}

const databaseFiles = (folder: Directory) =>
  folder
    .list()
    .filter((entry): entry is File => entry instanceof File && entry.name.startsWith(PREFIX));

export async function exportStoredRecovery() {
  const folder = databaseFolder();
  const files = folder.exists ? databaseFiles(folder) : [];
  if (!files.length) throw new Error("There are no database files to export.");
  const destination = await Directory.pickDirectoryAsync();
  const copy = destination.createDirectory(`leve-recovery-${Date.now()}`);
  for (const entry of files) {
    const target = copy.createFile(entry.name, "application/octet-stream");
    await target.write(await entry.bytes());
  }
}

/**
 * The phone's storage: SQLite through expo-sqlite, writing straight to the device, so there is
 * nothing to flush. The web build uses `engine.web.ts` instead.
 */
export async function openEngine(): Promise<OpenedEngine> {
  const folder = databaseFolder();
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  const file = (name: string) => new File(folder, name);
  // Exclusive startup inspection is synchronous. A leftover directory belongs to an interrupted open.
  const scratch = new Directory(folder, `${PREVIEW_STORAGE}-sqlite-inspection`);
  const clearInspection = () => {
    if (scratch.exists) scratch.delete();
  };
  clearInspection();

  // expo-sqlite's databases fit the engine's interface as they are; no casts, so the compiler
  // notices if its API changes.
  const api: ExpoSqliteApi = {
    openDatabase: (name) => openDatabaseSync(name, { useNewConnection: true }),
    createInspectionDirectory: () => {
      scratch.create();
      return {
        copyFromDatabaseDirectory: (name) => file(name).copySync(new File(scratch, name)),
        openDatabase: (name) => openDatabaseSync(name, { useNewConnection: true }, scratch.uri),
        remove: () => scratch.delete(),
      };
    },
    backupDatabaseAsync: ({ sourceDatabase, destDatabase }) =>
      backupDatabaseAsync({
        sourceDatabase: sourceDatabase as SQLiteDatabase,
        destDatabase: destDatabase as SQLiteDatabase,
      }),
    backupDatabaseSync: ({ sourceDatabase, destDatabase }) =>
      backupDatabaseSync({
        sourceDatabase: sourceDatabase as SQLiteDatabase,
        destDatabase: destDatabase as SQLiteDatabase,
      }),
    exists: (name) => file(name).exists,
    remove: (name) => {
      const target = file(name);
      if (target.exists) target.delete();
    },
  };
  const engine = createExpoSqliteEngine(api);

  return {
    engine,
    paths: () => {
      clearInspection();
      return databaseFiles(folder).map((entry) => expoPath(entry.name));
    },
    exportRecovery: exportStoredRecovery,
    flush: async () => {},
    onSaveProblem: () => {},
  };
}
