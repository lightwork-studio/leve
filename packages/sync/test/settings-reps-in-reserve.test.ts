import type { JsonObject } from "@leve/contract";
import { afterEach, describe, expect, it } from "vitest";
import { HistoricalPeer } from "../../contract/history/1.0/peer.ts";
import { previewContract, previewFrozen } from "../../contract/test/support/preview-contract.ts";
import { Peer1 } from "./support/content.ts";
import { engine, expectSynced, type Phone, type ServerHarness, World } from "./support/harness.ts";

/*
 * The settings record's switch for asking about reps in reserve after each logged set. It is an
 * optional field: off unless set, kept when an app without it edits the other settings, and a copy
 * saved before it existed still works.
 */

const SETTINGS: JsonObject = {
  weightUnit: "kg",
  distanceUnit: "km",
  shortDistanceUnit: "m",
  measurementUnit: "cm",
  firstWeekday: 1,
  defaultRestSeconds: 90,
  rpeEnabled: false,
  countWarmups: false,
  previousValues: "any_workout",
  autoUpdateRoutineValues: true,
};

let world: World;
afterEach(async () => {
  await world.dispose();
});

const phoneOn = (server: ServerHarness, name: string) =>
  world.phone(name, { server: "s", account: "alice", transport: server.transport("alice") });

const stored = (phone: Phone) => phone.store.get("settings", "settings");
const onServer = async (server: ServerHarness) =>
  (await server.row("alice", "settings", "settings"))?.content as JsonObject | undefined;

/** Rewrites the settings copies a database holds, as a build from before the setting saved them. */
function withoutField(path: string, columns: string[]) {
  const db = engine.open(path);
  try {
    for (const column of columns) {
      db.run(
        `UPDATE records SET ${column} = json_remove(${column}, '$.trackRepsInReserve')
         WHERE kind = 'settings' AND ${column} IS NOT NULL`,
      );
    }
  } finally {
    db.close();
  }
}

describe("tracking reps in reserve", () => {
  it("syncs between two phones, through a restart, with off as a value of its own", async () => {
    world = new World();
    const server = world.server();
    const first = await phoneOn(server, "first");
    first.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: true });
    expectSynced(await first.sync());
    expect(first.client.featureAvailable("track_reps_in_reserve")).toBe(true);
    expect(await onServer(server)).toMatchObject({ trackRepsInReserve: true });

    const second = await phoneOn(server, "second");
    expectSynced(await second.sync());
    await second.restart();
    expect(stored(second)?.content?.trackRepsInReserve).toBe(true);

    // Editing another setting on the second phone keeps it.
    second.store.put("settings", "settings", {
      ...(stored(second)?.content as JsonObject),
      countWarmups: true,
    });
    expectSynced(await second.sync());
    expectSynced(await first.sync());
    expect(stored(first)?.content).toMatchObject({ countWarmups: true, trackRepsInReserve: true });

    // Turning it off is stored as off, not as cleared.
    first.store.put("settings", "settings", {
      ...(stored(first)?.content as JsonObject),
      trackRepsInReserve: false,
    });
    expectSynced(await first.sync());
    expectSynced(await second.sync());
    await second.restart();
    expect(stored(second)?.content?.trackRepsInReserve).toBe(false);
    expect((await onServer(server))?.trackRepsInReserve).toBe(false);
  });

  it("rejects a value that isn't true, false or null without storing it", async () => {
    world = new World();
    const server = world.server();
    const phone = await phoneOn(server, "phone");
    phone.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: true });
    expectSynced(await phone.sync());
    const before = await server.row("alice", "settings", "settings");

    const peer = new Peer1(server.transport("alice"), "peer");
    await peer.hello();
    await peer.pull();
    for (const value of ["yes", 1, 0, "false", {}]) {
      const valid = peer.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: true });
      expect(
        await peer.push([{ ...valid, content: { ...SETTINGS, trackRepsInReserve: value } }]),
        JSON.stringify(value),
      ).toMatchObject({ results: [{ status: "invalid", code: "invalid_content" }] });
    }
    // Content carries every field of its release; leaving this one out is not allowed.
    const full = peer.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: null });
    expect(await peer.push([{ ...full, content: SETTINGS }])).toMatchObject({
      results: [{ status: "invalid", code: "invalid_content" }],
    });
    expect(await server.row("alice", "settings", "settings")).toEqual(before);
    expect(() =>
      phone.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: "on" }),
    ).toThrow(/trackRepsInReserve/);
  });

  it("is kept when an app without the setting edits the other settings, and refused from it", async () => {
    world = new World(previewContract);
    const server = world.server();
    const phone = await phoneOn(server, "phone");
    phone.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: true });
    expectSynced(await phone.sync());

    const older = new HistoricalPeer(previewFrozen("1.2"), server.transport("alice"));
    await older.hello();
    const copy = (await older.pull()).find((row) => row.kind === "settings");
    expect(copy?.content).not.toHaveProperty("trackRepsInReserve");
    expect(
      await older.push([older.put("settings", "settings", { ...SETTINGS, countWarmups: true })]),
    ).toMatchObject({ results: [{ status: "accepted" }] });
    const edit = older.put("settings", "settings", { ...SETTINGS, countWarmups: true });
    expect(
      await older.push([
        { ...edit, content: { ...(edit.content as JsonObject), trackRepsInReserve: false } },
      ]),
    ).toMatchObject({ results: [{ status: "invalid", code: "invalid_content" }] });
    expect(await onServer(server)).toMatchObject({ countWarmups: true, trackRepsInReserve: true });

    expectSynced(await phone.sync());
    expect(stored(phone)?.content).toMatchObject({ countWarmups: true, trackRepsInReserve: true });
  });

  it("is off for entry on a server without it, and a change made then is sent in full later", async () => {
    world = new World(previewContract);
    const server = world.server();
    const phone = await phoneOn(server, "phone");
    phone.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: null });
    expectSynced(await phone.sync());
    await server.restart({ releases: ["1.0", "1.1", "1.2"] });
    expectSynced(await phone.sync());
    expect(phone.client.featureAvailable("track_reps_in_reserve")).toBe(false);

    phone.store.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: true });
    await phone.sync();
    expect(stored(phone)).toMatchObject({
      status: "partial",
      partialFields: ["trackRepsInReserve"],
    });
    expect((await onServer(server))?.trackRepsInReserve ?? null).toBeNull();

    await phone.restart();
    await server.restart({});
    expectSynced(await phone.sync());
    expect(phone.client.featureAvailable("track_reps_in_reserve")).toBe(true);
    expect((await onServer(server))?.trackRepsInReserve).toBe(true);
    expect(stored(phone)?.status).toBe("synced");
  });

  it("reads copies saved before the setting existed as not set, on the server and on a phone", async () => {
    world = new World();
    const server = world.server();
    const phone = await phoneOn(server, "phone");
    phone.store.put("settings", "settings", SETTINGS);
    expectSynced(await phone.sync());
    const revision = (await server.row("alice", "settings", "settings"))?.revision;

    await server.stop();
    withoutField(server.dbPath("alice"), ["content"]);
    await server.restart({});
    phone.close();
    withoutField(phone.path, ["server_content", "local_content"]);
    await phone.open();
    expect(await onServer(server)).not.toHaveProperty("trackRepsInReserve");
    expect(stored(phone)?.content).not.toHaveProperty("trackRepsInReserve");
    expect(stored(phone)?.status).toBe("synced");

    // A new phone downloads the old copy with the setting not set.
    const fresh = await phoneOn(server, "fresh");
    expectSynced(await fresh.sync());
    expect(stored(fresh)?.content?.trackRepsInReserve ?? null).toBeNull();

    // Offering the same settings again, as after a restore, matches the old copy.
    const peer = new Peer1(server.transport("alice"), "peer");
    await peer.hello();
    expect(
      await peer.push([
        peer.put("settings", "settings", { ...SETTINGS, trackRepsInReserve: null }),
      ]),
    ).toMatchObject({ results: [{ status: "accepted", revision }] });

    // The phone holding the old copy edits it and turns the setting on.
    phone.store.put("settings", "settings", {
      ...(stored(phone)?.content as JsonObject),
      trackRepsInReserve: true,
    });
    expectSynced(await phone.sync());
    expectSynced(await fresh.sync());
    expect(stored(fresh)?.content?.trackRepsInReserve).toBe(true);
  });
});
