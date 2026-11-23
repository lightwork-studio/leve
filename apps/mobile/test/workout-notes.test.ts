import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { FaultyTransport, World } from "../../../packages/sync/test/support/harness.ts";
import { workoutJournalData } from "../src/data/read.ts";
import { beginWorkout } from "../src/data/workout-actions.ts";
import { unpinWorkoutNote, writeWorkoutNote } from "../src/data/workout-notes.ts";
import type { WithId, Workout, WorkoutNote } from "../src/model/types.ts";
import { carriedWorkoutNotes } from "../src/model/workout-notes.ts";

const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
const workout = (id: string, day: number): WithId<Workout> => ({
  id,
  content: {
    title: id,
    description: "",
    startedAt: at(day),
    endedAt: at(day, 11),
    routineId: null,
  },
});
describe("workout journal", () => {
  const first = workout("Monday", 2);
  const notes: WorkoutNote[] = [
    { id: "setup", kind: "sticky", text: "Use the lower bench", createdAt: at(2), reply: null },
    {
      id: "effort",
      kind: "session",
      text: "Last set felt easy",
      createdAt: at(2),
      reply: { text: "Add a rep", createdAt: at(5, 19) },
    },
    { id: "private", kind: "session", text: "Slept well", createdAt: at(2), reply: null },
  ];
  const wed = workout("Wednesday", 4);
  const fri = workout("Friday", 6);
  const sun = workout("Sunday", 8);
  const week = [sun, first, fri, wed];
  const visible = (target: WithId<Workout>) =>
    carriedWorkoutNotes(week, target, new Map([[first.id, notes]])).map(({ note, showReply }) => [
      note.id,
      showReply ? note.reply?.text : null,
    ]);

  it("keeps a session note on its workout and carries pinned notes across later workouts", () => {
    expect(visible(first)).toEqual([]);
    expect(visible(wed)).toEqual([["setup", null]]);
    expect(visible(sun)).toEqual([["setup", null]]);
  });
  function checkReplyDelivery(select: typeof carriedWorkoutNotes) {
    const byWorkout = new Map([[first.id, notes]]);
    const repliesAt = (target: WithId<Workout>) =>
      select(week, target, byWorkout)
        .filter((item) => item.showReply)
        .map((item) => [item.workoutId, item.note.text, item.note.reply?.text]);
    expect(repliesAt(wed)).toEqual([]);
    expect(repliesAt(fri)).toEqual([["Monday", "Last set felt easy", "Add a rep"]]);
    expect(repliesAt(sun)).toEqual([]);
  }
  it("shows a late coach reply alongside its source note on the next workout exactly once", () => {
    checkReplyDelivery(carriedWorkoutNotes);
  });
  it("detects a selector that repeats an already delivered reply", () => {
    const repeatsReply: typeof carriedWorkoutNotes = (workouts, target, notes) => {
      // Forget intervening workouts so earlier replies can appear again.
      return carriedWorkoutNotes(
        workouts.filter((row) => notes.has(row.id)),
        target,
        notes,
      );
    };
    expect(() => checkReplyDelivery(repeatsReply)).toThrow();
  });
});

it("updates one note independently of its siblings, rejects a stale reply, and disables edits on an older connection", async () => {
  const db = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    contract: previewContract,
    path: "/notes.db",
    appVersion: "test",
  });
  try {
    const id = beginWorkout(db);
    const notes = () => workoutJournalData(db, id)?.notes ?? [];
    const draft = { text: "Use rack three", kind: "sticky" as const, reply: "" };
    writeWorkoutNote(db, id, null, draft);
    const [pinned] = notes();
    if (!pinned) throw Error("Missing pinned note");
    writeWorkoutNote(db, id, null, { text: "All six reps", kind: "session", reply: "" });
    writeWorkoutNote(db, id, pinned, { ...draft, reply: "Keep the same setup" });
    expect(notes().map((n) => [n.kind, n.text, n.reply?.text])).toEqual(
      expect.arrayContaining([
        ["sticky", "Use rack three", "Keep the same setup"],
        ["session", "All six reps", undefined],
      ]),
    );
    expect(() => writeWorkoutNote(db, id, pinned, null)).toThrow(/changed/);
    db.put("workout", "other", { ...db.get("workout", id)?.content, title: "Other session" });
    const current = notes().find((n) => n.id === pinned.id);
    if (!current) throw Error("Missing note");
    const queuedSubmissions = () =>
      db
        .prepareSubmissions("2.0")
        .sort((a, b) => a.submission.submissionId.localeCompare(b.submission.submissionId));
    const submitted = queuedSubmissions();
    expect(() => unpinWorkoutNote(db, "other", pinned.id)).toThrow(/source workout/);
    for (const change of [{ ...draft, text: "Moved" }, null]) {
      expect(() => writeWorkoutNote(db, "other", current, change)).toThrow(/changed/);
      expect(notes().find((n) => n.id === pinned.id)).toEqual(current);
      expect(workoutJournalData(db, "other")?.notes).toEqual([]);
      expect(queuedSubmissions()).toEqual(submitted);
    }
    db.bindAccount("s", "a");
    db.setNegotiated("1.2", []);
    expect(() => unpinWorkoutNote(db, id, pinned.id)).toThrow(/Update the connected server/);
    expect(() => writeWorkoutNote(db, id, null, draft)).toThrow(/Update the connected server/);
    db.setNegotiated("2.0", ["workout_journal"]);
    expect(() => writeWorkoutNote(db, id, null, draft)).toThrow(/sync finishes/);
    db.applyPull([], 0, { cursor: 0, lineage: null, release: "2.0", lastPage: true });
    const latest = notes().find((n) => n.id === pinned.id);
    if (!latest) throw Error("Missing updated note");
    writeWorkoutNote(db, id, latest, null);
    expect(notes().map((n) => n.text)).toEqual(["All six reps"]);
  } finally {
    db.close();
  }
});

it("keeps the journal read-only while its first richer download is arriving", async () => {
  const world = new World(previewContract);
  try {
    const server = world.server();
    const transport = server.transport("alice");
    const opts = { server: "s", account: "alice", transport };
    const first = await world.phone("first", opts);
    first.store.put("workout", "w", {
      title: "Strength",
      description: "",
      startedAt: at(2),
      endedAt: at(2, 11),
      routineId: null,
    });
    writeWorkoutNote(first.store, "w", null, { kind: "sticky", text: "Original cue", reply: "" });
    await first.sync();
    await server.restart({ releases: ["1.2"] });
    const net = new FaultyTransport(transport);
    const other = await world.phone("second", { ...opts, transport: net.call });
    await other.sync();
    const draft = { kind: "session" as const, text: "Today's note", reply: "" };
    let blocked = false;
    net.beforeReply = (path) => {
      if (path === "/sync/pull" && other.store.syncState().refreshFrom === "1.2") {
        expect(() => writeWorkoutNote(other.store, "w", null, draft)).toThrow(/sync finishes/);
        blocked = true;
      }
    };
    await server.restart({ releases: ["2.0"] });
    await other.sync();
    expect(blocked).toBe(true);
    writeWorkoutNote(other.store, "w", null, draft);
    await other.sync();
    await first.sync();
    expect(
      workoutJournalData(first.store, "w")
        ?.notes.map((note) => note.text)
        .sort(),
    ).toEqual(["Original cue", "Today's note"]);
    const pin = workoutJournalData(other.store, "w")?.notes.find((note) => note.kind === "sticky");
    if (!pin) throw Error("Missing reminder");
    unpinWorkoutNote(other.store, "w", pin.id);
    await other.sync();
    await first.sync();
    expect(first.store.get("workout_note", pin.id)?.content).toMatchObject({
      workoutId: "w",
      kind: "session",
      text: "Original cue",
      createdAt: pin.createdAt,
    });
    unpinWorkoutNote(first.store, "w", pin.id);
    expect(first.store.hasUnsyncedWork()).toBe(false);
  } finally {
    await world.dispose();
  }
});
