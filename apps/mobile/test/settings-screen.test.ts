// @vitest-environment happy-dom
/// <reference lib="dom" />
import type { JsonObject } from "@leve/contract";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { act, createElement as h, type ReactNode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import SettingsScreen from "../app/settings.tsx";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { readSettings } from "../src/data/read.ts";
import { SettingsError, saveSettings, settingsContent } from "../src/data/settings-actions.ts";
import { readTrackRir, saveTrackRir } from "../src/data/track-rir.ts";
import { palettes } from "../src/theme.ts";
import { File, files } from "./support/expo-file-system.ts";
import { feedbackScheduler } from "./support/feedback.ts";

let store: DeviceStore;
let version = 0;
let holdAppVersion = false;
const reset = vi.fn(async () => true);
const feedback = feedbackScheduler();
vi.mock("../src/ui/after-feedback.ts", () => ({
  afterFeedback: (run: () => void) => feedback.afterFeedback(run),
}));

vi.mock("react-native", () => vi.importActual("react-native-web"));
// Mutable, so tests can stand in for local and deployed bundles.
const build = vi.hoisted(() => ({
  commit: "abc1234",
  label: "test",
  releaseNumber: undefined as string | undefined,
  sampleData: true,
  sampleDataOnRequest: false,
}));
vi.mock("../src/build-info.ts", () => ({ buildInfo: build }));
const sync = vi.hoisted(() => ({ on: false }));
vi.mock("../src/sync/sync-config.ts", () => ({
  syncEnabled: () => sync.on,
  syncServerUrl: "",
  builtInServerConfigured: () => false,
  ownServerAvailable: () => false,
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-router", () => ({
  router: { canGoBack: () => true, back: vi.fn() },
  useLocalSearchParams: () => ({}),
}));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store,
    version,
    reset,
    change: (write: (value: DeviceStore) => unknown) => {
      const result = write(store);
      if (!holdAppVersion) version++;
      return result;
    },
  }),
}));
vi.mock("../src/data/queries.ts", () => ({
  // biome-ignore lint/correctness/useExhaustiveDependencies: version marks stored data changes.
  useSettings: () => useMemo(() => readSettings(store), [store, version]),
}));
vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: passthrough,
      Text: ({ children }: { children?: ReactNode }) => h("span", null, children),
    },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
    withSpring: (value: number) => value,
    withSequence: (...steps: number[]) => steps.at(-1),
    useReducedMotion: () => false,
    interpolateColor: () => "#000",
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Circle: "circle",
  Line: "line",
  Polyline: "polyline",
  Rect: "rect",
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
  StillOnOpen: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));

const SQL = await initSqlJs();
let host: HTMLDivElement;
let root: Root;
let n = 0;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  files.clear();
  forgetDevicePreferences();
  store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/settings-screen-${n++}.db`,
    appVersion: "test",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  reset.mockClear();
});
afterEach(async () => {
  await act(feedback.release);
  holdAppVersion = false;
  build.releaseNumber = undefined;
  build.sampleData = true;
  build.sampleDataOnRequest = false;
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  store.close();
});

const render = () => act(() => root.render(h(SettingsScreen)));
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

it("shows which release is running while the app version stays the same across updates", async () => {
  await render();
  expect(byLabel("Leve, version 0.1.0, build test, abc1234")).not.toBeNull();
  expect(host.textContent).not.toContain(" · release ");

  build.releaseNumber = "26";
  await render();
  expect(byLabel("Leve, version 0.1.0, release 26, build test, abc1234")?.textContent).toContain(
    "version 0.1.0 · release 26",
  );

  build.releaseNumber = "27";
  await render();
  expect(byLabel("Leve, version 0.1.0, release 27, build test, abc1234")?.textContent).toContain(
    "version 0.1.0 · release 27",
  );
});

async function press(label: string) {
  const target = byLabel(label);
  if (!target) throw Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    // Menus find their row's place on screen before they open.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await render();
}

it("switches a unit by tapping its sample reading", async () => {
  await render();
  expect(host.textContent).toContain("82.4");
  await press("Weight in kg");
  expect(readSettings(store).weightUnit).toBe("lbs");
  expect(host.textContent).toContain("181.7");
  await press("Distance in km");
  expect(readSettings(store).distanceUnit).toBe("miles");
  // The other units are left as they were.
  expect(readSettings(store)).toMatchObject({ shortDistanceUnit: "m", measurementUnit: "cm" });
});

const restChoices = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="radio"]')]
    .map((option) => option.getAttribute("aria-label") ?? "")
    .filter((label) => /^(\d|Off)/.test(label));
const chooseRest = async (label: string) => {
  const option = [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="radio"]')].find(
    (radio) => radio.getAttribute("aria-label") === label,
  );
  if (!option) throw Error(`Missing ${label}`);
  await act(async () => option.click());
};

it("steps the default rest through the offered times and sets one in the rest dialog", async () => {
  await render();
  expect(readSettings(store).defaultRestSeconds).toBe(0);
  expect(host.textContent).not.toContain("Preview");
  await press("More default rest");
  await press("More default rest");
  expect(readSettings(store).defaultRestSeconds).toBe(45);
  expect(host.textContent).toContain("Preview · 0:45");
  await press("Less default rest");
  expect(readSettings(store).defaultRestSeconds).toBe(30);
  await press("Default rest, 0:30");
  // Off is one of the lengths, after the longest, not a switch of its own.
  expect(restChoices()).toEqual([
    "0:30",
    "0:45",
    "1:00",
    "1:30",
    "2:00",
    "2:30",
    "3:00",
    "4:00",
    "5:00",
    "Off",
  ]);
  // Leaving with ✕ keeps the rest as it was.
  await chooseRest("2:00");
  await press("Cancel");
  expect(byLabel("Rest time")).toBeNull();
  expect(readSettings(store).defaultRestSeconds).toBe(30);

  await press("Default rest, 0:30");
  await press("15 seconds more");
  await press("Set rest to 0:45");
  expect(readSettings(store).defaultRestSeconds).toBe(45);
  expect(byLabel("Rest time")).toBeNull();

  await press("Default rest, 0:45");
  await chooseRest("Off");
  await press("Set rest to Off");
  expect(readSettings(store).defaultRestSeconds).toBe(0);
  // Off can't go lower, and has no timer to preview.
  expect(byLabel("Less default rest")?.getAttribute("aria-disabled")).toBe("true");
  expect(host.textContent).not.toContain("Preview");
});

it("shows two rapid rest steps before the save and commits them together", async () => {
  await render();
  const more = byLabel("More default rest");
  if (!more) throw Error("Missing rest stepper");
  feedback.hold();
  await act(() => {
    more.click();
    more.click();
  });
  expect(host.textContent).toContain("Preview · 0:45");
  expect(readSettings(store).defaultRestSeconds).toBe(0);
  holdAppVersion = true;
  await act(feedback.release);
  expect(readSettings(store).defaultRestSeconds).toBe(45);
  expect(host.textContent).toContain("Preview · 0:45");
});

it("restores the stored value and explains a refused optimistic setting", async () => {
  await render();
  const more = byLabel("More default rest");
  if (!more) throw Error("Missing rest stepper");
  vi.spyOn(store, "put").mockImplementationOnce(() => {
    throw Error("Storage is full.");
  });
  feedback.hold();
  await act(() => more.click());
  expect(host.textContent).toContain("Preview · 0:30");
  await act(feedback.release);
  expect(readSettings(store).defaultRestSeconds).toBe(0);
  expect(host.textContent).not.toContain("Preview · 0:30");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Storage is full.");
});

it("changes the other settings from their rows", async () => {
  await render();
  await press("Week starts on, Monday");
  const sunday = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (option) => option.textContent === "Sunday",
  );
  await act(async () => sunday?.click());
  await render();
  expect(readSettings(store).firstWeekday).toBe(0);
  const before = readSettings(store).countWarmups;
  await press("Warm-ups in stats");
  expect(readSettings(store).countWarmups).toBe(!before);
});

it("keeps Track RIR in the synced settings, off until it is turned on", async () => {
  await render();
  const toggle = () => byLabel("Ask for effort");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(toggle()?.textContent).toContain("An optional prompt after each working set");
  // Showing the switch off writes nothing.
  expect(store.get("settings", "settings")).toBeNull();
  await press("Ask for effort");
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(readTrackRir(store)).toBe(true);
  // Saved in the settings record, waiting to go to the server, and not on the device alone.
  expect(store.get("settings", "settings")).toMatchObject({
    status: "pending",
    content: { trackRepsInReserve: true },
  });
  expect(files.size).toBe(0);
  await press("Ask for effort");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(store.get("settings", "settings")?.content?.trackRepsInReserve).toBe(false);
});

it("shows Track RIR as the synced settings record says", async () => {
  const settings = settingsContent(null, {}) as unknown as JsonObject;
  store.put("settings", "settings", { ...settings, trackRepsInReserve: true });
  await render();
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("true");
  store.put("settings", "settings", { ...settings, trackRepsInReserve: false });
  version++;
  await render();
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("false");
});

it("no longer reads Track RIR from where earlier builds kept it on this device", async () => {
  const path = "document/leve-device-preferences.json";
  const saved = JSON.stringify({ trackRir: true, futureSetting: "keep" });
  files.set(path, saved);
  await render();
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("false");
  expect(readTrackRir(store)).toBe(false);
  expect(store.get("settings", "settings")).toBeNull();
  await press("Ask for effort");
  expect(readTrackRir(store)).toBe(true);
  // The old copy is left as it was, and nothing reads it.
  expect(files.get(path)).toBe(saved);
});

it("hides Track RIR while the connected server can't keep it", async () => {
  store.close();
  store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    contract: previewContract,
    path: `/settings-screen-${n++}.db`,
    appVersion: "test",
  });
  saveSettings(store, { trackRepsInReserve: true });
  store.bindAccount("server", "lifter");
  // A server whose release has no such setting.
  store.setNegotiated("1.2", []);
  version++;
  await render();
  expect(byLabel("Ask for effort")).toBeNull();
  expect(byLabel("Warm-ups in stats")).not.toBeNull();
  const before = store.get("settings", "settings");
  expect(() => saveTrackRir(store, false)).toThrow(SettingsError);
  expect(store.get("settings", "settings")).toEqual(before);
  // The setting keeps its value for the live workout.
  expect(readTrackRir(store)).toBe(true);

  // A newer release first downloads everything again; the switch waits for that.
  store.setNegotiated("2.0", ["track_reps_in_reserve"]);
  version++;
  await render();
  expect(store.syncState().refreshFrom).toBe("1.2");
  expect(byLabel("Ask for effort")).toBeNull();
  const { cursor, lineage } = store.syncState();
  store.applyPull([], cursor, { release: "2.0", lastPage: true, cursor, lineage });
  version++;
  await render();
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("true");
  await press("Ask for effort");
  expect(readTrackRir(store)).toBe(false);
});

it("chooses and reloads an appearance without changing synced or other device settings", async () => {
  const path = "document/leve-device-preferences.json";
  files.set(path, JSON.stringify({ trackRir: true, futureSetting: "keep" }));
  const accountSettings = store.get("settings", "settings");
  await render();

  await press("Appearance, System");
  const choices = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
  expect(choices.map((option) => option.textContent)).toEqual(["System", "Light", "Dark"]);
  await act(() => choices[1]?.click());
  expect(byLabel("Appearance, Light")).not.toBeNull();
  expect(JSON.parse(files.get(path) ?? "{}")).toEqual({
    appearance: "light",
    trackRir: true,
    futureSetting: "keep",
  });
  forgetDevicePreferences();
  await render();
  expect(byLabel("Appearance, Light")).not.toBeNull();
  expect(store.get("settings", "settings")).toEqual(accountSettings);
  expect(store.prepareSubmissions("1.0")).toEqual([]);
});

it("keeps an appearance choice for the session without overwriting unreadable device preferences", async () => {
  const path = "document/leve-device-preferences.json";
  const saved = JSON.stringify({ trackRir: true, futureSetting: "keep" });
  files.set(path, saved);
  await render();
  await press("Appearance, System");
  const dark = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (option) => option.textContent === "Dark",
  );
  if (!dark) throw Error("Missing Dark appearance");
  const read = vi.spyOn(File.prototype, "textSync").mockImplementation(() => {
    throw Error("Unable to read existing preferences");
  });
  try {
    await act(() => dark.click());
    expect(byLabel("Appearance, Dark")).not.toBeNull();
    expect(files.get(path)).toBe(saved);
  } finally {
    read.mockRestore();
  }
  forgetDevicePreferences();
  await render();
  expect(byLabel("Appearance, System")).not.toBeNull();
});

it("starts again only once the action sheet is confirmed", async () => {
  files.set("document/leve-device-preferences.json", JSON.stringify({ appearance: "dark" }));
  await render();
  await press("Start again with fresh preview data");
  expect(reset).not.toHaveBeenCalled();
  await press("Keep my data");
  expect(reset).not.toHaveBeenCalled();
  expect(byLabel("Appearance, Dark")).not.toBeNull();
  await press("Start again with fresh preview data");
  const confirm = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]'),
  ].find((button) => button.textContent === "Delete and start again");
  await act(async () => confirm?.click());
  expect(reset).toHaveBeenCalledTimes(1);
  // The appearance, kept on this device alone, starts again too.
  expect(byLabel("Appearance, System")).not.toBeNull();
});

it("starts Track RIR off again with fresh data, without writing settings nobody chose", async () => {
  saveTrackRir(store, true);
  await render();
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("true");
  const old = store;
  // Starting again deletes the database and opens a fresh one.
  reset.mockImplementationOnce(async () => {
    const fresh = await openDeviceStore({
      engine: createSqlJsEngine(SQL),
      path: `/settings-screen-${n++}.db`,
      appVersion: "test",
    });
    old.close();
    store = fresh;
    return true;
  });
  await press("Start again with fresh preview data");
  const confirm = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]'),
  ].find((button) => button.textContent === "Delete and start again");
  await act(async () => confirm?.click());
  await render();
  expect(store).not.toBe(old);
  expect(byLabel("Ask for effort")?.getAttribute("aria-checked")).toBe("false");
  expect(store.get("settings", "settings")).toBeNull();
});

it("says under More what starting again brings back, for the kind of build it is", async () => {
  await render();
  expect(document.body.textContent).toContain("brings the made-up data back.");
  expect(document.body.textContent).not.toContain("starts empty");
  await act(() => root.unmount());
  root = createRoot(host);
  build.sampleData = false;
  await render();
  expect(document.body.textContent).not.toContain("made-up");
  expect(document.body.textContent).toContain(
    "Deleting everything removes your workouts and settings from this device. Leve then starts empty.",
  );
});

it("offers to delete everything, without promising preview data, in a build that starts empty", async () => {
  build.sampleData = false;
  await render();
  expect(document.body.textContent).not.toContain("preview data");
  expect(document.body.textContent).not.toContain("made-up");
  await press("Delete everything on this device");
  expect(reset).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Leve then starts empty.");
  const confirm = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]'),
  ].find((button) => button.textContent === "Delete and start again");
  await act(async () => confirm?.click());
  expect(reset).toHaveBeenCalledTimes(1);
});

it("offers TestFlight a start again with sample data, apart from deleting everything", async () => {
  build.sampleData = false;
  const confirm = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]')].find(
      (button) => button.textContent === label,
    );
  await render();
  expect(document.body.textContent).not.toContain("Start again with sample data");

  await act(() => root.unmount());
  root = createRoot(host);
  build.sampleDataOnRequest = true;
  await render();
  expect(document.body.textContent).toContain(
    "Leve then starts empty, or with made-up workouts when you start again with sample data.",
  );
  await press("Delete everything on this device");
  await act(async () => confirm("Delete and start again")?.click());
  expect(reset).toHaveBeenLastCalledWith(false);

  await press("Start again with sample data");
  expect(reset).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("made-up sample workouts loaded in their place.");
  await press("Keep my data");
  expect(reset).toHaveBeenCalledTimes(1);
  await press("Start again with sample data");
  await act(async () => confirm("Delete and load sample data")?.click());
  expect(reset).toHaveBeenCalledTimes(2);
  expect(reset).toHaveBeenLastCalledWith(true);
});

it("never offers made-up workouts in a build that syncs", async () => {
  // They would go up to the signed-in account.
  sync.on = true;
  build.sampleData = true;
  build.sampleDataOnRequest = true;
  try {
    await render();
    expect(document.body.textContent).not.toContain("made-up");
    expect(document.body.textContent).not.toContain("Start again with sample data");
    expect(document.body.textContent).toContain("Delete everything on this device");
    await press("Delete everything on this device");
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]')]
        .find((button) => button.textContent === "Delete and start again")
        ?.click(),
    );
    expect(reset).toHaveBeenLastCalledWith(false);
  } finally {
    sync.on = false;
  }
});

it("draws the logo in the about line and still names it Leve", async () => {
  await render();
  const about = document.querySelector<HTMLElement>('[aria-label^="Leve, version 0.1.0, build "]');
  if (!about) throw Error("Missing the about line");
  // The logo is drawn, not typed. A browser may read the line's content rather than its label, so on
  // the web the logo is an image named Leve.
  const logo = about.querySelector<HTMLElement>('[data-testid="wordmark"]');
  expect(logo?.getAttribute("role")).toBe("img");
  expect(logo?.getAttribute("aria-label")).toBe("Leve");
  const [word, stop] = [...(logo?.querySelectorAll("path") ?? [])].map((path) =>
    path.getAttribute("fill"),
  );
  // Secondary ink and the commit vermilion, whichever appearance the test environment reports.
  const appearance = word === palettes.dark.fg2 ? palettes.dark : palettes.paper;
  expect(word).toBe(appearance.fg2);
  expect(stop).toBe(appearance.commit);
  // The name is not typed out a second time beside the logo.
  expect(about.textContent).toMatch(/^ · version 0\.1\.0 · build /);
});
