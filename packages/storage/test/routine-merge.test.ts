import { join } from "node:path";
import type { Change, JsonObject } from "@leve/contract";
import { afterAll, expect, it } from "vitest";
import { openDeviceStore } from "../src/device-store.ts";
import { engine, removeTempDirs, tempDir } from "../src/test-support/fixtures.ts";

afterAll(removeTempDirs);

function exercise(id: string, weightKg: number) {
  return {
    id,
    exerciseId: id,
    exerciseName: id,
    exerciseType: "weight_reps",
    supersetId: null,
    restSeconds: 90,
    useRepRange: false,
    sets: [
      {
        id: `${id}-set`,
        type: "normal",
        weightKg,
        reps: 8,
        repRangeMin: null,
        repRangeMax: null,
        durationSeconds: null,
        distanceMeters: null,
        count: null,
        rpe: null,
      },
    ],
  };
}

function routine(bench: number, squat: number): JsonObject {
  return {
    title: "Strength",
    folderId: null,
    position: 1,
    effortScale: null,
    exercises: [exercise("bench", bench), exercise("squat", squat)],
  };
}

function version(revision: number, content: JsonObject): Change {
  return { kind: "routine", id: "r", revision, state: "live", content };
}

async function openRoutineDatabase(path = join(tempDir(), "routine.db")) {
  const store = await openDeviceStore({ engine, path, appVersion: "test" });
  store.bindAccount("server", "account");
  store.setNegotiated("1.0", [], "lineage");
  return store;
}

it("merges against the saved starting copy after restart and checks a racing write again", async () => {
  const path = join(tempDir(), "routine.db");
  const first = await openRoutineDatabase(path);
  first.applyPull([version(15, routine(30, 60))], 15);
  first.put("routine", "r", routine(35, 60));
  first.close();

  const store = await openRoutineDatabase(path);
  try {
    store.applyPull([version(20, routine(30, 70))], 20);
    const [outgoing] = store.prepareSubmissions("1.0");
    if (!outgoing) throw Error("Missing merged upload");
    expect(outgoing.submission).toMatchObject({
      baseRevision: 20,
      content: routine(35, 70),
    });

    store.applyPushResults([
      {
        status: "conflict",
        reason: "stale",
        submissionId: outgoing.submission.submissionId,
        current: version(21, routine(40, 80)),
      },
    ]);
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    expect(store.routineConflictVersions("r")).toEqual({
      phone: routine(35, 80),
      account: routine(40, 80),
    });
  } finally {
    store.close();
  }
});

it("uses an acknowledged own write as the starting copy of edits made during that upload", async () => {
  const store = await openRoutineDatabase();
  try {
    store.applyPull([version(15, routine(30, 60))], 15);
    store.put("routine", "r", routine(35, 60));
    const [outgoing] = store.prepareSubmissions("1.0");
    if (!outgoing) throw Error("Missing initial upload");
    const { submissionId } = outgoing.submission;
    store.put("routine", "r", routine(45, 60));
    store.applyPushResults(
      [{ status: "accepted", revision: 19, submissionId }],
      new Set([submissionId]),
    );

    // The other writer restored the original bench value after seeing the intermediate edit.
    store.applyPull([version(20, routine(30, 70))], 20);
    expect(store.routineConflictVersions("r")).toEqual({
      phone: routine(45, 70),
      account: routine(30, 70),
    });
  } finally {
    store.close();
  }
});

it("keeps a concurrent reorder for whole-routine review", async () => {
  const store = await openRoutineDatabase();
  try {
    store.applyPull([version(15, routine(30, 60))], 15);
    store.put("routine", "r", routine(35, 60));
    const reordered = {
      ...routine(30, 70),
      exercises: [exercise("squat", 70), exercise("bench", 30)],
    };
    store.applyPull([version(20, reordered)], 20);
    expect(store.routineConflictVersions("r")).toBeNull();
    expect(store.get("routine", "r")).toMatchObject({
      status: "conflict",
      content: routine(35, 60),
      server: { content: reordered },
    });
  } finally {
    store.close();
  }
});

it("uses whole-routine review after the account history changes", async () => {
  const store = await openRoutineDatabase();
  try {
    store.applyPull([version(15, routine(30, 60))], 15);
    store.put("routine", "r", routine(35, 60));
    store.resetForServerRestore();
    store.setNegotiated("1.0", [], "restored-lineage");
    store.applyPull([version(20, routine(30, 70))], 20);
    store.completeRestore();
    expect(store.routineConflictVersions("r")).toBeNull();
    expect(store.get("routine", "r")).toMatchObject({
      status: "conflict",
      content: routine(35, 60),
      server: { content: routine(30, 70) },
    });
  } finally {
    store.close();
  }
});
