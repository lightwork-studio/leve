import { join } from "node:path";
import type { Contract, JsonObject } from "@leve/contract";
import type { ServerStorage } from "@leve/storage/server";
import { expect } from "vitest";
import type { Transport } from "../../src/transport.ts";
import { Peer1, workout } from "./content.ts";
import {
  FaultyTransport,
  type PhoneOptions,
  resultsOf,
  type ServerHarness,
  sentSubmissions,
  World,
} from "./harness.ts";
import { REHEARSAL_FEATURE, rehearsalContract, rehearsalFrozen } from "./synthetic.ts";

/*
 * Reusable behaviour checks. Each builds its own world on real SQLite and asserts literal
 * expectations. The real implementation passes every check; the broken variants in
 * broken-variants.test.ts plug into the seams below and must make the matching check fail.
 */

export interface Variant {
  /** Replaces the write service's contract (the server's encoder and omission rule). */
  serviceContract?: (contract: Contract) => Contract;
  /** Replaces the phone's contract (the client's encoder). */
  clientContract?: (contract: Contract) => Contract;
  /** Wraps the server storage the write service uses. */
  wrapStorage?: (storage: ServerStorage) => ServerStorage;
  /** Installed on the transport of the writer under test. */
  tamper?: (net: FaultyTransport, server: ServerHarness) => void;
  /** Opens the phone's device store. */
  openStore?: PhoneOptions["openStore"];
  /** How the server's upload endpoint is reached; broken variants handle it differently. */
  pushRoute?: (server: ServerHarness, account: string) => Transport;
}

async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const world = new World();
  try {
    await fn(world);
  } finally {
    await world.dispose();
  }
}

async function phone(
  world: World,
  server: ServerHarness,
  name: string,
  variant: Variant,
  extra: Partial<PhoneOptions> = {},
) {
  const net = new FaultyTransport(server.transport("alice"));
  const device = await world.phone(name, {
    account: "alice",
    server: "s",
    transport: net.call,
    ...(variant.openStore ? { openStore: variant.openStore } : {}),
    ...extra,
  });
  return { phone: device, net };
}

const serverOptions = (variant: Variant) =>
  variant.wrapStorage ? { wrapStorage: variant.wrapStorage } : {};

/** Two writers from the same base: exactly one is accepted, the other is kept as a conflict. */
export function checkRevisionCheck(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const a = await phone(world, server, "a", variant);
    const b = await phone(world, server, "b", variant);
    variant.tamper?.(b.net, server);
    a.phone.store.put("workout", "w1", workout("v1"));
    await a.phone.sync();
    await b.phone.sync();
    a.phone.store.put("workout", "w1", workout("by A"));
    b.phone.store.put("workout", "w1", workout("by B"));
    await a.phone.sync();
    await b.phone.sync();
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("by A");
    expect(b.phone.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "by B" },
      problem: { reason: "stale" },
    });
    expect(await server.head("alice")).toBe(2);
  });
}

/** A retry after a lost reply gets the original answer even though the record changed since. */
export function checkRetryRecognised(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device, net } = await phone(world, server, "a", variant);
    device.store.put("workout", "w1", workout("v1"));
    await device.sync();
    device.store.put("workout", "w1", workout("v2"));
    net.next("lose_reply", "/sync/push");
    await device.sync();
    const peer = new Peer1(server.transport("alice"));
    await peer.pull();
    await peer.push([peer.put("workout", "w1", workout("by peer"))]);
    await server.restart();

    await device.sync();
    const [lost, retry] = net.log.filter((e) => e.path === "/sync/push").slice(-2);
    expect(retry?.request).toEqual(lost?.request);
    expect(retry?.response?.body).toEqual(lost?.response?.body);
    expect(resultsOf(retry)).toEqual([{ status: "accepted", submissionId: "a-2", revision: 2 }]);
    expect(device.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      content: { title: "by peer" },
    });
    expect(await server.head("alice")).toBe(3);
  });
}

/** An acknowledgement keeps an edit made while the submission was in flight. */
export function checkNewerEditSurvives(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device, net } = await phone(world, server, "a", variant);
    device.store.put("workout", "w1", workout("v1"));
    await device.sync();
    device.store.put("workout", "w1", workout("v2"));
    net.beforeReply = (path) => {
      if (path !== "/sync/push") return;
      net.beforeReply = null;
      device.store.put("workout", "w1", workout("v3"));
    };
    net.next("pass", "/sync/push").next("offline", "/sync/push");
    await device.sync();
    expect(device.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      content: { title: "v3" },
      baseRevision: 2,
      server: { revision: 2, content: { title: "v2" } },
    });
    await device.restart();
    await device.sync();
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("v3");
    expect(device.store.get("workout", "w1")?.status).toBe("synced");
  });
}

/** Upload answers never move the download cursor, so changes made elsewhere are not skipped. */
export function checkCursorOnlyFromDownloads(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device, net } = await phone(world, server, "a", variant);
    device.store.put("workout", "w1", workout("v1"));
    await device.sync();
    const peer = new Peer1(server.transport("alice"));
    await peer.push([peer.put("workout", "w9", workout("from elsewhere"))]);
    device.store.put("workout", "w1", workout("v2"));
    net.next("pass", "/sync/push").next("lose_reply", "/sync/pull");
    await device.sync();
    expect(device.store.syncState().cursor).toBe(1);
    await device.restart();
    await device.sync();
    expect(device.store.list("workout").map((r) => [r.id, r.content?.title])).toEqual([
      ["w1", "v2"],
      ["w9", "from elsewhere"],
    ]);
  });
}

const workoutWithPlan = (title: string, extra: JsonObject = {}) =>
  workout(title, { initialPlan: null, ...extra });

/**
 * Rehearsal (synthetic 1.1): an archived 1.0 peer editing a workout keeps a stored effortRating,
 * a 1.1 writer clears it with null, and fields a release lacks are left out of its answers.
 */
export function checkOmissionRule(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const service = variant.serviceContract?.(rehearsalContract);
    const server = world.server({
      contract: rehearsalContract,
      releases: ["1.0", "1.1"],
      ...(service ? { serviceContract: service } : {}),
    });
    const { phone: current } = await phone(world, server, "new", variant, {
      contract: rehearsalContract,
      releases: ["1.0", "1.1"],
    });
    current.store.put("workout", "w1", workoutWithPlan("Legs", { effortRating: 0 }));
    expect(await current.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(current.store.syncState().release).toBe("1.1");
    expect(current.client.featureAvailable(REHEARSAL_FEATURE)).toBe(true);
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Legs", { effortRating: 0 }),
    );

    const net = new FaultyTransport(server.transport("alice"));
    variant.tamper?.(net, server);
    const old = new Peer1(net.call);
    expect(await old.hello()).toMatchObject({ release: "1.0" });
    expect(await old.hello()).not.toMatchObject({
      features: expect.arrayContaining([REHEARSAL_FEATURE]),
    });
    const [change] = await old.pull();
    expect(change).toEqual({
      state: "live",
      kind: "workout",
      id: "w1",
      revision: 1,
      content: workoutWithPlan("Legs"),
    });
    expect(
      await old.push([old.put("workout", "w1", workoutWithPlan("Legs (old app)"))]),
    ).toMatchObject({
      results: [{ status: "accepted", revision: 2 }],
    });
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Legs (old app)", { effortRating: 0 }),
    );
    // A field the old release doesn't define is rejected, not stripped.
    const smuggled = old.put("workout", "w1", workoutWithPlan("smuggled"));
    expect(
      await old.push([{ ...smuggled, content: workoutWithPlan("smuggled", { effortRating: 9 }) }]),
    ).toMatchObject({ results: [{ status: "invalid", code: "invalid_content" }] });

    await current.sync();
    expect(current.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      content: workoutWithPlan("Legs (old app)", { effortRating: 0 }),
    });
    current.store.put("workout", "w1", workoutWithPlan("Legs (old app)", { effortRating: null }));
    await current.sync();
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Legs (old app)", { effortRating: null }),
    );
    await old.pull();
    await old.push([old.put("workout", "w1", workoutWithPlan("Legs again"))]);
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Legs again", { effortRating: null }),
    );

    // A 1.1 writer must send the field: missing is invalid, null clears, bounds apply.
    const newer = new Peer1(server.transport("alice"), "p11", rehearsalFrozen());
    await newer.pull();
    const put = newer.put("workout", "w1", workoutWithPlan("v11", { effortRating: 10 }));
    const results = (await newer.push([
      { ...put, submissionId: "p11-missing", content: workoutWithPlan("v11") },
      { ...put, submissionId: "p11-high", content: workoutWithPlan("v11", { effortRating: 11 }) },
      { ...put, submissionId: "p11-frac", content: workoutWithPlan("v11", { effortRating: 2.5 }) },
      put,
    ])) as { results: JsonObject[] };
    expect(results.results.map((r) => r.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "accepted",
    ]);
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("v11", { effortRating: 10 }),
    );
  });
}

/**
 * Rehearsal (synthetic 1.1): a 1.1 client on a 1.0-only server negotiates 1.0, disables the new
 * feature, keeps the value it holds, reports the upload as partial (never synced), and resends it
 * in full once the server supports 1.1.
 */
export function checkPartialUpload(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server({ contract: rehearsalContract, releases: ["1.0"] });
    const clientContract = variant.clientContract?.(rehearsalContract) ?? rehearsalContract;
    const { phone: device, net } = await phone(world, server, "new", variant, {
      contract: clientContract,
      releases: ["1.0", "1.1"],
    });
    expect(device.client.featureAvailable(REHEARSAL_FEATURE)).toBe(true);
    device.store.put("workout", "w1", workoutWithPlan("Run", { effortRating: 6 }));
    device.store.put("workout", "w2", workoutWithPlan("Walk", { effortRating: null }));
    expect(await device.sync()).toMatchObject({ state: "synced", pushed: 2 });
    expect(device.store.syncState().release).toBe("1.0");
    expect(device.client.featureAvailable(REHEARSAL_FEATURE)).toBe(false);
    expect(device.client.featureAvailable("rpe")).toBe(true);
    expect(sentSubmissions(net.log).map((s) => s.content)).toEqual([
      workoutWithPlan("Run"),
      workoutWithPlan("Walk"),
    ]);
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Run", { effortRating: null }),
    );

    const expectPartial = () => {
      expect(device.store.get("workout", "w1")).toMatchObject({
        status: "partial",
        partialFields: ["effortRating"],
        content: { title: "Run", effortRating: 6 },
      });
      expect(device.store.get("workout", "w2")?.status).toBe("synced");
      expect(device.store.summary()).toMatchObject({ partial: 1, synced: 1 });
      expect(device.store.hasUnsyncedWork()).toBe(true);
    };
    expectPartial();
    await device.restart();
    await device.sync();
    expectPartial();

    await server.restart({ contract: rehearsalContract, releases: ["1.0", "1.1"] });
    expect(await device.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect(device.store.syncState().release).toBe("1.1");
    expect(device.client.featureAvailable(REHEARSAL_FEATURE)).toBe(true);
    expect(net.log.filter((e) => e.path === "/sync/push").at(-1)?.request).toEqual({
      release: "1.1",
      lineage: device.store.syncState().lineage,
      submissions: [
        {
          op: "put",
          submissionId: expect.any(String),
          kind: "workout",
          id: "w1",
          baseRevision: 1,
          content: workoutWithPlan("Run", { effortRating: 6 }),
        },
      ],
    });
    expect(device.store.get("workout", "w1")).toMatchObject({
      status: "synced",
      partialFields: [],
    });
    expect((await server.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Run", { effortRating: 6 }),
    );
    expect(device.store.hasUnsyncedWork()).toBe(false);
  });
}

/** Without a common release the answer is update_required naming the side behind; data stays. */
export function checkNoCommonRelease(): Promise<void> {
  return inWorld(async (world) => {
    // A server that only speaks 1.1, an archived 1.0 peer and a current 1.0-only client.
    const newOnly = world.server({ contract: rehearsalContract, releases: ["1.1"] });
    const old = new Peer1(newOnly.transport("alice"));
    expect(await old.hello()).toEqual({
      error: {
        code: "update_required",
        message: expect.any(String),
        update: "client",
        serverReleases: ["1.1"],
      },
    });
    const { phone: oldApp } = await phone(world, newOnly, "old-app", {}, { releases: ["1.0"] });
    oldApp.store.put("workout", "w1", workoutWithPlan("Kept while paused"));
    expect(await oldApp.sync()).toEqual({ state: "update_required", update: "client" });
    expect(oldApp.store.get("workout", "w1")).toMatchObject({ status: "pending" });
    oldApp.store.put("workout", "w2", workoutWithPlan("Logged while paused"));
    await oldApp.restart();
    expect(oldApp.store.summary()).toMatchObject({ pending: 2 });
    expect(await newOnly.rows("alice")).toEqual([]);

    // A current client that only speaks 1.1 against a 1.0-only server: the server is behind.
    const oldServer = world.server({ releases: ["1.0"] });
    const { phone: newApp } = await phone(
      world,
      oldServer,
      "new-app",
      {},
      {
        contract: rehearsalContract,
        releases: ["1.1"],
      },
    );
    newApp.store.put("workout", "w1", workoutWithPlan("Kept", { effortRating: 4 }));
    expect(await newApp.sync()).toEqual({ state: "update_required", update: "server" });
    expect(newApp.store.get("workout", "w1")).toMatchObject({
      status: "pending",
      content: { effortRating: 4 },
    });
    expect(newApp.store.summary()).toMatchObject({ pending: 1, inFlight: 0 });
    expect(await oldServer.rows("alice")).toEqual([]);

    // Once the server speaks 1.1 the paused work goes through.
    await oldServer.restart({ contract: rehearsalContract, releases: ["1.0", "1.1"] });
    expect(await newApp.sync()).toMatchObject({ state: "synced", pushed: 1 });
    expect((await oldServer.row("alice", "workout", "w1"))?.content).toEqual(
      workoutWithPlan("Kept", { effortRating: 4 }),
    );
  });
}

/** The archived peer checks every reply against its frozen release. */
export function checkPeerValidatesReplies(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const net = new FaultyTransport(server.transport("alice"));
    variant.tamper?.(net, server);
    const peer = new Peer1(net.call);
    expect(await peer.hello()).toMatchObject({ release: "1.0", revision: 0 });
    expect(await peer.push([peer.put("workout", "w1", workout("v1"))])).toMatchObject({
      results: [{ status: "accepted", revision: 1 }],
    });
    expect(await peer.pull()).toHaveLength(1);
    expect(await peer.push([peer.put("workout", "w1", workout("v2"))])).toMatchObject({
      results: [{ status: "accepted", revision: 2 }],
    });
    expect(await peer.push([peer.delete("workout", "w1")])).toMatchObject({
      results: [{ status: "accepted", revision: 3 }],
    });
    expect(await peer.pull()).toEqual([
      { state: "deleted", kind: "workout", id: "w1", revision: 3 },
    ]);
  });
}

/**
 * An upload made in the history before a restore is refused as a whole before anything is
 * written, even when its base revision happens to equal one the new history reused.
 */
export function checkPushLineageGuard(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server();
    const { phone: a } = await phone(world, server, "a", variant);
    a.store.put("workout", "w1", workout("v1"));
    await a.sync();
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    a.store.put("workout", "w1", workout("v2"));
    await a.sync();
    expect(a.store.get("workout", "w1")?.server?.revision).toBe(2);
    const oldLineage = a.store.syncState().lineage;

    // A edits its copy at revision 2; the account goes back to revision 1 and C writes revision 2.
    a.store.put("workout", "w1", workout("A's edit"));
    await server.restoreWithCommand("alice", backup);
    const c = new Peer1(server.transport("alice"), "c");
    await c.pull();
    expect(await c.push([c.put("workout", "w1", workout("C's write"))])).toMatchObject({
      results: [{ status: "accepted", revision: 2 }],
    });

    // A uploads without connecting again, so it still names the old lineage.
    const [outgoing] = a.store.prepareSubmissions("1.0");
    expect(outgoing?.submission).toMatchObject({ id: "w1", baseRevision: 2 });
    const push = (variant.pushRoute ?? ((s, account) => s.transport(account)))(server, "alice");
    const reply = await push("/sync/push", {
      release: "1.0",
      lineage: oldLineage,
      submissions: [outgoing?.submission],
    });
    expect(reply).toMatchObject({ status: 409, body: { error: { code: "cursor_reset" } } });
    expect((await server.row("alice", "workout", "w1"))?.content?.title).toBe("C's write");
    expect(await server.head("alice")).toBe(2);
    expect(await server.receipts("alice")).toHaveLength(2);
  });
}

/**
 * Reviewer's reproducer: a file-copy restore, then a write by a device whose cursor was not ahead
 * (so the counter catches up) before the device that is ahead connects. Its change the server lost
 * must come back for review, never be quietly replaced by the restored copy.
 */
export function checkFileCopyThenWrite(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device } = await phone(world, server, "phone", variant);
    const { phone: old } = await phone(world, server, "old", variant);
    device.store.put("workout", "w1", workout("v1"));
    await device.sync();
    await old.sync();
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    device.store.put("workout", "w1", workout("v2"));
    device.store.put("workout", "w9", workout("x"));
    device.store.put("workout", "w8", workout("y"));
    await device.sync();
    await server.restore("alice", backup);
    old.store.put("workout", "w2", workout("a"));
    await old.sync();
    expect(await server.head("alice")).toBe(2);

    await device.sync();
    expect(device.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "v2" },
      server: { content: { title: "v1" } },
    });
    expect(device.store.problems().map((r) => r.id)).toEqual(["w1"]);
    expect((await server.row("alice", "workout", "w9"))?.content?.title).toBe("x");
  });
}

/**
 * Reviewer's reproducer: a tablet offline across two restores. Its edit belongs to the first
 * history, the second restore point to the second: the edit must come back for review.
 */
export function checkOfflineAcrossTwoRestores(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device } = await phone(world, server, "phone", variant);
    const { phone: tablet } = await phone(world, server, "tablet", variant);
    device.store.put("workout", "w1", workout("v1"));
    await device.sync();
    await tablet.sync();
    const first = join(world.directory, "first.db");
    await server.snapshot("alice", first);
    tablet.store.put("workout", "w1", workout("tablet edit"));
    await tablet.sync();
    expect(tablet.store.get("workout", "w1")?.server?.revision).toBe(2);
    const tabletLineage = tablet.store.syncState().lineage;

    await server.restoreWithCommand("alice", first);
    device.store.put("workout", "w5", workout("p5"));
    device.store.put("workout", "w6", workout("p6"));
    await device.sync();
    await device.sync();
    const second = join(world.directory, "second.db");
    await server.snapshot("alice", second);
    await server.restoreWithCommand("alice", second);
    const hello = await new Peer1(server.transport("alice")).hello();
    // The second backup came from the first restore's history, not from the tablet's.
    expect(hello.restoredFrom).toMatchObject({ restorePoint: 3 });
    expect((hello.restoredFrom as { lineage: string }).lineage).not.toBe(tabletLineage);

    await tablet.sync();
    await tablet.sync();
    expect(tablet.store.get("workout", "w1")).toMatchObject({
      status: "conflict",
      content: { title: "tablet edit" },
      server: { content: { title: "v1" } },
    });
    expect(tablet.store.problems().map((r) => r.id)).toEqual(["w1"]);
  });
}

/**
 * Reviewer's reproducer: a tablet still holding a workout deleted before the backup. After the
 * restore the deletion is the user's to confirm, with the untouched entry and set; the bulk choice
 * then takes it, and nothing counts as unsynced.
 */
export function checkRestoredDeletedTree(variant: Variant = {}): Promise<void> {
  return inWorld(async (world) => {
    const server = world.server(serverOptions(variant));
    const { phone: device } = await phone(world, server, "phone", variant);
    const { phone: tablet } = await phone(world, server, "tablet", variant);
    device.store.put("workout", "w3", workout("three"));
    device.store.put("workout_exercise", "e3", {
      workoutId: "w3",
      exerciseId: "squat",
      exerciseName: "Squat",
      exerciseType: "weight_reps",
      position: 1,
      supersetId: null,
      restSeconds: 90,
      notes: [],
      doubleDumbbellVolume: false,
    });
    device.store.put("workout_set", "s3", {
      workoutExerciseId: "e3",
      position: 1,
      type: "normal",
      weightKg: 80,
      reps: 5,
      distanceMeters: null,
      durationSeconds: null,
      count: null,
      rpe: null,
      completedAt: null,
    });
    await device.sync();
    await tablet.sync();
    device.store.delete("workout", "w3");
    await device.sync();
    const backup = join(world.directory, "backup.db");
    await server.snapshot("alice", backup);
    device.store.put("workout", "w9", workout("later"));
    await device.sync();
    await server.restoreWithCommand("alice", backup);

    await tablet.sync();
    await tablet.sync();
    expect(tablet.store.problems().map((r) => [r.kind, r.id, r.problem?.reason])).toEqual([
      ["workout", "w3", "deleted"],
      ["workout_exercise", "e3", "deleted"],
      ["workout_set", "s3", "deleted"],
    ]);
    tablet.store.resolveRestored();
    expect(tablet.store.problems()).toEqual([]);
    expect(tablet.store.list("workout")).toEqual([]);
    expect(tablet.store.list("workout_set")).toEqual([]);
    expect(tablet.store.hasUnsyncedWork()).toBe(false);
  });
}
