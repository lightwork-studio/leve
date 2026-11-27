import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { act, createElement, type ReactElement, type Ref, useImperativeHandle } from "react";
import { FlatList, Modal, Text } from "react-native";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { createCustomExercise, pickerLibrary } from "../src/data/custom-exercises.ts";
import { type BuiltInExercise, findExercises } from "../src/data/exercises.ts";
import { liveData, progressData, readWorkoutTree } from "../src/data/read.ts";
import { addExercise, beginWorkout, logSet } from "../src/data/workout-actions.ts";
import { palettes } from "../src/theme.ts";
import { ExercisePicker } from "../src/ui/exercise-picker.tsx";
import { setColumns } from "../src/ui/set-values.ts";

/** The palette on screen while the system is in dark mode, as these tests set it. */
const dark = palettes.dark;
const scrollTo = vi.fn();

vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  View: "View",
  Image: "Image",
  Text: "Text",
  TextInput: "Input",
  ScrollView: "Scroll",
  Modal: "Modal",
  Pressable: "Pressable",
  KeyboardAvoidingView: "Keyboard",
  Platform: { OS: "web" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  FlatList: ({
    ref,
    data,
    keyExtractor,
    renderItem,
    ListHeaderComponent,
  }: {
    ref?: Ref<{ scrollToOffset: typeof scrollTo }>;
    data: unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (props: { item: unknown }) => ReactElement;
    ListHeaderComponent?: ReactElement;
  }) => {
    useImperativeHandle(ref, () => ({ scrollToOffset: scrollTo }));
    return [
      ListHeaderComponent,
      ...data
        .slice(0, 15)
        .map((item) => createElement("Row", { key: keyExtractor(item) }, renderItem({ item }))),
    ];
  },
  StyleSheet: { create: (s: object) => s, absoluteFill: {} },
}));
vi.mock("react-native-reanimated", () => ({ default: { View: "Animated", Text: "Text" } }));
// A refused save shakes its field; here it only needs to hold the field.
vi.mock("../src/ui/shake.tsx", () => ({ Shake: "Shake" }));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children }: { children: ReactElement }) => children,
}));
vi.mock("../src/ui/live/sheet-drag.ts", () => ({
  useSheetDrag: () => ({ handlers: {}, style: {} }),
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
vi.mock("../src/ui/motion.ts", () => ({ fade: undefined }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/toggle.tsx", () => ({ Toggle: "Toggle" }));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Check",
  ChevronIcon: "Chevron",
  CloseIcon: "Close",
  MinusIcon: "Minus",
  MoreIcon: "More",
  PlusIcon: "Icon",
  SearchIcon: "Search",
}));

/** Presses a control by its text, or (for an icon tile) by the label it is given. */
function pressIn(root: ReactTestInstance, text: string) {
  let node = root.findAll(
    (n) =>
      (n.type === Text && [n.props.children].flat().join("") === text) ||
      (typeof n.type === "string" && n.props.accessibilityLabel === text && n.props.onPress),
  )[0];
  while (node && !node.props.onPress && node.parent) node = node.parent;
  if (!node) throw Error(`Missing ${text}`);
  return act(() => node.props.onPress());
}
let store: DeviceStore;
let version = 0;
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store,
    version,
    change: (write: (db: DeviceStore) => unknown) => {
      const result = write(store);
      version++;
      return result;
    },
  }),
}));

it("creates in the shared picker, logs the selected movement, and keeps its history after archiving and reopening", {
  timeout: 60000,
}, async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const engine = createSqlJsEngine(await initSqlJs());
  const open = () => openDeviceStore({ engine, path: "/custom.db", appVersion: "test" });
  store = await open();
  const workout = beginWorkout(store);
  const pick = vi.fn((exercise: BuiltInExercise) => addExercise(store, workout, exercise, 0));
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(
        createElement(ExercisePicker, { included: [], onPick: pick, onClose: vi.fn() }),
      );
    });
    if (!screen) throw new Error("Picker did not open");
    const root = screen.root;
    const press = (text: string) => pressIn(root, text);
    const enter = (label: string, value: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(value));
    const dialogName = () => root.findByType(Modal).props["aria-label"];
    expect(dialogName()).toBe("Add exercise");
    await enter("Search exercises", "flyes");
    await press("Filter by dumbbell");
    expect(
      root.findByProps({ accessibilityLabel: "Add Dumbbell Flyes, Weight and reps" }),
    ).toBeDefined();
    await press("Filter by machine");
    expect(
      root.findAllByProps({ accessibilityLabel: "Add Dumbbell Flyes, Weight and reps" }),
    ).toHaveLength(0);
    await press("Filter by machine");
    await enter("Search exercises", "");
    await press("Create custom exercise");
    expect(dialogName()).toBe("New exercise");
    await enter("Exercise name", "Cancelled");
    await press("Back");
    expect(store.list("custom_exercise")).toHaveLength(0);
    await press("Create custom exercise");
    await enter("Exercise name", "    ");
    await press("Create exercise");
    expect(root.findByProps({ accessibilityRole: "alert" })).toBeDefined();
    expect(store.list("custom_exercise")).toHaveLength(0);
    await enter("Exercise name", "  Sled circuit  ");
    await press("Exercise type");
    await press("Weight and distance");
    await press("Equipment");
    await press("Plate");
    await press("Primary muscle");
    await press("Quadriceps");
    await press("Calves");
    const submit = root.find((n) => n.type === Text && n.props.children === "Create exercise")
      .parent?.props.onPress;
    expect(submit).toBeTypeOf("function");
    await act(() => {
      submit();
      submit();
    });
    expect(store.list("custom_exercise")).toHaveLength(1);
    const created = store.list("custom_exercise")[0];
    if (!created?.content) throw new Error("missing exercise");
    expect(created.content).toEqual({
      name: "Sled circuit",
      type: "weight_distance",
      equipment: "plate",
      primaryMuscle: "quadriceps",
      secondaryMuscles: ["calves"],
      usesBodyweight: false,
      archived: false,
    });
    await press("Create custom exercise");
    await press("Exercise type");
    await press("Bodyweight reps");
    expect(
      root.findByProps({ accessibilityLabel: "Count full bodyweight in volume" }).props
        .accessibilityState.checked,
    ).toBe(false);
    await press("Count full bodyweight in volume");
    expect(
      root.findByProps({ accessibilityLabel: "Count full bodyweight in volume" }).props
        .accessibilityState.checked,
    ).toBe(true);
    await press("Equipment");
    await press("Plate");
    await press("Primary muscle");
    await press("Quadriceps");
    await press("Calves");
    await press("Create exercise");
    const other = store.list("custom_exercise").find((e) => e.id !== created.id);
    if (!other) throw new Error("missing second exercise");
    expect(other.content).toMatchObject({
      name: "Sled circuit",
      type: "bodyweight_reps",
      usesBodyweight: true,
    });
    await act(() =>
      screen?.update(
        createElement(ExercisePicker, { included: [other.id], onPick: pick, onClose: vi.fn() }),
      ),
    );
    await enter("Search exercises", "CALVES plate");
    const chip = (label: string) =>
      root
        .findAll((n) => n.props.accessibilityRole === "radio")
        .find((n) => n.findAllByType(Text)[0]?.props.children === label);
    // The filter's own figure, not a row's small one.
    const filterFigure = () =>
      root.find(
        (n) =>
          typeof n.type === "string" &&
          typeof n.props.accessibilityLabel === "string" &&
          n.props.accessibilityLabel.startsWith("Filter by muscle group,"),
      );
    const filter = async (label: string, byFigure = false) => {
      if (byFigure) {
        // The chest, tapped on the front of the 168-point figure.
        const scale = 1276 / 168;
        await act(() =>
          filterFigure()
            .findByProps({ testID: "muscle-figure-front" })
            .props.onResponderRelease({
              nativeEvent: { locationX: (256 - 40) / scale, locationY: (366 - 86) / scale },
            }),
        );
      } else await act(() => chip(label)?.props.onPress());
      expect(chip(label)?.props.accessibilityState.checked).toBe(true);
      const chestFill = () =>
        filterFigure().findByProps({ testID: "muscle-front-chest" }).props.fill;
      expect(chestFill()).toBe(label === "Chest" ? dark.fg : dark.muscle.ramp[0]);
      expect(dialogName()).toBe("Add exercise");
    };
    await act(() =>
      root.findByProps({ accessibilityLabel: "Muscle filter, All muscles" }).props.onPress(),
    );
    await filter("Chest", true);
    const sledRows = () =>
      root.findAll(
        (n) =>
          typeof n.props.accessibilityLabel === "string" &&
          n.props.accessibilityLabel.startsWith("Add Sled circuit, Weight and distance"),
      );
    expect(sledRows()).toHaveLength(0);
    await act(() =>
      root.findByProps({ accessibilityLabel: "Clear exercise search" }).props.onPress(),
    );
    expect(root.findByProps({ accessibilityLabel: "Search exercises" }).props.value).toBe("");
    expect(sledRows()).toHaveLength(0);
    await enter("Search exercises", "CALVES plate");
    const visibleRowText = (label: string) =>
      root
        .findByProps({ accessibilityLabel: label })
        .findAllByType(Text)
        .map((n) => n.children.join(""));
    await act(() =>
      root.findByProps({ accessibilityLabel: "Muscle filter, Chest" }).props.onPress(),
    );
    await filter("Quadriceps");
    const cable = () => root.findByProps({ accessibilityLabel: "Filter by cable" }).props.onPress();
    await act(cable);
    expect(sledRows()).toHaveLength(0);
    await act(cable);
    expect(visibleRowText("Add Sled circuit, Weight and distance, Quadriceps (primary)")).toContain(
      "Weight and distance · Quadriceps (primary) · Plate",
    );
    await filter("Calves");
    expect(visibleRowText("Add Sled circuit again, Bodyweight reps, Calves (secondary)")).toContain(
      "Already added · Bodyweight reps · Calves (secondary) · Plate",
    );
    // Clear goes back to every muscle: no chip stays chosen.
    await act(() =>
      root.findByProps({ accessibilityLabel: "Clear muscle filter" }).props.onPress(),
    );
    expect(
      root
        .findAll((n) => n.props.accessibilityRole === "radio")
        .filter((n) => n.props.accessibilityState?.checked),
    ).toHaveLength(0);
    expect(visibleRowText("Add Sled circuit, Weight and distance")).toContain(
      "Weight and distance · Quadriceps, Calves · Plate",
    );
    await filter("Calves");
    await act(() =>
      root
        .findByProps({
          accessibilityLabel: "Add Sled circuit, Weight and distance, Calves (secondary)",
        })
        .props.onPress(),
    );
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, type: "weight_distance" }),
    );
    const entry = pick.mock.results[0]?.value;
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw new Error("missing set");
    logSet(store, set.id, { weightKg: 25, distanceMeters: 30 });
    expect(liveData(store)?.muscleSets).toEqual({ quadriceps: 1, calves: 0.5 });
    expect(liveData(store)?.summary.sets).toBe(1);
    store.put("custom_exercise", created.id, { ...created.content, archived: true });
    store.close();
    store = await open();
    expect(progressData(store).equipmentFor(created.id)).toBe("plate");
    expect(progressData(store).equipmentFor("builtin:dumbbell-flyes")).toBe("dumbbell");
    expect(
      findExercises("sled circuit", "quadriceps", pickerLibrary(store)).map((e) => e.id),
    ).toEqual([other.id]);
    const saved = readWorkoutTree(store, workout)?.entries[0];
    expect(saved?.entry.content).toMatchObject({
      exerciseId: created.id,
      exerciseName: "Sled circuit",
      exerciseType: "weight_distance",
    });
    expect(setColumns(saved?.entry.content.exerciseType ?? "", "kg").map((c) => c.heading)).toEqual(
      ["KG", "DIST"],
    );
    expect(saved?.sets[0]?.content).toMatchObject({
      weightKg: 25,
      distanceMeters: 30,
      reps: null,
      durationSeconds: null,
    });
    expect(store.prepareSubmissions("1.0").map((item) => item.submission)).toContainEqual(
      expect.objectContaining({ kind: "custom_exercise", id: created.id, op: "put" }),
    );
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it.each([
  [true, 800],
  [false, 0],
] as const)(
  "retains the selected bodyweight volume flag (%s) through reopening",
  async (usesBodyweight, expected) => {
    const engine = createSqlJsEngine(await initSqlJs());
    const open = () => openDeviceStore({ engine, path: "/volume.db", appVersion: "test" });
    const db = await open();
    db.put("body_measurement", "measurement", {
      takenAt: "2020-01-01T00:00:00.000Z",
      bodyweightKg: 80,
      fatPercent: null,
    });
    const exercise = createCustomExercise(db, {
      name: "Custom reps",
      type: "bodyweight_reps",
      equipment: "none",
      primaryMuscle: "chest",
      secondaryMuscles: [],
      usesBodyweight,
    });
    const entry = addExercise(db, beginWorkout(db), exercise, 0);
    const [set] = db.list("workout_set", { parentId: entry });
    if (!set) throw new Error("missing set");
    logSet(db, set.id, { reps: 10 });
    db.close();
    const reopened = await open();
    try {
      expect(liveData(reopened)?.summary.volumeKg).toBe(expected);
    } finally {
      reopened.close();
    }
  },
);

it("keeps the last routine slot available after deselecting or archiving a selected exercise", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/routine-limit",
    appVersion: "test",
  });
  const pick = vi.fn();
  let screen: ReactTestRenderer | undefined;
  try {
    const exercise = createCustomExercise(store, {
      name: "00 Loaded carry",
      type: "weight_distance",
      equipment: "none",
      primaryMuscle: "other",
      secondaryMuscles: [],
      usesBodyweight: false,
    });
    await act(() => {
      screen = create(
        createElement(ExercisePicker, {
          included: [],
          selectionLimit: 1,
          onPickMany: pick,
          onClose: vi.fn(),
        }),
      );
    });
    if (!screen) throw new Error("Missing picker");
    const root = screen.root;
    const options = () =>
      root.findAll(
        (node) => node.props.accessibilityRole === "checkbox" && typeof node.type === "string",
      );
    const select = (i: number) => act(() => options()[i]?.props.onPress());
    const add = () =>
      act(() =>
        root
          .find((n) => n.type === Text && n.props.children === "Add 1 exercise")
          .parent?.props.onPress(),
      );
    await select(0);
    await select(1);
    expect(root.findByProps({ accessibilityRole: "alert" }).props.children).toMatch(
      /routine is full/,
    );
    expect(options()[0]?.props.accessibilityState.checked).toBe(true);
    expect(options()[1]?.props.accessibilityState.checked).toBe(false);
    await select(0);
    await select(1);
    await add();
    expect(pick).toHaveBeenCalledTimes(1);
    await select(1);
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Search exercises" })
        .props.onChangeText("00 Loaded carry"),
    );
    await select(0);
    const saved = store.get("custom_exercise", exercise.id);
    store.put("custom_exercise", exercise.id, { ...saved?.content, archived: true });
    await add();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ accessibilityRole: "alert" }).props.children).toMatch(
      /exercise changed/,
    );
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Search exercises" })
        .props.onChangeText("Bench Press"),
    );
    await select(0);
    await add();
    expect(pick).toHaveBeenCalledTimes(2);
    expect(pick.mock.lastCall?.[0].map((item: BuiltInExercise) => item.name)).toEqual([
      "Bench Press",
    ]);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("shows filtered results as soon as the pinned picker search receives focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/picker-focus",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(
        createElement(ExercisePicker, { included: [], onPickMany: vi.fn(), onClose: vi.fn() }),
      );
    });
    if (!screen) throw Error("Missing picker");
    const root = screen.root;
    const searchLabel = { accessibilityLabel: "Search exercises" };
    const field = root.findByProps(searchLabel);
    const figure = () =>
      root.findAllByProps({ accessibilityLabel: "Filter by muscle group, Chest" });
    await pressIn(root, "Chest");
    await pressIn(root, "Filter by dumbbell");
    expect(figure().length).toBeGreaterThan(0);

    scrollTo.mockClear();
    await act(() => field.props.onFocus());
    expect(root.findByType(FlatList).findAllByProps(searchLabel)).toHaveLength(0);
    expect(scrollTo).toHaveBeenCalledWith({ offset: 0, animated: false });
    expect(field.props.value).toBe("");
    expect(figure()).toHaveLength(0);
    expect(
      root.findByProps({
        accessibilityLabel: "Incline Dumbbell Press, Weight and reps, Chest (primary)",
      }),
    ).toBeDefined();
    expect(
      root
        .findByProps({ accessibilityLabel: "Exercise filters" })
        .findAllByProps({ accessibilityRole: "button" })
        .slice(0, 2)
        .map((chip) => [chip.props.accessibilityLabel, chip.props.accessibilityState.selected]),
    ).toEqual([
      ["Muscle filter, Chest", true],
      ["Filter by dumbbell", true],
    ]);

    scrollTo.mockClear();
    await act(() => field.props.onChangeText("flyes"));
    expect(scrollTo).toHaveBeenCalledWith({ offset: 0, animated: false });
    await pressIn(root, "Dumbbell Flyes, Weight and reps, Chest (primary)");
    await pressIn(root, "Clear exercise search");
    expect(field.props.value).toBe("");
    expect(figure()).toHaveLength(0);
    await act(() => field.props.onBlur());
    expect(figure().length).toBeGreaterThan(0);
    await pressIn(root, "Review selection");
    expect(
      root.findByProps({ accessibilityLabel: "Dumbbell Flyes, Weight and reps" }).props
        .accessibilityState.checked,
    ).toBe(true);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("reviews choices across searches, returns to the same filter and adds only the remaining exercises", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/picker-selection",
    appVersion: "test",
  });
  const pick = vi.fn();
  const close = vi.fn();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(
        createElement(ExercisePicker, { included: [], onPickMany: pick, onClose: close }),
      );
    });
    if (!screen) throw Error("Missing picker");
    const root = screen.root;
    const labeled = (label: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onPress());
    const press = (label: string) => pressIn(root, label);
    const search = (text: string) =>
      act(() =>
        root.findByProps({ accessibilityLabel: "Search exercises" }).props.onChangeText(text),
      );
    const choices = () =>
      root
        .findAll((n) => n.props.accessibilityRole === "checkbox" && typeof n.type === "string")
        .map((n) => n.props.accessibilityLabel);
    await search("Plank");
    await labeled("Plank, Time");
    await search("Bench Press");
    await labeled("Muscle filter, All muscles");
    await press("Chest");
    await labeled("Bench Press, Weight and reps, Chest (primary)");
    await press("Review selection");
    expect(root.findByType(Modal).props["aria-label"]).toBe("Selected exercises");
    expect(choices()).toEqual(["Plank, Time", "Bench Press, Weight and reps"]);
    await act(() => root.findByType(Modal).props.onRequestClose());
    expect(close).not.toHaveBeenCalled();
    expect(root.findByProps({ accessibilityLabel: "Search exercises" }).props.value).toBe(
      "Bench Press",
    );
    expect(
      root.findAllByProps({ accessibilityLabel: "Muscle filter, Chest" }).length,
    ).toBeGreaterThan(0);
    await press("Review selection");
    await labeled("Plank, Time");
    expect(choices()).toEqual(["Bench Press, Weight and reps"]);
    pick.mockImplementationOnce(() => {
      throw Error("Could not save the selection");
    });
    await press("Add 1 exercise");
    expect(root.findByProps({ accessibilityRole: "alert" }).props.children).toBe(
      "Could not save the selection",
    );
    await press("Add 1 exercise");
    expect(pick).toHaveBeenCalledTimes(2);
    expect(pick.mock.lastCall?.[0].map((e: BuiltInExercise) => e.name)).toEqual(["Bench Press"]);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});
