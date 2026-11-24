import { describe, expect, it } from "vitest";
import { emptyWorkoutSet } from "../src/model/live.ts";
import type { WorkoutTree } from "../src/model/past-workouts.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import { fieldView, logValues } from "../src/ui/live/set-fields.ts";
import { dockTarget, exerciseAfterLog } from "../src/ui/live/targets.ts";

const done = "2026-11-20T10:00:00.000Z";
const entry = (
  id: string,
  name: string,
  sets: Partial<WorkoutSet>[],
  supersetId: number | null = null,
) => ({
  entry: {
    id,
    content: {
      workoutId: "w",
      exerciseId: id,
      exerciseName: name,
      exerciseType: "weight_reps",
      position: 1,
      supersetId,
      notes: [],
      restSeconds: 90,
      doubleDumbbellVolume: false,
    },
  },
  sets: sets.map((set, i) => ({
    id: `${id}${i + 1}`,
    content: { ...emptyWorkoutSet(id), position: i + 1, ...set },
  })),
});
const workout = (entries: ReturnType<typeof entry>[]): WorkoutTree => ({
  workout: {
    id: "w",
    content: {
      title: "",
      description: "",
      startedAt: done,
      endedAt: null,
      routineId: null,
      initialPlan: null,
    },
  },
  entries,
});

describe("the set the dock logs", () => {
  const tree = workout([
    entry("bench", "Bench Press", [{ type: "warmup" }, {}, {}]),
    entry("row", "Row", [{}, {}]),
  ]);

  it("is the selected exercise's next set, counted as the list numbers it", () => {
    expect(dockTarget(tree, 0)).toMatchObject({ setIndex: 0, label: "W" });
    const warmup = tree.entries[0]?.sets[0];
    if (!warmup) throw new Error("Missing warm-up");
    warmup.content.completedAt = done;
    expect(dockTarget(tree, 0)).toMatchObject({ setIndex: 1, label: "1" });
    expect(dockTarget(tree, 1)).toMatchObject({ entryIndex: 1, setIndex: 0 });
  });

  it("is a picked set while it is still to log, then the exercise's next again", () => {
    expect(dockTarget(tree, 0, "bench3")).toMatchObject({ setIndex: 2, label: "2" });
    expect(dockTarget(tree, 0, "bench1")).toMatchObject({ setIndex: 1 });
  });

  it("moves on to the first exercise with a set left, and is nothing once all are logged", () => {
    const finished = workout([
      entry("bench", "Bench Press", [{ completedAt: done }]),
      entry("row", "Row", [{}]),
    ]);
    expect(dockTarget(finished, 0)).toMatchObject({ entryIndex: 1, setIndex: 0 });
    const row = finished.entries[1]?.sets[0];
    if (!row) throw new Error("Missing row set");
    row.content.completedAt = done;
    expect(dockTarget(finished, 1)).toBeNull();
  });

  it("passes over a set that waits for a sync review", () => {
    const held = workout([entry("bench", "Bench Press", [{}, {}])]);
    Object.assign(held.entries[0]?.sets[0] ?? {}, { needsSyncReview: true });
    expect(dockTarget(held, 0)).toMatchObject({ setIndex: 1 });
  });
});

describe("a field of a set", () => {
  const set = { ...emptyWorkoutSet("bench") };
  const base = {
    set,
    type: "weight_reps",
    unit: "kg" as const,
    distanceUnit: "m" as const,
    draft: undefined,
    timer: undefined,
    target: undefined,
    ready: true,
  };

  it("suggests last time's value until something is typed, which then wins", () => {
    const previous = {
      weightKg: 80,
      reps: 8,
      durationSeconds: null,
      distanceMeters: null,
      count: null,
    };
    expect(fieldView({ ...base, metric: "weight", previous })).toMatchObject({
      text: "80",
      firm: false,
      value: 80,
    });
    const typed = { ...base, metric: "weight" as const, previous, draft: { weight: "82.5" } };
    expect(fieldView(typed)).toMatchObject({ text: "82.5", firm: true, value: 82.5 });
    expect(logValues({ ...typed })).toEqual({ values: { weightKg: 82.5, reps: 8 } });
  });

  it("asks for reps when nothing says how many were done", () => {
    expect(logValues({ ...base, previous: undefined })).toMatchObject({ missing: "reps" });
  });
});

describe("the exercise selected after a set is logged", () => {
  // Bench and Row alternate as a superset; Curl stands on its own before them.
  const tree = () =>
    workout([
      entry("curl", "Curl", [{}, {}]),
      entry("bench", "Bench Press", [{ type: "warmup" }, {}, {}], 4),
      entry("row", "Row", [{}, {}], 4),
    ]);
  const log = (tree: WorkoutTree, setId: string) => {
    const set = tree.entries.flatMap((e) => e.sets).find((s) => s.id === setId);
    if (!set) throw new Error(`Missing ${setId}`);
    set.content.completedAt = done;
  };

  it("alternates through a superset, warm-ups included, and the dock follows", () => {
    const t = tree();
    expect(exerciseAfterLog(t, "bench", "bench1")).toBe("row");
    log(t, "bench1");
    expect(dockTarget(t, 2)).toMatchObject({ entryIndex: 2, setIndex: 0 });
    expect(exerciseAfterLog(t, "row", "row1")).toBe("bench");
    log(t, "row1");
    expect(dockTarget(t, 1)).toMatchObject({ entryIndex: 1, setIndex: 1, label: "1" });
  });

  it("stays on an exercise once the rest of its superset is finished", () => {
    const t = tree();
    for (const id of ["bench1", "row1", "bench2", "row2"]) log(t, id);
    expect(exerciseAfterLog(t, "bench", "bench3")).toBe("bench");
  });

  it("passes over a finished member in a larger superset", () => {
    const t = workout([
      entry("a", "A", [{}, {}], 1),
      entry("b", "B", [{ completedAt: done }], 1),
      entry("c", "C", [{}], 1),
    ]);
    expect(exerciseAfterLog(t, "a", "a1")).toBe("c");
    expect(exerciseAfterLog(t, "c", "c1")).toBe("a");
  });

  it("stays on an exercise that is not in a superset", () => {
    expect(exerciseAfterLog(tree(), "curl", "curl1")).toBe("curl");
  });

  it("skips a partner whose only open set waits for a sync review", () => {
    const t = workout([entry("a", "A", [{}, {}], 1), entry("b", "B", [{}], 1)]);
    Object.assign(t.entries[1]?.sets[0] ?? {}, { needsSyncReview: true });
    expect(exerciseAfterLog(t, "a", "a1")).toBe("a");
  });
});
