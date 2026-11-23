/// <reference lib="dom" />
import { defaultSettings } from "@leve/core";
import { act, createElement } from "react";
import { Text, View } from "react-native";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { summarize, type WorkoutSummary, type WorkoutTree } from "../src/model/past-workouts.ts";
import { buildProgress, recordsByWorkout, workoutRecords } from "../src/model/progress.ts";
import { compareBarcodes, versusLastTime } from "../src/model/session-compare.ts";
import type { WorkoutSet } from "../src/model/types.ts";
import { bestSet, loggedExercises } from "../src/model/workout-done.ts";
import { palettes } from "../src/theme.ts";
import { MuscleStrip } from "../src/ui/muscle-strip.tsx";
import { RecordMark } from "../src/ui/record-mark.tsx";
import { ExercisesCompared, WorkoutResults } from "../src/ui/workout-results.tsx";

/** The palette on screen while the system is in dark mode, as these tests set it. */
const dark = palettes.dark;

let shown: ReturnType<typeof createElement> | null = null;

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  ScrollView: "Scroll",
  View: "View",
  Text: "Text",
  StyleSheet: {
    create: (s: object) => s,
    flatten: (s: object[]) => Object.assign({}, ...s.flat().filter(Boolean)),
  },
}));
vi.mock("react-native-reanimated", () => ({ default: { View: "Animated" } }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("../src/ui/motion.ts", () => ({ pop: () => undefined }));
vi.mock("../src/ui/enter.tsx", () => ({ Enter: "Enter" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/barcode.tsx", () => ({ SetBarcode: "Barcode" }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("../src/ui/icons.tsx", () => ({
  ArrowIcon: "Arrow",
  CheckIcon: "Check",
  ChevronIcon: "Chevron",
  EditIcon: "Edit",
}));

type SetSpec = { kg: number; reps: number };
let ids = 0;
function tree(day: number, sets: SetSpec[], routineId: string | null = null): WorkoutTree {
  const workoutId = `w${++ids}`;
  const start = new Date(2026, 10, day, 18).getTime();
  const entryId = `${workoutId}-e0`;
  return {
    workout: {
      id: workoutId,
      content: {
        title: routineId ? "Push" : `Day ${day}`,
        description: "",
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 72 * 60_000).toISOString(),
        routineId,
      },
    },
    entries: [
      {
        entry: {
          id: entryId,
          content: {
            workoutId,
            exerciseId: "bench",
            exerciseName: "Bench Press",
            exerciseType: "weight_reps",
            position: 1,
            supersetId: null,
            restSeconds: 120,
            doubleDumbbellVolume: false,
          },
        },
        sets: sets.map((s, j) => ({
          id: `${entryId}-s${j}`,
          content: {
            workoutExerciseId: entryId,
            position: j + 1,
            type: "normal",
            weightKg: s.kg,
            reps: s.reps,
            distanceMeters: null,
            durationSeconds: null,
            count: null,
            rpe: null,
            completedAt: "2026-11-12T18:00:00.000Z",
          } satisfies WorkoutSet,
        })),
      },
    ],
  };
}

const counting = { countWarmups: false, bodyweightKg: null, usesBodyweight: () => false };
let muscleSets: Record<string, number> = { chest: 1, triceps: 0.5 };
/** The results of `done`, judged against `trees` (which include it), as the summary shows them. */
function show(trees: WorkoutTree[], done: WorkoutTree, last: WorkoutTree | null) {
  const index = buildProgress(trees, { ...counting, bodyweightAt: () => null });
  const settings = { ...defaultSettings(), weightUnit: "kg" as const };
  const summary = summarize(done, counting);
  const lastTime: WorkoutSummary | null = last ? summarize(last, counting) : null;
  const held = recordsByWorkout(index).get(done.workout.id) ?? [];
  const recordSets = new Set(held.flatMap((record) => (record.setId ? [record.setId] : [])));
  const best = bestSet(done, false);
  shown = createElement(
    View,
    null,
    createElement(WorkoutResults, {
      records: workoutRecords(index, done),
      versus: versusLastTime(index, done, summary, lastTime),
      last: lastTime,
      best,
      settings,
    }),
    createElement(ExercisesCompared, {
      exercises: loggedExercises(done),
      bars: compareBarcodes(index, done, recordSets),
      best,
      unit: "kg",
    }),
    createElement(MuscleStrip, {
      amounts: muscleSets,
      label: "Muscles worked · sets",
      height: 64,
      expandable: true,
    }),
  );
}

let screen: ReactTestRenderer | undefined;
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    if (shown) screen = create(shown);
  });
  if (!screen) throw Error("Summary did not mount");
  return screen.root;
}
afterEach(async () => {
  await act(() => screen?.unmount());
  vi.unstubAllGlobals();
});

const labels = (root: ReactTestInstance) =>
  root
    .findAll((n) => typeof n.props.accessibilityLabel === "string")
    .map((n) => n.props.accessibilityLabel);
const textColor = (node: ReactTestInstance) =>
  [node.props.style].flat(3).reduce((found, style) => style?.color ?? found, undefined);

it("leads with the records, each with what it beat, in brass", async () => {
  const before = tree(1, [{ kg: 100, reps: 5 }]);
  const done = tree(3, [{ kg: 110, reps: 3 }]);
  show([before, done], done, null);
  const root = await render();
  const all = labels(root);
  expect(all).toContain("2 new records");
  // 110 kg beats 100 kg; its estimate 110 × (1 + 3/30) = 121 beats 100 × (1 + 5/30) = 116.7.
  expect(all).toContain("Bench Press, Heaviest weight record, 110 kg, was 100 kg");
  expect(all).toContain("Bench Press, Best estimated 1RM record, 121 kg, was 116.7 kg");
  const lead = root.find((n) => n.type === Text && n.props.children === 2);
  expect(textColor(lead)).toBe(dark.record);
  expect(root.findAllByType(RecordMark).length).toBeGreaterThan(0);
  expect(all.some((label) => label.includes("up on last time"))).toBe(false);
  // The barcode shows last time's 500 kg set behind this time's 330 kg one, marked a record.
  const [bars] = root.findByType("Barcode" as never).props.exercises;
  expect(bars).toEqual([{ magnitude: 330, previous: 500, warmup: false, record: true }]);
});

it("compares with last time in plain ink when there are no records", async () => {
  const best = tree(1, [{ kg: 120, reps: 5 }]);
  const last = tree(3, [{ kg: 100, reps: 5 }], "push");
  const done = tree(5, [{ kg: 105, reps: 5 }], "push");
  show([best, last, done], done, last);
  const root = await render();
  const all = labels(root);
  expect(all.some((label) => label.includes("record"))).toBe(false);
  // 525 kg against the routine's last 500 kg is 5% more.
  expect(all.find((label) => label.startsWith("1 exercise up on last time"))).toMatch(
    /, volume \+5% on Push · /,
  );
  // 105 × (1 + 5/30) = 122.5 against 116.7: up 5.8 kg.
  expect(all).toContain("Bench Press, Best estimated 1RM up 5.8 kg, 122.5 kg, was 116.7 kg");
  const lead = root.find((n) => n.type === Text && n.props.children === 1);
  expect(textColor(lead)).toBe(dark.fg);
  expect(root.findAllByType(RecordMark)).toHaveLength(0);
});

it("leaves the comparison out without an earlier session", async () => {
  const done = tree(7, [{ kg: 60, reps: 8 }]);
  show([done], done, null);
  const root = await render();
  const all = labels(root);
  // The first session of an exercise sets its records, with nothing to say they beat.
  expect(all.find((label) => label.startsWith("Bench Press, Heaviest weight"))).toMatch(
    /first time$/,
  );
  expect(all.some((label) => label.includes("last time"))).toBe(false);
  expect(root.findAll((n) => n.type === View && n.props.accessible).length).toBeGreaterThan(0);
});

it("shows the muscles worked under the readouts, opening the full list past four", async () => {
  muscleSets = { chest: 3, triceps: 1.5, shoulders: 1.5, abdominals: 1, biceps: 0.5 };
  const done = tree(9, [{ kg: 60, reps: 8 }]);
  show([done], done, null);
  const root = await render();
  expect(labels(root)).toContain(
    "Muscles worked: Chest 3 sets, Shoulders 1.5 sets, Triceps 1.5 sets, Abdominals 1 set, Biceps 0.5 sets",
  );
  expect(labels(root)).not.toContain("Abdominals 1 set");
  await act(() => root.findByProps({ accessibilityLabel: "Show 2 more muscles" }).props.onPress());
  expect(labels(root)).toContain("Abdominals 1 set");
  expect(labels(root)).toContain("Biceps 0.5 sets");
});
