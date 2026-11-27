import { act, createElement as h } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { WeekBar as Week, WeekBarDay } from "../src/model/week-bar.ts";

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  View: "View",
  Text: "Text",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 40 }) }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/record-mark.tsx", () => ({ RecordMark: "RecordMark" }));
vi.mock("../src/ui/haptics.ts", () => ({ haptic: { select: vi.fn() } }));

const { WeekBar } = await import("../src/ui/week-bar.tsx");

// Monday 9 to Sunday 15 November 2026, on Thursday the 12th.
const start = new Date(2026, 10, 9).getTime();
const day = (i: number, over: Partial<WeekBarDay> = {}): WeekBarDay => {
  const date = new Date(2026, 10, 9 + i);
  const name = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i];
  return {
    start: date.getTime(),
    date: date.getDate(),
    letter: (name as string).slice(0, 1),
    name: name as string,
    today: i === 3,
    future: i > 3,
    workouts: [],
    habit: [false, false, false, false],
    ...over,
  };
};
const workout = (id: string, title: string, monogram: string, records = 0) => ({
  id,
  title,
  monogram,
  records,
  volumeKg: 6200,
  lastVolumeKg: 6000,
});
const week: Week = {
  start,
  days: [
    day(0, { workouts: [workout("a", "Upper Body A", "UA", 2)], habit: [true, true, true, true] }),
    // The first Full Body session, so there is nothing to compare it with.
    day(1, { workouts: [{ ...workout("d", "Full Body", "FB"), lastVolumeKg: null }] }),
    day(2, {
      // Together lighter than last time: 10,200 kg against 12,000.
      workouts: [
        workout("b", "Lower Body", "LB"),
        { ...workout("c", "Evening Run", "ER"), volumeKg: 4000 },
      ],
      habit: [false, true, false, true],
    }),
    day(3),
    day(4),
    day(5),
    day(6),
  ],
};

/** Whether a node is the stand-in element of this name (the mocks draw strings). */
const isType = (node: { type: unknown }, name: string) => node.type === name;

const text = (node: ReactTestRenderer["root"]) =>
  node
    .findAll((n) => isType(n, "Text"))
    .filter((n) => !(n.parent && isType(n.parent, "Text")))
    .map((n) =>
      n.children
        .map((c) => (typeof c === "string" ? c : (c as { children: string[] }).children.join("")))
        .join(""),
    );

it("names the week on top, keeps the frame on every tab, and changes only the marks", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let tree: ReactTestRenderer | undefined;
  try {
    await act(() => {
      tree = create(h(WeekBar, { week, mode: "train", action: h("settings") }));
    });
    const root = (tree as ReactTestRenderer).root;
    const head = () => text(root)[0];
    expect(head()).toBe("This week · 9–15 Nov");
    expect(root.findAllByType("settings" as never)).toHaveLength(1);
    // Train: a monogram per workout, a record mark on the day that set records.
    expect(text(root).slice(1)).toEqual([
      "M",
      "9",
      "UA",
      "T",
      "10",
      "FB",
      "W",
      "11",
      "LB",
      "ER",
      "T",
      "12",
      "F",
      "13",
      "S",
      "14",
      "S",
      "15",
    ]);
    expect(root.findAllByType("RecordMark" as never)).toHaveLength(1);
    const days = root.findAll((n) => n.props.accessibilityLabel?.match(/^\w+day \d+/));
    expect(days.map((d) => d.props.accessibilityLabel)).toEqual([
      "Monday 9, Upper Body A, 2 records",
      "Tuesday 10, Full Body",
      "Wednesday 11, Lower Body, Evening Run",
      "Thursday 12, today, no workout",
      "Friday 13",
      "Saturday 14",
      "Sunday 15",
    ]);

    // Tapping a trained day names its workouts on top; tapping it again goes back to the week.
    const wednesday = root.find(
      (n) => isType(n, "Tap") && n.props.accessibilityLabel?.startsWith("Wednesday"),
    );
    await act(() => wednesday.props.onPress());
    expect(head()).toBe("Wed 11 · Lower Body + Evening Run");
    expect(wednesday.props.accessibilityState).toEqual({ selected: true });
    await act(() => wednesday.props.onPress());
    expect(head()).toBe("This week · 9–15 Nov");
    // A day without a workout has nothing to name, so it isn't a button.
    expect(root.findAll((n) => isType(n, "Tap"))).toHaveLength(3);

    // History: the weeks before and this one, a mark each, under every date.
    await act(() => tree?.update(h(WeekBar, { week, mode: "history", action: null })));
    expect(root.findAllByType("settings" as never)).toHaveLength(0);
    expect(text(root).slice(1)).toEqual([
      "M",
      "9",
      "T",
      "10",
      "W",
      "11",
      "T",
      "12",
      "F",
      "13",
      "S",
      "14",
      "S",
      "15",
    ]);
    const labels = () =>
      root
        .findAll((n) => n.props.accessibilityLabel?.match(/^\w+day \d+/))
        .map((d) => d.props.accessibilityLabel);
    expect(labels()).toEqual([
      "Monday 9, trained, trained 4 of the 4 weeks before",
      "Tuesday 10, trained, trained 0 of the 4 weeks before",
      "Wednesday 11, trained, trained 2 of the 4 weeks before",
      "Thursday 12, today, not trained, trained 0 of the 4 weeks before",
      "Friday 13, not trained, trained 0 of the 4 weeks before",
      "Saturday 14, not trained, trained 0 of the 4 weeks before",
      "Sunday 15, not trained, trained 0 of the 4 weeks before",
    ]);

    // Progress: the change on last time, per day.
    await act(() => tree?.update(h(WeekBar, { week, mode: "progress", action: null })));
    expect(text(root).slice(1)).toEqual([
      "M",
      "9",
      "▲3%",
      "T",
      "10",
      "New",
      "W",
      "11",
      "▼15%",
      "T",
      "12",
      "F",
      "13",
      "S",
      "14",
      "S",
      "15",
    ]);
    expect(labels().slice(0, 3)).toEqual([
      "Monday 9, volume up 3% on last time",
      "Tuesday 10, no earlier session to compare",
      "Wednesday 11, volume down 15% on last time",
    ]);
    expect(head()).toBe("This week · 9–15 Nov");
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
