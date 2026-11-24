// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import RootLayout from "../app/_layout.tsx";
import { saveAppearanceSetting } from "../src/data/appearance-setting.ts";
import { forgetDevicePreferences } from "../src/data/device-preference-store.ts";
import { palettes } from "../src/theme.ts";
import { DockLine, SetStrip } from "../src/ui/live/dock.tsx";
import { Readouts } from "../src/ui/readout.tsx";
import { BackButton } from "../src/ui/screen.tsx";
import { AppStack } from "../src/ui/stack.tsx";
import { Toggle } from "../src/ui/toggle.tsx";
import { files } from "./support/expo-file-system.ts";

/** The system's colour scheme, which a test can change while the app is on screen. */
const system = vi.hoisted(() => {
  let scheme: "light" | "dark" | null = "dark";
  const listeners = new Set<() => void>();
  return {
    get: () => scheme,
    set(next: "light" | "dark" | null) {
      scheme = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("react-native", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useColorScheme: () => useSyncExternalStore(system.subscribe, system.get),
    Platform: { OS: "web" },
    StyleSheet: { create: (styles: object) => styles },
    View: "View",
    Text: "Text",
    ScrollView: "Scroll",
  };
});
// Animated styles are worked out at once, at the value they settle on.
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
  useAnimatedStyle: (style: () => object) => style(),
  interpolateColor: (at: number, _input: number[], colors: string[]) =>
    at >= 1 ? colors[1] : colors[0],
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: Fragment,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("../src/data/app-data.tsx", async () => {
  const { createElement } = await import("react");
  return {
    // Shown as while the data opens, so the root's own ground is on screen.
    AppDataProvider: ({ loading }: { loading: ReactNode }) =>
      createElement(Fragment, null, loading),
    useAppData: () => ({ saveProblem: null }),
  };
});
vi.mock("expo-router", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const DefaultTheme = { colors: { background: "#F2F2F2" } };
  const Theme = createContext(DefaultTheme);
  return {
    DefaultTheme,
    DarkTheme: { colors: { background: "#010101" } },
    ThemeProvider: Theme.Provider,
    Stack: Object.assign(
      ({ children }: { children: ReactNode }) =>
        createElement("NativeStack", { background: useContext(Theme).colors.background }, children),
      { Screen: "Route" },
    ),
  };
});
vi.mock("../src/ui/action-sheet.tsx", () => ({ DestructiveButton: "Destructive" }));
vi.mock("../src/ui/notice.tsx", () => ({ Banner: "Banner", ToastHost: "Toasts" }));
vi.mock("../src/ui/enter.tsx", () => ({ StillOnOpen: Fragment }));
vi.mock("../src/ui/motion.ts", () => ({ spring: {} }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Check",
  ChevronIcon: "Chevron",
  MinusIcon: "Minus",
  PlusIcon: "Plus",
}));
vi.mock("react-native-svg", () => ({ default: "svg", Line: "line" }));

afterEach(() => {
  files.clear();
  forgetDevicePreferences();
  system.set("dark");
});

async function mount(element: ReturnType<typeof createElement>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  await act(() => {
    screen = create(element);
  });
  if (!screen) throw Error("Nothing rendered");
  const mounted = screen;
  onTestFinished(() => act(() => mounted.unmount()));
  return screen;
}

const flat = (node: ReactTestInstance) =>
  Object.assign({}, ...[node.props.style].flat(3).filter(Boolean));

it("draws a screen again in paper when the system turns light, and back in graphite", async () => {
  const screen = await mount(
    createElement(
      Fragment,
      null,
      createElement(Readouts, { cells: [{ label: "Volume", value: "1,200", record: true }] }),
      createElement(BackButton, { label: "History", onPress: () => {} }),
      createElement(Toggle, { on: true }),
    ),
  );
  const look = () => {
    const [label, value] = screen.root.findAllByType("Text" as never);
    const [track, knob] = screen.root.findAllByType("AnimatedView" as never);
    if (!label || !value || !track || !knob) throw Error("Missing parts");
    return {
      label: flat(label).color,
      record: flat(value).color,
      chevron: screen.root.findByType("Chevron" as never).props.color,
      track: flat(track).backgroundColor,
      knob: flat(knob).backgroundColor,
    };
  };
  const expected = (c: (typeof palettes)[keyof typeof palettes]) => ({
    label: c.fg3,
    record: c.record,
    chevron: c.fg2,
    track: c.fg,
    knob: c.bg,
  });

  expect(look()).toEqual(expected(palettes.dark));
  await act(() => system.set("light"));
  expect(look()).toEqual(expected(palettes.paper));
  await act(() => system.set("dark"));
  expect(look()).toEqual(expected(palettes.dark));
});

it("matches the status bar and the page behind the app to the appearance", async () => {
  const screen = await mount(createElement(RootLayout));
  const page = () => ({
    statusBar: screen.root.findByType("StatusBar" as never).props.style,
    ground: flat(screen.root.findByType("View" as never)).backgroundColor,
    // happy-dom gives colours back as written.
    document: document.documentElement.style.backgroundColor.toUpperCase(),
    body: document.body.style.backgroundColor.toUpperCase(),
    scheme: document.documentElement.style.colorScheme,
  });

  expect(page()).toEqual({
    statusBar: "light",
    ground: palettes.dark.bg,
    document: palettes.dark.bg,
    body: palettes.dark.bg,
    scheme: "dark",
  });
  await act(() => system.set("light"));
  expect(page()).toEqual({
    statusBar: "dark",
    ground: palettes.paper.bg,
    document: palettes.paper.bg,
    body: palettes.paper.bg,
    scheme: "light",
  });
  // A system that doesn't say keeps the dark appearance.
  await act(() => system.set(null));
  expect(page().statusBar).toBe("light");
});

it("matches the native transition background to Settings even when the system stays light", async () => {
  system.set("light");
  const screen = await mount(
    createElement(AppStack, {
      screens: [
        { name: "(tabs)", transition: "push" },
        { name: "settings", transition: "push" },
        { name: "workout/active", transition: "cover", transparent: true },
        { name: "workout/finish", transition: "cover" },
      ],
    }),
  );
  const background = () => screen.root.findByType("NativeStack" as never).props.background;
  expect(background()).toBe(palettes.paper.bg);
  await act(() => saveAppearanceSetting("dark"));
  expect(background()).toBe(palettes.dark.bg);
  const workout = screen.root.findByProps({ name: "workout/active" });
  expect(workout.props.options).toMatchObject({
    presentation: "transparentModal",
    contentStyle: { backgroundColor: "transparent" },
  });
  // Opened above the live workout, the summary still covers the whole screen, not a page sheet.
  const finish = screen.root.findByProps({ name: "workout/finish" });
  expect(finish.props.options).toMatchObject({
    presentation: "fullScreenModal",
    animation: "slide_from_bottom",
  });
  expect(screen.root.findByProps({ name: "settings" }).props.options).not.toHaveProperty(
    "presentation",
  );
  await act(() => saveAppearanceSetting("system"));
  expect(background()).toBe(palettes.paper.bg);
  await act(() => system.set("dark"));
  expect(background()).toBe(palettes.dark.bg);
});

it("updates the whole app for an explicit appearance, until System is selected again", async () => {
  const screen = await mount(createElement(RootLayout));
  const checkAppearance = (scheme: "light" | "dark") => {
    const light = scheme === "light";
    const bg = light ? palettes.paper.bg : palettes.dark.bg;
    expect(flat(screen.root.findByType("View" as never)).backgroundColor).toBe(bg);
    expect(screen.root.findByType("StatusBar" as never).props.style).toBe(light ? "dark" : "light");
    expect(document.documentElement.style.colorScheme).toBe(scheme);
  };

  await act(() => saveAppearanceSetting("light"));
  checkAppearance("light");
  await act(() => system.set("light"));
  await act(() => saveAppearanceSetting("dark"));
  checkAppearance("dark");
  await act(() => system.set("dark"));
  await act(() => system.set("light"));
  checkAppearance("dark");
  await act(() => saveAppearanceSetting("system"));
  checkAppearance("light");
  await act(() => system.set("dark"));
  checkAppearance("dark");
});

it("draws the dock's set, kg and reps labels and values in both palettes", async () => {
  const noop = () => {};
  const screen = await mount(
    createElement(
      Fragment,
      null,
      createElement(DockLine, {
        left: "Bench Press · of 3",
        marker: { label: "1", onPress: noop },
      }),
      createElement(SetStrip, {
        fields: [
          {
            metric: "weight",
            name: "weight",
            text: "82.5",
            firm: true,
            unit: "kg",
            step: "2.5",
            steps: 33,
            editing: false,
            onStep: noop,
            onEdit: noop,
          },
          {
            metric: "reps",
            name: "reps",
            text: "8",
            firm: false,
            unit: "reps",
            steps: 8,
            editing: false,
            onStep: noop,
            onEdit: noop,
          },
        ],
        logLabel: "Log set 1",
        canLog: true,
        onLog: noop,
      }),
    ),
  );
  const color = (text: string) => {
    const node = screen.root
      .findAllByType("Text" as never)
      .find(({ props }) => [props.children].flat().includes(text));
    if (!node) throw Error(`Missing dock text: ${text}`);
    return flat(node).color;
  };
  const checkColors = (palette: typeof palettes.dark) => {
    expect(["Bench Press · of 3", "kg", "reps", "  ±2.5", "8"].map(color)).toEqual(
      Array(5).fill(palette.fg2),
    );
    expect(["1", "82.5"].map(color)).toEqual([palette.fg, palette.fg]);
  };

  checkColors(palettes.dark);
  await act(() => system.set("light"));
  checkColors(palettes.paper);
});
