import { expect, it } from "vitest";
import {
  dayLabel,
  distanceInput,
  distanceLabel,
  minutesLabel,
  minutesParts,
  readoutMinutes,
  readoutWeight,
  relativeDayLabel,
  timeLabel,
  workoutEffort,
  workoutMinutesLabel,
} from "../src/ui/format.ts";

it('names a workout\'s length, with under a minute as "<1 min"', () => {
  expect(workoutMinutesLabel(0)).toBe("<1 min");
  expect(workoutMinutesLabel(1)).toBe("1 min");
  expect(workoutMinutesLabel(75)).toBe("1 h 15 min");
  // Totals (a week's minutes) keep "0 min".
  expect(minutesLabel(0)).toBe("0 min");
});

it("splits a length into large numbers and small units", () => {
  expect(minutesParts(0)).toEqual([["0", "min"]]);
  expect(minutesParts(42)).toEqual([["42", "min"]]);
  expect(minutesParts(60)).toEqual([["1", "h"]]);
  expect(minutesParts(64)).toEqual([
    ["1", "h"],
    ["4", "min"],
  ]);
  expect(minutesParts(135)).toEqual([
    ["2", "h"],
    ["15", "min"],
  ]);
});

it("writes clock times without a leading zero on the hour", () => {
  // Some ICU versions put a narrow no-break space before AM/PM.
  const time = (iso: string, locale: string) => timeLabel(iso, locale).replace(/\s/g, " ");
  const evening = new Date(2026, 10, 12, 18, 5).toISOString();
  const morning = new Date(2026, 10, 12, 7, 30).toISOString();
  expect(time(evening, "en-US")).toBe("6:05 PM");
  expect(time(morning, "en-US")).toBe("7:30 AM");
  expect(time(evening, "de-DE")).toBe("18:05");
});

it("calls today and yesterday by name, other days by date", () => {
  const today = new Date(2027, 0, 1, 9).getTime();
  const at = (y: number, m: number, d: number, h = 18) => new Date(y, m, d, h).toISOString();
  expect(relativeDayLabel(at(2027, 0, 1), today)).toBe("Today");
  // The day before, across the year's end.
  expect(relativeDayLabel(at(2026, 11, 31, 23), today)).toBe("Yesterday");
  expect(relativeDayLabel(at(2026, 11, 30), today)).toBe(
    dayLabel(at(2026, 11, 30), undefined, today),
  );
});

it("applies independent short and long distance settings at the 1,000 metre boundary", () => {
  const mixed = { shortDistanceUnit: "yd", distanceUnit: "km" } as const;
  expect(distanceLabel(914.4, mixed, "en-US")).toBe("1,000 yd");
  expect(distanceLabel(1000, mixed, "en-US")).toBe("1 km");
  expect(distanceLabel(1609.34, { ...mixed, distanceUnit: "miles" }, "en-US")).toBe("1 mi");
  expect(distanceInput(11.43, "yd")).toBe("12.5");
});

it("shows recorded time for a timed session and weight for a loaded session", () => {
  expect(workoutEffort({ missingTimedSets: 0, volumeKg: 0, recordedSeconds: 45 }, "lbs")).toEqual({
    label: "Logged time",
    amount: "0:45",
    unit: "",
  });
  expect(workoutEffort({ missingTimedSets: 0, volumeKg: 100, recordedSeconds: 45 }, "lbs")).toEqual(
    {
      label: "Volume",
      amount: "220",
      unit: "lbs",
    },
  );
  expect(workoutEffort({ missingTimedSets: 0, volumeKg: 0, recordedSeconds: null }, "kg")).toEqual({
    label: "Volume",
    amount: "0",
    unit: "kg",
  });
});

it("keeps a readout's time and volume short", () => {
  expect(readoutMinutes(0)).toEqual({ value: "0", unit: "min" });
  expect(readoutMinutes(0.4)).toEqual({ value: "<1", unit: "min" });
  expect(readoutMinutes(59)).toEqual({ value: "59", unit: "min" });
  expect(readoutMinutes(72)).toEqual({ value: "1:12", unit: "h" });
  expect(readoutMinutes(125)).toEqual({ value: "2:05", unit: "h" });
  expect(readoutWeight(9999.4, "kg", "en")).toBe("9,999");
  // Thousands are cut, never rounded up: 12,480 kg reads 12.4k.
  expect(readoutWeight(12_480, "kg", "en")).toBe("12.4k");
  // 10,000 lb is about 4,536 kg.
  expect(readoutWeight(4536, "lbs", "en")).toBe("10k");
});
