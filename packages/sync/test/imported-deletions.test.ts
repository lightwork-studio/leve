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

// A Hevy import only adds data. Two phones can import the same file, so records it creates have ids
// derived from the file, and sync settles what the account already has without asking.

const engine = createNodeSqliteEngine();
const dirs: string[] = [];
const open: { close(): unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 18:00 on the wall in Berlin and in New York: the same CSV row, read in two time zones. */
const BERLIN = "2026-11-10T17:00:00.000Z";
const NEW_YORK = "2026-11-10T23:00:00.000Z";
const IMPORTED = `${HEVY_WORKOUT_ID_PREFIX}202611101800:1`;
const SET_2 = `${IMPORTED}:e:1:s:2`;
const NOTE = `${IMPORTED}:e:1:note`;

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

/** What an import of one workout writes, under the given id, read in the given time zone. */
function importWorkout(store: DeviceStore, id: string, at = BERLIN) {
  const set = (position: number, reps: number) => ({
    kind: "workout_set",
    id: `${id}:e:1:s:${position}`,
    content: {
      workoutExerciseId: `${id}:e:1`,
      position,
      type: "normal",
      weightKg: 80,
      reps,
      completedAt: at,
    },
  });
  store.putMany([
    {
      kind: "workout",
      id,
      content: { title: "Push", startedAt: at, endedAt: at, routineId: null },
    },
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
    set(1, 5),
    set(2, 4),
    {
      // Exercise notes have no parent: they outlive the workout they were written in.
      kind: "exercise_note",
      id: `${id}:e:1:note`,
      content: {
        exerciseId: "builtin:barbell-bench-press",
        workoutId: id,
        pinned: false,
        text: "Seat 4",
        createdAt: at,
        agent: null,
      },
    },
  ]);
}

const conflicts = (store: DeviceStore) => store.summary().conflict;

it("keeps the account's copy when another phone imports the same file in another time zone", async () => {
  const { phone, sync } = await setup();
  const berlin = await phone("berlin");
  importWorkout(berlin, IMPORTED, BERLIN);
  await sync(berlin);

  const travelling = await phone("travelling");
  importWorkout(travelling, IMPORTED, NEW_YORK);
  await sync(travelling);
  expect(conflicts(travelling)).toBe(0);
  expect(travelling.summary()).toMatchObject({ pending: 0, inFlight: 0 });
  expect(travelling.get("workout", IMPORTED)?.content).toMatchObject({ startedAt: BERLIN });
  expect(travelling.get("workout_set", SET_2)?.content).toMatchObject({ completedAt: BERLIN });
  expect(travelling.list("workout")).toHaveLength(1);
  expect(travelling.list("workout_set")).toHaveLength(2);
});

it("still asks about an imported record the person changed before it synced", async () => {
  const { phone, sync } = await setup();
  const berlin = await phone("berlin");
  importWorkout(berlin, IMPORTED, BERLIN);
  await sync(berlin);

  const travelling = await phone("travelling");
  importWorkout(travelling, IMPORTED, NEW_YORK);
  const set = travelling.get("workout_set", SET_2)?.content;
  travelling.put("workout_set", SET_2, { ...set, reps: 6 });
  await sync(travelling);
  // The untouched workout takes the account's copy; the edited set is the person's to settle.
  expect(travelling.get("workout", IMPORTED)).toMatchObject({ status: "synced" });
  expect(travelling.get("workout_set", SET_2)).toMatchObject({
    status: "conflict",
    content: { reps: 6 },
  });
  expect(conflicts(travelling)).toBe(1);
});

it("keeps an imported workout deleted when another phone imports it too", async () => {
  const { phone, sync } = await setup();
  const first = await phone("first");
  importWorkout(first, IMPORTED);
  // Deleted before it ever synced. The deletion still goes to the server, because another phone
  // can import the same file and would otherwise bring the workout back.
  first.delete("workout", IMPORTED);
  expect(first.list("workout_set")).toEqual([]);
  // The workout's deletion, and its exercise note, which outlives the workout.
  expect(await sync(first)).toMatchObject({ state: "synced", pushed: 2 });

  const second = await phone("second");
  importWorkout(second, IMPORTED, NEW_YORK);
  await sync(second);
  // The account deleted it, and nothing of the import was changed here: it goes, without asking.
  expect(conflicts(second)).toBe(0);
  expect(second.get("workout", IMPORTED)).toMatchObject({ deleted: true, status: "synced" });
  expect(second.list("workout")).toEqual([]);
  expect(second.list("workout_set")).toEqual([]);
  expect(second.summary()).toMatchObject({ pending: 0, inFlight: 0 });

  // A phone that starts from the account holds the deletion, so an import there skips the workout.
  const later = await phone("later");
  await sync(later);
  expect(later.get("workout", IMPORTED)).toMatchObject({ deleted: true, status: "synced" });
  expect(later.list("workout")).toEqual([]);
});

it("asks before a deletion in the account takes a workout whose import was changed here", async () => {
  const { phone, sync } = await setup();
  const first = await phone("first");
  importWorkout(first, IMPORTED);
  first.delete("workout", IMPORTED);
  await sync(first);

  const second = await phone("second");
  importWorkout(second, IMPORTED);
  const set = second.get("workout_set", SET_2)?.content;
  second.put("workout_set", SET_2, { ...set, reps: 6 });
  await sync(second);
  expect(second.get("workout", IMPORTED)).toMatchObject({ status: "conflict" });
  expect(second.get("workout_set", SET_2)?.content).toMatchObject({ reps: 6 });
});

it("keeps a deleted set and note of an imported workout deleted when another phone imports it", async () => {
  const { phone, sync } = await setup();
  const first = await phone("first");
  importWorkout(first, IMPORTED);
  first.delete("workout_set", SET_2);
  first.delete("exercise_note", NOTE);
  await sync(first);

  const second = await phone("second");
  importWorkout(second, IMPORTED);
  await sync(second);
  expect(conflicts(second)).toBe(0);
  expect(second.get("workout_set", SET_2)).toMatchObject({ deleted: true });
  expect(second.get("exercise_note", NOTE)).toMatchObject({ deleted: true });
  expect(second.list("workout_set").map((record) => record.id)).toEqual([`${IMPORTED}:e:1:s:1`]);

  await sync(first);
  expect(first.list("workout_set").map((record) => record.id)).toEqual([`${IMPORTED}:e:1:s:1`]);
  expect(first.list("exercise_note")).toEqual([]);
});

it("still forgets a deleted workout that never synced when it was not imported", async () => {
  const { phone, sync } = await setup();
  const store = await phone("only");
  importWorkout(store, "w1");
  store.delete("workout", "w1");
  expect(store.get("workout", "w1")).toBeNull();
  // Only the exercise note, which outlives the workout, is left to send.
  expect(store.summary()).toMatchObject({ pending: 1, inFlight: 0 });
  expect(await sync(store)).toMatchObject({ state: "synced", pushed: 1 });
});

it("asks as before when a record that wasn't imported meets the account's copy", async () => {
  const { phone, sync } = await setup();
  const first = await phone("first");
  importWorkout(first, "w1", BERLIN);
  await sync(first);
  const second = await phone("second");
  importWorkout(second, "w1", NEW_YORK);
  await sync(second);
  expect(second.get("workout", "w1")).toMatchObject({ status: "conflict" });
});
