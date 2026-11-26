import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("adds the phone's data to an account that already has some", async () => {
    const { phone } = await syncedPhone();
    const next = world.server();
    const other = await world.phone("other", {
      account: "bob",
      server: "new",
      transport: next.transport("bob"),
    });
    other.store.put("workout", "w9", workout("Push"));
    expectSynced(await other.sync());

    phone.store.moveTo("new", "bob");
    await phone.restart({ server: "new", account: "bob", transport: next.transport("bob") });
    expectSynced(await phone.sync());
    expectSynced(await phone.sync());
    expect((await live(next, "bob")).map((row) => row[1]).sort()).toEqual(["e1", "s1", "w1", "w9"]);
    expect(
      phone.store
        .list("workout")
        .map((w) => w.id)
        .sort(),
    ).toEqual(["w1", "w9"]);
    expect(phone.store.problems()).toEqual([]);
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
