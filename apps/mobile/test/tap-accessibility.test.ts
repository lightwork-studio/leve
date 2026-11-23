// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Tap } from "../src/ui/tap.tsx";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("react-native-reanimated", () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
  withSpring: (value: number) => value,
}));
vi.mock("../src/ui/motion.ts", () => ({ emphasised: undefined, pressScale: 1, spring: {} }));

function Controls() {
  const [checked, setChecked] = useState(false);
  const [expanded, setExpanded] = useState(true);
  return h(
    "div",
    null,
    h(Tap, {
      accessibilityRole: "checkbox",
      accessibilityLabel: "Set complete",
      accessibilityState: { checked },
      onPress: () => setChecked(!checked),
    }),
    h(Tap, {
      accessibilityRole: "button",
      accessibilityLabel: "Exercise",
      accessibilityState: { expanded },
      onPress: () => setExpanded(!expanded),
    }),
    h(Tap, { accessibilityRole: "button", accessibilityLabel: "Add exercise" }),
    h(Tap, {
      accessibilityRole: "checkbox",
      accessibilityLabel: "Explicit checked value",
      accessibilityState: { checked: true },
      "aria-checked": false,
    }),
    h(Tap, {
      accessibilityRole: "button",
      accessibilityLabel: "Explicit expanded value",
      accessibilityState: { expanded: false },
      "aria-expanded": true,
    }),
  );
}

it("exposes the current checked and expanded states through the web control", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(h(Controls)));
    const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]');
    const exercise = host.querySelector<HTMLElement>('[aria-label="Exercise"]');
    if (!checkbox || !exercise) throw Error("Missing controls");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(exercise.getAttribute("aria-expanded")).toBe("true");
    await act(() => {
      checkbox.click();
      exercise.click();
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(exercise.getAttribute("aria-expanded")).toBe("false");
    expect(
      host.querySelector('[aria-label="Explicit checked value"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      host.querySelector('[aria-label="Explicit expanded value"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    const ordinary = host.querySelector('[aria-label="Add exercise"]');
    expect(ordinary?.hasAttribute("aria-checked")).toBe(false);
    expect(ordinary?.hasAttribute("aria-expanded")).toBe(false);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
