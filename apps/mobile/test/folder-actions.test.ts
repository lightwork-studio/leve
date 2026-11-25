import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import {
  deleteFolder,
  finishFolderCreation,
  finishFolderRename,
} from "../src/data/folder-actions.ts";
import { trainData } from "../src/data/read.ts";

const SQL = await initSqlJs();

it("dismisses the naming dialog without starting a device change", () => {
  const change = vi.fn();
  finishFolderCreation(change, null);
  expect(change).not.toHaveBeenCalled();
});

it.each(["", "   ", "x".repeat(31)])("rejects an invalid name before writing", (name) => {
  const change = vi.fn();
  expect(() => finishFolderCreation(change, name)).toThrow(/folder name/);
  expect(change).not.toHaveBeenCalled();
});

it("shows the new empty folder on Train and keeps it queued after reopening", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/train.db", appVersion: "test" });
  const store = await open();
  store.put("routine_folder", "existing", { title: "Existing", position: 12 });
  const name = "x".repeat(30);
  finishFolderCreation((write) => write(store), ` ${name} `);
  const groups = trainData(store, 0).groups;
  expect(groups.map((group) => group.folder?.content.title)).toEqual(["Existing", name]);
  const folder = groups[1]?.folder;
  expect(folder?.id).toEqual(expect.any(String));
  expect(groups[1]?.routines).toEqual([]);
  store.close();

  const reopened = await open();
  expect(trainData(reopened, 0).groups).toEqual(groups);
  expect(reopened.prepareSubmissions("1.0").map((item) => item.submission)).toContainEqual(
    expect.objectContaining({
      op: "put",
      kind: "routine_folder",
      id: folder?.id,
      baseRevision: null,
      content: { title: name, position: 13 },
    }),
  );
  reopened.close();
});

it("keeps folders with the same name as separate records", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/duplicates.db",
    appVersion: "test",
  });
  finishFolderCreation((write) => write(store), "Home");
  finishFolderCreation((write) => write(store), "Home");
  const folders = store.list("routine_folder");
  expect(folders.map((folder) => folder.content)).toEqual([
    { title: "Home", position: 1 },
    { title: "Home", position: 2 },
  ]);
  expect(folders[0]?.id).not.toBe(folders[1]?.id);
  store.close();
});

it("appends after tied maximum positions and preserves folder order after reopening", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/crowded.db", appVersion: "test" });
  const store = await open();
  store.put("routine_folder", "untouched", { title: "First", position: 6 });
  store.put("routine_folder", "z", { title: "Middle", position: 1e15 - 1 });
  store.put("routine_folder", "-a", { title: "A", position: 1e15 });
  store.put("routine_folder", "-b", { title: "B", position: 1e15 });
  finishFolderCreation((write) => write(store), "Home");
  store.close();

  const reopened = await open();
  expect(trainData(reopened, 0).groups.map((group) => group.folder?.content.title)).toEqual([
    "First",
    "Middle",
    "A",
    "B",
    "Home",
  ]);
  expect(reopened.get("routine_folder", "untouched")?.content?.position).toBe(6);
  reopened.close();
});

it("rolls back an interrupted append and preserves a rejected folder through retry", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/interrupted.db", appVersion: "test" });
  let store = await open();
  const lastId = "y".repeat(64);
  store.put("routine_folder", lastId, { title: "My edit", position: 1e15 });
  const [queued] = store.prepareSubmissions("1.0");
  if (!queued) throw new Error("expected a queued folder");
  store.applyPushResults([
    {
      status: "invalid",
      submissionId: queued.submission.submissionId,
      code: "invalid_content",
      message: "rejected",
    },
  ]);
  const rejected = store.get("routine_folder", lastId);
  const exec = store.db.exec.bind(store.db);
  vi.spyOn(store.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && store.list("routine_folder").length === 2) {
      throw new Error("interrupted");
    }
    exec(sql);
  });
  expect(() => finishFolderCreation((write) => write(store), "Home")).toThrow(/interrupted/);
  store.close();

  store = await open();
  expect(store.list("routine_folder")).toEqual([rejected]);
  expect(store.prepareSubmissions("1.0")).toEqual([]);
  finishFolderCreation((write) => write(store), "Home");
  store.close();

  store = await open();
  const original = store.get("routine_folder", lastId);
  const added = store.list("routine_folder").find((folder) => folder.id !== lastId);
  expect(original).toEqual(rejected);
  expect(added?.content).toEqual({ title: "Home", position: 1e15 });
  expect(store.prepareSubmissions("1.0").map((item) => item.submission.id)).toEqual([added?.id]);
  store.close();
});

it("creates two UUID folders beside a saturated long ID and reopens in tie order", async () => {
  const engine = createSqlJsEngine(SQL);
  const open = () => openDeviceStore({ engine, path: "/prefix.db", appVersion: "test" });
  const store = await open();
  const longId = "z".repeat(32) + "a";
  store.put("routine_folder", longId, { title: "Last", position: 1e15 });
  for (const name of ["One", "Two"]) finishFolderCreation((write) => write(store), name);
  store.close();
  const reopened = await open();
  const folders = reopened.list("routine_folder");
  expect(folders.map((folder) => folder.id)).toEqual(folders.map((folder) => folder.id).sort());
  expect(folders.map((folder) => folder.content?.title).sort()).toEqual(["Last", "One", "Two"]);
  expect(folders.at(-1)?.id).toBe(longId);
  for (const folder of folders.slice(0, 2)) {
    expect(folder.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(folder.content?.position).toBe(1e15);
  }
  expect(reopened.get("routine_folder", longId)?.content).toEqual({
    title: "Last",
    position: 1e15,
  });
  reopened.close();
});

it("creates at the last position without editing the folder at the absolute ID ceiling", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/full.db",
    appVersion: "test",
  });
  const lastId = "z".repeat(64);
  store.put("routine_folder", lastId, { title: "Last", position: 1e15 });
  const original = store.get("routine_folder", lastId);
  finishFolderCreation((write) => write(store), "Home");
  expect(store.list("routine_folder").map((folder) => folder.content)).toEqual([
    { title: "Home", position: 1e15 },
    { title: "Last", position: 1e15 },
  ]);
  expect(store.get("routine_folder", lastId)).toEqual(original);
  store.close();
});

it("renames the selected folder, preserves its latest position and rejects stale or deleted targets", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/rename.db",
    appVersion: "test",
  });
  const folder = { id: "home", content: { title: "Home", position: 1 } };
  const rename = (title: string, expected = folder) =>
    finishFolderRename((write) => write(store), expected, title);
  store.put("routine_folder", folder.id, { ...folder.content, position: 8 });
  rename(" Gym ");
  expect(store.get("routine_folder", folder.id)?.content).toEqual({ title: "Gym", position: 8 });
  expect(() => rename("Stale")).toThrow(/changed/);
  expect(store.get("routine_folder", folder.id)?.content?.title).toBe("Gym");
  store.delete("routine_folder", folder.id);
  expect(() =>
    rename("Restore", { ...folder, content: { ...folder.content, title: "Gym" } }),
  ).toThrow(/changed/);
  expect(store.list("routine_folder")).toEqual([]);
  store.close();
});

it("keeps a rejected folder and its sync problem intact when rename is attempted", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/rejected",
    appVersion: "test",
  });
  const folder = { id: "home", content: { title: "Home", position: 1 } };
  store.put("routine_folder", folder.id, folder.content);
  const [queued] = store.prepareSubmissions("1.0");
  if (!queued) throw new Error("Expected the folder submission");
  store.applyPushResults([
    {
      status: "invalid",
      submissionId: queued.submission.submissionId,
      code: "invalid_content",
      message: "rejected",
    },
  ]);
  const rejected = store.get("routine_folder", folder.id);
  expect(() => finishFolderRename((write) => write(store), folder, "Gym")).toThrow(/sync issue/);
  expect(store.get("routine_folder", folder.id)).toEqual(rejected);
  expect(store.prepareSubmissions("1.0")).toEqual([]);
  store.close();
});

const plan = (title: string, folderId: string | null, position: number) => ({
  title,
  folderId,
  notes: "",
  position,
  exercises: [],
  effortScale: null,
});

it("deletes a synced folder and files its routines nowhere on every phone", {
  timeout: 60000,
}, async () => {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    a.store.put("routine_folder", "ppl", { title: "PPL", position: 1 });
    a.store.put("routine_folder", "mobility", { title: "Mobility", position: 2 });
    a.store.put("routine", "push", plan("Push", "ppl", 1));
    a.store.put("routine", "pull", plan("Pull", "ppl", 2));
    a.store.put("routine", "hips", plan("Hips", "mobility", 1));
    a.store.put("routine", "loose", plan("Full body", null, 3));
    await a.sync();
    await b.sync();

    deleteFolder(a.store, "ppl");
    // Deleting it again, as a second tap might, changes nothing.
    deleteFolder(a.store, "ppl");
    await a.sync();
    await b.sync();
    for (const phone of [a, b]) {
      const groups = trainData(phone.store, 0).groups;
      expect(
        groups.map((group) => [
          group.folder?.content.title ?? null,
          group.routines.map((r) => r.title),
        ]),
      ).toEqual([
        ["Mobility", ["Hips"]],
        [null, ["Push", "Pull", "Full body"]],
      ]);
      // The routines keep everything else, including their order.
      expect(phone.store.get("routine", "pull")?.content).toEqual(plan("Pull", null, 2));
      expect(phone.store.prepareSubmissions("1.0")).toEqual([]);
    }
    expect(await server.row("athlete", "routine_folder", "ppl")).toMatchObject({
      state: "deleted",
    });
  } finally {
    await world.dispose();
  }
});

it("refuses to delete a folder while one of its routines has a sync conflict", {
  timeout: 60000,
}, async () => {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    a.store.put("routine_folder", "ppl", { title: "PPL", position: 1 });
    a.store.put("routine", "push", plan("Push", "ppl", 1));
    await a.sync();
    await b.sync();
    b.store.put("routine", "push", plan("Push B", "ppl", 1));
    await b.sync();
    a.store.put("routine", "push", plan("Push A", "ppl", 1));
    await a.sync();
    expect(a.store.get("routine", "push")?.problem).not.toBeNull();

    expect(() => deleteFolder(a.store, "ppl")).toThrow(/sync issues/);
    expect(a.store.get("routine_folder", "ppl")?.deleted).toBe(false);
    expect(a.store.get("routine", "push")?.content?.folderId).toBe("ppl");
  } finally {
    await world.dispose();
  }
});

it("deletes a folder that never synced without sending it", async () => {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: "/local-delete.db",
    appVersion: "test",
  });
  store.put("routine_folder", "new", { title: "New", position: 1 });
  store.put("routine", "r", plan("Legs", "new", 4));
  deleteFolder(store, "new");
  expect(store.get("routine_folder", "new")).toBeNull();
  expect(store.prepareSubmissions("1.0").map((item) => item.submission)).toEqual([
    expect.objectContaining({
      op: "put",
      kind: "routine",
      id: "r",
      content: plan("Legs", null, 4),
    }),
  ]);
  store.close();
});
