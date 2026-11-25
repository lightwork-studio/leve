/// <reference lib="dom" />
import { act, createElement } from "react";
import { Text, View } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import TrainScreen from "../app/(tabs)/index.tsx";

let reduced = false;
let activeTitle: string | null = "Bench";
let activeRoutine: string | null = null;
let activeId = "w1";
let upNext: { id: string; title: string } | null = null;
// Replaces the two folders of twenty routines each, for the cases that need other groups.
let groupsOverride: unknown[] | null = null;
let reviews: unknown[] = [];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => reduced }));
const push = vi.fn();
const change = vi.fn();
vi.mock("expo-router", () => ({ router: { push: (...args: unknown[]) => push(...args) } }));
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  Platform: { OS: "web" },
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
vi.mock("../src/ui/train-sync-review.tsx", () => ({ TrainSyncReview: "TrainSyncReview" }));
vi.mock("../src/ui/use-now.ts", () => ({ useNow: () => 0 }));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: vi.fn(), select: vi.fn(), warning: vi.fn() },
}));
// The sheet keeps its choices in the tree, to be pressed by name.
vi.mock("../src/ui/action-sheet.tsx", () => ({ ActionSheet: "ActionSheet" }));
// Work after feedback runs at once, unless a test holds it to see the busy state first.
let held: (() => void)[] | null = null;
vi.mock("../src/ui/after-feedback.ts", () => ({
  afterFeedback: (run: () => void) => {
    if (held) held.push(run);
    else run();
    return () => {};
  },
}));
const showToast = vi.fn();
vi.mock("../src/ui/notice.tsx", () => ({ showToast: (text: string) => showToast(text) }));
const skipRest = vi.fn();
vi.mock("../src/data/rest-timer.ts", () => ({
  restTimer: { skip: (...args: unknown[]) => skipRest(...args) },
}));
// Each snapshot differs, so the one discarded can be traced to the tap that opened the sheet.
let snapshots = 0;
const snapshot = vi.fn(() => ({ seen: ++snapshots }));
const replace = vi.fn();
vi.mock("../src/data/workout-review.ts", () => ({
  workoutDeletionSnapshot: (...args: unknown[]) => snapshot(...(args as [])),
  replaceReviewedActiveWorkout: (...args: unknown[]) => replace(...args),
}));
vi.mock("../src/ui/icons.tsx", () => ({
  ChevronIcon: "Chevron",
  EditIcon: "Edit",
  FolderIcon: "Folder",
  ForwardIcon: "Forward",
  GearIcon: "Gear",
  MoreIcon: "More",
  PlayIcon: "Play",
  PlusIcon: "Plus",
  TrayIcon: "Tray",
}));
const appStore = { name: "store" };
vi.mock("../src/data/app-data.tsx", () => ({ useAppData: () => ({ change, store: appStore }) }));
const beginWorkout = vi.fn();
vi.mock("../src/data/workout-actions.ts", () => ({
  beginWorkout: (...args: unknown[]) => beginWorkout(...args),
}));
vi.mock("../src/data/queries.ts", () => ({
  // The running workout: one set logged of two.
  useLive: () =>
    activeTitle === null
      ? null
      : {
          tree: {
            workout: { content: { title: activeTitle } },
            entries: [
              { sets: [{ content: { completedAt: "x" } }, { content: { completedAt: null } }] },
            ],
          },
        },
  useTrain: () => ({
    settings: { weightUnit: "kg" },
    reviews,
    upNext,
    active:
      activeTitle === null
        ? null
        : { id: activeId, content: { title: activeTitle, routineId: activeRoutine } },
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
    groups:
      groupsOverride ??
      ["Home", "Gym"].map((id) => ({
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

/** Presses the control with this accessibility label. */
const press = (root: ReactTestRenderer["root"], label: string) =>
  root.findByProps({ accessibilityLabel: label }).props.onPress();
const labelled = (root: ReactTestRenderer["root"], pattern: RegExp) =>
  root
    .findAll((n) => typeof n.type === "string" && pattern.test(n.props.accessibilityLabel ?? ""))
    .map((n) => n.props.accessibilityLabel);

it.each([false, true])(
  "reveals the expanded folder header after layout, renames only open folders, and leaves the main action to the running workout (reduced motion %s)",
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
      // Only an open folder offers rename, beside its header; a closed one is opened first.
      expect(labelled(root, /^Edit .* folder$/)).toEqual(["Edit Home folder"]);
      await act(() => press(root, "Edit Home folder"));
      const openFolderDialog = root.findByProps({ initialName: "Home" });
      expect(nextFrame).toBeUndefined();
      await act(() => openFolderDialog.props.onFinish(null));
      await act(() =>
        root.find((n) => n.props.accessibilityState?.expanded === false).props.onPress(),
      );
      layouts().at(-1)?.props.onLayout(layout(1050, 1300));
      expect(scrollTo).not.toHaveBeenCalled();
      nextFrame?.();
      expect(scrollTo).toHaveBeenCalledWith({ y: 1282, animated: !preference });
      await act(() => press(root, "Edit Gym folder"));
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
it("starts a routine from a tap on its row, and edits it from the row's pencil", async () => {
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

    // The pencil beside the row edits the routine and starts nothing.
    const edit = root.findByProps({ accessibilityLabel: "Edit Routine 1" });
    expect(edit).not.toBe(row);
    await act(() => edit.props.onPress());
    expect(push.mock.calls[1]).toEqual([{ pathname: "/routine/[id]", params: { id: "0" } }]);
    expect(change).toHaveBeenCalledTimes(1);
  } finally {
    activeTitle = "Bench";
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("asks what to do with the running workout before starting another routine", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Routine 2 is the one running.
  activeRoutine = "1";
  for (const mock of [change, push, snapshot, replace, skipRest, showToast]) mock.mockClear();
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    const sheet = () => root.findAllByType("ActionSheet" as never)[0];
    const tap = (title: string) => act(() => rowAction(root, title)?.props.onPress());
    // The sheet replaces the note that used to explain why nothing happened.
    expect(
      root.findAll((n) => n.type === Text && /Finish or discard/.test(String(n.props.children))),
    ).toHaveLength(0);

    // The running routine's own row opens that workout again; the others ask first.
    expect(rowAction(root, "Routine 2")?.props.accessibilityLabel).toMatch(/^Resume Routine 2, /);
    expect(rowAction(root, "Routine 1")?.props).toMatchObject({
      accessibilityLabel: expect.stringMatching(/^Start Routine 1, /),
      accessibilityHint: "Asks what to do with the running workout first",
    });
    await tap("Routine 2");
    expect(push.mock.calls).toEqual([["/workout/active"]]);
    expect(sheet()).toBeUndefined();

    await tap("Routine 1");
    expect(sheet()?.props).toMatchObject({
      message: "Bench is still running, with 1 logged set. Discarding it can’t be undone.",
      action: "Discard and start Routine 1",
    });
    expect(sheet()?.props.choices.map((c: { label: string }) => c.label)).toEqual([
      "Resume Bench",
      "Finish, then start Routine 1",
    ]);
    // What the person is shown is noted as the sheet opens; nothing is written yet.
    expect(snapshot).toHaveBeenCalledWith(appStore, "w1");
    expect(change).not.toHaveBeenCalled();

    await act(() => sheet()?.props.choices[0].onPress());
    expect(sheet()).toBeUndefined();
    await tap("Routine 1");
    await act(() => sheet()?.props.choices[1].onPress());
    await tap("Routine 1");
    await act(() => sheet()?.props.onClose());
    expect(sheet()).toBeUndefined();
    expect(push.mock.calls.slice(1)).toEqual([
      ["/workout/active"],
      [{ pathname: "/workout/finish", params: { next: "0" } }],
    ]);
    expect(change).not.toHaveBeenCalled();

    // Discarding replaces the workout as it was shown with the routine, then opens it. The sheet
    // shows it is busy for a frame first, and a second press meanwhile does nothing.
    await tap("Routine 1");
    const seen = snapshot.mock.results.at(-1)?.value;
    const taken = snapshot.mock.calls.length;
    held = [];
    await act(() => sheet()?.props.onConfirm());
    await act(() => sheet()?.props.onConfirm());
    expect(sheet()?.props.busy).toBe(true);
    expect(held).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
    const queued = held;
    held = null;
    await act(() => {
      for (const run of queued) run();
    });
    expect(change).toHaveBeenCalledTimes(1);
    const [apply, scope] = change.mock.calls[0] ?? [];
    expect(scope).toBe("active-workout");
    apply(appStore);
    expect(snapshot).toHaveBeenCalledTimes(taken);
    expect(replace).toHaveBeenCalledWith(appStore, "w1", seen, "0");
    expect(skipRest).toHaveBeenCalledWith(appStore, "w1");
    expect(push.mock.calls.at(-1)).toEqual(["/workout/active"]);
    expect(sheet()).toBeUndefined();

    // A refusal (the workout changed meanwhile) says why and starts nothing.
    push.mockClear();
    skipRest.mockClear();
    change.mockImplementationOnce(() => {
      throw Error("The active workout changed. Review it before discarding.");
    });
    await tap("Routine 3");
    await act(() => sheet()?.props.onConfirm());
    expect(showToast).toHaveBeenCalledWith(
      "The active workout changed. Review it before discarding.",
    );
    expect(push).not.toHaveBeenCalled();
    expect(skipRest).not.toHaveBeenCalled();
    expect(sheet()).toBeUndefined();

    // A sheet opened for a workout that has since ended isn't shown for the next one.
    await tap("Routine 3");
    expect(sheet()).toBeDefined();
    activeId = "w2";
    await act(() => screen?.update(createElement(TrainScreen)));
    expect(sheet()).toBeUndefined();
    activeId = "w1";
    push.mockClear();

    // Editing from the row's pencil still works while a workout runs, without asking first.
    await act(() => press(root, "Edit Routine 1"));
    expect(sheet()).toBeUndefined();
    expect(push.mock.calls).toEqual([[{ pathname: "/routine/[id]", params: { id: "0" } }]]);
  } finally {
    activeRoutine = null;
    activeId = "w1";
    held = null;
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

/** The card a row sits in: the nearest `Enter` (closed folders) or `View` above it. */
const cardOf = (root: ReactTestRenderer["root"], label: string) => {
  let node = root.findByProps({ accessibilityLabel: label }).parent;
  while (node && node.type !== ("Enter" as never) && node.type !== View) node = node.parent;
  return node;
};

it("adds a routine at the end of each open folder, and a folder after the closed ones", async () => {
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
    // The heading holds no add button, and no row has a ⋯ menu.
    expect(root.findAll((n) => /options$|^Add routine or folder$/.test(n.props.label))).toEqual([]);
    // Home starts open and ends with its own add row; Gym is closed, so it offers none yet.
    expect(labelled(root, /^Add routine/)).toEqual(["Add routine to Home"]);
    await act(() => press(root, "Add routine to Home"));
    expect(push.mock.calls).toEqual([[{ pathname: "/routine/new", params: { folder: "Home" } }]]);

    // New folder ends the card of closed folders, right under Gym.
    const closed = cardOf(root, "New folder");
    expect(closed?.type).toBe("Enter");
    expect(
      closed?.findAll(
        (n) => n.type === ("Tap" as never) && n.props.accessibilityState?.expanded === false,
      ),
    ).toHaveLength(1);
    await act(() => press(root, "New folder"));
    const dialog = root.findByType("Dialog" as never);
    expect(dialog.props.initialName).toBeUndefined();
    await act(() => dialog.props.onFinish(null));

    // With Gym open too, each folder ends with its own add row, and New folder ends the section.
    await act(() =>
      root.find((n) => n.props.accessibilityState?.expanded === false).props.onPress(),
    );
    expect(labelled(root, /^Add routine/)).toEqual(["Add routine to Home", "Add routine to Gym"]);
    expect(labelled(root, /^New folder$/)).toHaveLength(1);
    expect(cardOf(root, "New folder")?.findAllByType("Tap" as never)).toHaveLength(1);
    push.mockClear();
    await act(() => press(root, "Add routine to Gym"));
    expect(push.mock.calls).toEqual([[{ pathname: "/routine/new", params: { folder: "Gym" } }]]);
    expect(change).not.toHaveBeenCalled();
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  ["no routines or folders yet", [], "Or start with a folder"],
  [
    "only routines outside a folder",
    [
      {
        folder: null,
        routines: [
          { id: "r", title: "Full body", exerciseNames: [], exerciseCount: 0, daysSinceLast: null },
        ],
      },
    ],
    "New folder",
  ],
])(
  "still offers both adds with %s, filing the routine in no folder",
  async (_, groups, folderLabel) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    groupsOverride = groups;
    push.mockClear();
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(createElement(TrainScreen));
      });
      if (!screen) throw Error("Train did not mount");
      const root = screen.root;
      // There is no folder to edit.
      expect(labelled(root, /^Edit .* folder$/)).toEqual([]);
      expect(labelled(root, /^Add routine|^New folder$|folder$/)).toEqual([
        "Add routine",
        folderLabel,
      ]);
      // With nothing yet, the two adds are an empty state's actions, not rows of one card.
      const empty = root.findAll((n) => n.type === Text && n.props.children === "No routines yet");
      expect(empty).toHaveLength(groups.length === 0 ? 1 : 0);
      await act(() => press(root, "Add routine"));
      expect(push.mock.calls).toEqual([["/routine/new"]]);
      await act(() => press(root, folderLabel));
      expect(root.findByType("Dialog" as never).props.initialName).toBeUndefined();
    } finally {
      groupsOverride = null;
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("deletes a folder from its edit dialog, shows where its routines went, and hands a refusal back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  change.mockReset();
  const row = (id: string, title: string) => ({
    id,
    title,
    exerciseNames: [],
    exerciseCount: 0,
    daysSinceLast: null,
  });
  groupsOverride = [
    {
      folder: { id: "Home", content: { title: "Home", position: 1 } },
      routines: [row("h", "Push")],
    },
    { folder: null, routines: [row("l", "Full body")] },
  ];
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    const dialog = () => root.findAllByType("Dialog" as never);
    // Not in a folder starts closed.
    expect(labelled(root, /^Add routine$/)).toEqual([]);
    await act(() => press(root, "Edit Home folder"));
    expect(dialog()[0]?.props.routineCount).toBe(1);
    // A refusal from the store reaches the dialog to show, and the dialog stays open.
    change.mockImplementationOnce(() => {
      throw new Error("Resolve the sync issue on this folder before deleting it.");
    });
    await act(async () =>
      expect(() => dialog()[0]?.props.onDelete()).toThrow(/sync issue on this folder/),
    );
    expect(dialog()).toHaveLength(1);
    // The deletion runs against the folder the dialog was opened for, then the dialog closes.
    const deleted: string[] = [];
    change.mockImplementationOnce((write: (store: unknown) => void) =>
      write({
        get: (kind: string, id: string) =>
          kind === "routine_folder"
            ? { id, content: { title: id, position: 1 }, deleted: false }
            : null,
        delete: (kind: string, id: string) => deleted.push(`${kind}:${id}`),
      }),
    );
    await act(() => dialog()[0]?.props.onDelete());
    expect(deleted).toEqual(["routine_folder:Home"]);
    expect(dialog()).toHaveLength(0);
    // Not in a folder opens, where the folder's routines now are.
    expect(labelled(root, /^Add routine$/)).toEqual(["Add routine"]);
  } finally {
    groupsOverride = null;
    change.mockReset();
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("offers Add routine in an open empty folder, and New folder once after a closed run between open ones", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const folder = (id: string, position: number) => ({ id, content: { title: id, position } });
  groupsOverride = [
    { folder: folder("Arms", 1), routines: [] },
    {
      folder: folder("Legs", 2),
      routines: [
        { id: "l", title: "Squat day", exerciseNames: [], exerciseCount: 0, daysSinceLast: null },
      ],
    },
    { folder: folder("Mobility", 3), routines: [] },
  ];
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    // Arms starts open with nothing in it: its card still holds the row that fills it.
    expect(cardOf(root, "Add routine to Arms")?.findAllByType("Tap" as never)).toHaveLength(1);
    // Open Mobility, leaving Legs as a closed run between two open folders.
    const closed = () =>
      root.findAll(
        (n) => n.type === ("Tap" as never) && n.props.accessibilityState?.expanded === false,
      );
    expect(closed()).toHaveLength(2);
    await act(() => closed()[1]?.props.onPress());
    expect(closed()).toHaveLength(1);
    expect(labelled(root, /^Add routine/)).toEqual([
      "Add routine to Arms",
      "Add routine to Mobility",
    ]);
    // New folder ends the section on its own, not the card of Legs in the middle.
    expect(labelled(root, /^New folder$/)).toHaveLength(1);
    expect(cardOf(root, "New folder")?.findAllByType("Tap" as never)).toHaveLength(1);
  } finally {
    groupsOverride = null;
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows each routine or folder waiting for sync review, with nothing else yet too", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const routine = { kind: "routine", id: "r", deleted: true, status: "conflict" };
  const folder = { kind: "routine_folder", id: "r", deleted: false, status: "conflict" };
  reviews = [routine, folder];
  groupsOverride = [];
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(TrainScreen));
    });
    if (!screen) throw Error("Train did not mount");
    const root = screen.root;
    // A routine and a folder may share an id: each is its own card.
    expect(root.findAllByType("TrainSyncReview" as never).map((card) => card.props.record)).toEqual(
      [routine, folder],
    );
    expect(
      root.findAll((n) => n.type === Text && n.props.children === "No routines yet"),
    ).toHaveLength(1);
  } finally {
    reviews = [];
    groupsOverride = null;
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});
