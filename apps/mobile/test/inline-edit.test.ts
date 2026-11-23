import { describe, expect, it } from "vitest";
import { retimeRest } from "../src/data/rest-timer.ts";
import {
  durationDigits,
  durationText,
  fieldOrder,
  nextField,
  stepLabel,
  stepSize,
  stepText,
  typeKey,
} from "../src/model/inline-edit.ts";

describe("the number pad", () => {
  it("replaces a freshly opened value with the first key, then adds to it", () => {
    expect(typeKey("weight", "80", "6", true)).toBe("6");
    expect(typeKey("weight", "6", "2", false)).toBe("62");
    expect(typeKey("weight", "62", ".", false)).toBe("62.");
    expect(typeKey("weight", "62.", "5", false)).toBe("62.5");
    expect(typeKey("weight", "62.5", "delete", false)).toBe("62.");
  });

  it("takes a decimal point only for weights and distances, and only once", () => {
    expect(typeKey("reps", "8", ".", false)).toBeNull();
    expect(typeKey("count", "8", ".", false)).toBeNull();
    expect(typeKey("distance", "5", ".", false)).toBe("5.");
    expect(typeKey("weight", "5.5", ".", false)).toBeNull();
    // A point first reads as a fraction of one.
    expect(typeKey("weight", "", ".", true)).toBe("0.");
  });

  it("refuses digits past a field's length and drops a leading zero", () => {
    expect(typeKey("reps", "1234", "5", false)).toBeNull();
    expect(typeKey("reps", "0", "8", false)).toBe("8");
    expect(typeKey("weight", "2.125", "5", false)).toBeNull();
  });

  it("types a time from the right, as minutes and seconds", () => {
    // Continues from the digits shown (1:02 is 102).
    expect(typeKey("duration", "1:02", "1", false)).toBe("10:21");
    expect(typeKey("duration", "", "4", true)).toBe("0:04");
    expect(typeKey("duration", "0:04", "5", false)).toBe("0:45");
    expect(typeKey("duration", "0:45", "0", false)).toBe("4:50");
    expect(typeKey("duration", "4:50", "delete", false)).toBe("0:45");
    expect(typeKey("duration", "0:45", ".", false)).toBeNull();
    expect(durationText("12345")).toBe("1:23:45");
    expect(durationDigits("90")).toBe("130");
  });
});

describe("the ± steppers", () => {
  it("move by the app's steps in the units on screen, never below zero", () => {
    expect(stepSize("weight", "kg", "m")).toBe(2.5);
    expect(stepSize("weight", "lbs", "m")).toBe(5);
    expect(stepSize("weight", "kg", "m", 1.25)).toBe(1.25);
    expect(stepSize("reps", "kg", "m")).toBe(1);
    expect(stepSize("duration", "kg", "m")).toBe(5);
    expect(stepSize("distance", "kg", "km")).toBe(0.1);
    expect(stepSize("distance", "kg", "yd")).toBe(10);
    expect(stepText("weight", 80, 1, "kg", "m")).toBe("82.5");
    expect(stepText("weight", 1, -1, "kg", "m")).toBe("0");
    expect(stepText("weight", null, 1, "lbs", "m")).toBe("5");
    expect(stepText("reps", 8, -1, "kg", "m")).toBe("7");
    expect(stepText("duration", 58, 1, "kg", "m")).toBe("1:03");
    expect(stepText("distance", 5, 1, "kg", "km")).toBe("5.1");
    expect(stepLabel("duration", "kg", "m")).toBe("5 s");
    expect(stepLabel("weight", "lbs", "m")).toBe("5");
  });
});

describe("Next on the pad", () => {
  const order = fieldOrder(
    [
      { metrics: ["weight", "reps"], sets: [{ id: "a1" }, { id: "a2" }] },
      { metrics: ["duration"], sets: [{ id: "b1" }, { id: "b2" }] },
    ],
    (setId) => setId === "b1",
  );

  it("walks weight, reps, the next set, then the next exercise, skipping held sets", () => {
    const walk = [];
    let at = order[0] ?? null;
    while (at) {
      walk.push(`${at.setId}:${at.metric}`);
      at = nextField(order, at);
    }
    expect(walk).toEqual(["a1:weight", "a1:reps", "a2:weight", "a2:reps", "b2:duration"]);
    expect(nextField(order, { setId: "a2", metric: "weight" }, -1)).toMatchObject({
      setId: "a1",
      metric: "reps",
    });
  });
});

describe("changing a running rest's length", () => {
  it("counts the new length from when the rest began", () => {
    // Began at 0 for 60 s; 20 s in, it becomes 90 s long.
    expect(retimeRest({ endsAt: 60_000, totalSeconds: 60 }, 90, 20_000)).toEqual({
      endsAt: 90_000,
      totalSeconds: 90,
    });
  });

  it("ends now when the new length has already passed", () => {
    expect(retimeRest({ endsAt: 60_000, totalSeconds: 60 }, 15, 20_000).endsAt).toBe(20_000);
  });
});
