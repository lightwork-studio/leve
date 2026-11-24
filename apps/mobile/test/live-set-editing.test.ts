/// <reference lib="dom" />
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { router } from "expo-router";
import { act, createElement, type ReactElement, useState } from "react";
import { Text } from "react-native";
import { withTiming } from "react-native-reanimated";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { World } from "../../../packages/sync/test/support/harness.ts";
import ActiveWorkoutScreen from "../app/workout/active.tsx";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { EXERCISES } from "../src/data/exercises.ts";
import { liveData, readSettings } from "../src/data/read.ts";
import { restTimer } from "../src/data/rest-timer.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import { saveTrackRir } from "../src/data/track-rir.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  finishWorkout,
  logSet,
  updateSet,
} from "../src/data/workout-actions.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import {
  RestSlab,
  SetStrip,
  type StripField,
  stripLayout,
  valueSize,
} from "../src/ui/live/dock.tsx";
import { isSwipe, SWIPE_OPEN, swipeOffset } from "../src/ui/live/swipe-row.tsx";

// The live workout's set editor in the dock, removing with Undo, and reps in reserve. Native views
// and animations are inert in Node; the screen's controls and its writes are real.
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  View: "View",
  Text: "Text",
  TextInput: "Input",
  ScrollView: "Scroll",
  Pressable: "Press",
  Modal: "Modal",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Platform: { OS: "ios" },
  Keyboard: {
    dismiss: () => {},
    isVisible: () => false,
    addListener: (event: string, callback: () => void) => {
      keyboardEvents.set(event, callback);
      return { remove: () => keyboardEvents.delete(event) };
    },
  },
  AccessibilityInfo: {
    // Records where a screen reader's focus is sent, by the control's name.
    sendAccessibilityEvent: (target: { label?: string }) => focused.push(target.label),
    isScreenReaderEnabled: () => Promise.resolve(screenReader),
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  StyleSheet: { create: (s: object) => s, absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Line: "Line" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "View", Text: "Text" },
  useSharedValue: (value: number) => useState(() => ({ value }))[0],
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  withTiming: vi.fn((n: number) => n),
  withSpring: (n: number) => n,
  Easing: { linear: (n: number) => n },
  ReduceMotion: { Never: "never" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-router", () => ({
  router: { push: () => {}, back: () => {}, canGoBack: () => true },
  useNavigation: () => ({ addListener: () => () => {} }),
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: "View",
  StillOnOpen: "View",
  useExit: () => undefined,
  useArrivedLater: () => false,
}));
vi.mock("../src/ui/motion.ts", () => ({
  layout: {},
  layoutDuration: 220,
  sinkOut: {},
  spring: {},
  easeOut: {},
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, warning: () => {}, select: () => {}, success: () => {} },
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Icon",
  ChevronIcon: "Icon",
  CloseIcon: "Icon",
  MoreIcon: "Icon",
  PlusIcon: "Icon",
  DeleteIcon: "Icon",
  EditIcon: "Icon",
  ForwardIcon: "Icon",
  MinusIcon: "Icon",
  TimerIcon: "Icon",
  NoteIcon: "Icon",
}));
vi.mock("../src/ui/muscle-map.tsx", () => ({ WorkoutMuscleSummary: "WorkoutMuscleSummary" }));
vi.mock("../src/ui/progress.tsx", () => ({ Fill: "Fill" }));
vi.mock("../src/ui/navigation.ts", () => ({ goHome: () => {} }));
vi.mock("../src/ui/exercise-picker.tsx", () => ({ ExercisePicker: "Picker" }));
vi.mock("../src/ui/use-settled.ts", () => ({ useSettled: () => true }));
vi.mock("../src/ui/use-ticker.ts", () => ({ useTicker: () => 0, clock: () => "0:00" }));
vi.mock("../src/ui/count-up.tsx", () => ({ useRolling: (n: number) => n }));

let store: DeviceStore;
/** Where focus was sent, latest last, and whether a screen reader runs. */
let focused: (string | undefined)[] = [];
let screenReader = false;
/** Every toast shown, oldest first. */
let toasts: string[] = [];
vi.mock("../src/ui/notice.tsx", async (original) => ({
  ...(await original<typeof import("../src/ui/notice.tsx")>()),
  showToast: (text: string) => toasts.push(text),
}));
const keyboardEvents = new Map<string, () => void>();
vi.mock("../src/data/queries.ts", () => ({
  useLive: () => liveData(store),
  usePastWorkouts: () => [],
  useSettings: () => readSettings(store),
}));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store, change: (write: (store: DeviceStore) => void) => write(store) }),
}));

const SQL = await initSqlJs();
let screen: ReactTestRenderer | undefined;
let n = 0;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  store = await openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/live-set-${n++}.db`,
    appVersion: "test",
  });
});
afterEach(async () => {
  await act(() => screen?.unmount());
  screen = undefined;
  forgetDevicePreferences();
  restTimer.skip(store, store.activeWorkout()?.id ?? "");
  store.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  focused = [];
  toasts = [];
  screenReader = false;
});

/** A workout with Bench Press and `count` empty sets, resting `rest` seconds after each. */
function benchWorkout(count = 3, rest = 120) {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, rest);
  while (store.list("workout_set", { parentId: entry }).length < count) addSet(store, entry);
  // Values to log, as if typed.
  for (const row of store.list("workout_set", { parentId: entry }))
    updateSet(store, row.id, { weightKg: 60, reps: 8 });
  const sets = () =>
    store
      .list("workout_set", { parentId: entry })
      .map((row) => ({ id: row.id, ...(row.content as unknown as WorkoutSet) }));
  return { workout, entry, sets };
}

/** A native view as tests see it: named after its control, so focus moves can be read. */
const nativeView = (element: ReactElement) => ({
  label: (element.props as { accessibilityLabel?: string }).accessibilityLabel,
  scrollTo: () => {},
  focus: () => {},
});

async function mount(nodeMock: (element: ReactElement) => object = nativeView) {
  await act(() => {
    screen = create(createElement(ActiveWorkoutScreen), {
      createNodeMock: nodeMock,
    });
  });
  if (!screen) throw Error("The workout didn't open");
  const root = screen.root;
  /** Controls are mocked as plain "Tap" elements. */
  const isTap = (node: ReactTestInstance) => (node.type as unknown) === "Tap";
  const all = (label: string) =>
    root.findAll((node) => isTap(node) && node.props.accessibilityLabel === label);
  const control = (label: string): ReactTestInstance => {
    const found = root.findAll(
      (node) => typeof node.type === "string" && node.props.accessibilityLabel === label,
    );
    if (found.length !== 1) throw Error(`${found.length} controls named ${label}`);
    return found[0] as ReactTestInstance;
  };
  const has = (label: string) =>
    root.findAll((node) => typeof node.type === "string" && node.props.accessibilityLabel === label)
      .length > 0;
  const press = (label: string) => act(() => control(label).props.onPress());
  /** The control whose text reads `text`. */
  const byText = (text: string) =>
    root.find(
      (node) =>
        isTap(node) &&
        node.findAll((child) => child.type === Text && child.props.children === text).length > 0,
    );
  const pressText = (text: string) => act(() => byText(text).props.onPress());
  const rerender = () => act(() => screen?.update(createElement(ActiveWorkoutScreen)));
  return { root, all, control, has, press, byText, pressText, rerender };
}

/** What the list's cell shows. */
const cell = (ui: Awaited<ReturnType<typeof mount>>, label: string) =>
  ui.control(label).findAllByType(Text)[0]?.props.children;

describe("rest above the keypad", () => {
  it("resizes the same countdown when opening and closing a field", async () => {
    benchWorkout();
    const ui = await mount();
    await ui.press("Log set 1");
    const panel = () => ui.root.findByType(RestSlab);
    const fullPanel = panel();
    const timing = vi.mocked(withTiming);
    timing.mockClear();

    await ui.press("kg for set 2");
    expect(panel()).toBe(fullPanel);
    expect(timing.mock.calls.map(([target]) => target)).toEqual([30]);
    timing.mockClear();

    await ui.press("reps for set 2");
    expect(panel()).toBe(fullPanel);
    expect(timing).not.toHaveBeenCalled();

    await ui.press("Done typing");
    expect(panel()).toBe(fullPanel);
    expect(timing.mock.calls.map(([target]) => target)).toEqual([50]);
  });

  it("adjusts the running rest without changing the field, then returns to the editable full timer", async () => {
    benchWorkout();
    const ui = await mount();
    await ui.press("Log set 1");
    expect(ui.root.findByType(RestSlab).props.onTime).toBeTypeOf("function");
    await ui.press("kg for set 2");
    await ui.press("7");
    const bar = () => ui.root.findByType(RestSlab);
    expect(bar().props.onTime).toBeUndefined();
    expect(
      bar().findAll((n) => String(n.props.accessibilityLabel).includes("Change the rest time")),
    ).toHaveLength(0);
    const endsAt = bar().props.rest.endsAt;
    await ui.press("15 seconds more");
    expect(bar().props.rest.endsAt).toBe(endsAt + 15000);
    await ui.press("15 seconds less");
    expect(bar().props.rest.endsAt).toBe(endsAt);
    await ui.press("0");
    expect(cell(ui, "kg for set 2")).toBe("70");
    await ui.press("Done typing");
    expect(bar().props.onTime).toBeTypeOf("function");
    await ui.press("reps for set 2");
    await ui.press("Skip rest");
    expect(ui.root.findAllByType(RestSlab)).toHaveLength(0);
    expect(ui.has("Done typing")).toBe(true);
  });

  it("shows one compact timer inside the native note sheet while its keyboard is visible", async () => {
    benchWorkout();
    const ui = await mount();
    await ui.press("Log set 1");
    await ui.press("Manage Bench Press");
    await ui.pressText("Add exercise note");
    const sheet = ui.root.find(
      (n) => String(n.type) === "Modal" && n.props["aria-label"] === "Bench Press",
    );
    await act(() => ui.control("Note for Bench Press").props.onChangeText("Pause"));
    expect(sheet.findAllByType(RestSlab)).toHaveLength(0);
    await act(() => keyboardEvents.get("keyboardDidShow")?.());
    expect(sheet.findByType(RestSlab).props.onTime).toBeUndefined();
    await act(() => keyboardEvents.get("keyboardDidHide")?.());
    expect(sheet.findAllByType(RestSlab)).toHaveLength(0);
    expect(ui.control("Note for Bench Press").props.value).toBe("Pause");
  });

  it("shows completion briefly and keeps an unfinished entry open across expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    benchWorkout(2, 5);
    const ui = await mount();
    await ui.press("Log set 1");
    await ui.press("kg for set 2");
    await ui.press("7");
    await act(() => vi.advanceTimersByTime(5000));
    const completion = () =>
      ui.root.findAll((n) => n.type === Text && n.props.children === "Rest done");
    expect(completion()).toHaveLength(1);
    await act(() => vi.advanceTimersByTime(2000));
    expect(completion()).toHaveLength(0);
    await ui.press("5");
    expect(cell(ui, "kg for set 2")).toBe("75");
  });
});

describe("the workout row", () => {
  it("shows a check on contact and withdraws it when the touch is cancelled or the log fails", async () => {
    const { sets } = benchWorkout();
    const ui = await mount();
    const button = () => ui.control("Log set 1");
    const mark = () => button().findAll((node) => (node.type as unknown) === "Icon");
    await act(() => button().props.onPressIn());
    expect(mark()).toHaveLength(1);
    expect(sets()[0]?.completedAt).toBeNull();
    await act(() => button().props.onPressOut());
    expect(mark()).toHaveLength(0);
    await act(() => button().props.onPressIn());
    vi.spyOn(store, "put").mockImplementationOnce(() => {
      throw Error("Save refused");
    });
    await ui.press("Log set 1");
    expect(mark()).toHaveLength(0);
    expect(sets()[0]?.completedAt).toBeNull();
    expect(alerts(ui)).toContain("Save refused");
  });

  it("counts logged sets only, half for secondary muscles, warm-ups as Settings says", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    const ohp = addExercise(store, workout, EXERCISES.ohp, 0);
    saveSettings(store, { countWarmups: false });
    for (let i = 0; i < 4; i++) addSet(store, bench);
    addSet(store, ohp);
    const benchSets = store.list("workout_set", { parentId: bench });
    const ohpSets = store.list("workout_set", { parentId: ohp });
    // Bench: a logged warm-up, three logged sets and one left unlogged. Press: two logged sets.
    updateSet(store, benchSets[0]?.id ?? "", { type: "warmup" });
    for (const set of benchSets.slice(0, 4)) logSet(store, set.id, { weightKg: 60, reps: 8 });
    for (const set of ohpSets) logSet(store, set.id, { weightKg: 40, reps: 8 });
    const ui = await mount();
    const row = () => ui.root.findByType("WorkoutMuscleSummary" as never).props;
    // Bench works the chest, then shoulders and triceps; the press the shoulders, then chest and
    // triceps. Chest 3 + 2 × ½, shoulders 3 × ½ + 2, triceps 3 × ½ + 2 × ½.
    expect(row().sets).toBe(5);
    expect(row().amounts).toEqual({ chest: 4, shoulders: 3.5, triceps: 2.5 });
    saveSettings(store, { countWarmups: true });
    await ui.rerender();
    // Warm-ups counted: the warm-up adds a set to the bench's muscles.
    expect(row().sets).toBe(6);
    expect(row().amounts).toEqual({ chest: 5, shoulders: 4, triceps: 3 });
  });
});

describe("the set's editor in the dock", () => {
  it("opens from the set number, applies a type and returns to logging", async () => {
    const { sets } = benchWorkout();
    const ui = await mount();
    await ui.press("Edit set 1");
    expect(ui.has("Done with this set")).toBe(true);
    expect(ui.has("Log set 1 of Bench Press")).toBe(false);
    const types = ui.root.findAll((node) => node.props.accessibilityRole === "radio");
    expect(types.map((node) => node.findByType(Text).props.children)).toEqual([
      "Working",
      "Warm-up",
      "Drop",
      "Failure",
    ]);
    await ui.pressText("Warm-up");
    expect(sets()[0]?.type).toBe("warmup");
    expect(ui.has("Done with this set")).toBe(false);
    // Back to logging, now on the warm-up.
    expect(ui.has("Log warm-up of Bench Press")).toBe(true);
    await ui.press("Edit set 1");
    await ui.press("Done with this set");
    expect(sets()[1]?.type).toBe("normal");
    expect(ui.has("Done with this set")).toBe(false);
  });

  it("removes a set at once, and Undo brings back the same set in the same place", async () => {
    const { sets } = benchWorkout();
    logSet(store, sets()[1]?.id ?? "", { weightKg: 60, reps: 8, repsInReserve: 2 });
    const before = sets();
    const record = store.get("workout_set", before[1]?.id ?? "");
    const ui = await mount();
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
    // Gone from the list and the totals straight away...
    expect(liveData(store)?.tree.entries[0]?.sets.map((s) => s.id)).toEqual([
      before[0]?.id,
      before[2]?.id,
    ]);
    expect(liveData(store)?.summary.sets).toBe(0);
    expect(ui.has("Edit set 3")).toBe(false);
    // ...but nothing is written until Undo has gone.
    expect(store.get("workout_set", before[1]?.id ?? "")).toEqual(record);
    await ui.press("Undo: Set 2 removed");
    expect(sets()).toEqual(before);
    expect(store.get("workout_set", before[1]?.id ?? "")).toEqual(record);
    expect(liveData(store)?.tree.entries[0]?.sets.map((s) => s.id)).toEqual(
      before.map((s) => s.id),
    );
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
  });

  it("deletes the set once something else is done, or after a few seconds", async () => {
    const { sets } = benchWorkout();
    const [first, second] = sets();
    const ui = await mount();
    await ui.press("Edit set 1");
    await ui.pressText("Remove set");
    expect(sets()).toHaveLength(3);
    // The next action ends the Undo.
    await ui.pressText("Add set");
    expect(sets().map((s) => s.id)).not.toContain(first?.id);
    expect(ui.has("Undo: Set 1 removed")).toBe(false);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ui.press("Edit set 1");
    await ui.pressText("Remove set");
    expect(sets().map((s) => s.id)).toContain(second?.id);
    await act(() => vi.advanceTimersByTime(7900));
    expect(sets().map((s) => s.id)).toContain(second?.id);
    await act(() => vi.advanceTimersByTime(200));
    expect(sets().map((s) => s.id)).not.toContain(second?.id);
    expect(ui.has("Undo: Set 1 removed")).toBe(false);
  });

  it("never lets sync see a removal that was undone", { timeout: 60000 }, async () => {
    const original = store;
    const world = new World();
    try {
      const server = world.server();
      const account = { server: "s", account: "alice", transport: server.transport("alice") };
      const phone = await world.phone("phone", account);
      const other = await world.phone("other", account);
      store = phone.store;
      const { sets } = benchWorkout(2);
      const [first] = sets();
      await phone.sync();
      await other.sync();
      const ui = await mount();
      await ui.press("Edit set 1");
      await ui.pressText("Remove set");
      // Sync runs while Undo is showing: the set is still there for every device.
      await phone.sync();
      await other.sync();
      expect(other.store.get("workout_set", first?.id ?? "")?.deleted).toBe(false);
      await ui.press("Undo: Set 1 removed");
      await phone.sync();
      await other.sync();
      expect(phone.store.get("workout_set", first?.id ?? "")?.status).toBe("synced");
      expect(other.store.get("workout_set", first?.id ?? "")?.content).toEqual(
        phone.store.get("workout_set", first?.id ?? "")?.content,
      );
      // Removed for good, it is deleted everywhere.
      await ui.press("Edit set 1");
      await ui.pressText("Remove set");
      await ui.pressText("Add set");
      await phone.sync();
      await other.sync();
      const gone = other.store.get("workout_set", first?.id ?? "");
      expect(gone === null || gone.deleted).toBe(true);
      await act(() => screen?.unmount());
      screen = undefined;
    } finally {
      store = original;
      await world.dispose();
    }
  });
});

describe("a set that changes while its removal waits for Undo", () => {
  const CHANGED = "This set changed. Reopen the set before removing it.";

  it("keeps a set whose stored values changed after its row was drawn, before it was removed", async () => {
    const { sets } = benchWorkout();
    const id = sets()[1]?.id ?? "";
    const ui = await mount();
    await ui.press("Edit set 2");
    // A write lands (from the Live Activity, say) before the screen draws again: the lifter still
    // sees 60 kg when they remove the set.
    updateSet(store, id, { weightKg: 100 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ui.pressText("Remove set");
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    await act(() => vi.advanceTimersByTime(8100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(alerts(ui)).toContain(CHANGED);
    expect(store.get("workout_set", id)?.deleted).toBe(false);
    expect(sets().find((set) => set.id === id)).toMatchObject({ weightKg: 100, reps: 8 });
    expect(ui.has("Edit set 2")).toBe(true);
  });

  it("keeps a set changed on this device during the Undo, with its new values", async () => {
    const { sets } = benchWorkout();
    const id = sets()[1]?.id ?? "";
    const ui = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
    // Logged from outside this screen (the Live Activity) while Undo shows.
    logSet(store, id, { weightKg: 62.5, reps: 6 });
    await act(() => vi.advanceTimersByTime(8100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(alerts(ui)).toContain(CHANGED);
    expect(store.get("workout_set", id)?.deleted).toBe(false);
    expect(sets().find((set) => set.id === id)).toMatchObject({ weightKg: 62.5, reps: 6 });
    expect(sets().find((set) => set.id === id)?.completedAt).toBeTruthy();
  });

  it("keeps a set another phone changed during the Undo", { timeout: 60000 }, async () => {
    const original = store;
    const world = new World();
    try {
      const server = world.server();
      const account = { server: "s", account: "alice", transport: server.transport("alice") };
      const phone = await world.phone("phone", account);
      const other = await world.phone("other", account);
      store = phone.store;
      const { sets } = benchWorkout(2);
      const id = sets()[0]?.id ?? "";
      await phone.sync();
      await other.sync();
      const ui = await mount();
      await ui.press("Edit set 1");
      await ui.pressText("Remove set");
      // The other phone changes the set; this one downloads it while Undo still shows.
      updateSet(other.store, id, { reps: 12 });
      await other.sync();
      await phone.sync();
      expect(phone.store.get("workout_set", id)?.content?.reps).toBe(12);
      expect(ui.has("Undo: Set 1 removed")).toBe(true);
      // Anything else done ends the Undo (here opening the other set, now shown as set 1); the
      // deletion is refused.
      await ui.press("Edit set 1");
      expect(ui.has("Undo: Set 1 removed")).toBe(false);
      expect(alerts(ui)).toContain(CHANGED);
      await phone.sync();
      await other.sync();
      for (const device of [phone.store, other.store])
        expect(device.get("workout_set", id)).toMatchObject({
          deleted: false,
          content: expect.objectContaining({ reps: 12, weightKg: 60 }),
        });
      await act(() => screen?.unmount());
      screen = undefined;
    } finally {
      store = original;
      await world.dispose();
    }
  });

  it("says in a toast that the set was kept when the workout is minimised", async () => {
    const { sets } = benchWorkout();
    const [first, second] = sets();
    const ui = await mount();
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
    updateSet(store, second?.id ?? "", { reps: 10 });
    await ui.press("Minimise workout");
    expect(toasts).toEqual(["A removed set changed, so it was kept."]);
    expect(sets().find((set) => set.id === second?.id)).toMatchObject({ reps: 10 });
    // A removal nothing changed is deleted on the way out, with nothing to say.
    toasts = [];
    await ui.rerender();
    await ui.press("Edit set 1");
    await ui.pressText("Remove set");
    await ui.press("Minimise workout");
    expect(toasts).toEqual([]);
    expect(sets().map((set) => set.id)).not.toContain(first?.id);
  });

  it("says in a toast that the set was kept when the screen closes", async () => {
    const { sets } = benchWorkout();
    const id = sets()[0]?.id ?? "";
    const ui = await mount();
    await ui.press("Edit set 1");
    await ui.pressText("Remove set");
    updateSet(store, id, { weightKg: 70 });
    await act(() => screen?.unmount());
    screen = undefined;
    expect(toasts).toEqual(["A removed set changed, so it was kept."]);
    expect(store.get("workout_set", id)?.content?.weightKg).toBe(70);
  });

  it.each([
    ["Finish in the header", "/workout/finish"],
    ["the dock's Finish workout", "/workout/finish"],
    ["the workout's notes", "/workout/notes/[id]"],
  ] as const)("stays to say why when %s ends an Undo that is refused", async (via, route) => {
    const { sets } = benchWorkout(2);
    const [first, second] = sets();
    for (const set of [first, second]) logSet(store, set?.id ?? "", { weightKg: 60, reps: 8 });
    const push = vi.spyOn(router, "push");
    const ui = await mount();
    const leave = () =>
      via === "Finish in the header"
        ? ui.pressText("Finish")
        : ui.press(via === "the workout's notes" ? "Workout notes, 0" : "Finish workout");
    const pushed = () =>
      push.mock.calls.map(([to]) =>
        typeof to === "string" ? to : (to as { pathname: string }).pathname,
      );
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
    updateSet(store, second?.id ?? "", { reps: 10 });
    await leave();
    expect(pushed()).toEqual([]);
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(alerts(ui)).toContain(CHANGED);
    expect(sets().find((set) => set.id === second?.id)).toMatchObject({ reps: 10 });
    // Seen, the next tap goes.
    await leave();
    expect(pushed()).toEqual([route]);
    expect(toasts).toEqual([]);
  });

  it("doesn't say the set changed when it couldn't be deleted for another reason", async () => {
    const { sets } = benchWorkout();
    const id = sets()[0]?.id ?? "";
    const ui = await mount();
    await ui.press("Edit set 1");
    await ui.pressText("Remove set");
    vi.spyOn(store, "delete").mockImplementation(() => {
      throw Error("The disk is full");
    });
    await ui.press("Minimise workout");
    expect(toasts).toEqual(["A removed set couldn't be deleted, so it was kept."]);
    expect(store.get("workout_set", id)?.deleted).toBe(false);
  });

  it("ends the Undo before the Discard sheet opens, so discarding works", async () => {
    const { workout, sets } = benchWorkout();
    const id = sets()[1]?.id ?? "";
    const ui = await mount();
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    await ui.pressText("Discard workout");
    // The removal is final now: Undo has gone and the set is deleted.
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(store.get("workout_set", id)?.deleted ?? true).toBe(true);
    // The sheet shows the workout as it now is, and discards it.
    const sheet = ui.root.findAll((node) => (node.type as unknown) === "Modal");
    expect(sheet).toHaveLength(1);
    const confirm = sheet[0]?.find(
      (node) =>
        (node.type as unknown) === "Tap" &&
        node.findAll((child) => child.type === Text && child.props.children === "Discard workout")
          .length > 0,
    );
    await act(() => confirm?.props.onPress());
    expect(alerts(ui)).toEqual([]);
    expect(store.activeWorkout()).toBeNull();
    expect(store.get("workout", workout)?.deleted ?? true).toBe(true);
  });
});

/** Every problem the screen shows. */
const alertTexts = (ui: Awaited<ReturnType<typeof mount>>) =>
  ui.root.findAll((node) => node.type === Text && node.props.accessibilityRole === "alert");
const alerts = (ui: Awaited<ReturnType<typeof mount>>) =>
  alertTexts(ui).map((node) => node.props.children);
/** The problems shown in the dock, outside the scrolled list. */
const dockAlerts = (ui: Awaited<ReturnType<typeof mount>>) =>
  alertTexts(ui)
    .filter((node) => {
      for (let up = node.parent; up; up = up.parent)
        if ((up.type as unknown) === "Scroll") return false;
      return true;
    })
    .map((node) => node.props.children);

describe("correcting a logged set", () => {
  it("shows and logs the pending correction when the next row is checked directly", async () => {
    const { sets } = benchWorkout(2);
    updateSet(store, sets()[1]?.id ?? "", { reps: null });
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("reps for set 1");
    await ui.press("1");
    await ui.press("0");
    expect(cell(ui, "reps for set 2")).toBe("10");
    await ui.press("Log set 2");
    expect(sets().map((set) => set.reps)).toEqual([10, 10]);
    expect(sets()[1]?.completedAt).toEqual(expect.any(String));
  });

  it("clears a logged weight left empty on Done, and the set stays logged", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("kg for set 1");
    await ui.press("Delete");
    expect(cell(ui, "kg for set 1")).toBe("");
    await ui.press("Done typing");
    expect(sets()[0]).toMatchObject({ weightKg: null, reps: 8, completedAt: expect.any(String) });
    expect(cell(ui, "kg for set 1")).toBe("–");
    expect(alerts(ui)).toEqual([]);
  });

  it("clears logged reps left empty on Done and asks for them, with the set still logged", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("reps for set 1");
    await ui.press("Delete");
    await ui.press("Done typing");
    expect(sets()[0]).toMatchObject({ weightKg: 60, reps: null, completedAt: expect.any(String) });
    expect(cell(ui, "reps for set 1")).toBe("Add reps");
    expect(ui.has("Done typing")).toBe(false);
  });

  it("clears a logged value left empty when Next moves on", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("kg for set 1");
    await ui.press("Delete");
    await ui.press("Next: reps");
    expect(sets()[0]).toMatchObject({ weightKg: null, reps: 8, completedAt: expect.any(String) });
    expect(cell(ui, "kg for set 1")).toBe("–");
  });

  it("keeps a logged value when Done comes before any key", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("kg for set 1");
    await ui.press("Done typing");
    expect(sets()[0]).toMatchObject({ weightKg: 60, reps: 8 });
  });

  it("falls back to the suggestion when an unlogged set's field is left empty", async () => {
    const { sets } = benchWorkout(2);
    const ui = await mount();
    await ui.press("kg for set 1");
    await ui.press("Delete");
    await ui.press("Done typing");
    expect(cell(ui, "kg for set 1")).toBe("60");
    expect(sets()[0]).toMatchObject({ weightKg: 60, completedAt: null });
    await ui.press("Log set 1");
    expect(sets()[0]).toMatchObject({ weightKg: 60, reps: 8, completedAt: expect.any(String) });
  });

  it("steps on from what is typed, not from what was logged", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    await ui.press("kg for set 1");
    await ui.press("Step up 2.5");
    await ui.press("Step up 2.5");
    expect(cell(ui, "kg for set 1")).toBe("65");
    await ui.press("Done typing");
    expect(sets()[0]?.weightKg).toBe(65);

    await ui.press("kg for set 1");
    await ui.press("7");
    await ui.press("0");
    await ui.press("Step up 2.5");
    expect(cell(ui, "kg for set 1")).toBe("72.5");
    await ui.press("Done typing");
    expect(sets()[0]).toMatchObject({ weightKg: 72.5, reps: 8 });
  });

  it("says on the pad why a correction can't be saved, and stays to fix it", async () => {
    const { sets } = benchWorkout(2);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const back = vi.spyOn(router, "back");
    const ui = await mount();
    await ui.press("kg for set 1");
    for (const key of ["3", "0", "0", "0"]) await ui.press(key);
    await ui.press("Done typing");
    expect(alerts(ui)).toEqual(["That weight is out of range."]);
    expect(dockAlerts(ui)).toEqual(["That weight is out of range."]);
    // Minimising keeps the pad open on the correction instead of dropping it.
    await ui.press("Minimise workout");
    expect(back).not.toHaveBeenCalled();
    expect(ui.has("Done typing")).toBe(true);
    expect(cell(ui, "kg for set 1")).toBe("3000");
    expect(dockAlerts(ui)).toEqual(["That weight is out of range."]);
    // Fixed, it saves and minimises.
    await ui.press("Delete");
    await ui.press("Minimise workout");
    expect(sets()[0]?.weightKg).toBe(300);
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("the dock's own pad", () => {
  it("shows what stops a set being logged while the pad is open", async () => {
    const { sets } = benchWorkout(2);
    const ui = await mount();
    await ui.press("Type weight");
    for (const key of ["3", "0", "0", "0"]) await ui.press(key);
    await ui.press("Log set 1 of Bench Press");
    expect(sets()[0]?.completedAt).toBeNull();
    expect(dockAlerts(ui)).toEqual(["That weight is out of range."]);
    // Typing again answers it.
    await ui.press("Delete");
    expect(alerts(ui)).toEqual([]);
  });
});

describe("removing from the row", () => {
  it("offers Remove set to screen readers on every part of a row, and moves to Undo", async () => {
    const { sets } = benchWorkout();
    const before = sets();
    const ui = await mount();
    for (const label of ["Edit set 2", "kg for set 2", "reps for set 2", "Log set 2"])
      expect(ui.control(label).props.accessibilityActions).toEqual([
        { name: "remove", label: "Remove set" },
      ]);
    await act(() =>
      ui.control("reps for set 2").props.onAccessibilityAction({
        nativeEvent: { actionName: "remove" },
      }),
    );
    expect(liveData(store)?.tree.entries[0]?.sets).toHaveLength(2);
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    await ui.press("Undo: Set 2 removed");
    expect(sets()).toEqual(before);
  });

  it("swipes only sideways, past 10 pt, and never past open", () => {
    expect(isSwipe(8, 0)).toBe(false);
    expect(isSwipe(-12, 2)).toBe(true);
    // Mostly vertical drags scroll the list.
    expect(isSwipe(-14, 12)).toBe(false);
    expect(isSwipe(0, 40)).toBe(false);
    expect(swipeOffset(0, -60)).toBe(-60);
    expect(swipeOffset(0, 40)).toBe(8);
    expect(swipeOffset(0, -SWIPE_OPEN - 40)).toBe(-SWIPE_OPEN - 10);
    expect(swipeOffset(-SWIPE_OPEN, 30)).toBe(-70);
  });
});

describe("focus around Undo", () => {
  const removeSet2 = async (ui: Awaited<ReturnType<typeof mount>>) => {
    await ui.press("Edit set 2");
    await ui.pressText("Remove set");
  };

  it("goes to Undo, then to the set Undo brings back", async () => {
    benchWorkout();
    const ui = await mount();
    await removeSet2(ui);
    expect(focused.at(-1)).toBe("Undo: Set 2 removed");
    await ui.press("Undo: Set 2 removed");
    expect(focused.at(-1)).toBe("Edit set 2");
  });

  it("goes to the exercise when Undo goes by itself", async () => {
    benchWorkout();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ui = await mount();
    await removeSet2(ui);
    await act(() => vi.advanceTimersByTime(8100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(focused.at(-1)).toBe("Bench Press");
  });

  it("stays where it was sent since when Undo goes by itself", async () => {
    const { workout, entry } = benchWorkout();
    const ohp = addExercise(store, workout, EXERCISES.ohp, 0);
    for (const id of [entry, ohp]) {
      const row = store.get("workout_exercise", id);
      if (!row?.content) throw Error("Missing exercise");
      store.put("workout_exercise", id, { ...row.content, supersetId: 0 });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ui = await mount();
    await removeSet2(ui);
    // Jumping to the next exercise in the superset sends focus there and keeps Undo.
    await ui.press("Next in Superset 1: Overhead Press, exercise 2");
    expect(focused.at(-1)).toBe("Overhead Press");
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    await act(() => vi.advanceTimersByTime(8100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(focused.at(-1)).toBe("Overhead Press");
  });

  it("stays far longer while a screen reader runs", async () => {
    const { sets } = benchWorkout();
    screenReader = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ui = await mount();
    await removeSet2(ui);
    await act(() => vi.advanceTimersByTime(60000));
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    expect(sets()).toHaveLength(3);
    await act(() => vi.advanceTimersByTime(20100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
    expect(sets()).toHaveLength(2);
  });

  it("waits while Undo has keyboard focus", async () => {
    benchWorkout();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ui = await mount();
    await removeSet2(ui);
    await act(() => ui.control("Undo: Set 2 removed").props.onFocus());
    await act(() => vi.advanceTimersByTime(30000));
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
    await act(() => ui.control("Undo: Set 2 removed").props.onBlur());
    await act(() => vi.advanceTimersByTime(8100));
    expect(ui.has("Undo: Set 2 removed")).toBe(false);
  });
});

describe("reps in reserve", () => {
  const prompt = (ui: Awaited<ReturnType<typeof mount>>, set: number) =>
    ui.has(`Skip, no reps in reserve for set ${set}`);
  /** What a set's RIR cell shows. */
  const rirCell = (ui: Awaited<ReturnType<typeof mount>>, set: number) =>
    ui.control(`reps in reserve for set ${set}`).findAllByType(Text)[0]?.props.children;

  it("asks after a logged set, on the rest timer, and records a pick", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    expect(prompt(ui, 1)).toBe(true);
    // The picks are the top band of the rest panel.
    const panel = ui.root.findByType(RestSlab);
    expect(panel).toBeDefined();
    await ui.press("2 reps in reserve");
    expect(sets()[0]?.repsInReserve).toBe(2);
    expect(prompt(ui, 1)).toBe(false);
  });

  it("records nothing on Skip, when the rest ends, or when the next set is logged", async () => {
    const { workout, sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    await ui.press("Skip, no reps in reserve for set 1");
    expect(prompt(ui, 1)).toBe(false);
    // Resting, the dock shows the timer: the next set is logged from its row.
    await ui.press("Log set 2");
    expect(prompt(ui, 2)).toBe(true);
    await act(() => restTimer.skip(store, workout));
    await ui.rerender();
    expect(prompt(ui, 2)).toBe(false);
    await ui.press("Log set 3 of Bench Press");
    expect(prompt(ui, 3)).toBe(true);
    await ui.press("Undo logged set 3");
    expect(prompt(ui, 3)).toBe(false);
    expect(sets().map((s) => s.repsInReserve)).toEqual([null, null, null]);
  });

  it("asks the next set instead when it is logged first", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    await ui.press("Log set 2");
    expect(prompt(ui, 1)).toBe(false);
    expect(prompt(ui, 2)).toBe(true);
    await ui.press("1 reps in reserve");
    expect(sets().map((s) => s.repsInReserve)).toEqual([null, 1, null]);
  });

  it("takes 5+ to a pad for whole numbers up to 10, with one Done", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    await ui.press("5 or more: opens the number pad");
    // The pad opens on 5, recorded only on Done.
    expect(sets()[0]?.repsInReserve).toBeNull();
    expect(rirCell(ui, 1)).toBe("5");
    expect(ui.all("Done")).toHaveLength(1);
    expect(ui.has("Done typing")).toBe(false);
    expect(ui.has("Decimal point")).toBe(false);
    await ui.press("1");
    // 11 would be past 10: refused.
    await ui.press("1");
    expect(rirCell(ui, 1)).toBe("1");
    await ui.press("Done");
    expect(sets()[0]?.repsInReserve).toBe(1);
    // It opens on the set's RIR, and steps stop at 10.
    await ui.press("reps in reserve for set 1");
    await ui.press("5 or more: opens the number pad");
    expect(rirCell(ui, 1)).toBe("1");
    for (let i = 0; i < 10; i++) await ui.press("Step up 1");
    await ui.press("Done");
    expect(sets()[0]?.repsInReserve).toBe(10);
  });

  it("closes the 5+ pad without recording anything", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    logSet(store, sets()[1]?.id ?? "", { weightKg: 60, reps: 8, repsInReserve: 7 });
    const ui = await mount();
    // Asked after logging: closing the pad leaves it empty, and the question stays.
    await ui.press("Log set 1 of Bench Press");
    await ui.press("5 or more: opens the number pad");
    await ui.press("Close without saving");
    expect(sets()[0]?.repsInReserve).toBeNull();
    expect(prompt(ui, 1)).toBe(true);
    await ui.press("Skip, no reps in reserve for set 1");
    // A set with RIR keeps it.
    await ui.press("reps in reserve for set 2");
    await ui.press("5 or more: opens the number pad");
    expect(rirCell(ui, 2)).toBe("7");
    await ui.press("Close without saving");
    expect(sets()[1]?.repsInReserve).toBe(7);
    expect(rirCell(ui, 2)).toBe("7");
    // Typed, then closed: still kept.
    await ui.press("reps in reserve for set 2");
    await ui.press("5 or more: opens the number pad");
    await ui.press("9");
    await ui.press("Close without saving");
    expect(sets()[1]?.repsInReserve).toBe(7);
  });

  it("never changes RIR past 10 unless a new value is typed and confirmed", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    // From an import: more than can be typed here.
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8, repsInReserve: 12 });
    const ui = await mount();
    await ui.press("reps in reserve for set 1");
    await ui.press("5 or more: opens the number pad");
    expect(rirCell(ui, 1)).toBe("12");
    await ui.press("Close without saving");
    expect(sets()[0]?.repsInReserve).toBe(12);
    // Done on it as it opened, or after a step up (which can't go further), changes nothing.
    await ui.press("reps in reserve for set 1");
    await ui.press("5 or more: opens the number pad");
    await ui.press("Step up 1");
    await ui.press("Done");
    expect(sets()[0]?.repsInReserve).toBe(12);
    await ui.press("reps in reserve for set 1");
    await ui.press("5 or more: opens the number pad");
    await ui.press("8");
    await ui.press("Done");
    expect(sets()[0]?.repsInReserve).toBe(8);
  });

  it("doesn't ask after a warm-up, or when Track RIR is off or can't be stored", async () => {
    const { sets } = benchWorkout(3);
    updateSet(store, sets()[0]?.id ?? "", { type: "warmup" });
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log warm-up of Bench Press");
    expect(ui.has("Skip, no reps in reserve for warm-up")).toBe(false);
    expect(ui.has("0 reps in reserve")).toBe(false);
    await act(() => saveTrackRir(store, false));
    await ui.press("Log set 1");
    expect(prompt(ui, 1)).toBe(false);
    // Off, and nothing logged with RIR: no column either.
    expect(ui.has("reps in reserve for set 1")).toBe(false);
  });

  it("asks above the logging strip when no rest timer runs", async () => {
    const { sets } = benchWorkout(3, 0);
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    expect(prompt(ui, 1)).toBe(true);
    expect(ui.root.findAllByType(RestSlab)).toHaveLength(0);
    // The strip is still there to log the next set.
    expect(ui.has("Log set 2 of Bench Press")).toBe(true);
    await ui.press("0 reps in reserve");
    expect(sets()[0]?.repsInReserve).toBe(0);
  });

  it("fills in or fixes a set from its RIR cell", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    expect(ui.control("reps in reserve for set 2").props.accessibilityHint).toBe("Empty");
    await ui.press("reps in reserve for set 2");
    expect(ui.control("reps in reserve for set 2").props.accessibilityState).toEqual({
      expanded: true,
    });
    await ui.press("3 reps in reserve");
    expect(sets()[1]?.repsInReserve).toBe(3);
    expect(ui.has("3 reps in reserve")).toBe(false);
    // An unlogged set keeps its RIR when it is logged, and isn't asked again.
    await ui.press("Log set 2");
    expect(sets()[1]).toMatchObject({ repsInReserve: 3 });
    expect(prompt(ui, 2)).toBe(false);
  });

  it("answers the question from the row instead, without asking twice", async () => {
    const { sets } = benchWorkout();
    saveTrackRir(store, true);
    const ui = await mount();
    await ui.press("Log set 1 of Bench Press");
    await ui.press("reps in reserve for set 1");
    expect(prompt(ui, 1)).toBe(false);
    expect(ui.all("2 reps in reserve")).toHaveLength(1);
    await ui.press("2 reps in reserve");
    expect(sets()[0]?.repsInReserve).toBe(2);
  });

  it("keeps showing RIR already logged, even with Track RIR off, without rewriting it", async () => {
    const { sets } = benchWorkout();
    // From an import: more than can be typed here.
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8, repsInReserve: 12 });
    const ui = await mount();
    const cell = ui.control("reps in reserve for set 1");
    expect(cell.findByType(Text).props.children).toBe("12");
    expect(ui.control("reps in reserve for set 2").findByType(Text).props.children).toBe("–");
    await ui.press("Log set 2 of Bench Press");
    await ui.press("Edit set 1");
    await ui.pressText("Drop");
    expect(sets()[0]).toMatchObject({ type: "drop", repsInReserve: 12 });
  });

  it("shows RIR read-only while the account can't store it", async () => {
    // A contract with a release from before reps in reserve, as an older server would speak.
    store = await openDeviceStore({
      engine: createSqlJsEngine(SQL),
      contract: previewContract,
      path: `/live-set-${n++}.db`,
      appVersion: "test",
    });
    const { sets } = benchWorkout();
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8, repsInReserve: 2 });
    saveTrackRir(store, true);
    // Synced with a server whose release has no reps in reserve.
    store.bindAccount("server", "user");
    store.setNegotiated("1.1", []);
    const ui = await mount();
    const cell = ui.control("reps in reserve for set 1, 2");
    expect(cell.props.accessibilityRole).toBeUndefined();
    expect(cell.props.onPress).toBeUndefined();
    await ui.press("Log set 2 of Bench Press");
    expect(prompt(ui, 2)).toBe(false);
    expect(sets()[0]?.repsInReserve).toBe(2);
  });

  it.each([
    ["can store RIR but not the Track RIR setting", "1.2", false],
    ["stores both", "2.0", true],
  ] as const)(
    "asks only when Track RIR can be switched off too: a server that %s",
    async (_, release, asks) => {
      // Track RIR stays on from before the account was connected; the older server hides its switch.
      const old = store;
      store = await openDeviceStore({
        engine: createSqlJsEngine(SQL),
        contract: previewContract,
        path: `/live-set-${n++}.db`,
        appVersion: "test",
      });
      old.close();
      const { sets } = benchWorkout();
      saveTrackRir(store, true);
      store.bindAccount("server", "user");
      store.setNegotiated(release, []);
      const ui = await mount();
      await ui.press("Log set 1 of Bench Press");
      expect(prompt(ui, 1)).toBe(asks);
      // RIR can still be recorded from the set's cell either way.
      await ui.press("reps in reserve for set 1");
      await ui.press("1 reps in reserve");
      expect(sets()[0]?.repsInReserve).toBe(1);
    },
  );
});

it("finishes a workout with its RIR as logged", async () => {
  const { workout, sets } = benchWorkout(1);
  saveTrackRir(store, true);
  const ui = await mount();
  await ui.press("Log set 1 of Bench Press");
  await ui.press("4 reps in reserve");
  await act(() => screen?.unmount());
  screen = undefined;
  finishWorkout(store, workout, { countForRoutine: false });
  expect(sets()[0]?.repsInReserve).toBe(4);
});

describe("the logging strip", () => {
  /**
   * The width each value is drawn at between its steppers on a phone this wide: the strip is the
   * phone less the dock's 14 pt gutters, and holds a 56 pt check, its 1 pt border and a 1 pt
   * hairline per field.
   */
  const DRAWN: Record<number, { weight: number; reps: number }> = {
    // 362 pt strip: reps 133 (132 + hairline), weight 171; steppers drawn 34 pt.
    390: { weight: 102, reps: 64 },
    // 347 pt strip: reps 133, weight 156.
    375: { weight: 87, reps: 64 },
    // 292 pt strip: 117 each; steppers drawn 30 pt.
    320: { weight: 56, reps: 56 },
  };
  /** Whether a value fits its column at the size it is drawn at (0.6 em a numeral). */
  const fits = (text: string, width: number, largest: number) =>
    valueSize(text, width, largest) * 0.6 * text.length <= width;

  it.each([390, 375, 320])("draws readable values on a %i pt phone", (phone) => {
    const { weight, reps } = DRAWN[phone] ?? { weight: 0, reps: 0 };
    for (const text of ["8–12", "10", "8"]) expect(fits(text, reps, 31)).toBe(true);
    for (const text of ["60", "102.5"])
      expect(fits(text, weight, text.length > 4 ? 25 : 31)).toBe(true);
    // A short value keeps its full size wherever there is room for it.
    if (phone >= 375) expect(valueSize("10", reps, 31)).toBe(31);
  });

  it("shares a strip without weight evenly, and gives a lone field all of it", () => {
    expect(stripLayout(362, ["distance", "duration"]).boxes).toEqual([152, 152]);
    expect(stripLayout(362, ["reps"]).boxes).toEqual([304]);
    expect(stripLayout(362, ["weight", "duration"]).boxes).toEqual([171, 133]);
    expect(stripLayout(0).boxes).toEqual([]);
  });

  const field = (metric: "weight" | "reps", text: string): StripField => ({
    metric,
    name: metric,
    text,
    firm: true,
    unit: metric === "weight" ? "kg" : "reps",
    ...(metric === "weight" ? { step: "2.5" } : {}),
    steps: 0,
    editing: false,
    onStep: () => {},
    onEdit: () => {},
  });
  /** The strip laid out on a phone this wide, each part measured from what it is drawn as. */
  const stripOn = async (phone: number) => {
    let strip: ReactTestRenderer | undefined;
    await act(() => {
      strip = create(
        createElement(SetStrip, {
          fields: [field("weight", "60"), field("reps", "8–12")],
          logLabel: "Log set 2",
          canLog: true,
          onLog: () => {},
        }),
      );
    });
    if (!strip) throw Error("No strip");
    const root = strip.root;
    const tap = (label: string) =>
      root.find((node) => typeof node.type === "string" && node.props.accessibilityLabel === label);
    // The strip itself is the outermost view that measures itself.
    const outer = root.find((node) => typeof node.type === "string" && node.props.onLayout);
    await act(() => outer.props.onLayout({ nativeEvent: { layout: { width: phone - 28 } } }));
    const slop = (label: string, side: "left" | "right") =>
      (tap(label).props.hitSlop?.[side] as number | undefined) ?? 0;
    const widthOf = (node: ReactTestInstance) =>
      [node.props.style].flat(2).reduce((w, s) => s?.width ?? w, 0) as number;
    /** How wide each part of a field is to touch: −, value and +. */
    const touch = (name: "weight" | "reps") => {
      const step = name === "weight" ? ", 2.5 kg" : "";
      const less = `Less ${name}${step}`;
      const more = `More ${name}${step}`;
      const segment = tap(`Type ${name}`).parent;
      if (!segment) throw Error("No field");
      // The field's hairline is on its left; the value is drawn between the steppers.
      const drawn = widthOf(segment) - 1 - widthOf(tap(less)) - widthOf(tap(more));
      return {
        box: widthOf(segment),
        less: widthOf(tap(less)) + slop(less, "right") + slop(less, "left"),
        value: drawn - slop(less, "right") - slop(more, "left"),
        more: widthOf(tap(more)) + slop(more, "left") + slop(more, "right"),
      };
    };
    const hasSetLabel = () =>
      root.findAll(
        (node) =>
          (node.type === Text && node.props.children === "Set") ||
          String(node.props.accessibilityLabel ?? "").startsWith("Set "),
      ).length > 0;
    return {
      weight: touch("weight"),
      reps: touch("reps"),
      check: widthOf(tap("Log set 2")),
      hasSetLabel,
      unmount: () => act(() => strip?.unmount()),
    };
  };

  // Each field is a row of −, value and + across the strip's full 72 pt height, so a target's
  // width is what decides it. With the set's marker in the line above, reps gets three 44 pt
  // targets wherever the strip has room for them and the weight takes the rest; on the narrowest
  // phone both fields share the strip evenly, and each shares its width evenly between − value +.
  it.each([
    // phone, weight −/value/+, reps −/value/+ (pt to touch)
    [390, [44, 82, 44], [44, 44, 44]],
    [375, [44, 67, 44], [44, 44, 44]],
    [320, [38.7, 38.7, 38.7], [38.7, 38.7, 38.7]],
  ])("keeps every value tappable beside its steppers on a %i pt phone", async (phone, w, r) => {
    const strip = await stripOn(phone);
    for (const [got, want] of [
      [strip.weight, w],
      [strip.reps, r],
    ] as const) {
      expect(got.less).toBeCloseTo(want[0] ?? 0, 1);
      expect(got.value).toBeCloseTo(want[1] ?? 0, 1);
      expect(got.more).toBeCloseTo(want[2] ?? 0, 1);
    }
    // The fields, the check and the borders fill the strip exactly.
    expect(strip.check).toBe(56);
    expect(strip.weight.box + strip.reps.box + 56 + 2).toBeCloseTo(phone - 28, 5);
    // The value keeps a target of its own, never smaller than a stepper's.
    for (const part of [strip.weight, strip.reps])
      expect(part.value).toBeGreaterThanOrEqual(Math.min(44, part.less) - 0.01);
    if (phone >= 375)
      expect(Math.min(strip.weight.value, strip.reps.value)).toBeGreaterThanOrEqual(44);
    await strip.unmount();
  });

  it.each([390, 375, 320])("has no set column on a %i pt phone", async (phone) => {
    const strip = await stripOn(phone);
    expect(strip.hasSetLabel()).toBe(false);
    await strip.unmount();
  });

  it("shows the set's marker in the line above, and opens the set's editor from it", async () => {
    const { sets } = benchWorkout(3);
    logSet(store, sets()[0]?.id ?? "", { weightKg: 60, reps: 8 });
    const ui = await mount();
    const marker = ui.control("Set 2");
    expect(marker.props.accessibilityRole).toBe("button");
    // 44 pt to touch, both ways, around the 20 pt chip.
    const style = Object.assign({}, ...[marker.props.style].flat(2));
    const slop = marker.props.hitSlop;
    expect(style.minWidth + slop.left + slop.right).toBeGreaterThanOrEqual(44);
    expect(style.height + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
    await ui.press("Set 2");
    expect(ui.has("Done with this set")).toBe(true);
    expect(ui.has("Set 2")).toBe(false);
    await ui.pressText("Remove set");
    expect(sets()).toHaveLength(3);
    expect(ui.has("Undo: Set 2 removed")).toBe(true);
  });
});

it("keeps the field being typed above the dock without animating when motion is reduced", async () => {
  benchWorkout(3);
  vi.stubGlobal("requestAnimationFrame", (run: (time: number) => void) => {
    run(0);
    return 1;
  });
  const scrollTo = vi.fn();
  // The viewport ends at 600. The active row extends 52 pt behind the dock.
  const ui = await mount((element) => ({
    scrollTo,
    focus: () => {},
    measureInWindow: (report: (x: number, y: number, w: number, h: number) => void) =>
      element.type === "Scroll" ? report(0, 100, 390, 500) : report(0, 600, 390, 52),
  }));
  await ui.press("reps for set 3");
  expect(scrollTo).toHaveBeenCalledWith({ y: 60, animated: false });
  expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ animated: true }));
});
