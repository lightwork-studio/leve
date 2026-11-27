import { describe, expect, it } from "vitest";
import type { Routine, Workout } from "../src/model/types.ts";
import {
  dayChange,
  weekBarDayLabel as dayLabel,
  dayMonograms,
  FOLD_PAST,
  monogram,
  OPEN_BELOW,
  routineMonograms,
  weekBar,
  weekFolded,
} from "../src/model/week-bar.ts";

// Dates are built in local time, so the tests hold in any time zone.
const local = (y: number, m: number, d: number, h = 18) => new Date(y, m - 1, d, h).getTime();
const routine = (id: string, title: string) => ({
  id,
  content: { title, folderId: null, position: 1, exercises: [] } satisfies Routine,
});
const workout = (
  id: string,
  start: number,
  routineId: string | null,
  title = id,
  finished = true,
) => ({
  id,
  content: {
    title,
    startedAt: new Date(start).toISOString(),
    endedAt: finished ? new Date(start + 3_600_000).toISOString() : null,
    routineId,
  } satisfies Workout,
});

describe("monogram", () => {
  it("keeps a short last word, else takes two initials, else a word's first two letters", () => {
    expect(monogram("Upper Body A")).toBe("UA");
    expect(monogram("Day 2")).toBe("D2");
    expect(monogram("Lower Body")).toBe("LB");
    expect(monogram("Full Body Strength")).toBe("FB");
    expect(monogram("Push")).toBe("PU");
    expect(monogram("legs & core")).toBe("LC");
    expect(monogram("Push-Pull")).toBe("PP");
    expect(monogram("Upper/Lower")).toBe("UL");
    expect(monogram("  ")).toBe("");
    expect(monogram("A")).toBe("A");
  });

  it("gives a later routine the next free letters of its own name, then a number", () => {
    // Push was trained first, so it keeps PU; Pull moves on to PL, Pulldown past PU and PL to PD.
    const routines = [routine("r3", "Pulldown"), routine("r2", "Pull"), routine("r1", "Push")];
    const workouts = [
      workout("a", local(2026, 10, 1), "r1"),
      workout("b", local(2026, 10, 3), "r2"),
      workout("c", local(2026, 10, 5), "r3"),
    ];
    expect(Object.fromEntries(routineMonograms(routines, workouts))).toEqual({
      r1: "PU",
      r2: "PL",
      r3: "PD",
    });
    // A routine with no letters left gets a number.
    const twins = [routine("x", "Up"), routine("y", "Up"), routine("z", "Up")];
    const done = [
      workout("x1", local(2026, 10, 1), "x"),
      workout("y1", local(2026, 10, 2), "y"),
      workout("z1", local(2026, 10, 3), "z"),
    ];
    expect(Object.fromEntries(routineMonograms(twins, done))).toEqual({
      x: "UP",
      y: "U2",
      z: "U3",
    });
  });

  it("never changes a trained routine's letters for a new one", () => {
    const before = routineMonograms(
      [routine("pull", "Pull")],
      [workout("a", local(2026, 10, 3), "pull")],
    );
    expect(before.get("pull")).toBe("PU");
    // Push is added later, and trained once since: Pull keeps PU.
    const after = routineMonograms(
      [routine("push", "Push"), routine("pull", "Pull")],
      [workout("a", local(2026, 10, 3), "pull"), workout("b", local(2026, 10, 9), "push")],
    );
    expect(Object.fromEntries(after)).toEqual({ pull: "PU", push: "PS" });
    // One never trained can't take letters from one that has been.
    const untrained = routineMonograms(
      [routine("push", "Push"), routine("pull", "Pull")],
      [workout("a", local(2026, 10, 3), "pull")],
    );
    expect(untrained.get("pull")).toBe("PU");
  });
});

describe("week bar", () => {
  // Thursday 12 November 2026, with the week starting on Monday.
  const now = local(2026, 11, 12, 20);
  const routines = [routine("upper", "Upper Body A"), routine("lower", "Lower Body")];
  const workouts = [
    workout("mon", local(2026, 11, 9), "upper", "Upper Body A"),
    workout("wed", local(2026, 11, 11), "lower", "Lower Body"),
    workout("wed2", local(2026, 11, 11, 20), null, "Evening run"),
    workout("running", local(2026, 11, 12), "upper", "Upper Body A", false),
    // The weeks before: Monday every week, Wednesday twice, Friday once.
    workout("m1", local(2026, 10, 12), "upper"),
    workout("m2", local(2026, 10, 19), "upper"),
    workout("m3", local(2026, 10, 26), "upper"),
    workout("m4", local(2026, 11, 2), "upper"),
    workout("w1", local(2026, 10, 21), "lower"),
    workout("w2", local(2026, 11, 4), "lower"),
    workout("f1", local(2026, 10, 16), "gone", "Old Routine"),
    // Five weeks back: outside the habit.
    workout("old", local(2026, 10, 7), "lower"),
  ];
  const volumes: Record<string, number> = { mon: 6200, m4: 6000, wed: 5600, w2: 5700, wed2: 0 };
  const records: Record<string, number> = { mon: 2 };
  const bar = weekBar(
    { workouts, routines, now, firstWeekday: 1 },
    (id) => ({ volumeKg: volumes[id] ?? 0, records: records[id] ?? 0 }),
    (routineId, before, id) => {
      const earlier = workouts
        .filter(
          (w) =>
            w.id !== id &&
            w.content.routineId === routineId &&
            w.content.endedAt !== null &&
            Date.parse(w.content.startedAt) < before,
        )
        .sort((a, b) => Date.parse(b.content.startedAt) - Date.parse(a.content.startedAt))[0];
      return earlier ? (volumes[earlier.id] ?? 0) : null;
    },
  );

  it("lays out the week from the first weekday, with today and the days ahead", () => {
    expect(bar.start).toBe(local(2026, 11, 9, 0));
    expect(
      bar.days.map((d) => `${d.letter}${d.date}${d.today ? "!" : ""}${d.future ? ">" : ""}`),
    ).toEqual(["M9", "T10", "W11", "T12!", "F13>", "S14>", "S15>"]);
  });

  it("shows each day's finished workouts by monogram, in order, with their records", () => {
    expect(bar.days.map((d) => d.workouts.map((w) => w.monogram))).toEqual([
      ["UA"],
      [],
      ["LB", "ER"],
      // The running workout isn't shown until it is finished.
      [],
      [],
      [],
      [],
    ]);
    expect(bar.days[0]?.workouts[0]?.records).toBe(2);
    expect(dayLabel(bar.days[0] as never, "train")).toBe("Monday 9, Upper Body A, 2 records");
    expect(dayLabel(bar.days[1] as never, "train")).toBe("Tuesday 10, no workout");
  });

  it("marks the weekdays trained in the four weeks before", () => {
    const habit = bar.days.map((d) => d.habit.map((on) => (on ? 1 : 0)).join(""));
    expect(habit).toEqual(["1111", "0000", "0101", "0000", "1000", "0000", "0000"]);
    expect(dayLabel(bar.days[2] as never, "history")).toBe(
      "Wednesday 11, trained, trained 2 of the 4 weeks before",
    );
  });

  it("compares each day's volume with the last session of the same routines", () => {
    // Monday: 6200 against 6000. Wednesday: the run has no routine, so only Lower Body counts.
    expect(bar.days.map(dayChange)).toEqual([3, null, -2, null, null, null, null]);
    expect(dayLabel(bar.days[0] as never, "progress")).toBe("Monday 9, volume up 3% on last time");
    // A routine's first session has nothing to compare with.
    const first = weekBar(
      { workouts: [workout("new", local(2026, 11, 10), "upper")], routines, now, firstWeekday: 1 },
      () => ({ volumeKg: 5000, records: 0 }),
      () => null,
    );
    expect(dayChange(first.days[1] as never)).toBeNull();
    // An earlier session that moved no weight is still an earlier session: no "New", and no
    // percentage of nothing.
    const fromZero = (volumeKg: number) =>
      weekBar(
        {
          workouts: [workout("cardio", local(2026, 11, 10), "upper")],
          routines,
          now,
          firstWeekday: 1,
        },
        () => ({ volumeKg, records: 0 }),
        () => 0,
      ).days[1] as never;
    expect(dayChange(fromZero(0))).toBe(0);
    expect(dayChange(fromZero(500))).toBe("up");
    expect(dayLabel(fromZero(0), "progress")).toBe("Tuesday 10, same volume as last time");
    expect(dayLabel(fromZero(500), "progress")).toBe("Tuesday 10, volume up on last time");
  });

  it("marks the right days in a week whose first midnight doesn't exist", () => {
    const previous = process.env.TZ;
    // Santiago skips from 00:00 to 01:00 on Sunday 6 September 2026.
    process.env.TZ = "America/Santiago";
    try {
      const week = weekBar(
        {
          workouts: [
            workout("mon", local(2026, 9, 7), null),
            workout("tue", local(2026, 9, 8), null),
          ],
          routines: [],
          now: local(2026, 9, 8, 20),
          firstWeekday: 0,
        },
        () => ({ volumeKg: 0, records: 0 }),
        () => null,
      );
      expect(
        week.days.map((d) => `${d.letter}${d.workouts.length ? "+" : ""}${d.today ? "!" : ""}`),
      ).toEqual(["S", "M+", "T+!", "W", "T", "F", "S"]);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("the folded week", () => {
  it("folds once the tab has scrolled a little, and opens only back near the top", () => {
    // Resting at the top, or pulled down past it, the week is open.
    expect(weekFolded(0, false)).toBe(false);
    expect(weekFolded(-40, false)).toBe(false);
    expect(weekFolded(FOLD_PAST, false)).toBe(false);
    expect(weekFolded(FOLD_PAST + 1, false)).toBe(true);
    // Between the two lines it stays as it was, so a list resting there doesn't flicker.
    const between = (FOLD_PAST + OPEN_BELOW) / 2;
    expect(weekFolded(between, true)).toBe(true);
    expect(weekFolded(between, false)).toBe(false);
    expect(weekFolded(OPEN_BELOW, true)).toBe(false);
    expect(weekFolded(-10, true)).toBe(false);
  });

  it("writes a day's workouts as one monogram, two joined, or the first and how many more", () => {
    const day = (...monograms: string[]) =>
      ({
        workouts: monograms.map((monogram, i) => ({
          id: String(i),
          title: monogram,
          monogram,
          records: 0,
          volumeKg: 0,
          lastVolumeKg: null,
        })),
      }) as unknown as Parameters<typeof dayMonograms>[0];
    expect(dayMonograms(day())).toBe("");
    expect(dayMonograms(day("UA"))).toBe("UA");
    expect(dayMonograms(day("LB", "ER"))).toBe("LB·ER");
    expect(dayMonograms(day("LB", "ER", "PU"))).toBe("LB+2");
    // A workout without letters (a routine with no name) still shows that it was there.
    expect(dayMonograms(day(""))).toBe("·");
    expect(dayMonograms(day("UA", ""))).toBe("UA+1");
  });
});
