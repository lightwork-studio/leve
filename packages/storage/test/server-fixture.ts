// Server account data written through the real server storage API, with its expected contents
// written out by hand. Shared by the server storage tests; must not import vitest.

import type { SqlEngine } from "../src/driver.ts";
import { ServerStorage, type StoredRecord } from "../src/server-store.ts";
import { engine as defaultEngine } from "../src/test-support/fixtures.ts";

import { serverV1 } from "../src/test-support/versions.ts";

export const SERVER_APP = "server-0.1.0";
export const T = "2026-11-10T08:00:00.000Z";

export const workout = {
  title: "Push day",
  startedAt: "2026-11-10T07:00:00.000Z",
  endedAt: null,
  routineId: null,
};
export const benchEntry = {
  workoutId: "w-1",
  exerciseId: "barbell-bench-press",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 120,
  doubleDumbbellVolume: false,
};
export const set = (position: number, weightKg: number | null, reps: number) => ({
  workoutExerciseId: "e-1",
  position,
  type: "normal",
  weightKg,
  reps,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
});
export const measurement = { takenAt: T, bodyweightKg: 80.6, fatPercent: null };

/** Writes one account's data through the server storage API at version 1. */
export async function seedAccount(
  directory: string,
  accountId: string,
  withSets: boolean,
  engine: SqlEngine = defaultEngine,
) {
  const storage = new ServerStorage({
    engine,
    directory,
    definition: serverV1,
    appVersion: SERVER_APP,
  });
  const store = await storage.account(accountId);
  store.transaction((tx) => {
    tx.writeLive("workout", "w-1", workout);
    tx.writeLive("workout_exercise", "e-1", benchEntry);
    if (withSets) {
      tx.writeLive("workout_set", "s-1", set(1, 100, 5));
      tx.writeLive("workout_set", "s-2", set(2, null, 12));
    }
    tx.writeLive("body_measurement", "bm-1", measurement);
    tx.writeLive("routine", "r-1", {
      title: "Old",
      folderId: null,
      position: 1,
      exercises: [],
    });
    tx.writeDeleted("routine", "r-1");
    tx.saveReceipt({
      submissionId: "sub-1",
      kind: "workout",
      id: "w-1",
      revision: 1,
      digest: "a".repeat(64),
      acceptedAt: T,
    });
  });
  await storage.close();
}

/** The account with sets, written out by hand in revision order. */
export const ALICE_RECORDS: StoredRecord[] = [
  { kind: "workout", id: "w-1", revision: 1, state: "live", content: workout },
  { kind: "workout_exercise", id: "e-1", revision: 2, state: "live", content: benchEntry },
  { kind: "workout_set", id: "s-1", revision: 3, state: "live", content: set(1, 100, 5) },
  { kind: "workout_set", id: "s-2", revision: 4, state: "live", content: set(2, null, 12) },
  { kind: "body_measurement", id: "bm-1", revision: 5, state: "live", content: measurement },
  { kind: "routine", id: "r-1", revision: 7, state: "deleted", content: null },
];
