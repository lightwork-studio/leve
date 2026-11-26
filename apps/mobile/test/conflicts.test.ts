import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@leve/contract";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { SyncClient, type Transport } from "@leve/sync";
import { SyncService, serviceTransport } from "@leve/sync/server";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conflicts, settleConflict } from "../src/data/conflicts.ts";
import { saveSettings, settingsContent } from "../src/data/settings-actions.ts";

/* Real conflicts, made by two phones syncing one account through a real sync service. */

vi.mock("../src/data/ids.ts", () => {
  let id = 0;
  return { newId: () => `copy-${++id}` };
});

const SQL = await initSqlJs();
let directory: string;
let storage: ServerStorage;
let service: SyncService;
let ids = 0;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "leve-conflicts-"));
  storage = new ServerStorage({ engine: createNodeSqliteEngine(), directory, appVersion: "test" });
  service = new SyncService({ storage });
  refuse = new Set();
});
afterEach(async () => {
  await storage.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Which records the server should turn down as invalid, as `kind:id`. */
let refuse = new Set<string>();

/** The service, except that uploads of the records in `refuse` are turned down as invalid. */
const refusing =
  (inner: Transport): Transport =>
  async (path, body) => {
    if (path !== "/sync/push") return inner(path, body);
    const request = body as { submissions: { submissionId: string; kind: string; id: string }[] };
    const refused = request.submissions.filter((item) => refuse.has(`${item.kind}:${item.id}`));
    if (!refused.length) return inner(path, body);
    // The server never sees them: it answers only for the rest.
    const rest = request.submissions.filter((item) => !refused.includes(item));
    const reply = rest.length
      ? await inner(path, { ...request, submissions: rest })
      : { status: 200, body: { release: (body as { release: string }).release, results: [] } };
    if (reply.status !== 200) return reply;
    const answered = new Map(
      (reply.body as { results: { submissionId: string }[] }).results.map((result) => [
        result.submissionId,
        result,
      ]),
    );
    return {
      status: 200,
      body: {
        ...(reply.body as object),
        results: request.submissions.map(
          (item) =>
            answered.get(item.submissionId) ?? {
              status: "invalid",
              submissionId: item.submissionId,
              code: "invalid_content",
              message: "refused in this test",
            },
        ),
      },
    };
  };

async function phone(name: string) {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/${name}.db`,
    appVersion: "test",
    randomId: () => `${name}-${++ids}`,
  });
  const client = new SyncClient({
    store,
    // Through whichever service is running, so a test can swap in a restored server.
    transport: refusing((path, body) => serviceTransport(service, "alice")(path, body)),
    server: "s",
    account: "alice",
    app: name,
  });
  const sync = async () => {
    const outcome = await client.sync();
    expect(outcome.state).toBe("synced");
  };
  return { store, sync };
}

const STARTED = "2026-11-24T18:00:00.000Z";
const workout = (title: string): JsonObject => ({
  title,
  startedAt: STARTED,
  endedAt: "2026-11-24T19:00:00.000Z",
  routineId: null,
});
const entry = (workoutId: string): JsonObject => ({
  workoutId,
  exerciseId: "bench-press-barbell",
  exerciseName: "Bench Press",
  exerciseType: "weight_reps",
  position: 1,
  supersetId: null,
  restSeconds: 90,
  doubleDumbbellVolume: false,
});
const set = (weightKg: number, reps: number): JsonObject => ({
  workoutExerciseId: "e1",
  position: 1,
  type: "normal",
  weightKg,
  reps,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: STARTED,
});

const serverRow = async (kind: string, id: string) =>
  (await storage.account("alice")).db.get("SELECT * FROM records WHERE kind = ? AND id = ?", [
    kind,
    id,
  ]);

/** Two phones that both hold `seed`, synced. */
async function twoPhones(seed: (store: DeviceStore) => void) {
  const a = await phone("a");
  const b = await phone("b");
  seed(a.store);
  await a.sync();
  await b.sync();
  return { a, b };
}

it("settles a routine renamed in two places with the version chosen", async () => {
  const folder = { title: "Push", position: 1 };
  const { a, b } = await twoPhones((store) => store.put("routine_folder", "f1", folder));
  a.store.put("routine_folder", "f1", { ...folder, title: "Push A" });
  b.store.put("routine_folder", "f1", { ...folder, title: "Push B" });
  await a.sync();
  await b.sync();

  const [conflict, ...rest] = conflicts(b.store);
  expect(rest).toEqual([]);
  expect(conflict).toMatchObject({
    key: "routine_folder:f1",
    title: "Push B",
    subtitle: "Folder",
    phone: { lines: [{ label: "Name", value: "Push B" }], choosable: true },
    account: { lines: [{ label: "Name", value: "Push A" }], choosable: true },
  });
  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect(JSON.parse(String((await serverRow("routine_folder", "f1"))?.content)).title).toBe(
    "Push B",
  );
});

it("settles a workout as one: every set that clashes takes the chosen side", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("workout_set", "s2", { ...set(80, 7), position: 2 });
  });
  a.store.put("workout_set", "s1", set(85, 6));
  a.store.put("workout_set", "s2", { ...set(85, 5), position: 2 });
  b.store.put("workout_set", "s1", set(82.5, 8));
  b.store.put("workout_set", "s2", { ...set(82.5, 7), position: 2 });
  await a.sync();
  await b.sync();

  const all = conflicts(b.store);
  expect(all).toHaveLength(1);
  const conflict = all[0]!;
  expect(conflict.key).toBe("workout:w1");
  expect(conflict.title).toBe("Push Day");
  expect(conflict.phone.lines).toEqual([
    { label: "Bench Press · Set 1", value: "82.5 kg × 8" },
    { label: "Bench Press · Set 2", value: "82.5 kg × 7" },
  ]);
  expect(conflict.account.lines).toEqual([
    { label: "Bench Press · Set 1", value: "85 kg × 6" },
    { label: "Bench Press · Set 2", value: "85 kg × 5" },
  ]);

  settleConflict(b.store, conflict, "account");
  expect(conflicts(b.store)).toEqual([]);
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 85, reps: 6 });
  expect(b.store.get("workout_set", "s2")?.content).toMatchObject({ weightKg: 85, reps: 5 });
});

it("sends a deletion again when it's kept over a change made elsewhere", async () => {
  const entryOf = (kg: number) => ({ takenAt: STARTED, bodyweightKg: kg, fatPercent: null });
  const { a, b } = await twoPhones((store) => store.put("body_measurement", "m1", entryOf(80)));
  a.store.put("body_measurement", "m1", entryOf(80.4));
  await a.sync();
  b.store.delete("body_measurement", "m1");
  await b.sync();

  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({
    key: "body_measurement:m1",
    title: "Bodyweight",
    phone: { lines: [{ label: "Entry", value: "Deleted" }], confirm: "Delete it" },
  });
  // The account's version in full: what keeping the deletion throws away.
  expect(conflict!.account.lines).toContainEqual({ label: "Bodyweight", value: "80.4 kg" });
  expect(conflict!.account.lines.map((line) => line.label)).toContain("Taken");
  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  expect((await serverRow("body_measurement", "m1"))?.state).toBe("deleted");
});

it("refuses a choice made on an outdated view, and leaves out what's still syncing", async () => {
  const folder = { title: "Push", position: 1 };
  const { a, b } = await twoPhones((store) => store.put("routine_folder", "f1", folder));
  a.store.put("routine_folder", "f1", { ...folder, title: "Push A" });
  b.store.put("routine_folder", "f1", { ...folder, title: "Push B" });
  await a.sync();
  await b.sync();
  const shown = conflicts(b.store)[0]!;

  // Changed again on this phone after it was shown.
  b.store.put("routine_folder", "f1", { ...folder, title: "Push C" });
  expect(() => settleConflict(b.store, shown, "phone")).toThrow("changed in the meantime");
  expect(JSON.parse(String((await serverRow("routine_folder", "f1"))?.content)).title).toBe(
    "Push A",
  );
});

it("leaves out a refused change that never reached the account, so nothing below it goes unseen", async () => {
  const b = await phone("b");
  b.store.put("workout", "w1", workout("Offline Day"));
  b.store.put("workout_exercise", "e1", entry("w1"));
  b.store.put("workout_set", "s1", set(60, 10));
  refuse = new Set(["workout:w1"]);
  await b.sync();
  expect(b.store.get("workout", "w1")?.status).toBe("invalid");
  expect(conflicts(b.store)).toEqual([]);
  // Nothing was dropped: the workout and what waits below it are still here.
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 60 });
});

it("asks about a refused change on its own, apart from valid changes beside it", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
  });
  a.store.put("workout", "w1", workout("Push A"));
  await a.sync();
  b.store.put("workout", "w1", workout("Push B"));
  b.store.put("workout_set", "s1", set(90, 8));
  refuse = new Set(["workout_set:s1"]);
  await b.sync();

  const all = conflicts(b.store);
  expect(all.map((item) => item.key).sort()).toEqual(["workout:w1", "workout:w1|workout_set:s1"]);
  const title = all.find((item) => item.key === "workout:w1")!;
  const refused = all.find((item) => item.key !== "workout:w1")!;
  expect(title.phone.choosable).toBe(true);
  expect(refused).toMatchObject({
    phone: { choosable: false },
    account: { confirm: "Undo my change" },
  });

  // Undoing the refused set leaves the title choice open, and keeping this phone's title works.
  settleConflict(b.store, refused, "account");
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 80 });
  settleConflict(b.store, conflicts(b.store)[0]!, "phone");
  expect(b.store.get("workout", "w1")?.content).toMatchObject({ title: "Push B" });
});

it("shows differences a set's weight and reps don't, and a routine's planned targets", async () => {
  const plan = (kg: number) => ({
    title: "Push",
    folderId: null,
    position: 1,
    effortScale: null,
    exercises: [
      {
        id: "x1",
        exerciseId: "bench-press-barbell",
        exerciseName: "Bench Press",
        exerciseType: "weight_reps",
        supersetId: null,
        restSeconds: 90,
        useRepRange: false,
        sets: [
          {
            id: "t1",
            type: "normal",
            weightKg: kg,
            reps: 8,
            repRangeMin: null,
            repRangeMax: null,
            distanceMeters: null,
            durationSeconds: null,
            count: null,
            rpe: null,
            repsInReserve: null,
          },
        ],
      },
    ],
  });
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("routine", "r1", plan(80));
  });
  a.store.put("workout_set", "s1", { ...set(80, 8), rpe: 7 });
  a.store.put("routine", "r1", plan(90));
  await a.sync();
  b.store.put("workout_set", "s1", { ...set(80, 8), rpe: 9 });
  b.store.put("routine", "r1", plan(85));
  await b.sync();

  const all = conflicts(b.store);
  const workoutConflict = all.find((item) => item.key === "workout:w1")!;
  expect(workoutConflict.phone.lines).toEqual([
    { label: "Bench Press · Set 1", value: "80 kg × 8 RPE 9" },
  ]);
  expect(workoutConflict.account.lines).toEqual([
    { label: "Bench Press · Set 1", value: "80 kg × 8 RPE 7" },
  ]);
  const routineConflict = all.find((item) => item.key === "routine:r1")!;
  expect(routineConflict.phone.lines).toEqual([
    { label: "Bench Press", value: "1 set · 85 kg × 8" },
  ]);
  expect(routineConflict.account.lines).toEqual([
    { label: "Bench Press", value: "1 set · 90 kg × 8" },
  ]);
});

it("settles a record deleted in both places", async () => {
  const entryOf = (kg: number) => ({ takenAt: STARTED, bodyweightKg: kg, fatPercent: null });
  const { a, b } = await twoPhones((store) => store.put("body_measurement", "m1", entryOf(80)));
  a.store.delete("body_measurement", "m1");
  await a.sync();
  b.store.put("body_measurement", "m1", entryOf(81));
  await b.sync();
  // Deleted here too while the question waited.
  b.store.delete("body_measurement", "m1");
  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({
    phone: { confirm: "Keep it deleted", choosable: true },
    account: { confirm: "Keep it deleted" },
  });
  settleConflict(b.store, conflict!, "phone");
  expect(b.store.problems()).toEqual([]);
});

it("still asks about other clashes in a workout that also holds a refused change it can't settle", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push"));
    store.put("workout_exercise", "e1", entry("w1"));
  });
  a.store.put("workout", "w1", workout("Push A"));
  await a.sync();
  b.store.put("workout", "w1", workout("Push B"));
  b.store.put("workout_set", "new", set(70, 10));
  refuse = new Set(["workout_set:new"]);
  await b.sync();
  expect(b.store.get("workout_set", "new")?.status).toBe("invalid");
  // The refused set has no account copy, so it isn't asked about; the name clash still is.
  expect(conflicts(b.store).map((item) => item.key)).toEqual(["workout:w1"]);
});

it("settles a set deleted in both places on its own", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("workout_set", "s2", { ...set(80, 8), position: 2 });
  });
  a.store.delete("workout_set", "s2");
  await a.sync();
  b.store.put("workout_set", "s2", { ...set(90, 8), position: 2 });
  await b.sync();
  b.store.delete("workout_set", "s2");
  const all = conflicts(b.store);
  expect(all).toHaveLength(1);
  settleConflict(b.store, all[0]!, "account");
  expect(b.store.problems()).toEqual([]);
});

it("leads a workout deleted in the account, but changed here, to the workout's own review", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Pull Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(60, 10));
  });
  a.store.delete("workout", "w1");
  await a.sync();
  b.store.put("workout_set", "s1", set(65, 10));
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict).toMatchObject({
    key: "workout:w1",
    title: "Pull Day",
    review: { target: { pathname: "/workout/[id]", params: { id: "w1" } } },
  });
  // Never settled from the popup: nothing below it can go unseen.
  expect(() => settleConflict(b.store, conflict!, "account")).toThrow("on its screen");
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 65 });
});

it("leads a workout deleted here, but changed in the account, to History", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Leg Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(100, 5));
  });
  a.store.put("workout_set", "s1", set(140, 5));
  await a.sync();
  b.store.delete("workout", "w1");
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict?.review?.target).toEqual({ pathname: "/(tabs)/history" });
  expect(() => settleConflict(b.store, conflict!, "phone")).toThrow("on its screen");
});

it("leads an exercise deleted in the account, with sets changed here, to the workout", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
  });
  a.store.delete("workout_exercise", "e1");
  await a.sync();
  b.store.put("workout_set", "s1", set(85, 8));
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict?.review?.target).toEqual({ pathname: "/workout/[id]", params: { id: "w1" } });
});

it("asks straight away about work logged under something deleted in the account", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
  });
  a.store.delete("workout_exercise", "e1");
  await a.sync();
  b.store.put("workout_set", "s1", set(85, 8));
  await b.sync();
  // Logged after the deletion arrived, not uploaded yet: the review shows it, so no waiting.
  b.store.put("workout_set", "s10", { ...set(100, 3), position: 2 });
  expect(conflicts(b.store).map((item) => item.review?.target.pathname)).toEqual(["/workout/[id]"]);
});

const note = (text: string) => ({
  workoutId: "w1",
  pinned: false,
  text,
  createdAt: STARTED,
  agent: null,
});
const comment = (text: string) => ({ noteId: "n1", text, createdAt: STARTED, agent: null });

it("keeps a comment under a note deleted in the account by saving the note as new, in the popup", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_note", "n1", note("Felt strong"));
    store.put("workout_note_comment", "c1", comment("Agreed"));
  });
  a.store.delete("workout_note", "n1");
  await a.sync();
  b.store.put("workout_note_comment", "c1", comment("Agreed, and add weight next time"));
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict?.review).toBeUndefined();
  expect(conflict?.phone.choosable).toBe(true);
  settleConflict(b.store, conflict!, "phone");
  await b.sync();
  expect(conflicts(b.store)).toEqual([]);
  const kept = b.store
    .list("workout_note_comment")
    .filter((row) => row.content?.text === "Agreed, and add weight next time");
  expect(kept).toHaveLength(1);
  expect(kept[0]!.content?.noteId).not.toBe("n1");
});

it("shows the account's comments before a note's deletion is kept over them", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_note", "n1", note("Felt strong"));
  });
  a.store.put("workout_note_comment", "c1", comment("Try a pause rep"));
  await a.sync();
  b.store.delete("workout_note", "n1");
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict?.account.lines).toContainEqual({ label: "Comment", value: "Try a pause rep" });
});

it("only offers the account's version for a note deleted here that gained comments there", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_note", "n1", note("Felt strong"));
  });
  a.store.put("workout_note_comment", "c1", comment("Try a pause rep"));
  await a.sync();
  b.store.delete("workout_note", "n1");
  await b.sync();
  const [conflict] = conflicts(b.store);
  expect(conflict?.phone.choosable).toBe(false);
  expect(() => settleConflict(b.store, conflict!, "phone")).toThrow();
  settleConflict(b.store, conflict!, "account");
  await b.sync();
  expect((await serverRow("workout_note_comment", "c1"))?.state).toBe("live");
});

it("waits while a workout deleted here is still to upload, instead of leading to a screen that's gone", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
  });
  a.store.delete("workout_exercise", "e1");
  await a.sync();
  b.store.put("workout_set", "s1", set(85, 8));
  await b.sync();
  b.store.delete("workout", "w1");
  expect(conflicts(b.store)).toEqual([]);
});

it("keeps a deleted note that holds comments in the account apart from other clashes in its workout", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("workout_note", "n1", note("Felt strong"));
  });
  a.store.put("workout_note_comment", "c1", comment("Try a pause rep"));
  a.store.put("workout_set", "s1", set(85, 8));
  await a.sync();
  b.store.delete("workout_note", "n1");
  b.store.put("workout_set", "s1", set(90, 8));
  await b.sync();
  const all = conflicts(b.store);
  const sets = all.find((item) => item.key === "workout:w1")!;
  // The set clash can still be settled with this phone's version.
  expect(sets.phone.choosable).toBe(true);
  settleConflict(b.store, sets, "phone");
  expect(b.store.get("workout_set", "s1")?.content).toMatchObject({ weightKg: 90 });
  expect(all.find((item) => item.key.endsWith("|workout_note:n1"))?.phone.choosable).toBe(false);
});

it("still asks about clashes beside a deletion a restored server never had", async () => {
  const { a, b } = await twoPhones((store) => {
    store.put("workout", "w1", workout("Push Day"));
    store.put("workout_exercise", "e1", entry("w1"));
    store.put("workout_set", "s1", set(80, 8));
    store.put("workout_set", "s2", { ...set(80, 8), position: 2 });
  });
  a.store.put("workout_set", "s1", set(85, 8));
  a.store.put("workout_set", "s2", { ...set(85, 8), position: 2 });
  await a.sync();
  b.store.delete("workout_set", "s1");
  b.store.put("workout_set", "s2", { ...set(100, 8), position: 2 });
  await b.sync();
  expect(conflicts(b.store).map((item) => item.key)).toEqual(["workout:w1"]);

  // The server is restored from a backup that has the workout and s2, but never had s1.
  await storage.close();
  directory = mkdtempSync(join(tmpdir(), "leve-conflicts-restored-"));
  storage = new ServerStorage({ engine: createNodeSqliteEngine(), directory, appVersion: "test" });
  service = new SyncService({ storage });
  const c = await phone("c");
  c.store.put("workout", "w1", workout("Push Day"));
  c.store.put("workout_exercise", "e1", entry("w1"));
  c.store.put("workout_set", "s2", { ...set(85, 8), position: 2 });
  await c.sync();
  await b.sync();

  // s1's deletion can't be placed, but it no longer hides the s2 clash.
  const keys = conflicts(b.store).map((item) => item.key);
  expect(keys).toContain("workout:w1");
  const s2 = conflicts(b.store).find((item) => item.key === "workout:w1")!;
  expect(s2.records.map((row) => row.id)).toEqual(["s2"]);
});

it.each([
  [false, "phone", "lbs"],
  [false, "account", null],
  [true, "account", "kg"],
] as const)(
  "settles moved settings in the popup when the destination has no copy (prior copy: %s, choice: %s)",
  async (hasPrevious, choice, unit) => {
    const { store } = await phone("settings-move");
    store.bindAccount("s", "alice");
    store.setNegotiated("1.0", [], "source");
    const previous = {
      kind: "settings",
      id: "settings",
      state: "live",
      revision: 1,
      content: settingsContent(null, { weightUnit: "kg" }),
    } as const;
    if (hasPrevious) store.applyPull([previous], 1);
    saveSettings(store, { weightUnit: "lbs" });
    const [outgoing] = store.prepareSubmissions("1.0");
    if (!outgoing) throw Error("expected settings ready to upload");
    store.applyPushResults([
      {
        status: "conflict",
        submissionId: outgoing.submission.submissionId,
        reason: "stale",
        current: hasPrevious ? { ...previous, revision: 2 } : null,
      },
    ]);

    store.moveTo("destination", "bob");
    expect(conflicts(store)).toEqual([]);
    const client = new SyncClient({
      store,
      transport: serviceTransport(service, "bob"),
      server: "destination",
      account: "bob",
      app: "test",
    });
    expect((await client.sync()).state).toBe("synced");
    const [shown] = conflicts(store);
    if (!shown) throw Error("expected a settings conflict in the popup");
    expect(shown.accountLabel).toBe(hasPrevious ? "Previous synced settings" : "Default settings");
    settleConflict(store, shown, choice);
    expect(conflicts(store)).toEqual([]);
    expect((await client.sync()).state).toBe("synced");
    const synced = await service.read("bob", "settings", "settings", "1.0");
    if (unit === null) expect(synced).toBeNull();
    else expect(synced).toMatchObject({ id: "settings", content: { weightUnit: unit } });
  },
);

it.each([
  ["phone", "lbs"],
  ["account", "kg"],
] as const)(
  "settles settings against a populated destination by choosing %s",
  async (choice, unit) => {
    const { store: other } = await phone("destination-settings");
    const transport = serviceTransport(service, "bob");
    const destination = new SyncClient({
      store: other,
      transport,
      server: "destination",
      account: "bob",
      app: "test",
    });
    saveSettings(other, { weightUnit: "kg" });
    expect((await destination.sync()).state).toBe("synced");

    const { store, sync } = await phone("settings-to-move");
    saveSettings(store, { weightUnit: "lbs" });
    await sync();
    store.moveTo("destination", "bob");
    const moved = new SyncClient({
      store,
      transport,
      server: "destination",
      account: "bob",
      app: "test",
    });
    expect((await moved.sync()).state).toBe("synced");
    const [shown] = conflicts(store);
    if (!shown) throw Error("expected a settings conflict in the popup");
    expect(shown).toMatchObject({
      title: "Settings",
      phone: { lines: [{ label: "Weight unit", value: "lbs" }] },
      account: { lines: [{ label: "Weight unit", value: "kg" }] },
    });
    expect(shown.accountLabel).toBeUndefined();
    settleConflict(store, shown, choice);
    expect((await moved.sync()).state).toBe("synced");
    expect(conflicts(store)).toEqual([]);
    expect(await service.read("bob", "settings", "settings", "1.0")).toMatchObject({
      content: { weightUnit: unit },
    });
  },
);
