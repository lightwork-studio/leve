import type { ReleaseId } from "@leve/contract";
import { openDeviceStore } from "@leve/storage";
import { afterEach, expect, it } from "vitest";
import { previewContract } from "../../contract/test/support/preview-contract.ts";
import { release10 } from "../../storage/src/test-support/versions.ts";
import { entry, set, workout } from "./support/content.ts";
import { expectSynced, FaultyTransport, World } from "./support/harness.ts";

let world: World;
afterEach(async () => world.dispose());

const firstTarget = { exercise: 0, set: 0 };
const otherTarget = { exercise: 0, set: 1 };

async function pair() {
  world = new World(previewContract);
  const server = world.server({ releases: ["1.0", "1.1"] });
  const transport = server.transport("alice");
  const net = new FaultyTransport(transport);
  const options = { server: "s", account: "alice", transport };
  const a = await world.phone("a", { ...options, transport: net.call });
  const b = await world.phone("b", options);
  a.store.put("workout", "w", workout("Push"));
  a.store.put("workout_exercise", "e", entry("w", "Press"));
  a.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
  await a.sync();
  await b.sync();
  return { server, a, b, net };
}

it("adopts another device's change to a hidden field when only a visible field was edited", async () => {
  const { server, a, b } = await pair();
  b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
  await a.sync();
  expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
    reps: 9,
    planSlot: otherTarget,
  });
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { reps: 9, planSlot: otherTarget },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(otherTarget);
});

it("keeps a competing hidden edit for conflict review after equal visible fields were accepted", async () => {
  const { server, a, b } = await pair();
  a.store.put("workout_set", "s", set("e", { planSlot: null }));
  b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "conflict",
    content: { planSlot: null },
    server: { content: { planSlot: otherTarget } },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(otherTarget);
});

it.each(["pending", "in flight"])(
  "preserves both versions when an edit is %s at the richer download",
  async (stage) => {
    const { server, a, b } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: null }));
    if (stage === "in flight") expect(a.store.prepareSubmissions("1.0")).toHaveLength(1);
    await a.restart();
    await server.restart({ releases: ["1.1", "1.0"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { planSlot: null },
      server: { content: { planSlot: otherTarget } },
    });
    a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      content: { planSlot: otherTarget },
    });
  },
);

it.each(["keep_theirs", "keep_mine"] as const)(
  "honors %s when a richer pull reveals a conflict before a legacy receipt is replayed",
  async (choice) => {
    const { a, b, server, net } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: null }));
    net.next("lose_reply", "/sync/push");
    await a.sync();
    await server.restart({ releases: ["1.1", "1.0"] });
    await a.client.waitForChanges(0);
    expect(a.store.get("workout_set", "s")).toMatchObject({ status: "conflict", inFlight: true });
    a.store.resolve("workout_set", "s", { choice });
    await a.restart();
    await a.sync();
    const expected = choice === "keep_mine" ? null : otherTarget;
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      inFlight: false,
      content: { planSlot: expected },
    });
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(expected);
  },
);

it.each([true, false])(
  "keeps a clear typed after a lost legacy create (legacy release still supported: %s)",
  async (legacySupported) => {
    world = new World(previewContract);
    const server = world.server({ releases: ["1.0"] });
    const transport = server.transport("alice");
    const net = new FaultyTransport(transport);
    const a = await world.phone("a", { server: "s", account: "alice", transport: net.call });
    a.store.put("workout", "w", workout("Push"));
    a.store.put("workout_exercise", "e", entry("w", "Press"));
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
    net.next("lose_reply", "/sync/push");
    await a.sync();
    expect(a.store.get("workout_set", "s")?.inFlight).toBe(true);
    a.store.put("workout_set", "s", set("e", { planSlot: null }));
    await a.restart();
    await server.restart({ releases: legacySupported ? ["1.0", "1.1"] : ["1.1"] });
    const b = await world.phone("b", { server: "s", account: "alice", transport });
    await b.sync();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { planSlot: null },
      server: { content: { planSlot: otherTarget } },
    });
    a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    await a.sync();
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toBeNull();
  },
);

it("retires a confirmed field marker when the lifter edits only reps before receipt replay", async () => {
  world = new World(previewContract);
  const server = world.server({ releases: ["1.0"] });
  const transport = server.transport("alice");
  const net = new FaultyTransport(transport);
  const a = await world.phone("a", { server: "s", account: "alice", transport: net.call });
  a.store.put("workout", "w", workout("Push"));
  a.store.put("workout_exercise", "e", entry("w", "Press"));
  a.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
  await a.sync();
  await server.restart({ releases: ["1.0", "1.1"] });
  net.next("lose_reply", "/sync/push");
  await a.sync();
  expect(a.store.get("workout_set", "s")?.inFlight).toBe(true);
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
  await a.restart({ releases: ["1.0"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    partialFields: [],
    content: { reps: 9 },
  });
  const b = await world.phone("b", { server: "s", account: "alice", transport });
  await b.sync();
  b.store.put("workout_set", "s", set("e", { reps: 9, planSlot: otherTarget }));
  await b.sync();
  await a.restart({ releases: ["1.0", "1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { reps: 9, planSlot: otherTarget },
  });
});

it.each([true, false])(
  "keeps chosen measurements when a legacy envelope reaches the server after resolution (confirmed: %s)",
  async (confirmed) => {
    const { a, b, server, net } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: null }));
    net.next("offline", "/sync/push");
    await a.sync();
    await server.restart({ releases: ["1.1", "1.0"] });
    await a.client.waitForChanges(0);
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      inFlight: true,
      server: { content: { reps: 5, planSlot: otherTarget } },
    });
    a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
    await a.restart({
      transport: async (path, body) => {
        const response = await net.call(path, body);
        return confirmed ? response : { status: response.status, body: response.body };
      },
    });
    await a.sync();
    if (!confirmed) {
      // Protocol 1.0 also accepts a concurrent writer's equal visible measurements.
      // The choice persists, but applying it over a newer ambiguous receipt needs review.
      expect(a.store.get("workout_set", "s")).toMatchObject({
        status: "conflict",
        content: { reps: 5, planSlot: otherTarget },
        server: { content: { reps: 9, planSlot: otherTarget } },
      });
      a.store.resolve("workout_set", "s", { choice: "keep_mine" });
      await a.sync();
    }
    expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
      reps: 5,
      planSlot: otherTarget,
    });
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      content: { reps: 5, planSlot: otherTarget },
    });
  },
);

it.each(["accept before other edit", "reject after other edit"])(
  "honors Keep mine against a newer revision after a lost receipt (%s)",
  async (order) => {
    const { a, b, server, net } = await pair();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: null }));
    const editB = async () => {
      await server.restart({ releases: ["1.1", "1.0"] });
      await b.sync();
      b.store.put("workout_set", "s", set("e", { reps: 10, planSlot: otherTarget }));
      await b.sync();
      await server.restart({ releases: ["1.0"] });
    };
    if (order === "reject after other edit") await editB();
    net.next("lose_reply", "/sync/push");
    await a.sync();
    if (order === "accept before other edit") await editB();
    await server.restart({ releases: ["1.0", "1.1"] });
    await a.client.waitForChanges(0);
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      inFlight: true,
      server: { content: { reps: 10, planSlot: otherTarget } },
    });
    a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    await a.restart();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      content: { reps: 9, planSlot: null },
    });
    expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
      reps: 9,
      planSlot: null,
    });
  },
);

it.each([null, firstTarget])(
  "keeps a subsequent edit when an accepted richer envelope is abandoned (original %j)",
  async (original) => {
    const { a, server, net } = await pair();
    a.store.put("workout_set", "s", set("e", { planSlot: original }));
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    net.next("lose_reply", "/sync/push");
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: original }));
    await a.restart();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "partial",
      partialFields: ["planSlot"],
    });
    // A second edit to a visible field must keep the local value withheld.
    a.store.put("workout_set", "s", set("e", { reps: 12, planSlot: original }));
    await a.restart();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "partial",
      partialFields: ["planSlot"],
      content: { reps: 12, planSlot: original },
    });
    expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
      reps: 12,
      planSlot: otherTarget,
    });
    await server.restart({ releases: ["1.1"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { reps: 12, planSlot: original },
      server: { content: { reps: 12, planSlot: otherTarget } },
    });
    a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    await a.sync();
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(original);
  },
);

async function checkOfflineClear(forgetHiddenEdit = false) {
  const { server } = await pair();
  await server.restart({ releases: ["1.0"] });
  const net = new FaultyTransport(server.transport("alice"));
  const c = await world.phone("legacy", {
    server: "s",
    account: "alice",
    transport: net.call,
    openStore: async (options) => {
      const store = await openDeviceStore(options);
      if (forgetHiddenEdit) {
        const put = store.put.bind(store);
        store.put = (kind, id, content) => {
          const saved = put(kind, id, content);
          store.db.run("UPDATE records SET partial_fields = '[]' WHERE kind = ? AND id = ?", [
            kind,
            id,
          ]);
          return saved;
        };
      }
      return store;
    },
  });
  await c.sync();
  await server.restart({ releases: ["1.1"] });
  net.next("offline", "/sync/pull");
  await c.sync();
  expect(c.store.syncState()).toMatchObject({ release: "1.1", refreshFrom: "1.0" });
  c.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  c.store.put("workout_set", "s", set("e", { planSlot: null }));
  await c.restart();
  await c.sync();
  expect(
    c.store.get("workout_set", "s"),
    "the offline clear must survive the first richer download",
  ).toMatchObject({
    status: "conflict",
    content: { planSlot: null },
    server: { content: { planSlot: firstTarget } },
  });
  c.store.resolve("workout_set", "s", { choice: "keep_mine" });
  await c.sync();
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toBeNull();
}

it("keeps a clear saved offline after negotiation but before the first richer download", () =>
  checkOfflineClear());
it("detects a device that forgets local field edits before the first richer download", async () => {
  await expect(checkOfflineClear(true)).rejects.toThrow(/the offline clear must survive/);
});

it.each([9, 12])(
  "offers both versions when a third edit of %i reps reaches the server after an in-flight conflict choice",
  async (reps) => {
    const { a, b, server, net } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: null }));
    net.next("offline", "/sync/push");
    await a.sync();
    await server.restart({ releases: ["1.0", "1.1"] });
    await a.client.waitForChanges(0);
    a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
    b.store.put("workout_set", "s", set("e", { reps, planSlot: otherTarget }));
    await b.sync();
    await a.restart();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { reps: 5, planSlot: otherTarget },
      server: { content: { reps, planSlot: otherTarget } },
    });
    expect((await server.row("alice", "workout_set", "s"))?.content?.reps).toBe(reps);
  },
);

it("adopts the set target when a genuinely older phone edits only reps across its first upgrade", async () => {
  const { server } = await pair();
  const old = await world.phone("old", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
    contract: release10,
    releases: ["1.0"],
  });
  await old.sync();
  old.store.put("workout_set", "s", set("e", { reps: 8 }));
  expect(old.store.get("workout_set", "s")?.content).not.toHaveProperty("planSlot");
  await old.restart({ contract: previewContract, releases: ["1.0", "1.1"] });
  old.store.put("workout_set", "s", set("e", { reps: 9 }));
  await old.sync();
  expect(old.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { reps: 9, planSlot: firstTarget },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
    reps: 9,
    planSlot: firstTarget,
  });
});

it("preserves competing richer fields when two phones create the same set ID", async () => {
  const { a, b, server, net } = await pair();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "shared", set("e", { planSlot: firstTarget }));
  net.next("offline", "/sync/push");
  await a.sync();
  expect(a.store.get("workout_set", "shared")).toMatchObject({ inFlight: true, server: null });
  await server.restart({ releases: ["1.1", "1.0"] });
  b.store.put("workout_set", "shared", set("e", { planSlot: otherTarget }));
  await b.sync();
  await a.restart();
  await a.sync();
  expect(a.store.get("workout_set", "shared")).toMatchObject({
    status: "conflict",
    content: { planSlot: firstTarget },
    server: { content: { planSlot: otherTarget } },
  });
  expect((await server.row("alice", "workout_set", "shared"))?.content?.planSlot).toEqual(
    otherTarget,
  );
});

it("retires a discarded hidden field when a conflict choice is replayed through a legacy connection", async () => {
  const { a, b, server, net } = await pair();
  b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: null }));
  net.next("offline", "/sync/push");
  await a.sync();
  await server.restart({ releases: ["1.1", "1.0"] });
  await a.client.waitForChanges(0);
  a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
  await server.restart({ releases: ["1.0"] });
  await a.restart({
    transport: async (path, body) => {
      const { status, body: reply } = await net.call(path, body);
      return { status, body: reply };
    },
  });
  await a.sync();
  // The old reply cannot identify the writer of the later revision. Retain
  // the chosen 5 reps until the lifter confirms them against the actual 9.
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "conflict",
    partialFields: [],
    content: { reps: 5, planSlot: otherTarget },
  });
  a.store.resolve("workout_set", "s", { choice: "keep_mine" });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({ status: "synced", partialFields: [] });
  await server.restart({ releases: ["1.1"] });
  await b.sync();
  b.store.put("workout_set", "s", set("e", { reps: 5, planSlot: { exercise: 1, set: 1 } }));
  await b.sync();
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { reps: 5, planSlot: { exercise: 1, set: 1 } },
  });
});

it.each([
  "legacy partial",
  "legacy envelope",
  "legacy envelope with later reps",
  "legacy receipt after later reps",
])(
  "retains both routine targets when an older app left ambiguous edit evidence (%s)",
  async (stage) => {
    const { a, b, server } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    await server.restart({ releases: ["1.0"] });
    await a.sync();
    a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
    const [out] = a.store.prepareSubmissions("1.0");
    if (!out) throw Error("Missing legacy submission");
    // Older apps recorded every non-null field left off a projection, including
    // cached fields and an intentional return to a value seen on this device.
    a.store.db.run("UPDATE submissions SET omitted = ? WHERE submission_id = ?", [
      JSON.stringify(["planSlot"]),
      out.submission.submissionId,
    ]);
    if (stage === "legacy partial") {
      await a.sync();
      expect(a.store.get("workout_set", "s")).toMatchObject({
        status: "partial",
        partialFields: ["planSlot"],
      });
    }
    const laterReps = stage.includes("later reps");
    if (laterReps) {
      a.store.put("workout_set", "s", set("e", { reps: 11, planSlot: firstTarget }));
    }
    if (stage === "legacy receipt after later reps") await a.sync();
    await a.restart();
    await server.restart({ releases: ["1.0", "1.1"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: {
        reps: laterReps ? 11 : 9,
        planSlot: firstTarget,
      },
      server: { content: { planSlot: otherTarget } },
    });
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(otherTarget);
    a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      content: { planSlot: otherTarget },
    });
  },
);

it("preserves a newer writer’s measurements when the target was edited only after the old envelope was stored", async () => {
  const { a, b, server, net } = await pair();
  b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
  net.next("offline", "/sync/push");
  await a.sync();
  expect(a.store.db.get("SELECT omitted FROM submissions WHERE id = 's'")?.omitted).toBe("[]");
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: null }));
  await server.restart({ releases: ["1.0", "1.1"] });
  await a.client.waitForChanges(0);
  a.store.resolve("workout_set", "s", { choice: "keep_theirs" });
  b.store.put("workout_set", "s", set("e", { reps: 9, planSlot: otherTarget }));
  await b.sync();
  await a.restart();
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "conflict",
    content: { reps: 5, planSlot: otherTarget },
    server: { content: { reps: 9, planSlot: otherTarget } },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.reps).toBe(9);
});

it("does not replace an explicit remote clear with a target edited from a legacy download", async () => {
  const { b, server } = await pair();
  await server.restart({ releases: ["1.0"] });
  const old = await world.phone("older-projection", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
  });
  await old.sync();
  old.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  await server.restart({ releases: ["1.1"] });
  b.store.put("workout_set", "s", set("e", { planSlot: null }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await old.sync();
  await old.restart();
  await server.restart({ releases: ["1.0", "1.1"] });
  await old.sync();
  expect(old.store.get("workout_set", "s")).toMatchObject({
    status: "conflict",
    content: { planSlot: otherTarget },
    server: { content: { planSlot: null } },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toBeNull();
});

it("keeps a correction that restored the old target after a richer upload lost its receipt", async () => {
  const { a, b, server, net } = await pair();
  a.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  net.next("lose_reply", "/sync/push");
  await a.sync();
  await b.sync();
  b.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.0", "1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "conflict",
    content: { planSlot: otherTarget },
    server: { content: { planSlot: firstTarget } },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(firstTarget);
});

it("uploads the confirmed set choice after another trip through a connection that hides targets", async () => {
  const { a, b, server, net } = await pair();
  a.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
  net.next("lose_reply", "/sync/push");
  await a.sync();
  await b.sync();
  b.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")?.status).toBe("conflict");
  a.store.resolve("workout_set", "s", { choice: "keep_mine" });
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { planSlot: otherTarget },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(otherTarget);
});

it("replays an ordinary edit made behind an outstanding older upload without asking for a choice", async () => {
  const { a, net, server } = await pair();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
  net.next("lose_reply", "/sync/push");
  await a.sync();
  a.store.put("workout_set", "s", set("e", { reps: 10, planSlot: firstTarget }));
  await a.restart();
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "synced",
    content: { reps: 10, planSlot: firstTarget },
  });
  expect((await server.row("alice", "workout_set", "s"))?.content?.reps).toBe(10);
});

it("retains an explicit clear when another phone creates the same set before the legacy create is acknowledged", async () => {
  const { a, b, server } = await pair();
  b.store.put("workout_set", "shared", set("e", { planSlot: firstTarget }));
  await b.sync();
  b.store.put("workout_set", "shared", set("e", { planSlot: null }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  a.store.put("workout_set", "shared", set("e", { planSlot: otherTarget }));
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "shared")).toMatchObject({
    status: "conflict",
    content: { planSlot: otherTarget },
    server: { content: { planSlot: null } },
  });
  expect((await server.row("alice", "workout_set", "shared"))?.content?.planSlot).toBeNull();
});

it("preserves a remote clear after the original phone resaves its partial set through an older server", async () => {
  const { a, b, server } = await pair();
  await server.restart({ releases: ["1.0"] });
  await a.sync();
  a.store.put("workout_set", "new-set", set("e", { planSlot: otherTarget }));
  await a.sync();
  expect(a.store.get("workout_set", "new-set")?.status).toBe("partial");
  await server.restart({ releases: ["1.1"] });
  await b.sync();
  b.store.put("workout_set", "new-set", set("e", { planSlot: firstTarget }));
  await b.sync();
  b.store.put("workout_set", "new-set", set("e", { planSlot: null }));
  await b.sync();
  await server.restart({ releases: ["1.0"] });
  a.store.put("workout_set", "new-set", set("e", { planSlot: otherTarget }));
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "new-set")).toMatchObject({
    status: "conflict",
    content: { planSlot: otherTarget },
    server: { content: { planSlot: null } },
  });
  expect((await server.row("alice", "workout_set", "new-set"))?.content?.planSlot).toBeNull();
});

it.each(["absent", "wrong length", "invalid characters"])(
  "keeps a differing target for review when legacy receipt provenance is %s",
  async (header) => {
    const { server } = await pair();
    await server.restart({ releases: ["1.0"] });
    const transport = server.transport("alice");
    const phone = await world.phone("unconfirmed", {
      server: "s",
      account: "alice",
      transport: async (path, body) => {
        const { status, body: response } = await transport(path, body);
        return header === "absent"
          ? { status, body: response }
          : { status, body: response, writtenRevisions: header === "wrong length" ? "11" : "x" };
      },
    });
    await phone.sync();
    phone.store.put("workout_set", "local", set("e", { planSlot: otherTarget }));
    await phone.sync();
    expect(phone.store.get("workout_set", "local")?.status).toBe("partial");
    await phone.restart();
    await server.restart({ releases: ["1.1"] });
    await phone.sync();
    expect(phone.store.get("workout_set", "local")).toMatchObject({
      status: "conflict",
      content: { planSlot: otherTarget },
      server: { content: { planSlot: null } },
    });
    expect((await server.row("alice", "workout_set", "local"))?.content?.planSlot).toBeNull();
  },
);

it("compares targets from the oldest queued release before sending newer fields", async () => {
  const { a, b, server, net } = await pair();
  a.store.put("workout_set", "t", set("e", { planSlot: firstTarget }));
  await a.sync();
  await b.sync();
  a.store.put("workout_set", "s", set("e", { reps: 9, planSlot: firstTarget }));
  net.next("offline", "/sync/push");
  await a.sync();
  a.store.put("workout_set", "t", set("e", { planSlot: otherTarget }));
  await a.restart({ releases: ["1.0"] });
  net.next("offline", "/sync/push");
  await a.sync();
  expect(a.store.db.all("SELECT id,release FROM submissions ORDER BY id")).toEqual([
    { id: "s", release: "1.1" },
    { id: "t", release: "1.0" },
  ]);
  await server.restart({ releases: ["1.0", "1.1", "1.2"] });
  await a.restart({ releases: ["1.0", "1.1", "1.2"] });
  const competing = { exercise: 0, set: 2 };
  net.beforeReply = async (path) => {
    if (path !== "/sync/pull") return;
    net.beforeReply = null;
    b.store.put("workout_set", "t", set("e", { planSlot: competing }));
    await b.sync();
  };
  await a.sync();
  expect(a.store.get("workout_set", "t")).toMatchObject({
    status: "conflict",
    content: { planSlot: otherTarget },
    server: { content: { planSlot: competing } },
  });
  expect((await server.row("alice", "workout_set", "t"))?.content?.planSlot).toEqual(competing);
});

it("keeps a second phone's set correction across an upgrade with an offline workout deletion", async () => {
  world = new World(previewContract);
  const server = world.server({ releases: ["1.0"] });
  const a = await world.phone("a", {
    account: "alice",
    server: "s",
    transport: server.transport("alice"),
  });
  const b = await world.phone("b", {
    account: "alice",
    server: "s",
    transport: server.transport("alice"),
  });
  a.store.put("workout", "w", workout("Workout"));
  a.store.put("workout_exercise", "e", entry("w", "Bench"));
  a.store.put("workout_set", "s", set("e"));
  expectSynced(await a.sync());
  expectSynced(await b.sync());
  a.store.delete("workout", "w");
  b.store.put("workout_set", "s", set("e", { reps: 12 }));
  expectSynced(await b.sync());
  await server.restart({ releases: ["1.0", "2.0"] });
  expectSynced(await a.sync());
  expect(a.store.syncState().release).toBe("2.0");
  expect(a.store.get("workout", "w")).toMatchObject({ deleted: true, status: "conflict" });
  expect((await server.row("alice", "workout_set", "s"))?.content?.reps).toBe(12);
  await a.restart();
  a.store.resolve("workout", "w", { choice: "keep_theirs" });
  expect(a.store.get("workout_set", "s")?.content?.reps).toBe(12);
});

it.each([
  ["stale reply", 12],
  ["equal older projection", 8],
] as const)(
  "preserves another phone's correction when a pending workout deletion learns it through a %s",
  async (_, correctedReps) => {
    world = new World(previewContract);
    const server = world.server();
    const connect = (name: string, release: ReleaseId) =>
      world.phone(name, {
        account: "alice",
        server: "s",
        transport: server.transport("alice"),
        releases: [release],
      });
    const a = await connect("a", "1.0");
    const b = await connect("b", "1.2");
    a.store.put("workout", "w", workout("Workout"));
    a.store.put("workout_exercise", "e", entry("w", "Bench"));
    a.store.put("workout_set", "s", set("e", { reps: 5 }));
    expectSynced(await a.sync());
    expectSynced(await b.sync());
    a.store.put("workout_set", "s", set("e", { reps: 8 }));
    expect(a.store.prepareSubmissions("1.0")).toHaveLength(1);
    a.store.delete("workout", "w");
    b.store.put("workout_set", "s", set("e", { reps: correctedReps, repsInReserve: 2 }));
    expectSynced(await b.sync());
    expectSynced(await a.sync());
    expect(await server.row("alice", "workout_set", "s")).toMatchObject({
      state: "live",
      content: { reps: correctedReps, repsInReserve: 2 },
    });
    expect(a.store.get("workout", "w")).toMatchObject({ deleted: true, status: "conflict" });
  },
);

it("keeps the workout when an accepted older header upload cannot prove it wrote the revision queued for deletion", async () => {
  world = new World(previewContract);
  const server = world.server();
  const a = await world.phone("a", {
    account: "alice",
    server: "s",
    transport: server.transport("alice"),
    releases: ["1.0"],
  });
  const b = await world.phone("b", {
    account: "alice",
    server: "s",
    transport: server.transport("alice"),
  });
  a.store.put("workout", "w", workout("Workout"));
  a.store.put("workout_exercise", "e", entry("w", "Bench"));
  expectSynced(await a.sync());
  expectSynced(await b.sync());
  a.store.put("workout", "w", workout("Renamed"));
  expect(a.store.prepareSubmissions("1.0")).toHaveLength(1);
  a.store.delete("workout", "w");
  const plan = { title: "Other phone's routine", exercises: [] };
  b.store.put("workout", "w", { ...workout("Renamed"), initialPlan: plan });
  expectSynced(await b.sync());
  expectSynced(await a.sync());
  expect(a.store.get("workout", "w")).toMatchObject({ deleted: true, status: "conflict" });
  expect(await server.row("alice", "workout", "w")).toMatchObject({
    state: "live",
    content: { initialPlan: plan },
  });
  expect(await server.row("alice", "workout_exercise", "e")).toMatchObject({ state: "live" });
});
