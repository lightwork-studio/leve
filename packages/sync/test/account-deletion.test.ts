import type { ServerStorage } from "@leve/storage/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry, set, workout } from "./support/content.ts";
import { expectSynced, type ServerHarness, World } from "./support/harness.ts";

/*
 * Deleting an account: the server refuses it from then on, and a phone that hears so keeps what it
 * shows as data that never synced, which can join another account later. Expected results are
 * written out literally.
 */

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

/** A server whose storage can delete accounts, as a managed server's can. */
function erasingServer() {
  const erased: string[] = [];
  const server = world.server({
    wrapStorage: (storage) =>
      ({
        account: (id: string) => storage.account(id),
        deleteAccount: async (id: string) => {
          erased.push(id);
        },
      }) as unknown as ServerStorage,
  });
  return { server, erased };
}

const live = async (server: ServerHarness, account: string) =>
  (await server.rows(account))
    .filter((row) => row.state === "live")
    .map((row) => [row.kind, row.id, (row.content as { title?: string } | null)?.title ?? null])
    .sort();

const shown = (store: { list(kind: string): { id: string; content: unknown }[] }, kind: string) =>
  store
    .list(kind)
    .map((record) => [record.id, (record.content as { title?: string }).title ?? null])
    .sort();

describe("deleting an account", () => {
  it("is refused afterwards, also for a download waiting at the time", async () => {
    const { server, erased } = erasingServer();
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    phone.store.put("workout", "w1", workout("Legs"));
    expectSynced(await phone.sync());
    const lineage = phone.store.syncState().lineage;

    const waiting = server.service.pull("alice", {
      release: "1.0",
      lineage,
      cursor: phone.store.syncState().cursor,
      waitMs: 20_000,
    });
    expect(await server.service.deleteAccount("alice")).toEqual({
      status: 200,
      body: { deleted: true },
    });
    expect(erased).toEqual(["alice"]);
    const gone = { status: 410, body: { error: { code: "account_deleted" } } };
    expect(await waiting).toMatchObject(gone);
    expect(await server.service.hello("alice", { releases: ["1.0"], app: "t" })).toMatchObject(
      gone,
    );
    expect(
      await server.service.push("alice", { release: "1.0", lineage, submissions: [] }),
    ).toMatchObject(gone);
    // Other accounts are untouched.
    expect((await server.service.hello("bob", { releases: ["1.0"], app: "t" })).status).toBe(200);
  });

  it("is refused by a server that can't delete accounts", async () => {
    const server = world.server();
    expect(await server.service.deleteAccount("alice")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
  });

  it("leaves a phone that hears of it with what it showed, as data that never synced", async () => {
    const { server } = erasingServer();
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    const other = await world.phone("other", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    phone.store.put("workout", "w1", workout("Legs"));
    phone.store.put("workout_exercise", "e1", entry("w1", "Squat"));
    phone.store.put("workout_set", "s1", set("e1"));
    phone.store.put("workout", "w2", workout("Push"));
    phone.store.put("workout", "w3", workout("Pull"));
    phone.store.put("workout", "w4", workout("Arms"));
    phone.store.put("routine_folder", "f1", { title: "Strength", position: 1 });
    expectSynced(await phone.sync());
    expectSynced(await other.sync());

    // A conflict (the phone keeps its own version), a deletion made elsewhere, a deletion made
    // here that never went up, an edit still pending, and one waiting in the outbox.
    other.store.put("workout", "w2", workout("Push (other)"));
    other.store.delete("workout", "w3");
    expectSynced(await other.sync());
    phone.store.put("workout", "w2", workout("Push (mine)"));
    expect((await phone.sync()).state).toBe("synced");
    expect(phone.store.get("workout", "w2")?.status).toBe("conflict");
    phone.store.delete("workout", "w4");
    phone.store.put("workout", "w1", workout("Legs (edited)"));
    phone.store.put("routine_folder", "f2", { title: "New folder", position: 2 });
    phone.store.prepareSubmissions("1.0");
    expect(phone.store.summary().inFlight).toBeGreaterThan(0);

    await server.service.deleteAccount("alice");
    expect(await phone.sync()).toEqual({ state: "account_deleted" });
    // The app forgets the account once it hears so (see the app's sync session).
    phone.store.forgetAccount();

    expect(phone.store.syncState()).toMatchObject({
      server: null,
      account: null,
      cursor: 0,
      lineage: null,
      restoring: false,
    });
    expect(shown(phone.store, "workout")).toEqual([
      ["w1", "Legs (edited)"],
      ["w2", "Push (mine)"],
    ]);
    expect(phone.store.list("workout_exercise").map((record) => record.id)).toEqual(["e1"]);
    expect(phone.store.list("workout_set").map((record) => record.id)).toEqual(["s1"]);
    expect(shown(phone.store, "routine_folder")).toEqual([
      ["f1", "Strength"],
      ["f2", "New folder"],
    ]);
    // Deletions and the account's other copies are gone; every kept record waits to go up as new.
    expect(phone.store.get("workout", "w3")).toBeNull();
    expect(phone.store.get("workout", "w4")).toBeNull();
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.summary()).toMatchObject({ conflict: 0, inFlight: 0, pending: 6 });
    expect(phone.store.get("workout", "w1")).toMatchObject({ server: null, baseRevision: null });

    // Signing in with another account brings it all there, as for any phone that never synced.
    await phone.restart({ server: "s", account: "bob", transport: server.transport("bob") });
    expectSynced(await phone.sync());
    expect(await live(server, "bob")).toEqual([
      ["routine_folder", "f1", "Strength"],
      ["routine_folder", "f2", "New folder"],
      ["workout", "w1", "Legs (edited)"],
      ["workout", "w2", "Push (mine)"],
      ["workout_exercise", "e1", null],
      ["workout_set", "s1", null],
    ]);
    expect(phone.store.summary()).toMatchObject({ pending: 0, conflict: 0, inFlight: 0 });
  });

  it("changes nothing on a phone that never synced", async () => {
    const server = world.server();
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    phone.store.put("workout", "w1", workout("Legs"));
    const before = phone.store.get("workout", "w1");
    phone.store.forgetAccount();
    expect(phone.store.get("workout", "w1")).toEqual(before);
  });
});
