import { join } from "node:path";
import { openDeviceStore } from "@leve/storage";
import { afterEach, expect, it } from "vitest";
import { HistoricalPeer } from "../../contract/history/1.0/peer.ts";
import { previewContract, previewFrozen } from "../../contract/test/support/preview-contract.ts";
import { entry, Peer1, set, workout } from "./support/content.ts";
import { FaultyTransport, World } from "./support/harness.ts";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.dispose();
});
const world = () => {
  const w = new World(previewContract);
  worlds.push(w);
  return w;
};
const plan = {
  title: "Captured title",
  exercises: [
    {
      exerciseId: "press",
      exerciseName: "Press",
      exerciseType: "weight_reps",
      restSeconds: 0,
      supersetId: null,
      useRepRange: true,
      sets: [
        {
          type: "normal",
          weightKg: 0,
          reps: null,
          repRangeMin: 6,
          repRangeMax: 8,
          count: null,
          distanceMeters: null,
          durationSeconds: null,
          rpe: 7.5,
        },
      ],
    },
  ],
};

async function checkRefresh(dropEqualRevisions = false) {
  const w = world();
  const server = w.server();
  const transport = server.transport("alice");
  const peer = new HistoricalPeer(previewFrozen("1.1"), transport);
  await peer.hello();
  await peer.push(
    ["a", "b"].map((id) => peer.put("workout", id, workout(id, { initialPlan: plan }))),
  );
  const net = new FaultyTransport(transport);
  const phone = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: net.call,
    pageSize: 1,
    openStore: async (options) => {
      const store = await openDeviceStore(options);
      if (dropEqualRevisions) {
        const apply = store.applyPull.bind(store);
        store.applyPull = (changes, ...args) =>
          apply(
            changes.filter(
              (change) => store.get(change.kind, change.id)?.server?.revision !== change.revision,
            ),
            ...args,
          );
      }
      return store;
    },
    releases: ["1.0"],
  });
  expect(await phone.sync()).toMatchObject({ state: "synced", pulled: 2 });
  phone.store.put("workout", "b", workout("edited on old release"));
  await phone.restart({ releases: ["1.0", "1.1"] });
  net.next("pass", "/sync/pull").next("offline", "/sync/pull");
  expect(await phone.sync()).toMatchObject({ state: "offline" });
  expect(phone.store.syncState()).toMatchObject({ cursor: 1, refreshFrom: "1.0" });
  expect(net.log.filter((e) => e.path === "/sync/push")).toHaveLength(0);
  expect(phone.store.prepareSubmissions("1.1")).toEqual([]);
  await phone.restart();
  expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 1 });
  expect(
    phone.store.get("workout", "a")?.content?.initialPlan,
    "equal revision must acquire its plan",
  ).toEqual(plan);
  const records = await peer.pull();
  expect(records.find((r) => r.id === "b")).toMatchObject({
    content: { title: "edited on old release", initialPlan: plan },
  });
  const older = new Peer1(transport, "peer", previewFrozen("1.0"));
  await older.pull();
  await older.push([older.put("workout", "b", workout("another old edit"))]);
  expect((await peer.pull())[0]).toMatchObject({
    content: { title: "another old edit", initialPlan: plan },
  });
  await peer.push([peer.put("workout", "b", workout("cleared", { initialPlan: null }))]);
  expect((await peer.pull())[0]).toMatchObject({ content: { initialPlan: null } });
}

it("refreshes equal revisions before uploading a 1.0 edit across a failed page and restart", () =>
  checkRefresh());
it("detects a client discarding equal revisions during a release upgrade", async () => {
  await expect(checkRefresh(true)).rejects.toThrow(/equal revision must acquire its plan/);
});

it("retains the initial plan and set slots locally until a 1.0 server can accept them", async () => {
  const w = world();
  const server = w.server({ releases: ["1.0"] });
  const phone = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
  });
  phone.store.put("workout", "w", workout("session", { initialPlan: plan }));
  phone.store.put("workout_exercise", "e", entry("w", "Press"));
  phone.store.put("workout_set", "s", set("e", { planSlot: { exercise: 0, set: 0 } }));
  expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 3 });
  expect(phone.store.get("workout", "w")).toMatchObject({
    status: "partial",
    partialFields: ["initialPlan"],
  });
  expect(phone.store.get("workout_set", "s")).toMatchObject({
    status: "partial",
    partialFields: ["planSlot"],
  });
  await phone.restart();
  await server.restart({ releases: ["1.0", "1.1"] });
  expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 2 });
  expect((await server.row("alice", "workout", "w"))?.content?.initialPlan).toEqual(plan);
  expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual({
    exercise: 0,
    set: 0,
  });
  expect(phone.store.hasUnsyncedWork()).toBe(false);
});

it("keeps a deliberate clear pending while a connection only accepts 1.0", async () => {
  const w = world();
  const server = w.server();
  const device = await w.phone("device", {
    account: "alice",
    server: "s",
    transport: server.transport("alice"),
  });
  device.store.put("workout", "w", workout("original", { initialPlan: plan }));
  await device.sync();
  await server.restart({ releases: ["1.0"] });
  device.store.put("workout", "w", workout("renamed", { initialPlan: null }));
  await device.sync();
  expect(device.store.get("workout", "w")).toMatchObject({
    status: "partial",
    content: { initialPlan: null },
  });
  expect((await server.row("alice", "workout", "w"))?.content?.initialPlan).toEqual(plan);
  await server.restart({ releases: ["1.0", "1.1"] });
  await device.sync();
  expect(device.store.get("workout", "w")?.status).toBe("synced");
  expect((await server.row("alice", "workout", "w"))?.content?.initialPlan).toBeNull();
});

it("refreshes a newer conflict copy returned in the old release when retrying an in-flight edit", async () => {
  const w = world();
  const server = w.server();
  const transport = server.transport("alice");
  const writer = new HistoricalPeer(previewFrozen("1.1"), transport);
  await writer.hello();
  await writer.push([writer.put("workout", "w", workout("session", { initialPlan: plan }))]);
  const net = new FaultyTransport(transport);
  const phone = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: net.call,
    releases: ["1.0"],
  });
  await phone.sync();
  phone.store.put("workout", "w", workout("local edit"));
  const before = phone.store.prepareSubmissions("1.0");
  const replaced = { ...plan, title: "Corrected source" };
  await writer.pull();
  // The competing update lands after the upgrade download, before the old envelope is retried.
  net.beforeReply = async (path) => {
    if (path !== "/sync/pull") return;
    net.beforeReply = null;
    await writer.push([
      writer.put("workout", "w", workout("remote edit", { initialPlan: replaced })),
    ]);
  };
  await phone.restart({ releases: ["1.0", "1.1"] });
  await phone.sync();
  expect(net.log.find((e) => e.path === "/sync/push")?.request).toMatchObject({
    release: "1.0",
    submissions: before.map((s) => s.submission),
  });
  expect(phone.store.get("workout", "w")).toMatchObject({
    status: "conflict",
    content: { title: "local edit", initialPlan: replaced },
    server: { content: { title: "remote edit", initialPlan: replaced } },
  });
});

it("drains the newer pending edit after an old in-flight create triggers another refresh", async () => {
  const w = world();
  const server = w.server();
  const phone = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
    releases: ["1.0"],
  });
  await phone.sync();
  phone.store.put("workout", "w", workout("first"));
  expect(phone.store.prepareSubmissions("1.0")).toHaveLength(1);
  phone.store.put("workout", "w", workout("latest"));
  await phone.restart({ releases: ["1.0", "1.1"] });
  expect(await phone.sync()).toMatchObject({ state: "synced", pushed: 2 });
  expect(phone.store.get("workout", "w")?.status).toBe("synced");
  expect((await server.row("alice", "workout", "w"))?.content?.title).toBe("latest");
});

it("resends a withheld snapshot when its 1.0 envelope is acknowledged after upgrading", async () => {
  const w = world();
  const server = w.server({ releases: ["1.0"] });
  const device = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
  });
  await device.sync();
  device.store.put("workout", "w", workout("session", { initialPlan: plan }));
  const [old] = device.store.prepareSubmissions("1.0");
  expect(old?.submission).toMatchObject({ op: "put", content: workout("session") });
  await server.restart({ releases: ["1.0", "1.1"] });
  await device.restart();
  expect(await device.sync()).toMatchObject({ state: "synced", pushed: 2 });
  expect((await server.row("alice", "workout", "w"))?.content?.initialPlan).toEqual(plan);
  expect(device.store.hasUnsyncedWork()).toBe(false);
});

it("keeps a withheld clear for review when a lineage reset coincides with the release upgrade", async () => {
  const w = world();
  const server = w.server();
  const device = await w.phone("device", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
  });
  device.store.put("workout", "w", workout("session", { initialPlan: plan }));
  await device.sync();
  const snapshot = join(w.directory, "backup.db");
  await server.snapshot("alice", snapshot);
  await server.restart({ releases: ["1.0"] });
  device.store.put("workout", "w", workout("session", { initialPlan: null }));
  await device.sync();
  expect(device.store.get("workout", "w")).toMatchObject({
    status: "partial",
    content: { initialPlan: null },
  });
  await server.restart({ releases: ["1.0", "1.1"] });
  await server.restoreWithCommand("alice", snapshot);
  await device.sync();
  expect(device.store.get("workout", "w")).toMatchObject({
    status: "conflict",
    content: { initialPlan: null },
    server: { content: { initialPlan: plan } },
  });
});

it("offers a previously synced clear for review if the restored backup predates it", async () => {
  const w = world();
  const server = w.server();
  const phone = await w.phone("phone", {
    server: "s",
    account: "alice",
    transport: server.transport("alice"),
  });
  phone.store.put("workout", "w", workout("session", { initialPlan: plan }));
  await phone.sync();
  const backup = join(w.directory, "before-clear.db");
  await server.snapshot("alice", backup);
  phone.store.put("workout", "w", workout("session", { initialPlan: null }));
  await phone.sync();
  await server.restart({ releases: ["1.0"] });
  await phone.sync();
  await server.restart({ releases: ["1.0", "1.1"] });
  await server.restoreWithCommand("alice", backup);
  await phone.sync();
  expect(phone.store.get("workout", "w")).toMatchObject({
    status: "conflict",
    content: { initialPlan: null },
    server: { content: { initialPlan: plan } },
  });
});

it("fills fields an older device never observed when restoring and upgrading together", async () => {
  const w = world();
  const server = w.server();
  const transport = server.transport("alice");
  const peer = new HistoricalPeer(previewFrozen("1.1"), transport);
  await peer.hello();
  await peer.push([peer.put("workout", "w", workout("session", { initialPlan: plan }))]);
  const backup = join(w.directory, "with-unseen-plan.db");
  await server.snapshot("alice", backup);
  const phone = await w.phone("device", {
    server: "s",
    account: "alice",
    transport,
    releases: ["1.0"],
  });
  await phone.sync();
  phone.store.put("workout", "w", workout("local edit"));
  await server.restoreWithCommand("alice", backup);
  await phone.restart({ releases: ["1.0", "1.1"] });
  await phone.sync();
  expect(phone.store.get("workout", "w")).toMatchObject({
    status: "conflict",
    content: { title: "local edit", initialPlan: plan },
    server: { content: { title: "session", initialPlan: plan } },
  });
});
