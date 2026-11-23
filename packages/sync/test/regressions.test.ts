import { join } from "node:path";
import { MAX_WAIT_MS } from "@leve/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "../src/transport.ts";
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
import { rehearsalContract } from "./support/synthetic.ts";

/*
 * Regression tests for defects found in review: account binding of long polls, a long poll racing
 * a server restore, deletions checking descendants, deleted trees with unsynced work, settings,
 * partially synced records, file-copy restores, long polling, null-base deletions after a restore
 * and the import boundaries. Expected results are written out literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

async function phoneOn(server: ServerHarness, name: string, account = "alice") {
  const net = new FaultyTransport(server.transport(account));
  const phone = await world.phone(name, { account, server: "s", transport: net.call });
  return { phone, net };
}

const titles = (phone: Phone) =>
  phone.store.list("workout").map((record) => [record.id, record.content?.title]);

const serverLive = async (server: ServerHarness, kind = "workout") =>
  (await server.rows("alice"))
    .filter((row) => row.kind === kind && row.state === "live")
    .map((row) => [row.id, row.content?.title])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));

const sorted = (pairs: unknown[][]) =>
  [...pairs].sort(([a], [b]) => String(a).localeCompare(String(b)));

describe("account binding", () => {
  it("refuses a long poll after an account switch and stores nothing from the other account", async () => {
    const server = world.server();
    const bob = new Peer1(server.transport("bob"), "bob");
    await bob.push([bob.put("workout", "b1", workout("Bob's"))]);
    await bob.push([bob.put("workout", "b2", workout("Bob's too"))]);
    const { phone } = await phoneOn(server, "phone");
    phone.store.put("workout", "a1", workout("Alice's"));
    expectSynced(await phone.sync());
    const before = phone.store.syncState();

    // The same device store, now configured for another account.
    await phone.restart({ account: "bob", transport: server.transport("bob") });
    await expect(phone.sync()).rejects.toThrow(/another account/);
    await expect(phone.client.waitForChanges(0)).rejects.toThrow(/another account/);
    expect(titles(phone)).toEqual([["a1", "Alice's"]]);
    expect(phone.store.syncState()).toEqual(before);

    await phone.restart({ account: "alice", transport: server.transport("alice") });
    expectSynced(await phone.sync());
    expect(await serverLive(server)).toEqual([["a1", "Alice's"]]);
  });
});

describe("a long poll racing a restore", () => {
  it("never leaves records from the old history or misses ones from the new", async () => {
    const server = world.server();
    const base = server.transport("alice");
    let hold = false;
    let release: (() => void) | null = null;
    let onPush: (() => void) | null = null;
    // Holds the long poll's reply until the restore happened; a concurrent sync's upload (or a
    // timer, when syncs wait for each other) lets it through.
    const transport: Transport = async (path, body) => {
      if (path === "/sync/pull" && hold) {
        hold = false;
        const reply = await base(path, body);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return reply;
      }
      if (path === "/sync/push" && onPush) {
        const fn = onPush;
        onPush = null;
        fn();
      }
      return base(path, body);
    };
    const a = await world.phone("a", { account: "alice", server: "s", transport });
    a.store.put("workout", "w1", workout("A1"));
    expectSynced(await a.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    const b = new Peer1(server.transport("alice"), "b");
    await b.pull();
    await b.push([b.put("workout", "w2", workout("B2"))]);
    await b.push([b.put("workout", "w3", workout("B3"))]);

    hold = true;
    const longPoll = a.client.waitForChanges(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(release).not.toBeNull();
    await server.restoreWithCommand("alice", backup);
    const c = new Peer1(server.transport("alice"), "c");
    await c.pull();
    await c.push([c.put("workout", "w4", workout("C4"))]);
    await c.push([c.put("workout", "w5", workout("C5"))]);

    const letGo = () => (release as unknown as () => void)();
    onPush = letGo;
    const timer = setTimeout(letGo, 50);
    const outcomes = await Promise.all([a.sync(), longPoll]);
    clearTimeout(timer);
    for (const outcome of outcomes) expect(outcome.state).toBe("synced");
    expectSynced(await a.sync());

    // What the phone shows is exactly the restored server, including C's records.
    expect(sorted(titles(a))).toEqual(await serverLive(server));
    expect(titles(a)).toEqual(
      expect.arrayContaining([
        ["w4", "C4"],
        ["w5", "C5"],
      ]),
    );
    expect(a.store.syncState().cursor).toBe(await server.head("alice"));
    expect(a.store.summary()).toMatchObject({ pending: 0, conflict: 0, inFlight: 0 });
  });
});

describe("updates of records the server doesn't have", () => {
  it("are stale, and nothing is created", async () => {
    const server = world.server();
    const peer = new Peer1(server.transport("alice"));
    const reply = await peer.push([
      { ...peer.put("workout", "w-unknown", workout("Edited")), baseRevision: 5 },
    ]);
    expect(reply.results).toMatchObject([{ status: "conflict", reason: "stale" }]);
    expect(await server.rows("alice")).toEqual([]);
  });
});

describe("deleting a parent checks its descendants", () => {
  async function tree(server: ServerHarness) {
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("Legs"));
    a.phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    a.phone.store.put("workout_set", "s1", set("e1"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    return { a, b };
  }

  it("rejects a deletion that doesn't know a set added since, and keeps the sets", async () => {
    const server = world.server();
    const { a, b } = await tree(server);
    b.phone.store.put("workout_set", "s2", set("e1", { position: 2, reps: 9 }));
    expectSynced(await b.phone.sync());

    a.phone.store.delete("workout", "w1");
    expectSynced(await a.phone.sync());
    const del = sentSubmissions(a.net.log).find((s) => s.op === "delete");
    expect(del).toMatchObject({
      id: "w1",
      baseRevision: 1,
      descendants: [
        { kind: "workout_exercise", id: "e1", revision: 2 },
        { kind: "workout_set", id: "s1", revision: 3 },
      ],
    });
    const deletion = a.net.log.find(
      (e) => e.path === "/sync/push" && JSON.stringify(e.request).includes(`"op":"delete"`),
    );
    expect(resultsOf(deletion)).toMatchObject([
      { status: "conflict", reason: "stale", current: { id: "w1", revision: 1 } },
    ]);
    expect((await server.rows("alice")).map((r) => [r.id, r.state])).toEqual([
      ["w1", "live"],
      ["e1", "live"],
      ["s1", "live"],
      ["s2", "live"],
    ]);
    expect(a.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      deleted: true,
      problem: { reason: "stale" },
    });

    // Insisting, now that the phone has seen the new set, deletes the whole tree.
    a.phone.store.resolve("workout", "w1", { choice: "keep_mine" });
    expectSynced(await a.phone.sync());
    expect(sentSubmissions(a.net.log).at(-1)).toMatchObject({
      op: "delete",
      id: "w1",
      descendants: [
        { kind: "workout_exercise", id: "e1", revision: 2 },
        { kind: "workout_set", id: "s1", revision: 3 },
        { kind: "workout_set", id: "s2", revision: 4 },
      ],
    });
    expect((await server.rows("alice")).every((r) => r.state === "deleted")).toBe(true);
    expect(a.phone.store.problems()).toEqual([]);
  });

  it("rejects a deletion that knows an older revision of a set", async () => {
    const server = world.server();
    await tree(server);
    const stale = new Peer1(server.transport("alice"), "stale");
    await stale.pull();
    const editor = new Peer1(server.transport("alice"), "editor");
    await editor.pull();
    await editor.push([editor.put("workout_set", "s1", set("e1", { reps: 12 }))]);

    expect(await stale.push([stale.delete("workout", "w1")])).toMatchObject({
      results: [{ status: "conflict", reason: "stale", current: { id: "w1", revision: 1 } }],
    });
    expect((await server.row("alice", "workout_set", "s1"))?.content).toMatchObject({ reps: 12 });

    await stale.pull();
    expect(await stale.push([stale.delete("workout", "w1")])).toMatchObject({
      results: [{ status: "accepted", revision: 7 }],
    });
  });

  it("answers a deletion without a base as stale when the record is live", async () => {
    const server = world.server();
    await tree(server);
    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    const blind = { ...peer.delete("workout", "w1"), baseRevision: null };
    expect(await peer.push([blind])).toMatchObject({
      results: [{ status: "conflict", reason: "stale", current: { id: "w1", state: "live" } }],
    });
    // Without a base, a record the server doesn't have gets a deletion marker.
    const unknown = { ...blind, submissionId: "blind-2", id: "w-unknown", descendants: [] };
    expect(await peer.push([unknown])).toMatchObject({
      results: [{ status: "accepted", revision: 4 }],
    });
    expect(await server.row("alice", "workout", "w-unknown")).toMatchObject({
      state: "deleted",
      content: null,
    });
  });
});

describe("a tree deleted elsewhere while this phone holds unsynced sets", () => {
  async function deletedUnderUs() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("Legs"));
    a.phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    a.phone.store.put("workout_set", "s1", set("e1"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    // A records more sets while offline; B deletes the workout.
    a.phone.store.put("workout_set", "s1", set("e1", { reps: 8 }));
    a.phone.store.put("workout_set", "s2", set("e1", { position: 2, reps: 6 }));
    b.phone.store.delete("workout", "w1");
    expectSynced(await b.phone.sync());
    expectSynced(await a.phone.sync());
    return { server, a };
  }

  it("keeps the workout visible as a deleted conflict and saves the whole tree as new", async () => {
    const { server, a } = await deletedUnderUs();
    const store = a.phone.store;
    expect(store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      deleted: false,
      content: { title: "Legs" },
      problem: { reason: "deleted" },
      server: { state: "deleted" },
    });
    expect(store.list("workout").map((r) => r.id)).toEqual(["w1"]);
    expect(store.list("workout_exercise", { parentId: "w1" }).map((r) => r.id)).toEqual(["e1"]);
    expect(
      store.list("workout_set", { parentId: "e1" }).map((r) => [r.id, r.content?.reps]),
    ).toEqual([
      ["s1", 8],
      ["s2", 6],
    ]);
    expect(() => store.resolve("workout_set", "s2", { choice: "save_as_new", newId: "x" })).toThrow(
      /deleted parent/,
    );
    expect(() => store.resolve("workout", "w1", { choice: "keep_mine" })).toThrow();

    store.resolve("workout", "w1", { choice: "save_as_new", newId: "w1-new" });
    expect(store.problems()).toEqual([]);
    expectSynced(await a.phone.sync());

    const live = (await server.rows("alice")).filter((r) => r.state === "live");
    const newEntry = live.find((r) => r.kind === "workout_exercise");
    expect(live.map((r) => [r.kind, r.parentId])).toEqual([
      ["workout", null],
      ["workout_exercise", "w1-new"],
      ["workout_set", newEntry?.id],
      ["workout_set", newEntry?.id],
    ]);
    expect(live.map((r) => r.content?.title ?? r.content?.exerciseName ?? r.content?.reps)).toEqual(
      ["Legs", "Squat", 8, 6],
    );
    for (const id of ["w1", "e1", "s1"]) {
      expect((await server.rows("alice")).find((r) => r.id === id)?.state).toBe("deleted");
    }
    expect(store.list("workout").map((r) => r.id)).toEqual(["w1-new"]);
    expect(store.hasUnsyncedWork()).toBe(false);
  });

  it("drops the tree on keep theirs", async () => {
    const { a } = await deletedUnderUs();
    const store = a.phone.store;
    store.resolve("workout", "w1", { choice: "keep_theirs" });
    expect(store.list("workout")).toEqual([]);
    expect(store.list("workout_set")).toEqual([]);
    expect(store.problems()).toEqual([]);
    expectSynced(await a.phone.sync());
    expect(store.hasUnsyncedWork()).toBe(false);
  });
});

describe("settings", () => {
  it("can be changed but never deleted", async () => {
    const server = world.server();
    const { phone } = await phoneOn(server, "phone");
    const settings = {
      weightUnit: "kg",
      distanceUnit: "km",
      shortDistanceUnit: "m",
      measurementUnit: "cm",
      firstWeekday: 1,
      defaultRestSeconds: 90,
      rpeEnabled: false,
      countWarmups: false,
      previousValues: "any_workout",
      autoUpdateRoutineValues: false,
    };
    phone.store.put("settings", "settings", settings);
    expectSynced(await phone.sync());
    expect(() => phone.store.delete("settings", "settings")).toThrow(/not deleted/);

    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    expect(await peer.push([peer.delete("settings", "settings")])).toEqual({
      release: "1.0",
      results: [
        {
          status: "invalid",
          submissionId: "peer-1",
          code: "not_deletable",
          message: expect.any(String),
        },
      ],
    });
    expect((await server.row("alice", "settings", "settings"))?.state).toBe("live");
    await peer.push([peer.put("settings", "settings", { ...settings, rpeEnabled: true })]);
    expectSynced(await phone.sync());
    expect(phone.store.get("settings", "settings")?.content).toMatchObject({ rpeEnabled: true });
  });
});

describe("partially synced records (synthetic release 1.1)", () => {
  it("become conflicts when a newer copy or a deletion is downloaded", async () => {
    const server = world.server({ releases: ["1.0"] });
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
      contract: rehearsalContract,
      releases: ["1.0", "1.1"],
    });
    phone.store.put("workout", "w1", workout("Run", { effortRating: 6 }));
    phone.store.put("workout", "w2", workout("Walk", { effortRating: 3 }));
    expectSynced(await phone.sync());
    expect(phone.store.summary()).toMatchObject({ partial: 2 });

    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    await peer.push([peer.delete("workout", "w1")]);
    await peer.push([peer.put("workout", "w2", workout("Walk renamed"))]);
    expectSynced(await phone.sync());

    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      problem: { reason: "deleted" },
      content: { title: "Run", effortRating: 6 },
    });
    expect(phone.store.get("workout", "w2")).toMatchObject({
      status: "conflict",
      problem: { reason: "stale" },
      content: { title: "Walk", effortRating: 3 },
      server: { content: { title: "Walk renamed" } },
    });
    expect(phone.store.summary()).toMatchObject({ partial: 0, conflict: 2 });
  });
});

describe("a restore by copying the database file", () => {
  it("makes every phone reset, not only the one whose cursor is ahead", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("one"));
    a.phone.store.put("workout", "w2", workout("two"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    const copy = join(world.directory, "copy.db");
    await server.snapshot("alice", copy);
    b.phone.store.put("workout", "w1", workout("one by B"));
    expectSynced(await b.phone.sync());
    expectSynced(await a.phone.sync());
    for (const id of ["w3", "w4", "w5"]) a.phone.store.put("workout", id, workout(id));
    expectSynced(await a.phone.sync());
    expect(a.phone.store.syncState().cursor).toBe(6);
    expect(b.phone.store.syncState().cursor).toBe(3);
    const lineage = a.phone.store.syncState().lineage;

    // The file is put back without the restore command: same lineage, older counter.
    await server.restore("alice", copy);
    expect(await server.head("alice")).toBe(2);

    // A notices its cursor is ahead; the server starts a new lineage for everyone.
    expectSynced(await a.phone.sync());
    const rotated = a.phone.store.syncState().lineage;
    expect(rotated).not.toBe(lineage);
    expect(await server.head("alice")).toBeGreaterThanOrEqual(3);
    // B's cursor is not ahead of the counter any more, but its history is gone all the same.
    expectSynced(await b.phone.sync());
    expect(b.phone.store.syncState().lineage).toBe(rotated);
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());

    // B's edit the server lost is held for review, never shown as synced.
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "one by B" },
      server: { content: { title: "one" } },
    });
    const live = Object.fromEntries(await serverLive(server));
    expect(live).toEqual({ w1: "one", w2: "two", w3: "w3", w4: "w4", w5: "w5" });
    for (const phone of [a.phone, b.phone]) {
      for (const record of phone.store.list("workout")) {
        if (record.status === "synced") expect(record.content?.title).toBe(live[record.id]);
      }
      expect(phone.store.list("workout").map((r) => r.id)).toEqual(Object.keys(live));
      expect(phone.store.syncState().cursor).toBe(await server.head("alice"));
    }
  });
});

describe("long polling", () => {
  function fakeTimers() {
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      timers,
      setTimer(fn: () => void, ms: number) {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return {
          cancel() {
            timer.cancelled = true;
          },
        };
      },
    };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const watch = <T>(promise: Promise<T>) => {
    const state = { done: false };
    promise.then(() => {
      state.done = true;
    });
    return state;
  };

  it("wakes on a write by another device, times out empty, caps the wait and ignores other accounts", async () => {
    const clock = fakeTimers();
    const server = world.server({ setTimer: clock.setTimer });
    const { phone } = await phoneOn(server, "phone");
    phone.store.put("workout", "w1", workout("mine"));
    expectSynced(await phone.sync());
    const other = new Peer1(server.transport("alice"), "other");
    const bob = new Peer1(server.transport("bob"), "bob");
    await bob.hello();

    // A write elsewhere wakes the poll before its timer.
    const woken = phone.client.waitForChanges(10_000);
    await settle();
    expect(clock.timers.map((t) => t.ms)).toEqual([10_000]);
    const wokenState = watch(woken);
    await bob.push([bob.put("workout", "b1", workout("bob"))]);
    await settle();
    expect(wokenState.done).toBe(false);
    await other.push([other.put("workout", "w2", workout("from elsewhere"))]);
    expect(await woken).toEqual({ state: "synced", pushed: 0, pulled: 1 });
    expect(clock.timers[0]?.cancelled).toBe(true);
    expect(titles(phone)).toEqual([
      ["w1", "mine"],
      ["w2", "from elsewhere"],
    ]);

    // Nothing happens: the timer ends the poll with no changes.
    const quiet = phone.client.waitForChanges(MAX_WAIT_MS);
    await settle();
    expect(clock.timers[1]?.ms).toBe(MAX_WAIT_MS);
    const quietState = watch(quiet);
    await settle();
    expect(quietState.done).toBe(false);
    clock.timers[1]?.fn();
    expect(await quiet).toEqual({ state: "synced", pushed: 0, pulled: 0 });
    expect(phone.store.syncState().cursor).toBe(2);

    // The wait is capped by the protocol.
    const lineage = phone.store.syncState().lineage;
    const tooLong = await server.transport("alice")("/sync/pull", {
      release: "1.0",
      lineage,
      cursor: 2,
      waitMs: MAX_WAIT_MS + 1,
    });
    expect(tooLong).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(clock.timers).toHaveLength(2);
  });
});

describe("restore after a deletion", () => {
  it("keeps a record deleted that the restored server lost, even for a phone that still had it", async () => {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("kept"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    // Created and deleted after the backup; B saw it created but not deleted.
    a.phone.store.put("workout", "w2", workout("gone"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    a.phone.store.delete("workout", "w2");
    expectSynced(await a.phone.sync());
    expect(b.phone.store.get("workout", "w2")?.status).toBe("synced");

    await server.restoreWithCommand("alice", backup);
    expect(await server.row("alice", "workout", "w2")).toBeUndefined();

    expectSynced(await a.phone.sync());
    expect(resultsOf(a.net.log.filter((e) => e.path === "/sync/push").at(-1))).toMatchObject([
      { status: "accepted" },
    ]);
    expect(sentSubmissions(a.net.log).at(-1)).toMatchObject({
      op: "delete",
      id: "w2",
      baseRevision: null,
      descendants: [],
    });
    expect(await server.row("alice", "workout", "w2")).toMatchObject({ state: "deleted" });

    expectSynced(await b.phone.sync());
    expectSynced(await b.phone.sync());
    expect(await server.row("alice", "workout", "w2")).toMatchObject({ state: "deleted" });
    // B still had it; its copy is offered back but held as a conflict, never re-created.
    expect(b.phone.store.get("workout", "w2")).toMatchObject({
      status: "conflict",
      problem: { reason: "deleted" },
      server: { state: "deleted" },
    });
    expectSynced(await a.phone.sync());
    expect(titles(a.phone)).toEqual([["w1", "kept"]]);
  });
});

describe("a record whose local version names another parent than the server copy", () => {
  /** A's e1 is a rejected create under w2; the server has e1 (from B) under w1. */
  async function crossed() {
    const server = world.server();
    const a = await phoneOn(server, "a");
    const b = await phoneOn(server, "b");
    a.phone.store.put("workout", "w1", workout("one"));
    a.phone.store.put("workout", "w2", workout("two"));
    expectSynced(await a.phone.sync());
    expectSynced(await b.phone.sync());
    b.phone.store.put("workout_exercise", "e1", entry("w1", "B's entry"));
    expectSynced(await b.phone.sync());
    a.phone.store.put("workout_exercise", "e1", entry("w2", "A's entry"));
    expectSynced(await a.phone.sync());
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      status: "conflict",
      problem: { reason: "exists" },
      content: { workoutId: "w2" },
      server: { revision: 3, content: { workoutId: "w1" } },
    });
    return { server, a };
  }

  it("deleting the local parent leaves the server's record where the server has it", async () => {
    const { server, a } = await crossed();
    a.phone.store.delete("workout", "w2");
    expectSynced(await a.phone.sync());
    expect(sentSubmissions(a.net.log).at(-1)).toMatchObject({
      op: "delete",
      id: "w2",
      descendants: [],
    });
    expect((await server.row("alice", "workout", "w2"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_exercise", "e1"))?.state).toBe("live");
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      status: "synced",
      content: { workoutId: "w1", exerciseName: "B's entry" },
    });
    expect(a.phone.store.list("workout_exercise", { parentId: "w1" }).map((r) => r.id)).toEqual([
      "e1",
    ]);
  });

  it("keeps a deletion the user made when the local parent is deleted elsewhere", async () => {
    const { a } = await crossed();
    a.phone.store.delete("workout_exercise", "e1");
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      deleted: true,
      status: "conflict",
    });
    const peer = new Peer1(a.phone.options.transport);
    await peer.pull();
    await peer.push([peer.delete("workout", "w2")]);
    await peer.push([peer.put("workout_exercise", "e1", entry("w1", "B's entry, edited"))]);
    expectSynced(await a.phone.sync());
    // The record lives on under w1 on the server; A's own deletion of it is still held.
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      deleted: true,
      status: "conflict",
      server: { state: "live", content: { exerciseName: "B's entry, edited" } },
    });
    expect(a.phone.store.list("workout_exercise")).toEqual([]);
  });

  it("deleting the server parent names the record as a descendant and is accepted", async () => {
    const { server, a } = await crossed();
    a.phone.store.delete("workout", "w1");
    expectSynced(await a.phone.sync());
    expect(sentSubmissions(a.net.log).at(-1)).toMatchObject({
      op: "delete",
      id: "w1",
      descendants: [{ kind: "workout_exercise", id: "e1", revision: 3 }],
    });
    expect((await server.row("alice", "workout", "w1"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_exercise", "e1"))?.state).toBe("deleted");
    // A's own version under w2 is still held for review.
    expect(a.phone.store.get("workout_exercise", "e1")).toMatchObject({
      status: "conflict",
      content: { workoutId: "w2", exerciseName: "A's entry" },
      server: { state: "deleted" },
    });
  });
});

describe("answers the client must not trust or must settle", () => {
  it("refuses a conflict whose current copy names another record", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "a");
    const other = await phoneOn(server, "b");
    phone.store.put("workout", "w1", workout("one"));
    phone.store.put("workout", "w2", workout("two"));
    expectSynced(await phone.sync());
    expectSynced(await other.phone.sync());
    other.phone.store.put("workout", "w1", workout("one by B"));
    expectSynced(await other.phone.sync());
    phone.store.put("workout", "w1", workout("one by A"));
    net.beforeReply = (path, response) => {
      if (path !== "/sync/push") return;
      const [result] = (response.body as { results: { current?: { id: string } }[] }).results;
      if (result?.current) result.current.id = "w2";
    };
    expect(await phone.sync()).toEqual({
      state: "error",
      error: "unreadable record in push answer",
    });
    expect(phone.store.get("workout", "w2")).toMatchObject({
      status: "synced",
      content: { title: "two" },
    });
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      content: { title: "one by A" },
    });
  });

  it("refuses a page that says there is more without moving the cursor", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "a");
    const peer = new Peer1(server.transport("alice"));
    await peer.push([peer.put("workout", "w1", workout("one"))]);
    let tampered = 0;
    net.beforeReply = (path, response) => {
      // Bounded, so a client that keeps asking ends the loop instead of hanging the test.
      if (path !== "/sync/pull" || ++tampered > 5) return;
      Object.assign(response.body as object, { changes: [], cursor: 0, hasMore: true });
    };
    expect(await phone.sync()).toEqual({ state: "error", error: "unreadable pull answer" });
    expect(phone.store.syncState().cursor).toBe(0);
    net.beforeReply = null;
    expectSynced(await phone.sync());
    expect(titles(phone)).toEqual([["w1", "one"]]);
  });

  it("leaves a newer edit pending when an older submission is answered invalid", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "a");
    phone.store.put("workout", "w1", workout("one"));
    net.beforeReply = (path, response) => {
      if (path !== "/sync/push") return;
      net.beforeReply = null;
      phone.store.put("workout", "w1", workout("one, corrected"));
      const body = response.body as { results: Record<string, unknown>[] };
      body.results = body.results.map((r) => ({
        status: "invalid",
        submissionId: r.submissionId,
        code: "invalid_content",
        message: "rejected for the test",
      }));
    };
    net.next("pass", "/sync/push").next("offline", "/sync/push");
    await phone.sync();
    expect(phone.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      content: { title: "one, corrected" },
    });
  });

  it("forgets a deleted record whose only upload was a create the server postponed", async () => {
    const server = world.server();
    const { phone, net } = await phoneOn(server, "a");
    phone.store.put("workout_exercise", "e9", entry("w9", "Row"));
    net.beforeReply = (path) => {
      if (path !== "/sync/push") return;
      net.beforeReply = null;
      phone.store.delete("workout_exercise", "e9");
    };
    expectSynced(await phone.sync());
    expect(resultsOf(net.log.find((e) => e.path === "/sync/push"))).toMatchObject([
      { status: "retry_later" },
    ]);
    expect(phone.store.get("workout_exercise", "e9")).toBeNull();
    expect(phone.store.hasUnsyncedWork()).toBe(false);
    expect(await server.rows("alice")).toEqual([]);
  });
});

it("settles matching workout deletions first learned in a stale header upload reply", async () => {
  const server = world.server();
  const { phone: a } = await phoneOn(server, "a");
  const { phone: b } = await phoneOn(server, "b");
  a.store.put("workout", "w", workout("Workout"));
  a.store.put("workout_exercise", "e", entry("w", "Bench"));
  expectSynced(await a.sync());
  expectSynced(await b.sync());
  a.store.put("workout", "w", workout("Renamed"));
  expect(a.store.prepareSubmissions("1.0")).toHaveLength(1);
  a.store.delete("workout", "w");
  b.store.delete("workout", "w");
  expectSynced(await b.sync());
  expectSynced(await a.sync());
  await a.restart();
  expect(a.store.problems()).toEqual([]);
  expect(a.store.get("workout", "w")).toMatchObject({ deleted: true, status: "synced" });
  expect(a.store.prepareSubmissions("1.0")).toEqual([]);
});
