import type { LiveActivityEnvironment, LiveActivityLayout } from "expo-widgets";
import { isValidElement } from "react";
import { expect, it, vi } from "vitest";
import { workoutActivity } from "../src/activity/layout.ios.tsx";
import type { WorkoutContent } from "../src/activity/session.ts";

vi.mock("expo-widgets", () => ({ createLiveActivity: (_name: string, render: unknown) => render }));
vi.mock("@expo/ui/swift-ui", () =>
  Object.fromEntries(
    ["Button", "Gauge", "HStack", "Link", "ProgressView", "Spacer", "Text", "VStack"].map((k) => [
      k,
      k,
    ]),
  ),
);
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityLabel",
      "activityBackgroundTint",
      "buttonStyle",
      "font",
      "foregroundStyle",
      "frame",
      "gaugeStyle",
      "lineLimit",
      "minimumScaleFactor",
      "monospacedDigit",
      "padding",
      "privacySensitive",
      "progressViewStyle",
      "tint",
    ].map((k) => [k, () => k]),
  ),
);
const layout = workoutActivity as unknown as (
  content: WorkoutContent,
  env: LiveActivityEnvironment,
) => LiveActivityLayout;
function controls(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!isValidElement<{ label?: string; children?: unknown }>(node)) return [];
  if (node.props.label) return [node.props.label];
  return controls(node.props.children);
}
function destinations(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(destinations);
  if (!isValidElement<{ destination?: string; children?: unknown }>(node)) return [];
  if (node.props.destination) return [node.props.destination];
  return destinations(node.props.children);
}
it.each([
  [false, 120_000, false, ["Open"]],
  [false, 0, false, ["Open"]],
  [true, 120_000, false, ["−15", "+15", "Skip"]],
  [true, 95_000, true, ["Log"]],
  [true, 0, false, ["Log"]],
] as const)(
  "renders executable controls for interactive=%s, restEnd=%s and stale=%s",
  (interactive, restEnd, isStale, expected) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const view = layout(
        {
          token: "1",
          openUrl: "leve-dev:///workout/active",
          title: "Push",
          exercise: "Press",
          set: "Set 2",
          measurements: "50 kg × 8 reps",
          compact: "50×8",
          previous: "",
          volume: "400 kg",
          started: 1,
          total: 3,
          done: 1,
          canLog: true,
          finish: false,
          restStart: 50_000,
          restEnd,
          interactive,
        },
        { colorScheme: "dark", isStale },
      );
      expect(controls(view.banner)).toEqual(expected);
      expect(controls(view.expandedBottom)).toEqual(expected);
      if (!interactive) {
        expect(destinations(view.banner)).toEqual(["leve-dev:///workout/active"]);
        expect(destinations(view.expandedBottom)).toEqual(["leve-dev:///workout/active"]);
      }
    } finally {
      clock.mockRestore();
    }
  },
);
