import { act, createElement } from "react";
import { SectionList, Text } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import ExercisesScreen from "../app/exercises.tsx";
import { builtInTargets, EXERCISES } from "../src/data/exercises.ts";

let params: { from?: string } = {};
vi.mock("expo-router", () => ({ Link: "Link", useLocalSearchParams: () => params }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  SectionList: ({ ListHeaderComponent }: { ListHeaderComponent: React.ReactNode }) =>
    ListHeaderComponent,
  View: "View",
  Text: "Text",
  TextInput: "Input",
  ScrollView: "Scroll",
  StyleSheet: { create: (s: object) => s, flatten: (s: object[]) => Object.assign({}, ...s) },
}));
vi.mock("../src/ui/back-link.tsx", () => ({ BackLink: "Back" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/icons.tsx", () => ({
  ChevronIcon: "Chevron",
  CloseIcon: "Close",
  SearchIcon: "Search",
}));
vi.mock("../src/ui/use-now.ts", () => ({ useToday: () => 0 }));
vi.mock("../src/data/queries.ts", () => ({
  useProgress: () => ({
    index: {
      exercises: [
        { exerciseId: "custom:press", name: "Band press" },
        { exerciseId: EXERCISES.bench.id, name: "Bench Press" },
        { exerciseId: "retired", name: "Retired movement" },
      ],
    },
    equipmentFor: (id: string) => (id === "custom:press" ? "cable" : undefined),
    muscleTargets: (id: string) =>
      id === "custom:press"
        ? { primaryMuscles: ["triceps"], secondaryMuscles: [] }
        : builtInTargets(id),
  }),
}));

it("filters logged movements with the anatomy figure, chips and search, keeping their history order", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(ExercisesScreen));
    });
    if (!screen) throw Error("Missing logged exercises");
    const root = screen.root;
    const shown = () =>
      root
        .findByType(SectionList)
        .props.sections.map((section: { title: string; data: { name: string }[] }) => [
          section.title,
          section.data.map((e) => e.name),
        ]);
    const chip = (label: string) =>
      act(() => {
        const chips = root.findAll((n) => n.props.accessibilityRole === "radio");
        const found = chips.find((n) => n.findAllByType(Text)[0]?.props.children === label);
        found?.props.onPress();
      });
    const search = () => root.findByProps({ accessibilityLabel: "Search exercises" });
    expect(shown()).toEqual([["", ["Band press", "Bench Press", "Retired movement"]]]);
    // A tap on the back of the figure, on the triceps.
    const scale = 1276 / 168;
    await act(() =>
      root.findByProps({ testID: "muscle-figure-back" }).props.onResponderRelease({
        nativeEvent: { locationX: (904 - 760) / scale, locationY: (462 - 86) / scale },
      }),
    );
    expect(shown()).toEqual([
      ["Triceps · primary", ["Band press"]],
      ["Also works triceps", ["Bench Press"]],
    ]);
    expect(
      root.findAllByProps({ accessibilityLabel: "Filter by muscle group, Triceps" }).length,
    ).toBeGreaterThan(0);
    await act(() => search().props.onChangeText("band"));
    expect(shown()).toEqual([["Triceps · primary", ["Band press"]]]);
    expect(
      root.findAllByProps({ accessibilityLabel: "Filter by muscle group, Triceps" }),
    ).toHaveLength(0);
    expect(
      root.findAllByProps({ accessibilityLabel: "Muscle filter, Triceps" }).length,
    ).toBeGreaterThan(0);
    const equipment = (label: string) =>
      act(() => root.findByProps({ accessibilityLabel: `Filter by ${label}` }).props.onPress());
    await equipment("dumbbell");
    expect(shown()).toEqual([]);
    await equipment("cable");
    expect(shown()).toEqual([["Triceps · primary", ["Band press"]]]);
    await act(() =>
      root.findByProps({ accessibilityLabel: "Muscle filter, Triceps" }).props.onPress(),
    );
    expect(
      root.findAllByProps({ accessibilityLabel: "Filter by muscle group, Triceps" }).length,
    ).toBeGreaterThan(0);
    await act(() => search().props.onChangeText("band press"));
    expect(
      root.findAllByProps({ accessibilityLabel: "Filter by muscle group, Triceps" }),
    ).toHaveLength(0);
    expect(
      root.findByProps({ accessibilityLabel: "Filter by cable", accessibilityRole: "button" }).props
        .accessibilityState.selected,
    ).toBe(true);
    expect(shown()).toEqual([["Triceps · primary", ["Band press"]]]);
    await equipment("cable");
    await act(() => search().props.onChangeText("retired"));
    expect(shown()).toEqual([]);
    await act(() => search().props.onChangeText(""));
    // The chips reach every muscle, including ones the figure doesn't draw.
    await chip("Other");
    expect(shown()).toEqual([["Other · primary", ["Retired movement"]]]);
    // Choosing it again shows them all.
    await chip("Other");
    expect(shown()).toEqual([["", ["Band press", "Bench Press", "Retired movement"]]]);
    await chip("Triceps");
    await act(() =>
      root.findByProps({ accessibilityLabel: "Clear muscle filter" }).props.onPress(),
    );
    expect(shown()).toHaveLength(1);
    // Opened from Progress, back leads there.
    expect(root.findByType("Back" as never).props).toMatchObject({
      label: "Progress",
      fallback: "/progress",
    });
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it("leads back to Train when opened from Train's library row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  params = { from: "train" };
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(ExercisesScreen));
    });
    expect(screen?.root.findByType("Back" as never).props).toMatchObject({
      label: "Train",
      fallback: "/",
    });
  } finally {
    await act(() => screen?.unmount());
    params = {};
    vi.unstubAllGlobals();
  }
});
