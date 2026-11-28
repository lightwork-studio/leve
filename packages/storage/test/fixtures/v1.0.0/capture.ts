import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leveContract } from "@leve/contract";
import { openDeviceStore } from "../../../src/device-store.ts";
import { ServerAccountStore, serverStorageDefinition } from "../../../src/server-store.ts";
import { engine, removeTempDirs, tempDir } from "../../../src/test-support/fixtures.ts";
import { openStorage } from "../../../src/upgrade.ts";

// Capture with the actual v1.0.0 writers before declaring the first release. Tests open the
// checked-in backup files directly so later changes to these writers cannot change the inputs.
const manifest = JSON.parse(
  readFileSync(new URL("../../../../../frozen-paths.json", import.meta.url), "utf8"),
) as { shipped: string[] };
if (manifest.shipped.includes("1.0")) throw new Error("The 1.0 baseline has shipped");

const appVersion = "1.0.0";
const release = "1.0";
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

    const phone = await openDeviceStore({
      engine,
      path: join(directory, "phone.db"),
      appVersion,
      now: () => now,
      randomId: () => "pending-bench-edit",
    });
    try {
      phone.bindAccount("https://sync.example.test", "account");
      phone.setNegotiated(release, ["workouts", "reps_in_reserve"], lineage);
      const { records } = account.changesAfter(0, 100);
      phone.applyPull(
        records.map(({ content, ...record }) =>
          record.state === "live" && content
            ? { ...record, state: "live", content }
            : {
                ...record,
                state: "deleted",
              },
        ),
        account.headRevision(),
        { cursor: 0, lineage },
      );
      phone.put("workout_set", "bench-set", { ...set, reps: 6 });
      phone.prepareSubmissions(release);
      phone.put("workout_set", "bench-set", { ...set, reps: 7 });
      phone.put("workout", "next-session", { ...workout, startedAt: now, endedAt: null });
      await engine.backup(phone.db, join(directory, "device.sqlite"));
      await engine.backup(db, join(directory, "server.sqlite"));
    } finally {
      phone.close();
    }
  } finally {
    account.close();
  }

  for (const name of ["device.sqlite", "server.sqlite"]) {
    copyFileSync(join(directory, name), new URL(name, import.meta.url));
  }
} finally {
  removeTempDirs();
}
