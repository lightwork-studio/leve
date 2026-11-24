import { openDeviceStore, verifyDeviceRecords } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { EXERCISES } from "../src/data/exercises.ts";
import {
  liveData,
  progressData,
  readAllWorkoutTrees,
  readSettings,
  readWorkoutTree,
  workoutDetail,
} from "../src/data/read.ts";
import { createRoutine } from "../src/data/routine-actions.ts";
import { seedSyntheticData } from "../src/data/seed.ts";
import {
  addExercise,
  addExerciseNote,
  addSelectedExercises,
  addSet,
  beginWorkout,
  discardActiveWorkout,
  discardWorkout,
  finishWorkout,
  logSet,
  moveWorkoutExercise,
  removeWorkoutExercise,
  removeWorkoutSet,
  setExerciseRest,
  unlogSet,
  updateRunningWorkoutDetails,
  updateSet,
  updateWorkoutDetails,
  workoutRest,
} from "../src/data/workout-actions.ts";
import {
  replaceReviewedActiveWorkout,
  workoutDeletionSnapshot,
} from "../src/data/workout-review.ts";
import { setProgress } from "../src/model/live.ts";

const SQL = await initSqlJs();
const open = async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/a.db",
    appVersion: "test",
  });
  seedSyntheticData(store, new Date(2026, 10, 12, 20));
  return store;
};

it("runs one workout from a routine through to the end", { timeout: 60_000 }, async () => {
  const store = await open();
  const id = beginWorkout(store, "seed-routine-push");
  // Starting again opens the same workout: one runs at a time.
  expect(beginWorkout(store, "seed-routine-legs")).toBe(id);
  let live = liveData(store);
  expect(live?.tree.workout.content).toMatchObject({
    title: "Push day",
    endedAt: null,
    routineId: "seed-routine-push",
  });
  expect(live?.tree.entries).toHaveLength(5);

  const first = live?.tree.entries[0]?.sets[0];
  if (!first) throw new Error("no set");
  logSet(store, first.id, { weightKg: 82.5, reps: 8 });
  live = liveData(store);
  expect(live?.tree.entries[0]?.sets[0]?.content).toMatchObject({ weightKg: 82.5, reps: 8 });
  expect(live?.tree.entries[0]?.sets[0]?.content.completedAt).not.toBeNull();
  expect(live?.summary).toMatchObject({ sets: 1, volumeKg: 660 });

  unlogSet(store, first.id);
  expect(liveData(store)?.summary.sets).toBe(0);
  logSet(store, first.id, { weightKg: 82.5, reps: 8 });

  const entryId = live?.tree.entries[0]?.entry.id as string;
  addSet(store, entryId);
  expect(liveData(store)?.tree.entries[0]?.sets.map((s) => s.content.position)).toEqual([
    1, 2, 3, 4,
  ]);
  addExercise(store, id, EXERCISES.curl, 90);
  expect(liveData(store)?.tree.entries.at(-1)?.entry.content).toMatchObject({
    exerciseName: "Biceps Curl",
    position: 6,
    restSeconds: 90,
  });

  finishWorkout(store, id, {
    title: " Push day ",
    description: " Felt good ",
    countForRoutine: false,
  });
  expect(store.activeWorkout()).toBeNull();
  const done = store.get("workout", id)?.content as Record<string, unknown>;
  expect(done).toMatchObject({ description: "Felt good", routineId: null, title: "Push day" });
  expect(done.endedAt).not.toBeNull();
  // Only what was logged stays: the bench press with its one logged set.
  const entries = store.list("workout_exercise", { parentId: id });
  expect(entries.map((e) => e.content?.exerciseName)).toEqual(["Bench Press"]);
  expect(store.list("workout_set", { parentId: entries[0]?.id as string })).toHaveLength(1);
  store.close();
});

it("names an untitled workout and discards one completely", { timeout: 60_000 }, async () => {
  const store = await open();
  const id = beginWorkout(store);
  addExercise(store, id, EXERCISES.squat, 120);
  const [squat] = store.list("workout_exercise", { parentId: id });
  const [first] = store.list("workout_set", { parentId: squat?.id as string });
  logSet(store, first?.id as string, { weightKg: 100, reps: 5 });
  finishWorkout(store, id, { title: "", description: "", countForRoutine: true });
  expect(String(store.get("workout", id)?.content?.title)).toMatch(/workout$/);

  const other = beginWorkout(store);
  addExercise(store, other, EXERCISES.bench, 120);
  discardWorkout(store, other);
  expect(store.activeWorkout()).toBeNull();
  expect(store.get("workout", other)).toBeNull();
  expect(store.list("workout_exercise", { parentId: other })).toEqual([]);
  store.close();
});

it("keeps a reopened workout active if its only set has no completion timestamp field", async () => {
  const engine = createSqlJsEngine(SQL);
  const options = { engine, path: "/omitted-completion.db", appVersion: "test" };
  let store = await openDeviceStore(options);
  try {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    store.db.run(
      "UPDATE records SET local_content=json_remove(local_content,'$.completedAt') WHERE kind='workout_set' AND id=?",
      [set.id],
    );
    expect(verifyDeviceRecords(store.db, store.contract)).toEqual([]);
    store.close();
    store = await openDeviceStore(options);
    const single = readWorkoutTree(store, id);
    const all = readAllWorkoutTrees(store).find((tree) => tree.workout.id === id);
    if (!single || !all) throw Error("Workout missing");
    expect(setProgress(single)).toEqual({ done: 0, total: 1 });
    expect(setProgress(all)).toEqual({ done: 0, total: 1 });
    expect(() =>
      finishWorkout(store, id, { title: "Still training", countForRoutine: false }),
    ).toThrow(/Log at least one set/);
    expect(store.activeWorkout()?.id).toBe(id);
    expect(store.list("workout_set", { parentId: entry }).map((row) => row.id)).toEqual([set.id]);
    const parent = store.get("workout_exercise", entry)?.content;
    const displayed = single.entries[0]?.sets[0]?.content;
    if (!displayed || !parent) throw Error("Missing editable set");
    const opened = {
      id: set.id,
      values: displayed,
      parent,
      exerciseType: String(parent.exerciseType),
    };
    updateSet(store, set.id, { type: "warmup" }, opened);
    expect(store.get("workout_set", set.id)?.content).toMatchObject({
      type: "warmup",
      completedAt: null,
    });
    expect(() => removeWorkoutSet(store, set.id, opened)).toThrow(/changed/);
    const edited = readWorkoutTree(store, id)?.entries[0]?.sets[0]?.content;
    if (!edited) throw Error("Missing updated set");
    store.db.run(
      "UPDATE records SET local_content=json_remove(local_content,'$.completedAt') WHERE kind='workout_set' AND id=?",
      [set.id],
    );
    removeWorkoutSet(store, set.id, { ...opened, values: edited });
    expect(store.list("workout_set", { parentId: entry })).toEqual([]);
  } finally {
    store.close();
  }
});

it("can reopen and retry a workout when cleanup fails during Finish", async () => {
  const engine = createSqlJsEngine(SQL);
  const options = { engine, path: "/finish.db", appVersion: "test" };
  let store = await openDeviceStore(options);
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 90);
    const first = store.list("workout_set", { parentId: entry })[0];
    if (!first) throw Error("Missing set");
    logSet(store, first.id, { reps: 5, weightKg: 40 });
    addSet(store, entry);
    addExercise(store, workout, EXERCISES.squat, 90);
    const before = readWorkoutTree(store, workout);
    const run = store.db.run.bind(store.db);
    const interrupted = vi.spyOn(store.db, "run").mockImplementation((sql, values) => {
      if (sql.startsWith("DELETE FROM records WHERE kind")) throw Error("interrupted finish");
      return run(sql, values);
    });
    expect(() => finishWorkout(store, workout, { title: "Saved", countForRoutine: false })).toThrow(
      /interrupted finish/,
    );
    interrupted.mockRestore();
    store.close();
    store = await openDeviceStore(options);
    expect(readWorkoutTree(store, workout)).toEqual(before);
    expect(store.activeWorkout()?.id).toBe(workout);
    finishWorkout(store, workout, { title: "Saved", countForRoutine: false });
    const result = readWorkoutTree(store, workout);
    expect(result?.workout.content.title).toBe("Saved");
    expect(result?.entries.map(({ sets }) => sets.map(({ id }) => id))).toEqual([[first.id]]);
  } finally {
    store.close();
  }
});

it("refuses to finish with nothing logged and changes nothing", { timeout: 60_000 }, async () => {
  const store = await open();
  const id = beginWorkout(store, "seed-routine-push");
  const before = liveData(store)?.tree.entries.length;
  expect(() =>
    finishWorkout(store, id, { title: "", description: "", countForRoutine: true }),
  ).toThrow(/Log at least one set/);
  expect(store.activeWorkout()?.id).toBe(id);
  expect(liveData(store)?.tree.entries.length).toBe(before);

  // An over-long name is cut to the limit rather than refused at the last step.
  const [first] = liveData(store)?.tree.entries[0]?.sets ?? [];
  logSet(store, first?.id as string, { weightKg: 80, reps: 8 });
  finishWorkout(store, id, { title: "x".repeat(150), description: "", countForRoutine: true });
  expect(String(store.get("workout", id)?.content?.title)).toHaveLength(100);
  store.close();
});

it("corrects a saved working set and preserves its completion time and untouched values", {
  timeout: 60000,
}, async () => {
  const store = await open();
  const id = beginWorkout(store, "seed-routine-push");
  const first = liveData(store)?.tree.entries[0]?.sets[0];
  if (!first) throw new Error("missing initial set");
  logSet(store, first.id, { weightKg: 92.5, reps: 8 });
  finishWorkout(store, id, { title: "Push", description: "", countForRoutine: true });
  const before = store.get("workout_set", first.id)?.content;
  updateSet(store, first.id, { type: "warmup", reps: 6 });
  expect(store.get("workout_set", first.id)?.content).toEqual({
    ...before,
    type: "warmup",
    reps: 6,
  });
  expect(store.activeWorkout()).toBeNull();
  store.close();
});

it("removes an accidental set and corrects a saved session without losing its time or notes", {
  timeout: 60_000,
}, async () => {
  const store = await open();
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.plank, 90);
  const [first] = store.list("workout_set", { parentId: entry });
  if (!first) throw new Error("Missing plank set");
  logSet(store, first.id, { durationSeconds: 45, type: "warmup" });
  const accidental = addSet(store, entry);
  logSet(store, accidental, { durationSeconds: 20 });
  const planned = addSet(store, entry);
  removeWorkoutSet(store, planned);
  expect(store.list("workout_set", { parentId: entry }).map((r) => r.id)).toEqual([
    first.id,
    accidental,
  ]);
  const bench = addExercise(store, id, EXERCISES.bench, 120);
  const benchSet = store.list("workout_set", { parentId: bench })[0];
  if (!benchSet) throw new Error("Missing bench set");
  logSet(store, benchSet.id, { weightKg: 20, reps: 8 });
  finishWorkout(store, id, { title: "Core", description: "After running", countForRoutine: false });
  const ended = store.get("workout", id)?.content?.endedAt;
  updateWorkoutDetails(store, id, { title: "Short core session" });
  removeWorkoutSet(store, accidental);
  removeWorkoutSet(store, benchSet.id);
  const benchHistory = progressData(store).index.exercises.find(
    (e) => e.exerciseId === EXERCISES.bench.id,
  );
  expect(benchHistory?.sessions.some((session) => session.workoutId === id)).toBe(false);
  expect(workoutDetail(store, id)?.summary).toMatchObject({
    title: "Short core session",
    sets: 0,
    excludedWarmups: 1,
    recordedSeconds: 45,
  });
  expect(store.get("workout", id)?.content).toMatchObject({
    description: "After running",
    endedAt: ended,
  });
  updateWorkoutDetails(store, id, { description: "" });
  expect(store.get("workout", id)?.content).toMatchObject({
    title: "Short core session",
    description: "",
  });
  expect(() => removeWorkoutSet(store, first.id)).toThrow(/only logged set/);
  expect(store.get("workout_set", first.id)?.content?.durationSeconds).toBe(45);
  expect(() => updateWorkoutDetails(store, id, { title: "  " })).toThrow(/name/);
  const ongoing = beginWorkout(store);
  expect(() => updateWorkoutDetails(store, ongoing, { title: "Wrong session" })).toThrow(/Finish/);
  discardWorkout(store, id);
  expect(store.get("workout_set", first.id)?.content ?? null).toBeNull();
  expect(store.activeWorkout()?.id).toBe(ongoing);
  expect(store.get("workout", "seed-workout-38")?.content).toBeTruthy();
  store.close();
});

it("moves one exercise without editing its neighbours or source plan and handles tied positions atomically", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/move.db",
    appVersion: "test",
  });
  try {
    const routineId = createRoutine(
      store,
      "Strength",
      null,
      [EXERCISES.bench, EXERCISES.squat, EXERCISES.curl].map((exercise) => ({
        id: exercise.id,
        exercise,
        sets: [{ id: "target", values: { reps: "6" } }],
      })),
      readSettings(store),
    );
    const id = beginWorkout(store, routineId);
    const initialPlan = store.get("workout", id)?.content?.initialPlan;
    const rows = () => store.list("workout_exercise", { parentId: id });
    const [a, b, c] = rows();
    if (!a?.content || !b?.content || !c?.content) throw Error("Missing routine entries");
    const sets = store.list("workout_set", { parentId: c.id });
    moveWorkoutExercise(store, id, c.id, -1);
    expect(
      rows()
        .slice(0, 3)
        .map((r) => r.id),
    ).toEqual([a.id, c.id, b.id]);
    expect(store.get("workout_exercise", a.id)?.content).toEqual(a.content);
    expect(store.get("workout_exercise", b.id)?.content).toEqual(b.content);
    expect(store.get("workout_exercise", c.id)?.content?.position).toBe(1.5);
    expect(store.list("workout_set", { parentId: c.id })).toEqual(sets);
    for (const row of rows())
      store.put("workout_exercise", row.id, { ...row.content, position: 0 });
    const tied = rows().map((row) => row.id);
    const selected = tied[2];
    if (!selected) throw Error("Missing tied entry");
    moveWorkoutExercise(store, id, selected, -1);
    expect(rows().map((row) => row.id)).toEqual([tied[0], selected, tied[1], ...tied.slice(3)]);
    expect(store.get("workout", id)?.content?.initialPlan).toEqual(initialPlan);
    expect(() => removeWorkoutExercise(store, "another-workout", selected)).toThrow();
    expect(rows().some((row) => row.id === selected)).toBe(true);
  } finally {
    store.close();
  }
});

it("corrects elapsed duration without changing recorded set time or the start date", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/duration.db",
    appVersion: "test",
  });
  try {
    store.put("workout", "old", {
      title: "Evening",
      description: "",
      routineId: null,
      startedAt: "2021-01-02T23:55:00.000Z",
      endedAt: "2021-01-03T07:00:00.000Z",
    });
    const entry = addExercise(store, "old", EXERCISES.plank, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing plank");
    logSet(store, set.id, { durationSeconds: 35 });
    const logged = store.get("workout_set", set.id)?.content;
    updateWorkoutDetails(store, "old", { durationSeconds: 735 });
    expect(store.get("workout", "old")?.content).toMatchObject({
      startedAt: "2021-01-02T23:55:00.000Z",
      endedAt: "2021-01-03T00:07:15.000Z",
    });
    expect(store.get("workout_set", set.id)?.content).toEqual(logged);
    expect(() => updateWorkoutDetails(store, "old", { durationSeconds: -1 })).toThrow();
    expect(() => updateWorkoutDetails(store, "old", { durationSeconds: Infinity })).toThrow();
    expect(workoutDetail(store, "old")?.summary.durationMinutes).toBe(12);
  } finally {
    store.close();
  }
});

it("refuses stale finish notes before removing unfinished sets and preserves untouched details on retry", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/finish-race.db",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.plank, 30);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { durationSeconds: 20 });
    const unfinished = addSet(store, entry);
    const row = store.get("workout", workout)?.content;
    if (!row) throw Error("Missing workout");
    store.put("workout", workout, {
      ...row,
      title: " New title ",
      description: "    First line\nSecond line\n",
    });
    expect(() =>
      finishWorkout(
        store,
        workout,
        { description: "Old draft", countForRoutine: true },
        { description: "" },
      ),
    ).toThrow(/changed/);
    expect(store.activeWorkout()?.id).toBe(workout);
    expect(store.list("workout_set", { parentId: entry }).map((r) => r.id)).toContain(unfinished);
    finishWorkout(store, workout, { countForRoutine: true });
    expect(store.get("workout", workout)?.content).toMatchObject({
      title: " New title ",
      description: "    First line\nSecond line\n",
    });
    expect(store.list("workout_set", { parentId: entry }).map((r) => r.id)).toEqual([set.id]);
  } finally {
    store.close();
  }
});

it("applies a workout rest default to new exercises, optionally updates existing exercises, and detects stale edits", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/rest.db",
    appVersion: "test",
  });
  try {
    const id = beginWorkout(store);
    const accountRest = readSettings(store).defaultRestSeconds;
    const current = liveData(store)?.tree.workout.content;
    if (!current) throw Error("Missing active workout");
    const bench = addExercise(store, id, EXERCISES.bench, 90);
    updateRunningWorkoutDetails(store, id, current, {}, { originalSeconds: null, seconds: 75 });
    const plank = addExercise(store, id, EXERCISES.plank, 90);
    const rest = (entry: string) => store.get("workout_exercise", entry)?.content?.restSeconds;
    expect([rest(bench), rest(plank)]).toEqual([90, 75]);
    const seen = new Map([
      [bench, 90],
      [plank, 75],
    ]);
    setExerciseRest(store, id, bench, "30");
    expect(() =>
      updateRunningWorkoutDetails(
        store,
        id,
        current,
        { title: "Changed" },
        { originalSeconds: 75, seconds: 0, applyTo: seen },
      ),
    ).toThrow(/changed/);
    expect(store.get("workout", id)?.content?.title).toBe(current.title);
    expect(workoutRest(store, id)).toBe(75);
    expect([rest(bench), rest(plank)]).toEqual([30, 75]);
    updateRunningWorkoutDetails(
      store,
      id,
      current,
      {},
      {
        originalSeconds: 75,
        seconds: 0,
        applyTo: new Map([
          [bench, 30],
          [plank, 75],
        ]),
      },
    );
    expect([rest(bench), rest(plank), rest(addExercise(store, id, EXERCISES.bench, 90))]).toEqual([
      0, 0, 0,
    ]);
    updateRunningWorkoutDetails(store, id, current, {}, { originalSeconds: 0, seconds: null });
    expect(rest(addExercise(store, id, EXERCISES.plank, 90))).toBe(90);
    expect(readSettings(store).defaultRestSeconds).toBe(accountRest);
  } finally {
    store.close();
  }
});

it("rejects a changed exercise or a finished workout before adding any part of a selection", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/selection.db",
    appVersion: "test",
  });
  try {
    const id = beginWorkout(store);
    const before = readWorkoutTree(store, id);
    const pending = store.summary();
    expect(() =>
      addSelectedExercises(
        store,
        id,
        [EXERCISES.bench, { ...EXERCISES.plank, name: "Stale name" }],
        45,
      ),
    ).toThrow(/changed/);
    expect(readWorkoutTree(store, id)).toEqual(before);
    expect(store.summary()).toEqual(pending);
    store.db.exec(`
      CREATE UNIQUE INDEX interrupt_selection ON records (kind)
      WHERE kind = 'workout_exercise'
    `);
    expect(() => addSelectedExercises(store, id, [EXERCISES.bench, EXERCISES.plank], 45)).toThrow(
      /UNIQUE constraint/,
    );
    expect(readWorkoutTree(store, id)).toEqual(before);
    expect(store.summary()).toEqual(pending);
    store.db.exec("DROP INDEX interrupt_selection");
    const ids = addSelectedExercises(store, id, [EXERCISES.bench, EXERCISES.plank], 45);
    expect(
      readWorkoutTree(store, id)
        ?.entries.slice(-2)
        .map(({ entry, sets }) => [entry.id, entry.content.restSeconds, sets.length]),
    ).toEqual([
      [ids[0], 45, 1],
      [ids[1], 45, 1],
    ]);
    store.put("workout", id, {
      ...store.get("workout", id)?.content,
      endedAt: new Date().toISOString(),
    });
    const finished = readWorkoutTree(store, id);
    expect(() => addSelectedExercises(store, id, [EXERCISES.curl], 45)).toThrow(/finished/);
    expect(readWorkoutTree(store, id)).toEqual(finished);
  } finally {
    store.close();
  }
});

it("reopens session exercise notes offline and refuses to append after the session ends", async () => {
  const engine = createSqlJsEngine(SQL);
  const reopen = () => openDeviceStore({ engine, path: "/exercise-notes", appVersion: "test" });
  let store = await reopen();
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.plank, 15);
    expect(() => addExerciseNote(store, workout, entry, "   ")).toThrow(/note/);
    addExerciseNote(store, workout, entry, "Set elbows one notch lower");
    store.close();
    store = await reopen();
    const stored = store.get("workout_exercise", entry)?.content;
    expect(stored?.notes).toEqual([
      { id: expect.any(String), text: "Set elbows one notch lower", createdAt: expect.any(String) },
    ]);
    expect(
      store.prepareSubmissions("1.0").find((s) => s.submission.id === entry)?.submission,
    ).toMatchObject({ kind: "workout_exercise", content: { notes: stored?.notes } });
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing plank set");
    logSet(store, set.id, { durationSeconds: 30 });
    finishWorkout(store, workout, { countForRoutine: false });
    expect(() => addExerciseNote(store, workout, entry, "Stale draft")).toThrow(/no longer/);
    expect(store.get("workout_exercise", entry)?.content).toEqual(stored);
  } finally {
    store.close();
  }
});

it("keeps a rejected workout exercise intact when a note draft tries to save", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/rejected-exercise",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.plank, 0);
    const pending = store
      .prepareSubmissions("1.0")
      .find(({ submission }) => submission.id === entry);
    if (!pending) throw Error("Missing exercise submission");
    store.applyPushResults([
      {
        submissionId: pending.submission.submissionId,
        status: "invalid",
        code: "invalid_content",
        message: "Rejected exercise",
      },
    ]);
    const rejected = store.get("workout_exercise", entry);
    expect(rejected?.status).toBe("invalid");
    expect(rejected?.problem).toBeTruthy();
    expect(() => addExerciseNote(store, workout, entry, "Hold")).toThrow(/sync issue/);
    expect(store.get("workout_exercise", entry)).toEqual(rejected);
  } finally {
    store.close();
  }
});

it("refuses a stale discard callback after an active workout has finished", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/discard.db",
    appVersion: "test",
  });
  try {
    const original = beginWorkout(store);
    const entry = addExercise(store, original, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { reps: 5, weightKg: 30 });
    finishWorkout(store, original, { title: "Saved on another device", countForRoutine: false });
    const next = beginWorkout(store);
    expect(() => discardActiveWorkout(store, original)).toThrow(/active workout changed/);
    expect(store.activeWorkout()?.id).toBe(next);
    expect(store.get("workout_set", set.id)?.content?.reps).toBe(5);
  } finally {
    store.close();
  }
});

it("appends a live set when the previous position is at the contract limit", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/append.db",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 90);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set?.content) throw Error("Missing set");
    store.put("workout_set", set.id, {
      ...set.content,
      position: 1_000_000_000_000_000,
      weightKg: 42,
    });
    const next = addSet(store, entry);
    expect(
      store
        .list("workout_set", { parentId: entry })
        .map((row) => [row.id, row.content?.position, row.content?.weightKg]),
    ).toEqual([
      [set.id, 1, 42],
      [next, 2, 42],
    ]);
  } finally {
    store.close();
  }
});

it("leaves a rejected set and its outbox alone when appending would renumber it", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/rejected-order",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set?.content) throw Error("Missing set");
    store.put("workout_set", set.id, { ...set.content, position: 1_000_000_000_000_000 });
    const outgoing = store.prepareSubmissions("1.0");
    store.applyPushResults(
      outgoing.map(({ submission }, index) =>
        submission.id === set.id
          ? {
              submissionId: submission.submissionId,
              status: "invalid",
              code: "invalid_content",
              message: "Rejected set",
            }
          : { submissionId: submission.submissionId, status: "accepted", revision: index + 1 },
      ),
    );
    const before = store.list("workout_set", { parentId: entry });
    expect(before[0]?.status).toBe("invalid");
    expect(() => addSet(store, entry)).toThrow(/sync/);
    expect(store.list("workout_set", { parentId: entry })).toEqual(before);
    expect(store.prepareSubmissions("1.0")).toEqual([]);
  } finally {
    store.close();
  }
});

it("retains the server's original set while a restored phone is offering it again", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/restored-order",
    appVersion: "test",
  });
  try {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set?.content) throw Error("Missing set");
    store.put("workout_set", set.id, { ...set.content, position: 1_000_000_000_000_000, reps: 8 });
    store.applyPushResults(
      store.prepareSubmissions("1.0").map(({ submission }, i) => ({
        submissionId: submission.submissionId,
        status: "accepted",
        revision: i + 1,
      })),
    );
    store.resetForServerRestore();
    const before = store.list("workout_set", { parentId: entry });
    expect(before[0]).toMatchObject({ status: "pending", fromRestore: true, content: { reps: 8 } });
    expect(() => addSet(store, entry)).toThrow(/sync/);
    expect(store.list("workout_set", { parentId: entry })).toEqual(before);
    expect(store.db.get("SELECT COUNT(*) AS n FROM submissions")).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});

it("keeps a skipped exercise's saved note in history and the outbox after finishing offline", async () => {
  const engine = createSqlJsEngine(SQL);
  const reopen = () => openDeviceStore({ engine, path: "/skipped-note", appVersion: "test" });
  let store = await reopen();
  try {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 60);
    const skipped = addExercise(store, workout, EXERCISES.plank, 15);
    const [set] = store.list("workout_set", { parentId: bench });
    if (!set) throw Error("Missing bench set");
    logSet(store, set.id, { weightKg: 20, reps: 5 });
    addExerciseNote(store, workout, skipped, "No mat available");
    finishWorkout(store, workout, { countForRoutine: false });
    store.close();
    store = await reopen();
    const history = readWorkoutTree(store, workout);
    expect(history?.entries.find(({ entry }) => entry.id === skipped)).toMatchObject({
      entry: { content: { notes: [{ text: "No mat available" }] } },
      sets: [],
    });
    expect(
      store.prepareSubmissions("1.0").find(({ submission }) => submission.id === skipped)
        ?.submission,
    ).toMatchObject({ op: "put", content: { notes: [{ text: "No mat available" }] } });
  } finally {
    store.close();
  }
});

it("discards the running workout as it was reviewed and starts the chosen routine instead", async () => {
  const store = await open();
  const pushId = beginWorkout(store, "seed-routine-push");
  const firstSet = () => {
    const tree = readWorkoutTree(store, pushId);
    const set = tree?.entries[0]?.sets[0];
    if (!set) throw Error("Missing set");
    return set;
  };
  logSet(store, firstSet().id, { weightKg: 60, reps: 8 });

  // A routine deleted meanwhile refuses before anything is deleted.
  const missing = workoutDeletionSnapshot(store, pushId);
  expect(() => replaceReviewedActiveWorkout(store, pushId, missing, "gone")).toThrow(
    "This routine no longer exists.",
  );
  expect(store.activeWorkout()?.id).toBe(pushId);

  // A set logged after the sheet opened refuses too: the person didn't see it.
  const stale = workoutDeletionSnapshot(store, pushId);
  const second = readWorkoutTree(store, pushId)?.entries[0]?.sets[1];
  if (!second) throw Error("Missing second set");
  logSet(store, second.id, { weightKg: 60, reps: 8 });
  expect(() => replaceReviewedActiveWorkout(store, pushId, stale, "seed-routine-pull")).toThrow(
    "The active workout changed. Review it before discarding.",
  );
  expect(store.activeWorkout()?.id).toBe(pushId);
  expect(setProgress(readWorkoutTree(store, pushId) ?? never()).done).toBe(2);

  const reviewed = workoutDeletionSnapshot(store, pushId);
  const pullId = replaceReviewedActiveWorkout(store, pushId, reviewed, "seed-routine-pull");
  expect(pullId).not.toBe(pushId);
  expect(readWorkoutTree(store, pushId)).toBeNull();
  expect(store.list("workout_exercise", { parentId: pushId })).toEqual([]);
  expect(store.activeWorkout()?.id).toBe(pullId);
  expect(liveData(store)?.tree.workout.content).toMatchObject({
    routineId: "seed-routine-pull",
    endedAt: null,
  });
  expect(setProgress(liveData(store)?.tree ?? never()).done).toBe(0);
  expect(verifyDeviceRecords(store.db, store.contract)).toEqual([]);
});

function never(): never {
  throw Error("Missing workout");
}
