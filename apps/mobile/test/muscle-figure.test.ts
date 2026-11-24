import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  type MuscleTargets,
  musclePeriodBounds,
  muscleSections,
  muscleStep,
  muscleSteps,
  periodMuscleActivity,
  rankedMuscles,
  stripNames,
  targetAmounts,
} from "../src/model/muscle-map.ts";
import type { ExerciseHistory } from "../src/model/progress.ts";
import { palettes } from "../src/theme.ts";
import { MuscleFigure } from "../src/ui/muscle-figure.tsx";
import {
  FIGURE_MUSCLES,
  muscleAt,
  nearestMuscle,
  sideOf,
  toPathUnits,
} from "../src/ui/muscle-geometry.ts";
import paths from "../src/ui/muscle-paths.json";
import { MuscleStrip } from "../src/ui/muscle-strip.tsx";

/** The palette on screen while the system is in dark mode, as these tests set it. */
const dark = palettes.dark;

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (s: object[]) => Object.assign({}, ...s),
  },
  View: "div",
  Text: "span",
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "button" }));
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));

const ramp = dark.muscle.ramp;

describe("shading", () => {
  it("shades each muscle ⌈4 × value ÷ max⌉, so any training shows and the most is darkest", () => {
    expect([0, 0.1, 2.5, 2.6, 5, 7.5, 7.6, 10].map((v) => muscleStep(v, 10))).toEqual([
      0, 1, 1, 2, 2, 3, 4, 4,
    ]);
    expect(muscleStep(3, 0)).toBe(0);
    expect(muscleStep(-1, 4)).toBe(0);
    expect([...muscleSteps({ chest: 8, triceps: 4, biceps: 0.5 })]).toEqual([
      ["chest", 4],
      ["triceps", 2],
      ["biceps", 1],
    ]);
  });

  it("draws an exercise's primary muscle darkest and its secondary muscles at the middle step", () => {
    const targets: MuscleTargets = { primaryMuscles: ["chest"], secondaryMuscles: ["triceps"] };
    expect([...muscleSteps(targetAmounts(targets))]).toEqual([
      ["triceps", 2],
      ["chest", 4],
    ]);
  });

  it("paints each muscle with its step on the side that draws it and leaves the rest untrained", () => {
    const html = renderToStaticMarkup(
      createElement(MuscleFigure, {
        amounts: { chest: 4, triceps: 2 },
        height: 200,
        accessibilityLabel: "Chest and triceps",
      }),
    );
    expect(html).toContain(`d="${paths.front.chest}" fill="${ramp[4]}" opacity="1"`);
    expect(html).toContain(`d="${paths.back.triceps}" fill="${ramp[2]}" opacity="1"`);
    expect(html).toContain(`d="${paths.back.glutes}" fill="${ramp[0]}" opacity="1"`);
    expect(html).not.toContain("muscle-front-selected");
  });

  it("dims the other muscles and outlines the chosen one, keeping its fill", () => {
    const html = renderToStaticMarkup(
      createElement(MuscleFigure, {
        amounts: { chest: 4, triceps: 2 },
        height: 200,
        selected: "triceps",
        accessibilityLabel: "Triceps chosen",
      }),
    );
    expect(html).toContain(`d="${paths.back.triceps}" fill="${ramp[2]}" opacity="1"`);
    expect(html).toContain(`d="${paths.front.chest}" fill="${ramp[4]}" opacity="0.3"`);
    // Triceps show on both sides, so both get the outline, drawn in ink without a fill.
    for (const side of ["front", "back"] as const) {
      expect(html).toContain(
        `testID="muscle-${side}-selected" d="${paths[side].triceps}" fill="none" stroke="${dark.fg}"`,
      );
    }
  });

  it("keeps the gaps between a chosen muscle's parts when it is shaded in the outline's ink", () => {
    // The filter shades the chosen muscle at the top step, which is the outline's ink.
    expect(ramp[4]).toBe(dark.fg);
    const html = renderToStaticMarkup(
      createElement(MuscleFigure, {
        amounts: { abdominals: 1 },
        height: 168,
        sides: ["front"],
        selected: "abdominals",
        accessibilityLabel: "Abs chosen",
      }),
    );
    const abs = paths.front.abdominals;
    const at = (drawn: string) => {
      const index = html.indexOf(drawn);
      expect(index, drawn).toBeGreaterThanOrEqual(0);
      return index;
    };
    const point = 1276 / 168;
    // Ink drawn over the parts, or left in the gaps between them, would join them into one shape.
    // So the outline goes under the muscle, with the body's colour over it, narrower, to keep the
    // gaps clear and set the ring off the muscle; then the muscle itself.
    const outline = at(
      `testID="muscle-front-selected" d="${abs}" fill="none" stroke="${dark.fg}" stroke-width="${point * 4}"`,
    );
    const gaps = at(
      `testID="muscle-front-selected-gaps" d="${abs}" fill="none" stroke="${dark.muscle.body}" stroke-width="${point * 2}"`,
    );
    const muscle = at(`testID="muscle-front-abdominals" d="${abs}" fill="${ramp[4]}" opacity="1"`);
    expect(outline).toBeLessThan(gaps);
    expect(gaps).toBeLessThan(muscle);
    expect(html.indexOf(`stroke="${dark.fg}"`, muscle)).toBe(-1);
    // The muscle is drawn once, after the dimmed rest.
    expect(html.split(`d="${abs}" fill="${ramp[4]}"`)).toHaveLength(2);
    expect(at(`testID="muscle-front-chest"`)).toBeLessThan(outline);
  });
});

describe("tapping the figure", () => {
  it("picks the muscle under the finger, and the nearest one within about 20 points of a miss", () => {
    // A point inside the chest, found on a grid of the drawing.
    expect(muscleAt("front", 256, 366)).toBe("chest");
    // Above the shoulder line, in the gap between neck and traps: the nearest wins.
    const height = 236;
    const { unitsPerPoint } = toPathUnits("front", height, 0, 0);
    const neck = nearestMuscle("front", 365, 250, unitsPerPoint);
    expect(neck).toBe("neck");
    // Far outside the body, nothing is within reach.
    expect(nearestMuscle("front", 60, 1340, unitsPerPoint)).toBeNull();
  });

  it("reaches further in path units on a smaller figure, since a point covers more", () => {
    // The gap above the shoulder line is about 8 points from the neck on a full figure.
    const big = toPathUnits("front", 236, 0, 0).unitsPerPoint;
    const small = toPathUnits("front", 34, 0, 0).unitsPerPoint;
    expect(small / big).toBeCloseTo(236 / 34);
    // Well clear of the body on a full figure, but within reach on a row's small one.
    expect(nearestMuscle("front", 365, 100, big)).toBeNull();
    expect(nearestMuscle("front", 365, 100, small)).not.toBeNull();
    expect(FIGURE_MUSCLES).toHaveLength(17);
    expect(sideOf("glutes")).toBe("back");
    expect(sideOf("chest")).toBe("front");
  });

  it("chooses a muscle from where a tap lands in the figure", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSelect = vi.fn();
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(
          createElement(MuscleFigure, {
            amounts: {},
            height: 236,
            onSelect,
            accessibilityLabel: "Filter by muscle",
          }),
        );
      });
      const layer = screen?.root.findByProps({ testID: "muscle-figure-front" });
      // The chest at (256, 366) in path units, as points in a 236-point figure.
      const scale = 1276 / 236;
      layer?.props.onResponderRelease({
        nativeEvent: { locationX: (256 - 40) / scale, locationY: (366 - 86) / scale },
      });
      expect(onSelect).toHaveBeenCalledWith("chest");
      expect(layer?.props.onStartShouldSetResponder()).toBe(true);
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("the compact strip", () => {
  it("names every muscle up to four, else the top three and how many more", () => {
    expect(stripNames(["a", "b", "c", "d"])).toEqual({ shown: ["a", "b", "c", "d"], more: 0 });
    expect(stripNames(["a", "b", "c", "d", "e", "f"])).toEqual({ shown: ["a", "b", "c"], more: 3 });
    expect(stripNames(["a", "b", "c", "d", "e"], true)).toEqual({
      shown: ["a", "b", "c", "d", "e"],
      more: 0,
    });
    expect(rankedMuscles({ triceps: 1.5, chest: 3, biceps: 1.5, glutes: 0 })).toEqual([
      ["chest", 3],
      ["biceps", 1.5],
      ["triceps", 1.5],
    ]);
  });

  it("shows the top three with '+2 more', which opens the full list on the summary", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const amounts = { chest: 6, triceps: 3, shoulders: 3, biceps: 1.5, lats: 1 };
    let screen: ReactTestRenderer | undefined;
    try {
      await act(() => {
        screen = create(createElement(MuscleStrip, { amounts, expandable: true }));
      });
      if (!screen) throw Error("Missing strip");
      const root = screen.root;
      const names = () =>
        root
          .findAll((n) => n.type === "div" && typeof n.props.accessibilityLabel === "string")
          .map((n) => n.props.accessibilityLabel as string)
          .filter((label) => !label.startsWith("Muscles"));
      expect(names()).toEqual(["Chest 6 sets", "Shoulders 3 sets", "Triceps 3 sets"]);
      const more = root.findByProps({ accessibilityLabel: "Show 2 more muscles" });
      expect(root.findAllByType("span").some((n) => n.children.join("") === "+2 more")).toBe(true);
      await act(() => more.props.onPress());
      expect(names()).toEqual([
        "Chest 6 sets",
        "Shoulders 3 sets",
        "Triceps 3 sets",
        "Biceps 1.5 sets",
        "Lats 1 set",
      ]);
      await act(() =>
        root.findByProps({ accessibilityLabel: "Show fewer muscles" }).props.onPress(),
      );
      expect(names()).toHaveLength(3);
      // The figure still speaks every muscle.
      expect(root.findByProps({ accessibilityRole: "image" }).props.accessibilityLabel).toBe(
        "Muscles worked: Chest 6 sets, Shoulders 3 sets, Triceps 3 sets, Biceps 1.5 sets, Lats 1 set",
      );
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("says '+N more' without a button on session detail, and nothing without sets", () => {
    const html = renderToStaticMarkup(
      createElement(MuscleStrip, {
        amounts: { chest: 6, triceps: 3, shoulders: 3, biceps: 1, lats: 1 },
      }),
    );
    expect(html).toContain("+2 more");
    expect(html).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(MuscleStrip, { amounts: {} }))).toBe("");
  });
});

describe("grouping exercises by a muscle", () => {
  const items = [
    { id: "bench", p: ["chest"], s: ["triceps", "shoulders"] },
    { id: "pushdown", p: ["triceps"], s: [] },
    { id: "dip", p: ["triceps"], s: ["chest"] },
    { id: "curl", p: ["biceps"], s: [] },
    { id: "mystery", p: null, s: [] },
  ] as const;
  const targets = (item: (typeof items)[number]): MuscleTargets | undefined =>
    item.p
      ? {
          primaryMuscles: [...item.p],
          secondaryMuscles: [...item.s] as MuscleTargets["secondaryMuscles"],
        }
      : undefined;
  const label = (m: string) => m[0]?.toUpperCase() + m.slice(1);
  const ids = (sections: { title: string; data: { id: string }[] }[]) =>
    sections.map((section) => [section.title, section.data.map((item) => item.id)]);

  it("lists the exercises that target a muscle first, then those that also work it, in order", () => {
    expect(ids(muscleSections(items, "triceps", targets, label))).toEqual([
      ["Triceps · primary", ["pushdown", "dip"]],
      ["Also works triceps", ["bench"]],
    ]);
    expect(ids(muscleSections(items, "chest", targets, label))).toEqual([
      ["Chest · primary", ["bench"]],
      ["Also works chest", ["dip"]],
    ]);
  });

  it("leaves out an empty group, counts unknown muscles as other, and keeps one list without a muscle", () => {
    expect(ids(muscleSections(items, "shoulders", targets, label))).toEqual([
      ["Also works shoulders", ["bench"]],
    ]);
    expect(ids(muscleSections(items, "other", targets, label))).toEqual([
      ["Other · primary", ["mystery"]],
    ]);
    expect(ids(muscleSections(items, "", targets, label))).toEqual([
      ["", ["bench", "pushdown", "dip", "curl", "mystery"]],
    ]);
  });
});

describe("a period's muscles", () => {
  const session = (time: number, counted: number, volumeKg: number | null) =>
    ({ time, counted, best: { volumeKg } }) as unknown as ExerciseHistory["sessions"][number];
  const history = (exerciseId: string, sessions: ExerciseHistory["sessions"]) =>
    ({ exerciseId, name: exerciseId, sessions }) as unknown as ExerciseHistory;
  const lookup = (id: string): MuscleTargets | undefined =>
    id === "bench"
      ? { primaryMuscles: ["chest"], secondaryMuscles: ["triceps"] }
      : id === "pullup"
        ? { primaryMuscles: ["lats"], secondaryMuscles: [] }
        : undefined;
  const exercises = [
    history("bench", [session(10, 3, 600), session(1, 9, 900)]),
    history("pullup", [session(12, 4, null)]),
  ];

  it("credits sets or volume in full to primary muscles and half to secondary ones", () => {
    const sets = periodMuscleActivity(exercises, 5, 20, lookup, "sets");
    expect(sets.amounts).toEqual({ chest: 3, triceps: 1.5, lats: 4 });
    // Each set once, for shares of the whole.
    expect(sets.total).toBe(7);
    const volume = periodMuscleActivity(exercises, 5, 20, lookup, "volume");
    expect(volume.amounts).toEqual({ chest: 600, triceps: 300 });
    expect(volume.total).toBe(600);
    expect(volume.byGroup.get("triceps")).toEqual([
      { exerciseId: "bench", name: "bench", sets: 600, credit: 300 },
    ]);
  });

  it("covers today and the six or twenty-nine days before it, or three months back", () => {
    const now = new Date(2026, 10, 22, 15, 30).getTime();
    const end = new Date(2026, 10, 23).getTime();
    expect(musclePeriodBounds("7d", now)).toEqual({ start: new Date(2026, 10, 16).getTime(), end });
    expect(musclePeriodBounds("30d", now)).toEqual({ start: new Date(2026, 9, 24).getTime(), end });
    expect(musclePeriodBounds("3m", now)).toEqual({ start: new Date(2026, 7, 22).getTime(), end });
    // A shorter month ends on its last day.
    expect(musclePeriodBounds("3m", new Date(2026, 4, 31).getTime()).start).toBe(
      new Date(2026, 1, 28).getTime(),
    );
  });
});
