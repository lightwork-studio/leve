import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry, Peer1, set, workout } from "./support/content.ts";
import { expectSynced, FaultyTransport, type ServerHarness, World } from "./support/harness.ts";

/*
 * Reviewers' reproducers for server restores, kept as regressions: what the restored server holds
 * is never overwritten or deleted without the user deciding. Expected results are written out
 * literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

async function phoneOn(server: ServerHarness, name: string, pageSize?: number) {
  const net = new FaultyTransport(server.transport("alice"));
  const phone = await world.phone(name, {
    account: "alice",
    server: "s",
    transport: net.call,
    ...(pageSize ? { pageSize } : {}),
  });
  return { phone, net };
}

const summary = (records: { kind: string; id: string; problem: { reason: string } | null }[]) =>
  records.map((r) => [r.kind, r.id, r.problem?.reason]);

describe("a deletion remembered across a restore", () => {
  /** w1 with e1 synced, backed up, then deleted by the phone; the backup is restored. */
  async function deletedParent() {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("one"));
    phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    expectSynced(await phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    phone.store.delete("workout", "w1");
    expectSynced(await phone.sync());
    await server.restoreWithCommand("alice", backup);
    const other = new Peer1(server.transport("alice"), "other");
    await other.pull();
    return { server, phone, other };
  }

  it("never deletes an entry edited on the restored server without asking", async () => {
    const { server, phone, other } = await deletedParent();
    await other.push([other.put("workout_exercise", "e1", entry("w1", "Squat, after restore"))]);

    expectSynced(await phone.sync());
    expectSynced(await phone.sync());
    const rows = await server.rows("alice");
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["w1", "live"],
      ["e1", "live"],
    ]);
    // Both remembered deletions, the workout's and the entry's, are the user's to confirm.
    expect(summary(phone.store.problems())).toEqual([
      ["workout", "w1", "restored"],
      ["workout_exercise", "e1", "restored"],
    ]);
    expect(phone.store.get("workout", "w1")).toMatchObject({ deleted: true, fromRestore: true });

    // Keeping the restored server's version brings back the workout with the later edit.
    expect(phone.store.resolveRestored()).toBe(2);
    expect(phone.store.get("workout_exercise", "e1")?.content).toMatchObject({
      exerciseName: "Squat, after restore",
    });
    expect(phone.store.hasUnsyncedWork()).toBe(false);
  });

  it("never deletes an entry created on the restored server without asking", async () => {
    const { server, phone, other } = await deletedParent();
    await other.push([other.put("workout_exercise", "e9", entry("w1", "logged after restore"))]);

    expectSynced(await phone.sync());
    expectSynced(await phone.sync());
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["w1", "live"],
      ["e1", "live"],
      ["e9", "live"],
    ]);
    expect(summary(phone.store.problems())).toEqual([
      ["workout", "w1", "restored"],
      ["workout_exercise", "e1", "restored"],
    ]);

    // Deleting again is the user's explicit choice and takes the entries with it.
    phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    expectSynced(await phone.sync());
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["e1", "deleted"],
      ["e9", "deleted"],
      ["w1", "deleted"],
    ]);
    expect(phone.store.problems()).toEqual([]);
  });

  it("is not sent when a second restore lands while the first download is half done", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone", 1);
    phone.store.put("workout", "w1", workout("one"));
    phone.store.put("workout", "w2", workout("two"));
    expectSynced(await phone.sync());
    const first = join(world.directory, "first.db");
    await server.snapshot("alice", first);
    phone.store.delete("workout", "w2");
    expectSynced(await phone.sync());
    await server.restoreWithCommand("alice", first);
    const other = new Peer1(server.transport("alice"), "other");
    await other.pull();
    await other.push([other.put("workout", "w2", workout("two, edited after the restore"))]);
    // The phone starts its download, gets one page, then loses the connection.
    net.next("pass", "/sync/pull").next("offline", "/sync/pull");
    expect((await phone.sync()).state).toBe("offline");
    expect(phone.store.syncState().restoring).toBe(true);
    const second = join(world.directory, "second.db");
    await server.snapshot("alice", second);
    await server.restoreWithCommand("alice", second);

    expectSynced(await phone.sync());
    expectSynced(await phone.sync());
    expect(await server.row("alice", "workout", "w2")).toMatchObject({
      state: "live",
      content: { title: "two, edited after the restore" },
    });
    expect(summary(phone.store.problems())).toEqual([["workout", "w2", "restored"]]);
  });
});

describe("a rejected deletion carried through a restore", () => {
  /**
   * The backup predates w1. The phone's deletion of w1 is rejected because another device added
   * e9 under it; then the backup is restored, so the restored server has neither.
   */
  async function rejectedDeletion() {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    phone.store.put("workout", "w0", workout("zero"));
    expectSynced(await phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    phone.store.put("workout", "w1", workout("one"));
    expectSynced(await phone.sync());
    const other = new Peer1(server.transport("alice"), "other");
    await other.pull();
    await other.push([other.put("workout_exercise", "e9", entry("w1", "Added elsewhere"))]);
    phone.store.delete("workout", "w1");
    expectSynced(await phone.sync());
    expect(phone.store.get("workout", "w1")?.problem?.reason).toBe("stale");
    expect(phone.store.get("workout_exercise", "e9")?.status).toBe("synced");

    await server.restoreWithCommand("alice", backup);
    expectSynced(await phone.sync());
    expectSynced(await phone.sync());
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      deleted: true,
      problem: { reason: "restored" },
      server: null,
      keptContent: { title: "one" },
    });
    // The entry another device added waits for the decision about its workout.
    expect(phone.store.get("workout_exercise", "e9")).toMatchObject({
      status: "pending",
      fromRestore: true,
    });
    expect((await server.rows("alice")).map((r) => r.id)).toEqual(["w0"]);
    return { server, phone };
  }

  it("brings back the workout and the entry added elsewhere on keep theirs", async () => {
    const { server, phone } = await rejectedDeletion();
    expect(phone.store.resolveRestored()).toBe(0);
    phone.store.resolve("workout", "w1", { choice: "keep_theirs" });
    expectSynced(await phone.sync());
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["w0", "live"],
      ["w1", "live"],
      ["e9", "live"],
    ]);
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.hasUnsyncedWork()).toBe(false);
  });

  it("deletes both on keep mine", async () => {
    const { server, phone } = await rejectedDeletion();
    phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    expectSynced(await phone.sync());
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["w0", "live"],
      ["w1", "deleted"],
    ]);
    expect(phone.store.get("workout_exercise", "e9")).toBeNull();
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.hasUnsyncedWork()).toBe(false);
  });
});

describe("a conflict carried through a restore", () => {
  it("can keep the user's set once the restore brings back its workout", async () => {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    const { phone: tablet } = await phoneOn(server, "tablet");
    phone.store.put("workout", "w1", workout("one"));
    phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    phone.store.put("workout_set", "s1", set("e1"));
    expectSynced(await phone.sync());
    expectSynced(await tablet.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    phone.store.delete("workout", "w1");
    expectSynced(await phone.sync());
    tablet.store.put("workout_set", "s1", set("e1", { reps: 12 }));
    expectSynced(await tablet.sync());
    expect(tablet.store.get("workout_set", "s1")?.problem?.reason).toBe("parent_deleted");

    await server.restoreWithCommand("alice", backup);
    expectSynced(await tablet.sync());
    expectSynced(await tablet.sync());
    // The workout is back; the set's problem is now about the restore, so it can be kept.
    expect(summary(tablet.store.problems())).toEqual([["workout_set", "s1", "restored"]]);
    expect(tablet.store.resolveRestored()).toBe(0);
    tablet.store.resolve("workout_set", "s1", { choice: "keep_mine" });
    expectSynced(await tablet.sync());
    expect((await server.row("alice", "workout_set", "s1"))?.content).toMatchObject({ reps: 12 });
    expect(tablet.store.problems()).toEqual([]);
  });
});

describe("a failed request while the device looks for a restore", () => {
  it("changes nothing on the device, and no edit is lost once it succeeds", async () => {
    const server = world.server();
    const { phone: a, net } = await phoneOn(server, "a");
    const { phone: b } = await phoneOn(server, "b");
    a.store.put("workout", "w1", workout("one"));
    expectSynced(await a.sync());
    const copy = join(world.directory, "copy.db");
    await server.snapshot("alice", copy);
    for (let i = 2; i <= 4; i++) a.store.put("workout", `w${i}`, workout(`w${i}`));
    expectSynced(await a.sync());
    expectSynced(await b.sync());
    a.store.put("workout", "w2", workout("A's edit"));
    // Files copied back by hand: the server's counter (1) is behind both devices (4).
    await server.restore("alice", copy);
    const lineage = a.store.syncState().lineage;
    let failNext = true;
    net.beforeReply = (path, response) => {
      if (path === "/sync/pull" && failNext) {
        failNext = false;
        response.status = 503;
        response.body = { error: { code: "unavailable", message: "busy" } };
      }
    };

    expect((await a.sync()).state).toBe("error");
    expect(a.store.syncState()).toMatchObject({ lineage, cursor: 4, restoring: false });
    expect(a.store.get("workout", "w2")).toMatchObject({
      status: "pending",
      content: { title: "A's edit" },
    });

    b.store.put("workout", "w2", workout("B's edit"));
    expectSynced(await b.sync());
    expectSynced(await b.sync());
    expectSynced(await a.sync());
    expectSynced(await a.sync());
    // One of the two edits is on the server; the other is kept for its user to review.
    const onServer = (await server.row("alice", "workout", "w2"))?.content?.title;
    const reviewed = [a, b]
      .map((device) => device.store.get("workout", "w2"))
      .filter((record) => record?.status === "conflict")
      .map((record) => record?.content?.title);
    expect([onServer, ...reviewed].sort()).toEqual(["A's edit", "B's edit"]);
  });
});
