import { describe, expect, it } from "vitest";
import { adjustRest, restProgress } from "../src/data/rest-timer.ts";

describe("rest timer adjustments", () => {
  const rest = { endsAt: 60000, totalSeconds: 60, label: "Bench Press" };

  it("skips 15 seconds of progress at second two without changing the pace", () => {
    const shortened = adjustRest(rest, -15, 2000);
    expect(shortened.totalSeconds).toBe(60);
    const after = restProgress(shortened, 2000);
    expect(after.left).toBe(43000);
    expect(after.fraction).toBeCloseTo(17 / 60);
    expect(restProgress(shortened, 3000).fraction).toBeCloseTo(18 / 60);
  });

  it("finishes immediately when the reduction exceeds the time left", () => {
    expect(restProgress(adjustRest(rest, -15, 55000), 55000)).toEqual({ left: 0, fraction: 1 });
  });

  it("still extends the interval when time is added", () => {
    const extended = adjustRest(rest, 15, 2000);
    expect(extended.totalSeconds).toBe(75);
    expect(restProgress(extended, 2000).left).toBe(73000);
  });
});

it("never shows more than the configured rest when the screen clock is one tick behind", () => {
  expect(restProgress({ endsAt: 121500, totalSeconds: 120 }, 700)).toEqual({
    left: 120000,
    fraction: 0,
  });
});
