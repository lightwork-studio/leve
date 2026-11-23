import { describe, expect, it } from "vitest";
import { METRICS_BY_TYPE, REST_TIMER_VALUES, round, weightFromKg, weightToKg } from "./index.ts";

describe("units", () => {
  it("round-trips lbs", () => {
    expect(round(weightFromKg(100, "lbs"))).toBe(220.46);
    expect(round(weightToKg(weightFromKg(42.5, "lbs"), "lbs"))).toBe(42.5);
  });
});

describe("domain constants", () => {
  it("lists rest timer options", () => {
    expect(REST_TIMER_VALUES.slice(0, 3)).toEqual([0, 5, 10]);
    expect(REST_TIMER_VALUES).toContain(120);
    expect(REST_TIMER_VALUES).toContain(135);
    expect(REST_TIMER_VALUES.at(-1)).toBe(300);
  });
  it("assigns metrics to every exercise type", () => {
    expect(METRICS_BY_TYPE.weight_reps).toEqual(["weight", "reps"]);
  });
});
