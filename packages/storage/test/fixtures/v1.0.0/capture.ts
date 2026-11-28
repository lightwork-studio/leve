import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVE_CONTRACT_DEFINITION, leveContract } from "@leve/contract";
import { deviceStorageDefinition } from "../../../src/device-schema.ts";
import { openDeviceStore } from "../../../src/device-store.ts";
import { ServerAccountStore, serverStorageDefinition } from "../../../src/server-store.ts";
import {
  buildDeviceFixture,
  engine,
  removeTempDirs,
  tempDir,
} from "../../../src/test-support/fixtures.ts";
import { openStorage } from "../../../src/upgrade.ts";

// Capture with the actual v1.0.0 writers before declaring the first release. Tests open the
// checked-in backup files directly so later changes to these writers cannot change the inputs.
const manifest = JSON.parse(
  readFileSync(new URL("../../../../../frozen-paths.json", import.meta.url), "utf8"),
) as { shipped: string[] };
if (manifest.shipped.includes("1.0")) throw new Error("The 1.0 baseline has shipped");

const appVersion = "1.0.0";
const now = "2026-11-10T18:05:00.000Z";
const lineage = "v1-account-history";
const directory = tempDir();
const workout = {
  title: "Tuesday strength",
  startedAt: "2026-11-10T17:30:00.000Z",
  endedAt: now,
  routineId: null,
};
const set = {
  workoutExerciseId: "bench-entry",
  position: 1,
  type: "normal",
  weightKg: 102.05,
  reps: 5,
  repsInReserve: 0,
  completedAt: "2026-11-10T17:45:00.000Z",
};

try {
  const definition = serverStorageDefinition();
  const { db } = await openStorage({
    engine,
    path: join(directory, "account.db"),
    definition,
    appVersion,
    randomId: () => lineage,
  });
  const account = new ServerAccountStore(db, leveContract);
  try {
    account.transaction((tx) => {
      tx.writeLive("workout", "strength", workout);
      tx.writeLive("workout_exercise", "bench-entry", {
        workoutId: "strength",
        exerciseId: "barbell-bench-press",
        exerciseName: "Bench Press",
        exerciseType: "weight_reps",
        position: 1,
        restSeconds: 0,
        doubleDumbbellVolume: false,
      });
      const revision = tx.writeLive("workout_set", "bench-set", set);
      tx.saveReceipt({
        submissionId: "first-bench-set",
        kind: "workout_set",
        id: "bench-set",
        revision,
        digest: "a".repeat(64),
        acceptedAt: now,
        wroteRevision: true,
      });
      tx.writeDeleted("body_measurement", "removed-measurement");
    });

    await engine.backup(db, join(directory, "server.sqlite"));
  } finally {
    account.close();
  }

  // The phone: synced, downloaded, pending, in-flight, conflicting, invalid and partially synced
  // records, deletions and a running workout, written by the v1.0.0 device layout.
  const phonePath = join(directory, "phone.db");
  await buildDeviceFixture(phonePath, engine, "1.0", {
    definition: deviceStorageDefinition(),
    contract: leveContract,
    appVersion,
  });
  const phone = await openDeviceStore({
    engine,
    path: phonePath,
    appVersion,
    now: () => now,
    randomId: () => "unused-submission",
  });
  try {
    // A v1.0.0 phone negotiates every 1.0 feature and holds notes, replies and rest preferences.
    phone.setNegotiated("1.0", Object.keys(LEVE_CONTRACT_DEFINITION.features), "lineage-1");
    const noted = phone.applyPull(
      [
        {
          state: "live",
          kind: "workout_note",
          id: "wn-1",
          revision: 17,
          content: {
            workoutId: "w-done",
            pinned: true,
            text: "Keep the elbows tucked on bench.",
            createdAt: "2026-11-09T18:10:00.000Z",
            agent: null,
          },
        },
        {
          state: "live",
          kind: "workout_note_comment",
          id: "wc-1",
          revision: 18,
          content: {
            noteId: "wn-1",
            text: "Bar speed looked better on the last set.",
            createdAt: "2026-11-09T20:00:00.000Z",
            agent: "Coach",
          },
        },
        {
          state: "live",
          kind: "exercise_note",
          id: "xn-1",
          revision: 19,
          content: {
            exerciseId: "barbell-squat",
            workoutId: null,
            pinned: false,
            text: "Belt from 140 kg.",
            createdAt: "2026-11-08T09:00:00.000Z",
            agent: null,
          },
        },
        {
          state: "live",
          kind: "workout_rest",
          id: "w-done",
          revision: 20,
          content: { workoutId: "w-done", seconds: 150 },
        },
      ],
      20,
      { cursor: 14, lineage: "lineage-1" },
    );
    if (!noted) throw new Error("capture: the notes page was dropped");
    phone.put("workout_rest", "w-live", { workoutId: "w-live", seconds: 210 });
    phone.put("workout_note", "wn-live", {
      workoutId: "w-live",
      pinned: false,
      text: "Knee felt fine today.",
      createdAt: "2026-11-10T08:40:00.000Z",
      agent: null,
    });

    // An unsent routine edit keeps the server copy it started from.
    const routine = phone.get("routine", "r-1");
    if (!routine?.content || routine.server?.revision !== 11) {
      throw new Error("capture: expected the synced routine r-1");
    }
    phone.put("routine", "r-1", { ...routine.content, title: "Push A (deload)" });
    await engine.backup(phone.db, join(directory, "device.sqlite"));
  } finally {
    phone.close();
  }

  for (const name of ["device.sqlite", "server.sqlite"]) {
    copyFileSync(join(directory, name), new URL(name, import.meta.url));
  }
} finally {
  removeTempDirs();
}
