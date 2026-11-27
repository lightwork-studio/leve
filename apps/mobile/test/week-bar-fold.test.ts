import { act, createElement as h } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";

// Which tab is on show: each stand-in tab asks by its name.
let shown = "train";
let rendering = "train";
vi.mock("expo-router", () => ({ useIsFocused: () => shown === rendering }));

const { WeekBarFoldContext, useWeekBarFold } = await import("../src/ui/week-bar-fold.ts");

type Fold = ReturnType<typeof useWeekBarFold>;
const tabs: Record<string, Fold> = {};
function Tab({ name }: { name: string }) {
  rendering = name;
  tabs[name] = useWeekBarFold();
  return null;
}
const scroll = (name: string, y: number) =>
  act(() => tabs[name]?.onScroll({ nativeEvent: { contentOffset: { y } } } as never));

it("folds the week for the tab on show, and gives each tab its own state back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const setFolded = vi.fn();
  const folded = () => setFolded.mock.lastCall?.[0];
  const app = () =>
    h(
      WeekBarFoldContext.Provider,
      { value: { height: 140, covered: 90, setFolded } },
      h(Tab, { name: "train" }),
      h(Tab, { name: "history" }),
    );
  let tree: ReactTestRenderer | undefined;
  try {
    await act(() => {
      tree = create(app());
    });
    // The tabs start their content under the bar.
    expect(tabs.train?.height).toBe(140);
    expect(folded()).toBe(false);

    // Train scrolls: the week folds, and opens again back at the top.
    await scroll("train", 80);
    expect(folded()).toBe(true);
    await scroll("train", 0);
    expect(folded()).toBe(false);
    await scroll("train", 300);
    expect(folded()).toBe(true);

    // History isn't on show: its scrolling leaves the bar alone (here, it stays at its top).
    setFolded.mockClear();
    await scroll("history", 0);
    expect(setFolded).not.toHaveBeenCalled();

    // Switching to History, still at its top, opens the week; scrolled Train folds it again.
    shown = "history";
    await act(() => tree?.update(app()));
    expect(folded()).toBe(false);
    shown = "train";
    await act(() => tree?.update(app()));
    expect(folded()).toBe(true);
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
