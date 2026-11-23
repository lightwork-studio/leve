import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { previewContract } from "../../contract/test/support/preview-contract.ts";
import { entry, set, workout } from "./support/content.ts";
import { FaultyTransport, World } from "./support/harness.ts";

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

it.each(["equal visible download", "delayed receipt"])(
  "retains a chosen clear through %s on the older server",
  async (stage) => {
    const { server, a, net } = await pair();
    const backup = join(world.directory, "before-clear.db");
    await server.snapshot("alice", backup);
    a.store.put("workout_set", "s", set("e", { planSlot: null }));
    await server.restart({ releases: ["1.0"] });
    await server.restoreWithCommand("alice", backup);
    await a.sync();
    a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    if (stage === "delayed receipt") net.next("lose_reply", "/sync/push");
    await a.sync();
    // A fresh peer reads the restored server through its actual older projection.
    const c = await world.phone("older", {
      server: "s",
      account: "alice",
      transport: server.transport("alice"),
      releases: ["1.0"],
    });
    await c.sync();
    c.store.put("workout_set", "s", set("e", { reps: 7 }));
    await c.sync();
    if (stage === "equal visible download") {
      c.store.put("workout_set", "s", set("e"));
      await c.sync();
    }
    await a.client.waitForChanges(0);
    await a.sync();
    const record = a.store.get("workout_set", "s");
    expect(record?.status).not.toBe("synced");
    if (record?.status === "conflict") a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "partial",
      partialFields: ["planSlot"],
      content: { planSlot: null },
    });
    await a.restart();
    await server.restart({ releases: ["1.1"] });
    await a.sync();
    // Only the richer peer can show what the backup actually contained. Verify
    // that the lifter still has both versions to choose from after restarting.
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { planSlot: null },
      server: { content: { planSlot: firstTarget } },
    });
    await a.restart();
    a.store.resolve("workout_set", "s", { choice: "keep_mine" });
    await a.sync();
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toBeNull();
  },
);

it.each(["partial", "in flight"])(
  "preserves a local clear on a legacy-only phone when a restored backup hides a different value (%s)",
  async (stage) => {
    world = new World(previewContract);
    const server = world.server({ releases: ["1.0"] });
    const options = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", options);
    a.store.put("workout", "w", workout("Push"));
    a.store.put("workout_exercise", "e", entry("w", "Press"));
    a.store.put("workout_set", "s", set("e", { planSlot: firstTarget }));
    await a.sync();
    a.store.put("workout_set", "s", set("e", { planSlot: null }));
    if (stage === "partial") await a.sync();
    else expect(a.store.prepareSubmissions("1.0")).toHaveLength(1);
    await server.restart({ releases: ["1.0", "1.1"] });
    const b = await world.phone("b", options);
    await b.sync();
    b.store.put("workout_set", "s", set("e", { planSlot: otherTarget }));
    await b.sync();
    const backup = join(world.directory, "changed.db");
    await server.snapshot("alice", backup);
    await server.restart({ releases: ["1.0"] });
    await server.restoreWithCommand("alice", backup);
    await a.restart();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { planSlot: null },
      partialFields: ["planSlot"],
    });
    await server.restart({ releases: ["1.0", "1.1"] });
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

it.each([null, firstTarget])(
  "confirms an unchanged observed field only when the restored server can show it (%j)",
  async (stored) => {
    const { a, b, server } = await pair();
    b.store.put("workout_set", "s", set("e", { planSlot: stored }));
    await b.sync();
    await a.sync();
    const backup = join(world.directory, "unchanged.db");
    await server.snapshot("alice", backup);
    await server.restart({ releases: ["1.0"] });
    await server.restoreWithCommand("alice", backup);
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      problem: { reason: "restored" },
      content: { planSlot: stored },
      partialFields: ["planSlot"],
    });
    await a.restart();
    await server.restart({ releases: ["1.1"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "synced",
      partialFields: [],
      content: { planSlot: stored },
    });
    expect(a.store.hasUnsyncedWork()).toBe(false);
    expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(stored);
  },
);

async function checkRestoredFirstUpload(dropFirst = false) {
  world = new World(previewContract);
  const server = world.server({ releases: ["1.1"] });
  const net = new FaultyTransport(server.transport("alice"));
  const a = await world.phone("a", { server: "s", account: "alice", transport: net.call });
  a.store.put("workout", "w", workout("Push"));
  a.store.put("workout_exercise", "e", entry("w", "Press"));
  await a.sync();
  a.store.put("workout_set", "new", set("e", { planSlot: firstTarget }));
  net.next("lose_reply", "/sync/push");
  await a.sync();
  expect(a.store.get("workout_set", "new")).toMatchObject({ inFlight: true, server: null });
  a.store.put("workout_set", "new", set("e", { planSlot: null }));
  // The backup includes the accepted request. The phone has never seen its revision.
  const backup = join(world.directory, "accepted.db");
  await server.snapshot("alice", backup);
  await server.restart({ releases: ["1.0"] });
  await server.restoreWithCommand("alice", backup);
  await a.restart();
  if (dropFirst) {
    const reset = a.store.resetForServerRestore.bind(a.store);
    a.store.resetForServerRestore = () => {
      a.store.db.run("DELETE FROM submissions");
      reset();
    };
  }
  await a.sync();
  expect(
    a.store.get("workout_set", "new"),
    "restore must keep the later local clear",
  ).toMatchObject({
    status: "conflict",
    content: { planSlot: null },
    partialFields: ["planSlot"],
  });
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "new")).toMatchObject({
    status: "conflict",
    content: { planSlot: null },
    server: { content: { planSlot: firstTarget } },
  });
  a.store.resolve("workout_set", "new", { choice: "keep_mine" });
  await a.sync();
  expect((await server.row("alice", "workout_set", "new"))?.content?.planSlot).toBeNull();
}

it("retains a clear made after a new set reached a richer server when its first receipt never arrived", () =>
  checkRestoredFirstUpload());
it("detects a restore that discards the outstanding upload before comparing the local edit", async () => {
  await expect(checkRestoredFirstUpload(true)).rejects.toThrow(
    /restore must keep the later local clear/,
  );
});

it("compares a post-dispatch clear when a legacy background pull precedes restore on a richer server", async () => {
  const { a, server, net } = await pair();
  a.store.put("workout_set", "new", set("e", { planSlot: firstTarget }));
  net.next("lose_reply", "/sync/push");
  await a.sync();
  a.store.put("workout_set", "new", set("e", { planSlot: null }));
  const backup = join(world.directory, "after-create.db");
  await server.snapshot("alice", backup);
  await server.restart({ releases: ["1.0"] });
  await a.client.waitForChanges(0);
  expect(a.store.get("workout_set", "new")?.inFlight).toBe(true);
  await server.restart({ releases: ["1.1"] });
  await server.restoreWithCommand("alice", backup);
  await a.restart();
  await a.sync();
  expect(a.store.get("workout_set", "new")).toMatchObject({
    status: "conflict",
    content: { planSlot: null },
    server: { content: { planSlot: firstTarget } },
  });
});

it("retains a rejected local clear and its rejection reason through a projected restore", async () => {
  const { a, server } = await pair();
  const backup = join(world.directory, "before-rejection.db");
  await server.snapshot("alice", backup);
  a.store.put("workout_set", "s", set("e", { planSlot: null }));
  const [pending] = a.store.prepareSubmissions("1.1");
  if (!pending) throw Error("Missing pending set");
  a.store.applyPushResults([
    {
      status: "invalid",
      submissionId: pending.submission.submissionId,
      code: "submission_reused",
      message: "Submission ID was already used.",
    },
  ]);
  await server.restart({ releases: ["1.0"] });
  await server.restoreWithCommand("alice", backup);
  await a.sync();
  await a.restart();
  await server.restart({ releases: ["1.1"] });
  await a.sync();
  expect(a.store.get("workout_set", "s")).toMatchObject({
    status: "invalid",
    problem: { reason: "invalid:submission_reused" },
    content: { planSlot: null },
    server: { content: { planSlot: firstTarget } },
  });
});
