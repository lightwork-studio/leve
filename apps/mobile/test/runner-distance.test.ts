/// <reference lib="dom" />
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { act, createElement } from "react";
import { Text, View } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import ActiveWorkoutScreen from "../app/workout/active.tsx";
import { liveData, readSettings } from "../src/data/read.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import { addExercise, addSet, beginWorkout } from "../src/data/workout-actions.ts";

// Drive the screen's controls and SQLite writes. Native views and animations are inert in Node.
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  View: "View",
  Text: "Text",
  TextInput: "Input",
  ScrollView: "Scroll",
  Pressable: "Press",
  Modal: "Modal",
  Platform: { OS: "ios" },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  StyleSheet: { create: (s: object) => s, absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Line: "Line" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "View" },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  withTiming: (n: number) => n,
  withSpring: (n: number) => n,
  Easing: { linear: (n: number) => n },
  ReduceMotion: { Never: "never" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-router", () => ({
  router: {},
  useNavigation: () => ({ addListener: () => () => {} }),
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: "View",
  StillOnOpen: "View",
  useExit: () => undefined,
  useArrivedLater: () => false,
}));
vi.mock("../src/ui/motion.ts", () => ({ layout: {}, sinkOut: {}, spring: {}, easeOut: {} }));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, warning: () => {}, select: () => {}, success: () => {} },
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Icon",
  ChevronIcon: "Icon",
  MoreIcon: "Icon",
  PlusIcon: "Icon",
  DeleteIcon: "Icon",
  EditIcon: "Icon",
  ForwardIcon: "Icon",
  MinusIcon: "Icon",
  TimerIcon: "Icon",
  NoteIcon: "Icon",
}));
vi.mock("../src/ui/progress.tsx", () => ({ Fill: "Fill" }));
vi.mock("../src/ui/navigation.ts", () => ({ goHome: () => {} }));
vi.mock("../src/ui/exercise-picker.tsx", () => ({ ExercisePicker: "Picker" }));
vi.mock("../src/ui/use-settled.ts", () => ({ useSettled: () => true }));
vi.mock("../src/ui/use-ticker.ts", () => ({ useTicker: () => 0, clock: () => "0:00" }));
vi.mock("../src/ui/count-up.tsx", () => ({ useRolling: (n: number) => n }));
vi.mock("../src/data/rest-timer.ts", () => ({
  useRest: () => null,
  restTimer: { start: () => {} },
}));

let store: DeviceStore;
vi.mock("../src/data/queries.ts", () => ({
  useLive: () => liveData(store),
  usePastWorkouts: () => [],
  useSettings: () => readSettings(store),
}));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store, change: (write: (store: DeviceStore) => void) => write(store) }),
}));

it("logs a fresh run in miles, switches the column to yards and corrects from either completed row", {
  timeout: 60000,
}, async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/runner.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    saveSettings(store, { distanceUnit: "miles", shortDistanceUnit: "yd" });
    const entry = addExercise(
      store,
      beginWorkout(store),
      { id: "run", name: "Run", type: "distance_duration" },
      0,
    );
    addSet(store, entry);
    await act(() => {
      screen = create(createElement(ActiveWorkoutScreen));
    });
    if (!screen) throw new Error("Runner did not open");
    const root = screen.root;
    const control = (label: string) => root.findByProps({ accessibilityLabel: label });
    const press = (label: string) => act(() => control(label).props.onPress());
    /** Opens a field on the number pad and types `value` (a time as its digits). */
    const enter = async (label: string, value: string) => {
      await press(label);
      for (const char of value) {
        if (char === ":") continue;
        await press(char === "." ? "Decimal point" : char);
      }
    };
    /** What a set's field shows. */
    const shown = (label: string) => control(label).findByType(Text).props.children;
    const saved = () => store.list("workout_set", { parentId: entry }).map((s) => s.content);
    await enter("mi for set 1", "3");
    await press("Distance in mi. Switch to yd");
    expect(shown("yd for set 1")).toBe("5279.986877");
    await press("Distance in yd. Switch to mi");
    await press("Log set 1");
    expect(saved()[0]?.completedAt).toBeNull();
    await enter("time for set 1", "25:00");
    await press("Log set 1");
    expect(saved()[0]?.distanceMeters).toBeCloseTo(4828.02, 8);
    expect(shown("mi for set 1")).toBe("3");
    expect(control("mi for set 2")).toBeDefined();
    await press("Distance in mi. Switch to yd");
    await enter("yd for set 2", "100");
    await enter("time for set 2", "0:30");
    await press("Log set 2");
    expect(saved()[1]?.distanceMeters).toBeCloseTo(91.44, 8);
    expect(control("Distance in yd. Switch to mi")).toBeDefined();
    expect(shown("yd for set 2")).toBe("100");
    expect(shown("yd for set 1")).toBe("5279.986877");
    await press("Distance in yd. Switch to mi");
    expect(shown("mi for set 2")).toBe("0.056818");
    // A logged set is corrected in its row, through the same checks.
    const original = saved();
    await enter("mi for set 2", "10000");
    await press("Done typing");
    expect(root.findByProps({ accessibilityRole: "alert" }).props.children).toBe(
      "That distance is out of range.",
    );
    expect(saved()).toEqual(original);
    // Emptied, the field clears the distance; the run stays logged and asks for it again.
    for (let i = 0; i < 5; i++) await press("Delete");
    await press("Done typing");
    expect(saved()).toEqual([
      original[0],
      { ...original[1], distanceMeters: null, completedAt: original[1]?.completedAt },
    ]);
    expect(shown("mi for set 2")).toBe("Add distance");
    const pressText = (value: string) =>
      act(() =>
        root
          .find((node) => node.type === Text && node.props.children === value)
          .parent?.props.onPress(),
      );
    await pressText("Add set");
    await act(() => screen?.update(createElement(ActiveWorkoutScreen)));
    await enter("mi for set 3", "3.");
    await press("Distance in mi. Switch to yd");
    expect(shown("mi for set 3")).toBe("3.");
    await enter("mi for set 3", "3.5");
    await enter("time for set 3", "26:00");
    await press("Log set 3");
    expect(saved()[2]?.distanceMeters).toBeCloseTo(5632.69, 8);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("keeps malformed time feedback on the lower exercise and scrolls back to it on resume", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/resume.db",
    appVersion: "test",
  });
  const workout = beginWorkout(store);
  addExercise(store, workout, { id: "press", name: "Press", type: "weight_reps" }, 0);
  addExercise(store, workout, { id: "plank", name: "Plank", type: "duration" }, 0);
  const scrollTo = vi.fn();
  let screen: ReactTestRenderer | undefined;
  const mount = () =>
    act(() => {
      screen = create(createElement(ActiveWorkoutScreen), {
        createNodeMock: () => ({ scrollTo, focus: () => {} }),
      });
    });
  try {
    await mount();
    if (!screen) throw Error("Missing screen");
    const cards = () =>
      screen?.root.findAll((node) => node.props.onLayout && node.type === View) ?? [];
    const plank = cards()[1];
    if (!plank) throw Error("Missing plank card");
    const expand = () => plank.findByProps({ accessibilityLabel: "Plank" }).props.onPress();
    await act(expand);
    await act(expand);
    // 1 9 9 on the pad reads as 1:99, which isn't a time.
    await act(() => plank.findByProps({ accessibilityLabel: "time for set 1" }).props.onPress());
    for (const key of ["1", "9", "9", "Done typing"])
      await act(() => screen?.root.findByProps({ accessibilityLabel: key }).props.onPress());
    await act(() => plank.findByProps({ accessibilityLabel: "Log set 1" }).props.onPress());
    expect(plank.findByProps({ accessibilityRole: "alert" }).props.children).toContain("time");
    await act(() => screen?.unmount());
    await mount();
    await act(() => {
      for (const [i, card] of cards().entries())
        card.props.onLayout({ nativeEvent: { layout: { y: 20 + 900 * i } } });
    });
    expect(scrollTo).toHaveBeenCalledWith({ y: 920, animated: false });
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});
