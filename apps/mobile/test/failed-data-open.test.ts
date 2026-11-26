import { createSqlJsEngine } from "@leve/storage/sqljs";
import { useState } from "react";
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

it("loads no synthetic data when deleting what is on the device fails", async () => {
  build.sampleData = false;
  const files = new Map<string, Uint8Array>();
  const engine = createSqlJsEngine(await initSqlJs(), { files });
  vi.mocked(openEngine).mockImplementation(async () => ({
    engine,
    paths: () => [...files.keys()],
    flush: async () => {},
    onSaveProblem: () => {},
    exportRecovery: async () => {},
  }));
  const failed = vi.fn(() => null);
  const capture = vi.fn<(data: AppData) => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seeding = vi.spyOn(seed, "seedSyntheticData");
  let screen: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, { loading: null, failed, children: jsx(Ready, { capture }) }),
      );
    });
    const data = capture.mock.lastCall?.[0];
    if (!data) throw Error("The device data did not open");
    data.store.put("body_measurement", "logged", {
      takenAt: "2026-11-20T08:00:00.000Z",
      bodyweightKg: 81,
      fatPercent: null,
    });
    const remove = vi.spyOn(engine, "remove").mockImplementation(() => {
      throw Error("The file is in use");
    });
    await act(async () => {
      expect(await data.reset(true)).toBe(false);
    });
    expect(failed).toHaveBeenCalledWith("The file is in use", expect.any(Function));
    expect(seeding).not.toHaveBeenCalled();
    remove.mockRestore();
    // What was logged is still there to open or export.
    const kept = createSqlJsEngine(await initSqlJs(), { files }).open(
      "/leve-preview-protocol-1/device.db",
      { readOnly: true },
    );
    try {
      expect(kept.get("SELECT COUNT(*) AS n FROM records WHERE id = 'logged'")).toEqual({ n: 1 });
    } finally {
      kept.close();
    }
  } finally {
    await act(() => screen?.unmount());
    seeding.mockRestore();
    build.sampleData = true;
    vi.unstubAllGlobals();
  }
});

/** Reads the store as it renders, as Settings does, and repaints when pressed. */
function ReadingScreen({ capture }: { capture(data: AppData, press: () => void): void }) {
  const data = useAppData();
  const [, setPresses] = useState(0);
  data.store.get("body_measurement", "logged");
  capture(data, () => setPresses((n) => n + 1));
  return null;
}

it.each([
  ["deleting everything", false],
  ["starting again with sample data", true],
])("renders no screen from the closed store while %s", async (_name, sampleData) => {
  build.sampleData = false;
  const files = new Map<string, Uint8Array>();
  // The next flush waits for this, standing in for a reset still deleting when the app repaints.
  let holding: Promise<void> | null = null;
  vi.mocked(openEngine).mockImplementation(async () => ({
    engine: createSqlJsEngine(await initSqlJs(), { files }),
    paths: () => [...files.keys()],
    flush: () => {
      const held = holding;
      holding = null;
      return held ?? Promise.resolve();
    },
    onSaveProblem: () => {},
    exportRecovery: async () => {},
  }));
  const capture = vi.fn<(data: AppData, press: () => void) => void>();
  const shown = () => {
    const [data, press] = capture.mock.lastCall ?? [];
    if (!data || !press) throw Error("No screen is showing the device data");
    return { data, press };
  };
  const failed = vi.fn(() => null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, { loading: null, failed, children: jsx(ReadingScreen, { capture }) }),
      );
    });
    const { data, press } = shown();
    data.store.put("body_measurement", "logged", {
      takenAt: "2026-11-20T08:00:00.000Z",
      bodyweightKg: 81,
      fatPercent: null,
    });

    let release = () => {};
    holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resetting: Promise<boolean> | undefined;
    // The confirming press: the sheet shows it is busy while the reset runs.
    act(() => {
      resetting = data.reset(sampleData);
      press();
    });
    release();
    await act(async () => {
      expect(await resetting).toBe(true);
    });

    const fresh = shown().data;
    expect(fresh.store).not.toBe(data.store);
    expect(fresh.store.get("body_measurement", "logged")).toBeNull();
    expect(fresh.store.get("routine", "seed-routine-push") !== null).toBe(sampleData);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    await act(() => screen?.unmount());
    build.sampleData = true;
    vi.unstubAllGlobals();
  }
});

it("seeds no made-up data in a build that could pair the person's own server", async () => {
  // An iOS build that offers pairing: once paired, the made-up data would go up to the account.
  const os = process.env.EXPO_OS;
  process.env.EXPO_OS = "ios";
  const files = new Map<string, Uint8Array>();
  vi.mocked(openEngine).mockImplementation(async () => ({
    engine: createSqlJsEngine(await initSqlJs(), { files }),
    paths: () => [...files.keys()],
    flush: async () => {},
    onSaveProblem: () => {},
    exportRecovery: async () => {},
  }));
  const capture = vi.fn<(data: AppData) => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, {
          loading: null,
          failed: () => null,
          children: jsx(Ready, { capture }),
        }),
      );
    });
    const data = capture.mock.lastCall?.[0];
    expect(data?.store.get("routine", "seed-routine-push")).toBeNull();
    expect(data?.store.db.get("SELECT count(*) AS n FROM records")?.n).toBe(0);
  } finally {
    await act(() => screen?.unmount());
    if (os === undefined) delete process.env.EXPO_OS;
    else process.env.EXPO_OS = os;
    vi.unstubAllGlobals();
  }
});
