import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { FaultyTransport, World } from "../../../packages/sync/test/support/harness.ts";
import {
  addExerciseNote,
  addNoteComment,
  commentsByNote,
  deleteExerciseNote,
  deleteNoteComment,
  editExerciseNote,
  MAX_PINNED_PER_EXERCISE,
  notesWrittenIn,
  resolveNoteProblem,
  setExerciseNotePinned,
  workoutExerciseNotes,
} from "../src/data/exercise-notes.ts";
import { workoutJournalData } from "../src/data/read.ts";
import { beginWorkout, finishWorkout } from "../src/data/workout-actions.ts";
import { unpinWorkoutNote, writeWorkoutNote } from "../src/data/workout-notes.ts";
import type {
  ExerciseNote,
  NoteComment,
  WithId,
  Workout,
  WorkoutNote,
} from "../src/model/types.ts";
import { carriedWorkoutNotes, exerciseCardNotes } from "../src/model/workout-notes.ts";

const at = (day: number, hour = 10, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString();
const workout = (id: string, day: number, routineId: string | null = null): WithId<Workout> => ({
  id,
  content: { title: id, startedAt: at(day), endedAt: at(day, 11), routineId },
});
const workoutNote = (id: string, day: number, pinned = false): WorkoutNote => ({
  id,
  pinned,
  text: id,
  createdAt: at(day, 10, 30),
  agent: null,
});
const comment = (noteId: string, day: number, agent: string | null = "Coach"): NoteComment => ({
  id: `${noteId}-${day}`,
  noteId,
  text: "Comment",
  createdAt: at(day, 19),
  agent,
});

describe("workout notes that come back", () => {
  // Push on days 2, 6 and 10; Legs on days 4 and 8; a free workout on day 12.
  const push1 = workout("push1", 2, "push");
  const legs1 = workout("legs1", 4, "legs");
  const push2 = workout("push2", 6, "push");
  const legs2 = workout("legs2", 8, "legs");
  const push3 = workout("push3", 10, "push");
  const free = workout("free", 12);
  const all = [push3, legs1, free, push1, legs2, push2];
  const notes = new Map([
    [push1.id, [workoutNote("deload", 2, true), workoutNote("tired", 2)]],
    [legs1.id, [workoutNote("legs-only", 4, true)]],
  ]);
  const shown = (target: WithId<Workout>, comments = new Map<string, NoteComment[]>()) =>
    carriedWorkoutNotes(all, target, notes, comments).map(({ note }) => note.id);

  it("shows a pinned note in every later workout of its routine and nowhere else", () => {
    expect(shown(push1)).toEqual([]);
    expect(shown(push2)).toEqual(["deload", "tired"]);
    expect(shown(push3)).toEqual(["deload"]);
    expect(shown(legs2)).toEqual(["legs-only"]);
  });

  it("shows a note that isn't pinned once, in the next workout of its routine", () => {
    expect(shown(legs2)).not.toContain("tired");
    expect(shown(push2)).toContain("tired");
    expect(shown(push3)).not.toContain("tired");
  });

  it("brings a note back once in the next workout after a later comment", () => {
    const late = new Map([["tired", [comment("tired", 7)]]]);
    expect(shown(push2, late)).toContain("tired");
    expect(shown(push3, late)).toContain("tired");
    const next = workout("push4", 14, "push");
    expect(
      carriedWorkoutNotes([...all, next], next, notes, late).map(({ note }) => note.id),
    ).toEqual(["deload"]);
  });

  it("shows a free workout's notes once in the very next workout, pinned or not", () => {
    const after = workout("after", 13, "legs");
    const later = workout("later", 15);
    const byWorkout = new Map([[free.id, [workoutNote("free-pin", 12, true)]]]);
    const workouts = [...all, after, later];
    const ids = (target: WithId<Workout>) =>
      carriedWorkoutNotes(workouts, target, byWorkout).map(({ note }) => note.id);
    // The next workout is a Legs day: the note shows there, then not again.
    expect(ids(after)).toEqual(["free-pin"]);
    expect(ids(later)).toEqual([]);
    expect(
      carriedWorkoutNotes([...all, later], later, byWorkout).map(({ note }) => note.id),
    ).toEqual(["free-pin"]);
  });

  it("keeps a routine's notes out of workouts of other routines and of free workouts", () => {
    const freeLater = workout("free-later", 16);
    const ids = carriedWorkoutNotes([...all, freeLater], freeLater, notes).map(
      ({ note }) => note.id,
    );
    expect(ids).toEqual([]);
  });
});

describe("exercise card notes", () => {
  const exerciseNote = (
    id: string,
    day: number,
    workoutId: string | null,
    pinned = false,
  ): ExerciseNote => ({
    id,
    exerciseId: "bench",
    workoutId,
    pinned,
    text: id,
    createdAt: at(day, 10, 30),
    agent: null,
  });
  // Bench on days 2, 6 and 9; day 4 is a workout without bench.
  const w2 = workout("w2", 2);
  const w6 = workout("w6", 6);
  const w9 = workout("w9", 9);
  const withBench = [w2, w6, w9];
  const notes = [
    exerciseNote("seat", 2, "w2", true),
    exerciseNote("shoulder", 2, "w2"),
    exerciseNote("from-screen", 5, null),
  ];
  const card = (target: WithId<Workout>, comments = new Map<string, NoteComment[]>()) => {
    const { pinned, lastTime, today } = exerciseCardNotes(notes, target, withBench, comments);
    return {
      pinned: pinned.map((n) => n.id),
      lastTime: lastTime.map((n) => n.id),
      today: today.map((n) => n.id),
    };
  };

  it("lists pinned notes every time and earlier notes in the next workout with the exercise", () => {
    expect(card(w2)).toEqual({ pinned: ["seat"], lastTime: [], today: ["shoulder"] });
    expect(card(w6)).toEqual({
      pinned: ["seat"],
      lastTime: ["from-screen", "shoulder"],
      today: [],
    });
    expect(card(w9)).toEqual({ pinned: ["seat"], lastTime: [], today: [] });
  });

  it("brings a note back after a comment, in the next workout with the exercise", () => {
    const late = new Map([["shoulder", [comment("shoulder", 7)]]]);
    expect(card(w9, late).lastTime).toEqual(["shoulder"]);
  });
});

async function openStore(path: string) {
  return openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    contract: previewContract,
    path,
    appVersion: "test",
  });
}

it("pins, edits and deletes one workout note independently of its siblings, and disables edits on an older connection", async () => {
  const db = await openStore("/notes.db");
  try {
    const id = beginWorkout(db);
    db.put("workout", id, { ...db.get("workout", id)?.content, routineId: "push" });
    const notes = () => workoutJournalData(db, id)?.notes ?? [];
    const draft = { text: "Use rack three", pinned: true };
    writeWorkoutNote(db, id, null, draft);
    const [pinned] = notes();
    if (!pinned) throw Error("Missing pinned note");
    writeWorkoutNote(db, id, null, { text: "All six reps", pinned: false });
    writeWorkoutNote(db, id, pinned, { ...draft, text: "Use rack four" });
    expect(notes().map((n) => [n.pinned, n.text, n.agent])).toEqual(
      expect.arrayContaining([
        [true, "Use rack four", null],
        [false, "All six reps", null],
      ]),
    );
    expect(() => writeWorkoutNote(db, id, pinned, null)).toThrow(/changed/);
    const current = notes().find((n) => n.id === pinned.id);
    if (!current) throw Error("Missing note");
    db.put("workout", "other", { ...db.get("workout", id)?.content, title: "Other session" });
    expect(() => unpinWorkoutNote(db, "other", pinned.id)).toThrow(/source workout/);
    expect(() => writeWorkoutNote(db, "other", current, null)).toThrow(/changed/);
    unpinWorkoutNote(db, id, pinned.id);
    expect(db.get("workout_note", pinned.id)?.content).toMatchObject({ pinned: false });
    db.bindAccount("s", "a");
    db.setNegotiated("1.2", []);
    expect(() => writeWorkoutNote(db, id, null, draft)).toThrow(/Update the connected server/);
    expect(() =>
      addExerciseNote(db, { exerciseId: "bench", workoutId: id, text: "Seat 3", pinned: true }),
    ).toThrow(/Update the connected server/);
  } finally {
    db.close();
  }
});

it("keeps an agent's note text and comments out of the lifter's edits", async () => {
  const db = await openStore("/agent.db");
  try {
    const id = beginWorkout(db);
    db.put("workout", id, { ...db.get("workout", id)?.content, routineId: "push" });
    db.put("workout_note", "coach-note", {
      workoutId: id,
      pinned: false,
      text: "Start with the top set",
      createdAt: at(2),
      agent: "Coach",
    });
    const note = workoutJournalData(db, id)?.notes.find((n) => n.id === "coach-note");
    if (!note) throw Error("Missing agent note");
    expect(note.agent).toBe("Coach");
    expect(() => writeWorkoutNote(db, id, note, { text: "Changed", pinned: false })).toThrow(
      /agent/,
    );
    // Pinning an agent's note keeps its text and author.
    writeWorkoutNote(db, id, note, { text: note.text, pinned: true });
    expect(db.get("workout_note", "coach-note")?.content).toMatchObject({
      pinned: true,
      text: "Start with the top set",
      agent: "Coach",
    });
    db.put("workout_note_comment", "coach-comment", {
      noteId: "coach-note",
      text: "Good session",
      createdAt: at(2, 19),
      agent: "Coach",
    });
    expect(() => deleteNoteComment(db, "workout_note", "coach-comment")).toThrow(/agent/);
    const mine = addNoteComment(db, "workout_note", "coach-note", "  Thanks  ");
    expect(
      workoutJournalData(db, id)
        ?.comments.get("coach-note")
        ?.map((c) => [c.text, c.agent]),
    ).toEqual([
      ["Good session", "Coach"],
      ["Thanks", null],
    ]);
    deleteNoteComment(db, "workout_note", mine);
    expect(
      commentsByNote(db, "workout_note")
        .get("coach-note")
        ?.map((c) => c.id),
    ).toEqual(["coach-comment"]);
  } finally {
    db.close();
  }
});

describe("exercise notes on the device", () => {
  let db: DeviceStore;
  const bench = (store: DeviceStore, workoutId: string) => {
    store.put("workout_exercise", `${workoutId}-bench`, {
      workoutId,
      exerciseId: "bench",
      exerciseName: "Bench Press",
      exerciseType: "weight_reps",
      position: 1,
      supersetId: null,
      restSeconds: 120,
      doubleDumbbellVolume: false,
    });
  };

  it("writes, pins, edits and deletes notes, with their comments", async () => {
    db = await openStore("/exercise-notes.db");
    try {
      const id = beginWorkout(db);
      bench(db, id);
      const seat = addExerciseNote(db, {
        exerciseId: "bench",
        workoutId: id,
        text: " Seat 3 ",
        pinned: true,
      });
      const today = addExerciseNote(db, {
        exerciseId: "bench",
        workoutId: id,
        text: "Shoulder twinged",
        pinned: false,
      });
      expect(() =>
        addExerciseNote(db, { exerciseId: "bench", workoutId: id, text: "   ", pinned: false }),
      ).toThrow(/Enter a note/);
      const card = () => workoutExerciseNotes(db, id).get("bench");
      expect(card()?.pinned.map((n) => n.text)).toEqual(["Seat 3"]);
      expect(card()?.today.map((n) => n.text)).toEqual(["Shoulder twinged"]);
      editExerciseNote(db, today, "Left shoulder twinged");
      setExerciseNotePinned(db, today, true);
      expect(card()?.pinned.map((n) => n.text)).toEqual(["Seat 3", "Left shoulder twinged"]);
      const reply = addNoteComment(db, "exercise_note", seat, "Try seat 4");
      expect(db.get("exercise_note_comment", reply)?.content).toMatchObject({
        noteId: seat,
        agent: null,
      });
      deleteExerciseNote(db, seat);
      expect(db.get("exercise_note", seat)?.deleted ?? true).toBe(true);
      expect(commentsByNote(db, "exercise_note").get(seat)).toBeUndefined();
      expect(card()?.pinned.map((n) => n.text)).toEqual(["Left shoulder twinged"]);
    } finally {
      db.close();
    }
  });

  it("refuses a pin past the limit and an edit of an agent's note", async () => {
    db = await openStore("/exercise-limits.db");
    try {
      const id = beginWorkout(db);
      for (let i = 0; i < MAX_PINNED_PER_EXERCISE; i++)
        addExerciseNote(db, { exerciseId: "bench", workoutId: id, text: `Pin ${i}`, pinned: true });
      expect(() =>
        addExerciseNote(db, { exerciseId: "bench", workoutId: id, text: "One more", pinned: true }),
      ).toThrow(/pinned notes/);
      const loose = addExerciseNote(db, {
        exerciseId: "bench",
        workoutId: null,
        text: "Loose",
        pinned: false,
      });
      expect(() => setExerciseNotePinned(db, loose, true)).toThrow(/pinned notes/);
      // Another exercise has its own limit.
      addExerciseNote(db, { exerciseId: "squat", workoutId: null, text: "Belt", pinned: true });
      db.put("exercise_note", "agent-note", {
        exerciseId: "squat",
        workoutId: null,
        pinned: false,
        text: "Go 82.5 kg next time",
        createdAt: at(3),
        agent: "Coach",
      });
      expect(() => editExerciseNote(db, "agent-note", "Go 90 kg")).toThrow(/agent/);
      setExerciseNotePinned(db, "agent-note", true);
      expect(db.get("exercise_note", "agent-note")?.content).toMatchObject({
        pinned: true,
        agent: "Coach",
      });
    } finally {
      db.close();
    }
  });

  it("keeps a workout's exercise notes when the workout is deleted, and lists the ones written in it", async () => {
    db = await openStore("/exercise-keep.db");
    try {
      const id = beginWorkout(db);
      bench(db, id);
      const seat = addExerciseNote(db, {
        exerciseId: "bench",
        workoutId: id,
        text: "Seat 3",
        pinned: true,
      });
      addExerciseNote(db, {
        exerciseId: "bench",
        workoutId: null,
        text: "Elsewhere",
        pinned: false,
      });
      expect(
        notesWrittenIn(db, id)
          .get("bench")
          ?.map((n) => n.id),
      ).toEqual([seat]);
      db.delete("workout", id);
      expect(db.get("exercise_note", seat)?.content).toMatchObject({ workoutId: id, pinned: true });
    } finally {
      db.close();
    }
  });
});

/** A workout of the push routine with one logged set, ready to finish. */
function loggedRoutineWorkout(db: DeviceStore) {
  const id = beginWorkout(db);
  db.put("workout", id, { ...db.get("workout", id)?.content, routineId: "push" });
  db.put("workout_exercise", `${id}-entry`, {
    workoutId: id,
    exerciseId: "bench",
    exerciseName: "Bench Press",
    exerciseType: "weight_reps",
    position: 1,
    supersetId: null,
    restSeconds: 120,
    doubleDumbbellVolume: false,
  });
  db.put("workout_set", `${id}-set`, {
    workoutExerciseId: `${id}-entry`,
    position: 1,
    type: "normal",
    weightKg: 80,
    reps: 5,
    distanceMeters: null,
    durationSeconds: null,
    count: null,
    rpe: null,
    completedAt: new Date().toISOString(),
  });
  return id;
}

it("pins workout notes only on a workout counted for its routine", async () => {
  const db = await openStore("/finish-note.db");
  try {
    const free = beginWorkout(db);
    expect(() => writeWorkoutNote(db, free, null, { text: "Seat 3", pinned: true })).toThrow(
      /routine workout/,
    );
    db.delete("workout", free);
    const uncounted = loggedRoutineWorkout(db);
    writeWorkoutNote(db, uncounted, null, { text: "Deload week", pinned: true });
    finishWorkout(db, uncounted, {
      countForRoutine: false,
      note: { text: "  Gym was packed  ", pinned: true },
    });
    expect(
      workoutJournalData(db, uncounted)
        ?.notes.map((n) => [n.text, n.pinned, n.agent])
        .sort(),
    ).toEqual([
      ["Deload week", false, null],
      ["Gym was packed", false, null],
    ]);
    // Counted, with a zero duration: the pin stays and the note comes back next time.
    const counted = loggedRoutineWorkout(db);
    finishWorkout(db, counted, {
      countForRoutine: true,
      durationSeconds: 0,
      note: { text: "Top set moved fast", pinned: false },
    });
    const [note] = workoutJournalData(db, counted)?.notes ?? [];
    expect(Date.parse(note?.createdAt ?? "")).toBeGreaterThan(
      Date.parse(String(db.get("workout", counted)?.content?.startedAt)),
    );
    const next = beginWorkout(db);
    db.put("workout", next, {
      ...db.get("workout", next)?.content,
      routineId: "push",
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(workoutJournalData(db, next)?.carried.map(({ note }) => note.text)).toEqual([
      "Top set moved fast",
    ]);
  } finally {
    db.close();
  }
});

it("syncs exercise notes and comments between devices, and keeps edits read-only while a richer download arrives", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const opts = { server: "s", account: "alice", transport };
    const first = await world.phone("first", opts);
    first.store.put("workout", "w", {
      title: "Strength",
      startedAt: at(2),
      endedAt: at(2, 11),
      routineId: "strength",
    });
    writeWorkoutNote(first.store, "w", null, { pinned: true, text: "Original cue" });
    const seat = addExerciseNote(first.store, {
      exerciseId: "bench",
      workoutId: "w",
      text: "Seat 3",
      pinned: true,
    });
    addNoteComment(first.store, "exercise_note", seat, "Felt stable");
    await first.sync();
    await server.restart({ releases: ["1.2"] });
    const net = new FaultyTransport(transport);
    const other = await world.phone("second", { ...opts, transport: net.call });
    await other.sync();
    const draft = { pinned: false, text: "Today's note" };
    let blocked = false;
    net.beforeReply = (path) => {
      if (path === "/sync/pull" && other.store.syncState().refreshFrom === "1.2") {
        expect(() => writeWorkoutNote(other.store, "w", null, draft)).toThrow(/sync finishes/);
        expect(() => addNoteComment(other.store, "exercise_note", seat, "Too early")).toThrow(
          /sync finishes/,
        );
        blocked = true;
      }
    };
    await server.restart({ releases: ["2.0"] });
    await other.sync();
    expect(blocked).toBe(true);
    expect(other.store.get("exercise_note", seat)?.content).toMatchObject({ text: "Seat 3" });
    writeWorkoutNote(other.store, "w", null, draft);
    addNoteComment(other.store, "exercise_note", seat, "Try seat 4");
    await other.sync();
    await first.sync();
    expect(
      workoutJournalData(first.store, "w")
        ?.notes.map((note) => note.text)
        .sort(),
    ).toEqual(["Original cue", "Today's note"]);
    expect(
      commentsByNote(first.store, "exercise_note")
        .get(seat)
        ?.map((c) => c.text),
    ).toEqual(["Felt stable", "Try seat 4"]);
    const pin = workoutJournalData(other.store, "w")?.notes.find((note) => note.pinned);
    if (!pin) throw Error("Missing pinned note");
    unpinWorkoutNote(other.store, "w", pin.id);
    deleteExerciseNote(other.store, seat);
    await other.sync();
    await first.sync();
    expect(first.store.get("workout_note", pin.id)?.content).toMatchObject({
      workoutId: "w",
      pinned: false,
      text: "Original cue",
      createdAt: pin.createdAt,
    });
    expect(first.store.get("exercise_note", seat)?.deleted ?? true).toBe(true);
    expect(commentsByNote(first.store, "exercise_note").get(seat)).toBeUndefined();
    unpinWorkoutNote(first.store, "w", pin.id);
    expect(first.store.hasUnsyncedWork()).toBe(false);
    // Deleting the workout on the server keeps the exercise notes written in it.
    const belt = addExerciseNote(first.store, {
      exerciseId: "squat",
      workoutId: "w",
      text: "Belt on the top set",
      pinned: true,
    });
    await first.sync();
    first.store.delete("workout", "w");
    await first.sync();
    await other.sync();
    expect((await server.row("alice", "workout", "w"))?.state).toBe("deleted");
    expect((await server.row("alice", "exercise_note", belt))?.content).toMatchObject({
      workoutId: "w",
      pinned: true,
    });
    expect(other.store.get("exercise_note", belt)?.content).toMatchObject({
      text: "Belt on the top set",
    });
  } finally {
    await world.dispose();
  }
});

it("settles an exercise note changed on two phones with the version the lifter picks", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const opts = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", opts);
    const seat = addExerciseNote(a.store, {
      exerciseId: "bench",
      workoutId: null,
      text: "Seat 3",
      pinned: true,
    });
    await a.sync();
    const b = await world.phone("b", opts);
    await b.sync();
    const both = async (here: string, there: string) => {
      editExerciseNote(a.store, seat, there);
      await a.sync();
      editExerciseNote(b.store, seat, here);
      await b.sync();
      const row = b.store.get("exercise_note", seat);
      expect(row).toMatchObject({ status: "conflict", content: { text: here } });
      if (!row) throw Error("Missing note");
      return row;
    };
    const first = await both("Seat 2", "Seat 4");
    // A choice made on a copy that has changed since is refused.
    expect(() =>
      resolveNoteProblem(
        b.store,
        { ...first, content: { ...first.content, text: "Old" } },
        "keep_mine",
      ),
    ).toThrow(/changed/);
    resolveNoteProblem(b.store, first, "keep_mine");
    await b.sync();
    await a.sync();
    expect(a.store.get("exercise_note", seat)?.content?.text).toBe("Seat 2");
    const second = await both("Seat 1", "Seat 5");
    resolveNoteProblem(b.store, second, "keep_theirs");
    await b.sync();
    expect(b.store.get("exercise_note", seat)?.content?.text).toBe("Seat 5");
    expect(b.store.hasUnsyncedWork()).toBe(false);
    // Deleted on the other phone: this phone's edit can't be kept as it was.
    deleteExerciseNote(a.store, seat);
    await a.sync();
    editExerciseNote(b.store, seat, "Seat 6");
    await b.sync();
    const gone = b.store.get("exercise_note", seat);
    if (!gone?.problem) throw Error("Expected a sync problem");
    expect(() => resolveNoteProblem(b.store, gone, "keep_mine")).toThrow();
    resolveNoteProblem(b.store, gone, "keep_theirs");
    await b.sync();
    expect(b.store.get("exercise_note", seat)?.deleted ?? true).toBe(true);
  } finally {
    await world.dispose();
  }
});
