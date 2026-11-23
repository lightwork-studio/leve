import { describe, expect, it } from "vitest";
import { s, validate } from "../src/index.ts";

const set = s.object(
  {
    reps: s.nullable(s.integer(0, 100)),
    weightKg: s.number({ minimum: 0, maximum: 500 }),
    note: s.string({ maxLength: 3 }),
  },
  ["note"],
);

describe("schema", () => {
  it("tells missing, null, zero and false apart", () => {
    expect(validate(set, { reps: null, weightKg: 0 })).toEqual([]);
    expect(validate(set, { weightKg: 0 })).toEqual([{ path: "$.reps", message: "missing" }]);
    expect(validate(set, { reps: 0, weightKg: null })[0]?.path).toBe("$.weightKg");
    expect(validate(s.boolean(), 0)).toHaveLength(1);
    expect(validate(s.nullable(s.boolean()), false)).toEqual([]);
  });

  it("rejects unknown fields instead of stripping them", () => {
    expect(validate(set, { reps: 1, weightKg: 1, effort: 3 })).toEqual([
      { path: "$.effort", message: "unknown field" },
    ]);
  });

  it("checks integers, ranges, non-finite numbers and string length", () => {
    expect(validate(set, { reps: 1.5, weightKg: 1 })[0]?.message).toBe("expected an integer");
    expect(validate(set, { reps: 1, weightKg: 500.01 })[0]?.message).toBe("must be 0..500");
    expect(validate(set, { reps: 1, weightKg: Number.NaN })).toHaveLength(1);
    expect(validate(set, { reps: 1, weightKg: 1, note: "long" })).toHaveLength(1);
  });

  it("accepts only UTC timestamps and plain ids", () => {
    expect(validate(s.dateTime(), "2026-11-10T19:57:06.000Z")).toEqual([]);
    expect(validate(s.dateTime(), "2026-11-10T19:57:06+01:00")).toHaveLength(1);
    expect(validate(s.dateTime(), "2026-13-45T99:00:00.000Z")).toHaveLength(1);
    expect(validate(s.id(), "a b")).toHaveLength(1);
    expect(validate(s.id(), "x".repeat(65))).toHaveLength(1);
  });

  it("picks union variants by their discriminator", () => {
    const shape = s.union("op", [
      s.object({ op: s.literal("put"), value: s.integer(0, 1) }),
      s.object({ op: s.literal("delete") }),
    ]);
    expect(validate(shape, { op: "delete" })).toEqual([]);
    expect(validate(shape, { op: "delete", value: 1 })).toHaveLength(1);
    expect(validate(shape, { op: "move" })).toHaveLength(1);
  });
});

describe("schema edge cases found in review", () => {
  it("rejects inherited property names as unknown fields", () => {
    const shape = s.object({ a: s.integer(0, 1) });
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(validate(shape, { a: 0, [key]: 1 })).toEqual([
        { path: `$.${key}`, message: "unknown field" },
      ]);
    }
    expect(validate(shape, JSON.parse('{"a":0,"__proto__":1}'))).toEqual([
      { path: "$.__proto__", message: "unknown field" },
    ]);
  });

  it("rejects dates that don't exist on the calendar", () => {
    expect(validate(s.dateTime(), "2026-02-30T00:00:00.000Z")).toHaveLength(1);
    expect(validate(s.dateTime(), "2026-02-28T23:59:59.999Z")).toEqual([]);
  });

  it("accepts one spelling per instant: exactly three fraction digits", () => {
    expect(validate(s.dateTime(), "2026-11-10T19:57:06.500Z")).toEqual([]);
    for (const other of [
      "2026-11-10T19:57:06Z",
      "2026-11-10T19:57:06.5Z",
      "2026-11-10T19:57:06.5000Z",
    ]) {
      expect(validate(s.dateTime(), other), other).toHaveLength(1);
    }
  });
});
