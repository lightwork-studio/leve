/// <reference lib="dom" />
import { act, createElement } from "react";
import { Text, View } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import TrainScreen from "../app/(tabs)/index.tsx";

let reduced = false;
let activeTitle: string | null = "Bench";
let upNext: { id: string; title: string } | null = null;
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => reduced }));
const push = vi.fn();
const change = vi.fn();
vi.mock("expo-router", () => ({ router: { push: (...args: unknown[]) => push(...args) } }));
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  View: "View",
  Text: "Text",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 30 }) }));
vi.mock("../src/ui/screen.tsx", () => ({ TabScreen: "Screen", HeaderButton: "HeaderButton" }));
// The slot draws what a screen offers elsewhere; here the offer stays in the tree to be inspected.
vi.mock("../src/ui/main-action.tsx", () => ({ MainAction: "MainAction" }));
vi.mock("../src/ui/commit-button.tsx", () => ({ CommitButton: "CommitButton" }));
vi.mock("../src/ui/enter.tsx", () => ({ Enter: "Enter" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/new-folder-dialog.tsx", () => ({ NewFolderDialog: "Dialog" }));
// A row's ⋯ menu keeps its items in the tree, to be pressed by name.
vi.mock("../src/ui/popover-menu.tsx", () => ({ MoreButton: "MoreButton" }));
vi.mock("../src/ui/group.tsx", () => ({ Group: "Group" }));
vi.mock("../src/ui/use-now.ts", () => ({ useNow: () => 0 }));
vi.mock("../src/ui/haptics.ts", () => ({ haptic: { tap: vi.fn(), select: vi.fn() } }));
vi.mock("../src/ui/icons.tsx", () => ({
  ChevronIcon: "Chevron",
  EditIcon: "Edit",
  LibraryIcon: "Library",
  FolderIcon: "Folder",
  FolderPlusIcon: "FolderPlus",
  ForwardIcon: "Forward",
  GearIcon: "Gear",
  MoreIcon: "More",
  PlayIcon: "Play",
  PlusIcon: "Plus",
  TrayIcon: "Tray",
}));
vi.mock("../src/data/app-data.tsx", () => ({ useAppData: () => ({ change }) }));
const beginWorkout = vi.fn();
vi.mock("../src/data/workout-actions.ts", () => ({
  beginWorkout: (...args: unknown[]) => beginWorkout(...args),
}));
vi.mock("../src/data/queries.ts", () => ({
  useTrain: () => ({
    settings: { weightUnit: "kg" },
    upNext,
    active: activeTitle === null ? null : { content: { title: activeTitle } },
    week: {
      workouts: 2,
      minutes: 75,
      volumeKg: 12_480,
      sets: 21,
      days: weekdays.map((name, index) => ({
        name,
        letter: name[0],
        today: index === 3,
        trained: index === 0 || index === 3,
        volumeKg: index === 0 ? 8000 : index === 3 ? 4480 : 0,
      })),
    },
    groups: ["Home", "Gym"].map((id) => ({
      folder: { id, content: { title: id, position: 1 } },
      routines: Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        title: `Routine ${i + 1}`,
        exerciseNames: i === 0 ? ["Bench Press"] : [],
        exerciseCount: i === 0 ? 1 : 0,
        daysSinceLast: null,
      })),
    })),
  }),
}));

it.each([false, true])(
  "reveals the expanded folder header after layout, opens rename independently, and leaves the main action to the running workout (reduced motion %s)",
  async (preference) => {
    reduced = preference;
    // A routine is up next, but while a workout runs the slot shows that workout instead.
    upNext = { id: "2", title: "Routine 3" };
    change.mockClear();
    push.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let nextFrame: (() => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      nextFrame = callback;
    });
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(createElement(TrainScreen));
      });
      if (!screen) throw new Error("Train did not mount");
      const root = screen.root;
      const scrollTo = vi.fn();
      root.find((n) => n.props.title === "Train").props.scrollRef.current = { scrollTo };
      const layouts = () =>
        root.findAll((n) => n.type === View && typeof n.props.onLayout === "function");
      const layout = (y: number, height: number) => ({ nativeEvent: { layout: { y, height } } });
      layouts()[0]?.props.onLayout(layout(270, 2500));
      await act(() => choose(root, "Gym options", "Rename folder"));
      const closedFolderDialog = root.findByProps({ initialName: "Gym" });
      expect(root.find((n) => n.props.accessibilityState?.expanded === false)).toBeDefined();
      expect(nextFrame).toBeUndefined();
      await act(() => closedFolderDialog.props.onFinish(null));
      await act(() =>
        root.find((n) => n.props.accessibilityState?.expanded === false).props.onPress(),
      );
      layouts().at(-1)?.props.onLayout(layout(1050, 1300));
      expect(scrollTo).not.toHaveBeenCalled();
      nextFrame?.();
      expect(scrollTo).toHaveBeenCalledWith({ y: 1282, animated: !preference });
      await act(() => choose(root, "Gym options", "Rename folder"));
      expect(root.findByProps({ initialName: "Gym" })).toBeDefined();
      expect(root.findAll((n) => n.props.accessibilityState?.expanded === true)).toHaveLength(2);
      // While a workout runs, the slot shows it (with its own Resume), so Train offers no start.
      expect(root.findByType("MainAction" as never).props.children).toBeNull();
      expect(root.findAllByProps({ accessibilityLabel: "Start empty workout" })).toHaveLength(0);
      expect(root.findAllByProps({ accessibilityLabel: "Start Routine 3, up next" })).toHaveLength(
        0,
      );
      expect(push).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
    } finally {
      upNext = null;
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it.each([null, "Strength and conditioning with a long accessory circuit"])(
  "exposes the full weekly strip and offers a start only when no workout runs (%s)",
  async (title) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    activeTitle = title;
    change.mockClear();
    push.mockClear();
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(createElement(TrainScreen));
      });
      if (!screen) throw new Error("Train did not mount");
      const days = screen.root.findAll(
        (n) =>
          n.type === View &&
          n.props.accessible &&
          /this week|day\b/.test(n.props.accessibilityLabel),
      );
      expect(days.map((day) => day.props.accessibilityLabel)).toEqual([
        "2 workouts this week",
        "Monday, trained",
        "Tuesday",
        "Wednesday",
        "Thursday, trained, today",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
      const offered = screen.root.findByType("MainAction" as never).props.children;
      if (title) {
        expect(offered).toBeNull();
        return;
      }
      const action = screen.root.findByProps({ accessibilityLabel: "Start empty workout" });
      expect(action.props).toMatchObject({
        variant: "slot",
        label: "Start",
        title: "Empty workout",
      });
      await act(() => action.props.onPress());
      expect(change).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledWith("/workout/active");
    } finally {
      activeTitle = "Bench";
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

/** The nearest thing above a routine's title that does something when tapped. */
const rowAction = (root: ReactTestRenderer["root"], title: string) => {
  const text = root.find((n) => n.type === Text && n.props.children === title);
  let target = text.parent;
  while (target && typeof target.props.onPress !== "function") target = target.parent;
  return target;
};
const menuOf = (root: ReactTestRenderer["root"], title: string) =>
  root.findByProps({ label: `${title} options` });

it("starts a routine from a tap on its row, and edits it from the row's menu", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeTitle = null;
  change.mockClear();
  push.mockClear();
  beginWorkout.mockClear();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    const row = rowAction(root, "Routine 1");
    if (!row) throw Error("Routine row has no action");
    expect(row.props.accessibilityLabel).toBe(
      "Start Routine 1, Bench Press, 1 exercise · not done yet",
    );
    await act(() => row.props.onPress());
    // The tap begins a workout from this routine and opens it, as the start button did.
    expect(change).toHaveBeenCalledTimes(1);
    const [apply, scope] = change.mock.calls[0] ?? [];
    apply({});
    expect(scope).toBe("active-workout");
    expect(beginWorkout).toHaveBeenCalledWith({}, "0");
    expect(push.mock.calls).toEqual([["/workout/active"]]);

    // Editing moved to the row's menu.
    const menu = menuOf(root, "Routine 1");
    expect(menu.props.items.map((item: { label: string }) => item.label)).toEqual(["Edit routine"]);
    await act(() => menu.props.items[0].onPress());
    expect(push.mock.calls[1]).toEqual([{ pathname: "/routine/[id]", params: { id: "0" } }]);
    expect(change).toHaveBeenCalledTimes(1);
  } finally {
    activeTitle = "Bench";
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("starts nothing from a routine while a workout runs, but still edits it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  change.mockClear();
  push.mockClear();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    expect(rowAction(root, "Routine 1")).toBeNull();
    expect(root.findAll((n) => /^Start Routine/.test(n.props.accessibilityLabel ?? ""))).toEqual(
      [],
    );
    expect(
      root.findAll((n) => n.type === Text && /Finish or discard/.test(String(n.props.children))),
    ).toHaveLength(1);
    await act(() => menuOf(root, "Routine 1").props.items[0].onPress());
    expect(push.mock.calls).toEqual([[{ pathname: "/routine/[id]", params: { id: "0" } }]]);
    expect(change).not.toHaveBeenCalled();
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("opens the exercise library from Train, so back leads to Train", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  push.mockClear();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const library = screen.root.findByProps({
      accessibilityLabel: "Exercises, records and history by name or muscle",
    });
    await act(() => library.props.onPress());
    expect(push.mock.calls).toEqual([[{ pathname: "/exercises", params: { from: "train" } }]]);
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("draws each day's bar against the week's biggest day and totals the week underneath", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const days = screen.root.findAll(
      (n) => n.type === View && n.props.accessible && /day/.test(n.props.accessibilityLabel),
    );
    const heights = days.map((day) => {
      const bar = day.findAllByType(View)[1];
      const styles = [bar?.props.style].flat(2);
      return styles.find((style) => style && "height" in style)?.height;
    });
    // Monday holds the most (8,000 kg) and fills the bar; Thursday's 4,480 kg is 56% of it.
    // Days without a workout are stubs, except today, which is ringed at its own height.
    expect(heights).toEqual([34, 3, 3, (4480 / 8000) * 34, 3, 3, 3]);
    const totals = screen.root
      .findAll((n) => n.type === Text && /^(Volume|Time|Sets) /.test(n.props.accessibilityLabel))
      .map((n) => n.props.accessibilityLabel);
    expect(totals).toEqual(["Volume 12.4k kg", "Time 1 h 15 min", "Sets 21"]);
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("starts a suggested routine from the main button and an empty workout from the tile", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { StartActions } = await import("../src/ui/start-actions.tsx");
  const onStart = vi.fn();
  let actions: ReactTestRenderer | undefined;
  try {
    await act(() => {
      actions = create(
        createElement(StartActions, { suggested: { id: "r1", title: "Pull" }, onStart }),
      );
    });
    if (!actions) throw Error("Start actions did not mount");
    const main = actions.root.findByProps({ accessibilityLabel: "Start Pull, up next" });
    expect(main.props).toMatchObject({ label: "Start · up next", title: "Pull" });
    await act(() => main.props.onPress());
    await act(() =>
      actions?.root.findByProps({ accessibilityLabel: "Start empty workout" }).props.onPress(),
    );
    expect(onStart.mock.calls).toEqual([["r1"], []]);
  } finally {
    await act(() => actions?.unmount());
    vi.unstubAllGlobals();
  }
});

it("offers the routine up next when idle and starts it just as its card does", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeTitle = null;
  upNext = { id: "2", title: "Routine 3" };
  change.mockClear();
  push.mockClear();
  beginWorkout.mockClear();
  const store = { name: "store" };
  // Runs each change against a stand-in store, so the start it makes can be compared.
  const started = () =>
    change.mock.calls.map(([apply, scope]) => {
      beginWorkout.mockClear();
      apply(store);
      return [scope, ...beginWorkout.mock.calls];
    });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    const main = root.findByProps({ accessibilityLabel: "Start Routine 3, up next" });
    expect(main.props).toMatchObject({
      variant: "slot",
      label: "Start · up next",
      title: "Routine 3",
    });
    await act(() => main.props.onPress());
    // The same routine's card: the first folder is open, so its third row is on show.
    const card = rowAction(root, "Routine 3");
    expect(card?.props.accessibilityLabel).toMatch(/^Start Routine 3, /);
    await act(() => card?.props.onPress());
    await act(() =>
      root.findByProps({ accessibilityLabel: "Start empty workout" }).props.onPress(),
    );
    expect(started()).toEqual([
      ["active-workout", [store, "2"]],
      ["active-workout", [store, "2"]],
      ["active-workout", [store, undefined]],
    ]);
    expect(push.mock.calls).toEqual([
      ["/workout/active"],
      ["/workout/active"],
      ["/workout/active"],
    ]);
  } finally {
    activeTitle = "Bench";
    upNext = null;
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

/** Presses the item called `item` in the menu whose tile is labelled `menu`. */
const choose = (root: ReactTestRenderer["root"], menu: string, item: string) => {
  const items: { label: string; onPress: () => void }[] = root.findByProps({ label: menu }).props
    .items;
  const found = items.find((entry) => entry.label === item);
  if (!found) throw Error(`${menu} has no ${item}`);
  found.onPress();
};

it("adds a routine or a folder from the one + menu, and a routine straight into a folder", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  change.mockClear();
  push.mockClear();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    // The heading has a single + tile; its menu holds both things to add.
    expect(root.findAllByProps({ accessibilityLabel: "New folder" })).toHaveLength(0);
    expect(root.findAllByProps({ accessibilityLabel: "New routine" })).toHaveLength(0);
    const add = root.findByProps({ label: "Add routine or folder" });
    expect(add.props.items.map((item: { label: string }) => item.label)).toEqual([
      "New routine",
      "New folder",
    ]);
    await act(() => choose(root, "Add routine or folder", "New routine"));
    expect(push.mock.calls).toEqual([["/routine/new"]]);
    expect(root.findAllByType("Dialog" as never)).toHaveLength(0);
    await act(() => choose(root, "Add routine or folder", "New folder"));
    const dialog = root.findByType("Dialog" as never);
    expect(dialog.props.initialName).toBeUndefined();

    // Each folder's menu, open (Home) or closed (Gym), adds a routine filed in that folder.
    for (const [title, id] of [
      ["Home", "Home"],
      ["Gym", "Gym"],
    ]) {
      push.mockClear();
      const menu = root.findByProps({ label: `${title} options` });
      expect(menu.props.items.map((item: { label: string }) => item.label)).toEqual([
        "New routine",
        "Rename folder",
      ]);
      await act(() => choose(root, `${title} options`, "New routine"));
      expect(push.mock.calls).toEqual([[{ pathname: "/routine/new", params: { folder: id } }]]);
    }
    expect(change).not.toHaveBeenCalled();
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});
