import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import { correctBodyweight, deleteBodyweight, recordBodyweight } from "../src/data/bodyweight.ts";
import { progressData } from "../src/data/read.ts";

vi.mock("../src/data/ids.ts", () => {
  let id = 0;
  return { newId: () => `measurement-${++id}` };
});

it("appends offline, preserves earlier workout volumes and retries the same uploads after reopen", async () => {
  const engine = createSqlJsEngine(await initSqlJs());
  let id = 0;
  const open = () =>
    openDeviceStore({
      engine,
      path: "/body.db",
      appVersion: "test",
      randomId: () => `upload-${++id}`,
    });
  let store = await open();
  const morning = new Date("2026-11-12T08:00:00Z");
  const noon = new Date("2026-11-12T12:00:00Z");
  recordBodyweight(store, "70,5", "kg", morning);
  const original = store.prepareSubmissions("1.0");
  expect(original).toHaveLength(1);
  for (const invalid of ["", " ", "0", "-1", "70kg", "1e2", "1.2.3", "2001"]) {
    expect(() => recordBodyweight(store, invalid, "kg", noon)).toThrow();
  }
  expect(store.prepareSubmissions("1.0")).toEqual(original);
  recordBodyweight(store, "176.3696", "lbs", noon);
  store.close();
  store = await open();
  expect(progressData(store).latestBodyweightKg).toBeCloseTo(80, 8);
  const uploads = store.prepareSubmissions("1.0");
  expect(uploads).toHaveLength(2);
  expect(uploads).toContainEqual(original[0]);
  expect(uploads).toContainEqual(
    expect.objectContaining({
      submission: expect.objectContaining({
        op: "put",
        kind: "body_measurement",
        baseRevision: null,
        content: {
          takenAt: noon.toISOString(),
          bodyweightKg: expect.closeTo(80, 8),
          fatPercent: null,
        },
      }),
    }),
  );
  for (const hour of ["07", "10", "13"]) {
    const startedAt = `2026-11-12T${hour}:00:00.000Z`;
    store.put("workout", hour, {
      title: "Pull-ups",
      routineId: null,
      startedAt,
      endedAt: startedAt,
    });
    store.put("workout_exercise", hour, {
      workoutId: hour,
      exerciseId: "builtin:pull-up",
      exerciseName: "Pull-up",
      exerciseType: "bodyweight_reps",
      position: 0,
      supersetId: null,
      restSeconds: 0,
      doubleDumbbellVolume: false,
    });
    store.put("workout_set", hour, {
      workoutExerciseId: hour,
      position: 0,
      type: "normal",
      weightKg: null,
      reps: 4,
      distanceMeters: null,
      durationSeconds: null,
      count: null,
      rpe: null,
      completedAt: startedAt,
    });
  }
  expect(progressData(store).index.workouts.map((w) => w.volumeKg)).toEqual([0, 282, 320]);
  const morningReading = progressData(store).measurements[0];
  if (!morningReading) throw Error("Missing morning bodyweight");
  correctBodyweight(store, morningReading, "71.5", "kg");
  expect(progressData(store).index.workouts.map((w) => w.volumeKg)).toEqual([0, 286, 320]);
  store.close();
});

it("refuses a stale weight correction or a deleted reading without resurrecting it", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/stale-weight",
    appVersion: "test",
  });
  try {
    const takenAt = "2026-11-11T10:00:00.000Z";
    const original = { id: "morning", kg: 72, at: Date.parse(takenAt) };
    const changed = { takenAt, bodyweightKg: 73, fatPercent: null };
    store.put("body_measurement", original.id, changed);
    expect(() => correctBodyweight(store, original, "81", "kg")).toThrow(/changed/);
    expect(store.get("body_measurement", original.id)?.content).toEqual(changed);
    store.delete("body_measurement", original.id);
    expect(() => correctBodyweight(store, original, "81", "kg")).toThrow(/no longer available/);
    expect(store.list("body_measurement")).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("deletes a reading only as it was seen, never while sync holds a conflicting version", async () => {
  const world = new World();
  try {
    const server = world.server();
    const account = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    const takenAt = "2026-11-11T10:00:00.000Z";
    const content = { takenAt, bodyweightKg: 72, fatPercent: null };
    const seen = { id: "morning" };
    a.store.put("body_measurement", seen.id, content);
    await a.sync();
    await b.sync();
    // Both phones correct it; the later upload finds the other version and holds a conflict.
    b.store.put("body_measurement", seen.id, { ...content, bodyweightKg: 71 });
    await b.sync();
    a.store.put("body_measurement", seen.id, { ...content, bodyweightKg: 73 });
    await a.sync();
    expect(a.store.get("body_measurement", seen.id)?.status).toBe("conflict");
    const mine = { ...content, bodyweightKg: 73 };
    expect(() => deleteBodyweight(a.store, seen.id, mine)).toThrow(/sync conflict/);
    expect(a.store.get("body_measurement", seen.id)?.deleted).toBe(false);
    // On the other phone, the reading as first seen is stale since its correction, and so is one
    // whose body fat changed unseen.
    expect(() => deleteBodyweight(b.store, seen.id, content)).toThrow(/changed/);
    const theirs = { ...content, bodyweightKg: 71 };
    expect(() => deleteBodyweight(b.store, seen.id, { ...theirs, fatPercent: 18 })).toThrow(
      /changed/,
    );
    deleteBodyweight(b.store, seen.id, theirs);
    // A second confirmation has nothing left to delete.
    deleteBodyweight(b.store, seen.id, theirs);
    await b.sync();
    expect(b.store.hasUnsyncedWork()).toBe(false);
    expect(await server.row("alice", "body_measurement", seen.id)).toMatchObject({
      state: "deleted",
      content: null,
    });
  } finally {
    await world.dispose();
  }
});
