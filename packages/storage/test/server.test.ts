import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AccountIdError, accountDatabasePath, ServerStorage } from "../src/server-store.ts";
import { dumpFile, engine, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";
import { serverV1, serverV2, serverV2Corrupting } from "../src/test-support/versions.ts";
import { StorageTooNewError, snapshotPath, UpgradeFailedError } from "../src/upgrade.ts";
import { failure } from "./helpers.ts";
import { ALICE_RECORDS, measurement, SERVER_APP, seedAccount, T } from "./server-fixture.ts";

afterAll(removeTempDirs);

describe("server storage upgrades per account", () => {
  it("pauses only the account whose upgrade fails", async () => {
    const directory = tempDir();
    await seedAccount(directory, "alice", true);
    await seedAccount(directory, "bob", false);
    const alicePath = accountDatabasePath(directory, "alice");
    const aliceBefore = dumpFile(alicePath);

    // A broken release: its step damages set content, which only alice has.
    const broken = new ServerStorage({
      engine,
      directory,
      appVersion: "server-0.2.0",
      definition: serverV2Corrupting,
    });
    const error = await failure(broken.account("alice"));
    expect(error).toBeInstanceOf(UpgradeFailedError);
    expect((error as UpgradeFailedError).restoredSnapshot).toBe(true);
    expect(dumpFile(alicePath)).toEqual(aliceBefore);

    // Bob opens, reads and writes on the same server while alice is paused.
    const bob = await broken.account("bob");
    expect(bob.changesAfter(0, 100).records.map((r) => `${r.kind}/${r.id}@${r.revision}`)).toEqual([
      "workout/w-1@1",
      "workout_exercise/e-1@2",
      "body_measurement/bm-1@3",
      "routine/r-1@5",
    ]);
    expect(
      bob.db.get("SELECT position FROM records WHERE kind = 'workout_exercise' AND id = 'e-1'"),
    ).toEqual({ position: 1 });
    expect(bob.transaction((tx) => tx.writeLive("body_measurement", "bm-2", measurement))).toBe(6);

    // Asking for alice again retries and fails the same way, still without losing anything.
    expect(await failure(broken.account("alice"))).toBeInstanceOf(UpgradeFailedError);
    expect(dumpFile(alicePath)).toEqual(aliceBefore);
    await broken.close();

    // The older server refuses bob's upgraded database; alice's is still version 1.
    const older = new ServerStorage({
      engine,
      directory,
      definition: serverV1,
      appVersion: SERVER_APP,
    });
    expect(await failure(older.account("bob"))).toBeInstanceOf(StorageTooNewError);
    const aliceOnOld = await older.account("alice");
    expect(aliceOnOld.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    await older.close();

    // A fixed release upgrades alice with every record, deletion marker and receipt intact.
    const fixed = new ServerStorage({
      engine,
      directory,
      appVersion: "server-0.2.1",
      definition: serverV2,
    });
    const alice = await fixed.account("alice");
    expect(alice.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    expect(alice.headRevision()).toBe(7);
    // The upgrade keeps the account history's lineage, so devices keep trusting their revisions.
    expect(alice.lineage()).toBe((aliceBefore.account as { lineage: string }[])[0]?.lineage);
    expect(alice.transaction((tx) => tx.receipt("sub-1"))).toEqual({
      submissionId: "sub-1",
      kind: "workout",
      id: "w-1",
      revision: 1,
      digest: "a".repeat(64),
      acceptedAt: T,
    });
    expect(
      alice.db.all("SELECT id, position FROM records WHERE kind = 'workout_set' ORDER BY id"),
    ).toEqual([
      { id: "s-1", position: 1 },
      { id: "s-2", position: 2 },
    ]);
    expect(engine.exists(snapshotPath(alicePath, 1))).toBe(true);
    await fixed.close();
  });

  it("reads version-1 account data back unchanged with the real definition", async () => {
    const directory = tempDir();
    await seedAccount(directory, "carol", true);
    const storage = new ServerStorage({
      engine,
      directory,
      appVersion: SERVER_APP,
      definition: serverV1,
    });
    const carol = await storage.account("carol");
    expect(carol.changesAfter(0, 100).records).toEqual(ALICE_RECORDS);
    await storage.close();
  });
});

describe("account database paths", () => {
  it("accepts plain ids", () => {
    const directory = tempDir();
    expect(accountDatabasePath(directory, "acct_1-A")).toBe(join(directory, "account-acct_1-A.db"));
    expect(accountDatabasePath(directory, "a".repeat(64))).toBe(
      join(directory, `account-${"a".repeat(64)}.db`),
    );
  });

  it.each([
    "",
    ".",
    "..",
    "../alice",
    "alice/../../etc",
    "a/b",
    "a\\b",
    "/etc/passwd",
    "alice.db",
    "ali ce",
    "alice\u0000",
    "a".repeat(65),
  ])("rejects %j", (id) => {
    expect(() => accountDatabasePath("/srv/leve", id)).toThrow(AccountIdError);
  });

  it("opens nothing for a rejected id", async () => {
    const root = tempDir();
    const directory = join(root, "accounts");
    const storage = new ServerStorage({ engine, directory, appVersion: SERVER_APP });
    expect(await failure(storage.account("../escape"))).toBeInstanceOf(AccountIdError);
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(dirname(root)).some((name) => name.startsWith("escape"))).toBe(false);
    await storage.close();
  });
});
