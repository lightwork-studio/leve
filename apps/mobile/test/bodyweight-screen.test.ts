/// <reference lib="dom" />
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { Link } from "expo-router";
import { act, createElement, type ReactNode } from "react";
import { Modal, Text } from "react-native";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import ProgressScreen from "../app/(tabs)/progress.tsx";
import BodyweightHistory from "../app/bodyweight.tsx";
import { EXERCISES } from "../src/data/exercises.ts";
import { progressData } from "../src/data/read.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import { addExercise, beginWorkout, finishWorkout, logSet } from "../src/data/workout-actions.ts";
import { BarChart } from "../src/ui/bar-chart.tsx";
import { BodyweightEditor } from "../src/ui/bodyweight-editor.tsx";
import { ChartTabs, Segmented } from "../src/ui/chart-controls.tsx";
import { dayLabel } from "../src/ui/format.ts";
import { Group } from "../src/ui/group.tsx";
import { LineChart } from "../src/ui/line-chart.tsx";
import { MuscleCard } from "../src/ui/muscle-map.tsx";

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: { id: string; at: number; kg: number }[];
    renderItem: (args: { item: { id: string; at: number; kg: number } }) => ReactNode;
    keyExtractor: (item: { id: string; at: number; kg: number }) => string;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) =>
    createElement(
      "List",
      null,
      ListHeaderComponent,
      data.length
        ? data.map((item) =>
            createElement("Row", { key: keyExtractor(item) }, renderItem({ item })),
          )
        : ListEmptyComponent,
    ),
  Modal: "Modal",
  Pressable: "Pressable",
  KeyboardAvoidingView: "Keyboard",
  Platform: { OS: "web" },
  ScrollView: "Scroll",
  View: "View",
  Text: "Text",
  TextInput: "Input",
  StyleSheet: {
    create: (s: object) => s,
    flatten: (s: object[]) => Object.assign({}, ...s.filter(Boolean)),
    absoluteFill: {},
  },
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children }: { children: ReactNode }) => children,
  StillOnOpen: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-native-reanimated", () => ({ default: { View: "Animated", Text: "Text" } }));
// A refused save shakes its field; here it only needs to hold the field.
vi.mock("../src/ui/shake.tsx", () => ({ Shake: "Shake" }));
vi.mock("../src/ui/live/sheet-drag.ts", () => ({
  useSheetDrag: () => ({ handlers: {}, style: {} }),
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/back-link.tsx", () => ({ BackLink: "Back" }));
vi.mock("../src/ui/line-chart.tsx", () => ({ LineChart: "LineChart" }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("../src/ui/icons.tsx", () => ({
  ChevronIcon: "Chevron",
  CloseIcon: "Close",
  PlusIcon: "Plus",
  DumbbellIcon: "Dumbbell",
  RulerIcon: "Ruler",
}));
vi.mock("../src/ui/screen.tsx", () => ({
  TabScreen: "Screen",
  TabTitle: "Title",
  HeaderButton: "HeaderButton",
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/chart-controls.tsx", () => ({
  ChartTabs: "Tabs",
  RangePills: "Pills",
  Segmented: "Segmented",
}));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Path: "Path",
  Polyline: "Line",
  Circle: "Dot",
}));
vi.mock("../src/ui/count-up.tsx", () => ({ useRolling: (n: number) => n }));
vi.mock("../src/ui/use-now.ts", () => ({ useToday: () => Date.parse("2026-11-12T12:00:00Z") }));
vi.mock("../src/ui/bar-chart.tsx", () => ({ BarChart: "Chart" }));
vi.mock("../src/ui/muscle-map.tsx", () => ({ MuscleCard: "MuscleCard" }));
/** A control by its text, or (for an icon tile, such as ⊕) by the label it is given. */
function pressable(root: ReactTestInstance, label: string) {
  const found = root.findAll(
    (n) =>
      (n.type === Text && n.props.children === label) ||
      (n.type === ("HeaderButton" as never) && n.props.label === label),
  )[0];
  if (!found) throw Error(`Missing ${label}`);
  return found;
}

/** Confirms a destructive action in the action sheet it opened. */
async function confirmAction(root: ReactTestInstance, action: string) {
  const sheet = root.find((n) => n.type === Modal && n.props["aria-label"] === action);
  await act(() =>
    sheet.find((n) => n.type === Text && n.props.children === action).parent!.props.onPress(),
  );
}

let store: DeviceStore;
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store, change: (write: (s: DeviceStore) => void) => write(store) }),
}));
vi.mock("../src/data/queries.ts", () => ({ useProgress: () => progressData(store) }));

it("discards a draft and lets the user correct and save a weight in pounds", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/progress.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    saveSettings(store, { weightUnit: "lbs" });
    await act(() => {
      screen = create(createElement(ProgressScreen));
    });
    if (!screen) throw new Error("Progress did not open");
    const root = screen.root;
    const input = () => root.findByProps({ accessibilityLabel: "Today's bodyweight in lbs" });
    const press = (label: string) =>
      act(() => {
        let control = root.find((n) => n.type === Text && n.props.children === label);
        while (!control.props.onPress && control.parent) control = control.parent;
        control.props.onPress();
      });
    const enter = (value: string) => act(() => input().props.onChangeText(value));
    const uploads = () =>
      store.prepareSubmissions("1.0").filter((s) => s.submission.kind === "body_measurement");
    await press("Record bodyweight");
    await enter("160");
    await press("Cancel");
    expect(uploads()).toHaveLength(0);
    await press("Record bodyweight");
    expect(input().props.value).toBe("");
    await enter("abc");
    await press("Save");
    expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
    expect(input().props.value).toBe("abc");
    expect(uploads()).toHaveLength(0);
    await enter("176.4");
    const submit = input().props.onSubmitEditing;
    const save = root.find((n) => n.type === Text && n.props.children === "Save").parent;
    if (!save) throw Error("Missing Save control");
    await act(() => {
      submit();
      save.props.onPress();
    });
    expect(store.list("body_measurement")).toHaveLength(1);
    expect(uploads()).toHaveLength(1);
    await act(() => screen?.update(createElement(ProgressScreen)));
    expect(
      root.findByProps({
        accessibilityLabel: "Bodyweight history. Latest 176.4 lbs, 1 reading.",
      }),
    ).toBeDefined();
    await press("Record bodyweight");
    await enter("174.2");
    await press("Save");
    expect(store.list("body_measurement")).toHaveLength(2);
    // The cell reads the latest, and how far it moved since the first reading charted.
    await act(() => screen?.update(createElement(ProgressScreen)));
    expect(
      root.findByProps({
        accessibilityLabel: "Bodyweight history. Latest 174.2 lbs, ▼ 2.2 · 1 d.",
      }),
    ).toBeDefined();
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("opens History from the Progress training-days comparison", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/frequency.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    for (const [id, day] of [
      ["a", "2026-11-10"],
      ["b", "2026-11-10"],
      ["c", "2026-10-01"],
    ] as const) {
      store.put("workout", id, {
        routineId: null,
        title: id,
        startedAt: day + "T12:00:00.000Z",
        endedAt: day + "T13:00:00.000Z",
      });
    }
    await act(() => {
      screen = create(createElement(ProgressScreen));
    });
    if (!screen) throw new Error("Progress did not open");
    const link = screen.root.findAllByType(Link).find((item) => item.props.href === "/history");
    expect(link).toBeDefined();
    // Expo Router's asChild slot merges styles into the web anchor as an object.
    const cardStyle = link?.findByProps({ accessibilityRole: "link" }).props.style;
    expect({ ...cardStyle }).toMatchObject({
      paddingTop: expect.any(Number),
      gap: expect.any(Number),
    });
    // Trained days, then the 28 days before, in the cell.
    const cellText = link
      ?.findAllByType(Text)
      .filter((node) => node.children.every((child) => typeof child === "string"))
      .map((node) => node.children.join(""));
    expect(cellText).toEqual(["Trained", "1", " days", "1 before"]);
    expect(Object.keys(cardStyle).some((key) => /^\d+$/.test(key))).toBe(false);
    expect(link?.findByProps({ accessibilityRole: "link" }).props.accessibilityLabel).toBe(
      "Workout history. Training days: 1 in the last 28 days, 1 in the previous 28 days.",
    );
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("leaves out Records and Main lifts in a fresh app with nothing logged", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/fresh.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(ProgressScreen));
    });
    if (!screen) throw Error("Missing Progress screen");
    const labels = screen.root.findAllByType(Group).map((g) => g.props.label);
    expect(labels).toContain("More");
    expect(labels).not.toContain("Records");
    expect(labels).not.toContain("Main lifts");
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("follows the bar the lifter scrubs to, resets it with the range, and lists main lifts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/ranges.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [day, exercise] of [
      ["2026-03-05", EXERCISES.pushdown],
      ["2026-11-10", EXERCISES.bench],
      ["2026-11-11", EXERCISES.bench],
    ] as const) {
      vi.setSystemTime(new Date(day + "T12:00:00.000Z"));
      const id = beginWorkout(store);
      const entry = addExercise(store, id, exercise, 0);
      const set = store.list("workout_set", { parentId: entry })[0];
      if (!set) throw Error("Missing set");
      logSet(store, set.id, { reps: 8, weightKg: 22 });
      finishWorkout(store, id, { countForRoutine: false });
    }
    await act(() => {
      screen = create(createElement(ProgressScreen));
    });
    if (!screen) throw Error("Missing Progress screen");
    const root = screen.root;
    const chart = () => root.findByType(BarChart).props;
    const tabs = root.findByType(ChartTabs);
    expect(tabs.props.options).toContainEqual({ value: "sets", label: "Sets" });
    await act(() => tabs.props.onChange("sets"));
    expect(chart().bars.at(-1).value).toBe(2);
    expect(chart().selected).toBe(chart().bars.length - 1);
    expect(chart().accessibilityLabel).toContain("This week: 2 sets.");
    expect(root.findAllByProps({ accessibilityLabel: "2 sets this week" }).length).toBeGreaterThan(
      0,
    );
    // A year back, the March week's bar drives the readout once the lifter scrubs to it.
    const range = () => root.findAllByType(Segmented).find((s) => s.props.label === "Chart range");
    await act(() => range()?.props.onChange("1Y"));
    const march = chart().bars.findIndex((bar: { value: number }) => bar.value === 1);
    expect(march).toBeGreaterThan(0);
    await act(() => chart().onSelect(march));
    expect(chart().selected).toBe(march);
    expect(
      root.findAll((n) => /^1 set in /.test(n.props.accessibilityLabel ?? "")).length,
    ).toBeGreaterThan(0);
    expect(chart().describe(march)).toMatch(/: 1 set$/);
    await act(() => range()?.props.onChange("3M"));
    expect(chart().selected).toBe(chart().bars.length - 1);
    // The muscle card gets the whole history and today, and measures its own period.
    const card = root.findByType(MuscleCard).props;
    expect(card.exercises.map((e: { name: string }) => e.name)).toEqual([
      "Bench Press",
      "Triceps Pushdown",
    ]);
    expect(card.today).toBe(Date.parse("2026-11-12T12:00:00Z"));
    const links = root.findAllByType(Link).map((link) => link.props.href);
    expect(links).toContainEqual({
      pathname: "/exercise/[id]",
      params: { id: EXERCISES.bench.id },
    });
    expect(links).toContain("/exercises");
    expect(root.findAllByType(Group).map((g) => g.props.label)).toContain("Main lifts");
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("records a new weight from history in the unit chosen when the editor opened", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/history-add",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(ProgressScreen));
    });
    if (!screen) throw Error("Missing Progress");
    const link = screen.root.findAllByType(Link).find((item) => item.props.href === "/bodyweight");
    expect(link).toBeDefined();
    await act(() => screen?.update(createElement(BodyweightHistory)));
    const root = screen.root;
    const press = (label: string) =>
      act(() => {
        let node = pressable(root, label);
        while (!node.props.onPress && node.parent) node = node.parent;
        node.props.onPress();
      });
    const input = (unit: string) =>
      root.findByProps({ accessibilityLabel: `Today's bodyweight in ${unit}` });
    await press("Record bodyweight");
    await act(() => input("kg").props.onChangeText("77.5"));
    await press("Cancel");
    expect(store.list("body_measurement")).toHaveLength(0);
    await press("Record bodyweight");
    expect(input("kg").props.value).toBe("");
    await act(() => input("kg").props.onChangeText("70"));
    await press("Save");
    const first = store.list("body_measurement")[0];
    expect(first?.content?.bodyweightKg).toBe(70);

    saveSettings(store, { weightUnit: "lbs" });
    await act(() => screen?.update(createElement(BodyweightHistory)));
    await press("Record bodyweight");
    await act(() => input("lbs").props.onChangeText("160"));
    saveSettings(store, { weightUnit: "kg" });
    await act(() => screen?.update(createElement(BodyweightHistory)));
    expect(input("lbs").props.value).toBe("160");
    await press("Save");
    await act(() => screen?.update(createElement(BodyweightHistory)));
    const rows = store.list("body_measurement");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first?.id)?.content).toEqual(first?.content);
    const second = rows.find((r) => r.id !== first?.id);
    expect(second?.content?.bodyweightKg).toBeCloseTo(72.5748, 3);
    expect(store.prepareSubmissions("1.0").map((s) => s.submission)).toContainEqual(
      expect.objectContaining({
        kind: "body_measurement",
        id: second?.id,
        op: "put",
      }),
    );
    expect(root.findAllByType(Text).map((n) => [n.props.children].flat().join(""))).toContain(
      "72.6 kg",
    );
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("saves the real second occurrence of a half-hour change on a device reporting an inaccurate Date offset", async () => {
  vi.stubEnv("TZ", "Australia/Lord_Howe");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
  const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-600);
  const onSave = vi.fn();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(
        createElement(BodyweightEditor, {
          label: "Weight",
          unit: "kg",
          onSave,
          onCancel: () => {},
        }),
      );
    });
    if (!screen) throw Error("Missing measurement editor");
    const root = screen.root;
    const enter = (label: string, value: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(value));
    const pressText = (text: string) =>
      act(() => root.findByProps({ children: text }).parent?.props.onPress());
    await enter("Weight in kg", "72");
    await pressText("Earlier measurement");
    await enter("Measurement date", "2026-04-05");
    await enter("Local measurement time", "01:45");
    await act(() =>
      root.findByProps({ accessibilityLabel: "Second time (UTC+10:30)" }).props.onPress(),
    );
    await pressText("Save");
    expect(onSave).toHaveBeenCalledExactlyOnceWith("72", new Date("2026-04-04T15:15:00Z"));
  } finally {
    await act(() => screen?.unmount());
    offset.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it.each([
  ["Progress", ProgressScreen, "First time (UTC+02:00)", "2026-10-25T00:30:00Z"],
  ["History", BodyweightHistory, "Second time (UTC+01:00)", "2026-10-25T01:30:00Z"],
] as const)(
  "records an earlier local reading from %s and preserves the latest measurement",
  async (_name, Screen, clockChoice, expectedUtc) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("TZ", "Europe/Berlin");
    const world = new World();
    let screen: ReactTestRenderer | undefined;
    try {
      const server = world.server();
      const account = { account: "alice", server: "s", transport: server.transport("alice") };
      const phone = await world.phone("entry", account);
      const second = await world.phone("second", account);
      await phone.sync();
      store = phone.store;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, 21, 12, 15, 43));
      store.put("body_measurement", "today", {
        takenAt: new Date().toISOString(),
        bodyweightKg: 71,
        fatPercent: null,
      });
      await act(() => {
        screen = create(createElement(Screen));
      });
      if (!screen) throw Error("Missing measurement screen");
      const root = screen.root;
      const press = (label: string) =>
        act(() => {
          let button = pressable(root, label);
          while (!button.props.onPress && button.parent) button = button.parent;
          button.props.onPress();
        });
      const enter = (label: string, value: string) =>
        act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(value));
      await press("Record bodyweight");
      await enter("Today's bodyweight in kg", "70.5");
      await press("Earlier measurement");
      await enter("Measurement date", "2026-02-30");
      await enter("Local measurement time", "08:25");
      await press("Save");
      expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
      expect(store.list("body_measurement")).toHaveLength(1);
      await enter("Measurement date", "2026-11-22");
      await press("Save");
      expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
      expect(store.list("body_measurement")).toHaveLength(1);
      await enter("Measurement date", "2026-11-19");
      await press("Save");
      const measuredAt = new Date("2026-11-19T07:25:00.000Z");
      const measurements = progressData(store);
      expect(measurements.latestBodyweightKg).toBe(71);
      expect(measurements.measurements[0]).toMatchObject({ kg: 70.5, at: measuredAt.getTime() });
      expect(store.prepareSubmissions("1.0").map((r) => r.submission)).toContainEqual(
        expect.objectContaining({
          kind: "body_measurement",
          content: { takenAt: measuredAt.toISOString(), bodyweightKg: 70.5, fatPercent: null },
        }),
      );
      await press("Record bodyweight");
      await press("Earlier measurement");
      await enter("Measurement date", "2026-11-18");
      await press("Use current time");
      vi.setSystemTime(new Date(2026, 10, 21, 12, 37, 21));
      await enter("Today's bodyweight in kg", "71.5");
      await press("Save");
      expect(progressData(store).measurements.at(-1)).toMatchObject({ kg: 71.5, at: Date.now() });
      await press("Record bodyweight");
      await enter("Today's bodyweight in kg", "70.4");
      await press("Earlier measurement");
      await enter("Measurement date", "2026-03-29");
      await enter("Local measurement time", "02:30");
      await press("Save");
      expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
      expect(store.list("body_measurement")).toHaveLength(3);
      await enter("Measurement date", "2026-10-25");
      await press("Save");
      expect(store.list("body_measurement")).toHaveLength(3);
      await press(clockChoice);
      await press("Save");
      await phone.restart();
      await phone.sync();
      await second.sync();
      const copied = progressData(second.store).measurements;
      expect(copied.map(({ kg }) => kg)).toEqual([70.4, 70.5, 71, 71.5]);
      expect(copied[0]?.at).toBe(Date.parse(expectedUtc));
      expect(copied[1]?.at).toBe(measuredAt.getTime());
      expect(await server.rows("bob")).toEqual([]);
    } finally {
      await act(() => screen?.unmount());
      vi.useRealTimers();
      await world.dispose();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  },
);

it("shows all saved bodyweights newest first and charts the latest thirty readings in the preferred unit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/history.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw new Error("Missing weight history");
    const root = screen.root;
    expect(root.findByProps({ children: "No bodyweight recorded yet." })).toBeDefined();
    const start = Date.UTC(2026, 9, 1, 12);
    const day = 86_400_000;
    for (let i = 31; i >= 0; i--) {
      store.put("body_measurement", "day-" + i, {
        takenAt: new Date(start + i * day).toISOString(),
        bodyweightKg: 80 + i,
        fatPercent: null,
      });
    }
    store.put("body_measurement", "fat-only", {
      takenAt: new Date(start + 32 * day).toISOString(),
      bodyweightKg: null,
      fatPercent: 20,
    });
    store.put("body_measurement", "without-weight", {
      takenAt: new Date(start + 33 * day).toISOString(),
      fatPercent: 22,
    });
    store.delete("body_measurement", "day-4");
    await act(() => screen?.update(createElement(BodyweightHistory)));
    const values = () =>
      root
        .findAllByType(Text)
        .map((n) => [n.props.children].flat().join(""))
        .filter((s) => /^\d.* (kg|lbs)$/.test(s));
    expect(values()).toHaveLength(31);
    expect(values()[0]).toBe("111 kg");
    expect(values().at(-1)).toBe("80 kg");
    expect(values()).not.toContain("84 kg");
    const chart = () => root.findByType(LineChart).props;
    expect(chart().points).toHaveLength(30);
    expect(chart().points[0]).toMatchObject({ time: start + day, value: 81, x: 0 });
    expect(chart().points.at(-1)).toMatchObject({ time: start + 31 * day, value: 111, x: 1 });
    saveSettings(store, { weightUnit: "lbs" });
    await act(() => screen?.update(createElement(BodyweightHistory)));
    expect(values()[0]).toBe("244.7 lbs");
    expect(chart().points.at(-1).value).toBeCloseTo(244.71, 1);
    await act(() => screen?.update(createElement(ProgressScreen)));
    expect(screen.root.findAllByType(Link).some((link) => link.props.href === "/bodyweight")).toBe(
      true,
    );
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("distinguishes close weights on the chart and shows the time of each reading on the same date", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/same-day",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    const morning = new Date(2026, 7, 6, 8, 15);
    const evening = new Date(2026, 7, 6, 18, 30);
    for (const [id, time, kg] of [
      ["morning", morning, 80],
      ["evening", evening, 80.01],
    ] as const)
      store.put("body_measurement", id, { takenAt: time.toISOString(), bodyweightKg: kg });
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing weight history");
    const { axis, tickLabel } = screen.root.findByType(LineChart).props;
    const labels = [0, 1, 2].map((i) => tickLabel(axis.low + axis.step * i));
    expect(new Set(labels).size).toBe(3);
    const readings = screen.root.findAll((n) => String(n.type) === "Row");
    expect(readings).toHaveLength(2);
    for (const [i, time] of [evening, morning].entries()) {
      const row = readings[i];
      if (!row) throw Error("Missing reading");
      expect(
        row.findByProps({
          children: time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
        }),
      ).toBeDefined();
      expect(row.findByProps({ children: dayLabel(time.toISOString()) })).toBeDefined();
    }
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("corrects one historical reading in pounds, retaining its time and other measurements", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const engine = createSqlJsEngine(await initSqlJs());
  const open = () => openDeviceStore({ engine, path: "/correct-weight", appVersion: "test" });
  store = await open();
  let screen: ReactTestRenderer | undefined;
  try {
    saveSettings(store, { weightUnit: "lbs" });
    const takenAt = "2026-09-03T10:30:00.000Z";
    const earlier = { takenAt, bodyweightKg: 77.12345, fatPercent: 16 };
    const later = { ...earlier, takenAt: "2026-09-04T10:30:00.000Z", bodyweightKg: 75 };
    store.put("body_measurement", "earlier", earlier);
    store.put("body_measurement", "later", later);
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing history");
    const root = screen.root;
    const edit = () =>
      act(() =>
        root
          .findAll(
            (n) =>
              n.props.accessibilityRole === "button" &&
              String(n.props.accessibilityLabel).startsWith("Edit bodyweight for "),
          )
          .at(-1)
          ?.props.onPress(),
      );
    const enter = (text: string) =>
      act(() =>
        root
          .findByProps({ accessibilityLabel: "Recorded bodyweight in lbs" })
          .props.onChangeText(text),
      );
    const press = (label: string) =>
      act(() =>
        root.find((n) => n.type === Text && n.props.children === label).parent?.props.onPress(),
      );
    await edit();
    await press("Save");
    expect(store.get("body_measurement", "earlier")?.content).toEqual(earlier);
    await edit();
    await enter("100");
    await press("Cancel");
    expect(store.get("body_measurement", "earlier")?.content).toEqual(earlier);
    await edit();
    await enter("invalid");
    await press("Save");
    expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
    // The other field can change while the user is entering a correction.
    store.put("body_measurement", "earlier", { ...earlier, fatPercent: 18 });
    await enter("160");
    await press("Save");
    await act(() => screen?.unmount());
    screen = undefined;
    store.close();
    store = await open();
    expect(store.list("body_measurement")).toHaveLength(2);
    expect(store.get("body_measurement", "later")?.content).toEqual(later);
    expect(store.get("body_measurement", "earlier")?.content).toEqual({
      takenAt,
      fatPercent: 18,
      bodyweightKg: expect.closeTo(72.5748, 3),
    });
    expect(
      store.prepareSubmissions("1.0").find((s) => s.submission.id === "earlier")?.submission,
    ).toMatchObject({
      kind: "body_measurement",
      op: "put",
      content: { takenAt, fatPercent: 18, bodyweightKg: expect.closeTo(72.5748, 3) },
    });
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("keeps a precise reading when untouched and saves the rounded value when explicitly entered", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/precise-weight",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    const measurement = {
      takenAt: "2026-09-03T10:30:00.000Z",
      bodyweightKg: 72.04,
      fatPercent: null,
    };
    store.put("body_measurement", "reading", measurement);
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing history");
    const root = screen.root;
    const edit = () =>
      act(() =>
        root
          .find(
            (n) =>
              n.props.accessibilityRole === "button" &&
              String(n.props.accessibilityLabel).startsWith("Edit bodyweight for "),
          )
          .props.onPress(),
      );
    const save = () =>
      act(() =>
        root.find((n) => n.type === Text && n.props.children === "Save").parent?.props.onPress(),
      );
    await edit();
    await save();
    expect(store.get("body_measurement", "reading")?.content).toEqual(measurement);
    await edit();
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Recorded bodyweight in kg" })
        .props.onChangeText("72"),
    );
    await save();
    expect(store.get("body_measurement", "reading")?.content).toEqual({
      ...measurement,
      bodyweightKg: 72,
    });
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("distinguishes equally weighted readings in the same repeated local minute", async () => {
  vi.stubEnv("TZ", "Australia/Lord_Howe");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/overlap.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    for (const [id, takenAt] of [
      ["first", "2026-04-04T14:45:00.000Z"],
      ["second", "2026-04-04T15:15:00.000Z"],
    ] as const) {
      store.put("body_measurement", id, { takenAt, bodyweightKg: 72, fatPercent: null });
    }
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing measurement history");
    const rows = screen.root.findAll((node) =>
      node.props.accessibilityLabel?.startsWith("Edit bodyweight for"),
    );
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      expect.stringContaining("UTC+10:30"),
      expect.stringContaining("UTC+11:00"),
    ]);
    await act(() => rows[0]?.props.onPress());
    const editor = screen.root.findByType(Modal);
    expect(
      editor.findAll(
        (node) => node.type === Text && String(node.props.children).includes("UTC+10:30"),
      ),
    ).toHaveLength(1);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

it("compares competing measurement corrections and accepts the server reading in the editor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  try {
    const server = world.server();
    const account = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    store = a.store;
    const initial = { takenAt: "2026-11-12T07:00:00.000Z", bodyweightKg: 70, fatPercent: 18 };
    store.put("body_measurement", "first", initial);
    await a.sync();
    await b.sync();
    store.put("body_measurement", "first", { ...initial, bodyweightKg: 69 });
    b.store.put("body_measurement", "first", { ...initial, bodyweightKg: 71, fatPercent: null });
    await b.sync();
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing history");
    const root = screen.root;
    await act(() =>
      root
        .find((n) => n.props.accessibilityLabel?.startsWith("Edit bodyweight for"))
        .props.onPress(),
    );
    const input = () => root.findByProps({ accessibilityLabel: "Recorded bodyweight in kg" });
    await act(() => input().props.onChangeText("68"));
    await a.sync();
    await act(() => screen?.update(createElement(BodyweightHistory)));
    expect(input().props.value).toBe("68");
    await act(() =>
      root
        .findByType(Modal)
        .find((n) => n.type === Text && n.props.children === "Discard draft and review versions")
        .parent!.props.onPress(),
    );
    expect(input().props.value).toBe("68");
    await confirmAction(root, "Discard draft");
    const modal = root.findByType(Modal);
    const text = modal.findAllByType(Text).map((n) => n.children.join(""));
    expect(text).toEqual(
      expect.arrayContaining([
        "Bodyweight (kg)",
        "This device · 69",
        "Server · 71",
        "Body fat (%)",
        "Server · None",
      ]),
    );
    await act(() =>
      modal
        .find((n) => n.type === Text && n.props.children === "Use server version")
        .parent!.props.onPress(),
    );
    expect(root.findAllByType(Modal)).toHaveLength(0);
    await a.restart();
    store = a.store;
    expect(store.get("body_measurement", "first")).toMatchObject({
      status: "synced",
      content: { ...initial, bodyweightKg: 71, fatPercent: null },
    });
    expect(store.hasUnsyncedWork()).toBe(false);
  } finally {
    await act(() => screen?.unmount());
    await world.dispose();
    vi.unstubAllGlobals();
  }
});

it("deletes a held reading on every phone after confirming, keeps it on Keep and refuses a changed one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  try {
    const server = world.server();
    const account = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    store = a.store;
    const monday = { takenAt: "2026-11-09T07:00:00.000Z", bodyweightKg: 70, fatPercent: null };
    const tuesday = { takenAt: "2026-11-10T07:00:00.000Z", bodyweightKg: 71, fatPercent: null };
    const wednesday = { takenAt: "2026-11-11T07:00:00.000Z", bodyweightKg: 72, fatPercent: null };
    store.put("body_measurement", "monday", monday);
    store.put("body_measurement", "tuesday", tuesday);
    store.put("body_measurement", "wednesday", wednesday);
    await a.sync();
    await b.sync();
    expect(b.store.list("body_measurement")).toHaveLength(3);
    await act(() => {
      screen = create(createElement(BodyweightHistory));
    });
    if (!screen) throw Error("Missing history");
    const root = screen.root;
    const rerender = () => act(() => screen?.update(createElement(BodyweightHistory)));
    const rows = () =>
      root.findAll(
        (n) =>
          n.type === ("Tap" as never) &&
          String(n.props.accessibilityLabel).startsWith("Edit bodyweight for "),
      );
    const row = (day: string) => {
      const found = rows().find((n) =>
        String(n.props.accessibilityLabel).startsWith(`Edit bodyweight for ${day} `),
      );
      if (!found) throw Error(`Missing reading for ${day}`);
      return found;
    };
    const day = (takenAt: string) => dayLabel(takenAt);
    const sheets = () => root.findAllByType(Modal);
    expect(rows()).toHaveLength(3);

    // Holding a reading asks first; keeping it changes nothing.
    await act(() => row(day(tuesday.takenAt)).props.onLongPress());
    const message = sheets()[0]
      ?.findAllByType(Text)
      .map((n) => n.children.join(""))[0];
    expect(message).toMatch(/^The 71 kg reading from .+ will be deleted\.$/);
    await act(() =>
      root
        .find((n) => n.type === Text && n.props.children === "Keep measurement")
        .parent!.props.onPress(),
    );
    expect(sheets()).toHaveLength(0);
    expect(store.list("body_measurement")).toHaveLength(3);

    // Confirming deletes it here and, after sync, on the other phone.
    await act(() => row(day(tuesday.takenAt)).props.onLongPress());
    await confirmAction(root, "Delete measurement");
    await rerender();
    expect(rows()).toHaveLength(2);
    expect(store.get("body_measurement", "tuesday")?.deleted).toBe(true);
    await a.sync();
    await b.sync();
    expect(b.store.get("body_measurement", "tuesday")?.deleted).toBe(true);
    expect(b.store.get("body_measurement", "monday")?.content).toEqual(monday);
    expect(b.store.get("body_measurement", "wednesday")?.content).toEqual(wednesday);

    // Screen readers delete through the row's action.
    await act(() =>
      row(day(monday.takenAt)).props.onAccessibilityAction({
        nativeEvent: { actionName: "delete" },
      }),
    );
    // Another phone corrects the reading while the sheet is open: the deletion is refused.
    b.store.put("body_measurement", "monday", { ...monday, bodyweightKg: 69 });
    await b.sync();
    await a.sync();
    await confirmAction(root, "Delete measurement");
    await rerender();
    expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
    expect(
      root.findAll(
        (n) => n.type === Text && /This measurement changed/.test(String(n.props.children)),
      ),
    ).not.toHaveLength(0);
    expect(store.get("body_measurement", "monday")?.content).toEqual({
      ...monday,
      bodyweightKg: 69,
    });
    expect(rows()).toHaveLength(2);
    await a.restart();
    store = a.store;
    expect(
      store
        .list("body_measurement")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["monday", "wednesday"]);
    expect(store.hasUnsyncedWork()).toBe(false);
  } finally {
    await act(() => screen?.unmount());
    await world.dispose();
    vi.unstubAllGlobals();
  }
});
