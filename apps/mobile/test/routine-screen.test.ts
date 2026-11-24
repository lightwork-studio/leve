/// <reference lib="dom" />
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { router } from "expo-router";
import { act, createElement, type ReactNode } from "react";
import { Platform, ScrollView, Text, TextInput, View } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import RoutineDetails from "../app/routine/[id].tsx";
import NewRoutine from "../app/routine/new.tsx";
import { EXERCISES } from "../src/data/exercises.ts";
import { liveData, workoutDetail } from "../src/data/read.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  finishWorkout,
  logSet,
  setExerciseRest,
} from "../src/data/workout-actions.ts";
import { routineTarget } from "../src/model/live.ts";
import { targetValue } from "../src/model/log-values.ts";
import { haptic } from "../src/ui/haptics.ts";

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  Platform: {
    get OS() {
      return "ios";
    },
  },
  Keyboard: { dismiss: vi.fn() },
  AccessibilityInfo: {
    sendAccessibilityEvent: vi.fn(),
    announceForAccessibilityWithOptions: vi.fn(),
  },
  // A drag's handlers land on the grip as props, to be called with made-up gestures.
  PanResponder: { create: (config: object) => ({ panHandlers: config }) },
  ScrollView: "Scroll",
  Text: "Text",
  TextInput: "Input",
  View: "View",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34 }),
}));
let sourceWorkout: string | undefined;
vi.mock("expo-router", () => {
  const navigation = { isFocused: () => true, addListener: () => () => {} };
  return {
    useLocalSearchParams: () => ({ id: "routine", fromWorkout: sourceWorkout }),
    router: { canGoBack: () => true, back: vi.fn() },
    useNavigation: () => navigation,
  };
});
vi.mock("../src/ui/screen.tsx", () => ({ ScreenHeader: "Header" }));
vi.mock("../src/ui/exercise-picker.tsx", () => ({ ExercisePicker: "Picker" }));
vi.mock("../src/ui/toggle.tsx", () => ({ Toggle: "SwitchIndicator" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
// Menus, sheets and dialogs keep what they would show in the tree, to be read and pressed.
vi.mock("../src/ui/popover-menu.tsx", () => ({ MoreButton: "MoreButton" }));
vi.mock("../src/ui/choice-row.tsx", () => ({ ChoiceRow: "ChoiceRow", MenuRow: "MenuRow" }));
vi.mock("../src/ui/bottom-sheet.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    BottomSheet: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) =>
      h("Sheet", null, children, footer),
  };
});
vi.mock("../src/ui/action-sheet.tsx", async () => {
  const { createElement: h, Fragment, useState } = await import("react");
  return {
    ActionSheet: "ActionSheet",
    // Like the real one, it acts only once its action sheet is confirmed.
    DestructiveButton: function DestructiveButton({
      label,
      action = label,
      onConfirm,
    }: {
      label: string;
      action?: string;
      onConfirm: () => unknown;
    }) {
      const [asking, setAsking] = useState(false);
      return h(
        Fragment,
        null,
        h(
          "Tap",
          { accessibilityRole: "button", onPress: () => setAsking(true) },
          h("Text", null, label),
        ),
        asking &&
          h("ActionSheet", {
            action,
            onConfirm: async () => {
              await onConfirm();
              setAsking(false);
            },
            onClose: () => setAsking(false),
          }),
      );
    },
  };
});
vi.mock("../src/ui/dialog.tsx", () => ({ Dialog: "Dialog", DialogField: "DialogField" }));
vi.mock("../src/ui/notice.tsx", () => ({ Banner: "Banner" }));
vi.mock("../src/ui/live/rest-dialog.tsx", () => ({ RestDialog: "RestDialog" }));
vi.mock("../src/ui/shake.tsx", () => ({ Shake: "Shake" }));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: vi.fn(), select: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Icon",
  ChevronIcon: "Icon",
  GripIcon: "Icon",
  InfoIcon: "Icon",
  LinkIcon: "Icon",
  PlusIcon: "Icon",
  TimerIcon: "Icon",
  WarnIcon: "Icon",
}));
type Root = ReactTestRenderer["root"];
/** Taps the control a text sits in. */
const tapText = (root: Root, label: string) =>
  act(() => {
    let node = root.find((n) => n.type === Text && n.props.children === label);
    while (!node.props.onPress && node.parent) node = node.parent;
    node.props.onPress();
  });
/** Picks an item from an exercise's ⋯ menu. */
const menuItem = (root: Root, exercise: string, item: string) =>
  act(() => {
    const menu = root.find(
      (n) => n.type === ("MoreButton" as never) && n.props.label === `${exercise} options`,
    );
    const found = menu.props.items.find((i: { label: string }) => i.label === item);
    if (!found) throw Error(`Missing ${item} for ${exercise}`);
    found.onPress();
  });
/** The labels in an exercise's ⋯ menu. */
const menuLabels = (root: Root, exercise: string) =>
  root
    .find((n) => n.type === ("MoreButton" as never) && n.props.label === `${exercise} options`)
    .props.items.map((i: { label: string }) => i.label);
/** What the problem on screen says. */
const alertText = (root: Root) =>
  root
    .findAll((n) => n.props.accessibilityRole === "alert", { deep: false })
    .flatMap((alert) => alert.findAllByType(Text).flatMap((text) => text.children))
    .filter((part) => typeof part === "string")
    .join(" ");
/** Opens the routine's notes, which are written in a sheet. */
const openNotes = (root: Root) =>
  act(() =>
    root
      .find((n) => n.props.accessibilityLabel?.startsWith("Notes, ") && n.props.onPress)
      .props.onPress(),
  );
/** Removes an exercise from its menu, confirming in the action sheet. */
const removeExercise = async (root: Root, exercise: string) => {
  await menuItem(root, exercise, "Remove from routine");
  await act(() => root.findByType("ActionSheet" as never).props.onConfirm());
};
/** Reorder mode: the header's tile switches it on and off. */
const toggleReorder = (rendered: ReactTestRenderer) =>
  act(() => rendered.root.findByType("Header" as never).props.action.props.onToggle());
/** Moves an exercise one place as a screen reader's action would, in reorder mode. */
const moveByAction = (root: Root, label: string, actionName: "moveUp" | "moveDown") =>
  act(() =>
    root
      .findByProps({ accessibilityLabel: label })
      .props.onAccessibilityAction({ nativeEvent: { actionName } }),
  );
/** Sets an exercise's rest as its rest dialog would. */
const setRest = async (root: Root, label: string, seconds: number) => {
  await act(() => root.findByProps({ accessibilityLabel: label }).props.onPress());
  await act(() => root.findByType("RestDialog" as never).props.onSet(seconds));
};

let store: DeviceStore;
let version = 0;
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store,
    version,
    change: (write: (db: DeviceStore) => void) => {
      write(store);
      version++;
    },
  }),
}));

it("selects the last folder in the scrollable form and saves the chosen exercise and targets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/form",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    for (let n = 1; n <= 20; n++)
      store.put("routine_folder", `f${n}`, { title: `Folder ${n}`, position: n });
    await act(() => {
      rendered = create(createElement(NewRoutine));
    });
    if (!rendered) throw new Error("Missing routine form");
    const root = rendered.root.findByType(ScrollView);
    const pressText = (value: string) => tapText(root, value);
    // The folder row's menu lists every folder, the last one too.
    const folder = root.find((n) => n.type === ("MenuRow" as never) && n.props.label === "Folder");
    expect(folder.props.value).toBe("Not in a folder");
    const choices = folder.props.menu.items;
    expect(choices).toHaveLength(21);
    await act(() => choices.at(-1).onPress());
    expect(
      root.find((n) => n.type === ("MenuRow" as never) && n.props.label === "Folder").props.value,
    ).toBe("Folder 20");
    await act(() =>
      root.findByProps({ accessibilityLabel: "Routine name" }).props.onChangeText("Friday"),
    );
    // Notes open in a sheet from their row.
    await act(() => root.findByProps({ accessibilityLabel: "Notes, none" }).props.onPress());
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Routine notes" })
        .props.onChangeText("Bring straps.\nUse rack two."),
    );
    expect(root.findAllByProps({ accessibilityLabel: "Notes, Bring straps." })).not.toHaveLength(0);
    await pressText("Add exercise");
    const picker = root.find((n) => typeof n.props.onPickMany === "function");
    expect(picker.props.selectionLimit).toBe(50);
    await act(() => picker.props.onPickMany([EXERCISES.plank, EXERCISES.bench]));
    // Reordering takes over the screen: the vermilion save hides until Done.
    const reorder = () => rendered?.root.findByType("Header" as never).props.action.props;
    await act(() => reorder()?.onToggle());
    expect(rendered.root.findByType("Header" as never).props.title).toBe("Reorder");
    expect(root.findAll((n) => n.type === Text && n.props.children === "Save routine")).toEqual([]);
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Plank, 1 of 2" })
        .props.onAccessibilityAction({ nativeEvent: { actionName: "moveDown" } }),
    );
    expect(root.findAllByProps({ accessibilityLabel: "Plank, 2 of 2" })).toHaveLength(1);
    const grip = root.findByProps({ accessibilityLabel: "Drag to reorder Plank" });
    await act(() => grip.props.onPanResponderStart());
    expect(root.props.scrollEnabled).toBe(false);
    await act(() => reorder()?.onToggle());
    expect(root.props.scrollEnabled).toBe(true);
    await pressText("Add exercise");
    const reopened = root.find((n) => typeof n.props.onPickMany === "function");
    expect(reopened.props.included).toEqual([EXERCISES.bench.id, EXERCISES.plank.id]);
    expect(reopened.props.selectionLimit).toBe(48);
    await act(() => reopened.props.onClose());
    await act(() =>
      root.findByProps({ accessibilityLabel: "Bench Press set 1 REPS" }).props.onChangeText("8"),
    );
    await act(() =>
      root.findByProps({ accessibilityLabel: "Bench Press set 1 type: Working" }).props.onPress(),
    );
    await pressText("Warm-up");
    expect(
      root.findByProps({ accessibilityLabel: "Bench Press set 1 type: Warm-up" }),
    ).toBeDefined();
    await act(() => root.findByProps({ label: "Effort scale" }).props.onChoose("rpe"));
    const rpe = root.findByProps({ accessibilityLabel: "Bench Press set 1 target RPE" });
    expect(rpe.props.value).toBe("");
    expect(root.findAllByProps({ accessibilityLabel: "Plank set 1 target RPE" })).toHaveLength(0);
    await act(() => rpe.props.onChangeText("7,5"));
    const range = () => menuItem(root, "Bench Press", "Rep range");
    expect(menuLabels(root, "Plank")).not.toContain("Rep range");
    await range();
    expect(root.findByProps({ accessibilityLabel: "Bench Press set 1 Min reps" }).props.value).toBe(
      "8",
    );
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Bench Press set 1 Min reps" })
        .props.onChangeText("6"),
    );
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Bench Press set 1 Max reps" })
        .props.onChangeText("10"),
    );
    await range();
    expect(root.findByProps({ accessibilityLabel: "Bench Press set 1 REPS" }).props.value).toBe(
      "8",
    );
    await range();
    expect(root.findByProps({ accessibilityLabel: "Bench Press set 1 Min reps" }).props.value).toBe(
      "6",
    );
    expect(root.findByProps({ accessibilityLabel: "Bench Press set 1 Max reps" }).props.value).toBe(
      "10",
    );
    // A target RPE the scale doesn't have is refused, and nothing is saved.
    await act(() => rpe.props.onChangeText("11"));
    await pressText("Save routine");
    expect(alertText(root)).toMatch(/target RPE/);
    expect(store.list("routine")).toHaveLength(0);
    await act(() => rpe.props.onChangeText("7,5"));
    // The rest chip opens the rest dialog; what it sets is this exercise's rest.
    await setRest(root, "Bench Press rest, Off. Change it", 75);
    expect(
      root.findAllByProps({ accessibilityLabel: "Bench Press rest, 1:15. Change it" }),
    ).toHaveLength(1);
    await menuItem(root, "Bench Press", "Cues");
    await pressText("Add cue");
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Bench Press cue 1" })
        .props.onChangeText("  Lower with control  "),
    );
    await pressText("Save routine");
    expect(store.list("routine").map((r) => r.content)).toMatchObject([
      {
        title: "Friday",
        notes: "Bring straps.\nUse rack two.",
        folderId: "f20",
        exercises: [
          {
            exerciseId: "builtin:barbell-bench-press",
            restSeconds: 75,
            useRepRange: true,
            sets: [{ repRangeMin: 6, repRangeMax: 10, type: "warmup", rpe: 7.5 }],
          },
          { exerciseId: EXERCISES.plank.id, sets: [{ durationSeconds: null }] },
        ],
      },
    ]);
    const routine = store.list("routine")[0];
    if (!routine) throw Error("Missing saved routine");
    const workoutId = beginWorkout(store, routine.id);
    expect(liveData(store)?.initialPlan?.exercises[0]?.sets[0]?.rpe).toBe(7.5);
    const work = store.list("workout_exercise", { parentId: workoutId })[0];
    if (!work) throw Error("Missing workout exercise");
    expect(work.content?.notes).toEqual([
      { id: expect.any(String), createdAt: expect.any(String), text: "Lower with control" },
    ]);
    expect(work.content?.restSeconds).toBe(75);
    expect(store.list("workout_set", { parentId: work.id })[0]?.content?.type).toBe("warmup");
    setExerciseRest(store, workoutId, work.id, "0");
    expect(store.get("workout_exercise", work.id)?.content?.restSeconds).toBe(0);
    expect(store.get("routine", routine.id)?.content?.exercises).toMatchObject([
      { restSeconds: 75 },
      { exerciseId: EXERCISES.plank.id },
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

const target = {
  id: "set",
  type: "drop",
  weightKg: 41.123456,
  reps: 9,
  durationSeconds: null,
  distanceMeters: null,
  count: null,
  rpe: 8.5,
  repRangeMin: 7,
  repRangeMax: 10,
};
const entry = {
  id: "entry",
  exerciseId: "retired-id",
  exerciseName: "Old press",
  exerciseType: "weight_reps",
  notes: [{ id: "cue", text: "Pause", createdAt: "2026-11-01T00:00:00.000Z" }],
  supersetId: 3,
  restSeconds: 77,
  useRepRange: true,
  sets: [target, { ...target, id: "second", weightKg: null }],
};
const routine = {
  title: "Monday",
  folderId: null,
  notes: "Cue",
  position: 6,
  exercises: [entry],
  effortScale: null,
};

it("opens a routine that arrives after its link and keeps edits through later updates", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/late-routine",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine screen");
    const root = rendered.root;
    const field = (label: string) => root.findByProps({ accessibilityLabel: label });
    const refresh = () => act(() => rendered?.update(createElement(RoutineDetails)));
    expect(root.findAllByProps({ accessibilityLabel: "Routine name" })).toHaveLength(0);
    store.put("routine_folder", "strength", { title: "Strength", position: 1 });
    const incoming = { ...routine, folderId: "strength" };
    store.put("routine", "routine", incoming);
    await refresh();
    expect(field("Routine name").props.value).toBe("Monday");
    await openNotes(root);
    expect(field("Routine notes").props.value).toBe("Cue");
    expect(field("Old press set 1 Min reps").props.value).toBe("7");
    const folder = root.find((n) => n.type === ("MenuRow" as never) && n.props.label === "Folder");
    expect(folder.props.value).toBe("Strength");
    expect(
      folder.props.menu.items.map((item: { label: string; checked: boolean }) => [
        item.label,
        item.checked,
      ]),
    ).toEqual([
      ["Not in a folder", false],
      ["Strength", true],
    ]);
    await act(() => field("Routine name").props.onChangeText("Heavy day"));
    store.delete("routine", "routine");
    await refresh();
    expect(root.findAllByProps({ accessibilityLabel: "Routine name" })).toHaveLength(0);
    store.put("routine", "routine", { ...incoming, notes: "Use rack two" });
    await refresh();
    expect(field("Routine name").props.value).toBe("Heavy day");
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content).toEqual({
      ...incoming,
      title: "Heavy day",
      notes: "Use rack two",
    });
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("clears saved routine notes and retains the draft if another edit arrived", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/routine-notes",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    store.put("routine", "routine", routine);
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing editor");
    let root = rendered.root;
    const notes = () => root.findByProps({ accessibilityLabel: "Routine notes" });
    const save = () => tapText(root, "Save routine");
    await openNotes(root);
    expect(notes().props.value).toBe("Cue");
    await act(() => notes().props.onChangeText(""));
    store.put("routine", "routine", { ...routine, notes: "Updated elsewhere" });
    await save();
    expect(alertText(root)).toMatch(/notes changed/i);
    expect(store.get("routine", "routine")?.content?.notes).toBe("Updated elsewhere");
    expect(notes().props.value).toBe("");
    await act(() => rendered?.update(createElement(RoutineDetails, { key: "reopen" })));
    root = rendered.root;
    await openNotes(root);
    expect(notes().props.value).toBe("Updated elsewhere");
    await act(() => notes().props.onChangeText(""));
    store.put("routine", "routine", {
      ...routine,
      title: "Newer title",
      notes: "Updated elsewhere",
    });
    await save();
    expect(store.get("routine", "routine")?.content).toEqual({
      ...routine,
      title: "Newer title",
      notes: "",
    });
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("requires confirmation to clear an incompatible target and preserves the running plan", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/routine-scale",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const initial = {
      ...routine,
      effortScale: "rpe",
      exercises: [
        {
          ...entry,
          sets: [
            { ...target, rpe: 8 },
            { ...target, id: "second", rpe: 8.5 },
          ],
        },
      ],
    };
    store.put("routine", "routine", initial);
    const active = beginWorkout(store, "routine");
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    const root = rendered.root;
    const choosing = () => root.findByProps({ label: "Effort scale" });
    const switchToRir = () => act(() => choosing().props.onChoose("rir"));
    const dialog = () => root.findByType("Dialog" as never);
    await switchToRir();
    expect(choosing().props.value).toBe("rpe");
    await act(() => dialog().props.onClose());
    expect(root.findByProps({ accessibilityLabel: "Old press set 2 target RPE" }).props.value).toBe(
      "8.5",
    );
    await switchToRir();
    await act(() => dialog().props.confirm.onPress());
    expect(root.findByProps({ accessibilityLabel: "Old press set 1 target RIR" }).props.value).toBe(
      "2",
    );
    expect(root.findByProps({ accessibilityLabel: "Old press set 2 target RIR" }).props.value).toBe(
      "",
    );
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content).toMatchObject({
      effortScale: "rir",
      exercises: [
        {
          sets: [
            { rpe: null, repsInReserve: 2 },
            { rpe: null, repsInReserve: null },
          ],
        },
      ],
    });
    expect(liveData(store)?.tree.workout.id).toBe(active);
    expect(liveData(store)?.initialPlan?.effortScale).toBe("rpe");
    expect(liveData(store)?.initialPlan?.exercises[0]?.sets.map((set) => set.rpe)).toEqual([
      8, 8.5,
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("adds the first effort target to a stored set without changing its other targets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/first-effort-target",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const existing = { ...target, rpe: null };
    store.put("routine", "routine", { ...routine, exercises: [{ ...entry, sets: [existing] }] });
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    const root = rendered.root;
    const field = root.findByProps({ accessibilityLabel: "Old press set 1 target RIR" });
    expect(field.props.value).toBe("");
    await act(() => field.props.onChangeText("0"));
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content?.exercises).toEqual([
      { ...entry, sets: [{ ...existing, repsInReserve: 0 }] },
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("edits template cues for the next workout and leaves the current workout's cues intact", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/routine-cues",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const remove = { id: "obsolete", text: "Old cue", createdAt: "2026-11-01T00:00:00.000Z" };
    store.put("routine", "routine", {
      ...routine,
      exercises: [{ ...entry, notes: [...entry.notes, remove] }],
    });
    const workout = beginWorkout(store, "routine");
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    const root = rendered.root;
    const tap = (label: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onPress());
    const type = (label: string, value: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(value));
    const press = (label: string) => tapText(root, label);
    await menuItem(root, "Old press", "Cues");
    await type("Old press cue 1", "Pause for two seconds");
    await tap("Remove Old press cue 2");
    await press("Add cue");
    await press("Save routine");
    expect(alertText(root)).toMatch(/cue/i);
    expect(store.get("routine", "routine")?.content?.exercises).toMatchObject([
      { notes: [...entry.notes, remove] },
    ]);
    await type("Old press cue 2", "Even grip");
    await press("Save routine");
    const first = store.list("workout_exercise", { parentId: workout })[0];
    if (!first) throw Error("Missing running exercise");
    expect(first.content?.notes).toEqual([...entry.notes, remove]);
    const set = store.list("workout_set", { parentId: first.id })[0];
    if (!set) throw Error("Missing workout set");
    logSet(store, set.id, { weightKg: 40, reps: 8 });
    finishWorkout(store, workout, { countForRoutine: false });
    const next = beginWorkout(store, "routine");
    expect(store.list("workout_exercise", { parentId: next })[0]?.content?.notes).toEqual([
      { ...entry.notes[0], text: "Pause for two seconds" },
      { id: expect.any(String), createdAt: expect.any(String), text: "Even grip" },
    ]);
    expect(store.get("workout_exercise", first.id)?.content?.notes).toEqual([
      ...entry.notes,
      remove,
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("keeps separate imported cue rows with the same ID and preserves untouched text", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/imported-cues",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const notes = [
      { id: "a", text: "Remove me" },
      { id: "b", text: "  " },
      { id: "b", text: "Grip" },
      { id: "c", text: "  Breathe  " },
    ].map((note) => ({ ...note, createdAt: "2026-11-01T00:00:00.000Z" }));
    store.put("routine", "routine", { ...routine, exercises: [{ ...entry, notes }] });
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine");
    const root = rendered.root;
    const tap = (label: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onPress());
    await menuItem(root, "Old press", "Cues");
    await tap("Remove Old press cue 1");
    const fields = () =>
      root
        .findAllByType(TextInput)
        .filter((n) => n.props.accessibilityLabel?.startsWith("Old press cue "));
    expect(fields().map((n) => n.props.value)).toEqual(["  ", "Grip", "  Breathe  "]);
    const save = () => tapText(root, "Save routine");
    expect(fields()).toHaveLength(3);
    await act(() =>
      root.findByProps({ accessibilityLabel: "Old press cue 2" }).props.onChangeText("  "),
    );
    await save();
    expect(store.get("routine", "routine")?.content?.exercises).toMatchObject([{ notes }]);
    expect(alertText(root)).toMatch(/cue/i);
    await act(() =>
      root.findByProps({ accessibilityLabel: "Old press cue 2" }).props.onChangeText("Even grip"),
    );
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content?.exercises).toMatchObject([
      { notes: [notes[1], { ...notes[2], text: "Even grip" }, notes[3]] },
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it.each(["empty", "conflict", "saved"])(
  "edits the stored plan through detail: %s",
  async (scenario) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    store = await openDeviceStore({
      engine: createSqlJsEngine(await initSqlJs()),
      path: "/edit-plan",
      appVersion: "test",
    });
    let rendered: ReactTestRenderer | undefined;
    try {
      store.put("routine", "routine", routine);
      await act(() => {
        rendered = create(createElement(RoutineDetails));
      });
      if (!rendered) throw new Error("Missing editor");
      const root = rendered.root;
      const pressText = (label: string) => tapText(root, label);
      await act(() =>
        root.findByProps({ accessibilityLabel: "Routine name" }).props.onChangeText("Monday B"),
      );
      if (scenario === "empty") {
        await removeExercise(root, "Old press");
        await pressText("Save routine");
        expect(alertText(root)).toMatch(/add an exercise/i);
        expect(store.get("routine", "routine")?.content).toEqual(routine);
        return;
      }
      await pressText("Add set");
      await act(() =>
        root
          .findByProps({ accessibilityLabel: "Old press set 3 Max reps" })
          .props.onChangeText("7"),
      );
      await pressText("Save routine");
      expect(alertText(root)).toMatch(/enter minimum reps/i);
      expect(store.get("routine", "routine")?.content).toEqual(routine);
      await act(() =>
        root
          .findByProps({ accessibilityLabel: "Old press set 3 Min reps" })
          .props.onChangeText("5"),
      );
      const weight = root.find(
        (n) =>
          n.props.accessibilityLabel?.match(/^Old press set 2 (KG|LBS)$/) && n.props.onChangeText,
      );
      await act(() => weight.props.onChangeText("0"));
      await pressText("Add exercise");
      await act(() =>
        root
          .find((n) => typeof n.props.onPickMany === "function")
          .props.onPickMany([EXERCISES.plank]),
      );
      await act(() =>
        root
          .findByProps({ accessibilityLabel: "Plank set 1 Time (m:ss)" })
          .props.onChangeText("1:03"),
      );
      await act(() =>
        root
          .findByProps({ accessibilityLabel: entry.exerciseName + " set 1 type: Drop" })
          .props.onPress(),
      );
      await pressText("Failure");
      if (!rendered) throw new Error("Missing editor");
      await toggleReorder(rendered);
      await moveByAction(root, "Plank, 2 of 2", "moveUp");
      await toggleReorder(rendered);
      const latest = {
        ...routine,
        notes: "New cue",
        exercises: scenario === "conflict" ? [{ ...entry, restSeconds: 121 }] : [entry],
      };
      store.put("routine", "routine", latest);
      await pressText("Save routine");
      const result = store.get("routine", "routine")?.content;
      if (scenario === "conflict") {
        expect(alertText(root)).toMatch(/plan changed/i);
        expect(result).toEqual(latest);
      } else {
        expect(result).toEqual({
          ...latest,
          title: "Monday B",
          exercises: [
            expect.objectContaining({
              exerciseId: EXERCISES.plank.id,
              sets: [expect.objectContaining({ durationSeconds: 63 })],
            }),
            {
              ...entry,
              sets: [
                { ...target, type: "failure" },
                { ...target, id: "second", weightKg: 0 },
                expect.objectContaining({ repRangeMin: 5, repRangeMax: 7 }),
              ],
            },
          ],
        });
        const started = beginWorkout(store, "routine");
        const movement = store
          .list("workout_exercise", { parentId: started })
          .find((row) => row.content?.exerciseId === entry.exerciseId);
        if (!movement) throw new Error("Missing exercise from the edited plan");
        expect(
          store.list("workout_set", { parentId: movement.id }).map((row) => row.content?.type),
        ).toEqual(["failure", "drop", "normal"]);
      }
    } finally {
      await act(() => rendered?.unmount());
      store.close();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  {
    edit: "fixed reps",
    useRepRange: false,
    changes: [["REPS", "12"]],
    original: 9,
    updated: 12,
    snapshot: { reps: 12, repRangeMin: 7, repRangeMax: 10 },
  },
  {
    edit: "minimum reps",
    useRepRange: true,
    changes: [["Min reps", "8"]],
    original: 7,
    updated: 8,
    snapshot: { reps: 9, repRangeMin: 8, repRangeMax: 10 },
  },
  {
    edit: "switch to a rep range",
    useRepRange: false,
    changes: [
      ["Rep range", ""],
      ["Min reps", "6"],
      ["Max reps", "12"],
    ],
    original: 9,
    updated: 6,
    snapshot: { reps: 9, repRangeMin: 6, repRangeMax: 12 },
  },
  {
    edit: "switch to fixed reps after an unfinished range edit",
    useRepRange: true,
    changes: [
      ["Min reps", "20"],
      ["Rep range", ""],
      ["REPS", "11"],
    ],
    original: 7,
    updated: 11,
    snapshot: { reps: 11, repRangeMin: 7, repRangeMax: 10 },
  },
  {
    edit: "clear range",
    useRepRange: true,
    changes: [
      ["Max reps", ""],
      ["Min reps", ""],
    ],
    original: 7,
    updated: null,
    snapshot: { reps: 9, repRangeMin: null, repRangeMax: null },
  },
])(
  "saves $edit during A, retains A's targets and logged history, and starts B with the edit",
  async ({ useRepRange, changes, original, updated, snapshot }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const engine = createSqlJsEngine(await initSqlJs());
    const open = () => openDeviceStore({ engine, path: "/running-edit", appVersion: "test" });
    store = await open();
    let rendered: ReactTestRenderer | undefined;
    try {
      store.put("routine", "routine", { ...routine, exercises: [{ ...entry, useRepRange }] });
      const a = beginWorkout(store, "routine");
      await act(() => {
        rendered = create(createElement(RoutineDetails));
      });
      if (!rendered) throw new Error("Missing editor");
      const root = rendered.root;
      for (const [field, value] of changes) {
        if (field === "Rep range") {
          await menuItem(root, "Old press", "Rep range");
          continue;
        }
        await act(() =>
          root
            .findByProps({ accessibilityLabel: `Old press set 1 ${field}` })
            .props.onChangeText(value),
        );
      }
      await tapText(root, "Save routine");
      await act(() => rendered?.unmount());
      rendered = undefined;
      store.close();
      store = await open();
      const live = liveData(store);
      const set = live?.tree.entries[0]?.sets[0];
      if (!live || !set) throw new Error("Missing running set");
      expect(live.tree.workout.id).toBe(a);
      expect(targetValue(routineTarget(live.initialPlan, set.content), "reps")).toBe(original);
      logSet(store, set.id, { reps: 6, weightKg: 40 });
      finishWorkout(store, a, { title: "Session A", description: "", countForRoutine: true });
      const history = workoutDetail(store, a);
      expect(history?.tree.entries[0]?.sets[0]?.content).toMatchObject({ reps: 6, weightKg: 40 });
      expect(history?.tree.workout.content.initialPlan?.exercises[0]?.sets[0]).toMatchObject({
        repRangeMin: 7,
      });
      const b = beginWorkout(store, "routine");
      const next = liveData(store);
      expect(b).not.toBe(a);
      expect(next?.tree.workout.id).toBe(b);
      expect(next?.initialPlan?.exercises[0]?.sets[0]).toMatchObject(snapshot);
      const first = next?.tree.entries[0]?.sets[0];
      if (!next || !first) throw new Error("Missing set in the next workout");
      expect(targetValue(routineTarget(next.initialPlan, first.content), "reps")).toBe(updated);
    } finally {
      await act(() => rendered?.unmount());
      store.close();
      vi.unstubAllGlobals();
    }
  },
);

it("requires valid bounds when an existing fixed-rep set switches to its stored range", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/range-activation",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const source = {
      ...routine,
      exercises: [
        {
          ...entry,
          useRepRange: false,
          sets: [
            { ...target, repRangeMin: 5, repRangeMax: 10 },
            { ...target, id: "dormant", repRangeMin: 12, repRangeMax: 8 },
          ],
        },
      ],
    };
    store.put("routine", "routine", source);
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw new Error("Missing editor");
    const root = rendered.root;
    const save = () => tapText(root, "Save routine");
    await menuItem(root, "Old press", "Rep range");
    await save();
    expect(store.get("routine", "routine")?.content).toEqual(source);
    expect(alertText(root)).toMatch(/Minimum reps/);
    await act(() =>
      root.findByProps({ accessibilityLabel: "Old press set 2 Max reps" }).props.onChangeText("15"),
    );
    await save();
    expect(store.get("routine", "routine")?.content?.exercises).toMatchObject([
      {
        useRepRange: true,
        sets: [
          { repRangeMin: 5, repRangeMax: 10 },
          { repRangeMin: 12, repRangeMax: 15 },
        ],
      },
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("saves a named copy of the edited routine while leaving its original and running workout intact", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const engine = createSqlJsEngine(await initSqlJs());
  const open = () => openDeviceStore({ engine, path: "/routine-copy", appVersion: "test" });
  store = await open();
  let rendered: ReactTestRenderer | undefined;
  try {
    store.put("routine_folder", "strength", { title: "Strength", position: 1 });
    store.put("routine_folder", "travel", { title: "Travel", position: 2 });
    const source = { ...routine, folderId: "strength" };
    store.put("routine", "routine", source);
    const a = beginWorkout(store, "routine");
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw new Error("Missing editor");
    const root = rendered.root;
    const press = (label: string) => tapText(root, label);
    const enter = (label: string, value: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(value));
    await openNotes(root);
    expect(root.findByProps({ accessibilityLabel: "Routine notes" }).props.value).toBe("Cue");
    await enter("Routine notes", "Travel setup");
    const folder = root.find((n) => n.type === ("MenuRow" as never) && n.props.label === "Folder");
    expect(folder.props.value).toBe("Strength");
    await act(() =>
      folder.props.menu.items.find((item: { label: string }) => item.label === "Travel").onPress(),
    );
    await enter("Old press set 1 Min reps", "8");
    const copyDialog = () => root.findByType("Dialog" as never);
    await press("Save as new routine");
    expect(copyDialog().props.eyebrow).toBe("Save as new routine");
    expect(root.findByProps({ accessibilityLabel: "New routine name" }).props.value).toBe(
      "Monday (copy)",
    );
    // ✕ leaves the copy unsaved and the edits as they were.
    await act(() => copyDialog().props.onClose());
    expect(root.findAllByType("Dialog" as never)).toHaveLength(0);
    expect(store.list("routine")).toHaveLength(1);
    expect(root.findByProps({ accessibilityLabel: "Old press set 1 Min reps" }).props.value).toBe(
      "8",
    );
    await press("Save as new routine");
    await enter("New routine name", "  ");
    await act(() => copyDialog().props.confirm.onPress());
    // The refusal shows in the name's helper line, and shakes it.
    const name = () => root.findByProps({ accessibilityLabel: "New routine name" }).props;
    expect(name().error).toMatch(/routine name/);
    expect(name().attempt).toBe(1);
    expect(store.list("routine")).toHaveLength(1);
    await enter("New routine name", "Friday strength");
    expect(name().error).toBe("");
    await act(() => copyDialog().props.confirm.onPress());
    await act(() => rendered?.unmount());
    rendered = undefined;
    store.close();
    store = await open();
    const saved = store.list("routine").find((row) => row.id !== "routine");
    expect(saved?.content).toEqual({
      ...source,
      effortScale: "rpe",
      title: "Friday strength",
      notes: "Travel setup",
      folderId: "travel",
      position: 1,
      exercises: [{ ...entry, sets: [{ ...target, repRangeMin: 8 }, entry.sets[1]] }],
    });
    expect(store.get("routine", "routine")?.content).toEqual(source);
    const live = liveData(store);
    expect(live?.tree.workout.id).toBe(a);
    expect(live?.initialPlan?.exercises[0]?.sets[0]?.repRangeMin).toBe(7);
    expect(store.prepareSubmissions("1.0").some((item) => item.submission.id === saved?.id)).toBe(
      true,
    );
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("marks only paired template exercises and hides the group after its partner is removed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/template-groups",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const second = { ...entry, id: "second-entry", exerciseName: "Second press", supersetId: null };
    const partner = { ...entry, id: "partner", exerciseName: "Partner" };
    store.put("routine", "routine", { ...routine, exercises: [entry, second, partner] });
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing editor");
    const root = rendered.root;
    const headings = () =>
      root
        .findAllByType(Text)
        .filter(
          (node) =>
            node.props.accessibilityRole === "header" || node.props.children === "Superset 1",
        )
        .map((node) => node.props.children);
    // Each exercise's name, then its group's tag.
    expect(headings()).toEqual([
      "Old press",
      "Superset 1",
      "Second press",
      "Partner",
      "Superset 1",
    ]);
    // A grouped exercise offers to leave its superset; the first one can't pair upwards.
    expect(menuLabels(root, "Old press")).toContain("Leave superset");
    expect(menuLabels(root, "Second press")).toContain("Superset with Old press");
    await removeExercise(root, "Partner");
    expect(headings()).toEqual(["Old press", "Second press"]);
    expect(menuLabels(root, "Old press")).not.toContain("Leave superset");
    expect(store.get("routine", "routine")?.content?.exercises).toEqual([entry, second, partner]);
    await menuItem(root, "Second press", "Superset with Old press");
    expect(headings()).toEqual(["Old press", "Superset 1", "Second press", "Superset 1"]);
    await menuItem(root, "Old press", "Leave superset");
    expect(headings()).toEqual(["Old press", "Second press"]);
    await menuItem(root, "Second press", "Superset with Old press");
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content?.exercises).toEqual([
      { ...entry, supersetId: 0 },
      { ...second, supersetId: 0 },
    ]);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("starts an editable new routine from the logged sets of a completed workout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/from-session",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    sourceWorkout = beginWorkout(store);
    const carry = { id: "custom:carry", name: "Farmer carry", type: "weight_distance" as const };
    const entry = addExercise(store, sourceWorkout, carry, 45);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing carry set");
    logSet(store, set.id, { weightKg: 18.125, distanceMeters: 40.345, type: "drop" });
    const bench = addExercise(store, sourceWorkout, EXERCISES.bench, 90);
    const firstPress = store.list("workout_set", { parentId: bench })[0];
    if (!firstPress) throw Error("Missing bench set");
    logSet(store, firstPress.id, { weightKg: 58, reps: 4, rpe: 9 });
    logSet(store, addSet(store, bench), { weightKg: 52, reps: 6, rpe: 7.5 });
    logSet(store, addSet(store, bench), { weightKg: 47, reps: 8, rpe: 8 });
    finishWorkout(store, sourceWorkout, {
      title: "Park session",
      description: "Personal session note",
      countForRoutine: false,
    });
    const original = store.get("workout_set", set.id)?.content;
    if (!original) throw Error("Missing completed carry");
    store.put("workout_set", "unfinished-import", {
      ...original,
      workoutExerciseId: entry,
      position: 9,
      weightKg: 77,
      completedAt: null,
    });
    const before = store.summary();
    const render = () =>
      act(() => {
        rendered = create(createElement(NewRoutine));
      });
    await render();
    if (!rendered) throw Error("Missing routine editor");
    await act(() =>
      rendered?.root
        .findByProps({ accessibilityLabel: "Routine name" })
        .props.onChangeText("Discarded"),
    );
    await act(() => rendered?.root.findByProps({ backLabel: "Workout" }).props.back());
    expect(router.back).toHaveBeenCalled();
    await act(() => rendered?.unmount());
    expect(store.list("routine")).toHaveLength(0);
    expect(store.summary()).toEqual(before);
    await render();
    const root = rendered.root;
    expect(root.findByProps({ accessibilityLabel: "Routine name" }).props.value).toBe(
      "Park session",
    );
    expect(
      root.findAllByProps({ accessibilityLabel: "Farmer carry rest, 0:45. Change it" }),
    ).toHaveLength(1);
    expect(store.list("routine")).toHaveLength(0);
    const rpe = (set: number) =>
      root.findByProps({ accessibilityLabel: `Bench Press set ${set} target RPE` });
    expect(rpe(1).props.value).toBe("9");
    await act(() => rpe(2).props.onChangeText("6.5"));
    await tapText(root, "Save routine");
    expect(alertText(root)).toMatch(/target RPE/);
    expect(store.list("routine")).toHaveLength(0);
    await act(() => rpe(2).props.onChangeText("8.5"));
    await act(() => rpe(3).props.onChangeText(""));
    await act(() =>
      root.findByProps({ accessibilityLabel: "Farmer carry set 1 KG" }).props.onChangeText("22"),
    );
    await act(() =>
      root.findByProps({ accessibilityLabel: "Routine name" }).props.onChangeText("Carry practice"),
    );
    await tapText(root, "Save routine");
    const created = store.list("routine")[0];
    expect(created?.content).toMatchObject({
      title: "Carry practice",
      notes: "",
      exercises: [
        {
          exerciseId: carry.id,
          exerciseName: carry.name,
          restSeconds: 45,
          notes: [],
          sets: [{ type: "drop", weightKg: 22, distanceMeters: 40.345 }],
        },
        {
          exerciseId: EXERCISES.bench.id,
          restSeconds: 90,
          sets: [
            { weightKg: 58, reps: 4, rpe: 9 },
            { weightKg: 52, reps: 6, rpe: 8.5 },
            { weightKg: 47, reps: 8, rpe: null },
          ],
        },
      ],
    });
    expect(store.get("workout_set", set.id)?.content).toEqual(original);
    expect(store.get("workout", sourceWorkout)?.content?.routineId).toBeNull();
    if (!created) throw Error("Missing saved routine");
    expect(store.get("workout_set", firstPress.id)?.content?.rpe).toBe(9);
    const next = beginWorkout(store, created.id);
    const live = liveData(store);
    expect(live?.initialPlan?.exercises[1]?.sets.map((target) => target.rpe)).toEqual([
      9,
      8.5,
      null,
    ]);
    expect(live?.tree.entries[1]?.sets.map(({ content }) => content.rpe)).toEqual([
      null,
      null,
      null,
    ]);
    expect(store.list("workout_exercise", { parentId: next })[0]?.content?.exerciseId).toBe(
      carry.id,
    );
  } finally {
    sourceWorkout = undefined;
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("opens the workout-to-routine draft when its source becomes eligible on the same screen", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/late-source",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    sourceWorkout = beginWorkout(store);
    const exercise = addExercise(store, sourceWorkout, EXERCISES.bench, 60);
    const first = store.list("workout_set", { parentId: exercise })[0];
    if (!first) throw Error("Missing bench set");
    logSet(store, first.id, { weightKg: 45, reps: 8 });
    await act(() => {
      rendered = create(createElement(NewRoutine));
    });
    if (!rendered) throw Error("Missing routine screen");
    const refresh = () => {
      version++;
      return act(() => rendered?.update(createElement(NewRoutine)));
    };
    expect(alertText(rendered.root)).toMatch(/completed workout/i);
    finishWorkout(store, sourceWorkout, {
      title: "Friday strength",
      description: "",
      countForRoutine: false,
    });
    await refresh();
    const root = rendered.root;
    const name = () => root.findByProps({ accessibilityLabel: "Routine name" });
    expect(name().props.value).toBe("Friday strength");
    expect(
      rendered.root.findByProps({ accessibilityLabel: "Bench Press set 1 KG" }).props.value,
    ).toBe("45");
    await act(() => name().props.onChangeText("Next week"));
    const source = store.get("workout_set", first.id)?.content;
    if (!source) throw Error("Missing source set");
    store.put("workout_set", first.id, { ...source, weightKg: 50 });
    await refresh();
    expect(name().props.value).toBe("Next week");
    expect(
      rendered.root.findByProps({ accessibilityLabel: "Bench Press set 1 KG" }).props.value,
    ).toBe("45");
    store.put("workout_set", first.id, { ...source, completedAt: null });
    await refresh();
    expect(name().props.value).toBe("Next week");
    expect(root.findByProps({ accessibilityLabel: "Bench Press set 1 KG" }).props.value).toBe("45");
    expect(store.list("routine")).toHaveLength(0);
  } finally {
    sourceWorkout = undefined;
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("reorders by drag or by action, superset partners together, without changing the running workout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/move-plan",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    // The first two are one superset (the same group), the row is on its own.
    const second = { ...entry, id: "repeat", sets: [{ ...target, id: "heavy", weightKg: 55 }] };
    const third = { ...entry, id: "last", exerciseName: "Row", supersetId: null };
    const original = [entry, second, third];
    store.put("routine", "routine", { ...routine, exercises: original });
    beginWorkout(store, "routine");
    const running = liveData(store)?.initialPlan;
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    const root = rendered.root;
    // Move up and down left the exercise menu; reordering covers them.
    expect(menuLabels(root, "Row")).toEqual([
      "Rep range",
      "Superset with Old press",
      "Reorder exercises",
      "Cues",
      "Remove from routine",
    ]);
    await menuItem(root, "Row", "Reorder exercises");
    expect(rendered.root.findByType("Header" as never).props.title).toBe("Reorder");
    expect(root.findAll((n) => n.type === Text && n.props.children === "Save routine")).toEqual([]);
    const rows = () =>
      root
        .findAll((n) => n.type === View && typeof n.props.onAccessibilityAction === "function")
        .map((n) => n.props.accessibilityLabel);
    const actions = (label: string) =>
      root
        .findByProps({ accessibilityLabel: label })
        .props.accessibilityActions.map((a: { name: string }) => a.name);
    expect(rows()).toEqual([
      "Old press, 1 of 3, Superset 1",
      "Old press, 2 of 3, Superset 1",
      "Row, 3 of 3",
    ]);
    // Partners share one place: both only go down, and the row only up.
    expect(actions("Old press, 1 of 3, Superset 1")).toEqual(["moveDown"]);
    expect(actions("Old press, 2 of 3, Superset 1")).toEqual(["moveDown"]);
    expect(actions("Row, 3 of 3")).toEqual(["moveUp"]);

    // Moving the second partner takes the first with it.
    await moveByAction(root, "Old press, 2 of 3, Superset 1", "moveDown");
    expect(rows()).toEqual([
      "Row, 1 of 3",
      "Old press, 2 of 3, Superset 1",
      "Old press, 3 of 3, Superset 1",
    ]);

    const grips = (name: string) =>
      root.findAll(
        (n) => n.type === View && n.props.accessibilityLabel === `Drag to reorder ${name}`,
      );
    const divider = (label: string) =>
      root
        .findByProps({ accessibilityLabel: label })
        .props.style.some(
          (style: { borderTopWidth?: number } | false) =>
            style !== false && style.borderTopWidth === 1,
        );
    const [firstPartnerGrip] = grips("Old press");
    if (!firstPartnerGrip) throw Error("Missing the first partner's grip");
    expect(divider("Old press, 2 of 3, Superset 1")).toBe(true);
    await act(() => firstPartnerGrip.props.onPanResponderStart());
    await act(() => firstPartnerGrip.props.onPanResponderMove(null, { dx: 0, dy: -100 }));
    expect(divider("Old press, 2 of 3, Superset 1")).toBe(false);
    expect(divider("Old press, 3 of 3, Superset 1")).toBe(true);
    await act(() => firstPartnerGrip.props.onPanResponderTerminate());
    expect(divider("Old press, 2 of 3, Superset 1")).toBe(true);

    const [rowGrip] = grips("Row");
    if (!rowGrip) throw Error("Missing the row's grip");
    const orderBeforeDrag = rows();
    const scrollEnabled = () => root.findByType(ScrollView).props.scrollEnabled;
    const lift = () => rowGrip.parent?.parent?.props.style[0];
    vi.mocked(haptic.tap).mockClear();

    // A touch holds the page steady. Small or sideways motion doesn't lift or move the row.
    expect(scrollEnabled()).toBe(true);
    await act(() => rowGrip.props.onPanResponderStart());
    expect(scrollEnabled()).toBe(false);
    expect(lift()).toBe(false);
    await act(() => rowGrip.props.onPanResponderMove(null, { dx: 0, dy: 5 }));
    expect(lift()).toBe(false);
    await act(() => rowGrip.props.onPanResponderMove(null, { dx: 150, dy: 140 }));
    expect(lift()).toBe(false);
    expect(haptic.tap).not.toHaveBeenCalled();
    await act(() => rowGrip.props.onPanResponderRelease(null, { dy: 140 }));
    expect(rows()).toEqual(orderBeforeDrag);
    expect(scrollEnabled()).toBe(true);

    const dragRow = async () => {
      await act(() => rowGrip.props.onPanResponderStart());
      await act(() => rowGrip.props.onPanResponderMove(null, { dx: 0, dy: 140 }));
    };
    const shifts = () =>
      root
        .findAll((n) => n.type === View && Array.isArray(n.props.style))
        .flatMap((n) => n.props.style)
        .flatMap((style: { transform?: { translateY: number }[] } | false) =>
          style && style.transform !== undefined ? style.transform.map((t) => t.translateY) : [],
        );
    await dragRow();
    expect(lift()).toBeTruthy();
    expect(haptic.tap).toHaveBeenCalledTimes(1);
    expect(shifts()).toEqual([140, -64]);
    expect(divider("Old press, 2 of 3, Superset 1")).toBe(false);
    expect(scrollEnabled()).toBe(false);
    await act(() => rowGrip.props.onPanResponderTerminate(null, { dy: 140 }));
    expect(rows()).toEqual(orderBeforeDrag);
    expect(shifts()).toEqual([]);
    expect(lift()).toBe(false);
    expect(scrollEnabled()).toBe(true);

    // Dragging the row past the pair's middle drops it after them.
    await dragRow();
    await act(() => rowGrip.props.onPanResponderRelease(null, { dy: 140 }));
    expect(scrollEnabled()).toBe(true);
    expect(rows()).toEqual([
      "Old press, 1 of 3, Superset 1",
      "Old press, 2 of 3, Superset 1",
      "Row, 3 of 3",
    ]);
    // A short drag that doesn't pass a middle leaves the order as it was.
    await act(() => rowGrip.props.onPanResponderStart());
    await act(() => rowGrip.props.onPanResponderMove(null, { dx: 0, dy: -20 }));
    await act(() => rowGrip.props.onPanResponderRelease(null, { dy: -20 }));
    expect(rows()).toEqual([
      "Old press, 1 of 3, Superset 1",
      "Old press, 2 of 3, Superset 1",
      "Row, 3 of 3",
    ]);
    // Dragging either partner moves the pair.
    const partnerGrip = grips("Old press")[1];
    if (!partnerGrip) throw Error("Missing the second partner's grip");
    await act(() => partnerGrip.props.onPanResponderStart());
    await act(() => partnerGrip.props.onPanResponderMove(null, { dx: 0, dy: 100 }));
    await act(() => partnerGrip.props.onPanResponderRelease(null, { dy: 100 }));
    expect(rows()).toEqual([
      "Row, 1 of 3",
      "Old press, 2 of 3, Superset 1",
      "Old press, 3 of 3, Superset 1",
    ]);

    // Nothing is stored until Save routine, which comes back with Done.
    expect(store.get("routine", "routine")?.content?.exercises).toEqual(original);
    await toggleReorder(rendered);
    await tapText(root, "Save routine");
    expect(store.get("routine", "routine")?.content?.exercises).toEqual([third, entry, second]);
    expect(liveData(store)?.initialPlan).toEqual(running);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("keeps the web page's scrollbar in place while a reorder grip is held", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const platform = vi.spyOn(Platform, "OS", "get").mockReturnValue("web");
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/move-plan-web",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  try {
    const second = { ...entry, id: "extra", exerciseName: "Row", supersetId: null };
    store.put("routine", "routine", { ...routine, exercises: [entry, second] });
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    await toggleReorder(rendered);
    const scroll = rendered.root.findByType(ScrollView);
    const grip = scroll.findByProps({ accessibilityLabel: "Drag to reorder Row" });
    await act(() => grip.props.onPanResponderStart());
    expect(scroll.props.scrollEnabled).toBe(true);
    await act(() => grip.props.onPanResponderRelease(null, { dy: 0 }));
    expect(scroll.props.scrollEnabled).toBe(true);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    platform.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("lets both routine editors make room for the keyboard below their last set", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/keyboard",
    appVersion: "test",
  });
  let rendered: ReactTestRenderer | undefined;
  /** The page the field scrolls on, which has to make room for the keyboard. */
  const pageOf = (field: Root) => {
    let node: Root | null = field;
    while (node && node.type !== ScrollView) node = node.parent;
    if (!node) throw Error("The field is not on a scrolling page");
    return node;
  };
  try {
    store.put("routine", "routine", routine);
    await act(() => {
      rendered = create(createElement(RoutineDetails));
    });
    if (!rendered) throw Error("Missing routine editor");
    const lastSet = rendered.root.findByProps({ accessibilityLabel: "Old press set 2 Max reps" });
    expect(pageOf(lastSet).props.automaticallyAdjustKeyboardInsets).toBe(true);
    await act(() => rendered?.unmount());

    await act(() => {
      rendered = create(createElement(NewRoutine));
    });
    const root = rendered.root;
    await tapText(root, "Add exercise");
    const picker = root.find((n) => typeof n.props.onPickMany === "function");
    await act(() => picker.props.onPickMany([EXERCISES.bench]));
    await tapText(root, "Add set");
    const added = root.findAll(
      (n) =>
        typeof n.props.accessibilityLabel === "string" &&
        /^Bench Press set \d+ REPS$/.test(n.props.accessibilityLabel) &&
        typeof n.props.onChangeText === "function",
    );
    expect(added.length).toBeGreaterThan(1);
    expect(pageOf(added.at(-1) as Root).props.automaticallyAdjustKeyboardInsets).toBe(true);
  } finally {
    await act(() => rendered?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("compares two phones' routine targets and syncs the chosen local version", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  try {
    const server = world.server();
    const account = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    store = a.store;
    store.put("routine", "routine", routine);
    await a.sync();
    await b.sync();
    const setTarget = (weightKg: number) => ({
      ...routine,
      notes: weightKg === 50 ? "" : "None",
      exercises: [{ ...entry, sets: [{ ...target, weightKg }] }],
    });
    store.put("routine", "routine", setTarget(50));
    b.store.put("routine", "routine", setTarget(75));
    await b.sync();
    await act(() => {
      screen = create(createElement(RoutineDetails));
    });
    if (!screen) throw Error("Missing routine form");
    const root = screen.root;
    await act(() =>
      root
        .findByProps({ accessibilityLabel: "Routine name" })
        .props.onChangeText("Unsubmitted routine name"),
    );
    await a.sync();
    await act(() => screen?.update(createElement(RoutineDetails)));
    expect(root.findByProps({ accessibilityLabel: "Routine name" }).props.value).toBe(
      "Unsubmitted routine name",
    );
    await act(() =>
      root
        .find((n) => n.type === Text && n.props.children === "Discard draft and review versions")
        .parent!.props.onPress(),
    );
    expect(root.findByProps({ accessibilityLabel: "Routine name" }).props.value).toBe(
      "Unsubmitted routine name",
    );
    await act(() =>
      root
        .find((n) => n.type === ("ActionSheet" as never) && n.props.action === "Discard draft")
        .props.onConfirm(),
    );
    const text = () => root.findAllByType(Text).map((n) => n.children.join(""));
    expect(text()).toEqual(
      expect.arrayContaining([
        'This device · ""',
        'Server · "None"',
        "Exercise 1 · Set 1 · Load (kg)",
        "This device · 50",
        "Server · 75",
      ]),
    );
    const choose = () =>
      root.find((n) => n.type === Text && n.props.children === "Keep my version").parent!.props
        .onPress;
    const stale = choose();
    b.store.put("routine", "routine", setTarget(80));
    await b.sync();
    await a.sync();
    await act(() => stale());
    expect(store.get("routine", "routine")?.status).toBe("conflict");
    expect(root.findByProps({ accessibilityRole: "alert" }).props.children).toMatch(/changed/);
    await act(() => screen?.update(createElement(RoutineDetails)));
    expect(text()).toContain("Server · 80");
    await act(() => choose()());
    await a.sync();
    await b.sync();
    expect(b.store.get("routine", "routine")?.content?.exercises).toEqual(setTarget(50).exercises);
    expect(store.hasUnsyncedWork()).toBe(false);
  } finally {
    await act(() => screen?.unmount());
    await world.dispose();
    vi.unstubAllGlobals();
  }
});
