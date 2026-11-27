import { act, createElement as h } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";

// The data version the app is on, and the progress index read for each version so far.
let historyVersion = 1;
const built = new Map<number, { index: { version: number } }>();
const sharedProgress = vi.fn((_store: unknown, version: number) => {
  const data = { index: { version } };
  built.set(version, data);
  return data;
});
const idle: (() => void)[] = [];

// Whether the tabs are on show, and what to tell when they come back.
let focused = true;
const listeners: { type: string; listener: () => void }[] = [];
vi.mock("expo-router", () => ({
  useNavigation: () => navigation,
}));
const navigation = {
  isFocused: () => focused,
  addListener: (type: string, listener: () => void) => {
    const entry = { type, listener };
    listeners.push(entry);
    return () => listeners.splice(listeners.indexOf(entry), 1);
  },
};
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store: "store", historyVersion }),
}));
vi.mock("../src/ui/when-idle.ts", () => ({
  whenIdle: (fn: () => void) => {
    idle.push(fn);
    return () => idle.splice(idle.indexOf(fn), 1);
  },
}));
vi.mock("../src/model/progress.ts", () => ({
  // A workout's records, marked with the version of the index they came from.
  recordsByWorkout: (index: { version: number }) => new Map([["w", [index.version]]]),
}));
vi.mock("../src/data/read.ts", () => ({
  cachedProgress: (_store: unknown, version: number) => built.get(version) ?? null,
  sharedProgress: (store: unknown, version: number) => sharedProgress(store, version),
  weekBarData: (_store: unknown, _today: number, held: Map<string, number[]> | null) => ({
    records: held?.get("w") ?? null,
  }),
}));

const { useWeekBar } = await import("../src/data/queries.ts");

let shown: unknown;
function Bar({ train = true }: { train?: boolean }) {
  // The mocked weekBarData hands back the records it was given, in place of a week.
  shown = (useWeekBar(0, train) as unknown as { records: unknown }).records;
  return null;
}

it("never reads the whole history in the render that follows an edit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let tree: ReactTestRenderer | undefined;
  try {
    await act(() => {
      tree = create(h(Bar));
    });
    // The bar opens without records, and reads them once the app is idle.
    expect(shown).toBeNull();
    expect(sharedProgress).not.toHaveBeenCalled();
    expect(idle).toHaveLength(1);
    await act(() => idle.shift()?.());
    expect(sharedProgress).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([1]);

    // An edit: the bar keeps the records it had and reads the history again later.
    historyVersion = 2;
    await act(() => tree?.update(h(Bar)));
    expect(sharedProgress).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([1]);
    await act(() => idle.shift()?.());
    expect(sharedProgress).toHaveBeenLastCalledWith("store", 2);
    expect(shown).toEqual([2]);

    // Another screen read the index for the next edit already: the bar takes it at once.
    historyVersion = 3;
    sharedProgress("store", 3);
    await act(() => tree?.update(h(Bar)));
    expect(shown).toEqual([3]);
    expect(idle).toHaveLength(0);

    // On a tab that shows no records, an edit reads nothing, now or later.
    historyVersion = 4;
    await act(() => tree?.update(h(Bar, { train: false })));
    expect(idle).toHaveLength(0);
    // Nor does one made on a screen over the tabs, until the tabs are back on show.
    focused = false;
    await act(() => tree?.update(h(Bar)));
    expect(idle).toHaveLength(0);
    expect(shown).toEqual([3]);
    focused = true;
    await act(() => {
      for (const entry of listeners) if (entry.type === "focus") entry.listener();
    });
    expect(idle).toHaveLength(1);
    await act(() => idle.shift()?.());
    expect(shown).toEqual([4]);
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
