import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@leve/contract";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { SyncClient } from "@leve/sync";
import { SyncService, serviceTransport } from "@leve/sync/server";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conflicts, settleConflict } from "../src/data/conflicts.ts";

/* Real conflicts, made by two phones syncing one account through a real sync service. */

vi.mock("../src/data/ids.ts", () => {
  let id = 0;
  return { newId: () => `copy-${++id}` };
});

const SQL = await initSqlJs();
let directory: string;
let storage: ServerStorage;
let service: SyncService;
let ids = 0;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leve-conflicts-"));
  storage = new ServerStorage({ engine: createNodeSqliteEngine(), directory, appVersion: "test" });
  service = new SyncService({ storage });
});
afterEach(async () => {
  await storage.close();
  rmSync(directory, { recursive: true, force: true });
});

async function phone(name: string) {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/${name}.db`,
    appVersion: "test",
    randomId: () => `${name}-${++ids}`,
  });
  const client = new SyncClient({
    store,
    transport: serviceTransport(service, "alice"),
    server: "s",
    account: "alice",
    app: name,
  });
  const sync = async () => {
    const outcome = await client.sync();
    expect(outcome.state).toBe("synced");
  };
  return { store, sync };
}

const STARTED = "2026-11-24T18:00:00.000Z";
const workout = (title: string): JsonObject => ({
  title,
  startedAt: STARTED,
  endedAt: "2026-11-24T19:00:00.000Z",
  routineId: null,
});
const entry = (workoutId: string): JsonObject => ({
  workoutId,
  exerciseId: "bench-press-barbell",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 90,
  doubleDumbbellVolume: false,
});
const set = (weightKg: number, reps: number): JsonObject => ({
  workoutExerciseId: "e1",
  position: 1,
  type: "normal",
  weightKg,
  reps,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: STARTED,
});

const serverRow = async (kind: string, id: string) =>
  (await storage.account("alice")).db.get("SELECT * FROM records WHERE kind = ? AND id = ?", [
    kind,
    id,
  ]);

/** Two phones that both hold `seed`, synced. */
async function twoPhones(seed: (store: DeviceStore) => void) {
  const a = await phone("a");
  const b = await phone("b");
  seed(a.store);
  await a.sync();
  await b.sync();
  return { a, b };
}

it("settles a routine renamed in two places with the version chosen", async () => {
  const folder = { title: "Push", position: 1 };
  const { a, b } = await twoPhones((store) => store.put("routine_folder", "f1", folder));
  a.store.put("routine_folder", "f1", { ...folder, title: "Push A" });
  b.store.put("routine_folder", "f1", { ...folder, title: "Push B" });
  await a.sync();
  await b.sync();

  const [conflict, ...rest] = conflicts(b.store);
  expect(rest).toEqual([]);
  expect(conflict).toMatchObject({
    key: "routine_folder:f1",
    title: "Push B",
    subtitle: "Folder",
    phone: { lines: [{ label: "Name", value: "Push B" }], choosable: true },
    account: { lines: [{ label: "Name", value: "Push A" }], choosable: true },
  });
  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect(JSON.parse(String((await serverRow("routine_folder", "f1"))?.content)).title).toBe(
    "Push B",
  );
});

it("settles a workout as one: every set that clashes takes the chosen side", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("workout_set", "s2", { ...set(80, 7), position: 2 });
  });
  a.store.put("workout_set", "s1", set(85, 6));
  a.store.put("workout_set", "s2", { ...set(85, 5), position: 2 });
  b.store.put("workout_set", "s1", set(82.5, 8));
  b.store.put("workout_set", "s2", { ...set(82.5, 7), position: 2 });
  await a.sync();
  await b.sync();

  const all = conflicts(b.store);
  expect(all).toHaveLength(1);
  const conflict = all[0]!;
  expect(conflict.key).toBe("workout:w1");
  expect(conflict.title).toBe("Push Day");
  expect(conflict.phone.lines).toEqual([
    { label: "Bench Press · Set 1", value: "82.5 kg × 8" },
    { label: "Bench Press · Set 2", value: "82.5 kg × 7" },
  ]);
  expect(conflict.account.lines).toEqual([
    { label: "Bench Press · Set 1", value: "85 kg × 6" },
    { label: "Bench Press · Set 2", value: "85 kg × 5" },
  ]);

  settleConflict(b.store, conflict, "account");
  expect(conflicts(b.store)).toEqual([]);
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 85, reps: 6 });
  expect(b.store.get("workout_set", "s2")?.content).toMatchObject({ weightKg: 85, reps: 5 });
});

it("keeps a workout deleted elsewhere but changed here by saving it as a new one", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Pull Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(60, 10));
  });
  a.store.delete("workout", "w1");
  await a.sync();
  b.store.put("workout_set", "s1", set(65, 10));
  await b.sync();

  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({ key: "workout:w1", title: "Pull Day" });
  expect(conflict!.phone).toMatchObject({ choosable: true, confirm: "Keep the workout" });
  expect(conflict!.account).toMatchObject({ confirm: "Delete it" });
  expect(conflict!.account.lines.every((line) => line.value === "Deleted")).toBe(true);

  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  // The workout lives on under a new id, with the set as changed here.
  const copies = b.store.list("workout").filter((row) => row.content?.title === "Pull Day");
  expect(copies).toHaveLength(1);
  expect(copies[0]!.id).not.toBe("w1");
  const sets = b.store
    .list("workout_set")
    .filter((row) => row.content?.weightKg === 65 && row.status === "synced");
  expect(sets).toHaveLength(1);
});

it("lets a workout deleted elsewhere go, with what changed here", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Pull Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(60, 10));
  });
  a.store.delete("workout", "w1");
  await a.sync();
  b.store.put("workout_set", "s1", set(65, 10));
  await b.sync();

  settleConflict(b.store, conflicts(b.store)[0]!, "account");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect(b.store.list("workout").filter((row) => !row.deleted)).toEqual([]);
  expect(b.store.hasUnsyncedWork()).toBe(false);
});

it("sends a deletion again when it's kept over a change made elsewhere", async () => {
  const entryOf = (kg: number) => ({ takenAt: STARTED, bodyweightKg: kg, fatPercent: null });
  const { a, b } = await twoPhones((store) => store.put("body_measurement", "m1", entryOf(80)));
  a.store.put("body_measurement", "m1", entryOf(80.4));
  await a.sync();
  b.store.delete("body_measurement", "m1");
  await b.sync();

  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({
    key: "body_measurement:m1",
    title: "Bodyweight",
    phone: { lines: [{ label: "Entry", value: "Deleted" }], confirm: "Delete it" },
    account: { lines: [{ label: "Bodyweight", value: "80.4 kg" }] },
  });
  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect((await serverRow("body_measurement", "m1"))?.state).toBe("deleted");
});

it("refuses a choice made on an outdated view, and leaves out what's still syncing", async () => {
  const folder = { title: "Push", position: 1 };
  const { a, b } = await twoPhones((store) => store.put("routine_folder", "f1", folder));
  a.store.put("routine_folder", "f1", { ...folder, title: "Push A" });
  b.store.put("routine_folder", "f1", { ...folder, title: "Push B" });
  await a.sync();
  await b.sync();
  const shown = conflicts(b.store)[0]!;

  // Changed again on this phone after it was shown.
  b.store.put("routine_folder", "f1", { ...folder, title: "Push C" });
  expect(() => settleConflict(b.store, shown, "phone")).toThrow("changed in the meantime");
  expect(JSON.parse(String((await serverRow("routine_folder", "f1"))?.content)).title).toBe(
    "Push A",
  );
});

it("shows what a workout still holds in the account before a deletion is kept over it", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Leg Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(100, 5));
  });
  // Another phone adds a set while this one deletes the workout.
  a.store.put("workout_set", "s2", { ...set(100, 5), position: 2 });
  await a.sync();
  b.store.delete("workout", "w1");
  await b.sync();

  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({ key: "workout:w1", title: "Leg Day" });
  expect(conflict!.phone).toMatchObject({ confirm: "Delete it", choosable: true });
  expect(conflict!.account.lines).toContainEqual({ label: "Holds", value: "1 exercise · 2 sets" });

  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect((await serverRow("workout", "w1"))?.state).toBe("deleted");
  expect((await serverRow("workout_set", "s2"))?.state).toBe("deleted");
});
