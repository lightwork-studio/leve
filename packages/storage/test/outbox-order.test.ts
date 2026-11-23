import { join } from "node:path";
import type { JsonObject } from "@leve/contract";
import { afterAll, describe, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { engine, OLD_APP, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";
import { fixtureContract } from "../src/test-support/versions.ts";

// Uploads that wait for an answer are sent again in the order they were first queued. Parents
// queue before their children, so a resend must never put a child first, even when every upload
// was queued in the same millisecond and their ids sort the other way round.

afterAll(removeTempDirs);

const T = "2026-11-10T08:00:00.000Z";
const workout: JsonObject = {
  title: "Push",
  description: "",
  startedAt: T,
  endedAt: T,
  routineId: null,
};
const entry: JsonObject = {
  workoutId: "w-1",
  exerciseId: "barbell-bench-press",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 120,
  notes: [],
  doubleDumbbellVolume: false,
};
const set: JsonObject = {
  workoutExerciseId: "e-1",
  position: 1,
  type: "normal",
  weightKg: 100,
  reps: 5,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: null,
};

/** A phone whose clock never moves and whose ids count down, so each new id sorts first. */
async function openPhone(path: string) {
  let next = 9999;
  return openDeviceStore({
    engine,
    path,
    appVersion: OLD_APP,
    contract: fixtureContract,
    now: () => T,
    randomId: () => `id-${String(next--).padStart(4, "0")}`,
  });
}

describe("resending queued uploads", () => {
  it("keeps the order they were queued in, parents first", async () => {
    const path = join(tempDir(), "phone.db");
    const store = await openPhone(path);
    // Written child first: the queue still sends the workout, then its exercise, then the set.
    store.put("workout_set", "s-1", set);
    store.put("workout_exercise", "e-1", entry);
    store.put("workout", "w-1", workout);

    const first = store.prepareSubmissions("1.0");
    expect(first.map((o) => `${o.submission.kind}/${o.submission.id}`)).toEqual([
      "workout/w-1",
      "workout_exercise/e-1",
      "workout_set/s-1",
    ]);
    // No answer arrived: the same uploads go out again, unchanged and in the same order.
    expect(store.prepareSubmissions("1.0")).toEqual(first);

    // The order is kept in the database, so it survives the app being closed and reopened.
    store.db.close();
    const reopened = await openPhone(path);
    expect(reopened.prepareSubmissions("1.0")).toEqual(first);
    reopened.db.close();
  });
});
