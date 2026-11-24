// @vitest-environment happy-dom
/// <reference lib="dom" />
import { join } from "node:path";
import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { World } from "../../../packages/sync/test/support/harness.ts";
import HistoryScreen from "../app/(tabs)/history.tsx";
import ExerciseScreen from "../app/exercise/[id].tsx";
import WorkoutDetailScreen from "../app/workout/[id].tsx";
import ActiveWorkoutScreen from "../app/workout/active.tsx";
import FinishScreen from "../app/workout/finish.tsx";
import { workoutFrame } from "../src/activity/frame.ts";
import { type WorkoutContent, workoutSession } from "../src/activity/session.ts";
import { pickerLibrary } from "../src/data/custom-exercises.ts";
import { type BuiltInExercise, EXERCISES } from "../src/data/exercises.ts";
import { newId } from "../src/data/ids.ts";
import {
  applyAppChange,
  historyData,
  liveData,
  progressData,
  readSettings,
  readWorkoutTree,
  workoutDetail,
} from "../src/data/read.ts";
import { restTimer } from "../src/data/rest-timer.ts";
import { createRoutine, writePlan } from "../src/data/routine-actions.ts";
import { saveSettings } from "../src/data/settings-actions.ts";
import { saveShowTargets } from "../src/data/show-targets.ts";
import {
  addExercise,
  addExerciseNote,
  addHistoricalSet,
  addSet,
  beginWorkout,
  discardWorkout,
  finishWorkout,
  logSet,
  moveWorkoutExercise,
  removeWorkoutExercise,
  removeWorkoutSet,
  updateSet,
} from "../src/data/workout-actions.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import { MiniPlayer } from "../src/ui/live/mini-player.tsx";
import { useWorkoutPlayer } from "../src/ui/live/use-workout-player.ts";
import { SetEditor } from "../src/ui/set-editor.tsx";
import { useSetStopwatch } from "../src/ui/use-set-stopwatch.ts";
import { useWorkoutSelection } from "../src/ui/use-workout-selection.ts";
import { WorkoutDetailsEditor } from "../src/ui/workout-details-editor.tsx";
import { feedbackScheduler } from "./support/feedback.ts";

const feedback = feedbackScheduler();
vi.mock("../src/ui/after-feedback.ts", () => ({
  afterFeedback: (run: () => void) => feedback.afterFeedback(run),
}));
let store: DeviceStore;
let version = 0;
let historyVersion = 0;
let preventRemoval = false;
let detailId: string;
let detailReturn: { back?: string; fromExercise?: string; from?: string } = {};
let activeEntryId: string | undefined;
const { pushRoute, replaceRoute, backRoute, canGoBack, navigateRoute, blurListeners } = vi.hoisted(
  () => ({
    backRoute: vi.fn(),
    canGoBack: vi.fn(),
    pushRoute: vi.fn(),
    replaceRoute: vi.fn(),
    navigateRoute: vi.fn(),
    /** What runs when the screen stops being the one shown. */
    blurListeners: new Set<() => void>(),
  }),
);
const navigation = {
  addListener: (event: string, listener: () => void) => {
    if (event !== "blur") return () => {};
    blurListeners.add(listener);
    return () => blurListeners.delete(listener);
  },
};
function change<T>(write: (value: DeviceStore) => T, scope?: "active-workout"): T {
  const updated = applyAppChange(store, write, scope);
  version++;
  historyVersion = updated.historyVersion;
  return updated.result;
}
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store,
    version,
    historyVersion,
    change,
  }),
}));
vi.mock("expo-router", () => ({
  useSegments: () => ["(tabs)", "index"],
  useNavigation: () => navigation,
  usePreventRemove: (enabled: boolean) => {
    preventRemoval = enabled;
    return () => {
      preventRemoval = false;
    };
  },
  Link: ({ children, href }: { children: ReactNode; href: unknown }) =>
    h("div", { "data-destination": JSON.stringify(href) }, children),
  useLocalSearchParams: () => ({ id: detailId, activeEntryId, ...detailReturn }),
  router: {
    push: pushRoute,
    replace: replaceRoute,
    navigate: navigateRoute,
    canGoBack,
    canDismiss: () => false,
    back: backRoute,
  },
}));
vi.mock("../src/data/queries.ts", async (load) => ({
  ...(await load<typeof import("../src/data/queries.ts")>()),
  useWorkoutDetail: (id: string) => workoutDetail(store, id),
  useHistory: () => historyData(store),
  useProgress: () => progressData(store),
}));
vi.mock("../src/ui/line-chart.tsx", () => ({ LineChart: () => null }));
const toasts: string[] = [];
vi.mock("../src/ui/notice.tsx", async (load) => {
  const notice = await load<typeof import("../src/ui/notice.tsx")>();
  return {
    ...notice,
    showToast: (text: string) => {
      toasts.push(text);
      notice.showToast(text);
    },
  };
});
vi.mock("../src/ui/use-now.ts", () => ({ useToday: () => Date.now() }));
vi.mock("../src/ui/chart-controls.tsx", () => ({
  Segmented: ({
    options,
    onChange,
  }: {
    options: { label: string; value: string }[];
    onChange: (value: string) => void;
  }) =>
    options.map(({ label, value }) =>
      h("button", { type: "button", key: value, onClick: () => onChange(value) }, label),
    ),
  RangePills: () => null,
}));
let settled = true;
vi.mock("../src/ui/use-settled.ts", () => ({ useSettled: () => settled }));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children }: { children: ReactNode }) => children,
  StillOnOpen: ({ children }: { children: ReactNode }) => children,
  useExit: () => undefined,
  useArrivedLater: () => false,
}));
vi.mock("react-native-reanimated", () => ({
  useReducedMotion: () => true,
  default: {
    View: ({ children }: { children: ReactNode }) => children,
    Text: ({ children }: { children: ReactNode }) => children,
  },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  Easing: { linear: (value: number) => value },
  ReduceMotion: { Never: "never" },
  withTiming: (value: number) => value,
  withSpring: (value: number) => value,
}));
vi.mock("../src/ui/motion.ts", () => ({
  easeOut: undefined,
  layout: undefined,
  layoutDuration: 220,
  sinkOut: undefined,
  spring: undefined,
}));
vi.mock("../src/ui/icons.tsx", () => ({
  HistoryIcon: () => null,
  ProgressIcon: () => null,
  TrainIcon: () => null,
  CheckIcon: () => null,
  ChevronIcon: () => null,
  MoreIcon: () => null,
  PlusIcon: () => null,
  DeleteIcon: () => null,
  EditIcon: () => null,
  ForwardIcon: () => null,
  MinusIcon: () => null,
  TimerIcon: () => null,
  SearchIcon: () => null,
  CloseIcon: () => null,
  SkipIcon: () => null,
  NoteIcon: () => null,
}));
vi.mock("../src/ui/progress.tsx", () => ({ Fill: () => null }));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Line: "line",
  Circle: "circle",
}));
vi.mock("../src/ui/muscle-map.tsx", () => ({
  ExerciseMuscles: () => null,
  WorkoutMuscleSummary: () => null,
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
// Exercise the editor and its real confirmation component with DOM controls.
vi.mock("react-native", () => {
  const container = ({ children }: { children: ReactNode }) => h("div", null, children);
  return {
    ActivityIndicator: () => null,
    useColorScheme: () => "dark",
    Easing: { linear: (value: number) => value },
    Platform: { OS: "web" },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Keyboard: { dismiss: () => (document.activeElement as HTMLElement | null)?.blur() },
    AccessibilityInfo: { sendAccessibilityEvent: vi.fn() },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      keyExtractor,
    }: {
      ListHeaderComponent?: ReactNode;
      keyExtractor?: (item: BuiltInExercise) => string;
      data: BuiltInExercise[];
      renderItem: (props: { item: BuiltInExercise }) => ReactNode;
    }) =>
      h(
        "div",
        null,
        ListHeaderComponent,
        data
          .slice(0, 10)
          .map((item) => h("div", { key: keyExtractor?.(item) ?? item.id }, renderItem({ item }))),
      ),
    SectionList: ({
      sections,
      renderItem,
      ListHeaderComponent,
      keyExtractor,
    }: {
      ListHeaderComponent?: ReactNode;
      keyExtractor?: (item: BuiltInExercise) => string;
      sections: { data: BuiltInExercise[] }[];
      renderItem: (props: {
        item: BuiltInExercise;
        index: number;
        section: { data: BuiltInExercise[] };
      }) => ReactNode;
    }) =>
      h(
        "div",
        null,
        ListHeaderComponent,
        sections.flatMap((section) =>
          section.data
            .slice(0, 10)
            .map((item, index) =>
              h(
                "div",
                { key: keyExtractor?.(item) ?? item.id },
                renderItem({ item, index, section }),
              ),
            ),
        ),
      ),
    Modal: ({ children, "aria-label": label }: { children: ReactNode; "aria-label"?: string }) =>
      h("div", { role: "dialog", "aria-label": label }, children),
    Pressable: container,
    ScrollView: ({ children, inert }: { children: ReactNode; inert?: boolean }) =>
      h("div", { inert }, children),
    View: ({
      children,
      onMouseDown,
      dataSet,
    }: {
      children: ReactNode;
      onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
      dataSet?: { keyboardAccessory?: boolean };
    }) =>
      h("div", { onMouseDown, "data-keyboard-accessory": dataSet?.keyboardAccessory }, children),
    Text: container,
    TextInput: ({
      value,
      placeholder,
      accessibilityLabel,
      onChangeText,
    }: {
      value: string;
      placeholder?: string;
      accessibilityLabel?: string;
      onChangeText: (text: string) => void;
    }) =>
      h("input", {
        value,
        placeholder,
        "aria-label": accessibilityLabel,
        onInput: (e) => onChangeText(e.currentTarget.value),
      }),
    KeyboardAvoidingView: container,
    StyleSheet: {
      absoluteFill: {},
      create: (styles: unknown) => styles,
      flatten: (styles: object[]) => Object.assign({}, ...styles),
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/tap.tsx", () => ({
  Tap: ({
    "aria-busy": busy,
    accessibilityRole,
    accessibilityState,
    children,
    onPress,
    onFocus,
    onBlur,
    accessibilityLabel,
    disabled,
    ref,
  }: {
    "aria-busy"?: boolean;
    ref?: React.Ref<HTMLButtonElement>;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; expanded?: boolean };
    children: ReactNode;
    onPress: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    h(
      "button",
      {
        type: "button",
        ref,
        role: accessibilityRole,
        onClick: onPress,
        onFocus,
        onBlur,
        disabled,
        "aria-busy": busy,
        "aria-label": accessibilityLabel,
        "aria-checked": accessibilityState?.checked,
        "aria-expanded": accessibilityState?.expanded,
      },
      children,
    ),
}));

const sql = await initSqlJs();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function openWorkoutStore(contract?: typeof previewContract) {
  return openDeviceStore({
    engine: createSqlJsEngine(sql),
    path: "/test.db",
    appVersion: "test",
    ...(contract ? { contract } : {}),
  });
}

async function usePreviewContract() {
  store.close();
  store = await openWorkoutStore(previewContract);
}

beforeEach(async () => {
  version = 0;
  historyVersion = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openWorkoutStore();
  saveShowTargets(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  canGoBack.mockReturnValue(true);
  backRoute.mockImplementation(() => root.render(null));
});
afterEach(async () => {
  blurListeners.clear();
  await act(() => root.unmount());
  await act(feedback.release);
  host.remove();
  store.close();
  vi.unstubAllGlobals();
  activeEntryId = undefined;
  detailReturn = {};
  pushRoute.mockReset();
  replaceRoute.mockReset();
  navigateRoute.mockReset();
  backRoute.mockReset();
  canGoBack.mockReset();
});
async function press(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (el) => el.textContent === label || el.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(() => button.click());
}

/** Confirms a destructive action in the action sheet it opened. */
async function confirmAction(action: string) {
  const sheet = host.querySelector(`[role="dialog"][aria-label="${action}"]`);
  const button = Array.from(sheet?.querySelectorAll("button") ?? []).find(
    (el) => el.textContent === action,
  );
  if (!button) throw new Error(`Missing confirmation: ${action}`);
  await act(() => button.click());
}

async function pressKey(key: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${key}"]`);
  if (!button) throw new Error(`Missing key: ${key}`);
  await act(() => button.click());
}
/** Opens a set's field on the number pad and types `text` there (a time as its digits). */
async function typeInto(field: string, text: string) {
  await press(field);
  for (const char of text) {
    if (char === ":") continue;
    await pressKey(char === "." || char === "," ? "Decimal point" : char);
  }
}
/** What a set's field shows. */
const field = (name: string) => host.querySelector(`button[aria-label="${name}"]`);
const fieldText = (name: string) => field(name)?.firstElementChild?.textContent ?? null;
const fieldTarget = (name: string) => field(name)?.children[1]?.textContent || null;

it("keeps a note draft focused while its sheet adjusts and skips the same workout rest", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 90);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing set");
  logSet(store, set.id, { weightKg: 60, reps: 8 });
  restTimer.start(store, id, set.id, 90);
  await act(() => root.render(h(ActiveWorkoutScreen)));
  await press("Manage Bench Press");
  await press("Add exercise note");
  const sheet = host.querySelector('[role="dialog"][aria-label="Bench Press"]');
  const input = sheet?.querySelector<HTMLInputElement>('input[aria-label="Note for Bench Press"]');
  if (!sheet || !input) throw Error("Missing note editor");
  await act(() => {
    input.focus();
    input.value = "Hold at the top";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const action = (name: string) =>
    sheet.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(action("15 seconds more")).toBeTruthy();
  expect(sheet.querySelector('button[aria-label*="Change the rest time"]')).toBeNull();
  const clickTimer = (name: string) =>
    act(() => {
      const button = action(name);
      if (!button) throw Error(`Missing ${name}`);
      // A browser focuses the pressed button unless mousedown was cancelled.
      if (button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })))
        button.focus();
      button.click();
    });
  await clickTimer("15 seconds more");
  expect(sheet.textContent).toContain("Rest · 1:45");
  expect(document.activeElement).toBe(input);
  await clickTimer("Skip rest");
  expect(action("15 seconds more")).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Hold at the top");
  await press("Save exercise note");
  expect(readWorkoutTree(store, id)?.entries[0]?.entry.content.notes?.[0]?.text).toBe(
    "Hold at the top",
  );
});

it("allows tab navigation to the rest controls without advancing the edited set field", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 90);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing set");
  addSet(store, entry);
  logSet(store, first.id, { weightKg: 60, reps: 8 });
  restTimer.start(store, id, first.id, 90);
  await act(() => root.render(h(ActiveWorkoutScreen)));
  await typeInto("kg for set 2", "7");
  for (const shiftKey of [false, true]) {
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    await act(() => document.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
  }
  const adjust = host.querySelector<HTMLButtonElement>('button[aria-label="15 seconds more"]');
  if (!adjust) throw Error("Missing compact timer");
  await act(() => {
    adjust.focus();
    adjust.click();
  });
  expect(host.textContent).toContain("Rest · 1:45");
  await pressKey("5");
  expect(fieldText("kg for set 2")).toBe("75");
});

function Screen({ id }: { id: string }) {
  const tree = readWorkoutTree(store, id);
  if (!tree) throw new Error("Missing workout");
  const { focusIndex, focusExercise } = useWorkoutSelection(store, tree);
  return h(
    "div",
    null,
    h("output", null, tree.entries[focusIndex]?.entry.content.exerciseName),
    tree.entries.map(({ entry }) =>
      h(
        "button",
        { type: "button", key: entry.id, onClick: () => focusExercise(entry.id) },
        entry.content.exerciseName,
      ),
    ),
  );
}

it.each([true, false])(
  "returns from Finish to the live session with a back stack: %s",
  async (hasStack) => {
    const session = beginWorkout(store);
    canGoBack.mockReturnValue(hasStack);
    await act(() => root.render(h(FinishScreen)));
    await press("Back to the workout");
    if (hasStack) {
      expect(backRoute).toHaveBeenCalledOnce();
      expect(replaceRoute).not.toHaveBeenCalled();
    } else {
      expect(replaceRoute).toHaveBeenCalledWith("/workout/active");
      expect(backRoute).not.toHaveBeenCalled();
    }
    expect(liveData(store)?.tree.workout.id).toBe(session);
  },
);

it("restores the chosen exercise on remount and opens a different workout at its first exercise", async () => {
  const push = beginWorkout(store);
  addExercise(store, push, EXERCISES.bench, 120);
  addExercise(store, push, EXERCISES.ohp, 120);
  await act(() => root.render(h(Screen, { id: push })));
  expect(host.querySelector("output")?.textContent).toBe("Bench Press");
  await press("Overhead Press");
  await act(() => root.render(null));
  await act(() => root.render(h(Screen, { id: push })));
  expect(host.querySelector("output")?.textContent).toBe("Overhead Press");
  discardWorkout(store, push);
  const pull = beginWorkout(store);
  addExercise(store, pull, EXERCISES.curl, 90);
  await act(() => root.render(h(Screen, { id: pull })));
  expect(host.querySelector("output")?.textContent).toBe("Biceps Curl");
});

it.each([
  ["training", ActiveWorkoutScreen],
  ["finishing", FinishScreen],
] as const)(
  "requires a new discard confirmation after switching sessions while %s",
  async (_, Screen) => {
    const first = beginWorkout(store);
    const entry = addExercise(store, first, EXERCISES.bench, 60);
    const logged = store.list("workout_set", { parentId: entry })[0];
    if (!logged) throw Error("Missing set");
    logSet(store, logged.id, { reps: 5, weightKg: 30 });
    const show = () => act(() => root.render(h(Screen)));
    await show();
    await press("Discard workout");
    const second = change((db) => {
      finishWorkout(db, first, { title: "Finished elsewhere", countForRoutine: false });
      const next = beginWorkout(db);
      addExercise(db, next, EXERCISES.squat, 60);
      return next;
    });
    await show();
    // The sheet opened for the first session closed with it.
    expect(host.querySelector('[role="dialog"][aria-label="Discard workout"]')).toBeNull();
    await press("Discard workout");
    expect(store.activeWorkout()?.id).toBe(second);
    expect(store.get("workout", first)?.content?.title).toBe("Finished elsewhere");
    await confirmAction("Discard workout");
    expect(store.activeWorkout()).toBeNull();
    expect(store.get("workout", first)?.content?.title).toBe("Finished elsewhere");
  },
);

it.each(["finished", "deleted"] as const)(
  "preserves local edits when the workout is %s remotely between discard taps",
  async (change) => {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const first = store.list("workout_set", { parentId: entry })[0];
    if (!first) throw Error("Missing set");
    logSet(store, first.id, { reps: 5, weightKg: 30 });
    store.applyPushResults(
      store.prepareSubmissions("1.0").map(({ submission }, index) => ({
        submissionId: submission.submissionId,
        status: "accepted",
        revision: index + 1,
      })),
    );
    const original = store.get("workout", id)?.server?.content;
    if (!original) throw Error("Missing synced workout");
    if (change === "finished") store.put("workout", id, { ...original, title: "Local edit" });
    updateSet(store, first.id, { reps: 8 });
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Discard workout");
    const incoming =
      change === "finished"
        ? {
            kind: "workout",
            id,
            revision: 50,
            state: "live" as const,
            content: { ...original, endedAt: new Date().toISOString() },
          }
        : { kind: "workout", id, revision: 50, state: "deleted" as const };
    store.applyPull([incoming], 50);
    expect(store.activeWorkout()?.id).toBe(id);
    await confirmAction("Discard workout");
    expect(store.get("workout", id)).toMatchObject({ deleted: false, status: "conflict" });
    expect(store.list("workout_set", { parentId: entry })[0]?.content?.reps).toBe(8);
  },
);

it.each(["save", "delete"])(
  "can %s a locally edited set after that set alone is deleted on the server",
  async (choice) => {
    detailId = beginWorkout(store);
    const entry = addExercise(store, detailId, EXERCISES.bench, 90);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { reps: 5, weightKg: 35 });
    finishWorkout(store, detailId, { title: "Bench", countForRoutine: false });
    store.applyPushResults(
      store.prepareSubmissions("1.0").map(({ submission }, i) => ({
        submissionId: submission.submissionId,
        status: "accepted",
        revision: i + 1,
      })),
    );
    updateSet(store, set.id, { reps: 7 });
    store.applyPull([{ kind: "workout_set", id: set.id, state: "deleted", revision: 50 }], 50);
    await act(() => root.render(h(WorkoutDetailScreen)));
    await press("Review changes to set 1");
    expect(host.textContent).toContain("This set was deleted on another device");
    await press(choice === "save" ? "Save as a new set" : "Accept set deletion");
    const remaining = store.list("workout_set", { parentId: entry });
    expect(remaining.map((row) => row.content?.reps)).toEqual(choice === "save" ? [7] : []);
    expect(remaining.some((row) => row.id === set.id)).toBe(false);
    expect(store.get("workout_exercise", entry)?.content?.workoutId).toBe(detailId);
  },
);
it("requires a fresh confirmation after cancelling and deletes only the selected session", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 90);
  const [first] = store.list("workout_set", { parentId: entry });
  if (!first) throw new Error("Missing first set");
  logSet(store, first.id, { weightKg: 20, reps: 8 });
  finishWorkout(store, id, { title: "Selected session", description: "", countForRoutine: false });
  const selected = readWorkoutTree(store, id)?.workout;
  if (!selected) throw new Error("Missing saved session");
  const other = beginWorkout(store);
  const open = () =>
    act(() =>
      root.render(
        h(WorkoutDetailsEditor, {
          workout: selected,
          onClose: () => root.render(null),
          onDeleted: () => root.render(null),
        }),
      ),
    );
  await open();
  await press("Delete workout");
  expect(readWorkoutTree(store, selected.id)).not.toBeNull();
  await press("Cancel");
  expect(readWorkoutTree(store, selected.id)).not.toBeNull();
  expect(store.activeWorkout()?.id).toBe(other);
  await open();
  await press("Delete workout");
  expect(readWorkoutTree(store, selected.id)).not.toBeNull();
  await confirmAction("Delete workout");
  expect(readWorkoutTree(store, selected.id)).toBeNull();
  expect(store.activeWorkout()?.id).toBe(other);
});

it("lets the lifter correct an invalid duration and save it from workout history", async () => {
  store.put("workout", "evening", {
    title: "Evening",
    description: "",
    routineId: null,
    startedAt: "2021-01-02T23:55:00.000Z",
    endedAt: "2021-01-03T01:05:20.000Z",
  });
  const row = readWorkoutTree(store, "evening")?.workout;
  if (!row) throw Error("Missing workout");
  const close = vi.fn();
  await act(() =>
    root.render(h(WorkoutDetailsEditor, { workout: row, onDeleted: close, onClose: close })),
  );
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Workout duration"]');
  if (!input) throw Error("Missing duration field");
  expect(input.value).toBe("1:10:20");
  const enter = async (value: string) => {
    await act(() => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await enter("wrong");
  await press("Save changes");
  expect(close).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Enter a duration");
  expect(store.get("workout", row.id)?.content?.endedAt).toBe("2021-01-03T01:05:20.000Z");
  await enter("12:15");
  await press("Save changes");
  expect(close).toHaveBeenCalledOnce();
  expect(store.get("workout", row.id)?.content?.endedAt).toBe("2021-01-03T00:07:15.000Z");
});

function TimerProbe({ workout, set }: { workout: string; set: string }) {
  const timer = useSetStopwatch(store, workout, set);
  return h(
    "div",
    null,
    h("output", null, timer.value?.seconds ?? (timer.value ? "running" : "idle")),
    h("button", { type: "button", onClick: timer.start }, "Start"),
    h("button", { type: "button", onClick: timer.stop }, "Stop"),
    h("button", { type: "button", onClick: timer.clear }, "Clear"),
  );
}

it("measures elapsed time across remounts without applying it to another set or session", async () => {
  const now = vi.spyOn(Date, "now");
  const screen = (workout: string, set: string) =>
    act(() => root.render(h(TimerProbe, { workout, set })));
  const value = () => host.querySelector("output")?.textContent;
  try {
    await screen("morning", "plank");
    now.mockReturnValue(1_000);
    await press("Start");
    await act(() => root.render(null));
    await screen("morning", "stretch");
    expect(value()).toBe("idle");
    await screen("morning", "plank");
    expect(value()).toBe("running");
    now.mockReturnValue(46_600);
    await press("Stop");
    expect(value()).toBe("45");
    await act(() => root.render(null));
    await screen("morning", "plank");
    expect(value()).toBe("45");
    await screen("evening", "plank");
    expect(value()).toBe("idle");
    await press("Start");
    await press("Clear");
    expect(value()).toBe("idle");
  } finally {
    now.mockRestore();
  }
});

it("logs the corrected stopwatch value after minimising, even with another duration in history", async () => {
  const addPlank = () => {
    const workoutId = beginWorkout(store);
    const entry = addExercise(store, workoutId, EXERCISES.plank, 0);
    const [set] = store.list("workout_set", { parentId: entry });
    if (!set) throw new Error("Missing plank set");
    return { workoutId, setId: set.id };
  };
  const prior = addPlank();
  logSet(store, prior.setId, { durationSeconds: 62 });
  finishWorkout(store, prior.workoutId, {
    title: "Earlier",
    description: "",
    countForRoutine: false,
  });
  const current = addPlank();
  const open = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await open();
  expect(host.textContent).toContain("Logged time 0:00");
  // Last time's time is suggested until a time is measured or typed.
  expect(fieldText("time for set 1")).toBe("1:02");
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(1000);
    await press("Start timer");
    now.mockReturnValue(46000);
    await press("Stop timer");
    expect(fieldText("time for set 1")).toBe("0:45");
    await typeInto("time for set 1", "0:40");
    await press("Minimise workout");
    expect(fieldText("time for set 1")).toBeNull();
    await open();
    expect(fieldText("time for set 1")).toBe("0:40");
    await press("Log set 1");
    const saved = readWorkoutTree(store, current.workoutId)?.entries[0]?.sets[0];
    expect(saved?.content.durationSeconds).toBe(40);
    expect(saved?.content.completedAt).toEqual(expect.any(String));
  } finally {
    now.mockRestore();
  }
});

it("opens a saved duration as a clock time and stores a clock-formatted correction", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.plank, 0);
  const [planned] = store.list("workout_set", { parentId: entry });
  if (!planned) throw new Error("Missing plank set");
  logSet(store, planned.id, { durationSeconds: 75.5 });
  finishWorkout(store, id, { title: "Mobility", description: "", countForRoutine: false });
  const set = readWorkoutTree(store, id)?.entries[0]?.sets[0];
  if (!set) throw new Error("Missing saved plank");
  const open = () =>
    act(() =>
      root.render(
        h(SetEditor, {
          set,
          exercise: "Plank",
          rowLabel: "1",
          exerciseType: "duration",
          unit: "kg",
          distanceUnit: "m",
          onClose: () => root.render(null),
        }),
      ),
    );
  await open();
  expect(host.querySelector("input")?.value).toBe("1:16");
  await press("Save changes");
  expect(readWorkoutTree(store, id)?.entries[0]?.sets[0]?.content.durationSeconds).toBe(75.5);
  await open();
  const input = host.querySelector("input");

  if (!input) throw new Error("Missing time field");
  await act(() => {
    input.value = "1:20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Save changes");
  expect(readWorkoutTree(store, id)?.entries[0]?.sets[0]?.content.durationSeconds).toBe(80);
});

it("keeps a newer correction when History receives changes while editing a logged set", async () => {
  const original = store;
  const world = new World();
  try {
    const server = world.server();
    const account = { server: "s", account: "alice", transport: server.transport("alice") };
    const editor = await world.phone("editor", account);
    const other = await world.phone("other", account);
    store = editor.store;
    detailId = beginWorkout(store);
    const entry = addExercise(store, detailId, EXERCISES.bench, 0);
    const row = store.list("workout_set", { parentId: entry })[0];
    if (!row) throw Error("Missing set");
    logSet(store, row.id, { reps: 8, weightKg: 60 });
    finishWorkout(store, detailId, { countForRoutine: false });
    await editor.sync();
    await other.sync();
    const render = () => act(() => root.render(h(WorkoutDetailScreen)));
    const editReps = async (text: string) => {
      const field = host.querySelector<HTMLInputElement>('input[aria-label="REPS"]');
      if (!field) throw Error("Missing rep field");
      await act(() => {
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await render();
    await press("Edit set 1");
    await editReps("10");
    updateSet(other.store, row.id, { reps: 12, weightKg: 65 });
    await other.sync();
    await editor.sync();
    await render();
    await press("Save changes");
    expect(store.get("workout_set", row.id)?.content).toMatchObject({ reps: 12, weightKg: 65 });
    expect(host.textContent).toContain("Reopen the set");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="REPS"]')?.value).toBe("10");

    updateSet(other.store, row.id, { reps: 10 });
    await other.sync();
    await editor.sync();
    await render();
    await press("Save changes");
    expect(host.querySelector('input[aria-label="REPS"]')).toBeNull();
    expect(store.get("workout_set", row.id)?.status).toBe("synced");
    expect(store.prepareSubmissions("1.0")).toEqual([]);
    updateSet(other.store, row.id, { weightKg: 60 });
    await other.sync();
    await editor.sync();
    expect(store.get("workout_set", row.id)).toMatchObject({
      status: "synced",
      content: { reps: 10, weightKg: 60 },
    });
    await render();
    await press("Edit set 1");
    await editReps("9");
    updateSet(other.store, row.id, { type: "drop", weightKg: 67.5 });
    await other.sync();
    await editor.sync();
    await render();
    await press("Save changes");
    expect(store.get("workout_set", row.id)?.content).toMatchObject({
      reps: 9,
      type: "drop",
      weightKg: 67.5,
    });
    expect(host.querySelector('input[aria-label="REPS"]')).toBeNull();
    await editor.sync();
    await other.sync();
    await other.restart();
    expect(other.store.get("workout_set", row.id)?.content).toMatchObject({
      reps: 9,
      type: "drop",
      weightKg: 67.5,
    });
  } finally {
    store = original;
    await world.dispose();
  }
});

it.each(["reps arrive", "set moves", "exercise changes type"])(
  "keeps the Finish correction attached to the opened exercise when %s",
  async (scenario) => {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 0);
    const first = store.list("workout_set", { parentId: entry })[0];
    if (!first) throw Error("Missing first set");
    const second = addSet(store, entry);
    logSet(store, first.id, { weightKg: 70, reps: null });
    logSet(store, second, { weightKg: 65, reps: null });
    const render = () => act(() => root.render(h(FinishScreen)));
    await render();
    const review = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("2 sets have missing values"),
    );
    if (!review) throw Error("Missing Finish review");
    await act(() => review.click());
    const field = host.querySelector<HTMLInputElement>('input[aria-label="REPS"]');
    if (!field) throw Error("Missing rep field");
    await act(() => {
      field.value = "10";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    if (scenario === "set moves") {
      const plank = addExercise(store, id, EXERCISES.plank, 0);
      updateSet(store, first.id, { workoutExerciseId: plank });
    } else if (scenario === "exercise changes type") {
      const saved = store.get("workout_exercise", entry);
      if (!saved?.content) throw Error("Missing exercise");
      store.put("workout_exercise", entry, { ...saved.content, exerciseType: "duration" });
    } else {
      updateSet(store, first.id, { reps: 12 });
    }
    await render();
    await press("Save changes");
    expect(store.get("workout_set", first.id)?.content?.reps).toBe(
      scenario === "reps arrive" ? 12 : null,
    );
    expect(store.get("workout_set", second)?.content?.reps).toBeNull();
    expect(host.textContent).toContain("Reopen the set");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="REPS"]')?.value).toBe("10");
  },
);

it.each(["moved", "corrected"])(
  "refuses a stale removal from Finish when the set was %s",
  async (scenario) => {
    const id = beginWorkout(store);
    const bench = addExercise(store, id, EXERCISES.bench, 0);
    const row = store.list("workout_set", { parentId: bench })[0];
    if (!row) throw Error("Missing set");
    logSet(store, row.id, { reps: null, weightKg: 50 });
    const show = () => act(() => root.render(h(FinishScreen)));
    await show();
    const review = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("1 set has missing values"),
    );
    if (!review) throw Error("Missing Finish review");
    await act(() => review.click());
    await press("Remove set");
    const parent = scenario === "moved" ? addExercise(store, id, EXERCISES.plank, 0) : bench;
    const correction =
      scenario === "moved"
        ? { workoutExerciseId: parent, durationSeconds: 90, weightKg: null }
        : { reps: 8 };
    updateSet(store, row.id, correction);
    await show();
    await confirmAction("Remove set");
    expect(store.get("workout_set", row.id)).toMatchObject({
      deleted: false,
      content: { workoutExerciseId: parent, ...correction },
    });
    expect(host.textContent).toContain("Reopen the set");
  },
);

it.each(["type", "identity"])(
  "refuses a missing-set draft when the exercise changes %s",
  async (field) => {
    detailId = beginWorkout(store);
    const bench = addExercise(store, detailId, EXERCISES.bench, 0);
    const row = store.list("workout_set", { parentId: bench })[0];
    if (!row) throw Error("Missing set");
    logSet(store, row.id, { reps: 8, weightKg: 50 });
    finishWorkout(store, detailId, { countForRoutine: false });
    const show = () => act(() => root.render(h(WorkoutDetailScreen)));
    await show();
    await press("Add set to Bench Press");
    for (const [label, text] of [
      ["KG", "75"],
      ["REPS", "6"],
    ] as const) {
      const el = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      if (!el) throw Error("Missing input");
      await act(() => {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const parent = store.get("workout_exercise", bench);
    if (!parent?.content) throw Error("Missing exercise");
    store.put("workout_exercise", bench, {
      ...parent.content,
      ...(field === "type"
        ? { exerciseType: "bodyweight_reps" }
        : { exerciseId: EXERCISES.row.id }),
    });
    await show();
    await press("Save set");
    expect(store.list("workout_set", { parentId: bench })).toHaveLength(1);
    expect(host.textContent).toContain("Reopen");
  },
);

it("keeps exercises independently open and completes the chosen set before moving and removing its exercise", async () => {
  const workout = beginWorkout(store);
  const bench = addExercise(store, workout, EXERCISES.bench, 0);
  const plank = addExercise(store, workout, EXERCISES.plank, 0);
  const first = store.list("workout_set", { parentId: plank })[0];
  if (!first) throw Error("Missing first plank");
  const second = addSet(store, plank);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const ticks = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'));
  await render();
  expect(ticks().map((node) => node.getAttribute("aria-checked"))).toEqual([
    "false",
    "false",
    "false",
  ]);
  await press("Bench Press");
  expect(ticks()).toHaveLength(2);
  await typeInto("time for set 2", "0:45");
  await press("Log set 2");
  expect(ticks().map((node) => node.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(store.get("workout_set", second)?.content?.durationSeconds).toBe(45);
  expect(store.get("workout_set", first.id)?.content?.completedAt).toBeNull();
  await press("Manage Plank");
  const options = () => host.querySelector('[role="dialog"][aria-label="Plank"]');
  expect(options()?.textContent).toContain("Move up");
  vi.spyOn(store, "put").mockImplementationOnce(() => {
    throw Error("Move refused");
  });
  await press("Move up");
  expect(options()?.textContent).toContain("Move refused");
  await press("Close exercise options");
  expect(options()).toBeNull();
  await press("Manage Plank");
  await press("Move up");
  await render();
  expect(store.list("workout_exercise", { parentId: workout }).map((e) => e.id)).toEqual([
    plank,
    bench,
  ]);
  expect(ticks()).toHaveLength(2);
  const moveBack = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "Move down",
  );
  expect(moveBack).toBeInstanceOf(HTMLButtonElement);
  expect(document.activeElement).toBe(moveBack);
  expect(moveBack?.getAttribute("aria-label")).toBe("Move Plank down from position 1");
  await press("Remove exercise");
  expect(store.get("workout_set", second)?.content?.durationSeconds).toBe(45);
  await confirmAction("Remove exercise");
  await render();
  expect(store.list("workout_exercise", { parentId: workout }).map((e) => e.id)).toEqual([bench]);
  expect(store.list("workout_set", { parentId: plank })).toEqual([]);
  expect(ticks()).toHaveLength(0);
  await press("Bench Press");
  expect(ticks()).toHaveLength(1);
});

it("keeps the moved exercise’s control and unfinished set together through repeated moves", async () => {
  const workout = beginWorkout(store);
  const first = addExercise(store, workout, EXERCISES.bench, 0);
  const second = addExercise(store, workout, EXERCISES.bench, 0);
  const last = addExercise(store, workout, EXERCISES.plank, 0);
  const reveal = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  try {
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await typeInto("kg for set 1", "72.5");
    await press("Done typing");
    await press("Manage Bench Press");
    await press("Move Bench Press down from position 1");
    const focusedMove = async (label: string) => {
      const button = document.activeElement;
      if (!(button instanceof HTMLButtonElement)) throw Error("Move control lost focus");
      expect(button.getAttribute("aria-label")).toBe(label);
      await vi.waitFor(() => expect(reveal.mock.contexts).toContain(button));
      reveal.mockClear();
      return button;
    };
    const order = () =>
      store.list("workout_exercise", { parentId: workout }).map((entry) => entry.id);
    const down = await focusedMove("Move Bench Press down from position 2");
    expect(order()).toEqual([second, first, last]);
    await act(() => down.click());
    const up = await focusedMove("Move Bench Press up from position 3");
    expect(order()).toEqual([second, last, first]);
    await act(() => up.click());
    await focusedMove("Move Bench Press up from position 2");
    expect(order()).toEqual([second, first, last]);
    const weights = Array.from(host.querySelectorAll('button[aria-label="kg for set 1"]')).map(
      (cell) => cell.textContent,
    );
    // The typed weight moved with its exercise, now second.
    expect(weights).toEqual(["–", "72.5"]);
    expect(store.list("workout_set", { parentId: first })[0]?.content?.completedAt).toBeNull();
  } finally {
    reveal.mockRestore();
  }
});

it("saves notes during a workout and protects a newer note when the editor is stale", async () => {
  const id = beginWorkout(store);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const edit = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Workout description"]');
    if (!input) throw Error("Missing workout notes");
    await act(() => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const changeStored = (patch: Record<string, string>) => {
    const row = store.get("workout", id);
    if (!row?.content) throw Error("Missing workout");
    store.put("workout", id, { ...row.content, ...patch });
  };
  await render();
  await press("Edit workout details");
  expect(host.querySelector('input[aria-label="Workout duration"]')).toBeNull();
  await edit("Try a longer rest");
  await press("Cancel");
  expect(store.get("workout", id)?.content?.description).toBe("");
  await press("Edit workout details");
  await edit("Try a longer rest");
  changeStored({ title: "Evening session" });
  await press("Save changes");
  expect(store.get("workout", id)?.content).toMatchObject({
    title: "Evening session",
    description: "Try a longer rest",
    endedAt: null,
  });
  await render();
  await press("Edit workout details");
  await edit("My draft");
  changeStored({ description: "Updated on another device" });
  await press("Save changes");
  expect(host.textContent).toContain("Workout details changed");
  expect(store.get("workout", id)?.content?.description).toBe("Updated on another device");
});

it.each(["startedAt", "endedAt"] as const)(
  "protects a saved duration when %s changes while the History editor is open",
  async (field) => {
    const schedule = {
      title: "Evening",
      description: "",
      routineId: null,
      startedAt: "2021-01-02T18:00:00.000Z",
      endedAt: "2021-01-02T19:00:00.000Z",
    };
    store.put("workout", "evening", schedule);
    const saved = readWorkoutTree(store, "evening")?.workout;
    if (!saved) throw Error("Missing saved workout");
    const close = vi.fn();
    await act(() =>
      root.render(h(WorkoutDetailsEditor, { workout: saved, onClose: close, onDeleted: close })),
    );
    const duration = host.querySelector<HTMLInputElement>('input[aria-label="Workout duration"]');
    if (!duration) throw Error("Missing duration input");
    await act(() => {
      duration.value = "40:00";
      duration.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const changed = { ...schedule, [field]: "2021-01-02T18:50:00.000Z" };
    store.put("workout", "evening", changed);
    await press("Save changes");
    expect(close).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Workout details changed");
    expect(store.get("workout", "evening")?.content).toMatchObject(changed);
  },
);

it("shows the records before saving, then saves the workout and opens History at it", async () => {
  const past = beginWorkout(store);
  const pastEntry = addExercise(store, past, EXERCISES.bench, 0);
  const pastSet = store.list("workout_set", { parentId: pastEntry })[0];
  if (!pastSet) throw Error("Missing set");
  logSet(store, pastSet.id, { weightKg: 100, reps: 5 });
  finishWorkout(store, past, { countForRoutine: false });
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 0);
  addSet(store, entry);
  const [set] = store.list("workout_set", { parentId: entry });
  if (!set) throw Error("Missing set");
  logSet(store, set.id, { weightKg: 105, reps: 5 });
  await act(() => root.render(h(FinishScreen)));
  // Records are worked out before saving, each with what it beats.
  expect(host.textContent).toContain("New records");
  expect(host.textContent).toContain("Heaviest weight · was 100 kg105 kg");
  expect(host.textContent).toContain("1 unfinished. Only logged sets will be saved.");
  // Nothing is saved by looking.
  expect(store.get("workout", id)?.content?.endedAt).toBeNull();
  feedback.hold();
  await press("Save workout");
  const saving = host.querySelector<HTMLButtonElement>('button[aria-label="Saving workout…"]');
  expect(saving?.getAttribute("aria-busy")).toBe("true");
  expect(saving?.disabled).toBe(true);
  expect(preventRemoval).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Back to the workout"]')?.disabled,
  ).toBe(true);
  expect(
    host.querySelector('input[aria-label="Workout description"]')?.closest("[inert]"),
  ).toBeInstanceOf(HTMLElement);
  expect(store.get("workout", id)?.content?.endedAt).toBeNull();
  expect(navigateRoute).not.toHaveBeenCalled();
  await act(feedback.release);
  expect(preventRemoval).toBe(false);
  expect(store.get("workout", id)?.content?.endedAt).toEqual(expect.any(String));
  expect(store.list("workout_set", { parentId: entry })).toHaveLength(1);
  expect(navigateRoute).toHaveBeenCalledWith({ pathname: "/history", params: { saved: id } });
});

it.each(["kept", "deleted", "another running"] as const)(
  "saves the workout and then starts the routine chosen on Train (%s)",
  async (state) => {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 0);
    const [set] = store.list("workout_set", { parentId: entry });
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { weightKg: 60, reps: 5 });
    const next = createRoutine(
      store,
      "Pull day",
      null,
      [
        {
          id: "row",
          exercise: EXERCISES.bench,
          sets: [{ id: "a", values: { weight: "40", reps: "8" } }],
        },
      ],
      readSettings(store),
    );
    detailReturn = { next } as typeof detailReturn;
    await act(() => root.render(h(FinishScreen)));
    expect(host.textContent).toContain("Pull day starts after saving.");
    // Changed on another device while the summary was open: saving still saves.
    if (state === "deleted") store.delete("routine", next);
    const other = newId();
    if (state === "another running") {
      const content = store.get("workout", id)?.content;
      if (!content) throw Error("Missing workout");
      store.put("workout", other, { ...content, title: "On the iPad" });
    }
    toasts.length = 0;
    await press("Save workout");
    await act(feedback.release);
    expect(store.get("workout", id)?.content?.endedAt).toEqual(expect.any(String));
    if (state === "kept") {
      expect(store.activeWorkout()?.content).toMatchObject({ routineId: next, endedAt: null });
      expect(pushRoute).toHaveBeenCalledWith("/workout/active");
      expect(navigateRoute).not.toHaveBeenCalled();
      expect(toasts).toEqual(["Workout added to History"]);
    } else {
      // Nothing else starts, and the running workout from the iPad isn't opened in its place.
      expect(store.activeWorkout()?.id ?? null).toBe(state === "deleted" ? null : other);
      expect(pushRoute).not.toHaveBeenCalled();
      expect(navigateRoute).toHaveBeenCalledWith({ pathname: "/history", params: { saved: id } });
      expect(toasts).toEqual(["Workout added to History. Pull day couldn’t be started."]);
    }
  },
);

it("sets how long the workout lasted before saving it, by the same rules as a saved one", async () => {
  const id = beginWorkout(store);
  const row = store.get("workout", id);
  if (!row?.content) throw Error("Missing workout");
  // Started two hours ago.
  const startedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  store.put("workout", id, { ...row.content, startedAt });
  const entry = addExercise(store, id, EXERCISES.bench, 0);
  const [set] = store.list("workout_set", { parentId: entry });
  if (!set) throw Error("Missing set");
  logSet(store, set.id, { weightKg: 60, reps: 5 });
  await act(() => root.render(h(FinishScreen)));
  const time = () =>
    Array.from(host.querySelectorAll("button")).find((el) =>
      el.getAttribute("aria-label")?.startsWith("Time "),
    );
  expect(time()?.getAttribute("aria-label")).toMatch(/Change the duration$/);
  const type = async (text: string) => {
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Workout duration"]');
    if (!field) throw Error("Missing duration field");
    await act(() => {
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await act(() => time()?.click());
  // Longer than it has run: it would end after now.
  await type("3:00:00");
  await press("Set duration");
  expect(host.textContent).toContain(
    "Enter a duration that ends between the workout start and now.",
  );
  await type("soon");
  await press("Set duration");
  expect(host.textContent).toContain(
    "Enter a duration in minutes:seconds or hours:minutes:seconds.",
  );
  await type("45:00");
  await press("Set duration");
  expect(host.querySelector('input[aria-label="Workout duration"]')).toBeNull();
  expect(time()?.getAttribute("aria-label")).toContain("45");
  // Nothing is saved until Save workout.
  expect(store.get("workout", id)?.content?.endedAt).toBeNull();
  await press("Save workout");
  expect(store.get("workout", id)?.content).toMatchObject({
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 45 * 60_000).toISOString(),
  });
  expect(store.list("workout_set", { parentId: entry })).toHaveLength(1);
});

it("discards the workout from Finish only once the action sheet is confirmed", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.plank, 30);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing set");
  logSet(store, set.id, { durationSeconds: 30 });
  await act(() => root.render(h(FinishScreen)));
  await press("Discard workout");
  expect(store.get("workout", id)?.deleted).toBe(false);
  expect(host.textContent).toContain("This workout and its 1 logged set will be deleted.");
  await press("Keep training");
  await act(() => root.render(h(FinishScreen)));
  expect(store.get("workout", id)?.deleted).toBe(false);
  await press("Discard workout");
  await confirmAction("Discard workout");
  expect(store.activeWorkout()).toBeNull();
});

it("keeps a Finish note draft open if another device changes the same note while typing", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.plank, 30);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing set");
  logSet(store, set.id, { durationSeconds: 30 });
  await act(() => root.render(h(FinishScreen)));
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Workout description"]');
  if (!field) throw Error("Missing Finish notes field");
  await act(() => {
    field.value = "Local draft";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const row = store.get("workout", id);
  if (!row?.content) throw Error("Missing workout");
  store.put("workout", id, { ...row.content, description: "New note on another device" });
  await act(() => root.render(h(FinishScreen)));
  await press("Save workout");
  expect(host.textContent).toContain("Workout details changed");
  expect(field.value).toBe("Local draft");
  expect(store.get("workout", id)?.content).toMatchObject({
    description: "New note on another device",
    endedAt: null,
  });
});

it("cancels rest when undoing its set and keeps rest when undoing an earlier set", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  onTestFinished(() => now.mockRestore());
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 90);
  addSet(store, entry);
  for (const set of store.list("workout_set", { parentId: entry }))
    updateSet(store, set.id, { reps: 8, weightKg: 40 });
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  await press("Log set 1");
  await press("Log set 2");
  await render();
  await press("Undo logged set 1");
  await render();
  const more = host.querySelector<HTMLButtonElement>('[aria-label="15 seconds more"]');
  if (!more) throw Error("Undoing a different set cleared the timer");
  await act(() => {
    more.click();
    more.click();
  });
  expect(host.textContent).toContain("2:00");
  await press("Undo logged set 2");
  await render();
  expect(host.textContent).not.toContain("Skip");
});

it("ignores a queued Skip from the previous set after a new rest has started", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 90);
  addSet(store, entry);
  for (const set of store.list("workout_set", { parentId: entry }))
    updateSet(store, set.id, { reps: 8 });
  await act(() => root.render(h(ActiveWorkoutScreen)));
  await press("Log set 1");
  const log = host.querySelector<HTMLButtonElement>('[aria-label="Log set 2"]');
  const skip = Array.from(host.querySelectorAll("button")).find((el) => el.textContent === "Skip");
  if (!log || !skip) throw Error("Missing controls for the next set and current rest");
  await act(() => {
    log.click();
    skip.click();
  });
  expect(host.textContent).toContain("Skip");
  await press("Skip");
  expect(host.textContent).not.toContain("Skip");
});

it.each(["remove", "move"])(
  "ends rest on both screens after a synced exercise changes owner (%s)",
  async (action) => {
    const original = store;
    const world = new World();
    try {
      const server = world.server();
      const editor = await world.phone("timer", {
        server: "s",
        account: "alice",
        transport: server.transport("alice"),
      });
      store = editor.store;
      const workout = beginWorkout(store);
      const entry = addExercise(store, workout, EXERCISES.bench, 90);
      const set = store.list("workout_set", { parentId: entry })[0];
      if (!set) throw Error("Missing first set");
      updateSet(store, set.id, { reps: 8 });
      await act(() => root.render(h(ActiveWorkoutScreen)));
      await press("Log set 1");
      await editor.sync();
      await press("Minimise workout");
      const bar = () => act(() => root.render(h(MiniPlayer)));
      await bar();
      expect(host.textContent).toContain("Rest");
      const parent = store.get("workout_exercise", entry)?.content;
      if (!parent) throw Error("Missing synced exercise");
      if (action === "remove") removeWorkoutExercise(store, workout, entry);
      else store.put("workout_exercise", entry, { ...parent, workoutId: "another-session" });
      expect(store.get("workout_set", set.id)?.content?.completedAt).toBeTruthy();
      version++;
      await bar();
      expect(host.querySelector('[aria-label="Resume Workout"]')).not.toBeNull();
      expect(host.textContent).not.toContain("Rest");
      await act(() => root.render(h(ActiveWorkoutScreen)));
      expect(host.textContent).not.toContain("Skip");
      store.put("workout_exercise", entry, parent);
      version++;
      await bar();
      expect(host.textContent).not.toContain("Rest");
      await act(() => root.render(h(ActiveWorkoutScreen)));
      expect(host.querySelector('[aria-label="Undo logged set 1"]')).not.toBeNull();
      expect(host.textContent).not.toContain("Skip");
    } finally {
      await act(() => root.render(null));
      store = original;
      await world.dispose();
    }
  },
);

it("opens a replacement workout without the previous workout’s rest countdown", async () => {
  const first = beginWorkout(store);
  const entry = addExercise(store, first, EXERCISES.bench, 90);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing bench set");
  updateSet(store, set.id, { reps: 8 });
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  await press("Log set 1");
  await press("Minimise workout");
  await render();
  expect(host.textContent).toContain("Skip");
  await press("Minimise workout");
  finishWorkout(store, first, { countForRoutine: false });
  const second = beginWorkout(store);
  addExercise(store, second, EXERCISES.ohp, 30);
  await render();
  expect(host.textContent).not.toContain("Skip");
});

it("keeps rest local to the phone that checked a set and stops after a different completion syncs", async () => {
  const original = store;
  const world = new World();
  try {
    const server = world.server();
    const account = { server: "s", account: "alice", transport: server.transport("alice") };
    const editor = await world.phone("timer", account);
    const other = await world.phone("other", account);
    store = editor.store;
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 90);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing first set");
    updateSet(store, set.id, { reps: 8 });
    const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
    await render();
    await press("Log set 1");
    await editor.sync();
    await other.sync();
    await press("Minimise workout");
    store = other.store;
    await render();
    expect(host.textContent).not.toContain("Skip");
    updateSet(other.store, set.id, { reps: 9 });
    await other.sync();
    await editor.sync();
    await press("Minimise workout");
    store = editor.store;
    await render();
    expect(host.textContent).toContain("Skip");
    const completed = other.store.get("workout_set", set.id)?.content?.completedAt;
    if (typeof completed !== "string") throw Error("Missing synced completion time");
    updateSet(other.store, set.id, {
      completedAt: new Date(Date.parse(completed) + 1000).toISOString(),
    });
    await other.sync();
    await editor.sync();
    version++;
    await render();
    expect(host.querySelector('[aria-label="Undo logged set 1"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Skip");
  } finally {
    await act(() => root.render(null));
    store = original;
    await world.dispose();
  }
});

it("changes rest for one exercise from its card and restores the interval on reopen", async () => {
  const workout = beginWorkout(store);
  const bench = addExercise(store, workout, EXERCISES.bench, 90);
  const plank = addExercise(store, workout, EXERCISES.plank, 30);
  const first = store.list("workout_set", { parentId: plank })[0];
  const neighbour = store.list("workout_set", { parentId: bench })[0];
  if (!first || !neighbour) throw Error("Missing sets");
  updateSet(store, first.id, { durationSeconds: 30 });
  updateSet(store, addSet(store, plank), { durationSeconds: 45 });
  updateSet(store, neighbour.id, { reps: 8, weightKg: 20 });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  onTestFinished(() => now.mockRestore());
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const typeRest = async (digits: string) => {
    await press("Type");
    for (const key of digits) await pressKey(key);
  };
  await render();
  await press("Manage Plank");
  await press("Rest timer for Plank, 0:30");
  expect(host.querySelector('[aria-label="Close exercise options"]')).toBeNull();
  expect(host.querySelector('[aria-label="Set rest to 0:30"]')).not.toBeNull();
  // A typed time past the longest rest an exercise can have stops at that hour.
  await typeRest("6100");
  expect(host.querySelector('[aria-label="Set rest to 1:00:00"]')).not.toBeNull();
  await press("Cancel");
  expect(store.get("workout_exercise", plank)?.content?.restSeconds).toBe(30);
  await press("Rest 0:30 for Plank. Change it");
  await typeRest("115");
  await press("Set rest to 1:15");
  expect(store.get("workout_exercise", plank)?.content?.restSeconds).toBe(75);
  expect(store.get("workout_exercise", bench)?.content?.restSeconds).toBe(90);
  await act(() => root.render(null));
  await render();
  expect(host.querySelector('[aria-label="Rest 1:15 for Plank. Change it"]')).not.toBeNull();
  await press("Bench Press");
  await press("Log set 1");
  expect(host.textContent).toContain("1:15");
  await press("Rest 1:15 for Plank. Change it");
  await typeRest("0");
  await press("Set rest to Off");
  expect(store.get("workout_exercise", plank)?.content?.restSeconds).toBe(0);
  await render();
  await press("Log set 2");
  expect(host.textContent).not.toContain("Skip");
  expect(
    store.list("workout_set", { parentId: plank }).every((set) => set.content?.completedAt),
  ).toBe(true);
  await press("Bench Press");
  await press("Log set 1");
  expect(host.textContent).toContain("1:30");
  await press("Skip");
});

it("drops an unfinished entry when undoing a set logged while the workout was minimised", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 0);
  const [set] = store.list("workout_set", { parentId: entry });
  if (!set) throw Error("Missing bench set");
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  await typeInto("kg for set 1", "70");
  await press("Minimise workout");
  change((db) => logSet(db, set.id, { weightKg: 80, reps: 8 }), "active-workout");
  await render();
  await press("Undo logged set 1");
  await render();
  // Not the 70 typed before: the stored 80 is suggested.
  expect(fieldText("kg for set 1")).toBe("80");
  await press("Log set 1");
  expect(store.get("workout_set", set.id)?.content?.weightKg).toBe(80);
});

it("keeps unfinished inputs private to each open device copy of the same workout", async () => {
  const original = store;
  const workout = beginWorkout(original);
  addExercise(original, workout, EXERCISES.bench, 0);
  const other = await openDeviceStore({
    engine: createSqlJsEngine(sql),
    path: "/second.db",
    appVersion: "test",
  });
  const open = async (device: DeviceStore) => {
    await act(() => root.render(null));
    store = device;
    await act(() => root.render(h(ActiveWorkoutScreen)));
  };
  try {
    for (const kind of ["workout", "workout_exercise", "workout_set"]) {
      for (const row of original.list(kind)) {
        if (row.content) other.put(kind, row.id, row.content);
      }
    }
    await open(original);
    await typeInto("kg for set 1", "72.5");
    await open(other);
    expect(fieldText("kg for set 1")).toBe("–");
    await typeInto("kg for set 1", "58");
    await open(original);
    expect(fieldText("kg for set 1")).toBe("72.5");
    await open(other);
    expect(fieldText("kg for set 1")).toBe("58");
  } finally {
    await act(() => root.render(null));
    store = original;
    other.close();
  }
});

it.each(["completed", "conflict"] as const)(
  "lets editable sets switch distance units after another set becomes %s while minimised",
  async (state) => {
    const original = store;
    const world = new World();
    try {
      const server = world.server();
      const account = { server: "s", account: "alice", transport: server.transport("alice") };
      const editor = await world.phone("editor", account);
      const other = await world.phone("other", account);
      store = editor.store;
      const workout = beginWorkout(store);
      const entry = addExercise(
        store,
        workout,
        { id: "qa-run", name: "Run", type: "distance_duration" },
        0,
      );
      const first = store.list("workout_set", { parentId: entry })[0];
      if (!first) throw Error("Missing first set");
      addSet(store, entry);
      await editor.sync();
      await other.sync();
      const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
      await render();
      await typeInto("km for set 1", "0.");
      await press("Done typing");
      await press("Distance in km. Switch to m");
      expect(host.textContent).toContain("Finish entering the distance");
      await press("Minimise workout");
      if (state === "completed") {
        logSet(other.store, first.id, { distanceMeters: 450, durationSeconds: 75 });
      } else {
        updateSet(store, first.id, { distanceMeters: 400 });
        updateSet(other.store, first.id, { distanceMeters: 450 });
      }
      await other.sync();
      await editor.sync();
      version++;
      await render();
      if (state === "completed")
        expect(store.get("workout_set", first.id)?.content?.completedAt).toEqual(
          expect.any(String),
        );
      else expect(store.get("workout_set", first.id)?.status).toBe("conflict");
      // The unfinished distance went with the set's completion or review.
      expect(fieldText("km for set 1")).not.toBe("0.");
      await press("Distance in km. Switch to m");
      expect(fieldText("m for set 2")).not.toBeNull();
      expect(host.textContent).not.toContain("Finish entering the distance");
    } finally {
      await act(() => root.render(null));
      store = original;
      await world.dispose();
    }
  },
);

it("restores the chosen distance unit and unfinished text only for the minimised workout", async () => {
  const run: BuiltInExercise = { id: "qa-run", name: "Run", type: "distance_duration" };
  saveSettings(store, { distanceUnit: "km", shortDistanceUnit: "m" });
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, run, 0);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  await press("Distance in km. Switch to m");
  await typeInto("m for set 1", "450.");
  await press("Minimise workout");
  await render();
  expect(fieldText("m for set 1")).toBe("450.");
  expect(store.list("workout_set", { parentId: entry })[0]?.content).toMatchObject({
    distanceMeters: null,
    completedAt: null,
  });
  change((db) => {
    discardWorkout(db, workout);
    addExercise(db, beginWorkout(db), run, 0);
  }, "active-workout");
  await render();
  expect(fieldText("km for set 1")).toBe("–");
  expect(host.querySelector('[aria-label="m for set 1"]')).toBeNull();
});

it("keeps the weight typed in an unfinished set when synced preferences switch units", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 0);
  addSet(store, entry);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const enter = typeInto;
  await render();
  await enter("kg for set 1", "40,125");
  await enter("kg for set 2", "50");
  await press("Minimise workout");
  expect(fieldText("kg for set 1")).toBeNull();
  expect(
    store.list("workout_set", { parentId: entry }).map((row) => row.content?.weightKg),
  ).toEqual([null, null]);
  change((db) => saveSettings(db, { weightUnit: "lbs" }));
  await render();
  expect(fieldText("lbs for set 1")).toBe("88.46");
  await enter("reps for set 1", "8");
  await press("Log set 1");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content).toMatchObject({
    weightKg: 40.125,
    reps: 8,
  });
  // The second set is edited in pounds, then logged after switching back to kilograms.
  await enter("lbs for set 2", "100");
  change((db) => saveSettings(db, { weightUnit: "kg" }));
  await render();
  expect(fieldText("kg for set 2")).toBe("45.36");
  await enter("reps for set 2", "6");
  await press("Log set 2");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[1]?.content).toMatchObject({
    weightKg: 45.359,
    reps: 6,
  });
});

it("uses a corrected previous set while the current workout stays open", async () => {
  const past = beginWorkout(store);
  const oldEntry = addExercise(store, past, EXERCISES.bench, 0);
  const [oldSet] = store.list("workout_set", { parentId: oldEntry });
  if (!oldSet) throw Error("Missing previous bench set");
  logSet(store, oldSet.id, { weightKg: 80, reps: 8 });
  finishWorkout(store, past, { countForRoutine: false });
  const current = beginWorkout(store);
  const entry = addExercise(store, current, EXERCISES.bench, 0);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  expect(host.textContent).toContain("80 × 8");

  change((db) => updateSet(db, oldSet.id, { weightKg: 75, reps: 9 }));
  await render();
  expect(host.textContent).toContain("75 × 9");
  const list = vi.spyOn(store, "list");
  await press("Log set 1");
  await render();
  expect(store.list("workout_set", { parentId: entry })[0]?.content).toMatchObject({
    weightKg: 75,
    reps: 9,
  });
  expect(
    list.mock.calls.filter(
      ([kind, options]) => kind === "workout_set" && !options?.parentId && !options?.parentIds,
    ),
  ).toHaveLength(0);
});

it("hints a routine weight only where no weight was logged last time", async () => {
  const past = beginWorkout(store);
  const priorEntry = addExercise(store, past, EXERCISES.bench, 0);
  const priorSet = store.list("workout_set", { parentId: priorEntry })[0];
  if (!priorSet) throw Error("Missing previous set");
  logSet(store, priorSet.id, { weightKg: 92.5, reps: 6 });
  finishWorkout(store, past, { countForRoutine: false });
  const routine = createRoutine(
    store,
    "Light day",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        useRepRange: true,
        sets: [
          { id: "work", values: { weight: "40", repRangeMin: "8", repRangeMax: "10" } },
          { id: "unloaded", values: { weight: "0", repRangeMin: "10", repRangeMax: "12" } },
        ],
      },
    ],
    readSettings(store),
  );
  const workout = beginWorkout(store, routine);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  expect(host.textContent).toContain("92.5 × 6");
  // Last time's 92.5 kg leads set 1; set 2 has no history, so its routine weight still shows.
  expect(fieldTarget("kg for set 1")).toBeNull();
  expect(fieldTarget("reps for set 1")).toBe("8–10");
  expect(fieldTarget("kg for set 2")).toBe("0");
  expect(fieldTarget("reps for set 2")).toBe("10–12");
  expect(fieldText("reps for set 2")).toBe("10");
  // The dock follows the same rule for the set it logs next.
  expect(field("Type weight")?.textContent).toMatch(/^92\.5kg/);
  expect(field("Type weight")?.textContent).not.toContain("·");
  expect(field("Type reps")?.textContent).toBe("6reps · 8–10");
  await act(() => saveShowTargets(false));
  expect(fieldTarget("kg for set 1")).toBeNull();
  expect(fieldTarget("reps for set 1")).toBeNull();
  expect(fieldText("kg for set 1")).toBe("92.5");
  expect(fieldText("reps for set 1")).toBe("6");
  expect(fieldText("kg for set 2")).toBe("0");
  expect(host.textContent).not.toMatch(/\bTarget\b/);
  await act(() => saveShowTargets(true));
  change((db) => saveSettings(db, { weightUnit: "lbs" }));
  await render();
  expect(fieldTarget("lbs for set 1")).toBeNull();
  expect(fieldTarget("lbs for set 2")).toBe("0");
  expect(fieldTarget("reps for set 1")).toBe("8–10");
  await press("Log set 1");
  await render();
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content).toMatchObject({
    weightKg: 92.5,
    reps: 6,
  });
  expect(fieldTarget("lbs for set 1")).toBeNull();
  expect(fieldTarget("lbs for set 2")).toBe("0");
  expect(field("Type weight")?.textContent).toMatch(/lbs · 0$/);
});

it("keeps previous running values and the next set’s planned duration in the fields", async () => {
  const run: BuiltInExercise = { id: "run", name: "Run", type: "distance_duration" };
  const past = beginWorkout(store);
  const entry = addExercise(store, past, run, 0);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing previous run");
  logSet(store, first.id, { distanceMeters: 2000, durationSeconds: 900 });
  finishWorkout(store, past, { countForRoutine: false });
  saveSettings(store, { distanceUnit: "km", shortDistanceUnit: "m" });
  const routine = createRoutine(
    store,
    "Intervals",
    null,
    [
      {
        id: "run",
        exercise: run,
        sets: [
          { id: "work", values: { distance: "1.2", duration: "5:30" } },
          { id: "recovery", values: { duration: "1:37" } },
        ],
      },
    ],
    readSettings(store),
  );
  const workout = beginWorkout(store, routine);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  expect(fieldTarget("km for set 1")).toBe("1.2");
  expect(fieldTarget("time for set 1")).toBe("5:30");
  expect(fieldTarget("time for set 2")).toBe("1:37");
  await press("Distance in km. Switch to m");
  expect(fieldTarget("m for set 1")).toBe("1200");
  await press("Log set 1");
  await render();
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content).toMatchObject({
    distanceMeters: 2000,
    durationSeconds: 900,
  });
  expect(fieldTarget("time for set 2")).toBe("1:37");
  expect(fieldTarget("m for set 1")).toBe("1200");
});

it.each([
  ["steps_duration", "12", 85, 85],
  ["floors_duration", "1", 0, 0],
  ["steps_duration", "12", null, 12],
] as const)(
  "shows the planned count and reuses the last logged count for %s",
  async (type, count, previousCount, expectedCount) => {
    const exercise = { id: type, name: "Climb", type };
    const previous = beginWorkout(store);
    const entry = addExercise(store, previous, exercise, 0);
    const first = store.list("workout_set", { parentId: entry })[0];
    if (!first) throw Error("Missing previous climb");
    logSet(store, first.id, { count: previousCount, durationSeconds: 70 });
    finishWorkout(store, previous, { countForRoutine: false });
    const routine = createRoutine(
      store,
      "Climb",
      null,
      [
        {
          id: "climb",
          exercise,
          sets: [{ id: "work", values: { count, duration: "30" } }],
        },
      ],
      readSettings(store),
    );
    const workout = beginWorkout(store, routine);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(fieldTarget("count for set 1")).toBe(count);
    expect(fieldTarget("time for set 1")).toBe("0:30");
    expect(host.textContent).toContain(`${previousCount ?? "–"} × 1:10`);
    expect(fieldText("count for set 1")).toBe(String(expectedCount));
    await press("Log set 1");
    expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content).toMatchObject({
      count: expectedCount,
      durationSeconds: 70,
    });
  },
);

it.each([
  { completed: true, countForRoutine: true, movedPreviously: false, weightKg: 50, reps: 12 },
  { completed: true, countForRoutine: true, movedPreviously: true, weightKg: 50, reps: 12 },
  { completed: true, countForRoutine: false, movedPreviously: true, weightKg: 50, reps: 12 },
  { completed: false, countForRoutine: true, movedPreviously: true, weightKg: 40, reps: 8 },
])(
  "keeps previous loads with reordered routine exercises (completed=$completed, credited=$countForRoutine, previously moved=$movedPreviously)",
  async ({ completed, countForRoutine, movedPreviously, weightKg, reps }) => {
    const routine = createRoutine(
      store,
      "Bench twice",
      null,
      ["heavy", "light"].map((id) => ({
        id,
        exercise: EXERCISES.bench,
        sets: [{ id: `${id}-set`, values: { weight: "40", reps: "8" } }],
      })),
      readSettings(store),
    );
    const earlier = beginWorkout(store, routine);
    const priorEntries = readWorkoutTree(store, earlier)?.entries;
    const heavy = priorEntries?.[0]?.sets[0];
    const lightEntry = priorEntries?.[1];
    const light = lightEntry?.sets[0];
    if (!heavy || !lightEntry || !light) throw Error("Expected two planned bench sets");
    if (movedPreviously) moveWorkoutExercise(store, earlier, lightEntry.entry.id, -1);
    logSet(store, heavy.id, { weightKg: 85, reps: 4 });
    if (completed) logSet(store, light.id, { weightKg: 50, reps: 12 });
    finishWorkout(store, earlier, { countForRoutine });
    const current = beginWorkout(store, routine);
    const secondEntry = readWorkoutTree(store, current)?.entries[1];
    if (!secondEntry) throw Error("Missing second planned bench");
    moveWorkoutExercise(store, current, secondEntry.entry.id, -1);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Log set 1");
    const recorded = readWorkoutTree(store, current)?.entries[0];
    expect(recorded?.entry.id).toBe(secondEntry.entry.id);
    expect(recorded?.sets[0]?.content).toMatchObject({ weightKg, reps });
    if (completed) expect(host.textContent).toContain("50 × 12");
    expect(host.textContent).toContain("85 × 4");
  },
);

it("omits the planned effort caption and logs effort only when entered", async () => {
  const plan = writePlan(
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        sets: [
          { id: "first", values: { reps: "8", weight: "40" } },
          { id: "second", values: { reps: "6", weight: "42" } },
        ],
      },
      {
        id: "plank",
        exercise: EXERCISES.plank,
        sets: [{ id: "hold", values: { duration: "30" } }],
      },
    ],
    readSettings(store),
  );
  const effortBySet: Record<string, number> = { first: 7.5, second: 8, hold: 9 };
  const routine = {
    title: "Effort targets",
    folderId: null,
    position: 1,
    notes: "",
    exercises: plan.map((entry) => ({
      ...entry,
      restSeconds: 0,
      sets: entry.sets.map((set) => ({ ...set, rpe: effortBySet[set.id] ?? null })),
    })),
  };
  store.put("routine", "effort", routine);
  const workout = beginWorkout(store, "effort");
  store.put("routine", "effort", { ...routine, exercises: [] });
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  expect(fieldTarget("RPE for set 1")).toBe("7.5");
  expect(fieldTarget("RPE for set 2")).toBe("8");
  expect(field("RPE for set 1")?.textContent).toBe("–7.5");
  await press("Log set 1");
  await render();
  expect(fieldTarget("RPE for set 1")).toBe("7.5");
  expect(fieldTarget("RPE for set 2")).toBe("8");
  const completed = readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content;
  expect(completed?.completedAt).toEqual(expect.any(String));
  expect(completed?.rpe).toBeNull();
  expect(completed?.repsInReserve ?? null).toBeNull();
});

it("keeps the original effort scale and numbers in a running workout and in history", async () => {
  saveSettings(store, { trackRepsInReserve: true });
  const routineId = createRoutine(
    store,
    "Push A",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        restSecondsText: "0",
        sets: [
          { id: "work1", values: { reps: "10" }, effortText: "2" },
          { id: "work2", values: { reps: "10" }, effortText: "2" },
        ],
      },
    ],
    readSettings(store),
    "",
    "rir",
  );
  const originalId = beginWorkout(store, routineId);
  const saved = store.get("routine", routineId)?.content;
  if (!saved) throw Error("Missing routine");
  // Change the routine while its RIR workout is already running.
  const exercises = writePlan(
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        restSecondsText: "60",
        sets: [{ id: "work1", values: { reps: "10" }, effortText: "8.5" }],
      },
    ],
    readSettings(store),
    "rpe",
  );
  store.put("routine", routineId, { ...saved, effortScale: "rpe", exercises });
  const live = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await live();
  expect(fieldTarget("reps in reserve for set 1")).toBe("2");
  await press("Log set 1");
  await press("1 reps in reserve");
  await press("Log set 2");
  await press("2 reps in reserve");
  const original = readWorkoutTree(store, originalId);
  expect(original?.workout.content.initialPlan?.effortScale).toBe("rir");
  expect(
    original?.entries[0]?.sets.map(({ content }) => [content.repsInReserve, content.rpe]),
  ).toEqual([
    [1, null],
    [2, null],
  ]);
  const nextId = change((db) => {
    finishWorkout(db, originalId, { countForRoutine: false });
    return beginWorkout(db, routineId);
  });
  await live();
  expect(field("reps in reserve for set 1")).toBeNull();
  expect(fieldTarget("RPE for set 1")).toBe("8.5");
  await press("Log set 1");
  expect(field("Skip rest")).not.toBeNull();
  expect(field("Skip, no RPE for set 1")).not.toBeNull();
  expect(readWorkoutTree(store, nextId)?.entries[0]?.sets[0]?.content.rpe).toBeNull();
  await press("RPE 8.5");
  expect(readWorkoutTree(store, nextId)?.entries[0]?.sets[0]?.content.rpe).toBe(8.5);
  finishWorkout(store, nextId, { countForRoutine: false });
  detailId = originalId;
  await act(() => root.render(h(WorkoutDetailScreen)));
  expect(host.textContent).toContain("RIR");
  expect(host.textContent).not.toContain("RPE");
  await press("Edit set 2");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Reps in reserve"]')?.value).toBe(
    "2",
  );
  await act(() => root.render(null));
  detailId = nextId;
  await act(() => root.render(h(WorkoutDetailScreen)));
  expect(host.textContent).toContain("RPE");
  expect(host.textContent).not.toContain("RIR");
  expect(host.textContent).toContain("8.5");
});

it("shows planned effort in the dock and can record actual effort with captions off", async () => {
  const routine = createRoutine(
    store,
    "Push",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        restSecondsText: "0",
        sets: [
          { id: "work", values: { reps: "8" }, effortText: "8.5" },
          { id: "next", values: { reps: "8" }, effortText: "7.5" },
        ],
      },
    ],
    readSettings(store),
    "",
    "rpe",
  );
  const workout = beginWorkout(store, routine);
  await act(() => root.render(h(ActiveWorkoutScreen)));
  expect(field("RPE in dock")?.textContent).toBe("RPE–8.5");
  expect(field("RPE 8.5")).toBeNull();
  await press("Bench Press");
  expect(field("reps for set 1")).toBeNull();
  await press("RPE in dock");
  await press("RPE 7.5");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content.rpe).toBe(7.5);
  expect(field("Log set 1 of Bench Press")).not.toBeNull();
  await press("RPE in dock");
  await press("Clear effort");
  await press("Bench Press");
  await press("reps for set 2");
  await press("Done typing");
  expect(field("RPE in dock")?.textContent).toBe("RPE–7.5");
  await act(() => saveShowTargets(false));
  expect(field("RPE in dock")).toBeNull();
  await press("Log set 1");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content.rpe).toBeNull();
  expect(field("RPE for set 1")).toBeNull();
  expect(field("RPE 8.5")).toBeNull();
  await press("Edit set 1");
  await press("Edit RPE");
  await press("RPE 8.5");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content.rpe).toBe(8.5);
  expect(fieldText("RPE for set 1")).toBe("8.5");
});

it("records RPE 6 or less on the pad that 6− opens, in half steps from 1 to 10", async () => {
  const routine = createRoutine(
    store,
    "Easy",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        restSecondsText: "0",
        sets: [
          { id: "light", values: { reps: "8" }, effortText: "4.5" },
          { id: "next", values: { reps: "8" }, effortText: "6" },
        ],
      },
    ],
    readSettings(store),
    "",
    "rpe",
  );
  saveSettings(store, { trackRepsInReserve: true });
  const workout = beginWorkout(store, routine);
  const rpe = () => readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content.rpe;
  await act(() => root.render(h(ActiveWorkoutScreen)));
  expect(fieldTarget("RPE for set 1")).toBe("4.5");
  await press("Log set 1");
  // The strip offers 6− in place of a plain 6, and nothing below it.
  expect(field("RPE 6")).toBeNull();
  expect(field("RPE 5")).toBeNull();
  await press("6 or less: opens the number pad");
  // The pad opens on 6, takes a decimal point, and records only on Done.
  expect(fieldText("RPE for set 1")).toBe("6");
  expect(field("Decimal point")).not.toBeNull();
  expect(rpe()).toBeNull();
  // 0 isn't an RPE, and only halves follow the point: 4.3 is refused, 4.5 kept.
  await pressKey("0");
  expect(fieldText("RPE for set 1")).toBe("6");
  await pressKey("4");
  await pressKey("Decimal point");
  await pressKey("3");
  await pressKey("5");
  expect(fieldText("RPE for set 1")).toBe("4.5");
  await press("Done");
  expect(rpe()).toBe(4.5);
  // It reopens on the logged value; steps go by half and stop at 1.
  await press("RPE for set 1");
  await press("6 or less: opens the number pad");
  expect(fieldText("RPE for set 1")).toBe("4.5");
  for (let i = 0; i < 9; i++) await press("Step down 0.5");
  expect(fieldText("RPE for set 1")).toBe("1");
  await press("Step up 0.5");
  await press("Done");
  expect(rpe()).toBe(1.5);
  // Values the strip already offers are still picked directly.
  await press("RPE for set 1");
  await press("RPE 7.5");
  expect(rpe()).toBe(7.5);
});

it("shows a legacy RPE target beside the actual RIR without reinterpreting either", async () => {
  const routine = createRoutine(
    store,
    "Previous build",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        sets: [{ id: "work", values: { reps: "8" }, effortText: "8.5" }],
      },
    ],
    readSettings(store),
    "",
    "rpe",
  );
  const workout = beginWorkout(store, routine);
  const record = store.get("workout", workout)?.content;
  const plan = record?.initialPlan;
  if (!record || !plan || typeof plan !== "object" || !("effortScale" in plan))
    throw Error("Missing original plan");
  const { effortScale: _scale, ...legacyPlan } = plan;
  store.put("workout", workout, { ...record, initialPlan: legacyPlan });
  const logged = readWorkoutTree(store, workout)?.entries[0]?.sets[0];
  if (!logged) throw Error("Missing legacy set");
  logSet(store, logged.id, { reps: 8, repsInReserve: 1 });
  await act(() => root.render(h(ActiveWorkoutScreen)));
  expect(fieldText("reps in reserve for set 1")).toBe("1");
  expect(fieldTarget("reps in reserve for set 1")).toBe("RPE 8.5");
});

it("shows the original scale of each logged effort in an older running workout", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 0);
  const first = readWorkoutTree(store, workout)?.entries[0]?.sets[0];
  if (!first) throw Error("Missing legacy set");
  const second = addSet(store, entry);
  logSet(store, first.id, { reps: 8, rpe: 8.5 });
  logSet(store, second, { reps: 8, repsInReserve: 0, rpe: 8 });
  await act(() => root.render(h(ActiveWorkoutScreen)));
  expect(fieldText("RPE for set 1")).toBe("RPE 8.5");
  expect(field("reps in reserve for set 2")?.textContent).toBe("RIR 0RPE 8");
  await press("RPE for set 1");
  await press("RPE 9");
  expect(readWorkoutTree(store, workout)?.entries[0]?.sets[0]?.content.rpe).toBe(9);
  expect(fieldText("RPE for set 1")).toBe("RPE 9");
});

it("shows a factual top-of-range cue only after the original working sets all qualify", async () => {
  const routine = createRoutine(
    store,
    "Range day",
    null,
    [
      {
        id: "bench",
        exercise: EXERCISES.bench,
        restSecondsText: "0",
        useRepRange: true,
        sets: [
          { id: "warmup", type: "warmup", values: { reps: "5" } },
          { id: "work1", values: { repRangeMin: "8", repRangeMax: "12" } },
          { id: "work2", type: "failure", values: { repRangeMin: "15", repRangeMax: "15" } },
          { id: "drop", type: "drop", values: { repRangeMin: "8", repRangeMax: "12" } },
        ],
      },
    ],
    readSettings(store),
  );
  const workout = beginWorkout(store, routine);
  const tree = readWorkoutTree(store, workout);
  const [entry] = tree?.entries ?? [];
  const [, first, second] = entry?.sets ?? [];
  if (!entry || !first || !second) throw Error("Missing planned work");
  logSet(store, first.id, { reps: 12 });
  logSet(store, second.id, { reps: 14 });
  const extra = addSet(store, entry.entry.id);
  logSet(store, extra, { reps: 20 });
  const live = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await live();
  expect(host.textContent).not.toContain("Top of range");
  change((db) => updateSet(db, second.id, { reps: 15 }), "active-workout");
  await live();
  expect(host.textContent).toContain("Top of range in all 2 sets");
  change((db) => {
    finishWorkout(db, workout, { countForRoutine: false });
    beginWorkout(db, routine);
  });
  await live();
  expect(host.textContent).toContain("Last time · Top of range in all 2 sets");
  store.applyPushResults(
    store.prepareSubmissions("1.0").map(({ submission }, i) => ({
      submissionId: submission.submissionId,
      status: "accepted",
      revision: i + 1,
    })),
  );
  const synced = store.get("workout_set", second.id)?.server?.content;
  if (!synced) throw Error("Missing acknowledged set");
  updateSet(store, second.id, { reps: 16 });
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: second.id,
        state: "live",
        revision: 50,
        content: { ...synced, reps: 14 },
      },
    ],
    50,
  );
  expect(store.get("workout_set", second.id)?.status).toBe("conflict");
  historyVersion += 1;
  await live();
  expect(host.textContent).not.toContain("Last time · Top of range");
  store.resetForServerRestore();
  store.completeRestore();
  expect(store.get("workout_set", second.id)).toMatchObject({ status: "conflict", server: null });
  historyVersion += 1;
  await live();
  expect(field("Log set 1")).not.toBeNull();
  expect(host.textContent).not.toContain("Last time · Top of range");
});

it("shows a routine exercise cue and saves an additional note only on that workout entry", async () => {
  const cue = { id: "cue", text: "Pause on the chest", createdAt: "2026-03-04T08:00:00.000Z" };
  const setup = { ...cue, id: "setup", text: "Plant both feet" };
  const plan = writePlan(
    [{ id: "planned", exercise: EXERCISES.bench, sets: [{ id: "s", values: { reps: "8" } }] }],
    readSettings(store),
  );
  const template = {
    title: "Strength",
    effortScale: null,
    position: 1,
    folderId: null,
    notes: "",
    exercises: plan.map((e) => ({ ...e, notes: [cue, setup] })),
  };
  store.put("routine", "template", template);
  const workout = beginWorkout(store, "template");
  const entry = store.list("workout_exercise", { parentId: workout })[0];
  if (!entry?.content) throw Error("Missing planned exercise");
  const other = addExercise(store, workout, EXERCISES.bench, 0);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await render();
  const disclosure = host.querySelector('button[aria-label="Exercise notes for Bench Press, 2"]');
  const panel = disclosure?.parentElement;
  if (!panel) throw Error("Missing cue disclosure");
  expect(panel.textContent).toContain("Pause on the chest");
  expect(panel.textContent).not.toContain("Plant both feet");
  await press("Exercise notes for Bench Press, 2");
  expect(panel.textContent).toContain("Pause on the chest");
  expect(panel.textContent).toContain("Plant both feet");
  await press("Manage Bench Press");
  // Opened in the exercise's sheet, the notes stay in the disclosure's own card, apart from the
  // note editor below it.
  const sheetDisclosure = [
    ...host.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Exercise notes for Bench Press, 2"]',
    ),
  ].find((button) => button !== disclosure);
  const card = sheetDisclosure?.parentElement;
  if (!sheetDisclosure || !card || card === panel) throw Error("Missing sheet cue disclosure");
  expect(card.textContent).not.toContain("Plant both feet");
  await act(() => sheetDisclosure.click());
  expect(sheetDisclosure.getAttribute("aria-expanded")).toBe("true");
  expect(card.textContent).toContain("Plant both feet");
  expect(card.textContent).not.toContain("Add exercise note");
  expect(card.parentElement?.textContent).toContain("Add exercise note");
  await press("Add exercise note");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Note for Bench Press"]');
  if (!input) throw Error("Missing exercise note input");
  await act(() => {
    input.value = "  Narrower grip  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const rest = host.querySelector('button[aria-label^="Rest timer for Bench Press"]');
  if (!(rest instanceof HTMLButtonElement)) throw Error("Missing exercise rest action");
  await act(() => rest.click());
  await press("Cancel");
  await press("Manage Bench Press");
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Note for Bench Press"]')?.value,
  ).toBe("  Narrower grip  ");
  const addedElsewhere = { ...cue, id: "parallel", text: "Move the hooks" };
  store.put("workout_exercise", entry.id, {
    ...entry.content,
    notes: [cue, setup, addedElsewhere],
  });
  await press("Save exercise note");
  await render();
  const notes = readWorkoutTree(store, workout)?.entries[0]?.entry.content.notes;
  expect(notes).toEqual([
    cue,
    setup,
    addedElsewhere,
    { id: expect.any(String), createdAt: expect.any(String), text: "Narrower grip" },
  ]);
  expect(store.get("workout_exercise", other)?.content?.notes).toEqual([]);
  expect(store.get("routine", "template")?.content).toEqual(template);
  const first = store.list("workout_set", { parentId: entry.id })[0];
  if (!first) throw Error("Missing set");
  logSet(store, first.id, { weightKg: 60, reps: 8 });
  finishWorkout(store, workout, { countForRoutine: false });
  expect(progressData(store).index.byExercise.get(EXERCISES.bench.id)?.sessions[0]?.notes).toEqual([
    "Pause on the chest",
    "Plant both feet",
    "Move the hooks",
    "Narrower grip",
  ]);
  const next = beginWorkout(store, "template");
  expect(readWorkoutTree(store, next)?.entries[0]?.entry.content.notes).toEqual([cue, setup]);
});

it("adds a missed set from a finished workout without changing its timeline or any other logged set", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(new Date("2023-06-01T12:00:00Z"));
  const routine = createRoutine(
    store,
    "Strength",
    null,
    [
      { id: "press", exercise: EXERCISES.bench, sets: [{ id: "a", values: { reps: "8" } }] },
      { id: "hold", exercise: EXERCISES.plank, sets: [{ id: "b", values: { duration: "0:25" } }] },
    ],
    readSettings(store),
  );
  const template = store.get("routine", routine);
  detailId = beginWorkout(store, routine);
  const [bench, plank] = store
    .list("workout_exercise", { parentId: detailId })
    .map((row) => row.id);
  if (!bench || !plank) throw Error("Missing planned exercises");
  const first = store.list("workout_set", { parentId: bench })[0];
  const hold = store.list("workout_set", { parentId: plank })[0];
  if (!first || !hold) throw Error("Missing fixture sets");
  logSet(store, first.id, { weightKg: 20, reps: 8 });
  logSet(store, hold.id, { durationSeconds: 25 });
  const open = () => act(() => root.render(h(WorkoutDetailScreen)));
  await open();
  expect(host.querySelector('[aria-label="Add set to Bench Press"]')).toBeNull();
  finishWorkout(store, detailId, { title: "Earlier", description: "", countForRoutine: true });
  vi.setSystemTime(new Date("2023-06-05T16:00:00Z"));
  removeWorkoutSet(store, hold.id);
  const saved = store.get("workout", detailId);
  const benchSet = store.get("workout_set", first.id);
  const current = beginWorkout(store, routine);
  const active = readWorkoutTree(store, current);
  const pending = store.summary();
  await open();
  await press("Add set to Bench Press");
  await press("Save set");
  expect(host.textContent).toContain("Enter reps to log this set.");
  await press("Cancel");
  expect(store.summary()).toEqual(pending);
  expect(store.list("workout_set", { parentId: bench })).toHaveLength(1);
  // The exercise entry survives deleting its final set in History.
  await press("Add set to Plank");
  await press("Save set");
  expect(host.textContent).toContain("Enter a time to log this set.");
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Time (m:ss or seconds)"]');
  if (!field) throw Error("Missing time input");
  await act(() => {
    field.value = "1:15";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Save set");
  expect(host.querySelector("input")).toBeNull();
  expect(store.get("workout", detailId)).toEqual(saved);
  expect(store.get("workout_set", first.id)).toEqual(benchSet);
  const sets = store.list("workout_set", { parentId: plank });
  expect(sets).toHaveLength(1);
  expect(sets[0]?.content).toMatchObject({
    position: 1,
    durationSeconds: 75,
    completedAt: saved?.content?.endedAt,
    planSlot: null,
  });
  expect(workoutDetail(store, detailId)?.summary.sets).toBe(2);
  await press("Add set to Bench Press");
  const fieldValue = (label: string, value: string) =>
    act(() => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      if (!input) throw Error("Missing " + label);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await fieldValue("REPS", "5");
  await fieldValue("Reps in reserve", "0");
  await press("Save set");
  const benchSets = store.list("workout_set", { parentId: bench });
  expect(benchSets).toHaveLength(2);
  expect(benchSets[1]?.content).toMatchObject({
    reps: 5,
    repsInReserve: 0,
    planSlot: null,
    completedAt: saved?.content?.endedAt,
  });
  expect(store.get("workout_set", first.id)).toEqual(benchSet);
  expect(store.get("routine", routine)).toEqual(template);
  expect(store.activeWorkout()?.id).toBe(current);
  expect(readWorkoutTree(store, current)).toEqual(active);
});

it("appends after intervening changes and keeps repeated saves and stale exercises from adding rows", () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 30);
  const original = readWorkoutTree(store, id)?.entries[0]?.sets[0];
  if (!original) throw Error("Missing fixture set");
  const missed = { id: "missed", content: { ...original.content, reps: 7 } };
  const save = () => addHistoricalSet(store, id, EXERCISES.bench.type, missed);
  expect(save).toThrow("workout or exercise changed");
  logSet(store, original.id, { reps: 8 });
  finishWorkout(store, id, { countForRoutine: false });
  updateSet(store, original.id, { position: 1_000_000_000_000_000 });
  expect(() => addHistoricalSet(store, id, "duration", missed)).toThrow(
    "workout or exercise changed",
  );
  save();
  expect(
    store
      .list("workout_set", { parentId: entry })
      .map((s) => [s.id, s.content?.position, s.content?.reps]),
  ).toEqual([
    [original.id, 1, 8],
    ["missed", 2, 7],
  ]);
  expect(save).toThrow("already been saved");
  expect(store.list("workout_set", { parentId: entry })).toHaveLength(2);
});

it("keeps a blank carry draft open and records its distance in the displayed unit", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(
    store,
    detailId,
    { id: "carry", name: "Carry", type: "weight_distance" },
    0,
  );
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing carry");
  logSet(store, first.id, { distanceMeters: 30, weightKg: 12 });
  finishWorkout(store, detailId, { countForRoutine: false });
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Add set to Carry");
  await press("Save set");
  expect(host.textContent).toContain("Enter a weight or distance to log this set.");
  expect(store.list("workout_set", { parentId: entry })).toHaveLength(1);
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Distance (m)"]');
  if (!field) throw Error("Missing distance");
  await act(() => {
    field.value = "42";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Save set");
  expect(
    store.list("workout_set", { parentId: entry }).map((row) => row.content?.distanceMeters),
  ).toEqual([30, 42]);
});

it("records zero reps in reserve before completion, then clears it without changing the logged set", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 0);
  const open = async () => {
    const set = readWorkoutTree(store, id)?.entries[0]?.sets[0];
    if (!set) throw Error("Missing set");
    await act(() =>
      root.render(
        h(SetEditor, {
          set,
          exercise: "Bench press",
          rowLabel: "1",
          exerciseType: "weight_reps",
          unit: "kg",
          distanceUnit: "m",
          onClose: () => root.render(null),
        }),
      ),
    );
  };
  const enter = async (value: string) => {
    const input = Array.from(host.querySelectorAll("input")).find(
      (el) => el.getAttribute("aria-label") === "Reps in reserve",
    );
    if (!input) throw Error("Missing RIR input");
    await act(() => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing set");
  await open();
  await enter("-1");
  await press("Save changes");
  expect(host.textContent).toContain("whole number");
  await enter("0");
  await press("Save changes");
  expect(store.get("workout_set", first.id)?.content).toMatchObject({
    repsInReserve: 0,
    completedAt: null,
    rpe: null,
  });
  const showWorkout = () => act(() => root.render(h(ActiveWorkoutScreen)));
  // The set's RIR shows in its own column of the live workout, logged or not.
  const reserveCell = () =>
    host.querySelector('button[aria-label="reps in reserve for set 1"]')?.textContent;
  await showWorkout();
  expect(reserveCell()).toBe("0");
  logSet(store, first.id, { reps: 8, weightKg: 60 });
  await showWorkout();
  expect(reserveCell()).toBe("0");
  finishWorkout(store, id, { title: "Bench", description: "", countForRoutine: false });
  const before = store.get("workout_set", first.id)?.content;
  await open();
  await enter("");
  await press("Save changes");
  expect(store.get("workout_set", first.id)?.content).toEqual({ ...before, repsInReserve: null });
});

it("keeps an unsynced reserve value read-only during the first richer download", async () => {
  await usePreviewContract();
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 0);
  const record = store.list("workout_set", { parentId: entry })[0];
  if (!record) throw Error("Missing set");
  updateSet(store, record.id, { repsInReserve: 2 });
  store.bindAccount("server", "user");
  store.setNegotiated("1.1", []);
  store.setNegotiated("1.2", ["reps_in_reserve"]);
  expect(() => updateSet(store, record.id, { repsInReserve: null })).toThrow(/Finish syncing/);
  expect(store.get("workout_set", record.id)?.content?.repsInReserve).toBe(2);
  store.applyPull([], 0, { cursor: 0, lineage: null, release: "1.2", lastPage: true });
  updateSet(store, record.id, { repsInReserve: 0 });
  expect(store.get("workout_set", record.id)?.content?.repsInReserve).toBe(0);
});

it("picks an omitted exercise in History and saves it only with a valid first set", async () => {
  const editField = async (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!input) throw Error(`Missing field ${label}`);
    await act(() => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const pick = async (name: string) => {
    await press("Workout options");
    await press("Add exercise");
    expect(host.querySelector('[role="dialog"][aria-label="Add exercise"]')).not.toBeNull();
    await editField("Search exercises", name);
    const button = Array.from(host.querySelectorAll("button")).find((button) => {
      const label = button.getAttribute("aria-label") ?? "";
      return label.startsWith(`Add ${name},`) || label.startsWith(`Add ${name} again,`);
    });
    if (!button) throw Error(`Missing ${name} in exercise picker`);
    await act(() => button.click());
    expect(host.querySelector('[role="dialog"][aria-label="First set"]')).not.toBeNull();
  };
  detailId = beginWorkout(store);
  const bench = addExercise(store, detailId, EXERCISES.bench, 60);
  const original = store.list("workout_set", { parentId: bench })[0];
  if (!original) throw Error("Missing first set");
  logSet(store, original.id, { reps: 8 });
  await act(() => root.render(h(WorkoutDetailScreen)));
  expect(host.textContent).not.toContain("Add exercise");
  finishWorkout(store, detailId, { countForRoutine: false });
  const activeId = beginWorkout(store);
  const activeBefore = readWorkoutTree(store, activeId);
  const before = readWorkoutTree(store, detailId);
  await act(() => root.render(h(WorkoutDetailScreen)));
  const pending = store.summary();
  await pick("Plank");
  await press("Save exercise and set");
  expect(host.textContent).toContain("Enter a time to log this set.");
  await press("Cancel");
  expect(store.summary()).toEqual(pending);
  expect(readWorkoutTree(store, detailId)).toEqual(before);
  for (const seconds of [35, 60]) {
    await pick("Plank");
    await editField("Time (m:ss or seconds)", String(seconds));
    await press("Save exercise and set");
    await act(() => root.render(h(WorkoutDetailScreen)));
  }
  const after = readWorkoutTree(store, detailId);
  expect(after?.workout).toEqual(before?.workout);
  expect(after?.entries[0]).toEqual(before?.entries[0]);
  expect(
    after?.entries.slice(1).map(({ entry, sets }) => ({
      exercise: entry.content.exerciseId,
      position: entry.content.position,
      sets: sets.map(({ content }) => [
        content.durationSeconds,
        content.completedAt,
        content.planSlot,
      ]),
    })),
  ).toEqual([
    {
      exercise: EXERCISES.plank.id,
      position: 2,
      sets: [[35, before?.workout.content.endedAt, null]],
    },
    {
      exercise: EXERCISES.plank.id,
      position: 3,
      sets: [[60, before?.workout.content.endedAt, null]],
    },
  ]);
  expect(readWorkoutTree(store, activeId)).toEqual(activeBefore);
  expect(workoutDetail(store, detailId)?.summary.sets).toBe(3);
  await pick("Biceps Curl");
  await editField("REPS", "6");
  await editField("Reps in reserve", "0");
  await press("Save exercise and set");
  const added = readWorkoutTree(store, detailId)?.entries.at(-1);
  expect(added?.entry.content.exerciseId).toBe(EXERCISES.curl.id);
  expect(
    added?.sets.map(({ content }) => [content.reps, content.repsInReserve, content.completedAt]),
  ).toEqual([[6, 0, before?.workout.content.endedAt]]);
  expect(readWorkoutTree(store, activeId)).toEqual(activeBefore);
});

it("rejects an archived custom pick and rolls back a renumber and entry when its first set is refused", () => {
  const workout = beginWorkout(store);
  const bench = addExercise(store, workout, EXERCISES.bench, 30);
  const original = readWorkoutTree(store, workout)?.entries[0]?.sets[0];
  if (!original) throw Error("Missing set");
  logSet(store, original.id, { reps: 8 });
  finishWorkout(store, workout, { countForRoutine: false });
  const entry = store.get("workout_exercise", bench)?.content;
  if (!entry) throw Error("Missing entry");
  store.put("workout_exercise", bench, { ...entry, position: 1_000_000_000_000_000 });
  const custom = {
    name: "Test hold",
    type: "duration",
    primaryMuscle: "abdominals",
    secondaryMuscles: [],
    equipment: "none",
    usesBodyweight: false,
    archived: false,
  };
  store.put("custom_exercise", "custom-hold", custom);
  const exercise = pickerLibrary(store).find((row) => row.id === "custom-hold");
  if (!exercise) throw Error("Missing custom pick");
  const saved = (id: string) =>
    addHistoricalSet(
      store,
      workout,
      "duration",
      {
        id,
        content: { ...original.content, workoutExerciseId: "extra-entry", durationSeconds: 45 },
      },
      exercise,
    );
  store.put("custom_exercise", "custom-hold", { ...custom, archived: true });
  expect(() => saved("set")).toThrow("Choose it again");
  store.put("custom_exercise", "custom-hold", custom);
  expect(() => saved("")).toThrow();
  expect(
    store.list("workout_exercise", { parentId: workout }).map((row) => row.content?.position),
  ).toEqual([1_000_000_000_000_000]);
  saved("set");
  expect(
    store.list("workout_exercise", { parentId: workout }).map((row) => row.content?.position),
  ).toEqual([1, 2]);
  expect(() => saved("another-set")).toThrow("already been saved");
  expect(store.list("workout_set", { parentId: "extra-entry" })).toHaveLength(1);
});

it.each(["running", "history"] as const)(
  "compares routine targets and measurements before resolving a %s set",
  async (screen) => {
    detailId = beginWorkout(store);
    const bench = addExercise(store, detailId, EXERCISES.bench, 0);
    const set = store.list("workout_set", { parentId: bench })[0];
    if (!set) throw Error("Missing bench set");
    logSet(store, set.id, { weightKg: 15, reps: 8, planSlot: { exercise: 0, set: 0 } });
    if (screen === "history")
      finishWorkout(store, detailId, { title: "Bench", description: "", countForRoutine: false });
    const outgoing = store.prepareSubmissions("1.0");
    store.applyPushResults(
      outgoing.map(({ submission }, i) => ({
        submissionId: submission.submissionId,
        status: "accepted",
        revision: i + 1,
      })),
    );
    const original = store.get("workout_set", set.id)?.server?.content;
    if (!original) throw Error("Missing acknowledged set");
    updateSet(store, set.id, { reps: 10, repsInReserve: 0 });
    const incoming = {
      kind: "workout_set",
      id: set.id,
      state: "live" as const,
      revision: 50,
      content: { ...original, reps: 9, repsInReserve: 2, planSlot: { exercise: 0, set: 2 } },
    };
    store.applyPull([incoming], 50);
    const show = () =>
      act(() =>
        root.render(screen === "history" ? h(WorkoutDetailScreen) : h(ActiveWorkoutScreen)),
      );
    await show();
    await press("Review changes to set 1");
    expect(host.textContent).toContain("Reps in reserve · 0");
    expect(host.textContent).toContain("Reps in reserve · 2");
    expect(host.textContent).toContain("Routine target · Exercise 1, set 1");
    expect(host.textContent).toContain("Routine target · Exercise 1, set 3");
    expect(host.textContent).toContain("Reps · 10");
    expect(host.textContent).toContain("Reps · 9");
    const choice = screen === "history" ? "Use synced set" : "Use this device’s set";
    store.applyPull(
      [{ ...incoming, revision: 51, content: { ...incoming.content, reps: 11 } }],
      51,
    );
    await press(choice);
    expect(host.textContent).toContain("This set changed.");
    expect(store.get("workout_set", set.id)?.status).toBe("conflict");
    await show();
    expect(host.textContent).toContain("Reps · 11");
    await press(choice);
    expect(store.get("workout_set", set.id)).toMatchObject(
      screen === "history"
        ? { status: "synced", content: { reps: 11, planSlot: { exercise: 0, set: 2 } } }
        : {
            status: "pending",
            baseRevision: 51,
            content: { reps: 10, planSlot: { exercise: 0, set: 0 } },
          },
    );
    await show();
    expect(host.textContent).not.toContain("Review changes to set 1");
  },
);

it("protects offline set edits when the exercise is deleted during review", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 0);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing bench set");
  logSet(store, set.id, { reps: 6, weightKg: 45 });
  const uploads = store.prepareSubmissions("1.0");
  store.applyPushResults(
    uploads.map(({ submission }, i) => ({
      status: "accepted",
      submissionId: submission.submissionId,
      revision: i + 1,
    })),
  );
  const original = store.get("workout_set", set.id)?.content;
  if (!original) throw Error("Missing set content");
  updateSet(store, set.id, { reps: 10 });
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: set.id,
        state: "live",
        revision: 50,
        content: { ...original, reps: 8 },
      },
    ],
    50,
  );
  const show = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await show();
  await press("Review changes to set 1");
  store.applyPull([{ kind: "workout_exercise", id: entry, state: "deleted", revision: 51 }], 51);
  await press("Use synced set");
  expect(store.get("workout_set", set.id)).toMatchObject({
    status: "conflict",
    problem: { reason: "parent_deleted" },
    content: { reps: 10 },
  });
  await show();
  expect(host.textContent).not.toContain("Use synced set");
  expect(host.textContent).toContain("Set 1 is saved on this device");
});

it("clears the resolved set’s unsaved timer and preserves the duration typed for its neighbor", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.plank, 0);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing plank set");
  const second = addSet(store, entry);
  const outgoing = store.prepareSubmissions("1.0");
  store.applyPushResults(
    outgoing.map(({ submission }, i) => ({
      status: "accepted",
      submissionId: submission.submissionId,
      revision: i + 1,
    })),
  );
  const original = store.get("workout_set", first.id)?.content;
  if (!original) throw Error("Missing synced plank set");
  updateSet(store, first.id, { durationSeconds: 25 });
  const show = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await show();
  await typeInto("time for set 1", "1:00");
  await typeInto("time for set 2", "0:40");
  await press("Done typing");
  change((db) =>
    db.applyPull(
      [
        {
          kind: "workout_set",
          id: first.id,
          state: "live",
          revision: 50,
          content: { ...original, durationSeconds: 90 },
        },
      ],
      50,
    ),
  );
  await show();
  await press("Review changes to set 1");
  await press("Use synced set");
  await show();
  await press("Log set 1");
  await press("Log set 2");
  expect(store.get("workout_set", first.id)?.content?.durationSeconds).toBe(90);
  expect(store.get("workout_set", second)?.content?.durationSeconds).toBe(40);
});

function acknowledgedBenchPair() {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 0);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing bench set");
  const second = addSet(store, entry);
  for (const id of [first.id, second]) logSet(store, id, { reps: 6, weightKg: 45 });
  finishWorkout(store, detailId, { title: "Morning", description: "", countForRoutine: false });
  const another = beginWorkout(store);
  const uploads = store.prepareSubmissions("1.0");
  store.applyPushResults(
    uploads.map(({ submission }, i) => ({
      status: "accepted",
      submissionId: submission.submissionId,
      revision: i + 1,
    })),
  );
  const original = store.get("workout_set", first.id)?.content;
  if (!original) throw Error("Missing synced set");
  updateSet(store, first.id, { reps: 10 });
  return {
    entry,
    another,
    first: first.id,
    competing: {
      kind: "workout_set",
      id: first.id,
      state: "live" as const,
      revision: 50,
      content: { ...original, reps: 8 },
    },
  };
}

it("rejects a choice from History after its exercise moves into another workout", async () => {
  const t = acknowledgedBenchPair();
  store.applyPull([t.competing], 50);
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Review changes to set 1");
  const entry = store.get("workout_exercise", t.entry)?.content;
  if (!entry) throw Error("Missing exercise");
  store.applyPull(
    [
      {
        kind: "workout_exercise",
        id: t.entry,
        state: "live",
        revision: 51,
        content: { ...entry, workoutId: t.another },
      },
    ],
    51,
  );
  await press("Use synced set");
  expect(store.get("workout_set", t.first)).toMatchObject({
    status: "conflict",
    content: { reps: 10 },
  });
});

it("keeps both recorded versions when an open set editor becomes stale", async () => {
  const t = acknowledgedBenchPair();
  const show = () => act(() => root.render(h(WorkoutDetailScreen)));
  await show();
  await press("Edit set 1");
  await press("Remove set");
  store.applyPull([t.competing], 50);
  await confirmAction("Remove set");
  expect(store.get("workout_set", t.first)).toMatchObject({
    status: "conflict",
    content: { reps: 10 },
    server: { content: { reps: 8 } },
  });
  expect(() => updateSet(store, t.first, { reps: 12 })).toThrow(/review/i);
  await show();
  expect(host.querySelector('[role="dialog"][aria-label="Remove set"]')).toBeNull();
  expect(host.textContent).not.toContain("Save changes");
  await press("Review changes to set 1");
  expect(host.textContent).toContain("Reps · 10");
  await press("Use synced set");
  await show();
  expect(host.textContent).not.toContain("Save changes");
});

it("offers workout notes immediately and reads the notes after the workout transition", async () => {
  beginWorkout(store);
  const list = vi.spyOn(store, "list");
  settled = false;
  try {
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(host.querySelector('[aria-label="Workout notes, 0"]')).not.toBeNull();
    expect(list.mock.calls.filter(([kind]) => kind === "workout_note")).toHaveLength(0);
    settled = true;
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(list.mock.calls.some(([kind]) => kind === "workout_note")).toBe(true);
  } finally {
    settled = true;
    list.mockRestore();
  }
});

it("saves a workout rest default from Edit details and only copies it to earlier exercises when selected", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 90);
  const render = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const edit = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Workout rest in seconds"]',
    );
    if (!input) throw Error("Missing workout rest control");
    await act(() => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await render();
  await press("Edit workout details");
  await edit("75");
  await press("Cancel");
  expect(store.get("workout_rest", id)).toBeNull();
  await press("Edit workout details");
  await edit("3601");
  await press("Save changes");
  expect(host.textContent).toContain("0–3600");
  await edit("75");
  await press("Save changes");
  expect(store.get("workout_rest", id)?.content?.seconds).toBe(75);
  expect(store.get("workout_exercise", entry)?.content?.restSeconds).toBe(90);
  await render();
  // The exercise's rest dialog stays open while its rest changes from the workout's details.
  await press("Rest 1:30 for Bench Press. Change it");
  await press("Type");
  await pressKey("3");
  await pressKey("0");
  await press("Edit workout details");
  await edit("0");
  await press("Also apply to the exercises already here");
  await press("Save changes");
  expect(store.get("workout_rest", id)?.content?.seconds).toBe(0);
  expect(store.get("workout_exercise", entry)?.content?.restSeconds).toBe(0);
  await render();
  await press("Set rest to 0:30");
  expect(store.get("workout_exercise", entry)?.content?.restSeconds).toBe(0);
  expect(host.textContent).toContain("Exercise rest changed");
  await press("Cancel");
  expect(host.querySelector('[aria-label="Rest off for Bench Press. Change it"]')).not.toBeNull();
});

it.each([null, 0])(
  "waits for the real restored effort before comparing a local value of %s",
  async (local) => {
    const original = store;
    const world = new World(previewContract);
    try {
      const server = world.server();
      const a = await world.phone("a", {
        server: "s",
        account: "alice",
        transport: server.transport("alice"),
      });
      store = a.store;
      await a.sync();
      detailId = beginWorkout(store);
      const bench = addExercise(store, detailId, EXERCISES.bench, 0);
      const set = store.list("workout_set", { parentId: bench })[0];
      if (!set) throw Error("Missing set");
      logSet(store, set.id, { reps: 8, weightKg: 20, repsInReserve: 3 });
      await a.sync();
      const backup = join(world.directory, "before-effort-edit.db");
      await server.snapshot("alice", backup);
      updateSet(store, set.id, { repsInReserve: local });
      await server.restart({ releases: ["1.1"] });
      await server.restoreWithCommand("alice", backup);
      await a.sync();
      expect(store.get("workout_set", set.id)).toMatchObject({
        status: "conflict",
        partialFields: expect.arrayContaining(["repsInReserve"]),
      });
      const show = () => act(() => root.render(h(ActiveWorkoutScreen)));
      await show();
      await press("Review changes to set 1");
      expect(host.textContent).toContain("Reps in reserve · Unavailable");
      expect(host.textContent).not.toContain("Use synced set");
      expect(host.textContent).not.toContain("Both versions have the same set values");
      await server.restart({ releases: ["1.2"] });
      await a.sync();
      await show();
      expect(host.textContent).toContain("Reps in reserve · 3");
      expect(host.textContent).toContain(
        local === null ? "Reps in reserve · None" : "Reps in reserve · 0",
      );
      await press("Use this device’s set");
      await a.sync();
      expect((await server.row("alice", "workout_set", set.id))?.content?.repsInReserve).toBe(
        local,
      );
    } finally {
      store = original;
      await world.dispose();
    }
  },
);

it("selects multiple exercises across searches, cancels cleanly and adds them in selection order", async () => {
  const id = beginWorkout(store);
  const show = () => act(() => root.render(h(ActiveWorkoutScreen)));
  const select = async (name: string) => {
    const button = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'),
    ).find((row) => row.getAttribute("aria-label")?.startsWith(name + ","));
    if (!button) throw Error(`Missing exercise checkbox for ${name}`);
    await act(() => button.click());
  };
  const search = async (value: string) => {
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Search exercises"]');
    if (!field) throw Error("Missing exercise search");
    await act(() => {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await show();
  await press("Add exercise");
  await select("Bench Press");
  await press("Cancel");
  expect(readWorkoutTree(store, id)?.entries).toHaveLength(0);
  await press("Add exercise");
  await select("Overhead Press");
  await select("Bench Press");
  await select("Bench Press");
  await press("Abdominals");
  await search("Plank");
  await select("Plank");
  expect(readWorkoutTree(store, id)?.entries).toHaveLength(0);
  const add = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Add 2 exercises",
  );
  if (!add) throw Error("Missing exercise selection submit button");
  await act(() => {
    add.click();
    add.click();
  });
  expect(
    readWorkoutTree(store, id)?.entries.map(({ entry, sets }) => [
      entry.content.exerciseName,
      sets.length,
      sets[0]?.content.completedAt,
    ]),
  ).toEqual([
    ["Overhead Press", 1, null],
    ["Plank", 1, null],
  ]);
  expect(host.querySelector('input[aria-label="Search exercises"]')).toBeNull();
});

it("drops pending exercise choices when a different active workout replaces the one being edited", async () => {
  const first = beginWorkout(store);
  const show = () => act(() => root.render(h(ActiveWorkoutScreen)));
  await show();
  await press("Add exercise");
  await press("Bench Press, Weight and reps");
  const pending = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Add 1 exercise",
  );
  expect(pending).toBeDefined();
  const next = change((db) => {
    db.put("workout", first, {
      ...db.get("workout", first)?.content,
      endedAt: new Date().toISOString(),
    });
    return beginWorkout(db);
  });
  await show();
  const stale = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Add 1 exercise",
  );
  if (stale) await act(() => stale.click());
  expect(readWorkoutTree(store, next)?.entries).toHaveLength(0);
  expect(host.querySelector('input[aria-label="Search exercises"]')).toBeNull();
  await press("Add exercise");
  // No exercise is chosen any more, and no muscle filter either.
  const checked = Array.from(host.querySelectorAll('button[aria-checked="true"]'));
  expect(checked.map((button) => button.textContent)).toEqual([]);
});

it("opens the selected exercise’s earlier sets from training without logging its current draft", async () => {
  const prior = beginWorkout(store);
  const previousPlank = addExercise(store, prior, EXERCISES.plank, 0);
  const previousSet = store.list("workout_set", { parentId: previousPlank })[0];
  if (!previousSet) throw Error("Missing prior set");
  logSet(store, previousSet.id, { durationSeconds: 45 });
  finishWorkout(store, prior, { title: "Previous core session", countForRoutine: false });

  const active = beginWorkout(store);
  addExercise(store, active, EXERCISES.bench, 0);
  const plank = addExercise(store, active, EXERCISES.plank, 0);
  const before = readWorkoutTree(store, active);
  const stack = (historyOpen: boolean) =>
    h(
      "main",
      null,
      h("section", { hidden: historyOpen }, h(ActiveWorkoutScreen)),
      historyOpen && h(ExerciseScreen),
    );
  pushRoute.mockImplementation(({ params }) => {
    detailId = params.id;
    activeEntryId = params.activeEntryId;
    root.render(stack(true));
  });
  backRoute.mockImplementation(() => root.render(stack(false)));
  replaceRoute.mockImplementation(() => root.render(h(ActiveWorkoutScreen)));
  await act(() => root.render(stack(false)));
  await typeInto("time for set 1", "0:35");
  await press("Done typing");
  await press("Manage Plank");
  await press("View history for Plank");
  expect(pushRoute).toHaveBeenCalledWith({
    pathname: "/exercise/[id]",
    params: { id: EXERCISES.plank.id, activeEntryId: plank },
  });
  expect(host.querySelector("section")?.hidden).toBe(true);
  expect(host.textContent).toContain("Previous core session");
  expect(host.textContent).toContain("0:45");
  await press("Back to Current workout");
  const returned = host.querySelector('section:not([hidden]) [aria-label="time for set 1"]');
  expect(returned?.textContent).toBe("0:35");
  expect(host.textContent).not.toContain("Previous core session");
  expect(readWorkoutTree(store, active)).toEqual(before);
});

it("identifies a custom exercise with no earlier sessions from the workout entry", async () => {
  const active = beginWorkout(store);
  canGoBack.mockReturnValue(false);
  detailId = "custom-hold";
  activeEntryId = addExercise(
    store,
    active,
    { ...EXERCISES.plank, id: detailId, name: "Custom ring hold" },
    0,
  );
  await act(() => root.render(h(ExerciseScreen)));
  expect(host.textContent).toContain("Custom ring hold");
  expect(host.textContent).toContain("No workouts with this exercise.");
  await press("Back to Current workout");
  expect(replaceRoute).toHaveBeenCalledWith("/workout/active");
});

it("keeps each exercise's saved notes readable on the finished workout", async () => {
  detailId = beginWorkout(store);
  const first = addExercise(store, detailId, EXERCISES.bench, 0);
  const second = addExercise(store, detailId, EXERCISES.bench, 0);
  const third = addExercise(store, detailId, EXERCISES.plank, 0);
  for (const entry of [first, second, third]) {
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing workout set");
    logSet(store, set.id, entry === third ? { durationSeconds: 45 } : { weightKg: 40, reps: 8 });
  }
  addExerciseNote(store, detailId, first, "Use the narrow grip");
  addExerciseNote(store, detailId, first, "Paused on the last rep");
  addExerciseNote(store, detailId, second, "Wide grip");
  finishWorkout(store, detailId, { countForRoutine: false });
  await act(() => root.render(h(WorkoutDetailScreen)));
  const cards = [...host.querySelectorAll("[data-destination]")]
    .filter((link) => link.textContent === "Bench PressTrend ›")
    .map((heading) => heading.parentElement);
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain("Use the narrow grip");
  expect(cards[0]?.textContent).not.toContain("Wide grip");
  expect(cards[1]?.textContent).toContain("Wide grip");
  expect(cards[1]?.textContent).not.toContain("Use the narrow grip");
  expect(host.textContent).not.toContain("Paused on the last rep");
  await press("Exercise notes for Bench Press, 2");
  expect(cards[0]?.textContent).toContain("Paused on the last rep");
  expect(cards[1]?.textContent).not.toContain("Paused on the last rep");
  expect(
    host
      .querySelector('[aria-label="Exercise notes for Bench Press, 1"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(host.querySelector('[aria-label*="Exercise notes for Plank"]')).toBeNull();
  expect(host.textContent).not.toContain("Add exercise note");
  await press("Exercise notes for Bench Press, 2");
  expect(host.textContent).not.toContain("Paused on the last rep");
});

it("opens a routine draft from the completed workout with its source ID", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 30);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing bench set");
  logSet(store, first.id, { weightKg: 40, reps: 8 });
  const render = () => act(() => root.render(h(WorkoutDetailScreen)));
  await render();
  expect(host.textContent).not.toContain("Save as routine");
  finishWorkout(store, detailId, { countForRoutine: false });
  await render();
  await press("Workout options");
  await press("Save as routine");
  expect(pushRoute).toHaveBeenCalledWith({
    pathname: "/routine/new",
    params: { fromWorkout: detailId },
  });
  expect(store.list("routine")).toHaveLength(0);
});

it("keeps the workout menu beside Review while the details have a sync issue", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 30);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing bench set");
  logSet(store, first.id, { weightKg: 40, reps: 8 });
  finishWorkout(store, detailId, { countForRoutine: false });
  // The workout's rest is changed here and, differently, on another device.
  store.put("workout_rest", detailId, { workoutId: detailId, seconds: 60 });
  store.applyPushResults(
    store.prepareSubmissions("2.0").map(({ submission }, i) => ({
      submissionId: submission.submissionId,
      status: "accepted",
      revision: i + 1,
    })),
  );
  store.put("workout_rest", detailId, { workoutId: detailId, seconds: 75 });
  store.applyPull(
    [
      {
        kind: "workout_rest",
        id: detailId,
        state: "live",
        revision: 50,
        content: { workoutId: detailId, seconds: 30 },
      },
    ],
    50,
  );
  await act(() => root.render(h(WorkoutDetailScreen)));
  expect(host.querySelector('[aria-label="Review sync issue"]')).not.toBeNull();
  await press("Workout options");
  await press("Add exercise");
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await press("Workout options");
  await press("Save as routine");
  expect(pushRoute).toHaveBeenCalledWith({
    pathname: "/routine/new",
    params: { fromWorkout: detailId },
  });
});

it("returns a directly opened workout to the calendar or its source exercise", async () => {
  detailId = "missing-workout";
  canGoBack.mockReturnValue(false);
  const open = () => act(() => root.render(h(WorkoutDetailScreen)));
  detailReturn = { back: "Calendar" };
  await open();
  await press("Calendar");
  expect(replaceRoute).toHaveBeenLastCalledWith("/history/calendar");

  detailReturn = { back: "Calendar", from: "progress" };
  await open();
  await press("Calendar");
  expect(replaceRoute).toHaveBeenLastCalledWith({
    pathname: "/history/calendar",
    params: { from: "progress" },
  });

  detailReturn = { back: "Calendar", fromExercise: "my-calendar-exercise" };
  await open();
  await press("Calendar");
  expect(replaceRoute).toHaveBeenLastCalledWith({
    pathname: "/exercise/[id]",
    params: { id: "my-calendar-exercise" },
  });

  detailReturn = { back: "Old exercise link" };
  await open();
  await press("History");
  expect(replaceRoute).toHaveBeenLastCalledWith("/history");
  canGoBack.mockReturnValue(true);
  await open();
  await press("Old exercise link");
  expect(backRoute).toHaveBeenCalledOnce();
});

it("links both records and past sessions back to the exercise that opened them", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 60);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing bench set");
  logSet(store, set.id, { weightKg: 42, reps: 8 });
  finishWorkout(store, workout, { title: "Press practice", countForRoutine: false });
  detailId = EXERCISES.bench.id;
  await act(() => root.render(h(ExerciseScreen)));
  const destination = (text: string) => {
    const link = Array.from(host.querySelectorAll<HTMLElement>("[data-destination]")).find((node) =>
      node.textContent?.includes(text),
    );
    return JSON.parse(link?.dataset.destination ?? "null");
  };
  const expected = {
    pathname: "/workout/[id]",
    params: { id: workout, back: "Bench Press", fromExercise: EXERCISES.bench.id },
  };
  expect(destination("Heaviest weight")).toEqual(expected);
  // The session log is on the same page, and marks the session that set records.
  expect(destination("Press practice")).toEqual(expected);
  const row = Array.from(host.querySelectorAll<HTMLElement>("[data-destination]")).find((node) =>
    node.textContent?.includes("Press practice"),
  );
  expect(row?.textContent).toContain("42×8");
  expect(row?.textContent).toContain("record");
});

it("opens all logged sessions from muscle activity and returns a direct link to Progress", async () => {
  const workout = beginWorkout(store);
  const entry = addExercise(store, workout, EXERCISES.bench, 30);
  const set = store.list("workout_set", { parentId: entry })[0];
  if (!set) throw Error("Missing bench set");
  logSet(store, set.id, { weightKg: 42, reps: 8 });
  finishWorkout(store, workout, { title: "Logged press session", countForRoutine: false });
  detailId = EXERCISES.bench.id;
  detailReturn = { from: "muscleActivity" };
  canGoBack.mockReturnValue(false);
  await act(() => root.render(h(ExerciseScreen)));
  const session = Array.from(host.querySelectorAll<HTMLElement>("[data-destination]")).find(
    (link) => link.textContent?.includes("Logged press session"),
  );
  expect(JSON.parse(session?.dataset.destination ?? "null")).toMatchObject({
    pathname: "/workout/[id]",
    params: { id: workout },
  });
  await press("Back to Progress");
  expect(replaceRoute).toHaveBeenCalledWith("/progress");
});

it("shows each superset on the live and completed cards independently of its template", async () => {
  const groups = [9, 0, null, 9, 0, 27];
  const plan = groups.map((supersetId, i) => ({
    id: `entry-${i}`,
    exerciseId: EXERCISES.bench.id,
    exerciseName: `Press ${i + 1}`,
    exerciseType: "weight_reps",
    notes: [],
    supersetId,
    restSeconds: 60,
    useRepRange: false,
    sets: [
      {
        id: `target-${i}`,
        type: "normal",
        weightKg: 30,
        reps: 6,
        durationSeconds: null,
        distanceMeters: null,
        count: null,
        rpe: null,
        repRangeMin: null,
        repRangeMax: null,
      },
    ],
  }));
  const template = {
    title: "Paired presses",
    notes: "",
    folderId: null,
    position: 0,
    exercises: plan,
  };
  store.put("routine", "paired", template);
  detailId = beginWorkout(store, "paired");
  store.put("routine", "paired", {
    ...template,
    exercises: plan.map((e) => ({ ...e, supersetId: null })),
  });
  const entries = store.list("workout_exercise", { parentId: detailId });
  for (const entry of entries) {
    const first = store.list("workout_set", { parentId: entry.id })[0];
    if (!first) throw Error("Missing workout set");
    logSet(store, first.id, { weightKg: 30, reps: 6 });
  }
  await act(() => root.render(h(ActiveWorkoutScreen)));
  const expected = [
    ["Press 1", "Superset 1"],
    ["Press 2", "Superset 2"],
    ["Press 3", null],
    ["Press 4", "Superset 1"],
    ["Press 5", "Superset 2"],
    ["Press 6", null],
  ];
  const groupOn = (element: Element | null) =>
    element?.textContent?.match(/Superset \d+/)?.[0] ?? null;
  // Each card names its exercise and, under it, the superset it belongs to.
  const headings = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ).filter((el) => /^Press \d$/.test(el.getAttribute("aria-label") ?? ""));
  expect(headings.map((heading) => [heading.getAttribute("aria-label"), groupOn(heading)])).toEqual(
    expected,
  );
  finishWorkout(store, detailId, {
    title: "Paired presses",
    description: "",
    countForRoutine: false,
  });
  await act(() => root.render(h(WorkoutDetailScreen)));
  const exerciseLinks = Array.from(host.querySelectorAll("[data-destination]")).filter((link) =>
    link.textContent?.endsWith("Trend ›"),
  );
  expect(
    exerciseLinks.map((link) => [
      link.textContent?.replace(/Trend ›$/, ""),
      groupOn(link.parentElement),
    ]),
  ).toEqual(expected);
});

it("jumps between the entries of a superset in workout order without checking off sets", async () => {
  const workout = beginWorkout(store);
  const first = addExercise(store, workout, EXERCISES.bench, 60);
  addExercise(store, workout, EXERCISES.squat, 60);
  const second = addExercise(store, workout, EXERCISES.bench, 60);
  const third = addExercise(store, workout, EXERCISES.squat, 60);
  for (const id of [first, second, third]) {
    const row = store.get("workout_exercise", id);
    if (!row?.content) throw Error("Missing entry");
    store.put("workout_exercise", id, { ...row.content, supersetId: 0 });
  }
  await act(() => root.render(h(ActiveWorkoutScreen)));
  await typeInto("kg for set 1", "72.5");
  await press("Done typing");
  const heading = (name: string, occurrence: number) =>
    host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${name}"]`)[occurrence];
  const links = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Next in Superset"]'));
  const jump = async (index: number) => {
    const link = links()[index];
    if (!link) throw Error("Missing superset navigation");
    await act(() => link.click());
  };
  expect(links().map((link) => link.getAttribute("aria-label"))).toEqual([
    "Next in Superset 1: Bench Press, exercise 3",
    "Next in Superset 1: Squat, exercise 4",
    "Next in Superset 1: Bench Press, exercise 1",
  ]);
  // Earlier cards can grow without a fresh layout event on this destination.
  addSet(store, first);
  const before = readWorkoutTree(store, workout);
  await act(() => root.render(h(ActiveWorkoutScreen)));
  const destination = heading("Bench Press", 1);
  if (!destination) throw Error("Missing second bench press heading");
  const reveal = vi.spyOn(destination, "scrollIntoView");
  await jump(0);
  expect(reveal).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(heading("Bench Press", 1));
  await jump(1);
  expect(document.activeElement).toBe(heading("Squat", 1));
  await jump(2);
  expect(document.activeElement).toBe(heading("Bench Press", 0));
  const platform = Platform.OS;
  Object.assign(Platform, { OS: "ios" });
  const weight = host.querySelector<HTMLButtonElement>('[aria-label="kg for set 1"]');
  if (!weight) throw Error("Missing first set weight");
  try {
    weight.focus();
    expect(document.activeElement).toBe(weight);
    await jump(0);
    expect(document.activeElement).not.toBe(weight);
  } finally {
    Object.assign(Platform, { OS: platform });
  }
  expect(fieldText("kg for set 1")).toBe("72.5");
  expect(readWorkoutTree(store, workout)).toEqual(before);
});

describe("the logging dock and the number pad", () => {
  /** A finished bench session of 80 × 8 sets, so the next one has last time's values. */
  const benchBefore = (sets: number) => {
    const past = beginWorkout(store);
    const entry = addExercise(store, past, EXERCISES.bench, 0);
    for (let i = 1; i < sets; i++) addSet(store, entry);
    for (const set of store.list("workout_set", { parentId: entry }))
      logSet(store, set.id, { weightKg: 80, reps: 8 });
    finishWorkout(store, past, { title: "Earlier", description: "", countForRoutine: false });
  };
  const sets = (entry: string) =>
    store
      .list("workout_set", { parentId: entry })
      .map((set) => set.content as unknown as WorkoutSet);
  const nextKey = () =>
    host
      .querySelector('button[aria-label^="Next: "], button[aria-label="Done"]')
      ?.getAttribute("aria-label");

  it("walks fields with Next and carries this session's reps into the next set", async () => {
    benchBefore(2);
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    addSet(store, bench);
    const squat = addExercise(store, workout, EXERCISES.squat, 0);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(fieldText("kg for set 1")).toBe("80");
    await press("kg for set 1");
    expect(nextKey()).toBe("Next: reps");
    // Next takes the suggestion as it is.
    await press("Next: reps");
    await pressKey("1");
    await pressKey("0");
    expect(fieldText("reps for set 1")).toBe("10");
    expect(nextKey()).toBe("Next: set 2");
    await press("Next: set 2");
    expect(fieldText("reps for set 2")).toBe("10");
    await pressKey("8");
    await pressKey("5");
    await press("Next: reps");
    expect(nextKey()).toBe("Next: Squat · set 1");
    await press("Next: Squat · set 1");
    expect(nextKey()).toBe("Next: reps");
    await press("Done typing");
    expect(nextKey()).toBeUndefined();
    // Typing records nothing until a set is logged.
    expect(sets(bench).map((set) => set.completedAt)).toEqual([null, null]);
    await press("Log set 1");
    await press("Log set 2");
    expect(sets(bench).map(({ weightKg, reps }) => [weightKg, reps])).toEqual([
      [80, 10],
      [85, 10],
    ]);
    expect(sets(squat)[0]?.completedAt).toBeNull();
  });

  it("fills every empty set after the one typed into, until another value is typed", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    for (let i = 0; i < 3; i++) addSet(store, bench);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(fieldText("kg for set 4")).toBe("–");
    await typeInto("kg for set 1", "60");
    await typeInto("reps for set 1", "8");
    await typeInto("reps for set 3", "6");
    await press("Done typing");
    expect(
      [2, 3, 4].map((n) => [fieldText(`kg for set ${n}`), fieldText(`reps for set ${n}`)]),
    ).toEqual([
      ["60", "8"],
      ["60", "6"],
      ["60", "6"],
    ]);
    for (const n of [1, 2, 3, 4]) await press(`Log set ${n}`);
    expect(sets(bench).map(({ weightKg, reps }) => [weightKg, reps])).toEqual([
      [60, 8],
      [60, 8],
      [60, 6],
      [60, 6],
    ]);
  });

  it("fills empty sets with today's value over last time's", async () => {
    benchBefore(3);
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    addSet(store, bench);
    addSet(store, bench);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(fieldText("kg for set 3")).toBe("80");
    await typeInto("kg for set 1", "85");
    await press("Done typing");
    expect(fieldText("kg for set 2")).toBe("85");
    expect(fieldText("kg for set 3")).toBe("85");
    // Last time's reps still fill the sets nothing was typed into.
    expect(fieldText("reps for set 3")).toBe("8");
  });

  it("logs the dock's set with its steppers, then shows only the rest until it is skipped", async () => {
    benchBefore(2);
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 90);
    addSet(store, bench);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("More weight, 2.5 kg");
    expect(fieldText("kg for set 1")).toBe("82.5");
    await press("Less reps");
    await press("Log set 1 of Bench Press");
    expect(sets(bench)[0]).toMatchObject({
      weightKg: 82.5,
      reps: 7,
      completedAt: expect.any(String),
    });
    // Resting: the timer is the whole dock, with the set that comes next.
    expect(host.textContent).toContain("Skip");
    expect(host.textContent).toContain("Up next · Bench Press · set 2/2");
    expect(host.querySelector('[aria-label="Log set 2 of Bench Press"]')).toBeNull();
    await press("Skip");
    expect(host.textContent).not.toContain("Skip");
    expect(fieldText("kg for set 2")).toBe("82.5");
    expect(fieldText("reps for set 2")).toBe("7");
    await press("Log set 2 of Bench Press");
    expect(sets(bench)[1]).toMatchObject({ weightKg: 82.5, reps: 7 });
    expect(host.textContent).toContain("All sets logged");
    await press("Skip");
    expect(host.textContent).toContain("Finish workout");
  });

  it("opens the missing reps on the pad when the dock can't log a set, then logs what was typed", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Log set 1 of Bench Press");
    expect(sets(bench)[0]?.completedAt).toBeNull();
    expect(host.textContent).toContain("Enter reps to log this set.");
    expect(host.textContent).toContain("Set 1 · reps");
    await pressKey("6");
    await press("Done");
    await press("Log set 1 of Bench Press");
    expect(sets(bench)[0]).toMatchObject({
      weightKg: null,
      reps: 6,
      completedAt: expect.any(String),
    });
  });

  it("corrects a logged set from its row and keeps it logged", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    const [set] = store.list("workout_set", { parentId: bench });
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { weightKg: 60, reps: 8 });
    const completedAt = store.get("workout_set", set.id)?.content?.completedAt;
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await typeInto("reps for set 1", "10");
    expect(host.textContent).toContain("Set 1 · reps · logged");
    // Nothing is saved until the field is left.
    expect(sets(bench)[0]?.reps).toBe(8);
    await press("Done typing");
    expect(sets(bench)[0]).toMatchObject({ weightKg: 60, reps: 10, completedAt });
    // Emptying a field on the pad clears that value, and the set stays logged.
    await press("kg for set 1");
    await pressKey("Delete");
    await press("Done typing");
    expect(sets(bench)[0]).toMatchObject({ weightKg: null, reps: 10, completedAt });
  });

  it("changes the running rest and the exercise's next ones from the rest dialog", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 90);
    addSet(store, bench);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    onTestFinished(() => now.mockRestore());
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await typeInto("reps for set 1", "5");
    await press("Log set 1");
    await press("Rest, 1:30 left of 1:30. Change the rest time");
    expect(host.textContent).toContain("This rest, and the next ones for this exercise");
    now.mockReturnValue(1_020_000);
    await press("2:00");
    await press("Set rest to 2:00");
    expect(store.get("workout_exercise", bench)?.content?.restSeconds).toBe(120);
    // The countdown now runs for 2 minutes (counted from when it began: see retimeRest).
    expect(
      host.querySelector(
        '[aria-label^="Rest, "][aria-label$=" left of 2:00. Change the rest time"]',
      ),
    ).not.toBeNull();
    expect(host.querySelector('[aria-label="Set rest to 2:00"]')).toBeNull();
  });

  it("closes the rest dialog before the workout is left in any way", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 90);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    const restDialog = () => host.querySelector('[aria-label="Rest time"]');
    const openRest = () => press("Rest 1:30 for Bench Press. Change it");

    await openRest();
    expect(restDialog()).not.toBeNull();
    await press("Finish");
    expect(pushRoute).toHaveBeenCalledWith("/workout/finish");
    expect(restDialog()).toBeNull();

    await openRest();
    canGoBack.mockReturnValue(true);
    await press("Minimise workout");
    expect(backRoute).toHaveBeenCalled();
    expect(restDialog()).toBeNull();

    // Opened again from the mini-player.
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await openRest();
    await press("Workout notes, 0");
    expect(pushRoute).toHaveBeenLastCalledWith({
      pathname: "/workout/notes/[id]",
      params: { id: workout },
    });
    expect(restDialog()).toBeNull();

    // However else the screen is left, it closes as the screen goes out of sight.
    await openRest();
    expect(blurListeners.size).toBeGreaterThan(0);
    await act(() => {
      for (const listener of blurListeners) listener();
    });
    expect(restDialog()).toBeNull();
    // Nothing was changed on the way.
    expect(store.get("workout_exercise", bench)?.content?.restSeconds).toBe(90);
  });

  it("turns an exercise's rest off from Off, the length after the longest", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 90);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Rest 1:30 for Bench Press. Change it");
    const lengths = Array.from(host.querySelectorAll('[aria-label="Rest time"] [role="radio"]'))
      .map((radio) => radio.getAttribute("aria-label") ?? "")
      .filter((label) => /^(\d|Off)/.test(label));
    expect(lengths.slice(-2)).toEqual(["5:00", "Off"]);
    await press("Off");
    await press("Set rest to Off");
    expect(store.get("workout_exercise", bench)?.content?.restSeconds).toBe(0);
    expect(host.querySelector('[aria-label="Rest off for Bench Press. Change it"]')).not.toBeNull();
  });

  it("jumps to an exercise from its segment, which the dock then logs", async () => {
    const workout = beginWorkout(store);
    addExercise(store, workout, EXERCISES.bench, 0);
    addExercise(store, workout, EXERCISES.squat, 0);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    const squat = host.querySelector<HTMLButtonElement>('button[aria-label="Squat"]');
    if (!squat) throw Error("Missing squat heading");
    const reveal = vi.spyOn(squat, "scrollIntoView");
    expect(host.querySelector('[aria-label="Log set 1 of Bench Press"]')).not.toBeNull();
    await press("Jump to Squat, 0 of 1 set done");
    expect(reveal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(squat);
    expect(host.querySelector('[aria-label="Log set 1 of Squat"]')).not.toBeNull();
  });

  it("moves the dock to the next exercise of a superset after each logged set", async () => {
    supersetWorkout();
    const screen = () => act(() => root.render(h(ActiveWorkoutScreen)));
    await screen();
    await press("Log set 1 of Bench Press");
    await screen();
    expect(host.querySelector('[aria-label="Log set 1 of Squat"]')).not.toBeNull();
    await press("Log set 1 of Squat");
    await screen();
    expect(host.querySelector('[aria-label="Log set 2 of Bench Press"]')).not.toBeNull();
    await press("Log set 2 of Bench Press");
    await screen();
    await press("Log set 2 of Squat");
    await screen();
    expect(host.querySelector('[aria-label^="Log set"]')).toBeNull();
  });
});

/** A bench and squat superset of two sets each, with last time's values to log them from. */
function supersetWorkout() {
  const past = beginWorkout(store);
  for (const [exercise, weightKg] of [
    [EXERCISES.bench, 80],
    [EXERCISES.squat, 105],
  ] as const) {
    const id = addExercise(store, past, exercise, 0);
    addSet(store, id);
    for (const set of store.list("workout_set", { parentId: id }))
      logSet(store, set.id, { weightKg, reps: 5 });
  }
  finishWorkout(store, past, { countForRoutine: false });
  const workout = beginWorkout(store);
  for (const exercise of [EXERCISES.bench, EXERCISES.squat]) {
    const id = addExercise(store, workout, exercise, 0);
    addSet(store, id);
    const row = store.get("workout_exercise", id);
    if (!row?.content) throw Error("Missing entry");
    store.put("workout_exercise", id, { ...row.content, supersetId: 0 });
  }
  return workout;
}

function PlayerProbe({ capture }: { capture: (frame: ReturnType<typeof workoutFrame>) => void }) {
  capture(workoutFrame(useWorkoutPlayer(), Date.now(), true));
  return null;
}

describe("the minimised workout", () => {
  it("logs a superset in turn, moving to the next exercise after each set", async () => {
    supersetWorkout();
    const mini = () => act(() => root.render(h(MiniPlayer)));
    await mini();
    await press("Log set 1 of Bench Press");
    await mini();
    expect(host.querySelector('[aria-label="Log set 1 of Squat"]')).not.toBeNull();
    await press("Log set 1 of Squat");
    await mini();
    expect(host.querySelector('[aria-label="Log set 2 of Bench Press"]')).not.toBeNull();
  });

  it("resumes with the logged values and previous-set suggestions before the transition ends", async () => {
    const past = beginWorkout(store);
    const pastBench = addExercise(store, past, EXERCISES.bench, 0);
    const pastSquat = addExercise(store, past, EXERCISES.squat, 0);
    const [benchSet] = store.list("workout_set", { parentId: pastBench });
    const [squatSet] = store.list("workout_set", { parentId: pastSquat });
    if (!benchSet || !squatSet) throw Error("Missing sets from last time");
    logSet(store, benchSet.id, { weightKg: 80, reps: 8 });
    logSet(store, squatSet.id, { weightKg: 105, reps: 5 });
    finishWorkout(store, past, { countForRoutine: false });

    const workout = beginWorkout(store);
    addExercise(store, workout, EXERCISES.bench, 0);
    const squat = addExercise(store, workout, EXERCISES.squat, 0);
    for (let i = 0; i < 10; i++) addSet(store, squat);
    const mini = () => act(() => root.render(h(MiniPlayer)));
    await mini();
    expect(host.textContent).toContain("Bench Press · 80 × 8");
    await press("Log set 1 of Bench Press");
    await mini();
    expect(host.textContent).toContain("Squat · 105 × 5");
    const list = vi.spyOn(store, "list");
    const syncState = vi.spyOn(store, "syncState");
    settled = false;
    try {
      await press("Resume Workout");
      expect(pushRoute).toHaveBeenCalledWith("/workout/active");
      await act(() => root.render(h(ActiveWorkoutScreen)));
      expect(
        Array.from(host.querySelectorAll('button[aria-label="kg for set 1"]')).map(
          (field) => field.textContent,
        ),
      ).toEqual(["80", "105"]);
      expect(host.textContent).toContain("105 × 5");
      expect(host.querySelector('[aria-label="Log set 1 of Squat"]')).toHaveProperty(
        "disabled",
        false,
      );
      expect(list).not.toHaveBeenCalled();
      expect(syncState.mock.calls.length).toBeLessThanOrEqual(6);

      settled = true;
      await act(() => root.render(h(ActiveWorkoutScreen)));
      expect(list.mock.calls.filter(([kind]) => kind === "workout_set")).toHaveLength(0);
    } finally {
      settled = true;
      list.mockRestore();
      syncState.mockRestore();
    }
  });

  it.each([
    "unchanged",
    "edited",
    "committed before acknowledgement",
    "logged then undone",
    "another account",
    "another server",
    "restored lineage",
  ])("recovers an interrupted Lock Screen Log with a %s set", async (scenario) => {
    store.close();
    const options = {
      engine: createSqlJsEngine(sql),
      path: "/activity-recovery.db",
      appVersion: "test",
    };
    store = await openDeviceStore(options);
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 0);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    updateSet(store, set.id, { weightKg: 50, reps: 8 });
    // Clone an unbound data-bearing database. Both owners start with identical IDs,
    // row versions, workout values and selection, so only the ownership boundary differs.
    const otherPath = "/other-owner.db";
    const db = options.engine.open(options.path, { readOnly: true });
    try {
      await options.engine.backup(db, otherPath);
    } finally {
      db.close();
    }
    store.bindAccount("server-A", "alice");
    store.setNegotiated("1.0", [], "lineage-A");
    const snapshots: WorkoutContent[] = [];
    const handle = {
      getId: () => "system activity",
      async end() {},
      async update(p: WorkoutContent) {
        snapshots.push(p);
      },
    };
    const factory = { getInstances: () => [handle], start: () => handle };
    const memory = { shown: () => undefined, remember: () => {} };
    let session = workoutSession(factory, "leve-preview", memory);
    let pending = Promise.resolve();
    const capture = (frame: ReturnType<typeof workoutFrame>) => {
      pending = session.publish(frame);
    };
    await act(() => root.render(h(PlayerProbe, { capture })));
    await pending;
    const ticket = snapshots[0]?.token + ":log";
    if (scenario === "edited") updateSet(store, set.id, { reps: 10 });
    if (scenario === "committed before acknowledgement" || scenario === "logged then undone") {
      expect(session.interact(handle.getId(), ticket)).toBe(true);
      if (scenario === "logged then undone") updateSet(store, set.id, { completedAt: null });
    }
    const before = store.get("workout_set", set.id)?.content;
    await act(() => root.render(null));
    store.close();
    const changedOwner = ["another account", "another server", "restored lineage"].includes(
      scenario,
    );
    store = await openDeviceStore(changedOwner ? { ...options, path: otherPath } : options);
    if (changedOwner) {
      store.bindAccount(
        scenario === "another server" ? "server-B" : "server-A",
        scenario === "another account" ? "bob" : "alice",
      );
      store.setNegotiated("1.0", [], scenario === "restored lineage" ? "lineage-B" : "lineage-A");
    }
    const versionBefore = store.editVersion("workout_set", set.id);
    session = workoutSession(factory, "leve-preview", memory);
    await act(() => root.render(h(PlayerProbe, { capture })));
    await pending;
    const accepted = session.interact(handle.getId(), ticket);
    const saved = store.get("workout_set", set.id)?.content;
    if (scenario === "unchanged") {
      expect(accepted).toBe(true);
      expect(saved).toMatchObject({ weightKg: 50, reps: 8, completedAt: expect.any(String) });
    } else {
      expect(accepted).toBe(false);
      expect(saved).toEqual(before);
      expect(store.editVersion("workout_set", set.id)).toEqual(versionBefore);
    }
    session.interact(handle.getId(), ticket);
    expect(store.get("workout_set", set.id)?.content).toEqual(saved);
  });

  it.each(["account binding", "lineage change"])(
    "rejects a previous owner's rest button after %s clears its authority",
    async (transition) => {
      const workout = beginWorkout(store);
      const entry = addExercise(store, workout, EXERCISES.bench, 90);
      const set = store.list("workout_set", { parentId: entry })[0];
      if (!set) throw Error("Missing set");
      logSet(store, set.id, { weightKg: 50, reps: 8 });
      restTimer.start(store, workout, set.id, 90);
      if (transition === "lineage change") {
        store.bindAccount("server-A", "alice");
        store.setNegotiated("1.0", [], "original");
      }
      const published: WorkoutContent[] = [];
      const handle = {
        getId: () => "system activity",
        async end() {},
        async update(content: WorkoutContent) {
          published.push(content);
        },
      };
      const session = workoutSession(
        { getInstances: () => [handle], start: () => handle },
        "leve-preview",
        { shown: () => undefined, remember: () => {} },
      );
      let ready = Promise.resolve();
      const capture = (frame: ReturnType<typeof workoutFrame>) => {
        ready = session.publish(frame);
      };
      await act(() => root.render(h(PlayerProbe, { capture })));
      await ready;
      const old = published.at(-1);
      if (!old || old.restEnd <= 0 || old.canLog) throw Error("Expected rest after the final set");
      if (transition === "account binding") store.bindAccount("server-A", "alice");
      else store.setNegotiated("1.0", [], "restored");
      version++;
      await act(() => root.render(h(PlayerProbe, { capture })));
      await ready;
      expect(session.interact(handle.getId(), old.token + ":skip")).toBe(false);
      const current = published.at(-1);
      expect(current?.restEnd).toBe(old.restEnd);
      await act(() => {
        expect(session.interact(handle.getId(), current?.token + ":skip")).toBe(true);
      });
      await ready;
      expect(published.at(-1)?.restEnd).toBe(0);
    },
  );

  it("only publishes display fields at start and after a measurement edit", async () => {
    const received: WorkoutContent[] = [];
    const handle = {
      getId: () => "native",
      async end() {},
      async update(content: WorkoutContent) {
        received.push(content);
      },
    };
    const session = workoutSession(
      {
        getInstances: () => [handle],
        start(content) {
          received.push(content);
          return handle;
        },
      },
      "leve-preview",
      { shown: () => undefined, remember: () => {} },
    );
    await session.publish(null);
    let pending = Promise.resolve();
    const capture = (frame: ReturnType<typeof workoutFrame>) => {
      pending = session.publish(frame);
    };
    const workout = beginWorkout(store);
    const row = store.get("workout", workout);
    if (!row?.content) throw Error("Missing workout");
    store.put("workout", workout, {
      ...row.content,
      title: "Training",
      description: "PRIVATE DESCRIPTION",
    });
    const bench = addExercise(store, workout, EXERCISES.bench, 60);
    addExerciseNote(store, workout, bench, "PRIVATE NOTE");
    const set = store.list("workout_set", { parentId: bench })[0];
    if (!set) throw Error("Missing set");
    updateSet(store, set.id, { weightKg: 50, reps: 8 });
    await act(() => root.render(h(PlayerProbe, { capture })));
    await pending;
    updateSet(store, set.id, { reps: 10 });
    version++;
    await act(() => root.render(h(PlayerProbe, { capture })));
    await pending;
    const expected = {
      title: "Training",
      exercise: "Bench Press",
      set: "set 1",
      compact: "50×8",
      measurements: "50 kg × 8 reps",
      previous: "",
      volume: "0 kg",
      started: Date.parse(String(row.content.startedAt)),
      done: 0,
      total: 1,
      interactive: true,
      restStart: 0,
      restEnd: 0,
      canLog: true,
      finish: false,
      token: expect.any(String),
      openUrl: "leve-preview:///workout/active",
    };
    expect(received).toEqual([
      expected,
      { ...expected, compact: "50×10", measurements: "50 kg × 10 reps" },
    ]);
  });

  it("preserves a changed measurement when Log is pressed on a stale display", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    const set = store.list("workout_set", { parentId: bench })[0];
    if (!set) throw Error("Missing set");
    updateSet(store, set.id, { reps: 8 });
    await act(() => root.render(h(MiniPlayer)));
    updateSet(store, set.id, { reps: 10 });
    await press("Log set 1 of Bench Press");
    expect(store.get("workout_set", set.id)?.content).toMatchObject({
      reps: 10,
      completedAt: null,
    });
  });

  it("logs a legacy unfinished set with an omitted completion timestamp", async () => {
    store.close();
    const engine = createSqlJsEngine(sql);
    const options = { engine, path: "/legacy.db", appVersion: "test" };
    store = await openDeviceStore(options);
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    const set = store.list("workout_set", { parentId: bench })[0];
    if (!set?.content) throw Error("Missing set");
    const { completedAt: _, ...unfinished } = set.content;
    store.close();
    const db = engine.open(options.path);
    db.run("UPDATE records SET local_content = ? WHERE kind = ? AND id = ?", [
      JSON.stringify({ ...unfinished, reps: 8 }),
      "workout_set",
      set.id,
    ]);
    db.close();
    store = await openDeviceStore(options);
    expect(store.get("workout_set", set.id)?.content).not.toHaveProperty("completedAt");
    await act(() => root.render(h(MiniPlayer)));
    await press("Log set 1 of Bench Press");
    expect(store.get("workout_set", set.id)?.content).toMatchObject({
      reps: 8,
      completedAt: expect.any(String),
    });
  });

  it("logs its next set, drains during the rest, and skips it", async () => {
    const past = beginWorkout(store);
    const before = addExercise(store, past, EXERCISES.bench, 0);
    for (const set of store.list("workout_set", { parentId: before }))
      logSet(store, set.id, { weightKg: 80, reps: 8 });
    finishWorkout(store, past, { title: "Earlier", description: "", countForRoutine: false });
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 60);
    addSet(store, bench);
    const mini = () => act(() => root.render(h(MiniPlayer)));
    await mini();
    expect(host.querySelector('[aria-label="Resume Workout"]')?.textContent).toContain("0/2");
    // The next set with last time's values.
    expect(host.textContent).toContain("Bench Press · 80 × 8");
    await press("Log set 1 of Bench Press");
    version++;
    await mini();
    expect(
      store.list("workout_set", { parentId: bench }).map((set) => set.content?.reps ?? null),
    ).toEqual([8, null]);
    expect(host.textContent).toContain("Rest");
    expect(host.textContent).toContain("Up next · Bench Press");
    await press("Skip rest");
    await mini();
    expect(host.textContent).not.toContain("Up next");
    expect(host.querySelector('[aria-label="Resume Workout"]')?.textContent).toContain("1/2");
    expect(host.textContent).toContain("Bench Press · 80 × 8");
    await press("Log set 2 of Bench Press");
    expect(store.list("workout_set", { parentId: bench })[1]?.content).toMatchObject({
      weightKg: 80,
      reps: 8,
      completedAt: expect.any(String),
    });
  });

  it("opens the workout on the field a set can't be logged without", async () => {
    const workout = beginWorkout(store);
    const bench = addExercise(store, workout, EXERCISES.bench, 0);
    await act(() => root.render(h(MiniPlayer)));
    await press("Log set 1 of Bench Press");
    expect(pushRoute).toHaveBeenCalledWith("/workout/active");
    expect(store.list("workout_set", { parentId: bench })[0]?.content?.completedAt).toBeNull();
    await act(() => root.render(h(ActiveWorkoutScreen)));
    expect(host.textContent).toContain("Enter reps to log this set.");
    expect(host.textContent).toContain("Set 1 · reps");
    await pressKey("5");
    await press("Done typing");
    expect(fieldText("reps for set 1")).toBe("5");
  });
});

it("shows a past session's title and date in its bar, then its time, volume, sets and reps, and no records", async () => {
  detailId = beginWorkout(store);
  const bench = addExercise(store, detailId, EXERCISES.bench, 0);
  const row = store.list("workout_set", { parentId: bench })[0];
  if (!row) throw Error("Missing set");
  logSet(store, row.id, { reps: 8, weightKg: 50 });
  finishWorkout(store, detailId, { countForRoutine: false });
  const workout = store.get("workout", detailId)?.content as { title: string; startedAt: string };
  await act(() => root.render(h(WorkoutDetailScreen)));
  const text = host.textContent ?? "";
  expect(text).toContain(workout.title);
  expect(text).toContain(
    new Date(workout.startedAt).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
  );
  // 50 kg × 8 is 400 kg over one set of 8 reps. The first session sets records, but looking back
  // shows none.
  expect(text).toContain("Volume400 kg");
  expect(text).toContain("Sets1");
  expect(text).toContain("Reps8");
  expect(text).not.toMatch(/record/i);
  expect(host.querySelector('[aria-label="Workout options"]')).not.toBeNull();
  // Each set shows its estimated one-rep max: 50 × (1 + 8/30) is 63.3 kg.
  expect(text).toContain("E1RM");
  expect(text).toContain("63");
});

it("deletes a past workout from its menu only once the action sheet is confirmed", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 30);
  const first = store.list("workout_set", { parentId: entry })[0];
  if (!first) throw Error("Missing bench set");
  logSet(store, first.id, { weightKg: 40, reps: 8 });
  finishWorkout(store, detailId, { title: "Light", countForRoutine: false });
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Workout options");
  await press("Delete workout");
  expect(readWorkoutTree(store, detailId)).not.toBeNull();
  expect(host.textContent).toContain("and its 1 set will be deleted.");
  await press("Keep it");
  expect(readWorkoutTree(store, detailId)).not.toBeNull();
  await press("Workout options");
  await press("Delete workout");
  await confirmAction("Delete workout");
  expect(readWorkoutTree(store, detailId)).toBeNull();
  expect(backRoute).toHaveBeenCalled();
});

describe("Undo after removing a set in a browser", () => {
  const removeSet2 = async () => {
    const workout = beginWorkout(store);
    const entry = addExercise(store, workout, EXERCISES.bench, 90);
    addSet(store, entry);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Edit set 2");
    await press("Remove set");
  };
  const undo = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Undo: Set 2 removed"]');

  it("goes by itself though it was given focus as it showed", async () => {
    await removeSet2();
    expect(document.activeElement).toBe(undo());
    await act(() => vi.advanceTimersByTime(7900));
    expect(undo()).not.toBeNull();
    await act(() => vi.advanceTimersByTime(200));
    expect(undo()).toBeNull();
    // Focus was still on Undo, so it goes to the exercise instead of being lost.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Bench Press");
  });

  it("waits while the person moves keyboard focus back to it", async () => {
    await removeSet2();
    const button = undo();
    await act(() => button?.blur());
    await act(() => button?.focus());
    await act(() => vi.advanceTimersByTime(30000));
    expect(undo()).not.toBeNull();
    await act(() => button?.blur());
    await act(() => vi.advanceTimersByTime(8100));
    expect(undo()).toBeNull();
  });

  it("leaves focus where the person moved it when Undo goes", async () => {
    await removeSet2();
    const weight = host.querySelector<HTMLButtonElement>('button[aria-label="kg for set 1"]');
    await act(() => weight?.focus());
    expect(document.activeElement).toBe(weight);
    await act(() => vi.advanceTimersByTime(8100));
    expect(undo()).toBeNull();
    expect(document.activeElement).toBe(weight);
  });
});

function acknowledgeWorkoutRows(release: "1.0" | "2.0" = "1.0") {
  store.applyPushResults(
    store.prepareSubmissions(release).map(({ submission }, i) => ({
      submissionId: submission.submissionId,
      status: "accepted",
      revision: i + 1,
    })),
  );
}

it.each(["exercise", "set", "waiting for receipt"])(
  "refuses Finish before cleanup deletes a disputed %s",
  (scope) => {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0]!;
    logSet(store, set.id, { reps: 5, weightKg: 20 });
    const other =
      scope === "set"
        ? addSet(store, entry)
        : store.list("workout_set", { parentId: addExercise(store, id, EXERCISES.bench, 60) })[0]!
            .id;
    logSet(store, other, { reps: 7, weightKg: 10 });
    acknowledgeWorkoutRows();
    const synced = store.get("workout_set", set.id)!.content!;
    updateSet(store, set.id, { completedAt: null });
    if (scope === "waiting for receipt") store.prepareSubmissions("1.0");
    store.applyPull(
      [
        {
          kind: "workout_set",
          id: set.id,
          state: "live",
          revision: 50,
          content: { ...synced, reps: 12, completedAt: "2026-11-01T12:00:00Z" },
        },
      ],
      50,
    );
    const before = store.get("workout_set", set.id);
    if (scope === "waiting for receipt") expect(before?.inFlight).toBe(true);
    else expect(before?.status).toBe("conflict");
    const summary = store.summary();
    expect(() => finishWorkout(store, id, { countForRoutine: false })).toThrow(/review/i);
    expect(store.activeWorkout()?.id).toBe(id);
    expect(store.get("workout_set", set.id)).toEqual(before);
    expect(store.summary()).toEqual(summary);
  },
);

it.each([
  "Keep set deletion",
  "Use synced set",
  "later revision",
  "moved exercise",
  "deleted exercise",
])("offers %s for a deleted set in its workout details", async (choice) => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 60);
  const set = store.list("workout_set", { parentId: entry })[0]!;
  logSet(store, set.id, { reps: 5, weightKg: 10 });
  logSet(store, addSet(store, entry), { reps: 8, weightKg: 20 });
  finishWorkout(store, detailId, { countForRoutine: false });
  acknowledgeWorkoutRows();
  const original = store.get("workout_set", set.id)!.content!;
  removeWorkoutSet(store, set.id);
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: set.id,
        revision: 50,
        state: "live",
        content: { ...original, reps: 12 },
      },
    ],
    50,
  );
  expect(readWorkoutTree(store, detailId)?.entries[0]?.sets).toHaveLength(1);
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Review sync issue");
  await press("Review changes to set " + original.position);
  expect(host.textContent).toContain("Reps · 12");
  if (choice === "later revision" || choice === "moved exercise" || choice === "deleted exercise") {
    if (choice === "later revision")
      store.applyPull(
        [
          {
            kind: "workout_set",
            id: set.id,
            state: "live",
            revision: 51,
            content: { ...original, reps: 17 },
          },
        ],
        51,
      );
    else if (choice === "moved exercise") {
      const other = beginWorkout(store);
      const previous = store.get("workout_exercise", entry)?.content;
      store.applyPull(
        [
          {
            kind: "workout_exercise",
            id: entry,
            state: "live",
            revision: 51,
            content: { ...previous, workoutId: other },
          },
        ],
        51,
      );
    } else
      store.applyPull(
        [{ kind: "workout_exercise", id: entry, state: "deleted", revision: 51 }],
        51,
      );
    const before = store.get("workout_set", set.id);
    await press("Keep set deletion");
    expect(store.get("workout_set", set.id)).toEqual(before);
    return;
  }
  await press(choice);
  expect(store.get("workout_set", set.id)?.deleted).toBe(choice === "Keep set deletion");
  expect(store.get("workout_set", set.id)?.status).not.toBe("conflict");
});

it("resolves concurrent workout titles before copying the session to a routine", async () => {
  detailId = beginWorkout(store);
  const entry = addExercise(store, detailId, EXERCISES.bench, 60);
  logSet(store, store.list("workout_set", { parentId: entry })[0]!.id, { weightKg: 10, reps: 5 });
  finishWorkout(store, detailId, { countForRoutine: false });
  acknowledgeWorkoutRows();
  const original = store.get("workout", detailId)!.content!;
  store.put("workout", detailId, { ...original, title: "Local name" });
  store.applyPull(
    [
      {
        kind: "workout",
        id: detailId,
        revision: 50,
        state: "live",
        content: { ...original, title: "Remote name" },
      },
    ],
    50,
  );
  const { routineFromWorkout } = await import("../src/data/routine-from-workout.ts");
  expect(routineFromWorkout(store, detailId)).toHaveProperty("error");
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Review sync issue");
  expect(host.textContent).toContain("Remote name");
  store.applyPull(
    [
      {
        kind: "workout",
        id: detailId,
        state: "live",
        revision: 51,
        content: { ...original, title: "Latest name" },
      },
    ],
    51,
  );
  await press("Use server version");
  expect(store.get("workout", detailId)?.status).toBe("conflict");
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Use server version");
  expect(routineFromWorkout(store, detailId)).toMatchObject({ name: "Latest name" });
});

it.each([false, true])(
  "keeps the captured workout plan through a 1.0 title conflict (interrupted upgrade: %s)",
  async (interrupted) => {
    await usePreviewContract();
    detailId = beginWorkout(store);
    const entry = addExercise(store, detailId, EXERCISES.bench, 0);
    const [set] = store.list("workout_set", { parentId: entry });
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { reps: 8, weightKg: 20 });
    finishWorkout(store, detailId, { countForRoutine: false });
    const bare = store.get("workout", detailId)?.content;
    if (!bare) throw Error("Missing workout");
    const plan = { title: "Captured", exercises: [] };
    store.put("workout", detailId, { ...bare, initialPlan: plan });
    store.bindAccount("s", "alice");
    store.setNegotiated("1.0", []);
    store.applyPushResults(
      store.prepareSubmissions("1.0").map(({ submission }, i) => ({
        submissionId: submission.submissionId,
        status: "accepted",
        revision: i + 1,
      })),
    );
    store.put("workout", detailId, { ...bare, initialPlan: plan, title: "Local title" });
    if (interrupted) {
      store.setNegotiated("1.1", []);
      store.applyPull([], 0, { cursor: 0, lineage: null, release: "1.1", lastPage: true });
      store.setNegotiated("2.0", []);
      store.setNegotiated("1.0", []);
      expect(store.syncState().refreshFrom).toBe("1.1");
    }
    const remote: typeof bare = { ...bare, title: "Server title" };
    delete remote.initialPlan;
    store.applyPull(
      [{ kind: "workout", id: detailId, revision: 50, state: "live", content: remote }],
      50,
    );
    await act(() => root.render(h(WorkoutDetailScreen)));
    await press("Review sync issue");
    expect(host.textContent).toContain("supports the saved workout fields");
    expect(host.textContent).not.toContain("Use server version");
    const row = store.get("workout", detailId);
    if (!row) throw Error("Missing conflict");
    const { resolveWorkoutRecord } = await import("../src/data/workout-review.ts");
    expect(() => resolveWorkoutRecord(store, detailId, row, "keep_theirs")).toThrow();
    expect(store.get("workout", detailId)?.content?.initialPlan).toEqual(plan);
    store.setNegotiated("1.1", []);
    store.applyPull(
      [
        {
          kind: "workout",
          id: detailId,
          state: "live",
          revision: 50,
          content: { ...remote, initialPlan: null },
        },
      ],
      50,
      { cursor: 0, lineage: null, release: "1.1", lastPage: true },
    );
    await act(() => root.render(h(WorkoutDetailScreen)));
    await press("Keep my version");
    expect(store.get("workout", detailId)).toMatchObject({
      status: "pending",
      content: { title: "Local title", initialPlan: plan },
    });
  },
);

it("preserves a set corrected after offline Finish and before deletion uploads", async () => {
  detailId = beginWorkout(store);
  const a = addExercise(store, detailId, EXERCISES.bench, 60);
  const b = addExercise(store, detailId, EXERCISES.plank, 60);
  const [bench] = store.list("workout_set", { parentId: a });
  const [plank] = store.list("workout_set", { parentId: b });
  if (!bench || !plank) throw Error("Missing sets");
  logSet(store, bench.id, { weightKg: 20, reps: 5 });
  logSet(store, plank.id, { durationSeconds: 30 });
  acknowledgeWorkoutRows();
  const before = store.get("workout_set", bench.id)?.content;
  updateSet(store, bench.id, { completedAt: null });
  finishWorkout(store, detailId, { countForRoutine: false });
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: bench.id,
        state: "live",
        revision: 51,
        content: { ...before, reps: 12 },
      },
    ],
    51,
  );
  expect(store.get("workout_set", bench.id)).toMatchObject({
    status: "conflict",
    server: { content: { reps: 12 } },
  });
  expect(store.prepareSubmissions("1.0").map((s) => s.submission.id)).not.toContain(a);
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Review sync issue");
  await press("Review changes to set " + before?.position);
  await press("Use synced set");
  expect(store.get("workout_set", bench.id)?.content?.reps).toBe(12);
});

it.each(["before", "after"])(
  "keeps shared exercise ownership when Finish runs %s a delayed create receipt",
  (timing) => {
    detailId = beginWorkout(store);
    const entry = addExercise(store, detailId, EXERCISES.bench, 60);
    const other = addExercise(store, detailId, EXERCISES.plank, 60);
    const [plank] = store.list("workout_set", { parentId: other });
    if (!plank) throw Error("Missing plank");
    logSet(store, plank.id, { durationSeconds: 30 });
    acknowledgeWorkoutRows();
    const set = addSet(store, entry);
    const sent = store.prepareSubmissions("1.0").find((row) => row.submission.id === set);
    const original = store.get("workout_set", set)?.content;
    if (!sent || !original) throw Error("Missing create");
    removeWorkoutSet(store, set);
    const finish = () => finishWorkout(store, detailId, { countForRoutine: false });
    if (timing === "before") finish();
    store.applyPull(
      [
        {
          kind: "workout_set",
          id: set,
          state: "live",
          revision: 51,
          content: { ...original, reps: 12, completedAt: "2026-11-02T12:00:00Z" },
        },
      ],
      51,
    );
    store.applyPushResults([
      { submissionId: sent.submission.submissionId, status: "accepted", revision: 50 },
    ]);
    if (timing === "after") finish();
    expect(store.get("workout_exercise", entry)?.deleted).toBe(false);
    const batch = store.prepareSubmissions("1.0").map((row) => row.submission);
    expect(batch.map((s) => s.id)).not.toContain(entry);
    expect(batch.find((s) => s.id === set)).toMatchObject({ baseRevision: 50 });
    expect(store.get("workout_set", set)?.server?.content?.reps).toBe(12);
  },
);

it.each([false, true])(
  "withholds a deleted-set decision on 1.1 (interrupted upgrade: %s)",
  async (interrupted) => {
    await usePreviewContract();
    detailId = beginWorkout(store);
    const entry = addExercise(store, detailId, EXERCISES.bench, 60);
    const [set] = store.list("workout_set", { parentId: entry });
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { reps: 5, weightKg: 20, repsInReserve: 3 });
    logSet(store, addSet(store, entry), { reps: 8, weightKg: 10 });
    finishWorkout(store, detailId, { countForRoutine: false });
    acknowledgeWorkoutRows("2.0");
    if (interrupted) {
      store.setNegotiated("1.2", []);
      store.setNegotiated("2.0", []);
    }
    store.setNegotiated("1.1", []);
    const server = store.get("workout_set", set.id)?.content;
    if (!server) throw Error("Missing server set");
    const projection = { ...server, reps: 12 };
    Reflect.deleteProperty(projection, "repsInReserve");
    removeWorkoutSet(store, set.id);
    store.applyPull(
      [{ kind: "workout_set", id: set.id, state: "live", revision: 51, content: projection }],
      51,
    );
    await act(() => root.render(h(WorkoutDetailScreen)));
    await press("Review sync issue");
    await press("Review changes to set " + server.position);
    expect(host.textContent).toContain("Reps in reserve · Unavailable");
    expect(host.textContent).not.toContain("Keep set deletion");
  },
);

it.each(["save a copy", "accept deletion"])(
  "can %s after only the running workout title changed offline",
  async (decision) => {
    const id = beginWorkout(store);
    acknowledgeWorkoutRows();
    store.put("workout", id, { ...store.get("workout", id)!.content!, title: "My training" });
    store.applyPull([{ kind: "workout", id, state: "deleted", revision: 50 }], 50);
    expect(store.problems().map((row) => row.kind)).toEqual(["workout"]);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Review workout sync issue");
    if (decision === "save a copy") {
      await press("Save workout as new");
      expect(store.activeWorkout()?.content?.title).toBe("My training");
      expect(store.activeWorkout()?.id).not.toBe(id);
      expect(replaceRoute).toHaveBeenCalledWith("/workout/active");
    } else {
      await press("Accept workout deletion");
      await press("Delete workout and its local changes");
      expect(store.activeWorkout()).toBeNull();
      expect(beginWorkout(store)).not.toBe(id);
    }
    expect(store.get("workout", id)?.deleted).toBe(true);
  },
);

it("restores a rejected workout deletion from History before offering a fresh deletion of its corrected sets", async () => {
  const id = beginWorkout(store);
  const entry = addExercise(store, id, EXERCISES.bench, 60);
  const set = store.list("workout_set", { parentId: entry })[0]!;
  logSet(store, set.id, { weightKg: 20, reps: 5 });
  finishWorkout(store, id, { countForRoutine: false });
  acknowledgeWorkoutRows();
  const header = store.get("workout", id)!.content!;
  const original = store.get("workout_set", set.id)!.content!;
  discardWorkout(store, id);
  const edit = (revision: number) =>
    store.applyPull(
      [
        {
          kind: "workout",
          id,
          state: "live",
          revision,
          content: { ...header, title: "Corrected " + revision },
        },
      ],
      revision,
    );
  edit(50);
  expect(historyData(store).months).toEqual([]);
  const renderHistory = () => act(() => root.render(h(HistoryScreen)));
  await renderHistory();
  expect(host.textContent).toContain("Corrected 50");
  edit(51);
  await press("Restore workout to review");
  expect(store.get("workout", id)?.deleted).toBe(true);
  await renderHistory();
  await press("Restore workout to review");
  expect(store.get("workout", id)?.content?.title).toBe("Corrected 51");
  expect(replaceRoute).toHaveBeenCalledWith({ pathname: "/workout/[id]", params: { id } });
  detailId = id;
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Workout options");
  await press("Delete workout");
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: set.id,
        state: "live",
        revision: 52,
        content: { ...original, reps: 12 },
      },
    ],
    52,
  );
  await confirmAction("Delete workout");
  expect(store.get("workout", id)?.deleted).toBe(false);
  expect(store.get("workout_set", set.id)?.content?.reps).toBe(12);
  expect(host.textContent).toContain("review it again");
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Workout options");
  await press("Delete workout");
  await confirmAction("Delete workout");
  expect(store.get("workout", id)?.deleted).toBe(true);
});

it("keeps the other phone's correction when a workout deletion is rejected by the server", async () => {
  const original = store;
  const world = new World();
  try {
    const server = world.server();
    const account = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    store = a.store;
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0];
    if (!set) throw Error("Missing set");
    logSet(store, set.id, { weightKg: 20, reps: 5 });
    finishWorkout(store, id, { countForRoutine: false });
    await a.sync();
    await b.sync();
    discardWorkout(store, id);
    updateSet(b.store, set.id, { reps: 12 });
    await b.sync();
    await a.sync();
    await a.restart();
    store = a.store;
    await act(() => root.render(h(HistoryScreen)));
    await press("Restore workout to review");
    expect(readWorkoutTree(store, id)?.entries[0]?.sets[0]?.content.reps).toBe(12);
    await a.sync();
    expect(store.hasUnsyncedWork()).toBe(false);
    expect((await server.row("alice", "workout_set", set.id))?.content?.reps).toBe(12);
  } finally {
    store = original;
    await world.dispose();
  }
});

it("restores a disputed deletion from History when the backup predates that workout", async () => {
  const previous = store;
  const world = new World();
  try {
    const server = world.server();
    const account = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("local", account);
    const b = await world.phone("remote", account);
    store = a.store;
    await a.sync();
    const backup = join(world.directory, "before-workout.db");
    await server.snapshot("alice", backup);
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0]!;
    logSet(store, set.id, { weightKg: 20, reps: 5 });
    finishWorkout(store, id, { countForRoutine: false });
    await a.sync();
    await b.sync();
    discardWorkout(store, id);
    updateSet(b.store, set.id, { reps: 12 });
    await b.sync();
    await a.sync();
    await server.restoreWithCommand("alice", backup);
    await a.sync();
    await a.restart();
    store = a.store;
    expect(store.get("workout", id)).toMatchObject({
      deleted: true,
      status: "conflict",
      server: null,
      problem: { reason: "restored" },
    });
    await act(() => root.render(h(HistoryScreen)));
    expect(host.textContent).toContain("Previous server copy");
    await press("Restore workout to review");
    expect(replaceRoute).toHaveBeenCalledWith({ pathname: "/workout/[id]", params: { id } });
    expect(readWorkoutTree(store, id)?.entries[0]?.sets[0]?.content.reps).toBe(12);
    await a.sync();
    expect((await server.row("alice", "workout_set", set.id))?.content?.reps).toBe(12);
    expect(store.hasUnsyncedWork()).toBe(false);
  } finally {
    store = previous;
    await world.dispose();
  }
});

it("requires the replacement session to finish before restoring an unfinished workout", async () => {
  const id = beginWorkout(store);
  acknowledgeWorkoutRows();
  const header = store.get("workout", id)!.content!;
  discardWorkout(store, id);
  store.applyPull(
    [{ kind: "workout", id, state: "live", revision: 50, content: { ...header, title: "Remote" } }],
    50,
  );
  const render = () => act(() => root.render(h(HistoryScreen)));
  await render();
  const replacement = beginWorkout(store);
  await press("Restore workout to review");
  expect(store.activeWorkout()?.id).toBe(replacement);
  expect(store.get("workout", id)?.deleted).toBe(true);
  await render();
  expect(host.textContent).toContain("Finish or discard the current workout");
  discardWorkout(store, replacement);
  await render();
  await press("Restore workout to review");
  expect(store.activeWorkout()?.id).toBe(id);
});

it.each([ActiveWorkoutScreen, FinishScreen])(
  "keeps a corrected set when discarding a restored running workout on %s",
  async (Screen) => {
    const id = beginWorkout(store);
    const entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0]!;
    logSet(store, set.id, { weightKg: 20, reps: 5 });
    acknowledgeWorkoutRows();
    const header = store.get("workout", id)!.content!;
    discardWorkout(store, id);
    store.applyPull(
      [
        {
          kind: "workout",
          id,
          state: "live",
          revision: 50,
          content: { ...header, title: "Restored" },
        },
      ],
      50,
    );
    await act(() => root.render(h(HistoryScreen)));
    await press("Restore workout to review");
    await act(() => root.render(h(Screen)));
    await press("Discard workout");
    const original = store.get("workout_set", set.id)!.content!;
    store.applyPull(
      [
        {
          kind: "workout_set",
          id: set.id,
          state: "live",
          revision: 51,
          content: { ...original, reps: 12 },
        },
      ],
      51,
    );
    await confirmAction("Discard workout");
    expect(store.activeWorkout()?.id).toBe(id);
    expect(store.get("workout_set", set.id)?.content?.reps).toBe(12);
  },
);

it("preserves a corrected hidden set when sync rejects its deletion between discard taps", async () => {
  const original = store;
  const world = new World();
  try {
    const server = world.server();
    const account = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", account),
      b = await world.phone("b", account);
    store = a.store;
    const id = beginWorkout(store),
      entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0]!;
    logSet(store, set.id, { reps: 5, weightKg: 20 });
    addSet(store, entry);
    await a.sync();
    await b.sync();
    removeWorkoutSet(store, set.id);
    await act(() => root.render(h(ActiveWorkoutScreen)));
    await press("Discard workout");
    updateSet(b.store, set.id, { reps: 12 });
    await b.sync();
    await a.sync();
    expect(store.get("workout_set", set.id)?.status).toBe("conflict");
    await confirmAction("Discard workout");
    expect(store.activeWorkout()?.id).toBe(id);
    await a.sync();
    expect((await server.row("alice", "workout_set", set.id))?.content?.reps).toBe(12);
  } finally {
    store = original;
    await world.dispose();
  }
});

it.each([false, true])(
  "restores an oversized deletion from History (backup predates workout: %s)",
  async (restored) => {
    const id = beginWorkout(store),
      entry = addExercise(store, id, EXERCISES.bench, 60);
    const set = store.list("workout_set", { parentId: entry })[0]!;
    acknowledgeWorkoutRows();
    store.applyPull(
      Array.from({ length: 1999 }, (_, index) => ({
        kind: "workout_set",
        id: "extra-" + index,
        revision: 10 + index,
        state: "live" as const,
        content: { ...set.content!, position: index + 2 },
      })),
      2008,
    );
    discardWorkout(store, id);
    store.prepareSubmissions("1.0");
    if (restored) {
      store.resetForServerRestore();
      store.setNegotiated("1.0", [], "restored");
      store.completeRestore();
      expect(store.get("workout", id)).toMatchObject({
        deleted: true,
        server: null,
        status: "invalid",
        problem: { reason: "invalid:too_many_descendants" },
      });
    }
    await act(() => root.render(h(HistoryScreen)));
    expect(host.textContent).toContain("too large to delete");
    await press("Restore workout to review");
    expect(store.activeWorkout()?.id).toBe(id);
    expect(store.list("workout_set", { parentId: entry })).toHaveLength(2000);
  },
  60_000,
);

it("keeps the corrected set when an exercise changes between removal taps", async () => {
  const id = beginWorkout(store),
    e = addExercise(store, id, EXERCISES.bench, 60);
  const set = store.list("workout_set", { parentId: e })[0]!;
  logSet(store, set.id, { reps: 5, weightKg: 20 });
  acknowledgeWorkoutRows();
  const content = store.get("workout_set", set.id)!.content!;
  await act(() => root.render(h(ActiveWorkoutScreen)));
  await press("Manage Bench Press");
  await press("Remove exercise");
  store.applyPull(
    [
      {
        kind: "workout_set",
        id: set.id,
        state: "live",
        revision: 50,
        content: { ...content, reps: 12 },
      },
    ],
    50,
  );
  await confirmAction("Remove exercise");
  expect(store.get("workout_exercise", e)?.deleted).toBe(false);
  expect(store.get("workout_set", set.id)?.content?.reps).toBe(12);
  expect(host.textContent).toContain("Review it before removing");
});

it("allows keeping a finished session when the server version would reopen it beside another workout", async () => {
  detailId = beginWorkout(store);
  const e = addExercise(store, detailId, EXERCISES.bench, 60);
  logSet(store, store.list("workout_set", { parentId: e })[0]!.id, { reps: 5, weightKg: 20 });
  acknowledgeWorkoutRows();
  const original = store.get("workout", detailId)!.content!;
  finishWorkout(store, detailId, { countForRoutine: false });
  store.applyPull(
    [
      {
        kind: "workout",
        id: detailId,
        state: "live",
        revision: 50,
        content: { ...original, title: "Still running" },
      },
    ],
    50,
  );
  await act(() => root.render(h(WorkoutDetailScreen)));
  await press("Review sync issue");
  const next = beginWorkout(store);
  await press("Use server version");
  expect(store.get("workout", detailId)?.status).toBe("conflict");
  await act(() => root.render(h(WorkoutDetailScreen)));
  expect(host.textContent).not.toContain("Use server version");
  await press("Keep my version");
  expect(store.activeWorkout()?.id).toBe(next);
  expect(store.get("workout", detailId)?.content?.endedAt).toBeTruthy();
});
