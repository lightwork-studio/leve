import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { afterEach, describe, expect, it } from "vitest";
import { HistoricalPeer, loadContract } from "../../contract/history/1.0/peer.ts";
import { SyncClient } from "../src/index.ts";
import { SyncService, serviceTransport } from "../src/server/index.ts";

const engine = createNodeSqliteEngine();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let ids = 0;
const nextId = () => `id-${++ids}`;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "leve-sync-"));
  dirs.push(dir);
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "server-test" });
  const service = new SyncService({ storage });
  const openPhone = () =>
    openDeviceStore({
      engine,
      path: join(dir, "phone.db"),
      appVersion: "app-test",
      randomId: nextId,
    });
  const client = (store: Awaited<ReturnType<typeof openPhone>>) =>
    new SyncClient({
      store,
      transport: serviceTransport(service, "alice"),
      server: "s",
      account: "alice",
      app: "t",
    });
  return { storage, service, openPhone, client };
}

const T = "2026-11-10T18:00:00.000Z";

describe("smoke", () => {
  it("records offline, survives restart, syncs, rejects a stale edit and resolves it", async () => {
    const { openPhone, client, service, storage } = await setup();
    let phone = await openPhone();
    phone.put("workout", "w1", { title: "Push", description: "", startedAt: T, endedAt: null });
    phone.put("workout_exercise", "e1", {
      workoutId: "w1",
      exerciseId: "bench",
      exerciseName: "Bench",
      exerciseType: "weight_reps",
      position: 1,
      restSeconds: 90,
      notes: [],
      doubleDumbbellVolume: false,
    });
    phone.put("workout_set", "s1", {
      workoutExerciseId: "e1",
      position: 1,
      type: "normal",
      weightKg: 80,
      reps: 5,
    });
    phone.close();

    phone = await openPhone();
    expect(phone.activeWorkout()?.id).toBe("w1");
    expect(await client(phone).sync()).toMatchObject({ state: "synced", pushed: 3 });
    expect(phone.summary()).toMatchObject({ pending: 0, inFlight: 0 });

    // A second writer (an old 1.0 client) changes the set.
    const peer = new HistoricalPeer(
      loadContract(new URL("../../contract/history/1.0/", import.meta.url)),
      serviceTransport(service, "alice"),
    );
    await peer.hello();
    await peer.pull();
    const set = peer.records.get("workout_set/s1");
    await peer.push([peer.put("workout_set", "s1", { ...set?.content, reps: 6 })]);

    // The phone edits the same set from the old revision.
    const before = phone.get("workout_set", "s1");
    phone.put("workout_set", "s1", { ...before?.content, reps: 7 });
    phone.put("workout", "w1", { title: "Push A", description: "", startedAt: T, endedAt: null });
    const outcome = await client(phone).sync();
    expect(outcome.state).toBe("synced");
    expect(phone.get("workout_set", "s1")).toMatchObject({
      status: "conflict",
      content: { reps: 7 },
    });
    expect(phone.get("workout", "w1")?.status).toBe("synced");

    phone.resolve("workout_set", "s1", { choice: "keep_mine" });
    await client(phone).sync();
    expect(phone.get("workout_set", "s1")).toMatchObject({
      status: "synced",
      content: { reps: 7 },
    });
    await peer.pull();
    expect(peer.records.get("workout_set/s1")?.content?.reps).toBe(7);
    phone.close();
    await storage.close();
  });
});
