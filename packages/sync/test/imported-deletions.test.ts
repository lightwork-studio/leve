import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEVY_WORKOUT_ID_PREFIX } from "@leve/contract";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { afterEach, expect, it } from "vitest";
import { SyncClient } from "../src/index.ts";
import { SyncService, serviceTransport } from "../src/server/index.ts";

const engine = createNodeSqliteEngine();
const dirs: string[] = [];
const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T = "2026-11-10T18:00:00.000Z";
const IMPORTED = `${HEVY_WORKOUT_ID_PREFIX}202611101800:1`;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "leve-import-"));
  dirs.push(dir);
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "server-test" });
  open.push(storage);
  const service = new SyncService({ storage });
  let ids = 0;
  const phone = async (name: string) => {
    const store = await openDeviceStore({
      engine,
      path: join(dir, `${name}.db`),
      appVersion: "app-test",
      randomId: () => `${name}-${++ids}`,
    });
    open.push(store);
    return store;
  };
  const sync = (store: DeviceStore) =>
    new SyncClient({
      store,
      transport: serviceTransport(service, "alice"),
      server: "s",
      account: "alice",
      app: "t",
    }).sync();
  return { phone, sync };
}

/** The records an import of one workout with one set writes, under the given workout id. */
function importWorkout(store: DeviceStore, id: string) {
  store.putMany([
    { kind: "workout", id, content: { title: "Push", startedAt: T, endedAt: T, routineId: null } },
    {
      kind: "workout_exercise",
      id: `${id}:e:1`,
      content: {
        workoutId: id,
        exerciseId: "builtin:barbell-bench-press",
        exerciseName: "Bench Press",
        exerciseType: "weight_reps",
        position: 1,
        supersetId: null,
        restSeconds: 0,
        doubleDumbbellVolume: false,
      },
    },
    {
      kind: "workout_set",
      id: `${id}:e:1:s:1`,
      content: {
        workoutExerciseId: `${id}:e:1`,
        position: 1,
        type: "normal",
        weightKg: 80,
        reps: 5,
        completedAt: T,
      },
    },
  ]);
}

it("keeps an imported workout deleted on the server when another phone imports it too", async () => {
  const { phone, sync } = await setup();
  const first = await phone("first");
  importWorkout(first, IMPORTED);
  // Deleted before it ever synced. The deletion still goes to the server, because another phone
  // can import the same file and would otherwise bring the workout back.
  first.delete("workout", IMPORTED);
  expect(first.list("workout_set")).toEqual([]);
  expect(await sync(first)).toMatchObject({ state: "synced", pushed: 1 });

  const second = await phone("second");
  importWorkout(second, IMPORTED);
  await sync(second);
  expect(second.get("workout", IMPORTED)).toMatchObject({
    status: "conflict",
    server: { state: "deleted" },
  });

  // A phone that starts from the account holds the deletion, so an import there skips the workout.
  const later = await phone("later");
  await sync(later);
  expect(later.get("workout", IMPORTED)).toMatchObject({ deleted: true, status: "synced" });
  expect(later.list("workout")).toEqual([]);
  expect(later.list("workout_set")).toEqual([]);
});

it("still forgets a deleted workout that never synced when it was not imported", async () => {
  const { phone, sync } = await setup();
  const store = await phone("only");
  importWorkout(store, "w1");
  store.delete("workout", "w1");
  expect(store.get("workout", "w1")).toBeNull();
  expect(store.summary()).toMatchObject({ pending: 0, inFlight: 0 });
  expect(await sync(store)).toMatchObject({ state: "synced", pushed: 0 });
});
