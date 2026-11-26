// @vitest-environment happy-dom
/// <reference lib="dom" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@leve/contract";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { ServerStorage } from "@leve/storage/server";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { SyncClient } from "@leve/sync";
import { SyncService, serviceTransport } from "@leve/sync/server";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { beginWorkout } from "../src/data/workout-actions.ts";
import { noteWorkoutHere } from "../src/data/workout-here.ts";
import { SyncHost } from "../src/sync/sync-host.tsx";
import { clerk } from "./support/clerk-expo.ts";
import { files } from "./support/expo-file-system.ts";

/*
 * The conflict popup on a real phone store, made by two phones syncing one account through a real
 * sync service. Regression: a workout started on the other phone syncs here and runs here too, and
 * every question (the conflict popup included) used to wait for it to end, with nothing said.
 */

vi.mock("../src/data/ids.ts", () => {
  let id = 0;
  return { newId: () => `id-${++id}` };
});
// Syncing is driven by the test; the host's own session does nothing.
vi.mock("../src/sync/sync-session.ts", () => ({
  unsyncedChanges: () => 0,
  SyncSession: class {
    start() {}
    stop() {}
    setForeground() {}
    nudge() {}
  },
}));
const route = vi.hoisted(() => ({ path: "/" }));
vi.mock("expo-router", () => ({
  router: { push: () => {} },
  usePathname: () => route.path,
}));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => true,
  syncServerUrl: "https://sync.test",
}));
const shown = vi.hoisted(() => ({ store: null as unknown, version: 1 }));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store: shown.store,
    version: shown.version,
    change: (fn: (store: unknown) => unknown) => fn(shown.store),
    reset: async () => true,
    exportData: async () => {},
  }),
}));
vi.mock("react-native", async () => {
  const web = await vi.importActual<Record<string, unknown>>("react-native-web");
  return {
    ...web,
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  };
});
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    createAnimatedComponent: (component: unknown) => component,
    View: ({ children }: { children?: ReactNode }) => children ?? null,
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
  withSpring: (value: number) => value,
  useReducedMotion: () => false,
  interpolateColor: () => "#000",
}));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Circle: "circle",
  Line: "line",
  Polyline: "polyline",
  Rect: "rect",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../src/ui/motion.ts", () => ({
  emphasised: undefined,
  pressScale: 1,
  spring: {},
  fade: undefined,
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children, ...props }: { children?: ReactNode; role?: string }) =>
    h("div", { role: props.role }, children),
}));

const SQL = await initSqlJs();
let directory: string;
let storage: ServerStorage;
let service: SyncService;
let ids = 0;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  directory = mkdtempSync(join(tmpdir(), "leve-sync-host-"));
  storage = new ServerStorage({ engine: createNodeSqliteEngine(), directory, appVersion: "test" });
  service = new SyncService({ storage });
  files.clear();
  forgetDevicePreferences();
  clerk.reset();
  clerk.signedIn = true;
  route.path = "/";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  await storage.close();
  rmSync(directory, { recursive: true, force: true });
});

async function phone(name: string) {
  const store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/${name}.db`,
    appVersion: "test",
    randomId: () => `${name}-${++ids}`,
  });
  const client = new SyncClient({
    store,
    transport: (path, body) => serviceTransport(service, "user_1")(path, body),
    server: "https://sync.test",
    account: "user_1",
    app: name,
  });
  const sync = async () => expect((await client.sync()).state).toBe("synced");
  return { store, sync };
}

/** A routine as the editor saves it: loads per set, the way the maintainer's test changed them. */
const routine = (loads: number[]): JsonObject => ({
  title: "Test Routine A",
  folderId: null,
  position: 1,
  effortScale: "rpe",
  exercises: [
    {
      id: "x1",
      exerciseId: "bench-press-barbell",
      exerciseName: "Bench Press",
      exerciseType: "weight_reps",
      supersetId: null,
      restSeconds: 90,
      useRepRange: false,
      sets: loads.map((weightKg, index) => ({
        id: `x1-s${index + 1}`,
        type: "normal",
        weightKg,
        reps: 8,
        repRangeMin: null,
        repRangeMax: null,
        durationSeconds: null,
        distanceMeters: null,
        count: null,
        rpe: null,
      })),
    },
  ],
});

async function show(store: DeviceStore) {
  shown.store = store;
  shown.version += 1;
  await act(async () => root.render(h(SyncHost)));
}
const screen = () => document.body.textContent ?? "";

it("asks about a routine changed on both phones while a workout started on the other one runs", async () => {
  const a = await phone("a");
  const b = await phone("b");
  a.store.put("routine", "r1", routine([30, 35, 40]));
  await a.sync();
  await b.sync();
  // Open on this phone, with no workout running.
  await show(b.store);
  expect(screen()).toBe("");

  // The other phone starts a workout from the routine; it syncs here and runs here too.
  const running = beginWorkout(a.store, "r1");
  await a.sync();
  await b.sync();
  expect(b.store.activeWorkout()?.id).toBe(running);

  // Both phones change the routine before they sync.
  a.store.put("routine", "r1", routine([30, 35, 40].map((load) => load + 5)));
  b.store.put("routine", "r1", routine([55, 55, 55]));
  await a.sync();
  await b.sync();
  expect(b.store.get("routine", "r1")?.status).toBe("conflict");

  await show(b.store);
  expect(screen()).toContain("Changed in two places");
  expect(screen()).toContain("Test Routine A");
  expect(screen()).not.toContain("once this workout ends");
});

it("holds the popup back while that workout is logged on this phone, says so, and asks once it ends", async () => {
  const a = await phone("a");
  const b = await phone("b");
  a.store.put("routine", "r1", routine([30, 35, 40]));
  await a.sync();
  await b.sync();
  const running = beginWorkout(a.store, "r1");
  await a.sync();
  await b.sync();
  a.store.put("routine", "r1", routine([35, 40, 45]));
  b.store.put("routine", "r1", routine([55, 55, 55]));
  await a.sync();
  await b.sync();

  // Logged on this phone too (any write to the workout in progress goes through the app's change).
  noteWorkoutHere(b.store);
  await show(b.store);
  expect(screen()).not.toContain("Changed in two places");
  expect(screen()).toContain("Sync has a question for you. It comes up once this workout ends.");

  // Finished (on the other phone): the popup comes up as soon as this phone hears of it.
  const workout = a.store.get("workout", running)!;
  a.store.put("workout", running, { ...workout.content!, endedAt: new Date().toISOString() });
  await a.sync();
  await b.sync();
  expect(b.store.activeWorkout()).toBeNull();
  await show(b.store);
  expect(screen()).toContain("Changed in two places");
});

it("takes a workout already running when this version first opens as this phone's, and says a question waits", async () => {
  const a = await phone("a");
  const b = await phone("b");
  a.store.put("routine", "r1", routine([30, 35, 40]));
  await a.sync();
  await b.sync();
  beginWorkout(a.store, "r1");
  await a.sync();
  await b.sync();
  a.store.put("routine", "r1", routine([35, 40, 45]));
  b.store.put("routine", "r1", routine([55, 55, 55]));
  await a.sync();
  await b.sync();
  // Nothing noted yet (this version just arrived): it may be logged here, so it isn't covered.
  await show(b.store);
  expect(screen()).not.toContain("Changed in two places");
  expect(screen()).toContain("It comes up once this workout ends.");
});
