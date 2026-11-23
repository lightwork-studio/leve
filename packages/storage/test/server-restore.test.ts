import {
  closeSync,
  copyFileSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Change } from "@leve/contract";
import { afterAll, describe, expect, it } from "vitest";
import type { SqlEngine } from "../src/driver.ts";
import { readStorageMeta } from "../src/meta.ts";
import {
  accountDatabasePath,
  SERVER_STORAGE_VERSION,
  type ServerAccountStore,
  ServerStorage,
  serverStorageDefinition,
} from "../src/server-store.ts";
import {
  dumpFile,
  durableFiles,
  engine,
  largeEngine,
  markAsNewer,
  needsRollback,
  RESTORE_TIME,
  RESTORED_LINEAGE,
  removeTempDirs,
  runCrashChild,
  tempDir,
} from "../src/test-support/fixtures.ts";
import { maximumWorkout } from "../src/test-support/max-workout.ts";
import { historicalContract, serverV1 } from "../src/test-support/versions.ts";
import {
  type Checkpoint,
  integrityProblems,
  StorageRecoveryError,
  StorageTooNewError,
  snapshotPath,
} from "../src/upgrade.ts";
import { failure, openPhone } from "./helpers.ts";
import {
  ALICE_RECORDS,
  benchEntry,
  measurement,
  SERVER_APP,
  seedAccount,
} from "./server-fixture.ts";

afterAll(removeTempDirs);

const restoreOptions = { randomId: () => RESTORED_LINEAGE, now: () => new Date(RESTORE_TIME) };
const REPLACED_SUFFIX = ".replaced-2026-11-10T09-00-00-000Z";

/** Records and lineage of an account as a fresh server process sees them. */
async function accountState(
  directory: string,
  onEngine: SqlEngine = engine,
  definition = serverStorageDefinition(),
) {
  const storage = new ServerStorage({
    engine: onEngine,
    directory,
    definition,
    appVersion: SERVER_APP,
  });
  try {
    const store = await storage.account("alice");
    return {
      lineage: store.lineage(),
      head: store.headRevision(),
      restoredFrom: store.restoredFrom(),
      records: store.changesAfter(0, 10_000).records,
    };
  } finally {
    await storage.close();
  }
}

async function copyWithBackup(from: string, to: string, onEngine: SqlEngine = engine) {
  const source = onEngine.open(from, { readOnly: true });
  try {
    await onEngine.backup(source, to);
  } finally {
    source.close();
  }
}

/**
 * Alice's account with a backup taken at revision 7 (`ALICE_RECORDS`) and two later writes that
 * only the live database holds.
 */
async function accountWithBackup(onEngine: SqlEngine = engine) {
  const directory = tempDir();
  await seedAccount(directory, "alice", true, onEngine);
  const path = accountDatabasePath(directory, "alice");
  const backup = join(directory, "backup.db");
  await copyWithBackup(path, backup, onEngine);
  const storage = new ServerStorage({ engine: onEngine, directory, appVersion: SERVER_APP });
  const store = await storage.account("alice");
  const originalLineage = store.lineage();
  store.transaction((tx) => {
    tx.writeLive("body_measurement", "bm-later", measurement);
    tx.writeLive("workout_exercise", "e-1", { ...benchEntry, restSeconds: 150 });
  });
  await storage.close();
  return { directory, path, backup, originalLineage };
}

/** Makes the live database big enough that an interrupted write leaves a hot journal. */
async function growAccount(directory: string): Promise<void> {
  const storage = new ServerStorage({ engine: largeEngine, directory, appVersion: SERVER_APP });
  const store = await storage.account("alice");
  store.transaction((tx) => {
    for (let i = 0; i < 600; i++) {
      tx.writeLive("workout_exercise", `e-bulk-${i}`, {
        ...benchEntry,
        position: 10 + i,
        notes: [{ id: `n-${i}`, text: "x".repeat(4000), createdAt: RESTORE_TIME }],
      });
    }
  });
  await storage.close();
}

/** The live database after `accountWithBackup`, written out by hand. */
const LATER_RECORDS = [
  ...ALICE_RECORDS.filter((record) => record.id !== "e-1"),
  { kind: "body_measurement", id: "bm-later", revision: 8, state: "live", content: measurement },
  {
    kind: "workout_exercise",
    id: "e-1",
    revision: 9,
    state: "live",
    content: { ...benchEntry, restSeconds: 150 },
  },
];

describe("a rehearsed server rollback", () => {
  it("refuses an interrupted upgrade before replacing a healthy live account", async () => {
    const { directory, path, backup } = await accountWithBackup();
    await copyWithBackup(path, backup);
    const before = dumpFile(path);
    const source = engine.open(backup);
    expect(readStorageMeta(source)?.storageVersion).toBe(SERVER_STORAGE_VERSION);
    source.exec(
      "CREATE TABLE IF NOT EXISTS storage_upgrade (id INTEGER PRIMARY KEY, from_version INTEGER, to_version INTEGER, counts TEXT)",
    );
    source.run("INSERT INTO storage_upgrade VALUES (1, ?, ?, ?)", [
      1,
      SERVER_STORAGE_VERSION,
      '{"records":101}',
    ]);
    source.close();
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    try {
      const live = await storage.account("alice");
      await expect(storage.restoreAccount("alice", backup, restoreOptions)).rejects.toThrow(
        /unfinished storage upgrade/,
      );
      expect(await storage.account("alice")).toBe(live);
      expect(dumpFile(path)).toEqual(before);
      live.transaction((tx) => tx.writeLive("body_measurement", "still-writable", measurement));
    } finally {
      await storage.close();
    }
    expect((await accountState(directory)).records.map((r) => r.id)).toEqual(
      expect.arrayContaining(["bm-later", "still-writable"]),
    );
  });

  it("restores the pre-upgrade snapshot with the older server and a new lineage", async () => {
    const directory = tempDir();
    await seedAccount(directory, "alice", true);
    const path = accountDatabasePath(directory, "alice");
    const original = await accountState(directory, engine, serverV1);
    expect(original.records).toEqual(ALICE_RECORDS);
    expect(original.restoredFrom).toBeNull();

    // The newer server upgrades the account on first use, then accepts a write.
    const newer = new ServerStorage({
      engine,
      directory,
      appVersion: "server-0.2.0",
    });
    const upgraded = await newer.account("alice");
    expect(upgraded.lineage()).toBe(original.lineage);
    upgraded.transaction((tx) => tx.writeLive("body_measurement", "bm-after", measurement));
    await newer.close();
    expect(engine.exists(snapshotPath(path, 1))).toBe(true);

    // Rolling the server back: the older server can't open the upgraded file ...
    const older = new ServerStorage({
      engine,
      definition: serverV1,
      directory,
      appVersion: SERVER_APP,
    });
    expect(await failure(older.account("alice"))).toBeInstanceOf(StorageTooNewError);
    // ... so it restores the snapshot the upgrade kept.
    const result = await older.restoreAccount("alice", snapshotPath(path, 1), restoreOptions);
    expect(result.replaced).toBe(`${path}${REPLACED_SUFFIX}`);
    const restored = await older.account("alice");
    expect(restored.lineage()).toBe(RESTORED_LINEAGE);
    expect(restored.headRevision()).toBe(7);
    // Devices learn that revisions up to 7 are history the restored server shares.
    expect(restored.restoredFrom()).toEqual({ lineage: original.lineage, restorePoint: 7 });
    expect(restored.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    await older.close();

    // The replaced copy is the upgraded database, which the older server still refuses.
    const replaced = engine.open(result.replaced as string, { readOnly: true });
    expect(readStorageMeta(replaced)?.storageVersion).toBe(SERVER_STORAGE_VERSION);
    replaced.close();
    const elsewhere = tempDir();
    copyFileSync(result.replaced as string, join(elsewhere, "account-alice.db"));
    const refuses = new ServerStorage({
      engine,
      definition: serverV1,
      directory: elsewhere,
      appVersion: SERVER_APP,
    });
    expect(await failure(refuses.account("alice"))).toBeInstanceOf(StorageTooNewError);
    await refuses.close();

    // The restored file is version-1 storage: the older server reads it as is, and a server with
    // version 2 or later upgrades it again on first use. Its recovery point is the moment of the
    // pre-upgrade snapshot: writes the newer server accepted afterwards (bm-after) are only in the
    // replaced copy. The new lineage makes devices download everything again and offer their
    // local work anew, instead of trusting revisions from the history that was rolled back.
    const again = new ServerStorage({
      engine,
      directory,
      appVersion: "server-0.2.0",
    });
    const reupgraded = await again.account("alice");
    expect(reupgraded.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    // The upgrade keeps the restored lineage and restore point.
    expect(reupgraded.lineage()).toBe(RESTORED_LINEAGE);
    expect(reupgraded.restoredFrom()).toEqual({ lineage: original.lineage, restorePoint: 7 });
    await again.close();
  });
});

describe("restoring an account", () => {
  it("never applies the replaced database's hot journal to the restored one", async () => {
    const { directory, path, backup, originalLineage } = await accountWithBackup(largeEngine);
    await growAccount(directory);
    const committed = dumpFile(path, largeEngine);

    const outcome = await runCrashChild(
      { path, mode: "server-interrupted-write", count: 400 },
      "large",
    );
    expect(outcome.signal, outcome.output).toBe("SIGKILL");
    expect(engine.exists(`${path}-journal`)).toBe(true);
    expect(needsRollback(path, largeEngine)).toBe(true);

    const restoring = new ServerStorage({ engine: largeEngine, directory, appVersion: SERVER_APP });
    const result = await restoring.restoreAccount("alice", backup, restoreOptions);
    await restoring.close();

    expect(engine.exists(`${path}-journal`)).toBe(false);
    const db = engine.open(path, { readOnly: true });
    expect(integrityProblems(db)).toEqual([]);
    db.close();
    expect(await accountState(directory, largeEngine)).toEqual({
      lineage: RESTORED_LINEAGE,
      restoredFrom: { lineage: originalLineage, restorePoint: 7 },
      head: 7,
      records: ALICE_RECORDS,
    });
    // The kept copy holds the replaced database's last committed state, properly rolled back.
    expect(dumpFile(result.replaced as string, largeEngine)).toEqual(committed);
  }, 60_000);

  it("never applies a journal left behind without its database", async () => {
    const { directory, path, backup, originalLineage } = await accountWithBackup(largeEngine);
    await growAccount(directory);
    const outcome = await runCrashChild(
      { path, mode: "server-interrupted-write", count: 400 },
      "large",
    );
    expect(outcome.signal, outcome.output).toBe("SIGKILL");
    // Someone removed the damaged database file but left its hot journal behind.
    rmSync(path);
    expect(engine.exists(`${path}-journal`)).toBe(true);

    const storage = new ServerStorage({ engine: largeEngine, directory, appVersion: SERVER_APP });
    expect(await storage.restoreAccount("alice", backup, restoreOptions)).toEqual({
      replaced: null,
    });
    await storage.close();
    expect(engine.exists(`${path}-journal`)).toBe(false);
    const db = engine.open(path, { readOnly: true });
    expect(integrityProblems(db)).toEqual([]);
    db.close();
    expect(await accountState(directory, largeEngine)).toEqual({
      lineage: RESTORED_LINEAGE,
      restoredFrom: { lineage: originalLineage, restorePoint: 7 },
      head: 7,
      records: ALICE_RECORDS,
    });
  }, 60_000);

  it("never applies the replaced database's WAL to the restored one", async () => {
    const { directory, path, backup, originalLineage } = await accountWithBackup();
    // The live server ran in WAL mode and was killed with a committed change still in the WAL.
    const outcome = await runCrashChild({ path, mode: "server-committed-wal" });
    expect(outcome.signal, outcome.output).toBe("SIGKILL");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const result = await storage.restoreAccount("alice", backup, restoreOptions);
    await storage.close();

    expect(engine.exists(`${path}-wal`)).toBe(false);
    expect(engine.exists(`${path}-shm`)).toBe(false);
    const db = engine.open(path, { readOnly: true });
    expect(integrityProblems(db)).toEqual([]);
    db.close();
    expect(await accountState(directory)).toEqual({
      lineage: RESTORED_LINEAGE,
      restoredFrom: { lineage: originalLineage, restorePoint: 7 },
      head: 7,
      records: ALICE_RECORDS,
    });
    // The kept copy includes the change that was committed only to the replaced database's WAL.
    const kept = engine.open(result.replaced as string, { readOnly: true });
    expect(
      kept.get("SELECT content FROM records WHERE kind = 'body_measurement' AND id = 'bm-later'"),
    ).toEqual({
      content: '{"takenAt":"2026-11-10T08:30:00.000Z","bodyweightKg":79.9,"fatPercent":null}',
    });
    kept.close();
  }, 60_000);

  it.each([
    ["invalid live ID", "UPDATE records SET id='bad id' WHERE id='bm-1'"],
    ["truncated live ID", "UPDATE records SET id=id || char(0) WHERE id='bm-1'"],
    ["truncated deleted kind", "UPDATE records SET kind=kind || char(0) WHERE id='r-1'"],
    ["invalid deleted ID", "UPDATE records SET id='' WHERE id='r-1'"],
    ["unknown deleted kind", "UPDATE records SET kind='other' WHERE id='r-1'"],
    ["incorrect singleton ID", "UPDATE records SET kind='settings' WHERE id='r-1'"],
    ["zero record revision", "UPDATE records SET revision=0 WHERE id='bm-1'"],
    ["fractional record revision", "UPDATE records SET revision=0.5 WHERE id='r-1'"],
    ["invalid lineage", "UPDATE account SET lineage='bad id'"],
    ["truncated lineage", "UPDATE account SET lineage=lineage || char(0)"],
    ["deleted singleton", "UPDATE records SET kind='settings',id='settings' WHERE id='r-1'"],
    ["fractional receipt revision", "UPDATE receipts SET revision=0.5"],
    ["future receipt revision", "UPDATE receipts SET revision=9"],
    [
      "another record at the receipt revision",
      "UPDATE receipts SET kind='body_measurement', id='bm-1'",
    ],
    ["wrong receipt owner", "UPDATE receipts SET id='unknown'"],
    ["truncated submission ID", "UPDATE receipts SET submission_id=submission_id || char(0)"],
    ["account revision beyond retained history", "UPDATE account SET revision=9007199254740991"],
    ["invalid receipt timestamp", "UPDATE receipts SET accepted_at='!'"],
    ["invalid calendar date", "UPDATE receipts SET accepted_at='2026-02-30T00:00:00.000Z'"],
    ["truncated receipt timestamp", "UPDATE receipts SET accepted_at=accepted_at || char(0)"],
    ["invalid receipt digest", "UPDATE receipts SET digest='different'"],
    ["invalid account revision", "UPDATE account SET revision=7.5"],
  ])("refuses a backup with %s before replacing the writable account", async (_, update) => {
    const { directory, backup } = await accountWithBackup();
    const db = engine.open(backup);
    try {
      expect(db.run(update).changes).toBe(1);
    } finally {
      db.close();
    }
    const before = durableFiles(directory);
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    try {
      const error = await failure(storage.restoreAccount("alice", backup, restoreOptions));
      expect(error).toBeInstanceOf(StorageRecoveryError);
      expect((error as Error).message).toMatch(
        /invalid .*revision|invalid account lineage|invalid receipt timestamp/,
      );
      expect(durableFiles(directory)).toEqual(before);
      const live = await storage.account("alice");
      expect(live.transaction((tx) => tx.get("body_measurement", "bm-later"))?.state).toBe("live");
      live.transaction((tx) => tx.writeLive("body_measurement", "after-refusal", measurement));
    } finally {
      await storage.close();
    }
  });

  it.each([true, false])(
    "checks ownership of a historical revision shared by receipts (same owner %s)",
    async (sameOwner) => {
      const { directory, backup } = await accountWithBackup();
      const db = engine.open(backup);
      try {
        db.run("UPDATE records SET revision=8 WHERE id='w-1'");
        db.run("UPDATE account SET revision=8");
        db.run(
          `INSERT INTO receipts(submission_id,kind,id,revision,digest,accepted_at)
        SELECT 'second', ?, ?, revision, digest, accepted_at FROM receipts WHERE submission_id='sub-1'`,
          sameOwner ? ["workout", "w-1"] : ["routine", "r-1"],
        );
      } finally {
        db.close();
      }
      const before = durableFiles(directory);
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const restore = storage.restoreAccount("alice", backup, restoreOptions);
        if (sameOwner) {
          await restore;
          const live = await storage.account("alice");
          expect(live.transaction((tx) => tx.receipt("second"))?.revision).toBe(1);
        } else {
          expect(await failure(restore)).toBeInstanceOf(StorageRecoveryError);
          expect(durableFiles(directory)).toEqual(before);
        }
      } finally {
        await storage.close();
      }
    },
  );

  it("rejects a backup with a rest under a different ID and preserves the live account", async () => {
    const { directory, backup } = await accountWithBackup();
    const db = engine.open(backup);
    try {
      db.run(
        "UPDATE records SET kind='workout_rest', content=?, parent_kind='workout', parent_id='w-1' WHERE id='e-1'",
        [JSON.stringify({ workoutId: "w-1", seconds: 45 })],
      );
    } finally {
      db.close();
    }
    const before = durableFiles(directory);
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    try {
      const error = await failure(storage.restoreAccount("alice", backup, restoreOptions));
      expect(error).toBeInstanceOf(StorageRecoveryError);
      expect((error as Error).message).toMatch(/parent.*ID/i);
    } finally {
      await storage.close();
    }
    expect(durableFiles(directory)).toEqual(before);
  });

  it.each(["w-1", "missing-owner"])(
    "refuses a deleted rest preference without a deleted workout (%s)",
    async (owner) => {
      const { directory, backup } = await accountWithBackup();
      const db = engine.open(backup);
      try {
        db.run("UPDATE records SET kind='workout_rest', id=? WHERE kind='routine' AND id='r-1'", [
          owner,
        ]);
      } finally {
        db.close();
      }
      const before = durableFiles(directory);
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const error = await failure(storage.restoreAccount("alice", backup, restoreOptions));
        expect(error).toBeInstanceOf(StorageRecoveryError);
        expect((error as Error).message).toContain(`workout_rest/${owner}: missing deleted parent`);
        expect(durableFiles(directory)).toEqual(before);
        const live = await storage.account("alice");
        expect(live.transaction((tx) => tx.get("body_measurement", "bm-later"))?.state).toBe(
          "live",
        );
        live.transaction((tx) => tx.writeLive("body_measurement", "after-refusal", measurement));
      } finally {
        await storage.close();
      }
    },
  );

  it.each(["kind,id", "revision"])(
    "refuses a backup missing the unique %s record key",
    async (missing) => {
      const { directory, path } = await accountWithBackup();
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      const backup = join(tempDir(), "missing-constraint.db");
      try {
        await storage.account("alice");
        await storage.close();
        await copyWithBackup(path, backup);
        const db = engine.open(backup);
        try {
          db.exec(
            "CREATE TABLE copied AS SELECT * FROM records; DROP TABLE records; ALTER TABLE copied RENAME TO records",
          );
          db.exec(
            missing === "revision"
              ? "CREATE UNIQUE INDEX identity_key ON records(kind,id)"
              : "CREATE UNIQUE INDEX revision_key ON records(revision)",
          );
        } finally {
          db.close();
        }
        const before = durableFiles(directory);
        await expect(storage.restoreAccount("alice", backup, restoreOptions)).rejects.toThrow(
          "invalid records identity or revision constraint",
        );
        expect(durableFiles(directory)).toEqual(before);
        const account = await storage.account("alice");
        account.transaction((tx) => tx.writeLive("body_measurement", "after-refusal", measurement));
      } finally {
        await storage.close();
      }
    },
  );

  it.each(["old", "current"])("requires unique submission IDs in a %s backup", async (version) => {
    const { directory, path, backup } = await accountWithBackup();
    if (version === "current") await copyWithBackup(path, backup);
    const db = engine.open(backup);
    try {
      db.exec(`CREATE TABLE copied AS SELECT * FROM receipts;
        DROP TABLE receipts; ALTER TABLE copied RENAME TO receipts;
        INSERT INTO receipts SELECT * FROM receipts;`);
    } finally {
      db.close();
    }
    const before = durableFiles(directory);
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    try {
      await expect(storage.restoreAccount("alice", backup, restoreOptions)).rejects.toThrow(
        "invalid receipt submission ID constraint",
      );
      expect(durableFiles(directory)).toEqual(before);
      const live = await storage.account("alice");
      live.transaction((tx) => tx.writeLive("body_measurement", "after-refusal", measurement));
    } finally {
      await storage.close();
    }
  });

  it.each([true, false])(
    "allows only one writer of a revision (both claim it: %s)",
    async (both) => {
      const { directory, path, backup } = await accountWithBackup();
      await copyWithBackup(path, backup);
      const db = engine.open(backup);
      try {
        db.run("UPDATE receipts SET wrote_revision=1");
        db.run(
          `INSERT INTO receipts(submission_id,kind,id,revision,digest,accepted_at,wrote_revision)
        SELECT 'SUB-1',kind,id,revision,digest,accepted_at,? FROM receipts WHERE submission_id='sub-1'`,
          [both ? 1 : null],
        );
      } finally {
        db.close();
      }
      const before = durableFiles(directory);
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const restore = storage.restoreAccount("alice", backup, restoreOptions);
        if (both) {
          await expect(restore).rejects.toThrow("multiple writing receipts for one revision");
          expect(durableFiles(directory)).toEqual(before);
          const live = await storage.account("alice");
          live.transaction((tx) => tx.writeLive("body_measurement", "after-refusal", measurement));
        } else {
          await restore;
          const live = await storage.account("alice");
          expect(live.transaction((tx) => tx.receipt("sub-1"))?.wroteRevision).toBe(true);
          expect(live.transaction((tx) => tx.receipt("SUB-1"))).toMatchObject({
            submissionId: "SUB-1",
            revision: 1,
          });
          expect(live.transaction((tx) => tx.receipt("SUB-1"))).not.toHaveProperty("wroteRevision");
        }
      } finally {
        await storage.close();
      }
    },
  );

  it.each(["wrong live parent", "missing owner", "deleted owner"])(
    "refuses a backup with an inconsistent live child (%s)",
    async (damage) => {
      const { directory, backup } = await accountWithBackup();
      const db = engine.open(backup);
      try {
        if (damage === "wrong live parent") {
          db.run(
            "UPDATE records SET parent_kind='body_measurement', parent_id='bm-1' WHERE kind='workout_exercise'",
          );
        } else if (damage === "deleted owner") {
          db.run("UPDATE records SET state='deleted', content=NULL WHERE kind='workout'");
        } else {
          db.run("DELETE FROM records WHERE kind = 'workout'");
        }
      } finally {
        db.close();
      }
      const before = durableFiles(directory);
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const error = await failure(storage.restoreAccount("alice", backup, restoreOptions));
        expect(error).toBeInstanceOf(StorageRecoveryError);
        expect((error as Error).message).toMatch(/parent/i);
      } finally {
        await storage.close();
      }
      expect(durableFiles(directory)).toEqual(before);
    },
  );

  it.each([
    ["digest", null],
    ["wrote_revision", null],
    ["wrote_revision", "INTEGER DEFAULT 1 CHECK(wrote_revision=1)"],
  ])(
    "refuses a damaged receipt column (%s, %s) and leaves the live account writable",
    async (column, replacement) => {
      const { directory, path } = await accountWithBackup();
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      const backup = join(tempDir(), "missing-receipt-column.db");
      try {
        await storage.account("alice");
        await storage.close();
        await copyWithBackup(path, backup);
        const db = engine.open(backup);
        try {
          db.exec(`ALTER TABLE receipts DROP COLUMN ${column}`);
          if (replacement) db.exec(`ALTER TABLE receipts ADD COLUMN ${column} ${replacement}`);
        } finally {
          db.close();
        }
        const before = durableFiles(directory);
        await expect(storage.restoreAccount("alice", backup, restoreOptions)).rejects.toThrow(
          replacement ? "invalid receipts.wrote_revision" : `missing receipts.${column}`,
        );
        expect(durableFiles(directory)).toEqual(before);
        const account = await storage.account("alice");
        account.transaction((tx) =>
          tx.saveReceipt({
            submissionId: "after-refusal",
            kind: "workout",
            id: "w-1",
            digest: "b".repeat(64),
            revision: 1,
            acceptedAt: RESTORE_TIME,
            wroteRevision: true,
          }),
        );
        expect(account.transaction((tx) => tx.receipt("after-refusal"))?.wroteRevision).toBe(true);
      } finally {
        await storage.close();
      }
    },
  );

  it.each(["DELETE", "WAL"] as const)(
    "refuses a current %s backup that indexes a set under another live exercise",
    async (mode) => {
      const { directory, path } = await accountWithBackup();
      const backup = join(tempDir(), "wrong-exercise.db");
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const account = await storage.account("alice");
        account.transaction((tx) =>
          tx.writeLive("workout_exercise", "e-2", { ...benchEntry, position: 2 }),
        );
      } finally {
        await storage.close();
      }
      await copyWithBackup(path, backup);
      const db = engine.open(backup);
      try {
        db.exec(`PRAGMA journal_mode = ${mode}`);
        db.run("UPDATE records SET parent_id='e-2' WHERE kind='workout_set' AND id='s-1'");
      } finally {
        db.close();
      }
      const before = durableFiles(directory);
      const restored = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      try {
        const error = await failure(restored.restoreAccount("alice", backup, restoreOptions));
        expect(error).toBeInstanceOf(StorageRecoveryError);
        expect((error as Error).message).toMatch(/workout_set\/s-1.*parent/i);
      } finally {
        await restored.close();
      }
      expect(readdirSync(directory).filter((name) => name.includes(".restore"))).toEqual([]);
      expect(durableFiles(directory)).toEqual(before);
    },
  );

  it("validates the copied image when the backup changes during restore", async () => {
    const { directory, path } = await accountWithBackup();
    const backup = join(tempDir(), "refreshed.db");
    await copyWithBackup(path, backup);
    const changingEngine: SqlEngine = {
      ...engine,
      async backup(source, destination, onStep) {
        if (source.path === backup) {
          const writer = engine.open(backup);
          try {
            writer.run("UPDATE records SET state='deleted', content=NULL WHERE kind='workout'");
          } finally {
            writer.close();
          }
        }
        await engine.backup(source, destination, onStep);
      },
    };
    const storage = new ServerStorage({
      engine: changingEngine,
      directory,
      appVersion: SERVER_APP,
    });
    try {
      const live = await storage.account("alice");
      const before = durableFiles(directory);
      const error = await failure(storage.restoreAccount("alice", backup, restoreOptions));
      expect(error).toBeInstanceOf(StorageRecoveryError);
      expect((error as Error).message).toMatch(/parent/i);
      expect(await storage.account("alice")).toBe(live);
      expect(durableFiles(directory)).toEqual(before);
    } finally {
      await storage.close();
    }
  });

  it("refuses a damaged backup and leaves the live database unchanged", async () => {
    const { directory, backup, originalLineage } = await accountWithBackup();
    const damaged = join(tempDir(), "damaged.db");
    copyFileSync(backup, damaged);
    const pageSize = 4096;
    const fd = openSync(damaged, "r+");
    writeSync(fd, Buffer.alloc(pageSize, 0x5a), 0, pageSize, pageSize * 2);
    closeSync(fd);
    const garbage = join(tempDir(), "garbage.db");
    copyFileSync(backup, garbage);
    const bytes = readFileSync(garbage);
    bytes.fill(0x5a, 0, 100);
    const gfd = openSync(garbage, "w");
    writeSync(gfd, bytes);
    closeSync(gfd);

    const before = durableFiles(directory);
    for (const [bad, kind] of [
      [damaged, StorageRecoveryError],
      [garbage, StorageRecoveryError],
    ] as const) {
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      const error = await failure(storage.restoreAccount("alice", bad, restoreOptions));
      expect(error, bad).toBeInstanceOf(kind);
      await storage.close();
      expect(durableFiles(directory)).toEqual(before);
    }
    expect(await accountState(directory)).toEqual({
      lineage: originalLineage,
      restoredFrom: null,
      head: 9,
      records: LATER_RECORDS,
    });
  });

  it("refuses a backup written by a newer server and leaves the live database unchanged", async () => {
    const { directory, backup, originalLineage } = await accountWithBackup();
    const newer = join(tempDir(), "newer.db");
    await copyWithBackup(backup, newer);
    markAsNewer(newer, SERVER_STORAGE_VERSION + 1, "future-server");
    const before = durableFiles(directory);
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const error = await failure(storage.restoreAccount("alice", newer, restoreOptions));
    expect(error).toBeInstanceOf(StorageRecoveryError);
    expect((error as Error).message).toContain(
      `storage version ${SERVER_STORAGE_VERSION + 1} is newer`,
    );
    // The account stays usable on this server.
    expect((await storage.account("alice")).lineage()).toBe(originalLineage);
    await storage.close();
    expect(durableFiles(directory)).toEqual(before);
  });

  it("refuses a backup whose content doesn't decode, before replacing anything", async () => {
    const { directory, backup } = await accountWithBackup();
    const broken = join(tempDir(), "broken.db");
    await copyWithBackup(backup, broken);
    const db = engine.open(broken);
    try {
      db.run("UPDATE records SET content = '{\"oops\":true}' WHERE state = 'live'");
    } finally {
      db.close();
    }
    const before = durableFiles(directory);
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const error = await failure(storage.restoreAccount("alice", broken, restoreOptions));
    expect(error).toBeInstanceOf(StorageRecoveryError);
    await storage.close();
    expect(durableFiles(directory)).toEqual(before);
  });

  it("keeps an open account open and tracked when its restore is refused", async () => {
    const { directory, backup } = await accountWithBackup();
    const newer = join(tempDir(), "newer.db");
    await copyWithBackup(backup, newer);
    markAsNewer(newer, SERVER_STORAGE_VERSION + 1, "future-server");
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const open = await storage.account("alice");
    const refused = failure(storage.restoreAccount("alice", newer, restoreOptions));
    // A request that arrives during the restore waits, then gets the account as it was.
    const waiting = storage.account("alice");
    await refused;
    expect(await waiting).toBe(open);
    // The same connection serves the account; no second one is opened beside it.
    expect(await storage.account("alice")).toBe(open);
    await storage.close();
  });

  it("makes requests that arrive during the restore wait for the restored database", async () => {
    const { directory, backup } = await accountWithBackup();
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const before = await storage.account("alice");
    expect(before.headRevision()).toBe(9);

    const restoring = storage.restoreAccount("alice", backup, restoreOptions);
    const during = storage.account("alice");
    const [, store] = await Promise.all([restoring, during]);
    expect(store.lineage()).toBe(RESTORED_LINEAGE);
    expect(store.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    expect(store.transaction((tx) => tx.writeLive("body_measurement", "bm-new", measurement))).toBe(
      8,
    );
    expect(await storage.account("alice")).toBe(store);
    await storage.close();

    const state = await accountState(directory);
    expect(state.head).toBe(8);
    expect(state.records.at(-1)).toEqual({
      kind: "body_measurement",
      id: "bm-new",
      revision: 8,
      state: "live",
      content: measurement,
    });
  });
});

describe("which restore point a device may trust", () => {
  type Phone = Awaited<ReturnType<typeof openPhone>>["store"];

  /** Downloads everything after the phone's cursor from the account, as one page. */
  function download(phone: Phone, account: ServerAccountStore): void {
    const changes: Change[] = account
      .changesAfter(phone.syncState().cursor, 10_000)
      .records.map((r) =>
        r.state === "live"
          ? {
              state: "live",
              kind: r.kind,
              id: r.id,
              revision: r.revision,
              content: r.content ?? {},
            }
          : { state: "deleted", kind: r.kind, id: r.id, revision: r.revision },
      );
    phone.applyPull(changes, account.headRevision());
  }

  /** What the sync client does on a new lineage: reset, download everything, finish. */
  function resetAfterRestore(phone: Phone, account: ServerAccountStore): void {
    phone.resetForServerRestore();
    phone.setNegotiated("1.0", ["workouts", "body_measurements"], account.lineage());
    download(phone, account);
    phone.completeRestore();
  }

  it("keeps a phone's edit made after one restore when an older copy is restored next", async () => {
    // L1 is at revision 9; its backup at revision 7 is restored as L2.
    const { directory, path, backup, originalLineage: l1 } = await accountWithBackup();
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const { store: phone, flag } = await openPhone();
    let account = await storage.account("alice");
    phone.setNegotiated("1.0", ["workouts", "body_measurements"], l1);
    download(phone, account);
    expect(phone.get("body_measurement", "bm-later")?.server?.revision).toBe(8);

    const first = await storage.restoreAccount("alice", backup, {
      ...restoreOptions,
      randomId: () => "L2",
    });
    account = await storage.account("alice");
    expect([account.lineage(), account.restoredFrom()]).toEqual([
      "L2",
      { lineage: l1, restorePoint: 7 },
    ]);
    resetAfterRestore(phone, account);

    // In L2 the phone edits bm-1; the server accepts it at revision 8.
    phone.put("body_measurement", "bm-1", { ...measurement, bodyweightKg: 79.5 });
    const [upload] = phone.prepareSubmissions("1.0");
    const revision = account.transaction((tx) =>
      tx.writeLive("body_measurement", "bm-1", { ...measurement, bodyweightKg: 79.5 }),
    );
    expect(revision).toBe(8);
    phone.applyPushResults([
      { status: "accepted", submissionId: upload?.submission.submissionId as string, revision },
    ]);
    expect(phone.get("body_measurement", "bm-1")).toMatchObject({
      status: "synced",
      server: { revision: 8 },
    });

    // Now the copy the first restore replaced (L1 at 9) is restored as L3.
    const second = await storage.restoreAccount("alice", first.replaced as string, {
      ...restoreOptions,
      randomId: () => "L3",
      now: () => new Date("2026-11-10T10:00:00.000Z"),
    });
    expect(second.replaced).toBe(`${path}.replaced-2026-11-10T10-00-00-000Z`);
    account = await storage.account("alice");
    // L3's history is L1's up to 9, which never held the phone's edit at L2's revision 8.
    expect([account.lineage(), account.restoredFrom()]).toEqual([
      "L3",
      { lineage: l1, restorePoint: 9 },
    ]);
    resetAfterRestore(phone, account);
    // bm-1 in L3 is the old value at revision 5; the phone's edit is offered again, not dropped.
    expect(phone.get("body_measurement", "bm-1")).toMatchObject({
      status: "pending",
      content: { ...measurement, bodyweightKg: 79.5 },
      server: { revision: 5 },
    });
    // Everything else downloaded equal to the phone's copy and is settled; only the edit is sent.
    const outgoing = phone.prepareSubmissions("1.0");
    expect(outgoing.map((o) => o.submission.id)).toEqual(["bm-1"]);
    phone.applyPushResults([
      {
        status: "conflict",
        submissionId: outgoing[0]?.submission.submissionId as string,
        reason: "exists",
        current: {
          state: "live",
          kind: "body_measurement",
          id: "bm-1",
          revision: 5,
          content: measurement,
        },
      },
    ]);
    expect(phone.get("body_measurement", "bm-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "exists", revision: 5 },
      content: { ...measurement, bodyweightKg: 79.5 },
    });
    expect(flag()).toBe(true);
    phone.close();
    await storage.close();
  });

  it("forgets the restore point when the lineage is rotated", async () => {
    const { directory, backup, originalLineage } = await accountWithBackup();
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    await storage.restoreAccount("alice", backup, restoreOptions);
    const account = await storage.account("alice");
    expect(account.restoredFrom()).toEqual({ lineage: originalLineage, restorePoint: 7 });
    // Files copied back by hand: where the histories split is unknown.
    account.transaction((tx) => tx.setLineage("lineage-rotated"));
    expect(account.lineage()).toBe("lineage-rotated");
    expect(account.restoredFrom()).toBeNull();
    expect(account.db.get("SELECT restored_from, restore_point FROM account")).toEqual({
      restored_from: null,
      restore_point: null,
    });
    await storage.close();
  });
});

describe("concurrent restores", () => {
  it("refuses a second restore of the same account while the first runs", async () => {
    const { directory, backup, originalLineage } = await accountWithBackup();
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    const first = storage.restoreAccount("alice", backup, restoreOptions);
    const second = storage.restoreAccount("alice", backup, {
      ...restoreOptions,
      randomId: () => "lineage-second",
    });
    expect(await failure(second)).toBeInstanceOf(StorageRecoveryError);
    expect(await first).toEqual({
      replaced: `${accountDatabasePath(directory, "alice")}${REPLACED_SUFFIX}`,
    });
    expect((await storage.account("alice")).lineage()).toBe(RESTORED_LINEAGE);
    await storage.close();
    expect(readdirSync(directory).filter((name) => name.includes(".restore"))).toEqual([]);
    expect(await accountState(directory)).toEqual({
      lineage: RESTORED_LINEAGE,
      restoredFrom: { lineage: originalLineage, restorePoint: 7 },
      head: 7,
      records: ALICE_RECORDS,
    });

    // Once it is done, the account can be restored again.
    const later = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    await later.restoreAccount("alice", backup, { ...restoreOptions, randomId: () => "lineage-3" });
    expect((await later.account("alice")).lineage()).toBe("lineage-3");
    await later.close();
  });
});

describe("crash while restoring an account", async () => {
  // Every checkpoint an uninterrupted restore reaches, once per count.
  const reached = new Map<Checkpoint, number>();
  {
    const { directory, backup } = await accountWithBackup();
    const storage = new ServerStorage({
      engine,
      directory,
      appVersion: SERVER_APP,
      onCheckpoint: (point, n) => reached.set(point, Math.max(reached.get(point) ?? 0, n)),
    });
    await storage.restoreAccount("alice", backup, restoreOptions);
    await storage.close();
  }
  const cases = [...reached].flatMap(([point, max]) =>
    Array.from({ length: max }, (_, i): [Checkpoint, number] => [point, i + 1]),
  );

  it("covers staging, the new lineage, the kept copy, clearing journals and the rename", () => {
    expect([...reached.keys()].sort()).toEqual([
      "account-restore:cleared",
      "account-restore:kept",
      "account-restore:renamed",
      "account-restore:staged",
      "account-restore:step",
    ]);
  });

  it.concurrent.each(cases)(
    "%s #%i",
    async (point, count) => {
      const { directory, originalLineage } = await accountWithBackup();
      const outcome = await runCrashChild({
        path: directory,
        mode: "server-restore",
        point,
        count,
      });
      expect(outcome.signal, outcome.output).toBe("SIGKILL");

      // The account is either exactly as before or exactly as restored, never empty or mixed.
      const state = await accountState(directory);
      if (point === "account-restore:renamed") {
        expect(state).toEqual({
          lineage: RESTORED_LINEAGE,
          restoredFrom: { lineage: originalLineage, restorePoint: 7 },
          head: 7,
          records: ALICE_RECORDS,
        });
      } else {
        expect(state).toEqual({
          lineage: originalLineage,
          restoredFrom: null,
          head: 9,
          records: LATER_RECORDS,
        });
      }

      // Running the restore again finishes it.
      const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
      await storage.restoreAccount("alice", join(directory, "backup.db"), restoreOptions);
      await storage.close();
      expect(await accountState(directory)).toEqual({
        lineage: RESTORED_LINEAGE,
        restoredFrom: { lineage: originalLineage, restorePoint: 7 },
        head: 7,
        records: ALICE_RECORDS,
      });
      expect(readdirSync(directory).some((name) => name.endsWith(".restore"))).toBe(false);
    },
    60_000,
  );
});

it.each([2, 3] as const)(
  "restores a version-%i server snapshot and its accepted receipts",
  async (version) => {
    const directory = tempDir();
    const path = accountDatabasePath(directory, "alice");
    await seedAccount(directory, "alice", true);
    const current = serverStorageDefinition({
      contract: historicalContract(version === 2 ? "1.1" : "1.2"),
    });
    const previous = {
      ...current,
      version,
      steps: current.steps.filter((step) => step.from < version),
    };
    if (version === 3) {
      const old = new ServerStorage({
        engine,
        directory,
        definition: previous,
        appVersion: "previous",
      });
      const account = await old.account("alice");
      const set = ALICE_RECORDS.find((row) => row.id === "s-1")?.content;
      if (!set) throw Error("Missing fixture set");
      account.transaction((tx) => tx.writeLive("workout_set", "s-1", { ...set, repsInReserve: 0 }));
      account.transaction((tx) => tx.writeLive("workout", "at-limit", maximumWorkout()));
      await old.close();
    }
    const before = await accountState(directory, engine, previous);
    const service = new ServerStorage({ engine, directory, appVersion: "effort" });
    const account = await service.account("alice");
    expect(account.changesAfter(0, 100).records).toEqual(before.records);
    expect(account.transaction((tx) => tx.receipt("sub-1"))).toMatchObject({
      revision: 1,
      digest: "a".repeat(64),
    });
    expect(account.transaction((tx) => tx.receipt("sub-1"))).not.toHaveProperty("wroteRevision");
    const record = before.records.find((row) => row.kind === "workout");
    if (!record?.content) throw Error("Missing workout");
    account.transaction((tx) =>
      tx.writeLive("workout_note", "pin", {
        workoutId: record.id,
        kind: "sticky",
        text: "Rack three",
        createdAt: RESTORE_TIME,
        reply: null,
      }),
    );
    await service.close();
    const older = new ServerStorage({
      engine,
      directory,
      definition: previous,
      appVersion: "previous",
    });
    expect(await failure(older.account("alice"))).toBeInstanceOf(StorageTooNewError);
    await older.restoreAccount("alice", snapshotPath(path, version), restoreOptions);
    const recovered = await older.account("alice");
    expect(recovered.changesAfter(0, 100).records).toEqual(before.records);
    expect(recovered.transaction((tx) => tx.receipt("sub-1"))).toMatchObject({
      revision: 1,
      digest: "a".repeat(64),
    });
    expect(recovered.restoredFrom()).toEqual({
      lineage: before.lineage,
      restorePoint: before.head,
    });
    await older.close();
  },
);
