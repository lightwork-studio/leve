import { expect, it, vi } from "vitest";
import { measurementClock } from "../src/model/measurement-clock.ts";

it("resolves both Lord Howe offsets using zone data and rejects the skipped half-hour", () => {
  // Hermes may assume a full hour of daylight saving in its Date local getters.
  const localOffset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-600);
  try {
    const clock = measurementClock("Australia/Lord_Howe");
    expect(clock.choices("2026-04-05", "01:45")).toEqual([
      { at: Date.parse("2026-04-04T14:45:00Z"), offset: "UTC+11:00" },
      { at: Date.parse("2026-04-04T15:15:00Z"), offset: "UTC+10:30" },
    ]);
    expect(clock.choices("2026-10-04", "02:15")).toEqual([]);
    expect(clock.choices("2026-10-04", "02:30")).toEqual([
      { at: Date.parse("2026-10-03T15:30:00Z"), offset: "UTC+11:00" },
    ]);
    expect(clock.repeatedOffset(Date.parse("2026-04-04T15:15:37.123Z"))).toBe("UTC+10:30");
    expect(clock.repeatedOffset(Date.parse("2026-10-03T15:30:00Z"))).toBeNull();
  } finally {
    localOffset.mockRestore();
  }
});

it("rejects impossible dates and handles a skipped date in the Pacific", () => {
  const clock = measurementClock("Pacific/Apia");
  expect(clock.choices("2026-02-30", "07:00")).toEqual([]);
  expect(clock.choices("2011-12-30", "12:00")).toEqual([]);
  expect(clock.localTimestamp(Date.parse("2011-12-30T10:00:00Z"))).toBe("2011-12-31T00:00:00");
});

it("distinguishes both sides of a clock rollback beginning partway through a minute", () => {
  const clock = measurementClock("America/Managua");
  expect(clock.repeatedOffset(Date.parse("1934-06-23T05:30:42Z"))).toBe("UTC-05:45:12");
  expect(clock.repeatedOffset(Date.parse("1934-06-23T05:45:30Z"))).toBe("UTC-06:00");
  // The first 12 seconds occur once, but the history row displays only the minute.
  expect(clock.repeatedOffset(Date.parse("1934-06-23T05:30:14Z"))).toBe("UTC-05:45:12");
});
