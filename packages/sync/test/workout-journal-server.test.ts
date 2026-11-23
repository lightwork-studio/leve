import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonBytes } from "@leve/contract";
import { ServerTransaction } from "@leve/storage/server";
import { expect, it, vi } from "vitest";
import { HistoricalPeer, loadContract } from "../../contract/history/1.0/peer.ts";
import {
  previewContract,
  previewContractThrough,
  previewFrozen,
} from "../../contract/test/support/preview-contract.ts";
import { maximumWorkout } from "../../storage/src/test-support/max-workout.ts";
import { ENDED, HISTORY, STARTED, workout } from "./support/content.ts";
import { World } from "./support/harness.ts";

it("keeps server-only note and rest records out of a release-1.2 phone’s offline database", async () => {
  const world = new World(previewContract);
  try {
    const phone = await world.phone("offline", {
      contract: previewContractThrough("1.2"),
      releases: ["1.2"],
      server: "s",
      account: "alice",
      transport: world.server().transport("alice"),
    });
    phone.store.put("workout", "w", workout("Leg day"));
    expect(phone.client.featureAvailable("reps_in_reserve")).toBe(true);
    expect(phone.client.featureAvailable("workout_journal")).toBe(false);
    expect(phone.client.featureAvailable("workout_rest")).toBe(false);
    const before = phone.store.summary();
    expect(() =>
      phone.store.put("workout_note", "journal", {
        workoutId: "w",
        kind: "sticky",
        text: "Adjust the seat",
        createdAt: STARTED,
        reply: null,
      }),
    ).toThrow(/unknown record kind/);
    expect(() => phone.store.put("workout_rest", "w", { workoutId: "w", seconds: 60 })).toThrow(
      /unknown record kind/,
    );
    await phone.restart();
    expect(phone.store.summary()).toEqual(before);
    expect(phone.store.get("workout_note", "journal")).toBeNull();
    expect(phone.store.get("workout_rest", "w")).toBeNull();
    expect(phone.store.get("workout", "w")?.content?.title).toBe("Leg day");
  } finally {
    await world.dispose();
  }
});

it("preserves notes, replies and workout rest when a 1.2 phone edits the session", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const writer = new HistoricalPeer(previewFrozen("2.0"), transport);
    await writer.hello();
    const original = maximumWorkout();
    expect(jsonBytes(original)).toBe(200_000);
    const note = {
      workoutId: "w",
      kind: "sticky",
      text: "Use rack 3",
      createdAt: STARTED,
      reply: { text: "Try six reps", createdAt: ENDED },
    };
    const rest = { workoutId: "w", seconds: 75 };
    const initial = await writer.push([
      writer.put("workout", "w", original),
      writer.put("workout_note", "cue", note),
      writer.put("workout_rest", "w", rest),
    ]);
    expect(initial.results).toMatchObject([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);
    const phone = await world.phone("installed", {
      server: "s",
      account: "alice",
      transport,
      releases: ["1.2"],
    });
    await phone.sync();
    expect(phone.store.get("workout", "w")?.content).toEqual(original);
    expect(phone.store.get("workout_note", "cue")).toBeNull();
    phone.store.put("workout", "w", { ...original, title: "Short" });
    await phone.sync();
    expect((await server.row("alice", "workout", "w"))?.content).toEqual({
      ...original,
      title: "Short",
    });
    expect((await server.row("alice", "workout_note", "cue"))?.content).toEqual(note);
    expect((await server.row("alice", "workout_rest", "w"))?.content).toEqual(rest);
    expect(
      (await writer.push([writer.put("workout_rest", "another", rest)])).results,
    ).toMatchObject([{ status: "invalid", code: "invalid_content" }]);
  } finally {
    await world.dispose();
  }
});

async function checkHiddenWorkoutChildren(filterHiddenChildren: boolean) {
  const world = new World(previewContract);
  const children = ServerTransaction.prototype.liveChildren;
  const spy = vi.spyOn(ServerTransaction.prototype, "liveChildren");
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const current = new HistoricalPeer(previewFrozen("2.0"), transport);
    const old = new HistoricalPeer(previewFrozen("1.2"), transport);
    await current.hello();
    await old.hello();
    const note = {
      workoutId: "w",
      kind: "session",
      text: "Adjust the seat",
      createdAt: STARTED,
      reply: { text: "Use the low setting", createdAt: ENDED },
    };
    const rest = { workoutId: "w", seconds: 60 };
    await current.push([
      current.put("workout", "w", workout("Legs", { initialPlan: null })),
      current.put("workout_note", "cue", note),
      current.put("workout_rest", "w", rest),
    ]);
    await current.pull();
    await old.pull();
    const unseen = old.delete("workout", "w");
    expect(unseen.descendants).toEqual([]);
    if (filterHiddenChildren) {
      // Broken server compares only children that the deleting peer understands.
      spy.mockImplementationOnce(function (this: ServerTransaction, kind, id) {
        return children
          .call(this, kind, id)
          .filter((child) => previewContract.hasKind(child.kind, "1.2"));
      });
    }
    const response = await old.push([unseen]);
    if (Array.isArray(response.results) && response.results[0]?.status === "accepted")
      throw Error("Deleted unseen workout children");
    expect(response.results).toMatchObject([{ status: "conflict", reason: "stale" }]);
    expect((await server.row("alice", "workout", "w"))?.state).toBe("live");
    expect((await server.row("alice", "workout_note", "cue"))?.content).toEqual(note);
    expect((await server.row("alice", "workout_rest", "w"))?.content).toEqual(rest);

    const stale = current.delete("workout", "w");
    await current.push([current.put("workout_rest", "w", { ...rest, seconds: 90 })]);
    expect((await current.push([stale])).results).toMatchObject([
      { status: "conflict", reason: "stale" },
    ]);
    expect((await server.row("alice", "workout_note", "cue"))?.content).toEqual(note);
    await current.pull();
    expect((await current.push([current.delete("workout", "w")])).results).toMatchObject([
      { status: "accepted" },
    ]);
    expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_note", "cue"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_rest", "w"))?.state).toBe("deleted");
  } finally {
    spy.mockRestore();
    await world.dispose();
  }
}

it("protects workout children an older peer cannot see and cascades a current deletion", async () => {
  await checkHiddenWorkoutChildren(false);
});
it("detects a server that ignores children outside the deleting release", async () => {
  await expect(checkHiddenWorkoutChildren(true)).rejects.toThrow("Deleted unseen workout children");
});

it("allows tombstone recovery only under the deleted owner in the authenticated account", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const author = async (account: string) => {
      const transport = server.transport(account);
      const peer = new HistoricalPeer(previewFrozen("2.0"), transport);
      await peer.hello();
      await peer.push([peer.put("workout", "shared", workout(account, { initialPlan: null }))]);
      await peer.pull();
      return peer;
    };
    const alice = await author("alice");
    const bob = await author("bob");
    const marker = {
      submissionId: "recover-rest",
      op: "delete" as const,
      kind: "workout_rest",
      id: "shared",
      baseRevision: null,
      descendants: [],
    };
    await alice.push([alice.delete("workout", "shared")]);
    expect(await alice.push([marker])).toMatchObject({
      results: [{ status: "accepted" }],
    });
    expect(await bob.push([marker])).toMatchObject({
      results: [{ status: "invalid", code: "not_deletable" }],
    });
    expect((await server.row("alice", "workout_rest", "shared"))?.state).toBe("deleted");
    expect(await server.row("bob", "workout_rest", "shared")).toBeUndefined();
    expect((await server.row("bob", "workout", "shared"))?.state).toBe("live");
  } finally {
    await world.dispose();
  }
});

it("recovers a rest deletion delivered before its missing workout marker", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const peer = new HistoricalPeer(previewFrozen("2.0"), server.transport("alice"));
    await peer.hello();
    const rest = {
      op: "delete",
      kind: "workout_rest",
      id: "w",
      baseRevision: null,
      descendants: [],
      submissionId: "rest",
    };
    const owner = { ...rest, kind: "workout", submissionId: "owner" };
    expect((await peer.push([rest, owner])).results).toEqual([
      { submissionId: "rest", status: "retry_later", reason: "parent_missing" },
      { submissionId: "owner", status: "accepted", revision: 1 },
    ]);
    expect(await server.row("alice", "workout_rest", "w")).toBeUndefined();
    const answer = { submissionId: "rest", status: "accepted", revision: 2 };
    expect((await peer.push([rest])).results).toEqual([answer]);
    expect((await peer.push([rest])).results).toEqual([answer]);
    expect(await server.head("alice")).toBe(2);
    expect((await server.row("alice", "workout_rest", "w"))?.state).toBe("deleted");
    const backup = join(world.directory, "after-parent-deletion.db");
    await server.snapshot("alice", backup);
    await server.restoreWithCommand("alice", backup);
    expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
    expect((await server.row("alice", "workout_rest", "w"))?.state).toBe("deleted");
  } finally {
    await world.dispose();
  }
});

it("rejects direct writes and reads before accessing an account on a disabled release", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server({ releases: ["1.2"] });
    const writes = [
      {
        op: "put" as const,
        kind: "workout",
        id: "w",
        baseRevision: null,
        submissionId: "w",
        content: workout("Session"),
      },
      {
        op: "put" as const,
        kind: "workout_rest",
        id: "w",
        baseRevision: null,
        submissionId: "r",
        content: { workoutId: "w", seconds: 60 },
      },
    ];
    await expect(server.service.submit("alice", "2.0", writes)).rejects.toThrow(/release/i);
    expect(await server.row("alice", "workout", "w")).toBeUndefined();
    await expect(server.service.read("alice", "workout_rest", "w", "2.0")).rejects.toThrow(
      /release/i,
    );
    expect(await server.service.read("alice", "workout_rest", "w", "1.2")).toBeNull();
  } finally {
    await world.dispose();
  }
});

it("replays the frozen first upload against current storage", async () => {
  const world = new World();
  try {
    const server = world.server();
    const wire = JSON.parse(
      readFileSync(new URL("../../contract/frozen/1.0/examples.json", import.meta.url), "utf8"),
    );
    const peer = new HistoricalPeer(
      loadContract(new URL("1.0/", HISTORY)),
      server.transport("alice"),
    );
    const { lineage } = await peer.hello();
    const reply = await server.service.push("alice", { ...wire.pushRequest, lineage });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(wire.pushResponse);
    // The frozen example writes ten records and one update, then deletes a parent.
    expect(reply.writtenRevisions).toBe("111111111110");
  } finally {
    await world.dispose();
  }
});

it("updates a live workout rest preference to off or inherited and refuses direct deletion", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const peer = new HistoricalPeer(previewFrozen("2.0"), server.transport("alice"));
    await peer.hello();
    const rest = { workoutId: "w", seconds: 75 };
    await peer.push([
      peer.put("workout", "w", workout("Legs", { initialPlan: null })),
      peer.put("workout_rest", "w", rest),
    ]);
    await peer.pull();
    const deletion = peer.delete("workout_rest", "w");
    expect(deletion.baseRevision).toBe(2);
    expect((await peer.push([deletion])).results).toMatchObject([
      { status: "invalid", code: "not_deletable" },
    ]);
    expect(await server.head("alice")).toBe(2);
    expect(await server.row("alice", "workout_rest", "w")).toMatchObject({
      state: "live",
      revision: 2,
      content: rest,
    });
    expect(await peer.pull()).toEqual([]);
    for (const [seconds, revision] of [
      [0, 3],
      [null, 4],
    ] as const) {
      const content = { workoutId: "w", seconds };
      expect((await peer.push([peer.put("workout_rest", "w", content)])).results).toMatchObject([
        { status: "accepted", revision },
      ]);
      expect(await peer.pull()).toMatchObject([
        { kind: "workout_rest", id: "w", state: "live", revision, content },
      ]);
    }
  } finally {
    await world.dispose();
  }
});
