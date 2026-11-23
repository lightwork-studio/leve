import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry, Peer1, set, workout } from "./support/content.ts";
import {
  cursorOf,
  engine,
  expectSynced,
  FaultyTransport,
  faultyEngine,
  type Phone,
  resultsOf,
  type ServerHarness,
  sentSubmissions,
  World,
  wrapTransactions,
} from "./support/harness.ts";

/*
 * Deterministic sync scenarios on real SQLite with injected transport, clock and ids. Expected
 * results are written out literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

async function phoneOn(
  server: ServerHarness,
  name: string,
  account = "alice",
  pageSize?: number,
): Promise<{ phone: Phone; net: FaultyTransport }> {
  const net = new FaultyTransport(server.transport(account));
  const phone = await world.phone(name, {
    account,
    server: "s",
    transport: net.call,
    ...(pageSize ? { pageSize } : {}),
  });
  return { phone, net };
}

const titles = (phone: Phone) =>
  phone.store.list("workout").map((record) => [record.id, record.content?.title]);

describe("offline recording across a restart", () => {
  it("keeps the running workout active after a restart and uploads it later", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("Push"));
    phone.store.put("workout_exercise", "e1", entry("w1", "Bench Press"));
    phone.store.put("workout_set", "s1", set("e1", { weightKg: 82.5, reps: 5 }));
    phone.store.put(
      "workout_set",
      "s2",
      set("e1", { position: 2, weightKg: 0, reps: 0, completedAt: "2026-11-10T18:10:00.000Z" }),
    );
    net.next("offline");
    expect(await phone.sync()).toEqual({ state: "offline", error: "offline" });

    await phone.restart();
    expect(phone.store.activeWorkout()?.id).toBe("w1");
    expect(phone.store.list("workout_set", { parentId: "e1" }).map((r) => r.id)).toEqual([
      "s1",
      "s2",
    ]);
    expect(phone.store.get("workout_set", "s2")?.content).toMatchObject({ weightKg: 0, reps: 0 });
    expect(phone.store.summary()).toMatchObject({ pending: 4, synced: 0, inFlight: 0 });
    expect(phone.store.hasUnsyncedWork()).toBe(true);
    expect(await server.rows("alice")).toEqual([]);

    expect(await phone.sync()).toEqual({ state: "synced", pushed: 4, pulled: 4 });
    const rows = await server.rows("alice");
    expect(rows.map((row) => [row.kind, row.id, row.revision])).toEqual([
      ["workout", "w1", 1],
      ["workout_exercise", "e1", 2],
      ["workout_set", "s1", 3],
      ["workout_set", "s2", 4],
    ]);
    expect(rows[3]?.content).toEqual(
      set("e1", {
        planSlot: null,
        repsInReserve: null,
        position: 2,
        weightKg: 0,
        reps: 0,
        completedAt: "2026-11-10T18:10:00.000Z",
      }),
    );
    expect(phone.store.summary()).toMatchObject({ pending: 0, synced: 4, inFlight: 0 });
    expect(phone.store.hasUnsyncedWork()).toBe(false);
    await phone.restart();
    expect(phone.store.activeWorkout()?.id).toBe("w1");
  });
});

describe("competing writers", () => {
  async function twoPhones() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("One"));
    a.phone.store.put("workout", "w2", workout("Two"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    return { server, a, b };
  }

  it("keeps both edits of separate records", async () => {
    const { server, a, b } = await twoPhones();
    a.phone.store.put("workout", "w1", workout("One by A"));
    b.phone.store.put("workout", "w2", workout("Two by B"));
    expect(await a.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(await b.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expectSynced(await a.phone.sync());
    const expected = [
      ["w1", "One by A"],
      ["w2", "Two by B"],
    ];
    expect(titles(a.phone)).toEqual(expected);
    expect(titles(b.phone)).toEqual(expected);
    expect((await server.rows("alice")).map((row) => [row.id, row.content?.title])).toEqual([
      ["w1", "One by A"],
      ["w2", "Two by B"],
    ]);
  });

  it("accepts exactly one of two edits from the same base and keeps the other as a conflict", async () => {
    const { server, a, b } = await twoPhones();
    const base = b.phone.store.get("workout", "w1")?.server?.revision;
    expect(base).toBe(1);
    a.phone.store.put("workout", "w1", workout("A wins"));
    b.phone.store.put("workout", "w1", workout("B loses"));
    expect(await a.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(await b.phone.sync()).toMatchObject({ state: "synced", pushed: 0 });

    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("A wins");
    const conflict = b.phone.store.get("workout", "w1");
    expect(conflict).toMatchObject({
      status: "conflict",
      content: { title: "B loses" },
      problem: { reason: "stale", revision: 3 },
      server: { revision: 3, state: "live", content: { title: "A wins" } },
      baseRevision: 1,
    });

    await b.phone.restart();
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "B loses" },
      problem: { reason: "stale" },
    });
    expect(b.phone.store.problems().map((record) => record.id)).toEqual(["w1"]);
    expect(b.phone.store.hasUnsyncedWork()).toBe(true);

    // It is never resubmitted on its own.
    const sentBefore = sentSubmissions(b.net.log).length;
    expectSynced(await b.phone.sync());
    expectSynced(await b.phone.sync());
    expect(sentSubmissions(b.net.log).length).toBe(sentBefore);
    expect((await server.row("alice", "workout", "w1"))?.revision).toBe(3);
  });

  it("answers a second create of the same id with an exists conflict", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "same", workout("From A"));
    b.phone.store.put("workout", "same", workout("From B"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    expect(b.phone.store.get("workout", "same")).toMatchObject({
      status: "conflict",
      content: { title: "From B" },
      problem: { reason: "exists" },
      server: { content: { title: "From A" } },
    });
    expect((await server.rows("alice")).length).toBe(1);
  });
});

describe("explicit resolution while other records sync", () => {
  it("resolves keep mine, keep theirs and save as new without blocking unrelated records", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    for (const id of ["w1", "w2", "w3"]) a.phone.store.put("workout", id, workout(`${id} v1`));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());

    a.phone.store.put("workout", "w1", workout("w1 by A"));
    a.phone.store.put("workout", "w2", workout("w2 by A"));
    a.phone.store.delete("workout", "w3");
    expectSynced(await a.phone.sync());

    b.phone.store.put("workout", "w1", workout("w1 by B"));
    b.phone.store.put("workout", "w2", workout("w2 by B"));
    b.phone.store.put("workout", "w3", workout("w3 by B"));
    b.phone.store.put("workout", "w4", workout("w4 by B"));
    expect(await b.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(
      b.phone.store.problems().map((record) => [record.id, record.problem?.reason, record.status]),
    ).toEqual([
      ["w1", "stale", "conflict"],
      ["w2", "stale", "conflict"],
      ["w3", "deleted", "conflict"],
    ]);
    expect(b.phone.store.get("workout", "w4")?.status).toBe("synced");

    // Unrelated records keep syncing both ways while the conflicts wait.
    a.phone.store.put("workout", "w5", workout("w5 by A"));
    expectSynced(await a.phone.sync());
    const sentBefore = sentSubmissions(b.net.log).length;
    b.phone.store.put("workout", "w6", workout("w6 by B"));
    expect(await b.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(
      sentSubmissions(b.net.log)
        .slice(sentBefore)
        .map((s) => s.id),
    ).toEqual(["w6"]);
    expect(b.phone.store.get("workout", "w5")).toMatchObject({
      status: "synced",
      content: { title: "w5 by A" },
    });
    expect(b.phone.store.problems().length).toBe(3);

    expect(() => b.phone.store.resolve("workout", "w3", { choice: "keep_mine" })).toThrow();

    b.phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      baseRevision: 4,
    });
    b.phone.store.resolve("workout", "w2", { choice: "keep_theirs" });
    expect(b.phone.store.get("workout", "w2")).toMatchObject({
      status: "synced",
      content: { title: "w2 by A" },
    });
    b.phone.store.resolve("workout", "w3", { choice: "save_as_new", newId: "w3-copy" });
    expect(b.phone.store.get("workout", "w3")?.deleted).toBe(true);

    const beforeResolved = sentSubmissions(b.net.log).length;
    expect(await b.phone.sync()).toMatchObject({ state: "synced", pushed: 2 });
    expect(
      sentSubmissions(b.net.log)
        .slice(beforeResolved)
        .map((s) => [s.id, s.baseRevision]),
    ).toEqual([
      ["w1", 4],
      ["w3-copy", null],
    ]);
    expect(b.phone.store.problems()).toEqual([]);

    expectSynced(await a.phone.sync());
    const expected = [
      ["w1", "w1 by B"],
      ["w2", "w2 by A"],
      ["w3-copy", "w3 by B"],
      ["w4", "w4 by B"],
      ["w5", "w5 by A"],
      ["w6", "w6 by B"],
    ];
    expect(titles(a.phone)).toEqual(expected);
    expect(titles(b.phone)).toEqual(expected);
    expect((await server.row("alice", "workout", "w3"))?.state).toBe("deleted");
  });

  it("rejects keep mine again when the record changed once more", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("v1"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    a.phone.store.put("workout", "w1", workout("A1"));
    expectSynced(await a.phone.sync());
    b.phone.store.put("workout", "w1", workout("B1"));
    expectSynced(await b.phone.sync());
    b.phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    a.phone.store.put("workout", "w1", workout("A2"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "B1" },
      problem: { reason: "stale" },
      server: { content: { title: "A2" } },
    });
  });
});

describe("lost, duplicated and reordered requests", () => {
  async function synced(name = "phone") {
    const server = world.server();
    const { phone, net } = await phoneOn(server, name);
    phone.store.put("workout", "w1", workout("v1"));
    expectSynced(await phone.sync());
    return { server, phone, net };
  }

  it("applies a submission once when its accepted reply is lost and both ends restart", async () => {
    const { server, phone, net } = await synced();
    phone.store.put("workout", "w1", workout("v2"));
    net.next("lose_reply", "/sync/push");
    expect(await phone.sync()).toEqual({ state: "offline", error: "reply lost" });
    expect(await server.head("alice")).toBe(2);
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "pending", inFlight: true });

    await phone.restart();
    await server.restart();
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "pending", inFlight: true });
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });

    const [lost, retried] = sentSubmissions(net.log).slice(-2);
    expect(retried).toEqual(lost);
    expect(await server.head("alice")).toBe(2);
    expect(net.log.at(-2)?.response?.body).toEqual({
      release: "1.0",
      results: [{ status: "accepted", submissionId: lost?.submissionId, revision: 2 }],
    });
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      server: { revision: 2, content: { title: "v2" } },
    });
  });

  it("answers a duplicated request the same way without writing twice", async () => {
    const { server, phone, net } = await synced();
    phone.store.put("workout", "w1", workout("v2"));
    phone.store.put("workout", "w2", workout("other"));
    net.next("duplicate", "/sync/push");
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 2 });
    expect(await server.head("alice")).toBe(3);
    expect((await server.receipts("alice")).length).toBe(3);
  });

  it("gives an old request that arrives late its original answer and changes nothing", async () => {
    const { server, phone, net } = await synced();
    phone.store.put("workout", "w1", workout("v2"));
    net.next("hold_copy", "/sync/push");
    expectSynced(await phone.sync());
    phone.store.put("workout", "w1", workout("v3"));
    expectSynced(await phone.sync());
    expect(await server.head("alice")).toBe(3);

    const [late] = await net.deliverHeld();
    const first = sentSubmissions(net.log).find(
      (s) => s.content && (s.content as { title: string }).title === "v2",
    );
    expect(late?.body).toEqual({
      release: "1.0",
      results: [{ status: "accepted", submissionId: first?.submissionId, revision: 2 }],
    });
    expect(await server.head("alice")).toBe(3);
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("v3");
    expectSynced(await phone.sync());
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      content: { title: "v3" },
    });
  });

  it("commits a write only together with its receipt", async () => {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    await server.restart({
      wrapStorage: (storage) =>
        wrapTransactions(storage, () => ({
          saveReceipt: () => {
            throw new Error("disk full while saving the receipt");
          },
        })),
    });
    phone.store.put("workout", "w1", workout("v1"));
    await expect(phone.sync()).rejects.toThrow(/disk full/);
    expect(await server.rows("alice")).toEqual([]);
    expect(await server.head("alice")).toBe(0);
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "pending", inFlight: true });

    await server.restart({});
    await phone.restart();
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect((await server.rows("alice")).map((row) => [row.id, row.revision])).toEqual([["w1", 1]]);
    expect((await server.receipts("alice")).map((r) => r.revision)).toEqual([1]);
  });

  it("answers a reused submission id with different content as invalid", async () => {
    const server = world.server();
    const peer = new Peer1(server.transport("alice"));
    await peer.hello();
    const first = peer.put("workout", "w1", workout("v1"), "fixed-id");
    expect(await peer.push([first])).toMatchObject({
      results: [{ status: "accepted", revision: 1 }],
    });
    const reused = { ...first, content: workout("different") };
    expect(await peer.push([reused])).toEqual({
      release: "1.0",
      results: [
        {
          status: "invalid",
          submissionId: "fixed-id",
          code: "submission_reused",
          message: expect.any(String),
        },
      ],
    });
    expect(await peer.push([{ ...first, id: "w2" }])).toMatchObject({
      results: [{ status: "invalid", code: "submission_reused" }],
    });
    expect(await peer.push([first])).toMatchObject({
      results: [{ status: "accepted", revision: 1 }],
    });
    expect((await server.rows("alice")).map((row) => [row.id, row.content?.title])).toEqual([
      ["w1", "v1"],
    ]);
  });

  it("recognises a repeat within 90 days even after the record changed", async () => {
    const { server, phone, net } = await synced();
    const peer = new Peer1(server.transport("alice"));
    phone.store.put("workout", "w1", workout("v2"));
    net.next("lose_reply", "/sync/push");
    await phone.sync();
    await peer.pull();
    await peer.push([peer.put("workout", "w1", workout("by peer"))]);
    world.clock.advanceDays(89);
    await phone.restart();
    await server.restart();
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(net.log.find((e) => e.path === "/sync/push" && e !== net.log.at(0))).toBeDefined();
    const retry = net.log.filter((e) => e.path === "/sync/push").at(-1);
    expect(resultsOf(retry)).toEqual([
      { status: "accepted", submissionId: expect.any(String), revision: 2 },
    ]);
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      content: { title: "by peer" },
      server: { revision: 3 },
    });
  });

  it("after the receipts expire, accepts a repeat equal to the current copy", async () => {
    const { server, phone, net } = await synced();
    phone.store.put("workout", "w1", workout("v2"));
    net.next("lose_reply", "/sync/push");
    await phone.sync();
    world.clock.advanceDays(91);
    await phone.restart();
    await server.restart();
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    const retry = net.log.filter((e) => e.path === "/sync/push").at(-1);
    expect(resultsOf(retry)).toEqual([
      { status: "accepted", submissionId: expect.any(String), revision: 2 },
    ]);
    expect(await server.head("alice")).toBe(2);
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "synced" });
  });

  it("after the receipts expire, applies the normal revision check to a changed record", async () => {
    const { server, phone, net } = await synced();
    const peer = new Peer1(server.transport("alice"));
    phone.store.put("workout", "w1", workout("v2"));
    net.next("lose_reply", "/sync/push");
    await phone.sync();
    await peer.pull();
    await peer.push([peer.put("workout", "w1", workout("by peer"))]);
    world.clock.advanceDays(91);
    await server.restart();
    expectSynced(await phone.sync());
    const retry = net.log.filter((e) => e.path === "/sync/push").at(-1);
    expect(resultsOf(retry)).toMatchObject([
      { status: "conflict", reason: "stale", current: { revision: 3 } },
    ]);
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "v2" },
    });
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("by peer");
  });
});

describe("edits while a submission is in flight", () => {
  it("keeps the newer edit, rebases it on the accepted revision and never skips unseen changes", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone");
    const peer = new Peer1(server.transport("alice"));
    phone.store.put("workout", "w1", workout("v1"));
    expectSynced(await phone.sync());
    expect(phone.store.syncState().cursor).toBe(1);

    // Another writer adds a record the phone hasn't downloaded (revision 2).
    await peer.hello();
    await peer.push([peer.put("workout", "w9", workout("by peer"))]);

    phone.store.put("workout", "w1", workout("v2"));
    let dispatched: unknown;
    net.beforeReply = (path) => {
      if (path !== "/sync/push" || dispatched) return;
      dispatched = phone.store.get("workout", "w1");
      phone.store.put("workout", "w1", workout("v3"));
    };
    net.next("lose_reply", "/sync/push");
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    expect(dispatched).toMatchObject({ inFlight: true, content: { title: "v2" } });

    // The in-flight submission is resent unchanged and accepted; the next upload fails to send.
    net.beforeReply = null;
    net.next("pass", "/sync/push").next("offline", "/sync/push");
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    const pushes = sentSubmissions(net.log);
    expect(pushes.length).toBe(4);
    expect(pushes[2]).toEqual(pushes[1]);
    expect(pushes[1]).toMatchObject({ baseRevision: 1, content: { title: "v2" } });
    expect(pushes[3]).toMatchObject({ baseRevision: 3, content: { title: "v3" } });
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      inFlight: true,
      content: { title: "v3" },
      baseRevision: 3,
      server: { revision: 3, content: { title: "v2" } },
    });
    // Upload answers never move the cursor: revision 2 has not been downloaded yet.
    expect(phone.store.syncState().cursor).toBe(1);

    await phone.restart();
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(sentSubmissions(net.log).at(-1)).toEqual(pushes[3]);
    expect(titles(phone)).toEqual([
      ["w1", "v3"],
      ["w9", "by peer"],
    ]);
    expect(phone.store.syncState().cursor).toBe(4);
    expect(phone.store.get("workout", "w1")).toMatchObject({ status: "synced" });
  });
});

describe("deletion against a stale writer", () => {
  async function workoutTree(server: ServerHarness) {
    const a = await phoneOn(server, "a");
    a.phone.store.put("workout", "w1", workout("Legs"));
    a.phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    a.phone.store.put("workout_set", "s1", set("e1"));
    a.phone.store.put("workout_set", "s2", set("e1", { position: 2 }));
    expectSynced(await a.phone.sync());
    return a;
  }

  it("deletes children with the workout, keeps markers without content and never resurrects", async () => {
    const server = world.server();
    const a = await workoutTree(server);
    const b = await phoneOn(server, "b");
    expectSynced(await b.phone.sync());
    const peer = new Peer1(server.transport("alice"));
    await peer.hello();
    await peer.pull();

    a.phone.store.delete("workout", "w1");
    expect(a.phone.store.list("workout")).toEqual([]);
    expectSynced(await a.phone.sync());
    const rows = await server.rows("alice");
    expect(rows.map((row) => [row.kind, row.id, row.state, row.content, row.parentId])).toEqual([
      ["workout_set", "s1", "deleted", null, null],
      ["workout_set", "s2", "deleted", null, null],
      ["workout_exercise", "e1", "deleted", null, null],
      ["workout", "w1", "deleted", null, null],
    ]);
    const raw = (await server.storage.account("alice")).db.all(
      "SELECT content, parent_kind, parent_id FROM records",
    );
    expect(raw.every((row) => row.content === null && row.parent_id === null)).toBe(true);

    // The stale phone edits a set and the workout; both are rejected and kept locally.
    b.phone.store.put("workout_set", "s1", set("e1", { reps: 12 }));
    b.phone.store.put("workout", "w1", workout("Legs edited"));
    expectSynced(await b.phone.sync());
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "Legs edited" },
      problem: { reason: "deleted" },
    });
    expect(b.phone.store.get("workout_set", "s1")).toMatchObject({
      status: "conflict",
      content: { reps: 12 },
    });
    // Shown only as the kept, rejected version, never as a synced record.
    expect(b.phone.store.list("workout").map((r) => [r.id, r.status])).toEqual([
      ["w1", "conflict"],
    ]);

    // The stale historical writer cannot bring it back, as an update or as a create.
    const update = peer.put("workout", "w1", workout("peer revival"));
    const create = { ...peer.put("workout", "w1", workout("peer create")), baseRevision: null };
    const setUpdate = peer.put("workout_set", "s2", set("e1", { reps: 1 }));
    expect(await peer.push([update, create, setUpdate])).toMatchObject({
      results: [
        { status: "conflict", reason: "deleted", current: { state: "deleted", id: "w1" } },
        { status: "conflict", reason: "deleted", current: { state: "deleted", id: "w1" } },
        { status: "conflict", reason: "deleted", current: { state: "deleted", id: "s2" } },
      ],
    });
    // Deleting an already deleted record is accepted.
    expect(await peer.push([peer.delete("workout", "w1")])).toMatchObject({
      results: [{ status: "accepted", revision: 8 }],
    });

    b.phone.store.resolve("workout", "w1", { choice: "save_as_new", newId: "w1-copy" });
    expectSynced(await b.phone.sync());
    expect((await server.row("alice", "workout", "w1"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout", "w1-copy"))?.content?.title).toBe("Legs edited");
    // The copy takes along what B still showed under it: the entry and its edited set.
    const copies = (await server.rows("alice")).filter((row) => row.revision > 8);
    expect(copies.map((row) => [row.kind, row.parentId])).toEqual([
      ["workout", null],
      ["workout_exercise", "w1-copy"],
      ["workout_set", copies[1]?.id],
    ]);
    expect(copies[2]?.content).toMatchObject({ reps: 12 });
    expect(await server.head("alice")).toBe(11);

    expectSynced(await a.phone.sync());
    expect(titles(a.phone)).toEqual([["w1-copy", "Legs edited"]]);
    expect(a.phone.store.get("workout", "w1")?.deleted).toBe(true);
    expect(() => a.phone.store.put("workout", "w1", workout("again"))).toThrow(/deleted/);
  });

  it("answers a child of a deleted parent with parent_deleted", async () => {
    const server = world.server();
    const a = await workoutTree(server);
    const b = await phoneOn(server, "b");
    expectSynced(await b.phone.sync());
    a.phone.store.delete("workout", "w1");
    expectSynced(await a.phone.sync());

    b.phone.store.put("workout_exercise", "e2", entry("w1", "Lunge"));
    expectSynced(await b.phone.sync());
    expect(b.phone.store.get("workout_exercise", "e2")).toMatchObject({
      status: "conflict",
      content: { exerciseName: "Lunge" },
    });
    expect(await server.row("alice", "workout_exercise", "e2")).toBeUndefined();

    const peer = new Peer1(server.transport("alice"));
    expect(await peer.push([peer.put("workout_exercise", "e3", entry("w1", "Peer"))])).toEqual({
      release: "1.0",
      results: [
        { status: "conflict", submissionId: "peer-1", reason: "parent_deleted", current: null },
      ],
    });
  });

  it("answers a child whose parent isn't on the server yet with retry_later, then accepts it", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone");
    phone.store.put("workout_exercise", "e8", entry("w8", "Row"));
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 0 });
    expect(resultsOf(net.log.find((e) => e.path === "/sync/push"))).toEqual([
      { status: "retry_later", submissionId: "phone-1", reason: "parent_missing" },
    ]);
    expect(phone.store.get("workout_exercise", "e8")).toMatchObject({
      status: "pending",
      inFlight: false,
    });

    const peer = new Peer1(server.transport("alice"));
    const orphan = peer.put("workout_set", "s8", set("e8"));
    expect(await peer.push([orphan])).toMatchObject({
      results: [{ status: "retry_later", reason: "parent_missing" }],
    });
    await peer.push([peer.put("workout", "w8", workout("Pull"))]);
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(await peer.push([orphan])).toMatchObject({
      results: [{ status: "accepted", revision: 3 }],
    });
    expect((await server.rows("alice")).map((row) => [row.id, row.parentId])).toEqual([
      ["w8", null],
      ["e8", "w8"],
      ["s8", "e8"],
    ]);
  });
});

describe("multi-page catch-up", () => {
  async function serverWithTen() {
    const server = world.server();
    const peer = new Peer1(server.transport("alice"));
    await peer.hello();
    const ids = Array.from({ length: 10 }, (_, i) => `w${String(i + 1).padStart(2, "0")}`);
    for (const id of ids) await peer.push([peer.put("workout", id, workout(`title ${id}`))]);
    return { server, ids };
  }

  it("resumes after a crash before the cursor of a page is saved", async () => {
    const { server, ids } = await serverWithTen();
    let cursorWrites = 0;
    const crashing = faultyEngine(engine, (sql) => {
      if (!sql.startsWith("UPDATE sync_state SET cursor")) return false;
      cursorWrites += 1;
      return cursorWrites === 3;
    });
    const net = new FaultyTransport(server.transport("alice"));
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: net.call,
      pageSize: 3,
      sqlEngine: crashing,
    });
    await expect(phone.sync()).rejects.toThrow(/injected crash/);
    await phone.restart({ sqlEngine: engine });
    // The third page was rolled back together with its cursor.
    expect(phone.store.syncState().cursor).toBe(6);
    expect(phone.store.list("workout").map((r) => r.id)).toEqual(ids.slice(0, 6));

    expect(await phone.sync()).toEqual({ state: "synced", pushed: 0, pulled: 4 });
    expect(phone.store.list("workout").map((r) => r.id)).toEqual(ids);
    expect(phone.store.syncState().cursor).toBe(10);
    const cursors = net.log
      .filter((e) => e.path === "/sync/pull")
      .map((e) => (e.request as { cursor: number }).cursor);
    expect(cursors).toEqual([0, 3, 6, 6, 9]);
  });

  it("resumes after a lost page reply and a restart", async () => {
    const { server, ids } = await serverWithTen();
    const { phone, net } = await phoneOn(server, "phone", "alice", 4);
    net.next("pass", "/sync/pull").next("lose_reply", "/sync/pull");
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    await phone.restart();
    expect(phone.store.syncState().cursor).toBe(4);
    expectSynced(await phone.sync());
    expect(phone.store.list("workout").map((r) => r.id)).toEqual(ids);
  });

  async function restoredAccount() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    for (const id of ["w1", "w2", "w5"]) a.phone.store.put("workout", id, workout(`${id} v1`));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    const snapshot = join(world.directory, "alice-backup.db");
    await server.snapshot("alice", snapshot);

    a.phone.store.put("workout", "w3", workout("w3 v1"));
    expectSynced(await a.phone.sync());
    b.phone.store.put("workout", "w5", workout("w5 by B"));
    expectSynced(await b.phone.sync());
    a.phone.store.put("workout", "w5", workout("w5 by A"));
    expectSynced(await a.phone.sync());
    expect(a.phone.store.get("workout", "w5")?.status).toBe("conflict");
    expect(a.phone.store.syncState().cursor).toBe(5);

    // Work recorded around the restore.
    a.phone.store.put("workout", "w4", workout("w4 local only"));
    a.phone.store.put("workout", "w3", workout("w3 pending edit"));
    return { server, a, snapshot };
  }

  async function expectWorkKept(server: ServerHarness, a: { phone: Phone }) {
    expect(a.phone.store.syncState()).toMatchObject({ restoring: false });
    // Rejected work is still held with its contents.
    expect(a.phone.store.get("workout", "w5")).toMatchObject({
      status: "conflict",
      content: { title: "w5 by A" },
    });
    // Pending, local-only and lost synced work reached the restored server.
    const serverTitles = Object.fromEntries(
      (await server.rows("alice")).map((row) => [row.id, row.content?.title]),
    );
    expect(serverTitles).toEqual({
      w1: "w1 v1",
      w2: "w2 v1",
      w3: "w3 pending edit",
      w4: "w4 local only",
      w5: "w5 v1",
    });
    for (const id of ["w1", "w2", "w3", "w4"]) {
      expect(a.phone.store.get("workout", id)?.status, id).toBe("synced");
    }
    expectSynced(await a.phone.sync());
    expect(a.phone.store.syncState().cursor).toBe(await server.head("alice"));
    expect(a.phone.store.get("workout", "w5")?.status).toBe("conflict");
  }

  it("re-downloads after a restore found on connect and keeps pending, rejected and local-only work", async () => {
    const { server, a, snapshot } = await restoredAccount();
    await server.restore("alice", snapshot);
    expect(await server.head("alice")).toBe(3);
    expectSynced(await a.phone.sync());
    expect(cursorOf(a.net.log.filter((e) => e.path === "/sync/pull").at(-1))).toBe(0);
    await expectWorkKept(server, a);
  });

  it("re-downloads after a cursor_reset answer and keeps pending, rejected and local-only work", async () => {
    const { server, a, snapshot } = await restoredAccount();
    // The restore happens after this sync's uploads were accepted, before its download.
    a.net.beforeReply = async (path) => {
      if (path !== "/sync/push") return;
      a.net.beforeReply = null;
      await server.restore("alice", snapshot);
    };
    expectSynced(await a.phone.sync());
    const pulls = a.net.log.filter((e) => e.path === "/sync/pull");
    expect(pulls.at(-2)?.response).toMatchObject({
      status: 409,
      body: { error: { code: "cursor_reset" } },
    });
    expect(cursorOf(pulls.at(-1))).toBe(0);
    await expectWorkKept(server, a);
  });

  it("detects a restore by its new lineage even after the counter passed the cursor", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    a.phone.store.put("workout", "w1", workout("w1 v1"));
    expectSynced(await a.phone.sync());
    const snapshot = join(world.directory, "alice-backup.db");
    await server.snapshot("alice", snapshot);
    a.phone.store.put("workout", "w2", workout("w2 after backup"));
    a.phone.store.put("workout", "w3", workout("w3 after backup"));
    expectSynced(await a.phone.sync());
    expect(a.phone.store.syncState().cursor).toBe(3);

    await server.restoreWithCommand("alice", snapshot);
    // Another device writes to the restored account before this phone reconnects.
    const b = await phoneOn(server, "b");
    for (const id of ["x1", "x2", "x3"]) b.phone.store.put("workout", id, workout(id));
    expectSynced(await b.phone.sync());
    expect(await server.head("alice")).toBe(4);

    expectSynced(await a.phone.sync());
    const titles = Object.fromEntries(
      (await server.rows("alice")).map((row) => [row.id, row.content?.title]),
    );
    expect(titles).toEqual({
      w1: "w1 v1",
      w2: "w2 after backup",
      w3: "w3 after backup",
      x1: "x1",
      x2: "x2",
      x3: "x3",
    });
    expect(a.phone.store.list("workout").map((record) => record.id)).toEqual(
      Object.keys(titles).sort(),
    );
    expect(a.phone.store.hasUnsyncedWork()).toBe(false);
  });

  async function deletedAfterBackup() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    a.phone.store.put("workout", "w1", workout("w1 v1"));
    a.phone.store.put("workout", "w2", workout("w2 v1"));
    expectSynced(await a.phone.sync());
    const snapshot = join(world.directory, "alice-backup.db");
    await server.snapshot("alice", snapshot);
    a.phone.store.delete("workout", "w2");
    expectSynced(await a.phone.sync());
    return { server, a, snapshot };
  }

  for (const how of ["the restore command", "copying the files back"] as const) {
    it(`asks before deleting again a record brought back by ${how}`, async () => {
      const { server, a, snapshot } = await deletedAfterBackup();
      if (how === "the restore command") await server.restoreWithCommand("alice", snapshot);
      else await server.restore("alice", snapshot);

      expectSynced(await a.phone.sync());
      expect((await server.row("alice", "workout", "w2"))?.state).toBe("live");
      expect(a.phone.store.get("workout", "w2")).toMatchObject({
        deleted: true,
        status: "conflict",
        fromRestore: true,
        problem: { reason: "restored" },
        server: { state: "live", content: { title: "w2 v1" } },
      });
      expect(a.phone.store.problems().map((record) => record.id)).toEqual(["w2"]);
      // Insisting deletes it again; other devices then see it gone.
      a.phone.store.resolve("workout", "w2", { choice: "keep_mine" });
      expectSynced(await a.phone.sync());
      expect((await server.row("alice", "workout", "w2"))?.state).toBe("deleted");
      expect(a.phone.store.hasUnsyncedWork()).toBe(false);
      const fresh = await phoneOn(server, "fresh");
      expectSynced(await fresh.phone.sync());
      expect(fresh.phone.store.list("workout").map((record) => record.id)).toEqual(["w1"]);
    });
  }
});

describe("account isolation", () => {
  it("never mixes records, cursors, receipts, conflicts or errors between accounts", async () => {
    const server = world.server();
    const alice = await phoneOn(server, "alice-phone", "alice");
    const alice2 = await phoneOn(server, "alice-tablet", "alice");
    const bobNet = new FaultyTransport(server.transport("bob"));
    const bob = await world.phone("bob-phone", {
      account: "bob",
      server: "s",
      transport: bobNet.call,
      idPrefix: "alice-phone",
    });

    alice.phone.store.put("workout", "w1", workout("Alice"));
    alice.phone.store.put("workout", "w2", workout("Alice 2"));
    bob.store.put("workout", "w1", workout("Bob"));
    expect(await alice.phone.sync()).toMatchObject({ state: "synced", pushed: 2 });
    expect(await bob.sync()).toMatchObject({ state: "synced", pushed: 1, pulled: 1 });
    const bobFirst = sentSubmissions(bobNet.log)[0];
    expect(bobFirst?.submissionId).toBe("alice-phone-1");
    expect(sentSubmissions(alice.net.log)[0]?.submissionId).toBe("alice-phone-1");

    // An id alice already used is fresh for bob.
    const bobPeer = new Peer1(server.transport("bob"), "alice-phone");
    await bobPeer.hello();
    await bobPeer.pull();
    expect(
      await bobPeer.push([bobPeer.put("workout", "w9", workout("Bob 9"), "alice-phone-2")]),
    ).toMatchObject({ results: [{ status: "accepted", revision: 2 }] });

    // A conflict in alice's account.
    expectSynced(await alice2.phone.sync());
    alice.phone.store.put("workout", "w1", workout("Alice edit"));
    alice2.phone.store.put("workout", "w1", workout("Alice tablet edit"));
    expectSynced(await alice.phone.sync());
    expectSynced(await alice2.phone.sync());
    expect(alice2.phone.store.get("workout", "w1")?.status).toBe("conflict");

    expectSynced(await bob.sync());
    expect(titles(bob)).toEqual([
      ["w1", "Bob"],
      ["w9", "Bob 9"],
    ]);
    expect(bob.store.problems()).toEqual([]);
    expect(titles(alice.phone)).toEqual([
      ["w1", "Alice edit"],
      ["w2", "Alice 2"],
    ]);
    expect(alice.phone.store.syncState()).toMatchObject({ account: "alice", cursor: 3 });
    expect(bob.store.syncState()).toMatchObject({ account: "bob", cursor: 2 });
    expect((await server.receipts("bob")).map((r) => r.submissionId)).toEqual([
      "alice-phone-1",
      "alice-phone-2",
    ]);
    expect((await server.receipts("alice")).map((r) => r.submissionId)).toEqual([
      "alice-phone-1",
      "alice-phone-2",
      "alice-phone-3",
    ]);

    // A device bound to one account never reuses its sync state for another.
    await bob.restart({ account: "alice", transport: server.transport("alice") });
    await expect(bob.sync()).rejects.toThrow(/another account/);
    expect(bob.store.syncState()).toMatchObject({ account: "bob", cursor: 2 });
    await bob.restart({ account: "bob", transport: bobNet.call });

    // A broken account database affects only that account.
    writeFileSync(server.dbPath("carol"), "this is not a database");
    const carol = await world.phone("carol-phone", {
      account: "carol",
      server: "s",
      transport: server.transport("carol"),
    });
    carol.store.put("workout", "w1", workout("Carol"));
    await expect(carol.sync()).rejects.toThrow();
    expect(carol.store.get("workout", "w1")?.status).toBe("pending");
    alice.phone.store.put("workout", "w2", workout("Alice 2 edit"));
    expect(await alice.phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expectSynced(await bob.sync());
    expect(titles(bob)).toEqual([
      ["w1", "Bob"],
      ["w9", "Bob 9"],
    ]);
  });
});

describe("acknowledgements and the local copy", () => {
  it("keeps an edit made while a deletion was in flight instead of erasing it", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("v1"));
    expectSynced(await phone.sync());
    phone.store.delete("workout", "w1");
    net.next("lose_reply", "/sync/push");
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    expect((await server.row("alice", "workout", "w1"))?.state).toBe("deleted");

    // The user takes the deletion back before its answer arrives.
    phone.store.put("workout", "w1", workout("kept after all"));
    expectSynced(await phone.sync());
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "kept after all" },
      problem: { reason: "deleted" },
      server: { revision: 2, state: "deleted" },
    });
    phone.store.resolve("workout", "w1", { choice: "save_as_new", newId: "w1-new" });
    expectSynced(await phone.sync());
    expect((await server.row("alice", "workout", "w1-new"))?.content?.title).toBe("kept after all");
    expect((await server.row("alice", "workout", "w1"))?.state).toBe("deleted");
  });

  it("files a record under the server copy's parent after keep theirs", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("One"));
    a.phone.store.put("workout", "w2", workout("Two"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    a.phone.store.put("workout_exercise", "e1", entry("w2", "Mine under two"));
    b.phone.store.put("workout_exercise", "e1", entry("w1", "Theirs under one"));
    expectSynced(await b.phone.sync());
    expectSynced(await a.phone.sync());
    expect(a.phone.store.get("workout_exercise", "e1")?.problem?.reason).toBe("exists");

    a.phone.store.resolve("workout_exercise", "e1", { choice: "keep_theirs" });
    const under = (id: string) =>
      a.phone.store.list("workout_exercise", { parentId: id }).map((r) => r.content?.exerciseName);
    expect(under("w1")).toEqual(["Theirs under one"]);
    expect(under("w2")).toEqual([]);
    a.phone.store.delete("workout", "w2");
    expectSynced(await a.phone.sync());
    expect(a.phone.store.list("workout_exercise").map((r) => r.id)).toEqual(["e1"]);
  });

  it("files a record under the server copy's parent when a newer copy arrived during the upload", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    a.phone.store.put("workout", "w1", workout("One"));
    a.phone.store.put("workout", "w2", workout("Two"));
    expectSynced(await a.phone.sync());
    a.phone.store.put("workout_exercise", "e1", entry("w1", "Row"));
    a.net.next("lose_reply", "/sync/push");
    expect(await a.phone.sync()).toMatchObject({ state: "offline" });

    // Another writer moves the entry to the other workout.
    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    await peer.push([peer.put("workout_exercise", "e1", entry("w2", "Row moved"))]);
    expectSynced(await a.phone.client.waitForChanges(0));
    expectSynced(await a.phone.sync());
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      status: "synced",
      content: { workoutId: "w2", exerciseName: "Row moved" },
    });
    expect(a.phone.store.list("workout_exercise", { parentId: "w2" }).map((r) => r.id)).toEqual([
      "e1",
    ]);
    expect(a.phone.store.list("workout_exercise", { parentId: "w1" })).toEqual([]);
  });
});
