import { type DeviceStore, openDeviceStore } from "@leve/storage";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildInfo } from "../build-info.ts";
import { syncConfigured } from "../sync/sync-server.ts";
import { exportStoredRecovery, type OpenedEngine, openEngine } from "./engine";
import { newId } from "./ids.ts";
import { PREVIEW_STORAGE } from "./preview-storage.ts";
import { applyAppChange } from "./read.ts";
import { seedSyntheticData, wantsSampleData } from "./seed.ts";

const DATABASE_PATH = `/${PREVIEW_STORAGE}/device.db`;

export interface AppData {
  store: DeviceStore;
  /** Changes whenever the data changes, so screens that read the store render again. */
  version: number;
  historyVersion: number;
  /** Runs a change against the store and tells every screen. */
  change<T>(fn: (store: DeviceStore) => T, scope?: "active-workout"): T;
  /**
   * Deletes everything on this device and starts again: empty, or from the synthetic data in builds
   * that have it (see `buildInfo.sampleData`) or when `sampleData` asks for it. Resolves to whether
   * fresh data opened; when it didn't, the app shows why in place of its screens.
   */
  reset(sampleData?: boolean): Promise<boolean>;
  /** Why changes can't be saved right now, if they can't. */
  saveProblem: string | null;
  /** Copies this device's database files to a place the person picks, before data is replaced. */
  exportData(): Promise<void>;
}

type State =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; store: DeviceStore; version: number; historyVersion: number };

const Context = createContext<AppData | null>(null);

async function openStore(opened: OpenedEngine, sampleData: boolean): Promise<DeviceStore> {
  const store = await openDeviceStore({
    engine: opened.engine,
    path: DATABASE_PATH,
    appVersion: `leve-preview ${buildInfo.commit}`,
    randomId: newId,
  });
  // A development preview's first start gets synthetic data, and a reset brings it back.
  // TestFlight builds start empty, unless a reset asked for the synthetic data. Builds that sync
  // never get it: it would go up to the signed-in account.
  if (!syncConfigured() && wantsSampleData(store, sampleData)) seedSyntheticData(store);
  await opened.flush();
  return store;
}

export function AppDataProvider({
  children,
  loading,
  failed,
}: {
  children: ReactNode;
  loading: ReactNode;
  failed: (message: string, exportRecovery: (() => Promise<void>) | null) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const engine = useRef<OpenedEngine | null>(null);
  // The open store, so no closure handed out earlier can reach one that was closed.
  const current = useRef<DeviceStore | null>(null);

  /** Opens the store. False if it couldn't, and the reason is shown in place of the app. */
  const start = useCallback(async (sampleData = buildInfo.sampleData): Promise<boolean> => {
    try {
      if (!engine.current) {
        engine.current = await openEngine();
        engine.current.onSaveProblem(setSaveProblem);
      }
      const store = await openStore(engine.current, sampleData);
      current.current = store;
      setState((previous) => ({
        status: "ready",
        store,
        historyVersion: 0,
        version: previous.status === "ready" ? previous.version + 1 : 0,
      }));
      return true;
    } catch (error) {
      current.current = null;
      setState({ status: "failed", message: (error as Error).message });
      return false;
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  const change = useCallback(<T,>(fn: (store: DeviceStore) => T, scope?: "active-workout"): T => {
    const store = current.current;
    if (!store) throw new Error("The data isn't open");
    const { result, historyVersion } = applyAppChange(store, fn, scope);
    setState((previous) =>
      previous.status === "ready"
        ? {
            ...previous,
            version: previous.version + 1,
            historyVersion,
          }
        : previous,
    );
    return result;
  }, []);

  /**
   * Deletes every database file, then opens a fresh store, with the synthetic data if `sampleData`.
   * False if that didn't work.
   */
  const startOver = useCallback(
    async (sampleData = buildInfo.sampleData): Promise<boolean> => {
      const opened = engine.current;
      if (!opened) return false;
      // Screens read the store as they render, and one can render before the fresh store opens
      // (the press that asked for this repaints at once). Take them off the store before closing
      // it, so none reads a closed one.
      setState({ status: "loading" });
      try {
        current.current?.close();
        current.current = null;
        for (const path of opened.paths()) opened.engine.remove(path);
        await opened.flush();
      } catch (error) {
        // The old store is closed, so screens can't go on with it: say why instead.
        current.current = null;
        setState({ status: "failed", message: (error as Error).message });
        return false;
      }
      return start(sampleData);
    },
    [start],
  );

  const value = useMemo<AppData | null>(
    () =>
      state.status === "ready"
        ? {
            store: state.store,
            version: state.version,
            historyVersion: state.historyVersion,
            change,
            reset: startOver,
            saveProblem,
            exportData: () => (engine.current?.exportRecovery ?? exportStoredRecovery)(),
          }
        : null,
    [state, change, startOver, saveProblem],
  );

  if (state.status === "loading") return loading;
  if (state.status === "failed")
    return failed(
      state.message,
      buildInfo.webDemo ? null : (engine.current?.exportRecovery ?? exportStoredRecovery),
    );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppData(): AppData {
  const data = useContext(Context);
  if (!data) throw new Error("useAppData needs the AppDataProvider");
  return data;
}
