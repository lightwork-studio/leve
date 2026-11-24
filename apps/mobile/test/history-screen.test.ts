/// <reference lib="dom" />
import { Link, router, useLocalSearchParams } from "expo-router";
import { act, createElement, type ReactElement } from "react";
import { FlatList, SectionList, Text, TextInput, View } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import HistoryScreen, { savedSettleMs } from "../app/(tabs)/history.tsx";
import WorkoutCalendar, { CalendarMonth } from "../app/history/calendar.tsx";
import type { useHistory } from "../src/data/queries.ts";
import type { WorkoutSummary } from "../src/model/past-workouts.ts";
import type { WorkoutRecord } from "../src/model/progress.ts";
import { palettes } from "../src/theme.ts";
import { flashDuration } from "../src/ui/flash.tsx";

/** The palette on screen while the system is in dark mode, as these tests set it. */
const dark = palettes.dark;

let historyMonths: ReturnType<typeof useHistory>["months"] = [];
let fixtureRecords = new Map<string, WorkoutRecord[]>();

// The History tab's navigation (its route params, and the stack it sits in), and its list.
const { navigation, stackEvents, sessionList } = vi.hoisted(() => {
  const stackEvents: { type: string; listener: (event: unknown) => void }[] = [];
  return {
    stackEvents,
    navigation: {
      setParams: vi.fn(),
      getParent: () => ({
        addListener: (type: string, listener: (event: unknown) => void) => {
          const entry = { type, listener };
          stackEvents.push(entry);
          return () => stackEvents.splice(stackEvents.indexOf(entry), 1);
        },
      }),
    },
    sessionList: { scrollToLocation: vi.fn(), getScrollResponder: vi.fn() },
  };
});

vi.mock("expo-router", () => ({
  Link: "Link",
  useLocalSearchParams: vi.fn(() => ({})),
  useNavigation: () => navigation,
  router: { canGoBack: () => false, replace: vi.fn() },
}));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => false }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  SectionList: ({
    ListHeaderComponent,
    ref,
  }: {
    ListHeaderComponent: ReactElement;
    ref?: { current: unknown } | null;
  }) => {
    if (ref) ref.current = sessionList;
    return ListHeaderComponent;
  },
  FlatList: "Pages",
  Platform: { OS: "web" },
  View: "View",
  Text: "Text",
  TextInput: "Input",
  StyleSheet: {
    create: (s: object) => s,
    flatten: (s: object | object[]) => [s].flat(3).reduce((a, b) => Object.assign(a, b), {}),
  },
}));
vi.mock("../src/ui/icons.tsx", () => ({
  ChevronIcon: "Chevron",
  SearchIcon: "Search",
  CloseIcon: "Close",
}));
vi.mock("../src/ui/flash.tsx", () => ({ Flash: "Flash", flashDuration: 2400 }));
vi.mock("../src/ui/screen.tsx", () => ({
  TabTitle: "Title",
  BackButton: "BackButton",
  tabContentStyle: {},
  useTabBottomPadding: () => 0,
}));
vi.mock("../src/ui/workout-sync-review.tsx", () => ({ WorkoutSyncReview: "WorkoutSyncReview" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/use-now.ts", () => ({ useToday: () => new Date(2026, 10, 10).getTime() }));
vi.mock("../src/model/progress.ts", async (load) => ({
  ...(await load<typeof import("../src/model/progress.ts")>()),
  recordsByWorkout: () => fixtureRecords,
}));
vi.mock("../src/data/queries.ts", () => ({
  useHistory: () => ({
    settings: { weightUnit: "kg", firstWeekday: 1 },
    months: historyMonths,
    rejectedDeletions: [],
  }),
  useProgress: () => ({ index: null }),
}));

const session = (
  id: string,
  [year, month, day, hour]: [number, number, number, number],
  over: Partial<WorkoutSummary> = {},
): WorkoutSummary => ({
  id,
  title: id,
  startedAt: new Date(year, month, day, hour).toISOString(),
  durationMinutes: 20,
  volumeKg: 0,
  sets: 1,
  reps: 0,
  loggedWarmups: 0,
  excludedWarmups: 0,
  recordedSeconds: null,
  missingTimedSets: 0,
  exercises: [],
  ...over,
});
const monthOf = (year: number, month: number, workouts: WorkoutSummary[]) => ({
  key: `${year}-${String(month + 1).padStart(2, "0")}`,
  year,
  month,
  workouts,
});
const record = (setId: string | null): WorkoutRecord => ({
  exerciseId: "bench",
  metric: "heaviest",
  value: 100,
  before: 90,
  setId,
});
const longDate = (y: number, m: number, d: number) =>
  new Date(y, m, d).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

async function mountHistory(options?: Parameters<typeof create>[1]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let screen: ReactTestRenderer | undefined;
  await act(() => {
    screen = create(createElement(HistoryScreen), options);
  });
  if (!screen) throw Error("Missing History");
  const root = screen.root;
  const layout = (width: number) =>
    act(() =>
      root
        .find((n) => n.type === View && n.props.onLayout)
        .props.onLayout({ nativeEvent: { layout: { width } } }),
    );
  return { screen, root, layout };
}

it("pages through full-width months, the current one first, with each month's figures", async () => {
  historyMonths = [
    monthOf(2026, 9, [
      session("Legs", [2026, 9, 14, 18], { volumeKg: 4200.4, durationMinutes: 62 }),
      session("Push", [2026, 9, 12, 18], { volumeKg: 3100, durationMinutes: 48 }),
    ]),
  ];
  fixtureRecords = new Map([["Legs", [record("s1"), record(null)]]]);
  const { screen, root, layout } = await mountHistory();
  let page: ReactTestRenderer | undefined;
  try {
    await layout(362);
    const pager = root.findByType(FlatList);
    expect(pager.props).toMatchObject({ horizontal: true, pagingEnabled: true });
    // November has nothing yet but still comes first, as the current month.
    expect(pager.props.data.map((m: { key: string }) => m.key)).toEqual(["2026-11", "2026-10"]);
    const october = pager.props.renderItem({ item: pager.props.data[1], index: 1 });
    expect(october.props.style.width).toBe(362);
    await act(() => {
      page = create(october);
    });
    if (!page) throw Error("Missing October");
    const spoken = page.root
      .findAll((n) => typeof n.props.accessibilityLabel === "string")
      .map((n) => n.props.accessibilityLabel);
    expect(spoken).toEqual(
      expect.arrayContaining([
        "2 sessions on 2 training days",
        "Volume 7,300 kg",
        "Time 1 h 50 min",
        "Records 2",
        `${longDate(2026, 9, 14)}, 1 workout, with a record`,
        `${longDate(2026, 9, 12)}, 1 workout`,
      ]),
    );
    const records = page.root.find(
      (n) =>
        n.type === Text &&
        n.props.children === "2" &&
        n.parent?.props.accessibilityLabel === "Records 2",
    );
    expect([records.props.style].flat().at(-1)).toMatchObject({ color: dark.record });
  } finally {
    await act(() => {
      page?.unmount();
      screen.unmount();
    });
    historyMonths = [];
    fixtureRecords = new Map();
    vi.unstubAllGlobals();
  }
});

it("browses earlier months by button and keeps the controls aligned after a swipe", async () => {
  historyMonths = [monthOf(2026, 8, [session("Walk", [2026, 8, 3, 9])])];
  const scrollToOffset = vi.fn();
  const { screen, root, layout } = await mountHistory({
    createNodeMock: (node) => (node.type === FlatList ? { scrollToOffset } : null),
  });
  try {
    const control = (label: string) => root.findByProps({ accessibilityLabel: label });
    const older = () => control("Show older month");
    const newer = () => control("Show newer month");
    const pageProps = (index: number) => {
      const pager = root.findByType(FlatList);
      return pager.props.renderItem({ item: pager.props.data[index], index }).props;
    };
    const expectVisibleMonth = (visible: number, hidden: number) => {
      expect(pageProps(visible).inert).not.toBe(true);
      expect(pageProps(visible)["aria-hidden"]).not.toBe(true);
      expect(pageProps(hidden)).toMatchObject({
        inert: true,
        "aria-hidden": true,
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      });
    };
    await layout(362);
    expectVisibleMonth(0, 1);
    expect(newer().props.disabled).toBe(true);
    await act(() => older().props.onPress());
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 362, animated: false });
    expect(older().props.disabled).toBe(true);
    expectVisibleMonth(1, 0);
    await layout(430);
    expect(root.findByType(FlatList).props.initialScrollIndex).toBe(1);
    await act(() =>
      root.findByType(FlatList).props.onScroll({ nativeEvent: { contentOffset: { x: 0 } } }),
    );
    expect(newer().props.disabled).toBe(true);
    expect(older().props.disabled).toBe(false);
    expectVisibleMonth(0, 1);
    await act(() => older().props.onPress());
    await act(() => newer().props.onPress());
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  } finally {
    await act(() => screen.unmount());
    historyMonths = [];
    vi.unstubAllGlobals();
  }
});

it("opens only the sessions for a trained date and collapses the list on a second tap", async () => {
  const month = (workouts: WorkoutSummary[]) => [monthOf(2026, 10, workouts)];
  historyMonths = month([
    session("Evening", [2026, 10, 9, 18]),
    session("Morning", [2026, 10, 9, 8]),
    session("Other day", [2026, 10, 10, 8]),
  ]);
  const { screen, root, layout } = await mountHistory();
  let card: ReactTestRenderer | undefined;
  try {
    await layout(360);
    // Mount the actual card from the horizontal list's renderer.
    const pager = () => root.findByType(FlatList);
    await act(() => {
      card = create(pager().props.renderItem({ item: pager().props.data[0], index: 0 }));
    });
    if (!card) throw Error("Missing month card");
    const days = card.root;
    const monday = () =>
      days.findByProps({ accessibilityLabel: `${longDate(2026, 10, 9)}, 2 workouts` });
    const links = () =>
      root
        .findAllByType(Link)
        .map((link) => link.props.href)
        .filter((href) => href.pathname === "/workout/[id]")
        .map((href) => href.params.id);
    expect(links()).toEqual([]);
    await act(() => monday().props.onPress());
    expect(links()).toEqual(["Evening", "Morning"]);
    await act(() =>
      days
        .findByProps({ accessibilityLabel: `${longDate(2026, 10, 10)}, today, 1 workout` })
        .props.onPress(),
    );
    expect(links()).toEqual(["Other day"]);
    await act(() => monday().props.onPress());
    await act(() => monday().props.onPress());
    expect(links()).toEqual([]);
    const wednesday = days.findByProps({ children: 11 });
    expect(wednesday.props.accessibilityLabel).toBe(longDate(2026, 10, 11));
    expect(wednesday.parent?.props.onPress).toBeUndefined();

    // Once Monday's sessions are gone, its date is like any other and nothing stays open.
    await act(() => monday().props.onPress());
    historyMonths = month([session("Other day", [2026, 10, 10, 8])]);
    await act(() => screen.update(createElement(HistoryScreen)));
    await act(() =>
      card?.update(pager().props.renderItem({ item: pager().props.data[0], index: 0 })),
    );
    expect(links()).toEqual([]);
    const refreshed = days.findByProps({ children: 9 });
    expect(refreshed.props.accessibilityLabel).toBe(longDate(2026, 10, 9));
    // Like Sunday the 8th, an earlier date without a workout.
    expect(refreshed.parent?.props.style).toEqual(
      days.findByProps({ children: 8 }).parent?.props.style,
    );
  } finally {
    await act(() => {
      card?.unmount();
      screen.unmount();
    });
    historyMonths = [];
    vi.unstubAllGlobals();
  }
});

it("draws each session's sets as a barcode with its record set in brass", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workout = session("Push", [2026, 10, 3, 17], {
    volumeKg: 2450,
    durationMinutes: 72,
    sets: 3,
    exercises: [
      {
        id: "e1",
        name: "Bench Press",
        sets: 2,
        bars: [
          { setId: "s0", magnitude: 400, warmup: true },
          { setId: "s1", magnitude: 800, warmup: false },
        ],
      },
      { id: "e2", name: "Dip", sets: 1, bars: [{ setId: "s2", magnitude: 12, warmup: false }] },
    ],
  });
  historyMonths = [monthOf(2026, 10, [workout])];
  fixtureRecords = new Map([["Push", [record("s1")]]]);
  const { screen, root } = await mountHistory();
  let row: ReactTestRenderer | undefined;
  try {
    const list = root.findByType(SectionList);
    await act(() => {
      row = create(
        list.props.renderItem({ item: workout, index: 0, section: list.props.sections[0] }),
      );
    });
    if (!row) throw Error("Missing row");
    const link = row.root.findByType("Tap" as never);
    expect(link.props.accessibilityLabel).toContain("Push");
    expect(link.props.accessibilityLabel).toContain("1 record");
    expect(link.props.accessibilityLabel).toContain("1 h 12 min, 2,450 kg, 3 sets");
    const texts = row.root.findAllByType(Text).map((n) => n.children.join(""));
    expect(texts).toEqual(
      expect.arrayContaining(["03", "Tue", "1", "1 h 12 min · 2,450 kg · 3 sets"]),
    );
    const { SetBarcode } = await import("../src/ui/barcode.tsx");
    expect(row.root.findByType(SetBarcode).props.exercises).toEqual([
      [
        { magnitude: 400, warmup: true, record: false },
        { magnitude: 800, warmup: false, record: true },
      ],
      [{ magnitude: 12, warmup: false, record: false }],
    ]);
    // The only row of its month is rounded at both ends.
    const style = link.props.style;
    expect(style.borderTopLeftRadius).toBeGreaterThan(0);
    expect(style.borderBottomLeftRadius).toBeGreaterThan(0);
  } finally {
    await act(() => {
      row?.unmount();
      screen.unmount();
    });
    historyMonths = [];
    fixtureRecords = new Map();
    vi.unstubAllGlobals();
  }
});

it("finds a workout by its fourth movement, shows the match on its card, and clears the search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workout = {
    id: "strength",
    title: "Evening strength",
    startedAt: new Date(2026, 10, 3, 17).toISOString(),
    durationMinutes: 35,
    volumeKg: 400,
    sets: 4,
    loggedWarmups: 0,
    excludedWarmups: 0,
    recordedSeconds: null,
    missingTimedSets: 0,
    reps: 0,
    exercises: ["Squat", "Row", "Curl", "Ring Pull-up"].map((name) => ({
      id: name,
      name,
      sets: 1,
      bars: [],
    })),
  };
  historyMonths = [
    {
      key: "2026-11",
      year: 2026,
      month: 10,
      workouts: [workout, { ...workout, id: "other", title: "Easy day", exercises: [] }],
    },
  ];
  let screen: ReactTestRenderer | undefined;
  let card: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(HistoryScreen));
    });
    if (!screen) throw Error("Missing history");
    const root = screen.root;
    const list = () => root.findByType(SectionList);
    const input = root.findByType(TextInput);
    expect(input.props.accessibilityLabel).toBe("Search workouts or exercises");
    await act(() => input.props.onChangeText("pullup"));
    const rows = list().props.sections[0].data;
    expect(rows.map((row: { id: string }) => row.id)).toEqual(["strength"]);
    await act(() => {
      card = create(list().props.renderItem({ item: rows[0] }));
    });
    if (!card) throw Error("Missing result card");
    const labels = card.root.findAllByType(Text).map((node) => node.children.join(""));
    expect(labels).toContain("Ring Pull-up +3");
    expect(card.root.findByType(Link).props.href).toBe("/workout/strength");
    await act(() => root.findByProps({ accessibilityLabel: "Clear search" }).props.onPress());
    expect(list().props.sections[0].data).toEqual(historyMonths[0]?.workouts);

    // A search that finds nothing says what search looks at, and its card's foot clears it.
    await act(() => input.props.onChangeText("  zercher "));
    expect(list().props.sections).toEqual([]);
    let empty: ReactTestRenderer | undefined;
    await act(() => {
      empty = create(list().props.ListEmptyComponent);
    });
    if (!empty) throw Error("Missing the empty state");
    const texts = empty.root.findAllByType(Text).map((node) => node.children.join(""));
    expect(texts).toEqual([
      "0 results",
      "Names and exercises",
      "Nothing matches “zercher”",
      "Search looks at workout names and the exercises in them.",
      "Clear search",
    ]);
    const clear = empty.root.findAll((n) => n.props.accessibilityLabel === "Clear search");
    expect(clear).toHaveLength(1);
    await act(() => clear[0]?.props.onPress());
    expect(list().props.sections[0].data).toEqual(historyMonths[0]?.workouts);
    await act(() => empty?.unmount());
  } finally {
    await act(() => {
      card?.unmount();
      screen?.unmount();
    });
    historyMonths = [];
    vi.unstubAllGlobals();
  }
});

it.each([
  ["History", {}, {}],
  ["Progress", { from: "progress" }, { from: "progress" }],
] as const)(
  "opens leap-day sessions from the %s calendar in the chosen weekday order",
  async (_tab, entryParams, linkOrigin) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const sessions = ["Morning", "Evening"].map((title, index) => ({
      id: title.toLowerCase(),
      title,
      startedAt: new Date(2024, 1, 29, 8 + index * 10).toISOString(),
      durationMinutes: index === 0 ? 0 : 25,
      volumeKg: 0,
      sets: 1,
      reps: 0,
      loggedWarmups: 0,
      excludedWarmups: 0,
      recordedSeconds: null,
      missingTimedSets: 0,
      exercises: [],
    }));
    let screen: ReactTestRenderer | undefined;
    try {
      vi.mocked(useLocalSearchParams).mockReturnValue(entryParams);
      await act(() => {
        screen = create(createElement(WorkoutCalendar));
      });
      if (!screen) throw Error("Missing calendar");
      const renderMonth = screen.root.findByType(FlatList).props.renderItem;
      const month = { key: "2024-02", year: 2024, month: 1, workouts: sessions };
      await act(() => screen?.update(renderMonth({ item: month })));
      const root = screen.root;
      const text = () => root.findAllByType(Text).map((n) => n.children.join(""));
      expect(
        root.findByProps({ accessibilityLabel: "2 sessions on 1 training day" }),
      ).toBeDefined();
      const weekdays = root.findAll((n) => n.type === Text && n.props["aria-hidden"]);
      expect(weekdays.map((n) => n.children.join(""))).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
      expect(text()).not.toContain("30");
      const day = root.findByProps({ accessibilityRole: "button" });
      expect(day.props.accessibilityLabel).toContain("2 workouts");
      expect(day.findByType(Text).children.join("")).toBe("29");
      // Thursday, the fourth column with Monday first.
      const cell = day.parent;
      expect(cell?.parent?.children.indexOf(cell)).toBe(3);
      expect(text()).not.toContain("Morning");
      await act(() => day.props.onPress());
      expect(text()).toContain("Evening");
      expect(text().some((label) => label.endsWith(" · <1 min"))).toBe(true);
      expect(root.findAllByType(Link).map((link) => link.props.href)).toEqual(
        expect.arrayContaining(
          ["morning", "evening"].map((id) => ({
            pathname: "/workout/[id]",
            params: { id, back: "Calendar", ...linkOrigin },
          })),
        ),
      );
      await act(() => day.props.onPress());
      expect(text()).not.toContain("Evening");
    } finally {
      vi.mocked(useLocalSearchParams).mockReturnValue({});
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("closes the calendar date after its final workout disappears and keeps today identifiable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const today = new Date(2026, 10, 10, 12).getTime();
  const workout = {
    id: "walk",
    title: "Lunch walk",
    startedAt: new Date(today).toISOString(),
    durationMinutes: 20,
    volumeKg: 0,
    sets: 1,
    reps: 0,
    loggedWarmups: 0,
    excludedWarmups: 0,
    recordedSeconds: null,
    missingTimedSets: 0,
    exercises: [],
  };
  const month = (workouts: (typeof workout)[]) =>
    createElement(CalendarMonth, {
      month: { key: "2026-11", year: 2026, month: 10, workouts },
      today,
      firstWeekday: 1,
    });
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(month([workout]));
    });
    if (!screen) throw Error("Missing calendar month");
    const root = screen.root;
    const trained = () => root.findByProps({ accessibilityRole: "button" });
    await act(() => trained().props.onPress());
    expect(root.findByType(Link).props.href.params.id).toBe("walk");

    await act(() => screen?.update(month([])));
    expect(root.findAllByType(Link)).toHaveLength(0);
    expect(root.findAllByProps({ accessibilityRole: "button" })).toHaveLength(0);

    await act(() => screen?.update(month([{ ...workout, id: "swim", title: "Evening swim" }])));
    expect(trained().props.accessibilityState.expanded).toBe(false);
    expect(root.findAllByType(Link)).toHaveLength(0);
    expect(trained().props.accessibilityLabel).toContain("today");
    await act(() => trained().props.onPress());
    expect(root.findByType(Link).props.href.params.id).toBe("swim");

    await act(() => screen?.update(month([])));
    expect(root.findByProps({ children: 10 }).props.accessibilityLabel).toContain("today");
    const emptyDate = new Date(2026, 10, 11).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(root.findByProps({ children: 11 }).props.accessibilityLabel).toBe(emptyDate);
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  [{ from: "progress" }, "Progress", "/progress"],
  [{}, "History", "/history"],
] as const)(
  "returns from the calendar to its entry tab when opened without a navigation stack (%j)",
  async (params, tab, path) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(useLocalSearchParams).mockReturnValue(params);
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(createElement(WorkoutCalendar));
      });
      if (!screen) throw new Error("Missing calendar");
      const back = screen.root.findByProps({ accessibilityLabel: `Back to ${tab}` });
      await act(() => back.props.onPress());
      expect(router.replace).toHaveBeenLastCalledWith(path);
    } finally {
      await act(() => screen?.unmount());
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it("picks out the workout just saved once the finish sheet has gone, in view, and only once", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  historyMonths = [
    monthOf(2026, 10, [
      session("Push", [2026, 10, 10, 18], {
        exercises: [{ id: "bench", name: "Bench Press", sets: 3, bars: [] }],
      }),
      session("Legs", [2026, 10, 8, 18]),
    ]),
  ];
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(HistoryScreen));
    });
    if (!screen) throw Error("Missing History");
    const root = screen.root;
    const list = () => root.findByType(SectionList);
    const lit = () =>
      list()
        .props.sections.flatMap((section: { data: { id: string }[] }) =>
          section.data.map((item, index) => list().props.renderItem({ item, index, section })),
        )
        .filter((row: ReactElement<{ flash: boolean }>) => row.props.flash)
        .map((row: ReactElement<{ workout: { id: string } }>) => row.props.workout.id);
    const finishSheetClosed = (closing: boolean) =>
      act(() => {
        for (const { type, listener } of [...stackEvents]) {
          if (type === "transitionEnd") listener({ data: { closing } });
        }
      });

    // Searching for Legs before training: the Push saved next would be hidden by it.
    await act(() => root.findByType(TextInput).props.onChangeText("legs"));
    expect(list().props.sections[0].data.map((w: { id: string }) => w.id)).toEqual(["Legs"]);

    vi.mocked(useLocalSearchParams).mockReturnValue({ saved: "Push" });
    await act(() => screen?.update(createElement(HistoryScreen)));
    expect(root.findByType(TextInput).props.value).toBe("");
    expect(navigation.setParams).toHaveBeenCalledWith({ saved: undefined });
    // Nothing lights up under the finish sheet while it is still closing.
    expect(lit()).toEqual([]);
    await finishSheetClosed(true);
    expect(lit()).toEqual([]);
    expect(sessionList.scrollToLocation).not.toHaveBeenCalled();

    await finishSheetClosed(false);
    expect(lit()).toEqual(["Push"]);
    // The list's first item counts as 1 (its month's header is 0).
    expect(sessionList.scrollToLocation).toHaveBeenCalledExactlyOnceWith({
      sectionIndex: 0,
      itemIndex: 1,
      viewPosition: 0.5,
      animated: true,
    });
    // The fallback doesn't light it a second time.
    await act(() => vi.advanceTimersByTime(savedSettleMs));
    expect(lit()).toEqual(["Push"]);
    await act(() => vi.advanceTimersByTime(flashDuration - savedSettleMs));
    expect(lit()).toEqual([]);

    // With its id taken off the route, History doesn't play it again.
    vi.mocked(useLocalSearchParams).mockReturnValue({});
    await act(() => screen?.update(createElement(HistoryScreen)));
    await act(() => vi.advanceTimersByTime(savedSettleMs + flashDuration));
    expect(lit()).toEqual([]);
    expect(sessionList.scrollToLocation).toHaveBeenCalledTimes(1);
  } finally {
    await act(() => screen?.unmount());
    vi.mocked(useLocalSearchParams).mockReturnValue({});
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    historyMonths = [];
  }
});

it("lights a saved workout after a moment when the closing sheet doesn't report it, keeping a search that shows it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  historyMonths = [
    monthOf(2026, 10, [session("Legs", [2026, 10, 8, 18])]),
    monthOf(2026, 9, [session("Hike", [2026, 9, 20, 9]), session("Easy legs", [2026, 9, 2, 9])]),
  ];
  let screen: ReactTestRenderer | undefined;
  try {
    await act(() => {
      screen = create(createElement(HistoryScreen));
    });
    if (!screen) throw Error("Missing History");
    const root = screen.root;
    const list = () => root.findByType(SectionList);
    await act(() => root.findByType(TextInput).props.onChangeText("legs"));
    // Synced in from another device while this one was training: an older workout.
    vi.mocked(useLocalSearchParams).mockReturnValue({ saved: "Easy legs" });
    await act(() => screen?.update(createElement(HistoryScreen)));
    expect(root.findByType(TextInput).props.value).toBe("legs");
    await act(() => vi.advanceTimersByTime(savedSettleMs - 1));
    expect(sessionList.scrollToLocation).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    const october = list().props.sections[1];
    expect(october.data.map((w: { id: string }) => w.id)).toEqual(["Easy legs"]);
    expect(
      list().props.renderItem({ item: october.data[0], index: 0, section: october }).props.flash,
    ).toBe(true);
    expect(sessionList.scrollToLocation).toHaveBeenCalledExactlyOnceWith({
      sectionIndex: 1,
      itemIndex: 1,
      viewPosition: 0.5,
      animated: true,
    });
  } finally {
    await act(() => screen?.unmount());
    vi.mocked(useLocalSearchParams).mockReturnValue({});
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    historyMonths = [];
  }
});
