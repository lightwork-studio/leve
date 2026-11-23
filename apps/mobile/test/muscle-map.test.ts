import { Link } from "expo-router";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Modal, Text } from "react-native";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { MuscleTargets } from "../src/model/muscle-map.ts";
import type { ExerciseHistory, WorkoutPoint } from "../src/model/progress.ts";
import { palettes } from "../src/theme.ts";
import { ChartTabs, Segmented } from "../src/ui/chart-controls.tsx";
import { ExerciseMuscles, MuscleCard, WorkoutMuscleSummary } from "../src/ui/muscle-map.tsx";
import paths from "../src/ui/muscle-paths.json";

/** The palette on screen while the system is in dark mode, as these tests set it. */
const dark = palettes.dark;

// Use host elements to inspect the actual SVG fills without a native view manager.
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (styles: object[]) => Object.assign({}, ...styles),
  },
  View: "div",
  Text: "span",
  Modal: "section",
  ScrollView: "article",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "button" }));
vi.mock("../src/ui/icons.tsx", () => ({ ChevronIcon: "chevron" }));
vi.mock("../src/ui/chart-controls.tsx", () => ({ ChartTabs: "tabs", Segmented: "segmented" }));
vi.mock("expo-router", () => ({ Link: "link-row" }));
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));

const TODAY = new Date(2026, 10, 22, 12).getTime();
const DAY = 86_400_000;
const session = (daysAgo: number, counted: number, volumeKg: number | null) =>
  ({
    time: TODAY - daysAgo * DAY,
    counted,
    best: { volumeKg },
  }) as unknown as ExerciseHistory["sessions"][number];
const history = (exerciseId: string, name: string, sessions: ExerciseHistory["sessions"]) =>
  ({ exerciseId, name, sessions }) as unknown as ExerciseHistory;
const TARGETS: Record<string, MuscleTargets> = {
  bench: { primaryMuscles: ["chest"], secondaryMuscles: ["triceps"] },
  pushdown: { primaryMuscles: ["triceps"], secondaryMuscles: [] },
  plank: { primaryMuscles: ["abdominals"], secondaryMuscles: [] },
};
const exercises = [
  history("bench", "Bench Press", [session(1, 3, 1200), session(40, 5, 2000)]),
  history("pushdown", "Pushdown", [session(2, 2, 300)]),
  history("plank", "Plank", [session(3, 2, null)]),
];
const workouts = [{ time: TODAY - DAY }, { time: TODAY - 2 * DAY }, { time: TODAY - 3 * DAY }];

async function mount(element: ReturnType<typeof createElement>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  await act(() => {
    screen = create(element);
  });
  if (!screen) throw Error("Did not mount");
  return screen;
}
const texts = (root: ReactTestInstance) =>
  root
    .findAllByType("span")
    .map((node) => node.children.filter((c) => typeof c === "string").join(""));
/** The large figure's props (it is a memoised component, so it is found by what it was given). */
const bigFigure = (root: ReactTestInstance) => {
  const found = root.find(
    (n) => n.props.height === 236 && n.props.amounts !== undefined && !n.props.side,
  );
  return found.props;
};
const row = (root: ReactTestInstance, label: string) =>
  root.findByProps({ accessibilityLabel: label, accessibilityRole: "button" });
const card = () =>
  createElement(MuscleCard, {
    exercises,
    workouts: workouts as WorkoutPoint[],
    today: TODAY,
    lookup: (id: string) => TARGETS[id],
    unit: "kg",
  });

it("highlights the same muscle on the figure and in the list from either one", async () => {
  const screen = await mount(card());
  try {
    const root = screen.root;
    const figure = () => bigFigure(root);
    // Thirty days: bench 3 sets (chest 3, triceps 1.5), pushdown 2, plank 2.
    expect(figure().amounts).toEqual({ chest: 3, triceps: 3.5, abdominals: 2 });
    expect(texts(root)).toContain("30 days · 3 workouts");
    expect(texts(root)).toContain("7");
    expect(texts(root)).toContain("Most · Triceps · Chest · Abdominals");
    // The legend's shades, bounded to the half set below each quarter of the most (3.5).
    expect(texts(root)).toEqual(expect.arrayContaining(["None", "≤0.5", "≤1.5", "≤2.5", "≤3.5"]));

    await act(() => row(root, "Chest, 3 sets").props.onPress());
    expect(figure().selected).toBe("chest");
    expect(row(root, "Chest, 3 sets").props.accessibilityState).toEqual({ selected: true });
    expect(texts(root)).toContain("Chest · 30 days");
    expect(texts(root)).toContain("43% of all sets · step 4 of 4");

    // A tap on the figure's back picks the triceps, and the list follows.
    const back = root.findByProps({ testID: "muscle-figure-back" });
    const scale = 1276 / 236;
    await act(() =>
      back.props.onResponderRelease({
        nativeEvent: { locationX: (904 - 760) / scale, locationY: (462 - 86) / scale },
      }),
    );
    expect(figure().selected).toBe("triceps");
    expect(row(root, "Triceps, 3.5 sets").props.accessibilityState).toEqual({ selected: true });
    expect(row(root, "Chest, 3 sets").props.accessibilityState).toEqual({ selected: false });

    // Choosing it again clears the highlight.
    await act(() => row(root, "Triceps, 3.5 sets").props.onPress());
    expect(figure().selected).toBeNull();
    expect(texts(root)).toContain("30 days · 3 workouts");
  } finally {
    await act(() => screen.unmount());
    vi.unstubAllGlobals();
  }
});

it("lists untrained muscles on request, and shows one picked on the figure", async () => {
  const screen = await mount(card());
  try {
    const root = screen.root;
    const untrained = () =>
      root.findAll((n) => n.props.accessibilityLabel === "Glutes, not trained");
    expect(untrained()).toHaveLength(0);
    const toggle = () => root.find((n) => n.props.accessibilityState?.expanded !== undefined);
    expect(texts(root)).toContain("Show 14 untrained");
    await act(() => toggle().props.onPress());
    expect(untrained()).toHaveLength(1);
    await act(() => toggle().props.onPress());
    expect(untrained()).toHaveLength(0);
    // Glutes, from the back of the figure: the readout says so and its row appears, picked.
    const back = root.findByProps({ testID: "muscle-figure-back" });
    const scale = 1276 / 236;
    await act(() =>
      back.props.onResponderRelease({
        nativeEvent: { locationX: (984 - 760) / scale, locationY: (678 - 86) / scale },
      }),
    );
    expect(texts(root)).toContain("Not trained in this period");
    expect(untrained()[0]?.props.accessibilityState).toEqual({ selected: true });
  } finally {
    await act(() => screen.unmount());
    vi.unstubAllGlobals();
  }
});

it("measures volume and changes the period, saying when a muscle had sets but no weight", async () => {
  const screen = await mount(card());
  try {
    const root = screen.root;
    const figure = () => bigFigure(root);
    await act(() => root.findByType(ChartTabs).props.onChange("volume"));
    expect(figure().amounts).toEqual({ chest: 1200, triceps: 900 });
    await act(() => root.findByType(Segmented).props.onChange("3m"));
    expect(figure().amounts).toEqual({ chest: 3200, triceps: 1900 });
    const scale = 1276 / 236;
    await act(() =>
      root.findByProps({ testID: "muscle-figure-front" }).props.onResponderRelease({
        nativeEvent: { locationX: (256 - 40) / scale, locationY: (438 - 86) / scale },
      }),
    );
    expect(bigFigure(root).selected).toBe("abdominals");
    expect(texts(root)).toContain("Sets logged, but no lifted weight");
    await act(() => root.findByType(Segmented).props.onChange("7d"));
    await act(() => root.findByType(ChartTabs).props.onChange("sets"));
    expect(figure().amounts).toEqual({ chest: 3, triceps: 3.5, abdominals: 2 });
  } finally {
    await act(() => screen.unmount());
    vi.unstubAllGlobals();
  }
});

it("opens the exercises behind a picked muscle, each linking to its sessions", async () => {
  const screen = await mount(card());
  try {
    const root = screen.root;
    const sheet = () => root.findAllByProps({ presentationStyle: "pageSheet" });
    await act(() => row(root, "Triceps, 3.5 sets").props.onPress());
    await act(() =>
      root.findByProps({ accessibilityLabel: "Triceps: view 2 exercises" }).props.onPress(),
    );
    expect(root.findByType(Modal).props["aria-label"]).toBe("Sets for triceps");
    const detail = sheet()[0];
    if (!detail) throw Error("Missing exercise list");
    expect(texts(detail)).toEqual(
      expect.arrayContaining([
        "3.5 sets · 30 days",
        "Pushdown",
        "2 counted sets · Full credit",
        "Bench Press",
        "3 counted sets · Half credit",
        "1.5 sets",
      ]),
    );
    expect(root.findAllByType(Link).map((link) => link.props.href)).toEqual([
      { pathname: "/exercise/[id]", params: { id: "pushdown", from: "muscleActivity" } },
      { pathname: "/exercise/[id]", params: { id: "bench", from: "muscleActivity" } },
    ]);
    const bench = root.findAllByType(Link)[1]?.findByProps({ accessibilityRole: "link" });
    await act(() => bench?.props.onPress());
    expect(sheet()).toHaveLength(0);
    // Untrained muscles have nothing to open.
    await act(() => row(root, "Triceps, 3.5 sets").props.onPress());
    expect(root.findAll((n) => /: view \d/.test(n.props.accessibilityLabel ?? ""))).toHaveLength(0);
  } finally {
    await act(() => screen.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows an exercise's primary muscles darkest and its secondary ones at the middle step", () => {
  const html = renderToStaticMarkup(
    createElement(ExerciseMuscles, {
      targets: { primaryMuscles: ["chest"], secondaryMuscles: ["triceps", "shoulders"] },
    }),
  );
  expect(html).toContain(`d="${paths.front.chest}" fill="${dark.muscle.ramp[4]}"`);
  expect(html).toContain(`d="${paths.back.triceps}" fill="${dark.muscle.ramp[2]}"`);
  expect(html).toContain(`d="${paths.back.glutes}" fill="${dark.muscle.ramp[0]}"`);
  expect(html).toContain("Triceps · Shoulders");
  expect(renderToStaticMarkup(createElement(ExerciseMuscles, { targets: undefined }))).toContain(
    "Muscle information unavailable.",
  );
});

it("opens the current workout's muscles on demand and dismisses it", async () => {
  const screen = await mount(
    createElement(WorkoutMuscleSummary, { amounts: { chest: 1, triceps: 0.5 }, sets: 1 }),
  );
  try {
    const root = screen.root;
    expect(root.findAllByType(Modal)).toHaveLength(0);
    // The row names how many sets count and the muscles worked most.
    const shown = root.findAllByType(Text).map((node) => node.props.children);
    expect(shown).toContain("Muscles · 1 set");
    expect(shown).toContain("Chest · Triceps");
    await act(() =>
      root
        .findByProps({
          accessibilityLabel: "Muscles in this workout: Chest 1 set, Triceps 0.5 sets",
        })
        .props.onPress(),
    );
    expect(root.findByType(Modal).props["aria-label"]).toBe("Muscle activity");
    await act(() => row(root, "Triceps, 0.5 sets").props.onPress());
    expect(bigFigure(root).selected).toBe("triceps");
    await act(() => root.findByProps({ children: "Close" }).parent?.props.onPress());
    expect(root.findAllByType(Modal)).toHaveLength(0);
  } finally {
    await act(() => screen.unmount());
    vi.unstubAllGlobals();
  }
});
