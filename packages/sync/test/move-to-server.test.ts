import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncClient } from "../src/client/sync-client.ts";
import { entry, set, workout } from "./support/content.ts";
import { expectSynced, type ServerHarness, World } from "./support/harness.ts";

/*
 * Bringing a phone's data along to another server (or account) instead of starting from what the
 * new one holds: the move only rebinds the phone, and the new server's lineage makes it reset as
 * after a server restore. Expected results are written out literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

const live = async (server: ServerHarness, account: string) =>
  (await server.rows(account))
    .filter((row) => row.state === "live")
    .map((row) => [row.kind, row.id, (row.content as { title?: string } | null)?.title ?? null])
    .sort();

/** A phone that synced a workout with an entry and a set to `old`, as alice. */
async function syncedPhone() {
  const old = world.server();
  const phone = await world.phone("phone", {
    account: "alice",
    server: "old",
    transport: old.transport("alice"),
  });
  phone.store.put("workout", "w1", workout("Legs"));
  phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
  phone.store.put("workout_set", "s1", set("e1"));
  expectSynced(await phone.sync());
  return { old, phone };
}

describe("moving a phone's data to another server", () => {
  it("brings everything to an empty account, and the old server keeps its copy", async () => {
    const { old, phone } = await syncedPhone();
    const next = world.server();
    phone.store.moveTo("new", "bob");
    await phone.restart({ server: "new", account: "bob", transport: next.transport("bob") });
    expectSynced(await phone.sync());
    expectSynced(await phone.sync());

    const tree = [
      ["workout", "w1", "Legs"],
      ["workout_exercise", "e1", null],
      ["workout_set", "s1", null],
    ];
    expect(await live(next, "bob")).toEqual(tree);
    expect(await live(old, "alice")).toEqual(tree);
    expect(phone.store.syncState()).toMatchObject({ server: "new", account: "bob" });
    expect(phone.store.summary()).toMatchObject({ pending: 0, conflict: 0, inFlight: 0 });
    expect(phone.store.problems()).toEqual([]);
  });

  it.each([false, true])(
    "combines both accounts even when the destination's cursor is higher (shared lineage: %s)",
    async (sharedLineage) => {
      const { phone } = await syncedPhone();
      const next = world.server();
      const other = await world.phone("other", {
        account: "bob",
        server: "new",
        transport: next.transport("bob"),
      });
      const before = phone.store.syncState();
      if (sharedLineage) {
        // A copy of an account database can leave two servers reporting the same lineage.
        (await next.storage.account("bob")).db.run("UPDATE account SET lineage = ?", [
          before.lineage,
        ]);
      }
      const existing = ["w6", "w7", "w8", "w9"];
      for (const id of existing) other.store.put("workout", id, workout(id));
      expectSynced(await other.sync());
      expect(await next.head("bob")).toBeGreaterThan(before.cursor);

      phone.store.moveTo("new", "bob");
      await phone.restart({ server: "new", account: "bob", transport: next.transport("bob") });
      expectSynced(await phone.sync());
      expect((await live(next, "bob")).map((row) => row[1]).sort()).toEqual([
        "e1",
        "s1",
        "w1",
        ...existing,
      ]);
      expect(
        phone.store
          .list("workout")
          .map((w) => w.id)
          .sort(),
      ).toEqual(["w1", ...existing]);
      expect(phone.store.problems()).toEqual([]);
    },
  );

  it("keeps the old binding, cursor and records if a parent cannot be read", async () => {
    const { phone } = await syncedPhone();
    phone.store.applyPull([{ state: "unavailable", kind: "workout", id: "w1", revision: 4 }], 4);
    const before = phone.store.syncState();
    expect(phone.store.hasUnavailableRecords()).toBe(true);
    expect(() => phone.store.moveTo("new", "bob")).toThrow("update Leve");
    expect(phone.store.syncState()).toEqual(before);
    expect(phone.store.get("workout", "w1")?.unavailable).toBe(true);
    expect(phone.store.get("workout_exercise", "e1")).not.toBeNull();
  });

  it("ignores a hello from the original server that arrives after the move", async () => {
    const { old, phone } = await syncedPhone();
    const next = world.server();
    const oldTransport = old.transport("alice");
    const requested = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const oldClient = new SyncClient({
      store: phone.store,
      server: "old",
      account: "alice",
      app: "test",
      transport: async (path, body) => {
        const reply = await oldTransport(path, body);
        requested.resolve();
        await released.promise;
        return reply;
      },
    });
    const oldSync = oldClient.sync();
    await requested.promise;
    phone.store.moveTo("new", "bob");
    released.resolve();

    expect(await oldSync).toMatchObject({ state: "offline" });
    expect(phone.store.syncState()).toMatchObject({ server: "new", account: "bob", lineage: null });
    await phone.restart({ server: "new", account: "bob", transport: next.transport("bob") });
    expectSynced(await phone.sync());
    expect(await live(next, "bob")).toContainEqual(["workout", "w1", "Legs"]);
  });

  it("brings changes that hadn't synced, without asking anything", async () => {
    const { old, phone } = await syncedPhone();
    phone.store.put("workout", "w1", workout("Legs, heavier"));
    phone.store.put("workout", "w2", workout("Arms"));
    const next = world.server();
    phone.store.moveTo("new", "bob");
    await phone.restart({ server: "new", account: "bob", transport: next.transport("bob") });
    expectSynced(await phone.sync());
    expectSynced(await phone.sync());

    // The new server never had w1, so the edited version simply arrives there.
    expect(await live(next, "bob")).toEqual([
      ["workout", "w1", "Legs, heavier"],
      ["workout", "w2", "Arms"],
      ["workout_exercise", "e1", null],
      ["workout_set", "s1", null],
    ]);
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.summary()).toMatchObject({ pending: 0, conflict: 0, inFlight: 0 });
    // The old server never saw those changes.
    expect(await live(old, "alice")).toContainEqual(["workout", "w1", "Legs"]);
  });

  it("is only for a phone that synced before; one that never did connects as it is", async () => {
    const phone = await world.phone("fresh", {
      account: "alice",
      server: "old",
      transport: world.server().transport("alice"),
    });
    expect(() => phone.store.moveTo("new", "bob")).toThrow("never synced");
  });
});
