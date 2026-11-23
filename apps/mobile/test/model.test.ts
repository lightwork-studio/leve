import { describe, expect, it } from "vitest";
import {
  filterHistoryMonths,
  groupByMonth,
  historyWeeks,
  monthOdometer,
  monthPages,
  summarize,
  type WorkoutTree,
} from "../src/model/past-workouts.ts";
import { workoutMinutes } from "../src/model/time.ts";
import {
  lastDoneLabel,
  routineGroups,
  startOfWeek,
  upNextRoutine,
  weekSummary,
} from "../src/model/train.ts";
import type { Routine, Workout, WorkoutEntry, WorkoutSet } from "../src/model/types.ts";
import { setVolumeKg } from "../src/model/volume.ts";
import { historySetLabel, wholeWeight } from "../src/ui/format.ts";

// Dates are built in local time, so the tests hold in any time zone.
const local = (y: number, m: number, d: number, h = 18, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const workout = (
  id: string,
  start: number,
  minutes: number | null,
  routineId: string | null = null,
) => ({
  id,
  content: {
    title: id,
    description: "",
    startedAt: new Date(start).toISOString(),
    endedAt: minutes === null ? null : new Date(start + minutes * 60_000).toISOString(),
    routineId,
  } satisfies Workout,
});
const entry = (type: string, double = false): WorkoutEntry => ({
  workoutId: "w",
  exerciseId: "x",
  exerciseName: "Bench Press",
  exerciseType: type,
  position: 1,
  supersetId: null,
  restSeconds: 120,
  doubleDumbbellVolume: double,
});
const set = (
  weightKg: number | null,
  reps: number | null,
  type: WorkoutSet["type"] = "normal",
  done = true,
): WorkoutSet => ({
  workoutExerciseId: "e",
  position: 1,
  type,
  weightKg,
  reps,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt: done ? "2026-11-12T18:00:00.000Z" : null,
});

describe("volume", () => {
  const plain = { usesBodyweight: false, bodyweightKg: 80 };
  const body = { usesBodyweight: true, bodyweightKg: 80 };
  it("counts weight times reps for completed sets of rep-based exercises", () => {
    expect(setVolumeKg(set(80, 8), entry("weight_reps"), plain)).toBe(640);
    expect(setVolumeKg(set(20, 10), entry("weight_reps", true), plain)).toBe(400);
    expect(setVolumeKg(set(80, 8, "normal", false), entry("weight_reps"), plain)).toBe(0);
    expect(setVolumeKg({ ...set(null, null), durationSeconds: 60 }, entry("duration"), body)).toBe(
      0,
    );
    expect(setVolumeKg(set(20, 10), entry("weight_duration"), plain)).toBe(0);
  });

  it("adds bodyweight only for exercises that use it", () => {
    expect(setVolumeKg(set(null, 10), entry("bodyweight_reps"), body)).toBe(800);
    expect(setVolumeKg(set(null, 10), entry("bodyweight_reps"), plain)).toBe(0);
    expect(setVolumeKg(set(10, 5), entry("weighted_bodyweight"), body)).toBe(450);
    expect(setVolumeKg(set(30, 5), entry("assisted_bodyweight"), body)).toBe(250);
    expect(setVolumeKg(set(90, 5), entry("assisted_bodyweight"), body)).toBe(0);
    expect(
      setVolumeKg(set(null, 10), entry("bodyweight_reps"), {
        usesBodyweight: true,
        bodyweightKg: null,
      }),
    ).toBe(0);
  });
});

describe("history", () => {
  const tree: WorkoutTree = {
    workout: workout("w", local(2026, 11, 12), 52),
    entries: [
      {
        entry: { id: "e", content: entry("weight_reps") },
        sets: [
          { id: "s0", content: set(40, 10, "warmup") },
          { id: "s1", content: set(80, 8) },
          { id: "s2", content: set(80, 7) },
          { id: "s3", content: set(80, 8, "normal", false) },
        ],
      },
    ],
  };

  it("sums finished sets, leaving warm-ups out unless the setting counts them", () => {
    expect(
      summarize(tree, { countWarmups: false, bodyweightKg: null, usesBodyweight: () => false }),
    ).toMatchObject({
      durationMinutes: 52,
      volumeKg: 1200,
      sets: 2,
      exercises: [{ id: "e", name: "Bench Press", sets: 2 }],
    });
    expect(
      summarize(tree, { countWarmups: true, bodyweightKg: null, usesBodyweight: () => false }),
    ).toMatchObject({
      volumeKg: 1600,
      sets: 3,
    });
  });

  it("counts the counted sets' reps and keeps every logged set, in order, for the barcode", () => {
    const summary = summarize(tree, {
      countWarmups: false,
      bodyweightKg: null,
      usesBodyweight: () => false,
    });
    // 8 + 7 reps; the warm-up isn't counted and the last set was never logged.
    expect(summary.reps).toBe(15);
    expect(summary.exercises[0]?.bars).toEqual([
      { setId: "s0", magnitude: 400, warmup: true },
      { setId: "s1", magnitude: 640, warmup: false },
      { setId: "s2", magnitude: 560, warmup: false },
    ]);
  });

  it("identifies a warm-up-only session on the History card with either totals setting", () => {
    const warmupOnly = {
      ...tree,
      entries: [
        {
          entry: { id: "e", content: entry("weight_reps") },
          sets: [
            { id: "warmup", content: set(null, 5, "warmup") },
            { id: "unlogged", content: set(null, 5, "warmup", false) },
          ],
        },
      ],
    };
    const settings = { bodyweightKg: null, usesBodyweight: () => false };
    for (const countWarmups of [true, false]) {
      const summary = summarize(warmupOnly, { ...settings, countWarmups });
      expect(summary.volumeKg).toBe(0);
      expect(summary.sets).toBe(countWarmups ? 1 : 0);
      expect(historySetLabel(summary)).toBe("1 warm-up");
    }
    expect(historySetLabel(summarize(tree, { ...settings, countWarmups: true }))).toBe(
      "3 sets (1 warm-up)",
    );
    expect(historySetLabel(summarize(tree, { ...settings, countWarmups: false }))).toBe(
      "2 sets · 1 warm-up",
    );
  });

  it("groups workouts by month, newest first", () => {
    const summaries = [local(2026, 10, 30), local(2026, 11, 12), local(2026, 11, 3)].map(
      (start, i) =>
        summarize(
          { workout: workout(`w${i}`, start, 30), entries: [] },
          { countWarmups: false, bodyweightKg: null, usesBodyweight: () => false },
        ),
    );
    expect(groupByMonth(summaries).map((g) => [g.key, g.workouts.map((w) => w.id)])).toEqual([
      ["2026-11", ["w1", "w2"]],
      ["2026-10", ["w0"]],
    ]);
  });

  it("searches titles and logged exercise names across months and restores the full history on clear", () => {
    const base = summarize(tree, {
      countWarmups: false,
      bodyweightKg: null,
      usesBodyweight: () => false,
    });
    const summary = (id: string, title: string, month: number, day: number) => ({
      ...base,
      id,
      title,
      startedAt: new Date(local(2026, month, day)).toISOString(),
    });
    const months = groupByMonth([
      {
        ...summary("a", "Leg day", 9, 10),
        exercises: [{ id: "pull", name: "Ring pull-up", sets: 1, bars: [] }],
      },
      summary("b", "Tempo", 10, 15),
      summary("c", "Evening legs", 11, 2),
      summary("d", "", 11, 5),
      summary("e", "Leg circuit", 11, 15),
    ]);
    const results = (query: string) =>
      filterHistoryMonths(months, query).map((month) => [
        month.key,
        month.workouts.map((w) => w.id),
      ]);
    expect(results("  LEG ")).toEqual([
      ["2026-11", ["e", "c"]],
      ["2026-09", ["a"]],
    ]);
    expect(results("Workout")).toEqual([["2026-11", ["d"]]]);
    expect(results("BENCH press")).toEqual([
      ["2026-11", ["e", "d", "c"]],
      ["2026-10", ["b"]],
    ]);
    for (const term of ["ring pull up", "pullup", "Pull-ups"]) {
      expect(results(term)).toEqual([["2026-09", ["a"]]]);
    }
    expect(results("swimming")).toEqual([]);
    expect(results("")).toEqual([
      ["2026-11", ["e", "d", "c"]],
      ["2026-10", ["b"]],
      ["2026-09", ["a"]],
    ]);
    expect(results("   ")).toEqual(results(""));
  });
});

describe("train", () => {
  // Thursday 12 November 2026, with the week starting on Monday.
  const now = local(2026, 11, 12, 20);

  it("starts the week on the chosen weekday", () => {
    expect(startOfWeek(now, 1)).toBe(local(2026, 11, 9, 0));
    expect(startOfWeek(now, 0)).toBe(local(2026, 11, 8, 0));
  });

  it("counts this week's finished workouts and marks the days trained", () => {
    const summary = weekSummary(
      [
        workout("mon", local(2026, 11, 9), 60),
        workout("wed", local(2026, 11, 11), 45),
        workout("running", local(2026, 11, 12), null),
        workout("last-week", local(2026, 11, 6), 50),
      ],
      now,
      1,
    );
    expect(summary.workouts).toBe(2);
    expect(summary.minutes).toBe(105);
    expect(
      summary.days.map((d) => `${d.letter}${d.trained ? "+" : ""}${d.today ? "!" : ""}`),
    ).toEqual(["M+", "T", "W+", "T!", "F", "S", "S"]);
  });

  it("adds up the week's volume and sets by day, from this week's finished workouts only", () => {
    const figures: Record<string, { volumeKg: number; sets: number }> = {
      mon: { volumeKg: 1200, sets: 9 },
      mon2: { volumeKg: 300.25, sets: 3 },
      wed: { volumeKg: 0, sets: 4 },
      "last-week": { volumeKg: 5000, sets: 20 },
      running: { volumeKg: 800, sets: 6 },
    };
    const summary = weekSummary(
      [
        workout("mon", local(2026, 11, 9, 8), 60),
        workout("mon2", local(2026, 11, 9, 18), 20),
        workout("wed", local(2026, 11, 11), 45),
        workout("running", local(2026, 11, 12), null),
        workout("last-week", local(2026, 11, 6), 50),
      ],
      now,
      1,
      (id) => figures[id],
    );
    expect(summary.volumeKg).toBe(1500.3);
    expect(summary.sets).toBe(16);
    expect(summary.days.map((d) => d.volumeKg)).toEqual([1500.25, 0, 0, 0, 0, 0, 0]);
    expect(summary.days.map((d) => d.trained)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("groups routines by folder and says when each was last done", () => {
    const routine = (id: string, folderId: string | null, position: number) => ({
      id,
      content: { title: id, notes: "", folderId, position, exercises: [] } satisfies Routine,
    });
    const groups = routineGroups(
      [
        routine("legs", "ppl", 3),
        routine("push", "ppl", 1),
        routine("full", null, 1),
        routine("lost", "gone", 1),
      ],
      [
        { id: "mob", content: { title: "Mobility", position: 2 } },
        { id: "ppl", content: { title: "Push · Pull · Legs", position: 1 } },
      ],
      [
        workout("a", local(2026, 11, 9), 60, "push"),
        workout("b", local(2026, 11, 11), null, "legs"),
      ],
      now,
    );
    expect(
      groups.map((g) => [g.folder?.id ?? null, g.routines.map((r) => [r.id, r.daysSinceLast])]),
    ).toEqual([
      [
        "ppl",
        [
          ["push", 3],
          ["legs", null],
        ],
      ],
      ["mob", []],
      [
        null,
        [
          ["full", null],
          ["lost", null],
        ],
      ],
    ]);
    expect([null, 0, 1, 6].map(lastDoneLabel)).toEqual([
      "Not done yet",
      "Today",
      "Yesterday",
      "6 days ago",
    ]);
  });
});

describe("time zones and odd data", () => {
  const withZone = (zone: string, fn: () => void) => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  };

  it("marks the right days in a week whose first midnight doesn't exist", () => {
    // Santiago skips from 00:00 to 01:00 on Sunday 6 September 2026.
    withZone("America/Santiago", () => {
      const summary = weekSummary(
        [workout("mon", local(2026, 9, 7), 50), workout("tue", local(2026, 9, 8), 40)],
        local(2026, 9, 8, 20),
        0,
      );
      expect(
        summary.days.map((d) => `${d.letter}${d.trained ? "+" : ""}${d.today ? "!" : ""}`),
      ).toEqual(["S", "M+", "T+!", "W", "T", "F", "S"]);
    });
  });

  it("never shows negative durations or days", () => {
    const backwards = workout("odd", local(2026, 11, 12), -60).content;
    expect(workoutMinutes(backwards)).toBe(0);
    expect(
      weekSummary([workout("odd", local(2026, 11, 12), -60)], local(2026, 11, 12, 20), 1).minutes,
    ).toBe(0);
    const ahead = workout("ahead", local(2026, 11, 13), 30, "push");
    const [group] = routineGroups(
      [
        {
          id: "push",
          content: { title: "Push", notes: "", folderId: null, position: 1, exercises: [] },
        },
      ],
      [],
      [ahead],
      local(2026, 11, 12, 20),
    );
    expect(group?.routines[0]?.daysSinceLast).toBe(0);
  });

  it("formats whole weights the same way in every locale", () => {
    expect(wholeWeight(1234.6, "kg", "en-US")).toBe("1,235");
    expect(wholeWeight(1234.6, "kg", "de-DE")).toBe("1.235");
    expect(wholeWeight(1000, "lbs", "de-DE")).toBe("2.205");
  });
});

describe("up next", () => {
  const routine = (id: string, folderId: string | null, position: number) => ({
    id,
    content: {
      title: `Title ${id}`,
      notes: "",
      folderId,
      position,
      exercises: [],
    } satisfies Routine,
  });
  const folder = (id: string, position: number) => ({ id, content: { title: id, position } });
  // Push, pull and legs in one folder (given out of order), upper and lower in a later one,
  // an empty folder first, and one routine on its own.
  const routines = [
    routine("legs", "ppl", 3),
    routine("push", "ppl", 1),
    routine("pull", "ppl", 2),
    routine("lower", "ul", 2),
    routine("upper", "ul", 1),
    routine("full", null, 1),
  ];
  const folders = [folder("ul", 3), folder("ppl", 2), folder("empty", 1)];
  const done = (id: string, day: number, routineId: string | null) =>
    workout(id, local(2026, 11, day), 60, routineId);
  const next = (workouts: ReturnType<typeof workout>[], list = routines, groups = folders) =>
    upNextRoutine(list, groups, workouts)?.id ?? null;

  it("suggests the routine after the last one done, wrapping to the first after the last", () => {
    expect(next([done("a", 9, "push")])).toBe("pull");
    expect(next([done("a", 9, "pull")])).toBe("legs");
    expect(next([done("a", 9, "legs")])).toBe("push");
    expect(next([done("a", 9, "upper")])).toBe("lower");
    expect(next([done("a", 9, "lower")])).toBe("upper");
    // On its own, the one routine not in a folder follows itself.
    expect(next([done("a", 9, "full")])).toBe("full");
    expect(upNextRoutine(routines, folders, [done("a", 9, "push")])).toEqual({
      id: "pull",
      title: "Title pull",
    });
  });

  it("goes by the latest finished workout, whatever order they come in", () => {
    const history = [done("b", 11, "legs"), done("a", 9, "push"), done("c", 10, "upper")];
    expect(next(history)).toBe("push");
    // A workout still running doesn't count.
    expect(next([...history, workout("d", local(2026, 11, 12), null, "push")])).toBe("push");
  });

  it("skips an empty workout done most recently", () => {
    expect(next([done("a", 9, "pull"), done("b", 10, null), done("c", 11, null)])).toBe("legs");
  });

  it("skips a workout from a deleted routine", () => {
    expect(next([done("a", 9, "pull"), done("b", 10, "deleted")])).toBe("legs");
    // With only those, it is as if nothing was done yet.
    expect(next([done("b", 10, "deleted"), done("c", 11, null)])).toBe("push");
  });

  it("starts with the first routine Train shows when nothing was done from a routine yet", () => {
    // The empty folder comes first but holds nothing, so push (first in the next folder) leads.
    expect(next([])).toBe("push");
    expect(next([], [routine("b", null, 2), routine("a", null, 1)], [])).toBe("a");
  });

  it("suggests nothing without routines", () => {
    expect(next([])).not.toBeNull();
    expect(next([], [], folders)).toBeNull();
    expect(next([done("a", 9, "push")], [], [])).toBeNull();
  });

  it("follows the current order after routines are reordered or moved", () => {
    const history = [done("a", 9, "push")];
    const reordered = [
      routine("legs", "ppl", 2),
      routine("push", "ppl", 3),
      routine("pull", "ppl", 1),
      ...routines.slice(3),
    ];
    // Now pull, legs, push: push is last, so the rotation goes back to pull.
    expect(next(history, reordered)).toBe("pull");
    // Push moved between upper and lower follows its new folder.
    const moved = [
      ...routines.filter((r) => r.id !== "push" && r.id !== "lower"),
      routine("push", "ul", 2),
      routine("lower", "ul", 3),
    ];
    expect(next(history, moved)).toBe("lower");
    // Folders swapped: with no history, the first routine of the folder now first leads.
    expect(next([], routines, [folder("ul", 1), folder("ppl", 2)])).toBe("upper");
  });
});

describe("historyWeek", () => {
  const summary = (id: string, startedAt: Date, durationMinutes: number, volumeKg: number) => ({
    id,
    title: id,
    startedAt: startedAt.toISOString(),
    durationMinutes,
    volumeKg,
    sets: 10,
    reps: 0,
    loggedWarmups: 0,
    excludedWarmups: 0,
    recordedSeconds: null,
    missingTimedSets: 0,
    exercises: [],
  });
  // Thursday 12 November 2026, 20:00 local time.
  const now = new Date(2026, 10, 12, 20).getTime();
  const workouts = [
    summary("mon", new Date(2026, 10, 9, 18), 50, 5000),
    summary("wed", new Date(2026, 10, 11, 7, 30), 40, 3000),
    summary("wed-2", new Date(2026, 10, 11, 19), 20, 1000),
    summary("last-sun", new Date(2026, 10, 8, 10), 60, 9000),
  ];

  it("pages back from an empty current week across training gaps, keeping today only on the first page", () => {
    const weeks = historyWeeks(
      [...workouts, summary("future", new Date(2027, 0, 3), 7, 100)],
      new Date(2026, 11, 1).getTime(),
      1,
    );
    expect(weeks.map((w) => [w.start, w.workouts, w.minutes, w.volumeKg])).toEqual([
      [new Date(2026, 10, 30).getTime(), 0, 0, 0],
      [new Date(2026, 10, 9).getTime(), 3, 110, 9000],
      [new Date(2026, 10, 2).getTime(), 1, 60, 9000],
    ]);
    expect(weeks.flatMap((w) => w.days.filter((d) => d.today).map((d) => d.date))).toEqual([1]);
    expect(weeks[2]?.days.filter((d) => d.trained).map((d) => d.date)).toEqual([8]);
  });

  it("lays out the week from Monday with dates, trained days and totals", () => {
    const [week] = historyWeeks(workouts, now, 1);
    expect(week.days.map((d) => d.date)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(week.days.map((d) => d.letter).join("")).toBe("MTWTFSS");
    expect(week.days.map((d) => d.trained)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(week.days.map((d) => d.today)).toEqual([false, false, false, true, false, false, false]);
    expect([week.workouts, week.minutes, week.volumeKg]).toEqual([3, 110, 9000]);
    expect(week.days[2]?.sessions.map(({ id }) => id)).toEqual(["wed-2", "wed"]);
    expect(week.days[1]?.sessions).toEqual([]);
    expect(week.start).toBe(new Date(2026, 10, 9).getTime());
    expect(week.end).toBe(new Date(2026, 10, 15).getTime());
  });

  it("starts on Sunday when asked, taking in the Sunday before", () => {
    const [week] = historyWeeks(workouts, now, 0);
    expect(week.days.map((d) => d.date)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(week.days.map((d) => d.trained)).toEqual([true, true, false, true, false, false, false]);
    expect([week.workouts, week.minutes, week.volumeKg]).toEqual([4, 170, 18000]);
  });

  it("crosses a month end by calendar date", () => {
    const [week] = historyWeeks([], new Date(2026, 11, 2, 9).getTime(), 1);
    expect(week.days.map((d) => d.date)).toEqual([30, 1, 2, 3, 4, 5, 6]);
    expect(week.workouts).toBe(0);
  });
});

describe("month odometer", () => {
  const summary = (id: string, day: number, volumeKg: number, minutes: number) => ({
    id,
    title: id,
    startedAt: new Date(2026, 1, day, 18).toISOString(),
    durationMinutes: minutes,
    volumeKg,
    sets: 3,
    reps: 24,
    loggedWarmups: 0,
    excludedWarmups: 0,
    recordedSeconds: null,
    missingTimedSets: 0,
    exercises: [],
  });
  // February 2026 starts on a Sunday and has 28 days; today is Tuesday 10 February.
  const month = {
    key: "2026-02",
    year: 2026,
    month: 1,
    workouts: [summary("b", 3, 1500.25, 50), summary("a", 3, 900, 30), summary("c", 9, 0, 25)],
  };
  const today = new Date(2026, 1, 10, 12).getTime();
  const recordsIn = (id: string) => ({ a: 2, c: 1 })[id] ?? 0;

  it("totals the month and marks training days, record days, today and the days ahead", () => {
    const odometer = monthOdometer(month, today, 1, recordsIn);
    expect(odometer).toMatchObject({
      sessions: 3,
      trainingDays: 2,
      volumeKg: 2400.3,
      minutes: 105,
      records: 3,
    });
    // Monday first: the 1st (a Sunday) is the seventh column, after six blanks.
    expect(odometer.cells.slice(0, 7).map((day) => day?.date ?? null)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ]);
    // Six blanks and 28 days make 34 cells, filled out to five whole weeks.
    expect(odometer.cells).toHaveLength(35);
    expect(odometer.cells.at(-1)).toBeNull();
    const day = (date: number) => odometer.cells.find((cell) => cell?.date === date);
    expect(day(3)?.sessions.map((w) => w.id)).toEqual(["b", "a"]);
    expect([day(3)?.record, day(9)?.record, day(4)?.record]).toEqual([true, true, false]);
    expect([day(9)?.today, day(10)?.today, day(10)?.ahead, day(11)?.ahead]).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it("starts the weeks on Sunday when asked", () => {
    const odometer = monthOdometer(month, today, 0, recordsIn);
    expect(odometer.cells[0]?.date).toBe(1);
    expect(odometer.cells).toHaveLength(28);
  });

  it("puts the current month first even before it has a workout", () => {
    const march = new Date(2026, 2, 2).getTime();
    expect(monthPages([month], march).map((page) => page.key)).toEqual(["2026-03", "2026-02"]);
    expect(monthPages([month], today)).toEqual([month]);
  });
});
