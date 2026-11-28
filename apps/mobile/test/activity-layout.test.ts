import type { LiveActivityEnvironment, LiveActivityLayout } from "expo-widgets";
import { isValidElement } from "react";
import { expect, it, vi } from "vitest";
import { workoutActivity } from "../src/activity/layout.ios.tsx";
import type { WorkoutContent } from "../src/activity/session.ts";

vi.mock("expo-widgets", () => ({ createLiveActivity: (_name: string, render: unknown) => render }));
vi.mock("@expo/ui/swift-ui", () =>
  Object.fromEntries(
    ["Button", "HStack", "Link", "ProgressView", "Spacer", "Text", "VStack"].map((k) => [k, k]),
  ),
);
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityLabel",
      "activityBackgroundTint",
      "background",
      "buttonStyle",
      "contentTransition",
      "font",
      "foregroundStyle",
      "frame",
      "lineLimit",
      "minimumScaleFactor",
      "monospacedDigit",
      "padding",
      "privacySensitive",
      "progressViewStyle",
      "tint",
    ].map((k) => [k, (...args: unknown[]) => ({ $type: k, args })]),
  ),
);
const layout = workoutActivity as unknown as (
  content: WorkoutContent,
  env: LiveActivityEnvironment,
) => LiveActivityLayout;
const content: WorkoutContent = {
  token: "1",
  openUrl: "leve-dev:///workout/active",
  title: "Push",
  exercise: "Press",
  set: "Set 2",
  measurements: "50 kg × 8 reps",
  compact: "50 kg × 8",
  previous: "",
  volume: "400 kg",
  started: 1,
  total: 3,
  done: 1,
  canLog: true,
  finish: false,
  restStart: 50_000,
  restEnd: 0,
  interactive: true,
  appearance: "system",
};
type Modifier = { $type: string; args: unknown[] };
type Node = { type: unknown; props: { modifiers?: Modifier[]; children?: unknown } };
const modifier = (node: unknown, name: string) =>
  (node as Node).props.modifiers?.find((m) => m.$type === name)?.args[0];
function render(
  restEnd: number,
  colorScheme: "light" | "dark",
  appearance: WorkoutContent["appearance"] = "system",
) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  try {
    return layout({ ...content, restEnd, appearance }, { colorScheme, isStale: false });
  } finally {
    clock.mockRestore();
  }
}
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
          appearance: "system",
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

const bone = "#F3F1EC";
const graphite = "#171A20";
it.each([
  ["system", "dark", 0, graphite],
  ["system", "light", 0, bone],
  ["system", "dark", 120_000, bone],
  ["system", "light", 120_000, graphite],
  ["dark", "light", 0, graphite],
  ["light", "dark", 0, bone],
  ["dark", "light", 120_000, bone],
  ["light", "dark", 120_000, graphite],
] as const)(
  "paints the ground for Appearance %s, a %s system and rest end %s",
  (appearance, scheme, restEnd, ground) => {
    const { banner } = render(restEnd, scheme, appearance);
    // iOS can shift the background tint on the Lock Screen, so the ground is drawn as well.
    expect(modifier(banner, "background")).toBe(ground);
    expect(modifier(banner, "activityBackgroundTint")).toBe(ground);
  },
);

it("shows the sets done and the set's values in the island between rests", () => {
  const view = render(0, "dark");
  for (const slot of [view.compactLeading, view.minimal] as Node[]) {
    expect(slot.type).toBe("Text");
    expect(slot.props.children).toBe("1/3");
  }
  expect((view.compactTrailing as Node).props.children).toBe("50 kg × 8");
});

it("counts the rest down once in the island, in a ring that fits its countdown", () => {
  const view = render(120_000, "dark");
  for (const slot of [view.compactLeading, view.minimal] as Node[]) {
    expect(slot.type).toBe("ProgressView");
    expect(modifier(slot, "progressViewStyle")).toBe("circular");
    expect(modifier(slot, "minimumScaleFactor")).toBeLessThan(1);
  }
  const trailing = view.compactTrailing as Node & { props: { timerInterval?: unknown } };
  expect(trailing.props.timerInterval).toBeUndefined();
  expect(trailing.props.children).toBe("50 kg × 8");
});

it("prints the wordmark's full stop in vermilion on the banner", () => {
  const texts: Node[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    if (node.type === "Text") texts.push(node as unknown as Node);
    walk((node.props as Node["props"]).children);
  };
  walk(render(0, "light").banner);
  const mark = texts.find((t) => Array.isArray(t.props.children) && t.props.children[0] === "Leve");
  if (!mark) throw Error("Missing wordmark");
  const stop = (mark.props.children as unknown[])[1] as Node;
  expect(stop.props.children).toBe(".");
  expect(modifier(stop, "foregroundStyle")).toBe("#FF5A32");
});

it("follows the system for an activity started before the Appearance setting was sent", () => {
  const { appearance: _sent, ...older } = content;
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  try {
    const view = layout(older as WorkoutContent, { colorScheme: "light", isStale: false });
    expect(modifier(view.banner, "background")).toBe(bone);
  } finally {
    clock.mockRestore();
  }
});

function targets(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(targets);
  if (!isValidElement<{ target?: string; children?: unknown }>(node)) return [];
  return node.props.target ? [node.props.target] : targets(node.props.children);
}

it("uses rest-specific intent targets for lock-screen and island buttons", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_000);
    const env = { colorScheme: "dark", isStale: false } as const;
    const resting = layout({ ...content, restKey: "timer-edit", restEnd: 120_000 }, env);
    for (const slot of [resting.banner, resting.expandedBottom]) {
      expect(targets(slot)).toEqual([
        "leveRest.timer-edit:less",
        "leveRest.timer-edit:more",
        "leveRest.timer-edit:skip",
      ]);
      expect(destinations(slot)).toEqual([]);
    }
    expect(targets(layout(content, env).banner)).toEqual(["1:log"]);
  } finally {
    vi.useRealTimers();
  }
});

it("uses the actual countdown deadline in Log after a native skip", () => {
  const env = { colorScheme: "dark", isStale: false } as const;
  const display = layout({ ...content, token: "leve1.epoch.2.120000.digest", restEnd: 0 }, env);
  expect(targets(display.banner)).toEqual(["leve1.epoch.2.0.digest:log"]);
});

it("disables content fades for the countdown and its progress views", () => {
  const view = render(120_000, "dark");
  const timers: Node[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (isValidElement<{ timerInterval?: unknown; children?: unknown }>(node)) {
      if (node.props.timerInterval) timers.push(node as Node);
      visit(node.props.children);
    }
  };
  [view.banner, view.expandedBottom, view.compactLeading, view.minimal].forEach(visit);
  expect(timers).toHaveLength(5);
  for (const timer of timers) expect(modifier(timer, "contentTransition")).toBe("identity");
});
