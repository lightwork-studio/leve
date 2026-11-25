// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BottomSheet } from "../src/ui/bottom-sheet.tsx";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("react-native-reanimated", async () => {
  const { View } = (await vi.importActual("react-native-web")) as { View: unknown };
  return {
    default: { View, createAnimatedComponent: (component: unknown) => component },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
    withSpring: (value: number) => value,
    withTiming: (value: number) => value,
  };
});
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Circle: "circle",
  Line: "line",
  Polyline: "polyline",
  Rect: "rect",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../src/ui/motion.ts", () => ({ emphasised: undefined, pressScale: 1, spring: {} }));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children, role }: { children?: ReactNode; role?: string }) =>
    h("div", { role }, children),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// `flex: 0` is CSS's `0 1 0%` on the web, whose zero basis collapsed a fitted sheet to nothing:
// the bodyweight editor opened as an empty sheet, its Save button clipped away under the bar.
it("sizes a fitted sheet to its content on the web", async () => {
  const field = h("input", { "aria-label": "Bodyweight in kg" });
  const props = { title: "Record bodyweight", onClose: () => {}, children: field };
  await act(() => root.render(h(BottomSheet, props)));
  const sheet = document.querySelector('[role="dialog"] > div');
  if (!(sheet instanceof HTMLElement)) throw Error("No sheet");
  const style = getComputedStyle(sheet);
  expect([style.flexGrow, style.flexShrink, style.flexBasis]).toEqual(["0", "1", "auto"]);
  expect(sheet.querySelector('[aria-label="Bodyweight in kg"]')).not.toBeNull();
});
