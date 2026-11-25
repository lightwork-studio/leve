import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type DeviceStore, openDeviceStore } from "../src/device-store.ts";
import { readStorageMeta } from "../src/meta.ts";
import { engine, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";
import { fixtureContract } from "../src/test-support/versions.ts";

// The fixed metadata's unsynced-work flag is what a build that refuses newer storage reads to
// decide whether resetting is safe. It must match reality after every kind of change.

afterAll(removeTempDirs);

const T = "2026-11-10T08:00:00.000Z";
const workout = { title: "Push", startedAt: T, endedAt: null };
const folder = { title: "Strength", position: 1 };

async function openPhone(contract = fixtureContract) {
  const path = join(tempDir(), "phone.db");
  let ids = 0;
  const store = await openDeviceStore({
    engine,
    path,
    appVersion: "0.1.0",
    contract,
    now: () => T,
    randomId: () => `sub-${++ids}`,
  });
  /** The flag as persisted, read through a separate connection. */
  const flag = () => {
    const db = engine.open(path, { readOnly: true });
    try {
      return readStorageMeta(db)?.unsyncedWork;
    } finally {
      db.close();
    }
  };
  return { store, flag };
}

function sendOne(store: DeviceStore, release: "1.0" | "1.1" = "1.0") {
  const outgoing = store.prepareSubmissions(release);
  expect(outgoing).toHaveLength(1);
  return (outgoing[0] as (typeof outgoing)[number]).submission.submissionId;
}

describe("the unsynced-work flag", () => {
  it("follows local edits, uploads, answers and deletions", async () => {
    const { store, flag } = await openPhone();
    expect(flag()).toBe(false);

    store.put("workout", "w-1", workout);
    expect(flag()).toBe(true); // local-only data and a local running workout

    const created = sendOne(store);
    expect(flag()).toBe(true); // in flight
    store.applyPushResults([{ status: "accepted", submissionId: created, revision: 1 }]);
    expect(flag()).toBe(false);

    store.put("workout", "w-1", { ...workout, title: "Push A" });
    expect(flag()).toBe(true); // pending edit
    store.applyPushResults([{ status: "accepted", submissionId: sendOne(store), revision: 2 }]);
    expect(flag()).toBe(false);

    store.delete("workout", "w-1");
    expect(flag()).toBe(true); // pending deletion
    const deletion = sendOne(store);
    store.applyPushResults([{ status: "accepted", submissionId: deletion, revision: 3 }]);
    expect(flag()).toBe(false);
    expect(store.get("workout", "w-1")).toMatchObject({ deleted: true, status: "synced" });
    store.close();
  });

  it("stays set for rejected versions until the user resolves them", async () => {
    const { store, flag } = await openPhone();
    store.put("workout", "w-1", workout);
    store.applyPushResults([{ status: "accepted", submissionId: sendOne(store), revision: 1 }]);
    store.put("workout", "w-1", { ...workout, title: "Mine" });
    store.applyPushResults([
      {
        status: "conflict",
        submissionId: sendOne(store),
        reason: "stale",
        current: {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 2,
          content: { ...workout, routineId: null, title: "Theirs" },
        },
      },
    ]);
    expect(flag()).toBe(true); // a kept rejected version

    store.resolve("workout", "w-1", { choice: "keep_mine" });
    expect(flag()).toBe(true); // pending again
    store.applyPushResults([{ status: "accepted", submissionId: sendOne(store), revision: 3 }]);
    expect(flag()).toBe(false);

    store.put("routine_folder", "f-1", folder);
    store.applyPushResults([
      { status: "invalid", submissionId: sendOne(store), code: "invalid_content", message: "no" },
    ]);
    expect(flag()).toBe(true); // an invalid upload is kept
    store.resolve("routine_folder", "f-1", { choice: "keep_theirs" });
    expect(flag()).toBe(false); // never reached the server: discarded entirely
    expect(store.get("routine_folder", "f-1")).toBeNull();

    store.put("workout", "w-1", { ...workout, title: "Again" });
    store.applyPushResults([
      {
        status: "conflict",
        submissionId: sendOne(store),
        reason: "stale",
        current: {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 4,
          content: { ...workout, routineId: null, title: "Server" },
        },
      },
    ]);
    expect(flag()).toBe(true);
    store.resolve("workout", "w-1", { choice: "keep_theirs" });
    expect(flag()).toBe(false);
    store.close();
  });

  it.each([true, false])(
    "keeps a partial record unsynced until all fields are confirmed (known writer: %s)",
    async (knownWriter) => {
      const { store, flag } = await openPhone();
      store.setNegotiated("1.0", ["workouts"]);
      store.put("workout", "w-1", { ...workout, perceivedEffort: 7 });
      const submissionId = sendOne(store);
      store.applyPushResults(
        [{ status: "accepted", submissionId, revision: 1 }],
        new Set(knownWriter ? [submissionId] : []),
      );
      expect(store.get("workout", "w-1")?.status).toBe("partial");
      expect(flag()).toBe(true);

      // The server gains the field: the record is resent in full.
      store.setNegotiated("1.1", ["workouts"]);
      expect(store.prepareSubmissions("1.1")).toEqual([]);
      store.applyPull(
        [
          {
            state: "live",
            kind: "workout",
            id: "w-1",
            revision: 1,
            content: { ...workout, perceivedEffort: null },
          },
        ],
        1,
        { cursor: 0, lineage: null, release: "1.1", lastPage: true },
      );
      expect(flag()).toBe(true);
      if (!knownWriter) {
        expect(store.get("workout", "w-1")).toMatchObject({
          status: "conflict",
          content: { perceivedEffort: 7 },
          server: { content: { perceivedEffort: null } },
        });
        expect(store.prepareSubmissions("1.1")).toEqual([]);
        store.resolve("workout", "w-1", { choice: "keep_mine" });
        expect(flag()).toBe(true);
      }
      store.applyPushResults([
        { status: "accepted", submissionId: sendOne(store, "1.1"), revision: 2 },
      ]);
      expect(flag()).toBe(false);
      store.close();
    },
  );

  it("is not set by downloads, and is set again by edits made after them", async () => {
    const { store, flag } = await openPhone();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-9", revision: 5, content: workout },
        { state: "deleted", kind: "routine", id: "r-9", revision: 6 },
      ],
      6,
    );
    expect(flag()).toBe(false);
    store.put("workout", "w-9", { ...workout, title: "Edited" });
    expect(flag()).toBe(true);
    // A download that shows someone else made exactly this change settles it.
    store.applyPull(
      [
        {
          state: "live",
          kind: "workout",
          id: "w-9",
          revision: 7,
          content: { ...workout, title: "Edited" },
        },
      ],
      7,
    );
    expect(store.get("workout", "w-9")?.status).toBe("synced");
    expect(flag()).toBe(false);
    store.close();
  });

  it("is set after a server restore reset until everything is offered again", async () => {
    const { store, flag } = await openPhone();
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    expect(flag()).toBe(false);
    store.resetForServerRestore();
    expect(flag()).toBe(true);
    store.applyPushResults([{ status: "accepted", submissionId: sendOne(store), revision: 1 }]);
    store.completeRestore();
    expect(flag()).toBe(false);
    store.close();
  });
});
