import { expect, it } from "vitest";
import { barcodeBars, SKIPPED_HEIGHT, setMagnitude } from "../src/model/barcode.ts";

it("scales each exercise to its own biggest set, so a light exercise keeps its shape", () => {
  const [heavy, light] = barcodeBars(
    [
      [{ magnitude: 1000 }, { magnitude: 500 }],
      [{ magnitude: 40 }, { magnitude: 20 }],
    ],
    28,
  );
  expect(heavy?.map((bar) => bar.height)).toEqual([28, 14]);
  expect(light?.map((bar) => bar.height)).toEqual([28, 14]);
});

it("counts last time in the scale, outlining it behind this time's bar", () => {
  const [bars] = barcodeBars([[{ magnitude: 600, previous: 800 }, { magnitude: 800 }]], 40);
  // Last time's 800 was the biggest set, so it sets the full height.
  expect(bars).toEqual([
    { kind: "work", height: 30, ghost: 40 },
    { kind: "work", height: 40, ghost: 0 },
  ]);
});

it("keeps small sets visible, draws skipped sets as stubs, and marks warm-ups and records", () => {
  const [bars] = barcodeBars(
    [
      [
        { magnitude: 1000, record: true },
        { magnitude: 10, warmup: true },
        { magnitude: 900, skipped: true },
        { magnitude: 0 },
      ],
    ],
    28,
    4,
  );
  expect(bars?.map((bar) => [bar.kind, bar.height])).toEqual([
    ["record", 28],
    ["warmup", 4],
    ["skipped", SKIPPED_HEIGHT],
    ["work", 4],
  ]);
});

it("draws an exercise with nothing measured without dividing by zero", () => {
  const [bars] = barcodeBars([[{ magnitude: 0, previous: Number.NaN }]], 28);
  expect(bars).toEqual([{ kind: "work", height: 4, ghost: 0 }]);
});

it("sizes a set by weight times reps, falling back to reps, time or distance", () => {
  expect(setMagnitude({ weightKg: 100, reps: 5 })).toBe(500);
  expect(setMagnitude({ weightKg: 0, reps: 12 })).toBe(12);
  expect(setMagnitude({ seconds: 60 })).toBe(60);
  expect(setMagnitude({ meters: 400, reps: null })).toBe(400);
  expect(setMagnitude({})).toBe(0);
});
