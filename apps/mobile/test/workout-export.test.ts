import type { JsonObject } from "@leve/contract";
import {
  type ExerciseType,
  exerciseLibrary,
  round,
  type WorkoutContent,
  type WorkoutSetContent,
} from "@leve/core";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvRows, formatHevyCsv, HevyImportError } from "../src/data/hevy-csv.ts";
import { importHevyWorkouts, prepareHevyImport } from "../src/data/hevy-import.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import { exportWorkouts } from "../src/data/workout-export.ts";

const SQL = await initSqlJs();
let n = 0;
const stores: DeviceStore[] = [];
const openStore = async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/export-${n++}.db`,
    appVersion: "test",
  });
  stores.push(store);
  return store;
};

let store: DeviceStore;
beforeEach(async () => {
  store = await openStore();
});
afterEach(() => {
  for (const opened of stores.splice(0)) opened.close();
});

type Write = { kind: string; id: string; content: JsonObject };
type SetInput = Partial<Omit<WorkoutSetContent, "workoutExerciseId" | "position">>;
interface EntryInput {
  exerciseId: string;
  name: string;
  type: ExerciseType;
  supersetId?: number;
  sets: SetInput[];
  note?: string;
}
interface WorkoutInput {
  id: string;
  title: string;
  start: Date;
  /** Null for a workout still being logged. */
  minutes: number | null;
  notes?: string[];
  entries: EntryInput[];
}

function customExercise(id: string, name: string, type: ExerciseType): Write {
  return {
    kind: "custom_exercise",
    id,
    content: {
      name,
      type,
      primaryMuscle: "other",
      secondaryMuscles: [],
      equipment: "other",
      usesBodyweight: false,
      archived: false,
    },
  };
}

/** The records Leve keeps for one workout, as logging it would leave them. */
function workoutRecords(workout: WorkoutInput): Write[] {
  const startedAt = workout.start.toISOString();
  const endedAt =
    workout.minutes === null
      ? null
      : new Date(workout.start.getTime() + workout.minutes * 60_000).toISOString();
  const done = endedAt ?? startedAt;
  const records: Write[] = [
    {
      kind: "workout",
      id: workout.id,
      content: { title: workout.title, startedAt, endedAt, routineId: null },
    },
  ];
  for (const [index, text] of (workout.notes ?? []).entries()) {
    records.push({
      kind: "workout_note",
      id: `${workout.id}-n${index + 1}`,
      content: {
        workoutId: workout.id,
        text,
        pinned: false,
        createdAt: new Date(Date.parse(done) + index * 1000).toISOString(),
        agent: null,
      },
    });
  }
  for (const [index, entry] of workout.entries.entries()) {
    const entryId = `${workout.id}-e${index + 1}`;
    records.push({
      kind: "workout_exercise",
      id: entryId,
      content: {
        workoutId: workout.id,
        exerciseId: entry.exerciseId,
        exerciseName: entry.name,
        exerciseType: entry.type,
        position: index + 1,
        supersetId: entry.supersetId ?? null,
        restSeconds: 90,
        doubleDumbbellVolume: false,
      },
    });
    if (entry.note) {
      records.push({
        kind: "exercise_note",
        id: `${entryId}-note`,
        content: {
          exerciseId: entry.exerciseId,
          workoutId: workout.id,
          text: entry.note,
          pinned: false,
          createdAt: done,
          agent: null,
        },
      });
    }
    for (const [position, set] of entry.sets.entries()) {
      records.push({
        kind: "workout_set",
        id: `${entryId}-s${position + 1}`,
        content: {
          workoutExerciseId: entryId,
          position: position + 1,
          type: set.type ?? "normal",
          weightKg: set.weightKg ?? null,
          reps: set.reps ?? null,
          distanceMeters: set.distanceMeters ?? null,
          durationSeconds: set.durationSeconds ?? null,
          count: set.count ?? null,
          rpe: set.rpe ?? null,
          completedAt: set.completedAt === undefined ? done : set.completedAt,
        },
      });
    }
  }
  return records;
}

const content = <T>(record: { content: JsonObject | null }) => record.content as unknown as T;
const minute = (timestamp: string) => new Date(timestamp).toISOString().slice(0, 16);

/**
 * Finished workouts as a person sees them in history, read straight from the store: what an
 * export and import have to carry. Built-in exercises by id, custom ones by name and type.
 */
function history(target: DeviceStore) {
  const customs = new Map(
    target.list("custom_exercise").map((record) => [record.id, content<JsonObject>(record)]),
  );
  const notes = (kind: string, keep: (note: JsonObject) => boolean) =>
    target
      .list(kind)
      .map((record) => content<JsonObject>(record))
      .filter(keep)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((note) => note.text)
      .join("\n\n");
  return target
    .list("workout")
    .map((record) => ({ id: record.id, ...content<WorkoutContent>(record) }))
    .filter((workout) => workout.endedAt !== null)
    .map((workout) => {
      const noted = new Set<unknown>();
      return {
        title: workout.title,
        startedAt: minute(String(workout.startedAt)),
        endedAt: minute(String(workout.endedAt)),
        notes: notes("workout_note", (note) => note.workoutId === workout.id),
        entries: target.list("workout_exercise", { parentId: workout.id }).map((record) => {
          const entry = content<JsonObject>(record);
          const custom = customs.get(String(entry.exerciseId));
          const first = !noted.has(entry.exerciseId);
          noted.add(entry.exerciseId);
          return {
            exercise: custom ? `custom: ${custom.name} (${custom.type})` : entry.exerciseId,
            type: entry.exerciseType,
            supersetId: entry.supersetId,
            notes: first
              ? notes(
                  "exercise_note",
                  (note) => note.workoutId === workout.id && note.exerciseId === entry.exerciseId,
                )
              : "",
            sets: target
              .list("workout_set", { parentId: record.id })
              .map((set) => content<WorkoutSetContent>(set))
              .filter((set) => set.completedAt !== null)
              .map((set) => ({
                type: set.type,
                weightKg: set.weightKg === null ? null : round(set.weightKg, 3),
                reps: set.reps,
                distanceMeters: set.distanceMeters === null ? null : round(set.distanceMeters, 1),
                durationSeconds: set.durationSeconds,
                count: set.count,
                rpe: set.rpe,
              })),
          };
        }),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.title.localeCompare(b.title));
}

/** Imports an export into a new, empty database. */
async function roundTrip(csv: string) {
  const fresh = await openStore();
  const result = importHevyWorkouts(fresh, await prepareHevyImport(csv));
  return { fresh, result };
}

const VARIED: WorkoutInput[] = [
  {
    id: "w-push",
    title: "Push day",
    start: new Date(2026, 10, 20, 18, 0, 41),
    minutes: 75,
    notes: ['Felt strong, "easy" day', "Second note\nwith a second line"],
    entries: [
      {
        exerciseId: "builtin:barbell-bench-press",
        name: "Barbell Bench Press",
        type: "weight_reps",
        note: "Seat 4, narrow grip",
        sets: [
          { type: "warmup", weightKg: 40, reps: 10 },
          { weightKg: 82.5, reps: 5, rpe: 8.5 },
          { type: "failure", weightKg: 82.5, reps: 4, rpe: 10 },
          { type: "drop", weightKg: 60, reps: 8 },
          // Planned but never logged: history doesn't show it, and neither does the export.
          { weightKg: 82.5, reps: 5, completedAt: null },
        ],
      },
      {
        exerciseId: "builtin:pull-up",
        name: "Pull-up",
        type: "bodyweight_reps",
        supersetId: 1,
        sets: [{ reps: 12 }, { reps: 10, rpe: 9 }],
      },
      {
        exerciseId: "custom-landmine",
        name: "Landmine Rotation",
        type: "weight_reps",
        supersetId: 1,
        note: "Half-kneeling",
        sets: [{ weightKg: 20, reps: 10 }],
      },
      // The same exercise again, with nothing logged, then once more with sets.
      {
        exerciseId: "custom-landmine",
        name: "Landmine Rotation",
        type: "weight_reps",
        supersetId: 1,
        sets: [{ weightKg: 20, reps: 10, completedAt: null }],
      },
      {
        exerciseId: "custom-landmine",
        name: "Landmine Rotation",
        type: "weight_reps",
        supersetId: 1,
        sets: [{ weightKg: 22.5, reps: 8 }],
      },
    ],
  },
  {
    id: "w-run",
    title: "Run",
    start: new Date(2026, 10, 21, 7, 30),
    minutes: 31,
    entries: [
      {
        exerciseId: "builtin:running-treadmill",
        name: "Running, Treadmill",
        type: "distance_duration",
        sets: [{ distanceMeters: 5200, durationSeconds: 1800 }],
      },
    ],
  },
  {
    id: "w-mixed",
    title: "Assisted and timed",
    start: new Date(2026, 10, 22, 12, 5),
    minutes: 40,
    entries: [
      {
        exerciseId: "builtin:assisted-pull-up",
        name: "Assisted Pull-Up",
        type: "assisted_bodyweight",
        sets: [
          { weightKg: 25, reps: 8 },
          { weightKg: 20, reps: 6 },
        ],
      },
      {
        exerciseId: "builtin:plank",
        name: "Plank",
        type: "duration",
        sets: [{ durationSeconds: 60 }, { durationSeconds: 45 }],
      },
      {
        exerciseId: "custom-sled",
        name: "Prowler Shove",
        type: "weight_distance",
        sets: [{ weightKg: 100, distanceMeters: 20 }],
      },
      {
        exerciseId: "custom-hang",
        name: "Towel Grip Hang",
        type: "duration",
        sets: [{ durationSeconds: 50.5 }],
      },
    ],
  },
  // Two workouts that start in the same minute.
  {
    id: "w-am",
    title: "Morning mobility",
    start: new Date(2026, 10, 23, 6, 0, 5),
    minutes: 10,
    entries: [
      {
        exerciseId: "builtin:plank",
        name: "Plank",
        type: "duration",
        sets: [{ durationSeconds: 30 }],
      },
    ],
  },
  {
    id: "w-am-2",
    title: "Second session",
    start: new Date(2026, 10, 23, 6, 0, 50),
    minutes: 20,
    entries: [
      {
        exerciseId: "builtin:pull-up",
        name: "Pull-up",
        type: "bodyweight_reps",
        sets: [{ reps: 5 }],
      },
    ],
  },
];

/** A workout still being logged: not history yet, so not exported. */
const IN_PROGRESS: WorkoutInput = {
  id: "w-live",
  title: "Leg day",
  start: new Date(2026, 10, 24, 17, 0),
  minutes: null,
  entries: [
    {
      exerciseId: "builtin:pull-up",
      name: "Pull-up",
      type: "bodyweight_reps",
      sets: [{ reps: 8 }],
    },
  ],
};

function addVaried(target: DeviceStore) {
  target.putMany([
    customExercise("custom-landmine", "Landmine Rotation", "weight_reps"),
    customExercise("custom-sled", "Prowler Shove", "weight_distance"),
    customExercise("custom-hang", "Towel Grip Hang", "duration"),
    ...[...VARIED, IN_PROGRESS].flatMap(workoutRecords),
  ]);
}

describe("workout CSV export", () => {
  it("brings back a varied history when imported into an empty database", async () => {
    addVaried(store);
    const exported = exportWorkouts(store, new Date(2026, 10, 28, 9, 0));
    expect(exported.workouts).toBe(5);
    expect(exported.fileName).toBe("leve-workouts-2026-11-28.csv");
    expect(exported.csv.split("\n")[0]).toBe(
      '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"',
    );

    const { fresh, result } = await roundTrip(exported.csv);
    expect(result).toEqual({ added: 5, existing: 0, deleted: 0 });
    const expected = history(store);
    expect(expected).toHaveLength(5);
    expect(history(fresh)).toEqual(expected);
    // Spot checks, so the comparison can't pass on an empty history.
    expect(expected[0]?.entries[0]?.sets).toHaveLength(4);
    expect(expected[0]?.entries.map((entry) => entry.sets.length)).toEqual([4, 2, 1, 0, 1]);
    expect(expected[2]?.entries[0]?.exercise).toBe("builtin:assisted-pull-up");
  });

  it("writes weights and distances in the person's units and still brings them back", async () => {
    saveSettings(store, { weightUnit: "lbs", distanceUnit: "miles" });
    store.putMany(
      workoutRecords({
        id: "w-imperial",
        title: "Imperial",
        start: new Date(2026, 10, 25, 18, 0),
        minutes: 60,
        entries: [
          {
            exerciseId: "builtin:barbell-bench-press",
            name: "Barbell Bench Press",
            type: "weight_reps",
            // 225 lb as logged in pounds, and a weight logged in kilograms before switching.
            sets: [
              { weightKg: 225 / 2.20462, reps: 5 },
              { weightKg: 100, reps: 3 },
            ],
          },
          {
            exerciseId: "builtin:running-treadmill",
            name: "Running, Treadmill",
            type: "distance_duration",
            sets: [{ distanceMeters: 3.1 * 1609.34, durationSeconds: 1500 }],
          },
        ],
      }),
    );
    const { csv } = exportWorkouts(store);
    const [header, ...rows] = [...csvRows(csv)].map((row) => row.fields);
    expect(header).toContain("weight_lbs");
    expect(header).toContain("distance_miles");
    expect(rows.map((row) => [row[9], row[11]])).toEqual([
      ["225", ""],
      ["220.462", ""],
      ["", "3.1"],
    ]);

    const { fresh } = await roundTrip(csv);
    const [imported] = history(fresh);
    const [original] = history(store);
    const weights = (workout: typeof original) =>
      workout?.entries[0]?.sets.map((set) => set.weightKg) ?? [];
    for (const [index, kg] of weights(original).entries())
      expect(weights(imported)[index]).toBeCloseTo(kg ?? Number.NaN, 2);
    expect(imported?.entries[1]?.sets[0]?.distanceMeters).toBeCloseTo(3.1 * 1609.34, 1);
  });

  it("writes only the header for an empty history, which the import refuses without writing", async () => {
    store.putMany(workoutRecords(IN_PROGRESS));
    const exported = exportWorkouts(store);
    expect(exported.workouts).toBe(0);
    expect([...csvRows(exported.csv)]).toHaveLength(1);

    const fresh = await openStore();
    await expect(prepareHevyImport(exported.csv)).rejects.toThrow(HevyImportError);
    expect(fresh.list("workout")).toEqual([]);
  });

  it("brings back a large history", async () => {
    const workouts = Array.from(
      { length: 400 },
      (_, index): WorkoutInput => ({
        id: `w-${index}`,
        title: `Session ${index}`,
        start: new Date(2022, 0, 1 + index, 18, index % 60),
        minutes: 60,
        entries: Array.from({ length: 6 }, (_, position) => ({
          exerciseId: position % 2 ? "builtin:barbell-bench-press" : "custom-landmine",
          name: position % 2 ? "Barbell Bench Press" : "Landmine Rotation",
          type: "weight_reps" as const,
          sets: Array.from({ length: 5 }, (_, set) => ({
            weightKg: 20 + ((index + set) % 40) * 2.5,
            reps: 5 + set,
          })),
        })),
      }),
    );
    store.putMany([
      customExercise("custom-landmine", "Landmine Rotation", "weight_reps"),
      ...workouts.flatMap(workoutRecords),
    ]);

    const exported = exportWorkouts(store);
    expect(exported.workouts).toBe(400);
    expect([...csvRows(exported.csv)]).toHaveLength(1 + 400 * 6 * 5);
    const { fresh, result } = await roundTrip(exported.csv);
    expect(result.added).toBe(400);
    expect(fresh.list("workout_set")).toHaveLength(12_000);
    expect(history(fresh)).toEqual(history(store));
  }, 120_000);

  const ODD_NAMES = [
    'Curl, "Zottman" style',
    "Row\nchest-supported",
    "Rücken Strecker",
    "スクワット",
    "Жим лёжа",
    "تمرين الضغط",
    "深蹲 🏋️",
    '=HYPERLINK("https://example.com","x")',
    "+1 push-ups",
    "-10 kg plate hold",
    "@SUM(A1:A2)",
    "'=already quoted",
  ];

  it("keeps odd names and notes exactly, and no text cell can run as a spreadsheet formula", async () => {
    store.putMany([
      ...ODD_NAMES.map((name, index) => customExercise(`custom-odd-${index}`, name, "weight_reps")),
      ...workoutRecords({
        id: "w-odd",
        title: "=cmd|' /C calc'!A0",
        start: new Date(2026, 10, 26, 18, 0),
        minutes: 45,
        notes: ["-felt heavy\n- next time lighter", "@coach: check form", "  =1+1 after spaces"],
        entries: ODD_NAMES.map((name, index) => ({
          exerciseId: `custom-odd-${index}`,
          name,
          type: "weight_reps" as const,
          note: index % 2 ? `+${name}, "noted"` : undefined,
          sets: [{ weightKg: 10 + index, reps: 8 }],
        })),
      }),
    ]);
    const { csv } = exportWorkouts(store);

    const cells = [...csvRows(csv)].slice(1).flatMap((row) => row.fields);
    for (const cell of cells) {
      // Numbers may be negative; everything else that a spreadsheet would run starts with '.
      if (/^-\d+(\.\d+)?$/.test(cell)) continue;
      expect(cell).not.toMatch(/^\s*[=+\-@]|^[\t\r]/);
    }
    expect(cells).toContain("'=cmd|' /C calc'!A0");
    expect(cells).toContain("''=already quoted");

    const { fresh } = await roundTrip(csv);
    expect(history(fresh)).toEqual(history(store));
    const [workout] = history(fresh);
    expect(workout?.title).toBe("=cmd|' /C calc'!A0");
    expect(fresh.list("custom_exercise").map((record) => record.content?.name)).toEqual(
      expect.arrayContaining(ODD_NAMES),
    );
  });

  it("changes nothing stored", async () => {
    addVaried(store);
    const dump = () =>
      store.db
        .all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map(({ name }) => [name, store.db.all(`SELECT * FROM "${String(name)}"`)]);
    const before = dump();
    const versions = store.list("workout").map((record) => store.editVersion("workout", record.id));
    exportWorkouts(store);
    expect(dump()).toEqual(before);
    expect(store.list("workout").map((record) => store.editVersion("workout", record.id))).toEqual(
      versions,
    );
  });

  it("names every built-in exercise so the import finds the same one", async () => {
    const csv = formatHevyCsv(
      [
        {
          title: "Library",
          startedAt: new Date(2026, 10, 27, 10, 0).toISOString(),
          endedAt: new Date(2026, 10, 27, 11, 0).toISOString(),
          description: "",
          exercises: exerciseLibrary.map((exercise) => ({
            name: exercise.name,
            notes: "",
            supersetId: null,
            sets: [],
          })),
        },
      ],
      { weight: "kg", distance: "km" },
    );
    const [workout] = await prepareHevyImport(csv);
    const ids = (workout?.records ?? [])
      .filter((record) => record.kind === "workout_exercise")
      .map((record) => record.content.exerciseId);
    const lost = exerciseLibrary
      .filter((exercise, index) => ids[index] !== exercise.id)
      .map((exercise) => exercise.name);
    // The import reads "assisted" in a name as assistance, which this bodyweight exercise isn't.
    expect(lost).toEqual(["Assisted Pistol Squat"]);
  });

  it("keeps exercises with the same name apart, renaming the custom ones", async () => {
    const entry = (exerciseId: string, name: string, type: ExerciseType, set: SetInput) => ({
      exerciseId,
      name,
      type,
      sets: [set],
    });
    store.putMany([
      // An archived exercise and the one made in its place, of another type.
      customExercise("custom-carry-a", "Bucket Carry", "weight_distance"),
      customExercise("custom-carry-b", "Bucket Carry", "duration"),
      // A custom exercise named like a library one.
      customExercise("custom-plank", "Plank", "weight_reps"),
      ...workoutRecords({
        id: "w-names",
        title: "Same names",
        start: new Date(2026, 10, 27, 18, 0),
        minutes: 30,
        entries: [
          entry("builtin:plank", "Plank", "duration", { durationSeconds: 60 }),
          entry("custom-plank", "Plank", "weight_reps", { weightKg: 10, reps: 12 }),
          entry("custom-carry-a", "Bucket Carry", "weight_distance", {
            weightKg: 30,
            distanceMeters: 40,
          }),
          entry("custom-carry-b", "Bucket Carry", "duration", { durationSeconds: 90 }),
        ],
      }),
    ]);
    const { fresh, result } = await roundTrip(exportWorkouts(store).csv);
    expect(result.added).toBe(1);
    const [workout] = history(fresh);
    expect(workout?.entries.map((entry) => entry.exercise)).toEqual([
      "builtin:plank",
      "custom: Plank (custom) (weight_reps)",
      "custom: Bucket Carry (weight_distance)",
      "custom: Bucket Carry (custom) (duration)",
    ]);
    const sets = (target: DeviceStore) => history(target)[0]?.entries.map((entry) => entry.sets);
    expect(sets(fresh)).toEqual(sets(store));
  });

  it("brings back notes that are longer together than one note", async () => {
    const long = (letter: string) => `${letter.repeat(5999)}.`;
    store.putMany([
      customExercise("custom-landmine", "Landmine Rotation", "weight_reps"),
      ...workoutRecords({
        id: "w-notes",
        title: "Long notes",
        start: new Date(2026, 10, 27, 7, 0),
        minutes: 30,
        notes: [long("a"), long("b"), "short"],
        entries: [
          {
            exerciseId: "custom-landmine",
            name: "Landmine Rotation",
            type: "weight_reps",
            note: long("c"),
            sets: [{ weightKg: 20, reps: 10 }],
          },
        ],
      }),
      {
        kind: "exercise_note",
        id: "w-notes-e1-note-2",
        content: {
          exerciseId: "custom-landmine",
          workoutId: "w-notes",
          text: long("d"),
          pinned: false,
          createdAt: "2026-11-28T00:00:00.000Z",
          agent: null,
        },
      },
    ]);
    const { fresh } = await roundTrip(exportWorkouts(store).csv);
    expect(history(fresh)).toEqual(history(store));
    expect(fresh.list("workout_note").map((note) => String(note.content?.text).length)).toEqual([
      6000,
      6000 + 2 + 5,
    ]);
    expect(fresh.list("exercise_note")).toHaveLength(2);
  });

  it("carries floors and steps in the reps column", async () => {
    store.putMany([
      customExercise("custom-floors", "Tower Climb", "floors_duration"),
      customExercise("custom-steps", "Tower Steps", "steps_duration"),
      ...workoutRecords({
        id: "w-stairs",
        title: "Stairs",
        start: new Date(2026, 10, 27, 12, 0),
        minutes: 45,
        entries: [
          {
            exerciseId: "builtin:stairmaster",
            name: "Stairmaster",
            type: "floors_duration",
            sets: [{ count: 50, durationSeconds: 600 }],
          },
          {
            exerciseId: "custom-floors",
            name: "Tower Climb",
            type: "floors_duration",
            sets: [{ count: 30, durationSeconds: 420 }],
          },
          {
            exerciseId: "custom-steps",
            name: "Tower Steps",
            type: "steps_duration",
            sets: [{ count: 1200, durationSeconds: 900 }],
          },
        ],
      }),
    ]);
    const { csv } = exportWorkouts(store);
    expect([...csvRows(csv)].slice(1).map((row) => row.fields[10])).toEqual(["50", "30", "1200"]);
    const { fresh } = await roundTrip(csv);
    expect(history(fresh)).toEqual(history(store));
  });

  it("writes a workout the clocks went back during so that it imports", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      // 02:30 summer time to 02:10 winter time on the night the clocks go back.
      const start = new Date("2026-10-25T00:30:00.000Z");
      expect(start.getHours()).toBe(2);
      store.putMany(
        workoutRecords({
          id: "w-clock",
          title: "Night shift",
          start,
          minutes: 40,
          entries: [
            {
              exerciseId: "builtin:plank",
              name: "Plank",
              type: "duration",
              sets: [{ durationSeconds: 60 }],
            },
          ],
        }),
      );
      const { csv } = exportWorkouts(store);
      const [, row] = [...csvRows(csv)].map((line) => line.fields);
      expect([row?.[1], row?.[2]]).toEqual(["25 Oct 2026, 02:30", "25 Oct 2026, 03:10"]);
      const { fresh, result } = await roundTrip(csv);
      expect(result.added).toBe(1);
      const [workout] = history(fresh);
      expect(workout?.startedAt).toBe(minute(start.toISOString()));
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
