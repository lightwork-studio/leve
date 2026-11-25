import { createSqlJsEngine } from "@leve/storage/sqljs";
import { jsx } from "react/jsx-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { type AppData, AppDataProvider, useAppData } from "../src/data/app-data.tsx";
import {
  claimBrowserData,
  loadBrowserFiles,
  readRecoveryFiles,
} from "../src/data/browser-files.ts";
import { exportStoredRecovery, openEngine } from "../src/data/engine";
import * as seed from "../src/data/seed.ts";

vi.mock("../src/data/engine", () => ({ openEngine: vi.fn(), exportStoredRecovery: vi.fn() }));
vi.mock("../src/data/ids.ts", () => ({ newId: () => "test-id" }));
// Mutable, so a test can stand in for a build that starts empty.
const build = vi.hoisted(() => ({ webDemo: false, commit: "local", sampleData: true }));
vi.mock("../src/build-info.ts", () => ({ buildInfo: build }));

function result<T>(value: T) {
  const req = { result: value, onsuccess: () => {} };
  queueMicrotask(() => req.onsuccess());
  return req;
}

function Ready({ capture }: { capture(data: AppData): void }) {
  capture(useAppData());
  return null;
}

it.each(["newer", "unrecognized"])(
  "offers a recovery copy without deleting %s device data",
  async (state) => {
    const files = new Map<string, Uint8Array>();
    const engine = createSqlJsEngine(await initSqlJs(), { files });
    const path = "/leve-preview-protocol-1/device.db";
    const db = engine.open(path);
    db.exec("CREATE TABLE unsent_notes (text TEXT)");
    db.run("INSERT INTO unsent_notes VALUES (?)", ["locally recorded"]);
    if (state === "newer") {
      db.exec(
        "CREATE TABLE storage_meta (id INTEGER PRIMARY KEY, storage_version INTEGER, app_version TEXT, unsynced_work INTEGER)",
      );
      db.run("INSERT INTO storage_meta VALUES (1, 500, 'newer-app', 1)");
    }
    db.close();
    const before = new Uint8Array(files.get(path) ?? []);
    expect(before.length).toBeGreaterThan(0);
    const exportRecovery = vi.fn(async () => {});
    vi.mocked(openEngine).mockResolvedValue({
      engine,
      paths: () => [...files.keys()],
      flush: async () => {},
      onSaveProblem: () => {},
      exportRecovery,
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let screen: ReactTestRenderer | undefined;
    try {
      const failed = vi.fn((_message: string, _action: (() => Promise<void>) | null) => null);
      await act(async () => {
        screen = create(jsx(AppDataProvider, { loading: null, failed }));
      });
      const [message, action] = failed.mock.lastCall ?? [];
      expect(message).toMatch(state === "newer" ? /version 500/ : /not a Leve database/);
      if (!action) throw new Error("Expected an export action");
      await act(() => action());
      expect(exportRecovery).toHaveBeenCalledOnce();
      expect(files.get(path)).toEqual(before);
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("exports committed files from a read-only transaction when the browser lacks Web Locks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", {});
  const transaction = vi.fn((name: string, mode: string) => {
    if (name !== "files" || mode !== "readonly") throw Error("Unexpected write transaction");
    return {
      objectStore: () => ({
        getAllKeys: () => result(["/leve/device.db", "/leve/device.db-journal"]),
        getAll: () => result([Uint8Array.of(42), Uint8Array.of(19, 0)]),
      }),
    };
  });
  const close = vi.fn();
  const open = vi.fn(() => result({ transaction, close }));
  vi.stubGlobal("indexedDB", { open });
  vi.mocked(openEngine).mockImplementation(async () => {
    await claimBrowserData();
    throw Error("unexpected writer");
  });
  let copied: number[][] = [];
  vi.mocked(exportStoredRecovery).mockImplementation(async () => {
    const files = await readRecoveryFiles();
    copied = files.paths().map((path) => Array.from(files.get(path) ?? []));
  });
  const failed = vi.fn((_message: string, _action: (() => Promise<void>) | null) => null);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      screen = create(jsx(AppDataProvider, { loading: null, failed }));
    });
    const [message, saveCopy] = failed.mock.lastCall ?? [];
    expect(message).toMatch(/Web Locks/);
    if (!saveCopy) throw Error("Missing read-only recovery");
    await saveCopy();
    expect(copied).toEqual([[42], [19, 0]]);
    expect(open).toHaveBeenCalledExactlyOnceWith("leve-preview-protocol-1");
    expect(transaction.mock.calls).toEqual([["files", "readonly"]]);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("opens and resets a fresh web preview without changing the previous IndexedDB database", async () => {
  const sql = await initSqlJs();
  const reading = { takenAt: "2026-01-01T12:00:00.000Z", bodyweightKg: 80, fatPercent: null };
  const seedPreview = vi.spyOn(seed, "seedSyntheticData").mockImplementation((store) => {
    store.put("body_measurement", "sample", reading);
  });
  const oldPath = "/leve/device.db";
  const previous = new Map([[oldPath, Uint8Array.of(1, 2, 3)]]);
  const current = new Map<string, Uint8Array>();
  const databases = new Map([
    ["leve-preview", previous],
    ["leve-preview-protocol-1", current],
  ]);
  const open = vi.fn((name: string) => {
    const files = databases.get(name);
    if (!files) throw Error(`Unexpected database ${name}`);
    return result({
      transaction: () => {
        const tx = {
          oncomplete: () => {},
          objectStore: () => ({
            getAllKeys: () => result([...files.keys()]),
            getAll: () => result([...files.values()]),
            put: (bytes: Uint8Array, path: string) => files.set(path, bytes),
            delete: (path: string) => files.delete(path),
          }),
        };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      },
    });
  });
  vi.stubGlobal("indexedDB", { open });
  vi.mocked(openEngine).mockImplementation(async () => {
    const files = await loadBrowserFiles();
    const engine = createSqlJsEngine(sql, { files, onChange: files.saveSoon });
    return {
      engine,
      paths: files.paths,
      flush: files.flush,
      onSaveProblem: files.onSaveProblem,
      exportRecovery: async () => {},
    };
  });
  const failed = vi.fn(() => null);
  const capture = vi.fn<(data: AppData) => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, { loading: null, failed, children: jsx(Ready, { capture }) }),
      );
    });
    const data = capture.mock.lastCall?.[0];
    if (!data) throw Error("Preview did not open");
    data.store.put("body_measurement", "entered-after-open", reading);
    await act(async () => {
      expect(await data.reset()).toBe(true);
    });
    const resetStore = capture.mock.lastCall?.[0].store;
    expect(resetStore?.get("body_measurement", "sample")?.content?.bodyweightKg).toBe(80);
    expect(resetStore?.get("body_measurement", "entered-after-open")).toBeNull();
    expect(failed).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledExactlyOnceWith("leve-preview-protocol-1", 1);
    expect(current.get("/leve-preview-protocol-1/device.db")?.byteLength).toBeGreaterThan(0);
    expect([...previous]).toEqual([[oldPath, Uint8Array.of(1, 2, 3)]]);
  } finally {
    await act(() => screen?.unmount());
    seedPreview.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("starts a build that starts empty again with the synthetic data only when asked", async () => {
  build.sampleData = false;
  const files = new Map<string, Uint8Array>();
  vi.mocked(openEngine).mockImplementation(async () => ({
    engine: createSqlJsEngine(await initSqlJs(), { files }),
    paths: () => [...files.keys()],
    flush: async () => {},
    onSaveProblem: () => {},
    exportRecovery: async () => {},
  }));
  const failed = vi.fn(() => null);
  const capture = vi.fn<(data: AppData) => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  const opened = () => {
    const data = capture.mock.lastCall?.[0];
    if (!data) throw Error("The device data did not open");
    return data;
  };
  const sampleRoutine = () => opened().store.get("routine", "seed-routine-push");
  const logged = { takenAt: "2026-11-20T08:00:00.000Z", bodyweightKg: 81, fatPercent: null };
  try {
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, { loading: null, failed, children: jsx(Ready, { capture }) }),
      );
    });
    expect(sampleRoutine()).toBeNull();
    opened().store.put("body_measurement", "logged", logged);

    await act(async () => {
      expect(await opened().reset()).toBe(true);
    });
    expect(opened().store.get("body_measurement", "logged")).toBeNull();
    expect(sampleRoutine()).toBeNull();

    opened().store.put("body_measurement", "logged", logged);
    await act(async () => {
      expect(await opened().reset(true)).toBe(true);
    });
    // What was there is deleted first: the synthetic data is never mixed into it.
    expect(opened().store.get("body_measurement", "logged")).toBeNull();
    expect(sampleRoutine()?.content).toMatchObject({ title: "Push day" });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    await act(() => screen?.unmount());
    build.sampleData = true;
    vi.unstubAllGlobals();
  }
});
