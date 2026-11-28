import { createSqlJsEngine } from "@leve/storage/sqljs";
import { jsx } from "react/jsx-runtime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import {
  type AppData,
  AppDataProvider,
  beforeWorkoutScene,
  useAppData,
} from "../src/data/app-data.tsx";
import { openEngine } from "../src/data/engine";

vi.mock("../src/data/engine", () => ({ openEngine: vi.fn() }));
vi.mock("../src/build-info.ts", () => ({
  buildInfo: { commit: "local", sampleData: false, wellKnownSyncUrls: [] },
}));

function Ready({ capture }: { capture(data: AppData): void }) {
  capture(useAppData());
  return null;
}

it("hands the cold intent's store to a scene that opens during the write", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  let started: (store: AppData["store"]) => void = () => {};
  let release: () => void = () => {};
  const writing = new Promise<AppData["store"]>((resolve) => {
    started = resolve;
  });
  const canSave = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = vi.fn<(data: AppData) => void>();
  const failed = vi.fn(() => null);
  vi.mocked(openEngine).mockResolvedValue({
    engine: createSqlJsEngine(await initSqlJs()),
    paths: () => [],
    flush: async () => {},
    onSaveProblem: () => {},
    exportRecovery: async () => {},
  });
  const write = beforeWorkoutScene(async (store) => {
    started(store);
    await canSave;
    store.put("body_measurement", "reading", {
      takenAt: "2026-11-28T08:00:00.000Z",
      bodyweightKg: 82,
      fatPercent: null,
    });
  });
  try {
    const background = await writing;
    await act(async () => {
      screen = create(
        jsx(AppDataProvider, { loading: null, failed, children: jsx(Ready, { capture }) }),
      );
    });
    expect(capture).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await write;
    });
    const foreground = capture.mock.lastCall?.[0].store;
    expect(foreground).toBe(background);
    expect(foreground?.get("body_measurement", "reading")?.content?.bodyweightKg).toBe(82);
    expect(openEngine).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    const late = vi.fn(async () => {});
    await beforeWorkoutScene(late);
    expect(late).not.toHaveBeenCalled();
  } finally {
    release();
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});
