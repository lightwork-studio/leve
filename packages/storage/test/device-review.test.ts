import type { JsonObject, SubmissionResult } from "@leve/contract";
import { afterAll, describe, expect, it } from "vitest";
import { type DeviceStore, DeviceStoreError } from "../src/device-store.ts";
import { dumpTables, removeTempDirs } from "../src/test-support/fixtures.ts";
import { openPhone } from "./helpers.ts";

// Regression tests for device sync rules. Expected rows are written out by hand.

afterAll(removeTempDirs);

const T = "2026-11-10T08:00:00.000Z";
const workout = { title: "Push", startedAt: T, endedAt: null, routineId: null };
const workoutRow = { ...workout, perceivedEffort: null };
const entry = (workoutId: string): JsonObject => ({
  workoutId,
  exerciseId: "barbell-bench-press",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 120,
  doubleDumbbellVolume: false,
});
const set = (workoutExerciseId: string, position: number, reps = 5): JsonObject => ({
  workoutExerciseId,
  position,
  type: "normal",
  weightKg: 100,
  reps,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
});

/** Sends everything that is ready and answers each upload as `answer` says. */
function sync(
  store: DeviceStore,
  answer: Record<string, (submissionId: string) => SubmissionResult>,
  release: "1.0" | "1.1" = "1.0",
): string[] {
  const outgoing = store.prepareSubmissions(release);
  store.applyPushResults(
    outgoing.map(({ submission }) => {
      const key = `${submission.op} ${submission.kind}/${submission.id}`;
      const reply = answer[key];
      if (!reply) throw new Error(`no answer for ${key}`);
      return reply(submission.submissionId);
    }),
  );
  return outgoing.map(({ submission }) => `${submission.op} ${submission.kind}/${submission.id}`);
}
const accepted = (revision: number) => (submissionId: string) =>
  ({ status: "accepted", submissionId, revision }) as const;
const retryLater = (submissionId: string) =>
  ({ status: "retry_later", submissionId, reason: "parent_missing" }) as const;
const invalid = (submissionId: string) =>
  ({ status: "invalid", submissionId, code: "invalid_content", message: "rejected" }) as const;

/** Every record row as kind/id → status, local state, base, server state and revision. */
function rows(store: DeviceStore): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of store.db.all("SELECT * FROM records ORDER BY kind, id")) {
    result[`${String(row.kind)}/${String(row.id)}`] =
      `${String(row.status)} local=${String(row.local_state)} base=${String(row.local_base)} ` +
      `server=${String(row.server_state)}@${String(row.server_revision)}`;
  }
  return result;
}

/** Each record with its stored local content, parsed. */
function localContents(store: DeviceStore): unknown[] {
  return store.db
    .all("SELECT kind, id, local_content FROM records ORDER BY kind, id")
    .map((row) => [
      row.kind,
      row.id,
      row.local_content === null ? null : JSON.parse(String(row.local_content)),
    ]);
}

/** A synced workout w-1 (rev 1) with entry e-1 (rev 2) and set s-1 (rev 3). */
function syncedTree(store: DeviceStore): void {
  store.put("workout", "w-1", workout);
  store.put("workout_exercise", "e-1", entry("w-1"));
  store.put("workout_set", "s-1", set("e-1", 1));
  sync(store, {
    "put workout/w-1": accepted(1),
    "put workout_exercise/e-1": accepted(2),
    "put workout_set/s-1": accepted(3),
  });
}

describe("record ids", () => {
  it("are refused before anything is stored when the server would refuse them", async () => {
    const { store, flag } = await openPhone();
    for (const id of ["", "has space", '"><img>', "x".repeat(65)]) {
      expect(() => store.put("workout", id, workout), JSON.stringify(id)).toThrow(/invalid id/);
    }
    store.put("workout", "w-1:ok.2", workout);
    sync(store, {
      "put workout/w-1:ok.2": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "exists",
        current: { state: "live", kind: "workout", id: "w-1:ok.2", revision: 1, content: workout },
      }),
    });
    expect(() =>
      store.resolve("workout", "w-1:ok.2", { choice: "save_as_new", newId: "bad id" }),
    ).toThrow(/invalid id/);
    expect(store.list("workout").map((r) => r.id)).toEqual(["w-1:ok.2"]);
    expect(flag()).toBe(true);
    store.close();
  });
});

describe("deleting a parent on the device", () => {
  it("settles children with edits or never uploaded once the deletion is accepted", async () => {
    const { store, flag } = await openPhone();
    syncedTree(store);
    store.put("workout_exercise", "e-1", { ...entry("w-1"), restSeconds: 150 }); // edited child
    store.put("workout_exercise", "e-2", { ...entry("w-1"), position: 2 }); // never uploaded
    store.put("workout_set", "s-1", set("e-1", 1, 9)); // edited grandchild
    store.put("workout_set", "s-2", set("e-2", 1)); // never uploaded grandchild
    store.delete("workout", "w-1");

    const outgoing = store.prepareSubmissions("1.0");
    expect(outgoing.map((o) => o.submission)).toMatchObject([
      { op: "delete", submissionId: "id-4", kind: "workout", id: "w-1", baseRevision: 1 },
    ]);
    store.applyPushResults([{ status: "accepted", submissionId: "id-4", revision: 4 }]);

    expect(store.problems()).toEqual([]);
    expect(rows(store)).toEqual({
      "workout/w-1": "synced local=null base=null server=deleted@4",
    });
    expect(flag()).toBe(false);
    // The deletion told the server which descendants this device knew.
    expect(outgoing[0]?.submission).toMatchObject({
      descendants: [
        { kind: "workout_exercise", id: "e-1", revision: 2 },
        { kind: "workout_set", id: "s-1", revision: 3 },
      ],
    });
    store.close();
  });

  it("holds back a deletion too large to send, without blocking other uploads", async () => {
    const { store } = await openPhone();
    const sets = Array.from({ length: 2000 }, (_, index) => ({
      state: "live" as const,
      kind: "workout_set",
      id: `s-${index}`,
      revision: index + 3,
      content: set("e-1", index + 1),
    }));
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
        ...sets,
      ],
      2002,
    );
    store.delete("workout", "w-1");
    store.put("body_measurement", "m-1", { takenAt: T, bodyweightKg: 80.6, fatPercent: null });
    // 2,001 records below the workout: more than one deletion may list.
    expect(sync(store, { "put body_measurement/m-1": accepted(3000) })).toEqual([
      "put body_measurement/m-1",
    ]);
    expect(store.get("workout", "w-1")).toMatchObject({ status: "invalid", deleted: true });
    expect(store.problems().map((p) => [p.id, p.problem?.reason])).toEqual([
      ["w-1", "invalid:too_many_descendants"],
    ]);
    // Keeping the server's version brings the workout back; nothing else is waiting.
    store.resolve("workout", "w-1", { choice: "keep_theirs" });
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(store.get("workout", "w-1")).toMatchObject({ status: "synced", deleted: false });
    store.close();
  });

  it("settles a held-back deletion once the server deletes the record too", async () => {
    const { store } = await openPhone();
    const sets = Array.from({ length: 2000 }, (_, index) => ({
      state: "live" as const,
      kind: "workout_set",
      id: `s-${index}`,
      revision: index + 3,
      content: set("e-1", index + 1),
    }));
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
        ...sets,
      ],
      2002,
    );
    store.delete("workout", "w-1");
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(store.get("workout", "w-1")).toMatchObject({ status: "invalid" });
    // Another device deletes the workout: nothing is left to decide.
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 2003 }], 2003);
    expect(store.problems()).toEqual([]);
    expect(store.summary()).toMatchObject({ invalid: 0, pending: 0 });
    store.close();
  });

  it("refuses to delete the settings record", async () => {
    const { store } = await openPhone();
    store.put("settings", "settings", {
      weightUnit: "kg",
      distanceUnit: "km",
      shortDistanceUnit: "m",
      measurementUnit: "cm",
      firstWeekday: 1,
      defaultRestSeconds: 90,
      rpeEnabled: false,
      countWarmups: true,
      previousValues: "any_workout",
      autoUpdateRoutineValues: true,
    });
    expect(() => store.delete("settings", "settings")).toThrow(DeviceStoreError);
    expect(store.get("settings", "settings")?.status).toBe("pending");
    store.close();
  });
});

describe("deleting during a server restore", () => {
  /** w-1 (revision 1) with e-1 (revision 2), a reset, then the user deletes w-1. */
  async function restoringPhone() {
    const phone = await openPhone();
    phone.store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
      ],
      2,
    );
    phone.store.resetForServerRestore();
    phone.store.delete("workout", "w-1");
    return phone;
  }

  it("asks before deleting a record the restored server has", async () => {
    const { store, flag } = await restoringPhone();
    expect(rows(store)["workout/w-1"]).toBe("pending local=deleted base=null server=null@null");
    expect(store.get("workout", "w-1")?.fromRestore).toBe(false);
    expect(flag()).toBe(true);
    expect(store.prepareSubmissions("1.0")).toEqual([]);

    // The restored server still has the record. Which version the user saw is unknown, so the
    // deletion is not sent against the restored revision without asking.
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      deleted: true,
      problem: { reason: "restored", revision: 1 },
    });
    store.completeRestore();
    // The user's own deletion is not part of the bulk choice.
    expect(store.resolveRestored()).toBe(0);
    store.resolve("workout", "w-1", { choice: "keep_mine" });
    expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toMatchObject([
      { op: "delete", kind: "workout", id: "w-1", baseRevision: 1 },
    ]);
    store.close();
  });

  it("sends the deletion without a base when the restored server lacks the record", async () => {
    const { store, flag } = await restoringPhone();
    store.completeRestore();
    expect(rows(store)).toEqual({
      "workout/w-1": "pending local=deleted base=null server=null@null",
    });
    expect(flag()).toBe(true);
    expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toEqual([
      {
        op: "delete",
        submissionId: "id-1",
        kind: "workout",
        id: "w-1",
        baseRevision: null,
        descendants: [],
      },
    ]);
    store.close();
  });
});

describe("a deletion remembered across a server restore", () => {
  /** w-2 was deleted at revision 3; the server is then restored and has it again at 2. */
  async function phoneWithRememberedDeletion() {
    const phone = await openPhone();
    phone.store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-2", revision: 2, content: workout },
        { state: "deleted", kind: "workout", id: "w-2", revision: 3 },
      ],
      3,
    );
    phone.store.resetForServerRestore();
    expect(rows(phone.store)["workout/w-2"]).toBe(
      "pending local=deleted base=null server=null@null",
    );
    phone.store.applyPull(
      [{ state: "live", kind: "workout", id: "w-2", revision: 2, content: workout }],
      2,
    );
    return phone;
  }

  it("is for the user to review, once the download is complete", async () => {
    const { store } = await phoneWithRememberedDeletion();
    expect(store.get("workout", "w-2")).toMatchObject({
      status: "conflict",
      deleted: true,
      fromRestore: true,
      problem: { reason: "restored", revision: 2 },
      server: { revision: 2, state: "live" },
    });
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    for (const choice of ["keep_mine", "keep_theirs"] as const) {
      expect(() => store.resolve("workout", "w-2", { choice })).toThrow(/wait/);
    }
    expect(() => store.resolveRestored()).toThrow(/wait/);
    store.completeRestore();
    // Keep mine deletes it again, against the restored revision.
    store.resolve("workout", "w-2", { choice: "keep_mine" });
    expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toMatchObject([
      { op: "delete", id: "w-2", baseRevision: 2 },
    ]);
    store.close();
  });

  it("keeps the restored server's record with the bulk choice", async () => {
    const { store, flag } = await phoneWithRememberedDeletion();
    store.completeRestore();
    expect(store.resolveRestored()).toBe(1);
    expect(store.get("workout", "w-2")).toMatchObject({
      status: "synced",
      deleted: false,
      content: workoutRow,
    });
    expect(flag()).toBe(false);
    store.close();
  });
});

describe("a parent the restored server reports deleted", () => {
  /** A synced tree, a reset, and a download showing w-1 deleted. */
  async function restoredDeletion(edit?: (store: DeviceStore) => void) {
    const phone = await openPhone();
    syncedTree(phone.store);
    phone.store.resetForServerRestore();
    edit?.(phone.store);
    phone.store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 4 }], 4);
    return phone;
  }

  it("is reviewed with its untouched children, and the bulk choice drops them", async () => {
    const { store, flag } = await restoredDeletion();
    expect(store.problems().map((p) => [p.kind, p.id, p.problem?.reason])).toEqual([
      ["workout", "w-1", "deleted"],
      ["workout_exercise", "e-1", "parent_deleted"],
      ["workout_set", "s-1", "parent_deleted"],
    ]);
    store.completeRestore();
    expect(store.resolveRestored()).toBe(1);
    expect(rows(store)).toEqual({ "workout/w-1": "synced local=null base=null server=deleted@4" });
    expect(flag()).toBe(false);
    store.close();
  });

  it("is kept for saving as new when the user changed something below it", async () => {
    const { store } = await restoredDeletion((s) => s.put("workout_set", "s-1", set("e-1", 1, 9)));
    expect(rows(store)).toEqual({
      "workout/w-1": "conflict local=live base=null server=deleted@4",
      "workout_exercise/e-1": "conflict local=live base=null server=null@null",
      "workout_set/s-1": "conflict local=live base=null server=null@null",
    });
    expect(store.get("workout_set", "s-1")?.problem?.reason).toBe("parent_deleted");
    expect(store.get("workout", "w-1")).toMatchObject({
      problem: { reason: "deleted", revision: 4 },
      content: workoutRow,
    });

    // The bulk choice would discard the user's edit below w-1, so it leaves the tree alone.
    store.completeRestore();
    expect(store.resolveRestored()).toBe(0);
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-9" });
    expect(localContents(store)).toEqual([
      ["workout", "w-1", null],
      ["workout", "w-9", workoutRow],
      ["workout_exercise", "id-4", entry("w-9")],
      ["workout_set", "id-5", set("id-4", 1, 9)],
    ]);
    store.close();
  });
});

describe("partially synced records", () => {
  async function partialPhone() {
    const phone = await openPhone();
    phone.store.setNegotiated("1.0", ["workouts"], "lineage-1");
    phone.store.put("workout", "w-1", { ...workout, perceivedEffort: 8 });
    sync(phone.store, { "put workout/w-1": accepted(1) });
    expect(phone.store.get("workout", "w-1")?.status).toBe("partial");
    return phone;
  }

  it("become a stale conflict when a newer copy arrives", async () => {
    const { store, flag } = await partialPhone();
    store.applyPull(
      [
        {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 2,
          content: { ...workout, title: "Theirs" },
        },
      ],
      2,
    );
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "stale", revision: 2, at: T },
      content: { ...workoutRow, perceivedEffort: 8 },
      server: { revision: 2, state: "live", content: { ...workoutRow, title: "Theirs" } },
      partialFields: ["perceivedEffort"],
    });
    expect(flag()).toBe(true);
    store.close();
  });

  it("become a deleted conflict when the record is deleted elsewhere", async () => {
    const { store } = await partialPhone();
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 2 }], 2);
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "deleted", revision: 2 },
      content: { ...workoutRow, perceivedEffort: 8 },
      server: { revision: 2, state: "deleted", content: null },
    });
    store.close();
  });

  it("become a conflict when accepted after a newer copy already arrived", async () => {
    const { store } = await openPhone();
    store.put("workout", "w-1", { ...workout, perceivedEffort: 8 });
    const [outgoing] = store.prepareSubmissions("1.0");
    store.applyPull(
      [
        {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 5,
          content: { ...workout, title: "Theirs" },
        },
      ],
      5,
    );
    store.applyPushResults([
      {
        status: "accepted",
        submissionId: outgoing?.submission.submissionId as string,
        revision: 4,
      },
    ]);
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "stale", revision: 5 },
      baseRevision: 4,
      content: { ...workoutRow, perceivedEffort: 8 },
      partialFields: [],
    });
    store.close();
  });
});

describe("deleting a record whose create is still in flight", () => {
  it("purges it when the create is answered retry_later", async () => {
    const { store, flag } = await openPhone();
    store.put("workout", "w-1", workout);
    store.put("workout_exercise", "e-1", entry("w-1"));
    const outgoing = store.prepareSubmissions("1.0");
    expect(outgoing).toHaveLength(2);
    store.delete("workout_exercise", "e-1");
    store.applyPushResults(
      outgoing.map(({ submission }) =>
        submission.kind === "workout"
          ? accepted(1)(submission.submissionId)
          : retryLater(submission.submissionId),
      ),
    );
    expect(rows(store)).toEqual({ "workout/w-1": "synced local=null base=null server=live@1" });
    expect(flag()).toBe(false);
    store.close();
  });

  it("retains its deletion when the abandoned create may already have committed", async () => {
    const { store, flag } = await openPhone();
    store.put("workout", "w-1", workout);
    store.prepareSubmissions("1.0");
    store.delete("workout", "w-1");
    expect(store.abandonSubmissions("1.0")).toBe(1);
    expect(store.get("workout", "w-1")?.deleted).toBe(true);
    expect(flag()).toBe(true);
    const [retry] = store.prepareSubmissions("1.0");
    expect(retry?.submission).toMatchObject({
      kind: "workout",
      id: "w-1",
      op: "delete",
      baseRevision: null,
    });
    if (!retry) throw Error("Expected pending deletion");
    store.applyPushResults([accepted(1)(retry.submission.submissionId)]);
    expect(flag()).toBe(false);
    store.close();
  });
});

describe("resolving rejected versions", () => {
  it("saving a rejected, never uploaded parent as new moves its children with it", async () => {
    const { store, flag } = await openPhone();
    store.put("workout", "w-1", workout);
    store.put("workout_exercise", "e-1", entry("w-1"));
    store.put("workout_set", "s-1", set("e-1", 1));
    sync(store, {
      "put workout/w-1": invalid,
      "put workout_exercise/e-1": retryLater,
      "put workout_set/s-1": retryLater,
    });
    expect(store.get("workout", "w-1")?.status).toBe("invalid");

    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    // id-1 to id-3 went to the three submissions; the copies of the children get id-4 and id-5.
    expect(localContents(store)).toEqual([
      ["workout", "w-2", workoutRow],
      ["workout_exercise", "id-4", entry("w-2")],
      ["workout_set", "id-5", set("id-4", 1)],
    ]);
    expect(rows(store)).toEqual({
      "workout/w-2": "pending local=live base=null server=null@null",
      "workout_exercise/id-4": "pending local=live base=null server=null@null",
      "workout_set/id-5": "pending local=live base=null server=null@null",
    });
    expect(flag()).toBe(true);
    store.close();
  });

  it("refuses keep_theirs and save_as_new until the download after a restore finishes", async () => {
    const { store, flag } = await openPhone();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
      ],
      2,
    );
    store.put("workout", "w-1", { ...workout, title: "Mine" });
    sync(store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "stale",
        current: { state: "live", kind: "workout", id: "w-1", revision: 3, content: workout },
      }),
    });
    store.resetForServerRestore();
    store.put("workout_exercise", "e-1", { ...entry("w-1"), restSeconds: 180 });

    // "Theirs" isn't known until the restored server's copy has been downloaded.
    expect(() => store.resolve("workout", "w-1", { choice: "keep_theirs" })).toThrow(/wait/);
    expect(() => store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" })).toThrow(
      /wait/,
    );
    expect(rows(store)).toEqual({
      "workout/w-1": "conflict local=live base=null server=null@null",
      "workout_exercise/e-1": "pending local=live base=null server=null@null",
    });

    // The restored server has the workout again; now the user can decide.
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "keep_theirs" });
    expect(store.get("workout", "w-1")).toMatchObject({ status: "synced", content: workout });
    expect(store.get("workout_exercise", "e-1")?.content).toMatchObject({ restSeconds: 180 });
    expect(flag()).toBe(true);
    store.close();
  });

  it("keeps a record deleted elsewhere whose descendants hold edits, and saves the tree as new", async () => {
    const { store } = await openPhone();
    syncedTree(store);
    store.put("workout_set", "s-1", set("e-1", 1, 9));
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 4 }], 4);
    expect(rows(store)).toEqual({
      "workout/w-1": "conflict local=live base=null server=deleted@4",
      "workout_exercise/e-1": "conflict local=live base=null server=deleted@4",
      "workout_set/s-1": "conflict local=live base=3 server=live@3",
    });
    expect(store.get("workout", "w-1")?.problem?.reason).toBe("deleted");
    expect(store.get("workout_set", "s-1")?.problem?.reason).toBe("parent_deleted");
    expect(() =>
      store.resolve("workout_set", "s-1", { choice: "save_as_new", newId: "s-9" }),
    ).toThrow(DeviceStoreError);

    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-9" });
    expect(localContents(store)).toEqual([
      ["workout", "w-1", null],
      ["workout", "w-9", workoutRow],
      ["workout_exercise", "id-4", entry("w-9")],
      ["workout_set", "id-5", set("id-4", 1, 9)],
    ]);
    expect(rows(store)["workout/w-1"]).toBe("synced local=null base=null server=deleted@4");
    store.close();
  });

  it("an invalid answer to an older upload leaves the newer edit pending", async () => {
    const { store } = await openPhone();
    store.put("routine_folder", "f-1", { title: "A", position: 1 });
    const [outgoing] = store.prepareSubmissions("1.0");
    store.put("routine_folder", "f-1", { title: "B", position: 1 });
    store.applyPushResults([invalid(outgoing?.submission.submissionId as string)]);
    expect(store.get("routine_folder", "f-1")).toMatchObject({
      status: "pending",
      problem: null,
      content: { title: "B", position: 1 },
      inFlight: false,
    });
    store.close();
  });
});

describe("downloads", () => {
  it("drop a page requested before the cursor or lineage changed", async () => {
    const { store } = await openPhone();
    store.setNegotiated("1.0", ["workouts"], "lineage-1");
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    const before = dumpTables(store.db);
    const page = [
      { state: "live", kind: "workout", id: "w-2", revision: 2, content: workout },
    ] as const;
    expect(store.applyPull(page, 2, { cursor: 0, lineage: "lineage-1" })).toBe(false);
    expect(store.applyPull(page, 2, { cursor: 1, lineage: "lineage-0" })).toBe(false);
    expect(dumpTables(store.db)).toEqual(before);
    expect(store.applyPull(page, 2, { cursor: 1, lineage: "lineage-1" })).toBe(true);
    expect(store.syncState().cursor).toBe(2);
    store.close();
  });
});

describe("records offered again after a server restore", () => {
  const v = (title: string) => ({ ...workout, title });
  const reoffered = (store: DeviceStore, id: string) =>
    Number(store.db.get("SELECT reoffered FROM records WHERE id = ?", [id])?.reoffered);
  const exists = (id: string, revision: number, title: string) => (submissionId: string) =>
    ({
      status: "conflict",
      submissionId,
      reason: "exists",
      current: { state: "live", kind: "workout", id, revision, content: v(title) },
    }) as const;

  /** w-a (revision 3) and w-b (revision 8) synced, then a reset after a server restore. */
  async function restoredPhone() {
    const phone = await openPhone();
    phone.store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-a", revision: 3, content: v("A") },
        { state: "live", kind: "workout", id: "w-b", revision: 8, content: v("B") },
      ],
      8,
    );
    phone.store.resetForServerRestore();
    return phone;
  }

  it("are all marked, whatever their revision", async () => {
    const { store } = await restoredPhone();
    expect([reoffered(store, "w-a"), reoffered(store, "w-b")]).toEqual([1, 1]);
    expect(store.get("workout", "w-a")?.fromRestore).toBe(true);
    store.close();
  });

  it("are confirmed quietly only when the restored server's copy is equal", async () => {
    const { store } = await restoredPhone();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-a", revision: 2, content: v("A") },
        { state: "live", kind: "workout", id: "w-b", revision: 5, content: v("B restored") },
      ],
      5,
    );
    expect(rows(store)["workout/w-a"]).toBe("synced local=null base=null server=live@2");
    expect(reoffered(store, "w-a")).toBe(0);
    // A different copy is not taken quietly: the upload decides, and its answer is reviewed.
    expect(store.get("workout", "w-b")).toMatchObject({
      status: "pending",
      content: { ...workoutRow, title: "B" },
      fromRestore: true,
    });
    store.close();
  });

  it("become conflicts for exists, stale and deleted answers", async () => {
    for (const reason of ["exists", "stale", "deleted"] as const) {
      const { store } = await restoredPhone();
      const current =
        reason === "deleted"
          ? ({ state: "deleted", kind: "workout", id: "w-a", revision: 4 } as const)
          : ({
              state: "live",
              kind: "workout",
              id: "w-a",
              revision: 4,
              content: v("Server"),
            } as const);
      sync(store, {
        "put workout/w-a": (submissionId) => ({
          status: "conflict",
          submissionId,
          reason,
          current,
        }),
        "put workout/w-b": exists("w-b", 5, "Old B"),
      });
      expect(store.get("workout", "w-a"), reason).toMatchObject({
        status: "conflict",
        fromRestore: true,
        problem: { reason, revision: 4 },
        content: { ...workoutRow, title: "A" },
      });
      expect(store.get("workout", "w-b")).toMatchObject({
        status: "conflict",
        problem: { reason: "exists", revision: 5 },
        content: { ...workoutRow, title: "B" },
      });
      store.close();
    }
  });

  it("take the restored server's version with the bulk choice", async () => {
    const { store, flag } = await restoredPhone();
    sync(store, {
      "put workout/w-a": exists("w-a", 4, "Server A"),
      "put workout/w-b": exists("w-b", 5, "Server B"),
    });
    store.completeRestore();
    expect(store.resolveRestored()).toBe(2);
    expect(rows(store)).toEqual({
      "workout/w-a": "synced local=null base=null server=live@4",
      "workout/w-b": "synced local=null base=null server=live@5",
    });
    expect(store.get("workout", "w-a")?.content).toMatchObject({ title: "Server A" });
    expect(flag()).toBe(false);
    store.close();
  });

  it("lose the mark once accepted, when the restored server stored them anew", async () => {
    const { store, flag } = await restoredPhone();
    sync(store, { "put workout/w-a": accepted(6), "put workout/w-b": accepted(7) });
    expect(rows(store)["workout/w-a"]).toBe("synced local=null base=null server=live@6");
    expect(reoffered(store, "w-a")).toBe(0);
    store.completeRestore();
    expect(flag()).toBe(false);
    store.close();
  });

  it("leave the bulk choice once the user edits them", async () => {
    const { store } = await restoredPhone();
    store.put("workout", "w-a", v("A edited"));
    expect(reoffered(store, "w-a")).toBe(0);
    sync(store, {
      "put workout/w-a": exists("w-a", 4, "Server"),
      "put workout/w-b": exists("w-b", 5, "Server B"),
    });
    store.completeRestore();
    expect(store.resolveRestored()).toBe(1);
    expect(store.get("workout", "w-a")).toMatchObject({
      status: "conflict",
      fromRestore: false,
      content: { ...workoutRow, title: "A edited" },
    });
    expect(store.get("workout", "w-b")?.status).toBe("synced");
    store.close();
  });
});

describe("conflicts carried through a server restore", () => {
  /** w-1 synced at 1, the user's edit rejected as stale against revision 2, then a reset. */
  async function carriedConflict() {
    const phone = await openPhone();
    phone.store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    phone.store.put("workout", "w-1", { ...workout, title: "Mine" });
    sync(phone.store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "stale",
        current: { state: "live", kind: "workout", id: "w-1", revision: 2, content: workout },
      }),
    });
    phone.store.resetForServerRestore();
    return phone;
  }

  it("are confirmed when the restored server has exactly the user's version", async () => {
    const { store, flag } = await carriedConflict();
    store.applyPull(
      [
        {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 3,
          content: { ...workout, title: "Mine" },
        },
      ],
      3,
    );
    expect(rows(store)["workout/w-1"]).toBe("synced local=null base=null server=live@3");
    expect(store.get("workout", "w-1")?.problem).toBeNull();
    store.completeRestore();
    expect(flag()).toBe(false);
    store.close();
  });

  it("stay for review when the restored server's copy differs", async () => {
    const { store } = await carriedConflict();
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    // The rejection was about the old history; it is now about the restored server's copy.
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      fromRestore: false,
      problem: { reason: "restored", revision: 1 },
      content: { ...workoutRow, title: "Mine" },
      server: { revision: 1, content: workoutRow },
      keptContent: null,
    });
    store.completeRestore();
    // The user's own edit is never part of the bulk choice.
    expect(store.resolveRestored()).toBe(0);
    store.close();
  });

  it("offer the last server copy again on keep theirs when the restored server lacks it", async () => {
    const { store } = await carriedConflict();
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      problem: { reason: "restored", revision: null },
      server: null,
      keptContent: workoutRow,
    });
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "keep_theirs" });
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "pending",
      fromRestore: true,
      content: workoutRow,
      keptContent: null,
    });
    expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toMatchObject([
      { op: "put", id: "w-1", baseRevision: null, content: workout },
    ]);
    store.close();
  });

  it("keep the last server copy when the user retries or edits an invalid version", async () => {
    for (const retry of ["keep_mine", "edit"] as const) {
      const { store } = await openPhone();
      store.applyPull(
        [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
        1,
      );
      store.put("workout", "w-1", { ...workout, title: "Mine" });
      sync(store, { "put workout/w-1": invalid });
      store.resetForServerRestore();
      store.completeRestore();
      if (retry === "keep_mine") store.resolve("workout", "w-1", { choice: "keep_mine" });
      else store.put("workout", "w-1", { ...workout, title: "Mine, again" });
      expect(store.get("workout", "w-1"), retry).toMatchObject({
        status: "pending",
        keptContent: workoutRow,
      });
      sync(store, { "put workout/w-1": invalid });
      store.resolve("workout", "w-1", { choice: "keep_theirs" });
      expect(store.get("workout", "w-1"), retry).toMatchObject({
        status: "pending",
        content: workoutRow,
        fromRestore: true,
      });
      store.close();
    }
  });

  it("stay for review when the user deletes them after the restore", async () => {
    const { store } = await carriedConflict();
    store.completeRestore();
    store.delete("workout", "w-1");
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "conflict",
      deleted: true,
      keptContent: workoutRow,
    });
    // Keeping theirs still brings back the last server copy.
    store.resolve("workout", "w-1", { choice: "keep_theirs" });
    expect(store.get("workout", "w-1")).toMatchObject({ status: "pending", content: workoutRow });
    store.close();
  });

  it("keep theirs too when the user's version is saved as new", async () => {
    const { store } = await carriedConflict();
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    expect(localContents(store)).toEqual([
      ["workout", "w-1", workoutRow],
      ["workout", "w-2", { ...workoutRow, title: "Mine" }],
    ]);
    expect(
      store.prepareSubmissions("1.0").map((o) => [o.submission.id, o.submission.baseRevision]),
    ).toEqual([
      ["w-1", null],
      ["w-2", null],
    ]);
    store.close();
  });

  it("put the old tree back to its last server copies when the user's tree is saved as new", async () => {
    const { store } = await openPhone();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
        { state: "live", kind: "workout_set", id: "s-1", revision: 3, content: set("e-1", 1) },
      ],
      3,
    );
    store.put("workout", "w-1", { ...workout, title: "Mine" });
    sync(store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "stale",
        current: { state: "live", kind: "workout", id: "w-1", revision: 4, content: workout },
      }),
    });
    store.put("workout_set", "s-1", set("e-1", 1, 8));
    store.put("workout_set", "s-new", set("e-1", 2, 3));
    store.resetForServerRestore();
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    // The copy holds the user's versions; the old tree holds the server's again.
    expect(localContents(store)).toEqual([
      ["workout", "w-1", workoutRow],
      ["workout", "w-2", { ...workoutRow, title: "Mine" }],
      ["workout_exercise", "e-1", entry("w-1")],
      ["workout_exercise", "id-2", entry("w-2")],
      ["workout_set", "id-3", set("id-2", 1, 8)],
      ["workout_set", "id-4", set("id-2", 2, 3)],
      ["workout_set", "s-1", set("e-1", 1)],
    ]);
    store.close();
  });

  it("put the old tree back even when the user edits it after the restore began", async () => {
    const { store } = await openPhone();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
        { state: "live", kind: "workout_set", id: "s-1", revision: 3, content: set("e-1", 1) },
      ],
      3,
    );
    store.put("workout", "w-1", { ...workout, title: "Mine" });
    sync(store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "stale",
        current: { state: "live", kind: "workout", id: "w-1", revision: 4, content: workout },
      }),
    });
    store.resetForServerRestore();
    // Logging goes on while the restored server's records download.
    store.put("workout_set", "s-1", set("e-1", 1, 8));
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    // The edit moves with the copy, and the old set holds its last server copy again: the set is
    // never uploaded twice.
    expect(localContents(store)).toEqual([
      ["workout", "w-1", workoutRow],
      ["workout", "w-2", { ...workoutRow, title: "Mine" }],
      ["workout_exercise", "e-1", entry("w-1")],
      ["workout_exercise", "id-2", entry("w-2")],
      ["workout_set", "id-3", set("id-2", 1, 8)],
      ["workout_set", "s-1", set("e-1", 1)],
    ]);
    store.close();
  });

  it("are deleted on the server too when the user deletes a copy offered again", async () => {
    const { store } = await openPhone();
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    store.resetForServerRestore();
    store.completeRestore();
    store.delete("workout", "w-1");
    expect(rows(store)["workout/w-1"]).toBe("pending local=deleted base=null server=null@null");
    // An abandoned upload doesn't drop the deletion either.
    expect(store.prepareSubmissions("1.0")).toHaveLength(1);
    store.abandonSubmissions("1.0");
    expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toMatchObject([
      { op: "delete", id: "w-1", baseRevision: null },
    ]);
    store.close();
  });

  it("drop a child of a parent deleted on the restored server with one keep theirs", async () => {
    const { store } = await openPhone();
    syncedTree(store);
    store.resetForServerRestore();
    store.put("workout_set", "s-1", set("e-1", 1, 9));
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 4 }], 4);
    store.completeRestore();
    expect(store.get("workout_set", "s-1")).toMatchObject({
      problem: { reason: "parent_deleted" },
    });
    store.resolve("workout_set", "s-1", { choice: "keep_theirs" });
    expect(store.get("workout_set", "s-1")).toBeNull();
    store.close();
  });

  it("send the deletion of any record a server had before the restore", async () => {
    const deleteAfter = async (setUp: (store: DeviceStore) => void) => {
      const { store } = await openPhone();
      store.applyPull(
        [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
        1,
      );
      setUp(store);
      store.resetForServerRestore();
      store.completeRestore();
      return store;
    };
    // Offered again and then edited; and deleted on the old server while the user edited it.
    const edited = await deleteAfter(() => {});
    edited.put("workout", "w-1", { ...workout, title: "Edited after the restore" });
    const deletedThere = await deleteAfter((store) => {
      store.put("workout", "w-1", { ...workout, title: "Mine" });
      store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 2 }], 2);
    });
    for (const store of [edited, deletedThere]) {
      store.delete("workout", "w-1");
      if (store === deletedThere) {
        // A conflict stays one; keeping the deletion sends it.
        expect(store.get("workout", "w-1")).toMatchObject({ status: "conflict", deleted: true });
        store.resolve("workout", "w-1", { choice: "keep_mine" });
      }
      expect(store.prepareSubmissions("1.0").map((o) => o.submission)).toMatchObject([
        { op: "delete", id: "w-1", baseRevision: null },
      ]);
      store.close();
    }
  });

  it("purge a record created and deleted during the restore without telling the server", async () => {
    const { store, flag } = await openPhone();
    store.resetForServerRestore();
    store.put("workout", "w-new", workout);
    store.delete("workout", "w-new");
    expect(store.get("workout", "w-new")).toBeNull();
    store.completeRestore();
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(flag()).toBe(false);
    store.close();
  });

  /** w-1 > e-1 > s-1 synced; the user's edit of w-1 rejected as stale. */
  async function rejectedTree() {
    const phone = await openPhone();
    phone.store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
        { state: "live", kind: "workout_set", id: "s-1", revision: 3, content: set("e-1", 1) },
      ],
      3,
    );
    phone.store.put("workout", "w-1", { ...workout, title: "Mine" });
    sync(phone.store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "stale",
        current: { state: "live", kind: "workout", id: "w-1", revision: 4, content: workout },
      }),
    });
    return phone;
  }

  it("put a set moved under the user's new entry back where the server had it", async () => {
    const { store } = await rejectedTree();
    store.put("workout_exercise", "e-new", { ...entry("w-1"), position: 2 });
    store.put("workout_set", "s-1", set("e-new", 1, 7));
    store.resetForServerRestore();
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    expect(store.get("workout_set", "s-1")).toMatchObject({
      status: "pending",
      content: set("e-1", 1),
      fromRestore: true,
    });
    expect(store.get("workout_exercise", "e-new")).toBeNull();
    expect(store.list("workout_set").map((r) => r.content?.reps)).toEqual(
      expect.arrayContaining([5, 7]),
    );
    store.close();
  });

  it("put a child the restored server has back to its copy when the tree is saved as new", async () => {
    const { store } = await rejectedTree();
    store.put("workout_exercise", "e-1", { ...entry("w-1"), restSeconds: 60 });
    store.resetForServerRestore();
    // The restored server has the entry, but not the workout or the set.
    store.applyPull(
      [{ state: "live", kind: "workout_exercise", id: "e-1", revision: 1, content: entry("w-1") }],
      1,
    );
    store.completeRestore();
    store.resolve("workout", "w-1", { choice: "save_as_new", newId: "w-2" });
    expect(rows(store)["workout_exercise/e-1"]).toBe("synced local=null base=null server=live@1");
    expect(
      store
        .list("workout_exercise")
        .map((r) => [r.content?.workoutId, r.content?.restSeconds])
        .sort(),
    ).toEqual([
      ["w-1", 120],
      ["w-2", 60],
    ]);
    store.close();
  });

  it("keep the mark of records offered again through a second restore", async () => {
    const { store } = await openPhone();
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    store.resetForServerRestore();
    sync(store, {
      "put workout/w-1": (submissionId) => ({
        status: "conflict",
        submissionId,
        reason: "exists",
        current: {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 4,
          content: { ...workout, title: "Other" },
        },
      }),
    });
    store.resetForServerRestore();
    expect(store.get("workout", "w-1")).toMatchObject({ status: "conflict", fromRestore: true });
    store.applyPull(
      [
        {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision: 2,
          content: { ...workout, title: "Other" },
        },
      ],
      2,
    );
    store.completeRestore();
    expect(store.resolveRestored()).toBe(1);
    expect(store.get("workout", "w-1")).toMatchObject({
      status: "synced",
      content: { title: "Other" },
    });
    store.close();
  });

  it("leave the bulk choice once the user keeps their version", async () => {
    const { store } = await openPhone();
    store.applyPull(
      [{ state: "live", kind: "workout", id: "w-1", revision: 1, content: workout }],
      1,
    );
    store.resetForServerRestore();
    store.completeRestore();
    const exists = (revision: number) => (submissionId: string) =>
      ({
        status: "conflict",
        submissionId,
        reason: revision === 4 ? "exists" : "stale",
        current: {
          state: "live",
          kind: "workout",
          id: "w-1",
          revision,
          content: { ...workout, title: `r${revision}` },
        },
      }) as const;
    sync(store, { "put workout/w-1": exists(4) });
    store.resolve("workout", "w-1", { choice: "keep_mine" });
    expect(store.get("workout", "w-1")?.fromRestore).toBe(false);
    sync(store, { "put workout/w-1": exists(5) });
    // The user chose this version; the bulk choice must not take it back.
    expect(store.resolveRestored()).toBe(0);
    expect(store.get("workout", "w-1")).toMatchObject({ status: "conflict", content: workoutRow });
    store.close();
  });
});

describe("children of a record the user deleted", () => {
  /** A synced tree with an edited set under it; the user then deletes the workout. */
  async function deletedTree() {
    const phone = await openPhone();
    syncedTree(phone.store);
    phone.store.put("workout_set", "s-1", set("e-1", 1, 9));
    phone.store.delete("workout", "w-1");
    return phone;
  }

  it("are dropped when a download shows that someone else deleted the record too", async () => {
    const { store, flag } = await deletedTree();
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 4 }], 4);
    expect(store.problems()).toEqual([]);
    expect(rows(store)).toEqual({ "workout/w-1": "synced local=null base=null server=deleted@4" });
    expect(flag()).toBe(false);
    store.close();
  });

  it("are dropped when the device's own deletion was abandoned and the download shows it", async () => {
    const { store, flag } = await deletedTree();
    expect(store.prepareSubmissions("1.0").map((o) => o.submission.op)).toEqual(["delete"]);
    store.abandonSubmissions("1.0");
    store.applyPull([{ state: "deleted", kind: "workout", id: "w-1", revision: 4 }], 4);
    expect(store.problems()).toEqual([]);
    expect(rows(store)).toEqual({ "workout/w-1": "synced local=null base=null server=deleted@4" });
    expect(flag()).toBe(false);
    store.close();
  });
});

describe("deleting an invalid record", () => {
  it("clears its problem", async () => {
    const { store } = await openPhone();
    store.put("routine_folder", "f-1", { title: "A", position: 1 });
    sync(store, { "put routine_folder/f-1": accepted(1) });
    store.put("routine_folder", "f-1", { title: "B", position: 1 });
    sync(store, { "put routine_folder/f-1": invalid });
    expect(store.problems().map((r) => r.id)).toEqual(["f-1"]);

    store.delete("routine_folder", "f-1");
    expect(store.get("routine_folder", "f-1")).toMatchObject({
      status: "pending",
      deleted: true,
      problem: null,
    });
    expect(store.problems()).toEqual([]);
    store.close();
  });
});

describe("preparing uploads", () => {
  // A routine of five sets: a little over 1000 bytes.
  const long = (title: string) => ({
    title,
    folderId: null,
    position: 1,
    exercises: [
      {
        id: "x",
        exerciseId: "bench",
        exerciseName: "Bench",
        exerciseType: "weight_reps",
        supersetId: null,
        restSeconds: 90,
        useRepRange: false,
        sets: Array.from({ length: 5 }, (_, i) => ({
          id: `s${i}`,
          type: "normal",
          weightKg: 60,
          reps: 8,
          repRangeMin: null,
          repRangeMax: null,
          distanceMeters: null,
          durationSeconds: null,
          count: null,
          rpe: null,
        })),
      },
    ],
  });

  it("stops adding submissions once the batch reaches its size limit, but sends at least one", async () => {
    const { store } = await openPhone();
    for (const id of ["w-1", "w-2", "w-3"]) store.put("routine", id, long(id));
    expect(store.prepareSubmissions("1.0", 100, 1).map((o) => o.submission.id)).toEqual(["w-1"]);
    // The submission in flight already fills the batch: nothing new is added.
    expect(store.prepareSubmissions("1.0", 100, 1).map((o) => o.submission.id)).toEqual(["w-1"]);
    // Each submission is a little over 1000 bytes: a 1500-byte batch takes a second one, then stops.
    expect(store.prepareSubmissions("1.0", 100, 1500).map((o) => o.submission.id)).toEqual([
      "w-1",
      "w-2",
    ]);
    expect(store.prepareSubmissions("1.0").map((o) => o.submission.id)).toEqual([
      "w-1",
      "w-2",
      "w-3",
    ]);
    store.close();
  });

  it("holds a parent's deletion while a descendant is in flight", async () => {
    const { store } = await openPhone();
    syncedTree(store);
    store.put("workout_set", "s-1", set("e-1", 1, 9));
    const [inFlight] = store.prepareSubmissions("1.0");
    store.delete("workout", "w-1");
    expect(
      store.prepareSubmissions("1.0").map((o) => `${o.submission.op} ${o.submission.id}`),
    ).toEqual(["put s-1"]);
    const sentId = inFlight!.submission.submissionId;
    store.applyPushResults([accepted(4)(sentId)], new Set([sentId]));
    const [deletion] = store.prepareSubmissions("1.0");
    expect(deletion?.submission).toMatchObject({
      op: "delete",
      id: "w-1",
      descendants: [
        { kind: "workout_exercise", id: "e-1", revision: 2 },
        { kind: "workout_set", id: "s-1", revision: 4 },
      ],
    });
    store.close();
  });

  it("holds a parent's deletion while a descendant moving elsewhere is in the same batch", async () => {
    const { store } = await openPhone();
    syncedTree(store);
    store.put("workout", "w-2", workout);
    store.put("workout_exercise", "e-1", entry("w-2")); // moved to another workout
    store.delete("workout", "w-1");
    expect(
      store.prepareSubmissions("1.0").map((o) => `${o.submission.op} ${o.submission.id}`),
    ).toEqual(["put w-2", "put e-1"]);
    store.close();
  });
});

it("disputes a queued cascade when a corrected descendant arrives before the delete is prepared", async () => {
  const { store } = await openPhone();
  try {
    store.setNegotiated("1.0", ["workouts"], "lineage");
    store.applyPull(
      [
        { kind: "workout", id: "w", state: "live", revision: 1, content: workout },
        { kind: "workout_exercise", id: "e", state: "live", revision: 2, content: entry("w") },
        { kind: "workout_set", id: "s", state: "live", revision: 3, content: set("e", 1, 5) },
      ],
      3,
    );
    store.delete("workout", "w");
    store.applyPull(
      [{ kind: "workout_set", id: "s", state: "live", revision: 4, content: set("e", 1, 12) }],
      4,
    );
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(store.get("workout", "w")?.status).toBe("conflict");
    store.resolve("workout", "w", { choice: "keep_theirs" });
    expect(store.get("workout_set", "s")?.content?.reps).toBe(12);
  } finally {
    store.close();
  }
});

it.each([true, false])(
  "retains a discard after resetting an unacknowledged create (restored copy: %s)",
  async (exists) => {
    const { store } = await openPhone();
    try {
      store.put("workout", "w", workout);
      expect(store.prepareSubmissions("1.0")).toHaveLength(1);
      store.resetForServerRestore();
      store.delete("workout", "w");
      if (exists)
        store.applyPull(
          [{ kind: "workout", id: "w", state: "live", revision: 1, content: workout }],
          1,
        );
      store.completeRestore();
      expect(store.get("workout", "w")?.deleted).toBe(true);
      if (exists) expect(store.get("workout", "w")?.status).toBe("conflict");
      else expect(store.prepareSubmissions("1.0")[0]?.submission.op).toBe("delete");
    } finally {
      store.close();
    }
  },
);

it("disputes a queued workout deletion when an outstanding set upload returns another phone's correction", async () => {
  const { store } = await openPhone();
  try {
    syncedTree(store);
    store.put("workout_set", "s-1", set("e-1", 1, 8));
    const [sent] = store.prepareSubmissions("1.0");
    store.delete("workout", "w-1");
    const correction = {
      kind: "workout_set",
      id: "s-1",
      state: "live" as const,
      revision: 4,
      content: set("e-1", 1, 12),
    };
    store.applyPushResults([
      {
        submissionId: sent!.submission.submissionId,
        status: "conflict",
        reason: "stale",
        current: correction,
      },
    ]);
    store.applyPull([correction], 4);
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(store.get("workout", "w-1")?.status).toBe("conflict");
    expect(store.get("workout_set", "s-1")?.server?.content?.reps).toBe(12);
  } finally {
    store.close();
  }
});

it("settles a disputed queued deletion when another phone deletes the same workout", async () => {
  const { store } = await openPhone();
  try {
    syncedTree(store);
    store.delete("workout", "w-1");
    store.applyPull(
      [{ kind: "workout_set", id: "s-1", state: "live", revision: 4, content: set("e-1", 1, 12) }],
      4,
    );
    expect(store.get("workout", "w-1")?.status).toBe("conflict");
    store.applyPull(
      [
        { kind: "workout_set", id: "s-1", state: "deleted", revision: 5 },
        { kind: "workout_exercise", id: "e-1", state: "deleted", revision: 6 },
        { kind: "workout", id: "w-1", state: "deleted", revision: 7 },
      ],
      7,
    );
    expect(store.get("workout", "w-1")).toMatchObject({ status: "synced", deleted: true });
    expect(store.problems()).toEqual([]);
    expect(store.prepareSubmissions("1.0")).toEqual([]);
  } finally {
    store.close();
  }
});

it("reviews a workout discarded between restore pages before deleting a newly restored set", async () => {
  const { store } = await openPhone();
  try {
    syncedTree(store);
    store.resetForServerRestore();
    store.applyPull(
      [
        { state: "live", kind: "workout", id: "w-1", revision: 1, content: workout },
        { state: "live", kind: "workout_exercise", id: "e-1", revision: 2, content: entry("w-1") },
      ],
      2,
    );
    expect(store.get("workout", "w-1")?.status).toBe("synced");
    store.delete("workout", "w-1");
    store.applyPull(
      [{ state: "live", kind: "workout_set", id: "s-1", revision: 5, content: set("e-1", 1, 12) }],
      5,
    );
    store.completeRestore();
    expect(store.get("workout", "w-1")?.status).toBe("conflict");
    expect(
      store.prepareSubmissions("1.0").some(({ submission }) => submission.op === "delete"),
    ).toBe(false);
    expect(store.get("workout_set", "s-1")?.server?.content?.reps).toBe(12);
  } finally {
    store.close();
  }
});

it("settles a matching deletion pulled before an earlier put receipt returns", async () => {
  const { store, flag } = await openPhone();
  try {
    syncedTree(store);
    store.put("workout", "w-1", { ...workout, title: "Edited" });
    const [sent] = store.prepareSubmissions("1.0");
    store.delete("workout", "w-1");
    store.applyPull([{ kind: "workout", id: "w-1", state: "deleted", revision: 5 }], 5);
    store.applyPushResults([accepted(4)(sent!.submission.submissionId)]);
    expect(store.get("workout", "w-1")).toMatchObject({
      deleted: true,
      status: "synced",
      server: { revision: 5 },
    });
    expect(flag()).toBe(false);
  } finally {
    store.close();
  }
});
