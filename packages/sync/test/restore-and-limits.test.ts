import { join } from "node:path";
import { jsonBytes } from "@leve/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPushLineageGuard } from "./support/checks.ts";
import { entry, Peer1, set, workout } from "./support/content.ts";
import {
  expectSynced,
  FaultyTransport,
  type Phone,
  resultsOf,
  type ServerHarness,
  sentSubmissions,
  World,
} from "./support/harness.ts";

/*
 * Deletions waiting for their descendants' uploads, the lineage guard on uploads, server restores,
 * size limits and the write service's own validation. Expected results are written out literally.
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

const titles = (phone: Phone) =>
  phone.store.list("workout").map((record) => [record.id, record.content?.title]);

describe("a parent deletion and its descendants' uploads", () => {
  it("waits until a descendant's upload in flight is answered", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "a");
    phone.store.put("workout", "w1", workout("Legs"));
    phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    phone.store.put("workout_set", "s1", set("e1"));
    expectSynced(await phone.sync());

    phone.store.delete("workout_set", "s1");
    net.next("offline", "/sync/push");
    expect(await phone.sync()).toMatchObject({ state: "offline" });
    expect(phone.store.get("workout_set", "s1")?.inFlight).toBe(true);
    phone.store.delete("workout", "w1");
    expectSynced(await phone.sync());

    // The set's deletion went first; the workout's then listed only what was still live.
    const pushes = net.log.filter((e) => e.path === "/sync/push" && e.response);
    expect(
      pushes.map((e) =>
        (e.request as { submissions: { id: string; descendants?: unknown }[] }).submissions.map(
          (s) => [s.id, s.descendants],
        ),
      ),
    ).toEqual([
      [
        ["w1", undefined],
        ["e1", undefined],
        ["s1", undefined],
      ],
      [["s1", []]],
      [["w1", [{ kind: "workout_exercise", id: "e1", revision: 2 }]]],
    ]);
    expect(pushes.flatMap((e) => resultsOf(e))).toMatchObject([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted", revision: 4 },
      { status: "accepted", revision: 6 },
    ]);
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["s1", "deleted"],
      ["e1", "deleted"],
      ["w1", "deleted"],
    ]);
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.summary()).toMatchObject({ pending: 0, conflict: 0, inFlight: 0 });
  });
});

describe("the lineage guard on uploads", () => {
  it("refuses an upload from the old history before writing anything", () =>
    checkPushLineageGuard());
});

describe("after a server restore", () => {
  /**
   * Revisions: 1 w1 v1, 2 w3 created (the tablet synced here), 3 w1 v2, 4 w3 deleted (backup taken
   * here), 5 w1 v3 by the phone. The restore goes back to revision 4.
   */
  async function history() {
    const server = world.server();
    const phone = await phoneOn(server, "phone");
    const tablet = await phoneOn(server, "tablet");
    phone.phone.store.put("workout", "w1", workout("v1"));
    phone.phone.store.put("workout", "w3", workout("three"));
    expectSynced(await phone.phone.sync());
    expectSynced(await tablet.phone.sync());
    phone.phone.store.put("workout", "w1", workout("v2"));
    phone.phone.store.delete("workout", "w3");
    expectSynced(await phone.phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    phone.phone.store.put("workout", "w1", workout("v3"));
    expectSynced(await phone.phone.sync());
    expect(phone.phone.store.get("workout", "w1")?.server?.revision).toBe(5);
    expect(tablet.phone.store.get("workout", "w1")?.server?.revision).toBe(1);
    return { server, phone, tablet, backup };
  }

  function expectLostEditForReview(phone: Phone) {
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "v3" },
      server: { content: { title: "v2" } },
    });
    expect(phone.store.problems().map((r) => r.id)).toEqual(["w1"]);
  }

  it("asks about every difference after the restore command; the bulk choice takes the server's", async () => {
    const { server, phone, tablet, backup } = await history();
    const lineage = tablet.phone.store.syncState().lineage;
    await server.restoreWithCommand("alice", backup);
    const hello = await new Peer1(server.transport("alice")).hello();
    // Where the backup came from is reported, but nothing on the device relies on it.
    expect(hello).toMatchObject({ revision: 4, restoredFrom: { lineage, restorePoint: 4 } });

    expectSynced(await tablet.phone.sync());
    expectSynced(await tablet.phone.sync());
    expect(
      tablet.phone.store
        .problems()
        .map((r) => [r.id, r.problem?.reason, r.content?.title, r.fromRestore]),
    ).toEqual([
      ["w1", "exists", "v1", true],
      ["w3", "deleted", "three", true],
    ]);
    expect(tablet.phone.store.resolveRestored()).toBe(2);
    expect(tablet.phone.store.problems()).toEqual([]);
    expect(titles(tablet.phone)).toEqual([["w1", "v2"]]);
    expect(tablet.phone.store.get("workout", "w3")?.content ?? null).toBeNull();
    expect(tablet.phone.store.hasUnsyncedWork()).toBe(false);

    // The phone's edit the server lost is held for review too.
    expectSynced(await phone.phone.sync());
    expectLostEditForReview(phone.phone);
    expect(phone.phone.store.get("workout", "w1")?.fromRestore).toBe(true);
    phone.phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    expectSynced(await phone.phone.sync());
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("v3");
    expectSynced(await tablet.phone.sync());
    expect(titles(tablet.phone)).toEqual([["w1", "v3"]]);
  });

  it("sends every difference to review after a file-copy restore, where the split is unknown", async () => {
    const { server, phone, tablet, backup } = await history();
    await server.restore("alice", backup);
    const before = await new Peer1(server.transport("alice")).hello();
    expect(before).toMatchObject({ revision: 4, restoredFrom: null });

    // The phone's cursor (5) is ahead of the counter (4): the server rotates without a restore
    // point, because nobody knows which revisions the copied file shares with the devices.
    expectSynced(await phone.phone.sync());
    const after = await new Peer1(server.transport("alice")).hello();
    expect(after).toMatchObject({ revision: 4, restoredFrom: null });
    expect(after.lineage).not.toBe(before.lineage);
    expectLostEditForReview(phone.phone);

    // The tablet's older copies differ from the restored server: the user decides.
    expectSynced(await tablet.phone.sync());
    expectSynced(await tablet.phone.sync());
    expect(
      tablet.phone.store.problems().map((r) => [r.id, r.problem?.reason, r.content?.title]),
    ).toEqual([
      ["w1", "exists", "v1"],
      ["w3", "deleted", "three"],
    ]);
    expect(tablet.phone.store.get("workout", "w1")?.server?.content?.title).toBe("v2");
  });
});

describe("size limits", () => {
  const note = (index: number) => ({
    id: `n${index}`,
    text: "x".repeat(10_000),
    createdAt: "2026-11-10T18:00:00.000Z",
  });
  const large = (workoutId: string, notes: number, name = "Big") =>
    entry(workoutId, name, { notes: Array.from({ length: notes }, (_, i) => note(i)) });

  it("refuses a record over 200,000 bytes on the device and on the server", async () => {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("Notes"));
    expectSynced(await phone.sync());
    expect(jsonBytes(large("w1", 19))).toBeLessThan(200_000);
    expect(jsonBytes(large("w1", 20))).toBeGreaterThan(200_000);
    expect(() => phone.store.put("workout_exercise", "e1", large("w1", 20))).toThrow(/200000/);
    phone.store.put("workout_exercise", "e1", large("w1", 19));

    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    const tooBig = peer.put("workout_exercise", "e2", large("w1", 20));
    const fine = peer.put("workout_exercise", "e3", large("w1", 19));
    expect(await peer.push([tooBig, fine])).toMatchObject({
      results: [{ status: "invalid", code: "invalid_content" }, { status: "accepted" }],
    });
    expect(await server.row("alice", "workout_exercise", "e2")).toBeUndefined();
  });

  it("uploads many large records in requests under 1 MiB and downloads them in bounded pages", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("Notes"));
    const ids = Array.from({ length: 12 }, (_, i) => `e${String(i + 1).padStart(2, "0")}`);
    for (const id of ids) phone.store.put("workout_exercise", id, large("w1", 15, id));
    expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 13 });

    const pushes = net.log.filter((e) => e.path === "/sync/push");
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    for (const push of pushes) expect(jsonBytes(push.request)).toBeLessThan(1_048_576);
    expect(sentSubmissions(net.log).map((s) => s.id)).toEqual(["w1", ...ids]);

    const reader = await phoneOn(server, "reader");
    expectSynced(await reader.phone.sync());
    const pages = reader.net.log.filter((e) => e.path === "/sync/pull");
    const first = pages[0]?.response?.body as { changes: unknown[]; hasMore: boolean };
    expect(first.hasMore).toBe(true);
    expect(first.changes.length).toBeLessThan(13);
    for (const page of pages) {
      const body = page.response?.body as { changes: { content?: unknown }[] };
      expect(body.changes.length).toBeGreaterThan(0);
      // It stops once it holds about 800,000 bytes, so it may go over by at most one record.
      const contents = body.changes.map((c) => jsonBytes(c.content ?? null));
      const beforeLast = contents.slice(0, -1).reduce((a, b) => a + b, 0);
      expect(beforeLast).toBeLessThan(800_000);
    }
    expect(reader.phone.store.list("workout_exercise").map((r) => r.id)).toEqual(ids);
  });
});

describe("the write service validates what it is given", () => {
  it("throws for malformed submissions or repeated ids and writes nothing", async () => {
    const server = world.server();
    const { service } = server;
    const good = {
      op: "put" as const,
      submissionId: "s-1",
      kind: "workout",
      id: "w1",
      baseRevision: null,
      content: workout("ok", { initialPlan: null }),
    };
    await expect(
      service.submit("alice", "1.0", [good, { ...good, submissionId: "s-2", kind: "spaceship" }]),
    ).rejects.toThrow(/invalid submissions/);
    await expect(
      service.submit("alice", "1.0", [
        good,
        { op: "delete", submissionId: "s-3", kind: "workout", id: "w2", baseRevision: 1 },
      ] as never),
    ).rejects.toThrow(/invalid submissions/);
    await expect(service.submit("alice", "1.0", [good, { ...good, id: "w2" }])).rejects.toThrow(
      /unique/,
    );
    expect(await server.rows("alice")).toEqual([]);
    expect(await server.head("alice")).toBe(0);
    expect(await server.receipts("alice")).toEqual([]);
    expect(await service.submit("alice", "1.0", [good])).toEqual([
      { status: "accepted", submissionId: "s-1", revision: 1 },
    ]);
  });
});
