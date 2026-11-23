import type { DistanceUnit, LengthUnit, ShortDistanceUnit, WeightUnit } from "./units.ts";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface UserSettings {
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit;
  shortDistanceUnit: ShortDistanceUnit;
  measurementUnit: LengthUnit;
  firstWeekday: Weekday;
  /** Default rest timer in seconds, 0 = off. */
  defaultRestSeconds: number;
  rpeEnabled: boolean;
  /** Whether warm-up sets count toward volume, set counts and records. */
  countWarmups: boolean;
  /** Where "previous" values come from while logging. */
  previousValues: "any_workout" | "same_routine";
  /** After a routine-based workout, copy the logged values back into the routine. */
  autoUpdateRoutineValues: boolean;
  /**
   * Ask for reps in reserve after each logged set. Off unless the lifter turns it on; a synced
   * settings record without a value reads as off.
   */
  trackRepsInReserve: boolean;
  keepScreenAwake: boolean;
}

export const defaultSettings = (imperial = false): UserSettings => ({
  weightUnit: imperial ? "lbs" : "kg",
  distanceUnit: imperial ? "miles" : "km",
  shortDistanceUnit: imperial ? "yd" : "m",
  measurementUnit: imperial ? "in" : "cm",
  firstWeekday: 1,
  defaultRestSeconds: 0,
  rpeEnabled: false,
  countWarmups: true,
  previousValues: "any_workout",
  autoUpdateRoutineValues: true,
  trackRepsInReserve: false,
  keepScreenAwake: false,
});
