import { join } from "node:path";
import { expect, it } from "vitest";
import { HistoricalPeer } from "../../contract/history/1.0/peer.ts";
import { previewContract, previewFrozen } from "../../contract/test/support/preview-contract.ts";
import { entry, set, workout } from "./support/content.ts";
import { FaultyTransport, World } from "./support/harness.ts";

it("preserves zero reserve across an older peer correction and syncs an explicit clear after re-upgrade", async () => {
  const w = new World(previewContract);
  try {
    const server = w.server();
    const transport = server.transport("alice");
    const phone = await w.phone("device", { server: "s", account: "alice", transport });
    phone.store.put("workout", "w", workout("Push"));
    phone.store.put("workout_exercise", "e", entry("w", "Press"));
    phone.store.put("workout_set", "s", set("e", { repsInReserve: 0, rpe: 8 }));
    await phone.sync();
    const reader = await w.phone("second", { server: "s", account: "alice", transport });
    await reader.sync();
    await reader.restart();
    expect(reader.store.get("workout_set", "s")?.content?.repsInReserve).toBe(0);
    const old = new HistoricalPeer(previewFrozen("1.1"), transport);
    await old.hello();
    const rows = await old.pull();
    expect(rows.find((row) => row.id === "s")?.content).not.toHaveProperty("repsInReserve");
    await old.push([old.put("workout_set", "s", set("e", { reps: 9, rpe: 8, planSlot: null }))]);
    expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
      repsInReserve: 0,
      reps: 9,
      rpe: 8,
    });
    await phone.sync();
    await server.restart({ releases: ["1.1"] });
    await phone.sync();
    expect(phone.client.featureAvailable("reps_in_reserve")).toBe(false);
    phone.store.put("workout_set", "s", set("e", { reps: 9, rpe: 8, repsInReserve: null }));
    await phone.sync();
    expect(phone.store.get("workout_set", "s")?.status).toBe("partial");
    await phone.restart();
    await server.restart({ releases: ["1.2"] });
    await phone.sync();
    expect(phone.client.featureAvailable("reps_in_reserve")).toBe(true);
    expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
      repsInReserve: null,
      reps: 9,
      rpe: 8,
    });
    await reader.sync();
    expect(reader.store.get("workout_set", "s")?.content?.repsInReserve).toBeNull();
  } finally {
    await w.dispose();
  }
});

it.each(["acknowledged", "in flight"])(
  "sends each withheld field when its own release arrives (%s)",
  async (stage) => {
    const w = new World(previewContract);
    try {
      const server = w.server({ releases: ["1.0"] });
      const phone = await w.phone("device", {
        server: "s",
        account: "alice",
        transport: server.transport("alice"),
      });
      phone.store.put("workout", "w", workout("Push"));
      phone.store.put("workout_exercise", "e", entry("w", "Press"));
      await phone.sync();
      const slot = { exercise: 1, set: 2 };
      phone.store.put("workout_set", "s", set("e", { planSlot: slot, repsInReserve: 0 }));
      if (stage === "in flight") expect(phone.store.prepareSubmissions("1.0")).toHaveLength(1);
      else await phone.sync();
      await phone.restart();
      await server.restart({ releases: ["1.0", "1.1"] });
      await phone.sync();
      expect((await server.row("alice", "workout_set", "s"))?.content?.planSlot).toEqual(slot);
      expect(phone.store.get("workout_set", "s")).toMatchObject({
        status: "partial",
        partialFields: ["repsInReserve"],
      });
      await server.restart({ releases: ["1.2"] });
      await phone.sync();
      expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
        planSlot: slot,
        repsInReserve: 0,
      });
    } finally {
      await w.dispose();
    }
  },
);

it.each(["pending", "synced", "kept on older peer", "identical backup"])(
  "keeps a %s clear for review across an older-release restore",
  async (stage) => {
    const w = new World(previewContract);
    try {
      const server = w.server();
      const phone = await w.phone("device", {
        server: "s",
        account: "alice",
        transport: server.transport("alice"),
      });
      phone.store.put("workout", "w", workout("Push"));
      phone.store.put("workout_exercise", "e", entry("w", "Press"));
      phone.store.put("workout_set", "s", set("e", { repsInReserve: 0 }));
      await phone.sync();
      const backup = join(w.directory, "before-clear.db");
      await server.snapshot("alice", backup);
      phone.store.put("workout_set", "s", set("e", { repsInReserve: null }));
      if (stage === "synced" || stage === "identical backup") await phone.sync();
      if (stage === "identical backup") await server.snapshot("alice", backup);
      await server.restart({ releases: ["1.1"] });
      await server.restoreWithCommand("alice", backup);
      await phone.sync();
      expect(phone.store.get("workout_set", "s")).toMatchObject({
        status: "conflict",
        content: { repsInReserve: null },
      });
      if (stage === "kept on older peer") {
        phone.store.resolve("workout_set", "s", { choice: "keep_mine" });
        await phone.sync();
        expect(phone.store.get("workout_set", "s")).toMatchObject({
          status: "partial",
          partialFields: ["repsInReserve"],
        });
        phone.store.put("workout_set", "s", set("e", { reps: 11, repsInReserve: null }));
        await phone.sync();
      }
      await phone.restart();
      await server.restart({ releases: ["1.2"] });
      await phone.sync();
      if (stage === "identical backup") {
        expect(phone.store.get("workout_set", "s")).toMatchObject({
          status: "synced",
          content: { repsInReserve: null },
        });
        expect((await server.row("alice", "workout_set", "s"))?.content?.repsInReserve).toBeNull();
        return;
      }
      expect(phone.store.get("workout_set", "s")).toMatchObject({
        status: "conflict",
        content: { repsInReserve: null },
        server: { content: { repsInReserve: 0 } },
      });
      if (stage === "kept on older peer") {
        // The restored older peer could not show RIR. The visible reps edit
        // arrived there, and the first richer copy now exposes the competing 0.
        expect((await server.row("alice", "workout_set", "s"))?.content).toMatchObject({
          reps: 11,
          repsInReserve: 0,
        });
      }
      phone.store.resolve("workout_set", "s", { choice: "keep_mine" });
      await phone.sync();
      expect((await server.row("alice", "workout_set", "s"))?.content?.repsInReserve).toBeNull();
    } finally {
      await w.dispose();
    }
  },
);

it("retains a clear made before the first rich upload when its reply is lost and an older backup is restored", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const net = new FaultyTransport(transport);
    const opts = { server: "s", account: "alice", transport };
    const a = await world.phone("a", { ...opts, transport: net.call });
    a.store.put("workout", "w", workout("Push"));
    a.store.put("workout_exercise", "e", entry("w", "Press"));
    await a.sync();
    a.store.put("workout_set", "s", set("e", { repsInReserve: 2 }));
    a.store.put("workout_set", "s", set("e", { repsInReserve: null }));
    net.next("lose_reply", "/sync/push");
    await a.sync();
    const b = await world.phone("b", opts);
    await b.sync();
    b.store.put("workout_set", "s", set("e", { repsInReserve: 3 }));
    await b.sync();
    const backup = join(world.directory, "after-edit.db");
    await server.snapshot("alice", backup);
    await server.restart({ releases: ["1.1"] });
    await server.restoreWithCommand("alice", backup);
    await a.restart();
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { repsInReserve: null },
      partialFields: expect.arrayContaining(["repsInReserve"]),
    });
    await server.restart({ releases: ["1.2"] });
    await a.sync();
    expect(a.store.get("workout_set", "s")).toMatchObject({
      status: "conflict",
      content: { repsInReserve: null },
      server: { content: { repsInReserve: 3 } },
    });
  } finally {
    await world.dispose();
  }
});
