import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { BarChart } from "../src/ui/bar-chart.tsx";
import { LineChart } from "../src/ui/line-chart.tsx";

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  StyleSheet: { create: (s: object) => s, absoluteFill: {} },
  View: "View",
  Text: "Text",
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView", createAnimatedComponent: (c: unknown) => c },
  Easing: { out: () => undefined, cubic: undefined, bezier: () => undefined },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  useAnimatedProps: () => ({}),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withTiming: (value: unknown) => value,
  withDelay: (_: number, value: unknown) => value,
}));
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Path: "Path",
  Line: "Line",
  Circle: "Circle",
  Defs: "Defs",
  LinearGradient: "Gradient",
  Stop: "Stop",
}));
vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }),
}));
vi.mock("../src/ui/cross-fade.tsx", () => ({ CrossFade: "Fade" }));
vi.mock("../src/ui/motion.ts", () => ({ easeOut: undefined, emphasised: undefined }));
const select = vi.fn();
vi.mock("../src/ui/haptics.ts", () => ({ haptic: { select: () => select() } }));

let screen: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => screen?.unmount());
  vi.unstubAllGlobals();
  select.mockClear();
});
async function mount(element: ReturnType<typeof createElement>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    screen = create(element);
  });
  if (!screen) throw Error("Did not mount");
  return screen.root;
}
const layout = (width: number) => ({ nativeEvent: { layout: { width } } });

it("picks the bar under the finger as it drags, once per bar, and steps for screen readers", async () => {
  const onSelect = vi.fn();
  const bars = [10, 20, 30, 40].map((value, i) => ({ key: `w${i}`, value }));
  const props = {
    bars,
    top: 40,
    tickLabel: String,
    marks: [],
    onSelect,
    describe: (i: number) => `Week ${i + 1}`,
    average: 25,
    accessibilityLabel: "Volume",
  };
  const root = await mount(createElement(BarChart, { ...props, selected: 3 }));
  const plot = root.find((n) => typeof n.props.onLayout === "function");
  await act(() => plot.props.onLayout(layout(200)));
  const scrub = root.findByProps({ testID: "bar-chart-scrub" });
  expect(scrub.props.onStartShouldSetResponder()).toBe(true);
  // 200 points over four bars: 50 each.
  await act(() => scrub.props.onResponderGrant({ nativeEvent: { locationX: 60 } }));
  expect(onSelect).toHaveBeenLastCalledWith(1);
  await act(() => scrub.props.onResponderMove({ nativeEvent: { locationX: 90 } }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  await act(() => scrub.props.onResponderMove({ nativeEvent: { locationX: -30 } }));
  expect(onSelect).toHaveBeenLastCalledWith(0);
  expect(select).toHaveBeenCalledTimes(2);

  await act(() => screen?.update(createElement(BarChart, { ...props, selected: 1 })));
  const chart = root.find(
    (n) => (n.type as unknown) === "View" && n.props.accessibilityLabel === "Volume",
  );
  expect(chart.props.accessibilityRole).toBe("adjustable");
  expect(chart.props.accessibilityValue).toEqual({ text: "Week 2" });
  await act(() => chart.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
  expect(onSelect).toHaveBeenLastCalledWith(2);
  // The dashed average line sits at 25 of 40.
  const average = root.findByType("Line" as never);
  expect(average.props.y1).toBeCloseTo(150 * (1 - 25 / 40));
});

it("picks the nearest point of the line as the finger moves", async () => {
  const onSelect = vi.fn();
  const root = await mount(
    createElement(LineChart, {
      points: [
        { time: 1, x: 0, value: 10 },
        { time: 2, x: 0.5, value: 12 },
        { time: 3, x: 1, value: 11 },
      ],
      axis: { low: 9, step: 2, high: 13 },
      tickLabel: String,
      marks: [],
      onSelect,
      describe: (i: number) => `Point ${i + 1}`,
      accessibilityLabel: "Estimated 1RM",
    }),
  );
  const plot = root.find((n) => typeof n.props.onLayout === "function");
  await act(() => plot.props.onLayout(layout(212)));
  const scrub = root.findByProps({ testID: "line-chart-scrub" });
  // The plot is inset 6 points each side, so the middle point sits at 106.
  await act(() => scrub.props.onResponderGrant({ nativeEvent: { locationX: 120 } }));
  expect(onSelect).toHaveBeenLastCalledWith(1);
  await act(() => scrub.props.onResponderMove({ nativeEvent: { locationX: 10 } }));
  expect(onSelect).toHaveBeenLastCalledWith(0);
  const chart = root.find(
    (n) => (n.type as unknown) === "View" && n.props.accessibilityLabel === "Estimated 1RM",
  );
  expect(chart.props.accessibilityValue).toEqual({ text: "Point 3" });
});
