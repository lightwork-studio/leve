import { describe, expect, it } from "vitest";
import {
  alignLines,
  areaPath,
  lerpLine,
  linePath,
  NO_LINE,
  type Polyline,
  pointAt,
} from "../src/ui/line-tween.ts";

const line = (points: [t: number, x: number, y: number][]): Polyline => ({
  t: points.map((p) => p[0]),
  x: points.map((p) => p[1]),
  y: points.map((p) => p[2]),
});

describe("moving a line chart to another line", () => {
  const before = line([
    [10, 0, 100],
    [20, 50, 0],
    [30, 100, 50],
  ]);

  it("finds a line's position between its vertices and holds its ends beyond them", () => {
    expect(pointAt(before, 15)).toEqual([25, 50]);
    expect(pointAt(before, 30)).toEqual([100, 50]);
    expect(pointAt(before, 5)).toEqual([0, 100]);
    expect(pointAt(before, 99)).toEqual([100, 50]);
  });

  it("gives both lines a vertex at every moment either has, each drawn as before", () => {
    // The new line covers a longer span (a longer range), so the old points sit further right.
    const after = line([
      [0, 0, 80],
      [20, 60, 20],
      [30, 90, 40],
      [40, 120, 60],
    ]);
    const pair = alignLines(before, after);
    if (!pair) throw new Error("no pair");
    const [a, b] = pair;
    expect(a.t).toEqual([0, 10, 20, 30, 40]);
    expect(b.t).toEqual([0, 10, 20, 30, 40]);
    // The old line waits at its first and last points where it has none.
    expect(a.x).toEqual([0, 0, 50, 100, 100]);
    expect(a.y).toEqual([100, 100, 0, 50, 50]);
    // Time 10 lies halfway along the new line's first segment.
    expect(b.x).toEqual([0, 30, 60, 90, 120]);
    expect(b.y).toEqual([80, 50, 20, 40, 60]);
    expect(linePath(a)).toBe("M0,100 L0,100 L50,0 L100,50 L100,50");
  });

  it("moves every vertex part of the way, ending exactly on the new line", () => {
    const after = line([
      [10, 0, 0],
      [20, 50, 100],
      [30, 100, 0],
    ]);
    const [a, b] = alignLines(before, after) ?? [NO_LINE, NO_LINE];
    expect(lerpLine(a, b, 0.25).y).toEqual([75, 25, 37.5]);
    expect(lerpLine(a, b, 0)).toBe(a);
    expect(lerpLine(a, b, 1)).toBe(b);
  });

  it("doesn't move to or from no line", () => {
    expect(alignLines(NO_LINE, before)).toBeNull();
    expect(alignLines(before, NO_LINE)).toBeNull();
  });

  it("fills under a line of two or more points only", () => {
    expect(areaPath(before, 140)).toBe("M0,100 L50,0 L100,50 L100,140 L0,140 Z");
    expect(areaPath(line([[1, 5, 5]]), 140)).toBe("");
  });
});
