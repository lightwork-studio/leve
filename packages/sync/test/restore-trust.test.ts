import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkFileCopyThenWrite,
  checkOfflineAcrossTwoRestores,
  checkRestoredDeletedTree,
} from "./support/checks.ts";
import { entry, Peer1, set, workout } from "./support/content.ts";
import { expectSynced, FaultyTransport, type ServerHarness, World } from "./support/harness.ts";

/*
 * After a server restore nothing is decided quietly: copies equal to the restored server's are
 * confirmed, every other difference is the user's to review. Expected results are written out
 * literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

async function phoneOn(server: ServerHarness, name: string) {
  const net = new FaultyTransport(server.transport("alice"));
  const phone = await world.phone(name, { account: "alice", server: "s", transport: net.call });
  return { phone, net };
}

describe("differences after a restore", () => {
  it("brings back for review a change the server lost when the file copy is found late", () =>
    checkFileCopyThenWrite());

  it("brings back for review an edit from a history an older restore replaced", () =>
    checkOfflineAcrossTwoRestores());

  it("asks about a deletion made before the backup, untouched children included", () =>
    checkRestoredDeletedTree());
});

describe("an upload racing a restore", () => {
  it("is not accepted when the restore lands between the lineage check and the write", async () => {
    const server = world.server();
    const { phone: a } = await phoneOn(server, "a");
    a.store.put("workout", "w1", workout("v1"));
    expectSynced(await a.sync());
    const first = join(world.directory, "first.db");
    await server.snapshot("alice", first);
    a.store.put("workout", "w1", workout("v2"));
    expectSynced(await a.sync());
    const current = join(world.directory, "current.db");
    await server.snapshot("alice", current);
    // Backup B: the account as at `first`, after which someone else wrote w1 at revision 2.
    await server.restore("alice", first);
    const c = new Peer1(server.transport("alice"), "c");
    await c.pull();
    await c.push([c.put("workout", "w1", workout("C's write"))]);
    const backup = join(world.directory, "b.db");
    await server.snapshot("alice", backup);
    // Back to A's history; the server restarts, so the account isn't open yet.
    await server.restore("alice", current);

    const lineage = a.store.syncState().lineage;
    a.store.put("workout", "w1", workout("A's stale edit"));
    const [outgoing] = a.store.prepareSubmissions("1.0");
    expect(outgoing?.submission).toMatchObject({ baseRevision: 2 });
    const pushing = server.service.push("alice", {
      release: "1.0",
      lineage,
      submissions: [outgoing?.submission],
    });
    const restoring = server.restoreWithCommand("alice", backup);
    const reply = await pushing;
    await restoring;

    expect(reply).toMatchObject({ status: 409, body: { error: { code: "cursor_reset" } } });
    const hello = await new Peer1(server.transport("alice")).hello();
    expect(hello.lineage).not.toBe(lineage);
    expect(await server.row("alice", "workout", "w1")).toMatchObject({
      revision: 2,
      content: { title: "C's write" },
    });
  });
});

describe("a remembered deletion after a restore", () => {
  async function deletedAfterBackup() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    a.phone.store.put("workout", "w1", workout("one"));
    a.phone.store.put("workout", "w2", workout("two"));
    expectSynced(await a.phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    a.phone.store.delete("workout", "w2");
    expectSynced(await a.phone.sync());
    await server.restoreWithCommand("alice", backup);
    return { server, a };
  }

  it("is the user's to confirm when the restored server has the record unchanged", async () => {
    const { server, a } = await deletedAfterBackup();
    expectSynced(await a.phone.sync());
    expect((await server.row("alice", "workout", "w2"))?.state).toBe("live");
    expect(a.phone.store.problems().map((r) => [r.id, r.problem?.reason])).toEqual([
      ["w2", "restored"],
    ]);
    a.phone.store.resolve("workout", "w2", { choice: "keep_mine" });
    expectSynced(await a.phone.sync());
    expect((await server.row("alice", "workout", "w2"))?.state).toBe("deleted");
    expect(a.phone.store.problems()).toEqual([]);
    expect(a.phone.store.hasUnsyncedWork()).toBe(false);
  });

  it("goes to review when the record changed after the restore; the bulk choice keeps it", async () => {
    const { server, a } = await deletedAfterBackup();
    const other = new Peer1(server.transport("alice"), "other");
    await other.pull();
    await other.push([other.put("workout", "w2", workout("two, edited after the restore"))]);

    expectSynced(await a.phone.sync());
    expect(await server.row("alice", "workout", "w2")).toMatchObject({
      state: "live",
      revision: 3,
      content: { title: "two, edited after the restore" },
    });
    expect(a.phone.store.get("workout", "w2")).toMatchObject({
      deleted: true,
      status: "conflict",
      problem: { reason: "restored" },
      server: { state: "live", content: { title: "two, edited after the restore" } },
    });
    expect(a.phone.store.resolveRestored()).toBe(1);
    expect(a.phone.store.get("workout", "w2")).toMatchObject({
      status: "synced",
      deleted: false,
      content: { title: "two, edited after the restore" },
    });
    expect(a.phone.store.hasUnsyncedWork()).toBe(false);
  });
});

describe("a workout the restored server reports deleted", () => {
  it("is kept for saving as new when the user recorded something under it", async () => {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    const { phone: tablet } = await phoneOn(server, "tablet");
    phone.store.put("workout", "w3", workout("three"));
    phone.store.put("workout_exercise", "e3", entry("w3", "Squat"));
    phone.store.put("workout_set", "s3", set("e3"));
    expectSynced(await phone.sync());
    expectSynced(await tablet.sync());
    phone.store.delete("workout", "w3");
    expectSynced(await phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    await server.restoreWithCommand("alice", backup);
    // The tablet hadn't heard of the deletion and logged another set meanwhile.
    tablet.store.put("workout_set", "s4", set("e3", { position: 2, reps: 7 }));

    expectSynced(await tablet.sync());
    expectSynced(await tablet.sync());
    expect(tablet.store.get("workout", "w3")).toMatchObject({
      status: "conflict",
      problem: { reason: "deleted" },
      content: { title: "three" },
    });
    expect(tablet.store.get("workout_set", "s4")).toMatchObject({ content: { reps: 7 } });
    tablet.store.resolve("workout", "w3", { choice: "save_as_new", newId: "w3-new" });
    expectSynced(await tablet.sync());
    const live = (await server.rows("alice")).filter((r) => r.state === "live");
    // Everything the tablet showed under the workout is saved with it, the new set included.
    expect(live.map((r) => r.kind)).toEqual([
      "workout",
      "workout_exercise",
      "workout_set",
      "workout_set",
    ]);
    expect(live.slice(2).map((r) => r.content?.reps)).toEqual(expect.arrayContaining([5, 7]));
    expect(tablet.store.hasUnsyncedWork()).toBe(false);
  });
});
