import { join } from "node:path";
import { type Contract, jsonBytes, leveContract } from "@leve/contract";
import { expect, it } from "vitest";
import { HistoricalPeer } from "../../contract/history/1.0/peer.ts";
import { previewContract, previewFrozen } from "../../contract/test/support/preview-contract.ts";
import { maximumWorkout } from "../../storage/src/test-support/max-workout.ts";
import { ENDED, STARTED, workout } from "./support/content.ts";
import { FaultyTransport, World } from "./support/harness.ts";

it("syncs individual notes and replies independently across a restart, older edits and a server upgrade", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const device = { server: "s", account: "alice", transport };
    const first = await world.phone("first", device);
    first.store.put("workout", "source", workout("Legs", { endedAt: ENDED }));
    const pin = {
      workoutId: "source",
      kind: "sticky",
      text: "Use rack three",
      createdAt: STARTED,
      reply: null,
    };
    first.store.put("workout_note", "pin", pin);
    await first.sync();
    expect(await server.service.read("alice", "workout_note", "pin", "1.2")).toBeNull();
    const reader = await world.phone("reader", device);
    await reader.sync();
    expect(reader.store.list("workout_note", { parentId: "source" })).toHaveLength(1);
    const peer = new HistoricalPeer(previewFrozen("1.2"), transport);
    await peer.hello();
    expect((await peer.pull()).map((row) => row.kind)).toEqual(["workout"]);
    await peer.push([
      peer.put("workout", "source", workout("Renamed", { initialPlan: null, endedAt: ENDED })),
    ]);
    const answer = { text: "Keep six reps", createdAt: ENDED };
    reader.store.put("workout_note", "pin", { ...pin, reply: answer });
    first.store.put("workout_note", "q", { ...pin, kind: "session", text: "Last set felt easy" });
    await first.sync();
    await server.restart({ releases: ["1.2"] });
    await reader.sync();
    expect(reader.store.get("workout_note", "pin")?.status).toBe("pending");
    await reader.restart();
    await server.restart({ releases: ["2.0"] });
    await reader.sync();
    await first.sync();
    expect(first.store.get("workout_note", "pin")?.content?.reply).toEqual(answer);
    expect(reader.store.get("workout_note", "q")?.content?.text).toBe("Last set felt easy");
    expect(reader.store.get("workout", "source")?.content?.title).toBe("Renamed");
    reader.store.delete("workout_note", "pin");
    await reader.sync();
    await first.sync();
    expect(first.store.list("workout_note", { parentId: "source" }).map((row) => row.id)).toEqual([
      "q",
    ]);
    first.store.delete("workout", "source");
    await first.sync();
    await reader.sync();
    expect(reader.store.list("workout_note", { parentId: "source" })).toEqual([]);
    expect(await server.service.read("alice", "workout_note", "q", "1.2")).toBeNull();
  } finally {
    await world.dispose();
  }
});

it("round-trips a 200,000-byte workout from the archived 1.2 peer while a note is stored separately", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const peer = new HistoricalPeer(previewFrozen("1.2"), transport);
    await peer.hello();
    const original = maximumWorkout();
    expect(jsonBytes(original)).toBe(200_000);
    await peer.push([peer.put("workout", "full", original)]);
    const phone = await world.phone("reader", { server: "s", account: "alice", transport });
    await phone.sync();
    expect(phone.store.get("workout", "full")?.content).toEqual(original);
    phone.store.put("workout_note", "cue", {
      workoutId: "full",
      kind: "sticky",
      text: "Raise the seat",
      createdAt: STARTED,
      reply: null,
    });
    await phone.sync();
    expect((await server.row("alice", "workout_note", "cue"))?.content?.text).toBe(
      "Raise the seat",
    );
    expect((await server.row("alice", "workout", "full"))?.content).toEqual(original);
  } finally {
    await world.dispose();
  }
});

it("preserves a workout’s rest default through older edits and refuses a second ID for the same workout", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const opts = { server: "s", account: "alice", transport };
    const first = await world.phone("first", opts);
    first.store.put("workout", "w", workout("Session"));
    const rest = { workoutId: "w", seconds: 0 };
    expect(() => first.store.put("workout_rest", "different", rest)).toThrow(/parent/);
    first.store.put("workout_rest", "w", rest);
    await first.sync();
    const peer = new HistoricalPeer(previewFrozen("2.0"), transport);
    await peer.hello();
    await peer.pull();
    expect(await peer.push([peer.put("workout_rest", "different", rest)])).toMatchObject({
      results: [{ status: "invalid", code: "invalid_content" }],
    });
    expect(() => first.store.delete("workout_rest", "w")).toThrow(/not deleted/);
    expect(await peer.push([peer.delete("workout_rest", "w")])).toMatchObject({
      results: [{ status: "invalid", code: "not_deletable" }],
    });
    const legacy = new HistoricalPeer(previewFrozen("1.2"), transport);
    await legacy.hello();
    await legacy.pull();
    expect(await legacy.push([legacy.delete("workout", "w")])).toMatchObject({
      results: [{ status: "conflict", reason: "stale" }],
    });
    const other = await world.phone("second", opts);
    await other.sync();
    await other.restart();
    expect(other.store.get("workout_rest", "w")?.content).toEqual(rest);
    other.store.put("workout_rest", "w", { ...rest, seconds: null });
    await other.sync();
    await first.sync();
    expect(first.store.get("workout_rest", "w")?.content?.seconds).toBeNull();
    other.store.put("workout_rest", "w", { ...rest, seconds: 30 });
    first.store.delete("workout", "w");
    await first.sync();
    await other.sync();
    expect(other.store.get("workout", "w")?.status).toBe("conflict");
    other.store.resolve("workout", "w", { choice: "save_as_new", newId: "recovered" });
    await other.sync();
    await first.sync();
    expect(first.store.get("workout_rest", "recovered")).toMatchObject({
      status: "synced",
      content: { workoutId: "recovered", seconds: 30 },
    });
    expect(other.store.list("workout_rest", { parentId: "w" })).toEqual([]);
  } finally {
    await world.dispose();
  }
});

it.each(["workout_note", "workout_rest"])(
  "syncs other records while a workout deletion still needs the release that knows its %s",
  async (kind) => {
    const world = new World(previewContract);
    try {
      const server = world.server();
      const a = await world.phone("a", {
        account: "alice",
        server: "s",
        transport: server.transport("alice"),
      });
      a.store.put("workout", "w", workout("Push"));
      const id = kind === "workout_note" ? "pin" : "w";
      if (kind === "workout_note")
        a.store.put(kind, id, {
          workoutId: "w",
          kind: "sticky",
          text: "Seat 4",
          createdAt: STARTED,
          reply: null,
        });
      else a.store.put(kind, id, { workoutId: "w", seconds: 0 });
      await a.sync();
      await server.restart({ releases: ["1.2"] });
      await a.sync();
      a.store.delete("workout", "w");
      a.store.put("workout", "another", workout("Another"));
      await a.sync();
      expect((await server.row("alice", "workout", "another"))?.state).toBe("live");
      expect((await server.row("alice", kind, id))?.state).toBe("live");
      expect(a.store.get("workout", "w")).toMatchObject({ deleted: true, inFlight: false });
      await a.restart();
      await server.restart({ releases: ["1.2", "2.0"] });
      await a.sync();
      expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
      expect((await server.row("alice", kind, id))?.state).toBe("deleted");
      expect(a.store.hasUnsyncedWork()).toBe(false);
    } finally {
      await world.dispose();
    }
  },
);

it("replays a rest marker safely when a device saw only the deleted workout and a backup precedes its creation", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const opts = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", opts);
    await a.sync();
    const backup = join(world.directory, "empty.db");
    await server.snapshot("alice", backup);
    a.store.put("workout", "w", workout("Push"));
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
    await a.sync();
    a.store.delete("workout", "w");
    await a.sync();
    const b = await world.phone("b", opts);
    await b.sync();
    expect(b.store.get("workout_rest", "w")?.deleted).toBe(true);
    await server.restoreWithCommand("alice", backup);
    await b.restart();
    await b.sync();
    expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_rest", "w"))?.state).toBe("deleted");
    expect(b.store.problems()).toEqual([]);
    expect(b.store.hasUnsyncedWork()).toBe(false);
  } finally {
    await world.dispose();
  }
});

it.each([
  { snapshotRest: true, choice: "keep_mine" },
  { snapshotRest: true, choice: "keep_theirs" },
  { snapshotRest: false, choice: "keep_mine" },
  { snapshotRest: false, choice: "keep_theirs" },
  { snapshotRest: true, choice: "reconsider" },
  { snapshotRest: false, choice: "reconsider" },
] as const)(
  "applies the parent's $choice to a recovered setting (present in backup: $snapshotRest)",
  async ({ snapshotRest, choice }) => {
    const world = new World(previewContract);
    try {
      const server = world.server();
      const opts = { account: "alice", server: "s", transport: server.transport("alice") };
      const a = await world.phone("a", opts);
      a.store.put("workout", "w", workout("Push"));
      const setting = { workoutId: "w", seconds: 45 };
      if (snapshotRest) a.store.put("workout_rest", "w", setting);
      await a.sync();
      const backup = join(world.directory, "live.db");
      await server.snapshot("alice", backup);
      if (!snapshotRest) {
        a.store.put("workout_rest", "w", setting);
        await a.sync();
      }
      a.store.delete("workout", "w");
      await a.sync();
      const observer = await world.phone("observer", opts);
      await observer.sync();
      await server.restoreWithCommand("alice", backup);
      await observer.sync();
      expect(observer.store.get("workout", "w")?.status).toBe("conflict");
      if (snapshotRest) {
        expect(observer.store.problems().map((row) => row.kind)).toEqual(["workout"]);
        expect(() => observer.store.resolve("workout_rest", "w", { choice: "keep_mine" })).toThrow(
          /workout deletion/,
        );
      }
      if (choice === "reconsider") {
        observer.store.resolve("workout", "w", { choice: "keep_mine" });
        const writer = await world.phone("writer", opts);
        await writer.sync();
        writer.store.put("workout", "w", workout("Updated from second phone"));
        await writer.sync();
        await observer.sync();
        expect(observer.store.get("workout", "w")?.problem?.reason).toBe("stale");
        observer.store.resolve("workout", "w", { choice: "keep_theirs" });
      } else {
        observer.store.resolve("workout", "w", { choice });
      }
      await observer.restart();
      await observer.sync();
      expect(observer.store.hasUnsyncedWork()).toBe(false);
      expect((await server.row("alice", "workout", "w"))?.state).toBe(
        choice === "keep_mine" ? "deleted" : "live",
      );
      const rest = await server.row("alice", "workout_rest", "w");
      if (choice !== "keep_mine") {
        if (snapshotRest) expect(rest?.content).toEqual(setting);
        else expect(rest).toBeUndefined();
      } else expect(rest?.state).toBe("deleted");
    } finally {
      await world.dispose();
    }
  },
);

it("keeps an explicitly cleared rest and reply for review after a backup is restored through an older release", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const a = await world.phone("a", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    a.store.put("workout", "w", workout("Session"));
    const note = { workoutId: "w", kind: "session", text: "Seat height?", createdAt: STARTED };
    const reply = { text: "Try four", createdAt: ENDED };
    a.store.put("workout_note", "n", { ...note, reply });
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
    await a.sync();
    const backup = join(world.directory, "prior.db");
    await server.snapshot("alice", backup);
    a.store.put("workout_note", "n", { ...note, reply: null });
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: null });
    await a.sync();
    await server.restart({ releases: ["1.2"] });
    await server.restoreWithCommand("alice", backup);
    await a.sync();
    await a.restart();
    await server.restart({ releases: ["2.0"] });
    await a.sync();
    expect(a.store.get("workout_note", "n")).toMatchObject({
      status: "conflict",
      content: { reply: null },
      server: { content: { reply } },
    });
    expect(a.store.get("workout_rest", "w")).toMatchObject({
      status: "conflict",
      content: { seconds: null },
      server: { content: { seconds: 45 } },
    });
    a.store.resolve("workout_note", "n", { choice: "keep_mine" });
    a.store.resolve("workout_rest", "w", { choice: "keep_theirs" });
    await a.sync();
    expect((await server.row("alice", "workout_note", "n"))?.content?.reply).toBeNull();
    expect(a.store.get("workout_rest", "w")?.content?.seconds).toBe(45);
    expect(a.store.hasUnsyncedWork()).toBe(false);
  } finally {
    await world.dispose();
  }
});

async function checkDownloadedRestOwner(contract: Contract) {
  const world = new World();
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const a = await world.phone("a", { account: "alice", server: "s", transport });
    a.store.put("workout", "w", workout("Session"));
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
    await a.sync();
    const net = new FaultyTransport(transport);
    const b = await world.phone("b", {
      account: "alice",
      server: "s",
      transport: net.call,
      contract,
    });
    net.beforeReply = (path, response) => {
      if (path !== "/sync/pull") return;
      const rest = (response.body as { changes: { kind: string; id: string }[] }).changes.find(
        (r) => r.kind === "workout_rest",
      );
      if (rest) rest.id = "wrong";
    };
    const result = await b.sync();
    if (result.state !== "error") throw Error("Accepted rest under a different ID");
    expect(result.error).toBe("unreadable pull answer");
    expect(b.store.syncState().cursor).toBe(0);
    expect(b.store.get("workout_rest", "wrong")).toBeNull();
    net.beforeReply = null;
    await b.sync();
    expect(b.store.get("workout_rest", "w")?.content?.seconds).toBe(45);
  } finally {
    await world.dispose();
  }
}

it("rejects a page containing a rest under a different ID and detects a decoder that skips that check", async () => {
  await checkDownloadedRestOwner(leveContract);
  const checksContentOnly: Contract = {
    ...leveContract,
    decode: (kind, content, release) => leveContract.decode(kind, content, release),
  };
  await expect(checkDownloadedRestOwner(checksContentOnly)).rejects.toThrow(
    "Accepted rest under a different ID",
  );
});

it("refuses a conflicting rest reply whose content names another workout and retries on a valid reply", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const net = new FaultyTransport(transport);
    const a = await world.phone("a", { account: "alice", server: "s", transport: net.call });
    const b = await world.phone("b", { account: "alice", server: "s", transport });
    a.store.put("workout", "w", workout("Session"));
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 45 });
    await a.sync();
    await b.sync();
    b.store.put("workout_rest", "w", { workoutId: "w", seconds: 60 });
    await b.sync();
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 75 });
    net.beforeReply = (path, response) => {
      if (path !== "/sync/push") return;
      const first = (
        response.body as { results: { current?: { content: { workoutId: string } } }[] }
      ).results[0];
      if (first?.current) first.current.content.workoutId = "different";
    };
    expect(await a.sync()).toEqual({ state: "error", error: "unreadable record in push answer" });
    expect(a.store.get("workout_rest", "w")).toMatchObject({
      status: "pending",
      inFlight: true,
      content: { workoutId: "w", seconds: 75 },
    });
    net.beforeReply = null;
    await a.sync();
    expect(a.store.get("workout_rest", "w")).toMatchObject({
      status: "conflict",
      server: { content: { workoutId: "w", seconds: 60 } },
    });
  } finally {
    await world.dispose();
  }
});

it.each(
  ["empty", "live workout", "live workout with rest"].flatMap((snapshot) =>
    ["new", "cached", "edited", "local-only"].map((observer) => ({ snapshot, observer })),
  ),
)(
  "recovers a child-only deletion page with a $observer observer and a $snapshot backup",
  async ({ snapshot, observer }) => {
    const world = new World(previewContract);
    try {
      const server = world.server();
      const opts = { account: "alice", server: "s", transport: server.transport("alice") };
      const a = await world.phone("writer", opts);
      await a.sync();
      const w = workout("Push");
      const setting = { workoutId: "w", seconds: 30 };
      if (snapshot !== "empty") a.store.put("workout", "w", w);
      if (snapshot === "live workout with rest") a.store.put("workout_rest", "w", setting);
      await a.sync();
      const backup = join(world.directory, "before-deletion.db");
      await server.snapshot("alice", backup);
      if (snapshot === "empty") a.store.put("workout", "w", w);
      if (snapshot !== "live workout with rest") a.store.put("workout_rest", "w", setting);
      await a.sync();
      const net = new FaultyTransport(opts.transport);
      const b = await world.phone("observer", { ...opts, transport: net.call, pageSize: 1 });
      if (observer === "cached" || observer === "edited") await b.sync();
      a.store.delete("workout", "w");
      await a.sync();
      net.next("pass", "/sync/pull").next("offline", "/sync/pull");
      expect(await b.sync()).toMatchObject({ state: "offline" });
      expect(b.store.get("workout_rest", "w")?.deleted).toBe(true);
      if (observer === "new" || observer === "local-only")
        expect(b.store.get("workout", "w")).toBeNull();
      else expect(b.store.get("workout", "w")?.content?.title).toBe("Push");
      if (observer === "edited" || observer === "local-only")
        b.store.put("workout", "w", { ...w, title: "Local edit" });
      await server.restoreWithCommand("alice", backup);
      await b.restart();
      await b.sync();
      if (observer === "edited" || observer === "local-only") {
        expect(b.store.problems().map((row) => row.kind)).toEqual(["workout"]);
        expect(b.store.get("workout", "w")?.content?.title).toBe("Local edit");
        expect((await server.row("alice", "workout", "w"))?.content?.title).toBe(
          snapshot === "empty" ? undefined : "Push",
        );
        b.store.resolve("workout", "w", { choice: "keep_mine" });
        await b.sync();
        expect((await server.row("alice", "workout", "w"))?.content?.title).toBe("Local edit");
        expect(b.store.get("workout_rest", "w")?.content?.seconds).toBe(
          snapshot === "live workout with rest" ? 30 : undefined,
        );
      } else if (snapshot === "empty") {
        expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
        expect((await server.row("alice", "workout_rest", "w"))?.state).toBe("deleted");
      } else {
        expect(b.store.problems().map((row) => row.kind)).toEqual(["workout"]);
        expect((await server.row("alice", "workout", "w"))?.state).toBe("live");
        b.store.resolve("workout", "w", { choice: "keep_theirs" });
        await b.sync();
        expect(b.store.get("workout", "w")?.content?.title).toBe("Push");
        expect(b.store.get("workout_rest", "w")?.content?.seconds).toBe(
          snapshot === "live workout with rest" ? 30 : undefined,
        );
      }
      expect(b.store.hasUnsyncedWork()).toBe(false);
    } finally {
      await world.dispose();
    }
  },
);

it.each(["before", "after"])(
  "keeps a note deleted %s negotiating with an older server that cannot confirm its original upload",
  async (timing) => {
    const world = new World(previewContract);
    try {
      const server = world.server();
      const net = new FaultyTransport(server.transport("alice"));
      const phone = await world.phone("writer", {
        server: "s",
        account: "alice",
        transport: net.call,
      });
      phone.store.put("workout", "w", workout("Session"));
      await phone.sync();
      phone.store.put("workout_note", "n", {
        workoutId: "w",
        kind: "sticky",
        text: "Pin",
        createdAt: STARTED,
        reply: null,
      });
      net.next("lose_reply", "/sync/push");
      expect(await phone.sync()).toMatchObject({ state: "offline" });
      expect((await server.row("alice", "workout_note", "n"))?.state).toBe("live");
      if (timing === "before") phone.store.delete("workout_note", "n");
      await server.restart({ releases: ["1.2"] });
      await phone.sync();
      await phone.restart();
      if (timing === "after") phone.store.delete("workout_note", "n");
      phone.store.delete("workout_note", "n");
      expect(phone.store.get("workout_note", "n")?.deleted).toBe(true);
      expect(phone.store.hasUnsyncedWork()).toBe(true);
      await phone.restart();
      await server.restart({});
      await phone.sync();
      // A live version with no confirmed baseline is presented for an explicit decision.
      expect(phone.store.get("workout_note", "n")).toMatchObject({
        deleted: true,
        status: "conflict",
      });
      phone.store.resolve("workout_note", "n", { choice: "keep_mine" });
      await phone.sync();
      expect((await server.row("alice", "workout_note", "n"))?.state).toBe("deleted");
      expect(phone.store.hasUnsyncedWork()).toBe(false);
    } finally {
      await world.dispose();
    }
  },
);

it("keeps an unsynced note for explicit review when its cached workout's deletion download was interrupted", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const opts = { server: "s", account: "alice", transport: server.transport("alice") };
    const writer = await world.phone("writer", opts);
    await writer.sync();
    const emptyBackup = join(world.directory, "empty.db");
    await server.snapshot("alice", emptyBackup);
    writer.store.put("workout", "w", workout("Session"));
    writer.store.put("workout_rest", "w", { workoutId: "w", seconds: 30 });
    await writer.sync();
    const network = new FaultyTransport(opts.transport);
    const observer = await world.phone("observer", {
      ...opts,
      transport: network.call,
      pageSize: 1,
    });
    await observer.sync();
    writer.store.delete("workout", "w");
    await writer.sync();
    network.next("pass", "/sync/pull").next("offline", "/sync/pull");
    expect(await observer.sync()).toMatchObject({ state: "offline" });
    observer.store.put("workout_note", "n", {
      workoutId: "w",
      text: "My local note",
      kind: "session",
      createdAt: STARTED,
      reply: null,
    });
    await server.restoreWithCommand("alice", emptyBackup);
    await observer.restart();
    await observer.sync();
    expect(await server.row("alice", "workout", "w")).toBeUndefined();
    expect(await server.row("alice", "workout_note", "n")).toBeUndefined();
    expect(observer.store.get("workout_note", "n")).toMatchObject({
      status: "conflict",
      content: { text: "My local note" },
    });
    expect(observer.store.get("workout", "w")?.status).toBe("conflict");
    observer.store.resolve("workout", "w", { choice: "keep_mine" });
    observer.store.resolve("workout_note", "n", { choice: "keep_mine" });
    await observer.sync();
    expect((await server.row("alice", "workout_note", "n"))?.content?.text).toBe("My local note");
    expect(observer.store.hasUnsyncedWork()).toBe(false);
  } finally {
    await world.dispose();
  }
});

it("preserves an explicit note deletion while reconciling its workout's interrupted deletion", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const opts = { server: "s", account: "alice", transport: server.transport("alice") };
    const writer = await world.phone("a", opts);
    const w = workout("Session");
    writer.store.put("workout", "w", w);
    writer.store.put("workout_rest", "w", { workoutId: "w", seconds: 30 });
    await writer.sync();
    writer.store.put("workout_note", "n", {
      workoutId: "w",
      text: "Retired cue",
      kind: "sticky",
      createdAt: STARTED,
      reply: null,
    });
    await writer.sync();
    const backup = join(world.directory, "with-note.db");
    await server.snapshot("alice", backup);
    const net = new FaultyTransport(opts.transport);
    const observer = await world.phone("b", { ...opts, transport: net.call, pageSize: 1 });
    await observer.sync();
    writer.store.delete("workout", "w");
    await writer.sync();
    net.next("pass", "/sync/pull").next("offline", "/sync/pull");
    expect(await observer.sync()).toMatchObject({ state: "offline" });
    expect(observer.store.get("workout_rest", "w")?.deleted).toBe(true);
    observer.store.delete("workout_note", "n");
    observer.store.put("workout", "w", { ...w, title: "Local" });
    await server.restoreWithCommand("alice", backup);
    await observer.restart();
    await observer.sync();
    expect(observer.store.get("workout_note", "n")).toMatchObject({
      deleted: true,
      status: "conflict",
    });
    observer.store.resolve("workout", "w", { choice: "keep_mine" });
    observer.store.resolve("workout_note", "n", { choice: "keep_mine" });
    await observer.sync();
    expect((await server.row("alice", "workout_note", "n"))?.state).toBe("deleted");
    expect(observer.store.hasUnsyncedWork()).toBe(false);
  } finally {
    await world.dispose();
  }
});
