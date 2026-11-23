import { type JsonObject, leveContract } from "@leve/contract";
import { defaultSettings, type UserSettings } from "@leve/core";
import type { DeviceStore } from "@leve/storage";

// Changes to the settings record. The record is always saved whole: what is stored, or core's
// defaults where a required field is missing, with the change on top, checked against the contract
// before writing.

/** Settings fields the record may lack; null or a missing value means not set. */
type OptionalSettings = "trackRepsInReserve";

/**
 * The settings record's content. Keeping the screen awake is a device-only preference. Tracking
 * reps in reserve arrived after the record's other fields, so it is optional: a copy saved before
 * it existed lacks it, and that reads as off.
 */
export type StoredSettings = Omit<UserSettings, "keepScreenAwake" | OptionalSettings> & {
  [K in OptionalSettings]?: UserSettings[K] | null;
};

/** A change the screen couldn't save, with a message to show. */
export class SettingsError extends Error {
  override name = "SettingsError";
}

const settingsFields = leveContract.kind("settings").fields;

/**
 * The full content to store: the defaults for the required fields, then what is stored, then the
 * change.
 *
 * A stored copy can lack a required field only if it was never written, so the default fills it.
 * An optional field missing from a stored copy was left out, not set to its default: the copy may
 * have been saved before the field existed (see "Protocol releases" in
 * docs/data-compatibility.md). It stays out, and the store saves it as not set (null) rather than
 * as an "off" the lifter never chose. Another device's value is protected by the revision check:
 * an upload based on an outdated copy is rejected instead of replacing it.
 */
export function settingsContent(
  stored: JsonObject | null | undefined,
  change: Partial<StoredSettings>,
): StoredSettings {
  const { keepScreenAwake: _deviceOnly, ...defaults } = defaultSettings();
  const required = Object.fromEntries(
    Object.entries(defaults).filter(([name]) => settingsFields[name]?.required === true),
  ) as Omit<StoredSettings, OptionalSettings>;
  return { ...required, ...(stored as Partial<StoredSettings> | null | undefined), ...change };
}

/** Saves a change to the settings, or throws a SettingsError without writing anything. */
export function saveSettings(store: DeviceStore, change: Partial<StoredSettings>): StoredSettings {
  const stored = store.get("settings", "settings");
  const content = settingsContent(stored?.deleted ? null : stored?.content, change);
  const issues = leveContract.validateContent(
    "settings",
    leveContract.normalize("settings", content as unknown as JsonObject),
  );
  if (issues.length > 0) {
    throw new SettingsError(
      `This setting couldn't be saved (${issues.map((i) => `${i.path} ${i.message}`).join("; ")}).`,
    );
  }
  store.put("settings", "settings", content as unknown as JsonObject);
  return content;
}

/**
 * Deletes this device's data and starts again. Resolves to null once fresh data is open, or to a message
 * saying it didn't work: never a rejection nobody sees.
 */
export async function startAgain(reset: () => Promise<boolean>): Promise<string | null> {
  try {
    if (await reset()) return null;
    return "Leve couldn't start again.";
  } catch (error) {
    return `Leve couldn't start again (${(error as Error).message}).`;
  }
}

export interface Choice<V> {
  value: V;
  label: string;
}

/** The interval stored on a routine or workout exercise. Zero disables its timer. */
export function parseRestSeconds(text: string): number | null {
  const value = text.trim();
  const seconds = Number(value);
  return /^\d+$/.test(value) && seconds <= 3600 ? seconds : null;
}

/** The rest times offered as the default for new exercise entries. */
export const REST_CHOICES: Choice<number>[] = [
  { value: 0, label: "Off" },
  { value: 30, label: "30 s" },
  { value: 45, label: "45 s" },
  { value: 60, label: "1 min" },
  { value: 90, label: "1 min 30 s" },
  { value: 120, label: "2 min" },
  { value: 150, label: "2 min 30 s" },
  { value: 180, label: "3 min" },
  { value: 240, label: "4 min" },
  { value: 300, label: "5 min" },
];

export const PREVIOUS_CHOICES: Choice<StoredSettings["previousValues"]>[] = [
  { value: "any_workout", label: "Any workout" },
  { value: "same_routine", label: "Same routine" },
];

export const WEIGHT_CHOICES: Choice<StoredSettings["weightUnit"]>[] = [
  { value: "kg", label: "kg" },
  { value: "lbs", label: "lbs" },
];

export const DISTANCE_CHOICES: Choice<StoredSettings["distanceUnit"]>[] = [
  { value: "km", label: "km" },
  { value: "miles", label: "miles" },
];

export const SHORT_DISTANCE_CHOICES: Choice<StoredSettings["shortDistanceUnit"]>[] = [
  { value: "m", label: "m" },
  { value: "yd", label: "yd" },
];

export const MEASUREMENT_CHOICES: Choice<StoredSettings["measurementUnit"]>[] = [
  { value: "cm", label: "cm" },
  { value: "in", label: "in" },
];

export const WEEKDAY_CHOICES: Choice<StoredSettings["firstWeekday"]>[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

/** What a row shows for its current value. */
export function choiceLabel<V>(choices: Choice<V>[], value: V): string {
  return choices.find((choice) => choice.value === value)?.label ?? String(value);
}

/** The default rest time as shown, including one not in the list (from an import, say). */
export function restLabel(seconds: number): string {
  const listed = REST_CHOICES.find((choice) => choice.value === seconds);
  if (listed) return listed.label;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The next choice up or down from a value, for stepping through a list: from a value that isn't
 * listed (from an import, say), the nearest listed one beyond it. Null at either end.
 */
export function stepChoice<V extends number>(
  choices: readonly Choice<V>[],
  value: number,
  direction: -1 | 1,
): V | null {
  const values = choices.map((choice) => choice.value);
  const found =
    direction > 0 ? values.find((v) => v > value) : [...values].reverse().find((v) => v < value);
  return found ?? null;
}
