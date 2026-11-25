import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import { deleteRoutine, organizeRoutine } from "../src/data/organize-routine.ts";
import { trainData } from "../src/data/read.ts";
import { seedSyntheticData } from "../src/data/seed.ts";
import { beginWorkout } from "../src/data/workout-actions.ts";

const SQL = await initSqlJs();
it("moves and renames the same routine while retaining its history and concurrent plan edit", {
  timeout: 60000,
}, async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/manage", appVersion: "test" });
  let store = await open();
  seedSyntheticData(store, new Date("2026-11-12T12:00:00Z"));
  const id = "seed-routine-push";
  const original = store.get("routine", id)?.content;
  if (!original) throw new Error("Missing seed routine");
  const history = store
    .list("workout")
    .filter((w) => w.content?.routineId === id)
    .map((w) => w.id);
  expect(history.length).toBeGreaterThan(0);
  const opened = { title: String(original.title), folderId: "seed-folder-ppl" };
  // Another editor drops the last exercise after this one opened.
  const edited = (original.exercises as unknown[]).slice(0, -1);
  expect(edited.length).toBeGreaterThan(0);
  store.put("routine", id, { ...original, exercises: edited });
  organizeRoutine(store, id, opened, { title: "  Push A ", folderId: "seed-folder-mobility" });
  store.close();
  store = await open();
  expect(store.get("routine", id)?.content).toMatchObject({
    title: "Push A",
    folderId: "seed-folder-mobility",
    exercises: edited,
  });
  expect(
    store
      .list("workout")
      .filter((w) => w.content?.routineId === id)
      .map((w) => w.id),
  ).toEqual(history);
  expect(() =>
    organizeRoutine(store, id, opened, { ...opened, title: "Conflicting name" }),
  ).toThrow(/changed/);
  expect(() =>
    organizeRoutine(
      store,
      id,
      { title: "Push A", folderId: "seed-folder-mobility" },
      { title: "Push A", folderId: "gone" },
    ),
  ).toThrow(/available folder/);
  expect(store.get("routine", id)?.content?.title).toBe("Push A");
  store.close();
});

it("retains the sync warning and rejected draft when a rename is attempted", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/rejected-routine", appVersion: "test" });
  let store = await open();
  const opened = { title: "Home", folderId: null };
  store.put("routine", "r", { ...opened, position: 1, exercises: [] });
  const [pending] = store.prepareSubmissions("1.0");
  if (!pending) throw new Error("Expected a pending routine");
  store.applyPushResults([
    {
      status: "invalid",
      submissionId: pending.submission.submissionId,
      code: "invalid_content",
      message: "Review this routine",
    },
  ]);
  const original = store.get("routine", "r");
  expect(original?.problem?.reason).toBeTruthy();
  expect(() => organizeRoutine(store, "r", opened, { ...opened, title: "Home A" })).toThrow(
    /sync issue/,
  );
  store.close();
  store = await open();
  expect(store.get("routine", "r")).toEqual(original);
  expect(store.prepareSubmissions("1.0")).toEqual([]);
  store.close();
});

it("deletes a synced routine on every phone and keeps the workouts started from it", {
  timeout: 60000,
}, async () => {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    const routine = {
      title: "Friday",
      folderId: null,
      exercises: [],
      position: 0,
      effortScale: null,
    };
    a.store.put("routine", "r", routine);
    a.store.put("routine", "other", { ...routine, title: "Monday", position: 1 });
    const workout = beginWorkout(a.store, "r");
    await a.sync();
    await b.sync();

    deleteRoutine(b.store, "r", routine);
    await b.sync();
    await a.sync();
    for (const phone of [a, b]) {
      expect(
        trainData(phone.store, 0).groups.flatMap((group) => group.routines.map((r) => r.title)),
      ).toEqual(["Monday"]);
      expect(phone.store.get("workout", workout)?.content?.routineId).toBe("r");
    }
    expect(await server.row("athlete", "routine", "r")).toMatchObject({ state: "deleted" });
    expect(() => deleteRoutine(a.store, "r", routine)).toThrow(/no longer available/);
  } finally {
    await world.dispose();
  }
});

it("refuses to delete a routine that changed since it was opened, or has a sync conflict", {
  timeout: 60000,
}, async () => {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    const opened = { title: "Friday", folderId: null, exercises: [], position: 0 };
    a.store.put("routine", "r", opened);
    await a.sync();
    await b.sync();
    // B renames it while A has it open; A downloads the rename before confirming the delete.
    b.store.put("routine", "r", { ...opened, title: "Friday heavy" });
    await b.sync();
    await a.sync();
    expect(() => deleteRoutine(a.store, "r", opened)).toThrow(/changed/);
    await a.sync();
    expect(await server.row("athlete", "routine", "r")).toMatchObject({ state: "live" });
    expect(a.store.get("routine", "r")?.content?.title).toBe("Friday heavy");

    // A conflicting edit is settled by review first, even against the version A opened.
    const theirs = { ...opened, title: "Friday heavy" };
    b.store.put("routine", "r", { ...theirs, position: 3 });
    await b.sync();
    a.store.put("routine", "r", { ...theirs, position: 4 });
    await a.sync();
    const conflicted = a.store.get("routine", "r");
    expect(conflicted?.problem).not.toBeNull();
    expect(() => deleteRoutine(a.store, "r", conflicted?.content ?? {})).toThrow(/sync issue/);
    expect(a.store.get("routine", "r")?.deleted).toBe(false);
  } finally {
    await world.dispose();
  }
});

it("puts a routine moved to no folder after the routines whose folder is gone", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/unfiled-order.db",
    appVersion: "test",
  });
  const routine = (title: string, folderId: string | null, position: number) => ({
    title,
    folderId,
    position,
    exercises: [],
    effortScale: null,
  });
  store.put("routine_folder", "kept", { title: "Kept", position: 1 });
  store.put("routine", "loose", routine("Loose", null, 2));
  // Its folder was deleted: Train shows it with the routines in no folder, after "Loose".
  store.put("routine", "orphan", routine("Orphan", "gone", 7));
  store.put("routine", "filed", routine("Filed", "kept", 30));
  organizeRoutine(
    store,
    "filed",
    { title: "Filed", folderId: "kept" },
    { title: "Filed", folderId: null },
  );
  expect(store.get("routine", "filed")?.content?.position).toBe(8);
  expect(trainData(store, 0).groups.map((group) => group.routines.map((r) => r.title))).toEqual([
    [],
    ["Loose", "Orphan", "Filed"],
  ]);
  store.close();
});
