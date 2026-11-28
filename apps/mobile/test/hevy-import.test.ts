import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { beforeEach, describe, expect, it } from "vitest";
import { HevyImportError, parseHevyCsv } from "../src/data/hevy-csv.ts";
import {
  HEVY_ALIASES,
  hevyImportSummary,
  importHevyWorkouts,
  prepareHevyImport,
} from "../src/data/hevy-import.ts";

const HEADER =
  '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';

/** A synthetic export in Hevy's layout: one row per set, the workout repeated on each row. */
const EXPORT = [
  HEADER,
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Bench Press (Barbell)",,"Seat 4,\nnarrow grip",0,"warmup",40,10,,,',
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Bench Press (Barbell)",,"",1,"normal",80,5,,,8.5',
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Bench Press (Barbell)",,"",2,"failure",80,4,,,10',
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Pull Up",0,"",0,"normal",0,12,,,',
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Landmine Rotation",0,"",0,"normal",20,10,,,',
  '"Push Day","15 Nov 2026, 18:00","15 Nov 2026, 19:05","Felt strong, ""easy"" day","Landmine Rotation",0,"",1,"dropset",15,12,,,',
  '"Run","16 Nov 2026, 07:30","16 Nov 2026, 08:00","","Running (Treadmill)",,"",0,"normal",,,5.2,1800,',
].join("\r\n");

let store: DeviceStore;
beforeEach(async () => {
  const engine = createSqlJsEngine(await initSqlJs());
  store = await openDeviceStore({ engine, path: "/hevy.db", appVersion: "test" });
});

const visible = () =>
  ["workout", "workout_exercise", "workout_set", "workout_note", "exercise_note", "custom_exercise"]
    .flatMap((kind) => store.list(kind))
    .map((record) => `${record.kind}/${record.id}`)
    .sort();

describe("Hevy CSV import", () => {
  it("adds each workout with its exercises, sets and notes", async () => {
    const result = importHevyWorkouts(store, await prepareHevyImport(EXPORT));
    expect(result).toEqual({ added: 2, existing: 0, deleted: 0 });

    const push = "hevy:workout:202611151800:1";
    expect(store.get("workout", push)?.content).toMatchObject({
      title: "Push Day",
      startedAt: new Date(2026, 10, 15, 18, 0).toISOString(),
      endedAt: new Date(2026, 10, 15, 19, 5).toISOString(),
      routineId: null,
    });
    expect(store.get("workout_note", `${push}:note`)?.content).toMatchObject({
      workoutId: push,
      text: 'Felt strong, "easy" day',
    });

    const entries = store.list("workout_exercise", { parentId: push });
    expect(entries.map((entry) => entry.content)).toMatchObject([
      { exerciseId: "builtin:barbell-bench-press", exerciseType: "weight_reps", supersetId: null },
      { exerciseId: "builtin:pull-up", exerciseType: "bodyweight_reps", supersetId: 0 },
      { exerciseName: "Landmine Rotation", exerciseType: "weight_reps", supersetId: 0 },
    ]);
    expect(store.get("exercise_note", `${push}:e:1:note`)?.content).toMatchObject({
      exerciseId: "builtin:barbell-bench-press",
      text: "Seat 4,\nnarrow grip",
    });

    const bench = store.list("workout_set", { parentId: `${push}:e:1` });
    expect(bench.map((set) => set.content)).toMatchObject([
      { type: "warmup", weightKg: 40, reps: 10, rpe: null },
      { type: "normal", weightKg: 80, reps: 5, rpe: 8.5 },
      { type: "failure", weightKg: 80, reps: 4, rpe: 10 },
    ]);
    // Hevy writes a zero weight for bodyweight sets; Leve keeps no weight for them.
    expect(store.list("workout_set", { parentId: `${push}:e:2` })[0]?.content).toMatchObject({
      weightKg: null,
      reps: 12,
    });

    const custom = store.list("custom_exercise");
    expect(custom.map((exercise) => exercise.content)).toMatchObject([
      { name: "Landmine Rotation", type: "weight_reps", archived: false },
    ]);
    expect(custom[0]?.id).toMatch(/^hevy:exercise:[0-9a-f]{48}$/);
    expect(entries[2]?.content?.exerciseId).toBe(custom[0]?.id);
    expect(
      store.list("workout_set", { parentId: `${push}:e:3` }).map((set) => set.content?.type),
    ).toEqual(["normal", "drop"]);

    const run = store.list("workout_exercise", { parentId: "hevy:workout:202611160730:1" });
    expect(run[0]?.content).toMatchObject({
      exerciseId: "builtin:running-treadmill",
      exerciseType: "distance_duration",
    });
    expect(store.list("workout_set", { parentId: run[0]?.id })[0]?.content).toMatchObject({
      distanceMeters: 5200,
      durationSeconds: 1800,
      weightKg: null,
      reps: null,
    });
  });

  it("adds nothing twice and never brings back a deleted workout", async () => {
    importHevyWorkouts(store, await prepareHevyImport(EXPORT));
    const before = visible();
    const edited = store.get("workout_set", "hevy:workout:202611151800:1:e:1:s:2");
    store.put("workout_set", "hevy:workout:202611151800:1:e:1:s:2", {
      ...edited?.content,
      reps: 6,
    });
    store.delete("workout", "hevy:workout:202611160730:1");

    expect(importHevyWorkouts(store, await prepareHevyImport(EXPORT))).toEqual({
      added: 0,
      existing: 1,
      deleted: 1,
    });
    expect(store.get("workout", "hevy:workout:202611160730:1")).toMatchObject({ deleted: true });
    expect(visible()).toEqual(
      before.filter((record) => !record.includes("hevy:workout:202611160730:1")),
    );
    expect(store.get("workout_set", "hevy:workout:202611151800:1:e:1:s:2")?.content).toMatchObject({
      reps: 6,
    });
  });

  it("gives workouts that start in the same minute their own ids", async () => {
    const twice = [
      HEADER,
      '"AM","15 Nov 2026, 18:00","15 Nov 2026, 18:20","","Pull Up",,"",0,"normal",,8,,,',
      '"PM","15 Nov 2026, 18:00","15 Nov 2026, 18:40","","Pull Up",,"",0,"normal",,9,,,',
    ].join("\n");
    importHevyWorkouts(store, await prepareHevyImport(twice));
    expect(store.list("workout").map((workout) => [workout.id, workout.content?.title])).toEqual(
      expect.arrayContaining([
        ["hevy:workout:202611151800:1", "AM"],
        ["hevy:workout:202611151800:2", "PM"],
      ]),
    );
  });

  it("converts an export in pounds and miles", async () => {
    const imperial = [
      '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_lbs","reps","distance_miles","duration_seconds","rpe"',
      '"Legs","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Squat (Barbell)",,"",0,"normal",225,5,,,',
      '"Legs","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Running (Treadmill)",,"",0,"normal",,,1,600,',
    ].join("\n");
    const [legs] = parseHevyCsv(imperial);
    expect(legs?.exercises[0]?.sets[0]?.weightKg).toBeCloseTo(102.06, 2);
    expect(legs?.exercises[1]?.sets[0]?.distanceMeters).toBeCloseTo(1609.34, 2);
  });

  it("refuses a file that isn't a Hevy export, or a broken row, without writing anything", async () => {
    await expect(prepareHevyImport("date,exercise,weight\n2026-11-15,Squat,100")).rejects.toThrow(
      "Choose a workout CSV exported from Hevy.",
    );
    const broken = `${EXPORT}\n"Run","17 Nov 2026, 07:30","17 Nov 2026, 08:00","","Pull Up",,"",0,"normal",,8,,,7.3`;
    await expect(prepareHevyImport(broken)).rejects.toThrow(
      new HevyImportError("Hevy CSV row 9 has an invalid RPE."),
    );
    await expect(
      prepareHevyImport(
        `${HEADER}\n"Run","17 Nov 2026, 07:30","17 Nov 2026, 07:00","","Pull Up",,"",0,"normal",,8,,,`,
      ),
    ).rejects.toThrow("Hevy CSV row 2 has an end time before its start time.");
    await expect(prepareHevyImport(`${HEADER}\n"Run","17 Nov 2026"`)).rejects.toThrow(
      "Hevy CSV row 2 has the wrong number of fields.",
    );
    expect(visible()).toEqual([]);
  });

  it("matches every Hevy alias to an exercise in Leve's library", async () => {
    const rows = [...HEVY_ALIASES.keys()].map(
      (name, i) =>
        `"Library","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","${name}",,"",${i},"normal",,,,,`,
    );
    const [workout] = await prepareHevyImport([HEADER, ...rows].join("\n"));
    const entries = workout?.records.filter((record) => record.kind === "workout_exercise") ?? [];
    expect(entries.map((entry) => entry.content.exerciseId)).toEqual([...HEVY_ALIASES.values()]);
  });

  it("names the row of a value outside what Leve stores, before writing anything", async () => {
    const heavy = `${HEADER}\n"Push","17 Nov 2026, 07:30","17 Nov 2026, 08:00","","Bench Press (Barbell)",,"",0,"normal",80,5,,,\n"Push","17 Nov 2026, 07:30","17 Nov 2026, 08:00","","Bench Press (Barbell)",,"",1,"normal",2500,5,,,`;
    await expect(prepareHevyImport(heavy)).rejects.toThrow(
      "Hevy CSV row 3 has a value Leve can't store (weightKg).",
    );
    expect(visible()).toEqual([]);
  });

  it("stores every entry of a custom exercise with one type that fits all its sets", async () => {
    const carries = [
      HEADER,
      '"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Sled Hold",,"",0,"normal",,,,30,',
      '"B","16 Nov 2026, 18:00","16 Nov 2026, 19:00","","Sled Hold",,"",0,"normal",40,,,45,',
    ].join("\n");
    importHevyWorkouts(store, await prepareHevyImport(carries));
    expect(store.list("custom_exercise").map((exercise) => exercise.content?.type)).toEqual([
      "weight_duration",
    ]);
    expect(
      store
        .list("workout_exercise")
        .map((entry) => entry.content?.exerciseType)
        .sort(),
    ).toEqual(["weight_duration", "weight_duration"]);
  });

  it("ignores zeros Hevy writes in columns an exercise doesn't use", async () => {
    const zeros = [
      HEADER,
      '"Pull","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Chest Supported Incline Row (Dumbbell)",,"",0,"warmup",20,6,,0,',
      '"Pull","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Bench Press (Barbell)",,"",0,"normal",80,5,0,0,',
      '"Pull","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Plank",,"",0,"normal",0,0,,60,',
    ].join("\n");
    importHevyWorkouts(store, await prepareHevyImport(zeros));
    const entries = store.list("workout_exercise");
    expect(entries.map((entry) => entry.content)).toMatchObject([
      { exerciseType: "weight_reps" },
      { exerciseId: "builtin:barbell-bench-press", exerciseType: "weight_reps" },
      { exerciseId: "builtin:plank", exerciseType: "duration" },
    ]);
    const [row, bench, plank] = entries.map(
      (entry) => store.list("workout_set", { parentId: entry.id })[0]?.content,
    );
    expect(row).toMatchObject({ durationSeconds: null, distanceMeters: null });
    expect(bench).toMatchObject({ durationSeconds: null, distanceMeters: null });
    expect(plank).toMatchObject({ weightKg: null, reps: null, durationSeconds: 60 });
  });

  it("names the row that brings in a measurement the exercise can't take", async () => {
    const mixed = [
      HEADER,
      '"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Odd Carry",,"",0,"normal",20,10,,,',
      '"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Odd Carry",,"",1,"normal",20,,0.1,,',
    ].join("\n");
    await expect(prepareHevyImport(mixed)).rejects.toThrow(
      "Hevy CSV row 3 combines measurements Leve cannot import.",
    );
    // The same sets the other way round: the reps on row 3 are what no longer fit.
    const reversed = [
      HEADER,
      '"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Odd Carry",,"",0,"normal",,,0.1,60,',
      '"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Odd Carry",,"",1,"normal",,10,,,',
    ].join("\n");
    await expect(prepareHevyImport(reversed)).rejects.toThrow(
      "Hevy CSV row 3 combines measurements Leve cannot import.",
    );
  });

  it("finds Leve's exercise for a Hevy name with its equipment, only when the equipment agrees", async () => {
    const names = [
      "Lateral Raise (Dumbbell)",
      "Leg Press (Machine)",
      "Deadlift (Barbell)",
      "Chin Up",
      "Leg Press (Cable)",
    ];
    const rows = names.map(
      (name, i) =>
        `"Mix","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","${name}",,"",${i},"normal",${name === "Chin Up" ? "" : 10},8,,,`,
    );
    const [workout] = await prepareHevyImport([HEADER, ...rows].join("\n"));
    const ids = workout?.records
      .filter((record) => record.kind === "workout_exercise")
      .map((record) => record.content.exerciseId);
    expect(ids?.slice(0, 4)).toEqual([
      "builtin:lateral-raise",
      "builtin:leg-press",
      "builtin:deadlift",
      "builtin:chin-up",
    ]);
    expect(ids?.[4]).toMatch(/^hevy:exercise:/);
  });

  it("leaves an imported custom exercise as the person changed it when a later export uses it", async () => {
    const first = `${HEADER}\n"A","15 Nov 2026, 18:00","15 Nov 2026, 19:00","","Landmine Rotation",,"",0,"normal",20,10,,,`;
    importHevyWorkouts(store, await prepareHevyImport(first));
    const [custom] = store.list("custom_exercise");
    if (!custom?.content) throw Error("Missing custom exercise");
    store.put("custom_exercise", custom.id, { ...custom.content, name: "Landmine Twist" });

    const later = `${first}\n"B","16 Nov 2026, 18:00","16 Nov 2026, 19:00","","Landmine Rotation",,"",0,"normal",25,10,,,`;
    expect(importHevyWorkouts(store, await prepareHevyImport(later))).toEqual({
      added: 1,
      existing: 1,
      deleted: 0,
    });
    expect(store.list("custom_exercise").map((exercise) => exercise.content?.name)).toEqual([
      "Landmine Twist",
    ]);
    expect(store.list("workout_exercise").map((entry) => entry.content?.exerciseId)).toEqual([
      custom.id,
      custom.id,
    ]);
  });

  it("says what an import did", () => {
    expect(hevyImportSummary({ added: 3, existing: 0, deleted: 0 })).toBe("Added 3 workouts.");
    expect(hevyImportSummary({ added: 1, existing: 1, deleted: 0 })).toBe(
      "Added 1 workout. 1 workout was already in Leve.",
    );
    expect(hevyImportSummary({ added: 0, existing: 4, deleted: 1 })).toBe(
      "No new workouts in this file. 4 workouts were already in Leve. 1 workout was deleted in Leve, so it stays deleted.",
    );
  });
});
