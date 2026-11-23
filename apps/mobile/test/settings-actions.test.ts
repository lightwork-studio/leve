import { type JsonObject, LEVE_CONTRACT_DEFINITION } from "@leve/contract";
import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { EXERCISES } from "../src/data/exercises.ts";
import { historyData, liveData, readSettings, trainData } from "../src/data/read.ts";
import { seedSyntheticData } from "../src/data/seed.ts";
import {
  choiceLabel,
  DISTANCE_CHOICES,
  MEASUREMENT_CHOICES,
  PREVIOUS_CHOICES,
  REST_CHOICES,
  restLabel,
  SettingsError,
  SHORT_DISTANCE_CHOICES,
  saveSettings,
  settingsContent,
  startAgain,
  stepChoice,
  WEEKDAY_CHOICES,
  WEIGHT_CHOICES,
} from "../src/data/settings-actions.ts";
import {
  addExercise,
  addSet,
  beginWorkout,
  logSet,
  updateSet,
} from "../src/data/workout-actions.ts";

const SQL = await initSqlJs();
let n = 0;
const open = () =>
  openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/settings-${n++}.db`,
    appVersion: "test",
  });

const stored = (store: Awaited<ReturnType<typeof open>>) =>
  store.get("settings", "settings")?.content;

describe("settingsContent", () => {
  it("fills what isn't stored from the defaults, then applies the change", () => {
    expect(settingsContent(null, { countWarmups: false })).toEqual({
      weightUnit: "kg",
      distanceUnit: "km",
      shortDistanceUnit: "m",
      measurementUnit: "cm",
      firstWeekday: 1,
      defaultRestSeconds: 0,
      rpeEnabled: false,
      countWarmups: false,
      previousValues: "any_workout",
      autoUpdateRoutineValues: true,
    });
  });

  it("keeps stored values the change doesn't touch", () => {
    expect(
      settingsContent(
        { weightUnit: "lbs", firstWeekday: 0, defaultRestSeconds: 90 },
        {
          defaultRestSeconds: 45,
        },
      ),
    ).toEqual({
      weightUnit: "lbs",
      distanceUnit: "km",
      shortDistanceUnit: "m",
      measurementUnit: "cm",
      firstWeekday: 0,
      defaultRestSeconds: 45,
      rpeEnabled: false,
      countWarmups: true,
      previousValues: "any_workout",
      autoUpdateRoutineValues: true,
    });
  });

  it("fills a required field missing from a stored copy with its default", () => {
    const { weightUnit: _left, ...withoutWeight } = settingsContent(null, { weightUnit: "lbs" });
    expect(settingsContent(withoutWeight, {})).toMatchObject({ weightUnit: "kg" });
  });

  // A copy saved before tracking reps in reserve existed lacks it because it was left out. Filling
  // in "off" would write a value nobody chose, over one another device may have set.
  it("never fills in tracking reps in reserve, and keeps what is stored", () => {
    const fields = LEVE_CONTRACT_DEFINITION.kinds.settings.fields;
    expect(fields.trackRepsInReserve).toEqual({ since: "1.0", schema: expect.anything() });
    expect(settingsContent(null, {})).not.toHaveProperty("trackRepsInReserve");
    const older = settingsContent(null, { countWarmups: false }) as unknown as JsonObject;
    expect(settingsContent(older, { weightUnit: "lbs" })).not.toHaveProperty("trackRepsInReserve");
    expect(settingsContent({ ...older, trackRepsInReserve: true }, { weightUnit: "lbs" })).toEqual(
      expect.objectContaining({ trackRepsInReserve: true, weightUnit: "lbs" }),
    );
    expect(
      settingsContent({ ...older, trackRepsInReserve: true }, { trackRepsInReserve: false }),
    ).toEqual(expect.objectContaining({ trackRepsInReserve: false }));
  });
});

describe("tracking reps in reserve", () => {
  const BEFORE_THE_SETTING = {
    weightUnit: "lbs",
    distanceUnit: "km",
    shortDistanceUnit: "m",
    measurementUnit: "cm",
    firstWeekday: 1,
    defaultRestSeconds: 90,
    rpeEnabled: false,
    countWarmups: false,
    previousValues: "any_workout",
    autoUpdateRoutineValues: true,
  };

  /** A store whose settings copy was saved by a build from before the setting existed. */
  async function olderCopy() {
    const engine = createSqlJsEngine(SQL);
    const path = `/settings-older-${n++}.db`;
    const first = await openDeviceStore({ engine, path, appVersion: "test" });
    first.put("settings", "settings", BEFORE_THE_SETTING);
    first.close();
    const db = engine.open(path);
    db.run(
      "UPDATE records SET local_content = json_remove(local_content, '$.trackRepsInReserve') WHERE kind = 'settings'",
    );
    db.close();
    return openDeviceStore({ engine, path, appVersion: "test" });
  }

  it("is off until turned on", async () => {
    const store = await open();
    expect(readSettings(store).trackRepsInReserve).toBe(false);
    saveSettings(store, { weightUnit: "lbs" });
    expect(stored(store)?.trackRepsInReserve).toBeNull();
    expect(readSettings(store).trackRepsInReserve).toBe(false);
    saveSettings(store, { trackRepsInReserve: true });
    expect(readSettings(store).trackRepsInReserve).toBe(true);
    saveSettings(store, { countWarmups: true });
    expect(readSettings(store).trackRepsInReserve).toBe(true);
    saveSettings(store, { trackRepsInReserve: false });
    expect(stored(store)?.trackRepsInReserve).toBe(false);
    expect(readSettings(store).trackRepsInReserve).toBe(false);
    store.close();
  });

  it("reads a copy saved before the setting existed as off, and can still change it", async () => {
    const store = await olderCopy();
    expect(stored(store)).toEqual(BEFORE_THE_SETTING);
    expect(readSettings(store)).toMatchObject({ weightUnit: "lbs", trackRepsInReserve: false });
    saveSettings(store, { countWarmups: true });
    expect(stored(store)).toEqual({
      ...BEFORE_THE_SETTING,
      countWarmups: true,
      trackRepsInReserve: null,
    });
    expect(readSettings(store).trackRepsInReserve).toBe(false);
    saveSettings(store, { trackRepsInReserve: true });
    expect(readSettings(store).trackRepsInReserve).toBe(true);
    store.close();
  });

  it("refuses anything but on or off, leaving the record as it was", async () => {
    const store = await open();
    saveSettings(store, { trackRepsInReserve: true });
    const before = stored(store);
    for (const value of ["yes", 1, 0, {}]) {
      expect(() => saveSettings(store, { trackRepsInReserve: value as never })).toThrow(
        /trackRepsInReserve/,
      );
    }
    expect(stored(store)).toEqual(before);
    store.close();
  });
});

describe("startAgain", () => {
  it("says nothing once fresh data is open", async () => {
    expect(await startAgain(async () => true)).toBeNull();
  });

  it("says so when fresh data didn't open", async () => {
    expect(await startAgain(async () => false)).toBe("Leve couldn't start again.");
  });

  it("turns a failure into a message instead of a rejection", async () => {
    expect(
      await startAgain(async () => {
        throw new Error("disk full");
      }),
    ).toBe("Leve couldn't start again (disk full).");
  });
});

describe("saveSettings", () => {
  it("writes a whole record when none is stored yet", async () => {
    const store = await open();
    expect(stored(store)).toBeUndefined();
    saveSettings(store, { weightUnit: "lbs" });
    expect(stored(store)).toEqual({
      weightUnit: "lbs",
      distanceUnit: "km",
      shortDistanceUnit: "m",
      measurementUnit: "cm",
      firstWeekday: 1,
      defaultRestSeconds: 0,
      rpeEnabled: false,
      countWarmups: true,
      previousValues: "any_workout",
      autoUpdateRoutineValues: true,
      trackRepsInReserve: null,
    });
    store.close();
  });

  it("keeps every other stored setting, including ones the screen doesn't show", async () => {
    const store = await open();
    store.put("settings", "settings", {
      weightUnit: "lbs",
      distanceUnit: "miles",
      shortDistanceUnit: "yd",
      measurementUnit: "in",
      firstWeekday: 6,
      defaultRestSeconds: 75,
      rpeEnabled: true,
      countWarmups: false,
      previousValues: "same_routine",
      autoUpdateRoutineValues: false,
    });
    saveSettings(store, { previousValues: "any_workout" });
    saveSettings(store, { countWarmups: true });
    expect(stored(store)).toEqual({
      weightUnit: "lbs",
      distanceUnit: "miles",
      shortDistanceUnit: "yd",
      measurementUnit: "in",
      firstWeekday: 6,
      defaultRestSeconds: 75,
      rpeEnabled: true,
      countWarmups: true,
      previousValues: "any_workout",
      autoUpdateRoutineValues: false,
      trackRepsInReserve: null,
    });
    store.close();
  });

  it("refuses an invalid value with a message, leaving the record as it was", async () => {
    const store = await open();
    saveSettings(store, { defaultRestSeconds: 120 });
    const before = stored(store);
    expect(() => saveSettings(store, { defaultRestSeconds: 5000 })).toThrow(SettingsError);
    expect(() => saveSettings(store, { defaultRestSeconds: 5000 })).toThrow(/defaultRestSeconds/);
    expect(() => saveSettings(store, { firstWeekday: 7 as never })).toThrow(/firstWeekday/);
    expect(() => saveSettings(store, { weightUnit: "stone" as never })).toThrow(/weightUnit/);
    // A device-only preference never goes into the synced record.
    expect(() => saveSettings(store, { keepScreenAwake: true } as never)).toThrow(SettingsError);
    expect(stored(store)).toEqual(before);
    expect(stored(store)?.defaultRestSeconds).toBe(120);
    store.close();
  });
});

describe("choices", () => {
  it("steps the default rest through the offered times, and from an unlisted one to its neighbours", () => {
    expect(stepChoice(REST_CHOICES, 0, 1)).toBe(30);
    expect(stepChoice(REST_CHOICES, 0, -1)).toBeNull();
    expect(stepChoice(REST_CHOICES, 120, -1)).toBe(90);
    expect(stepChoice(REST_CHOICES, 300, 1)).toBeNull();
    // 100 s isn't offered: it steps to the nearest offered time on each side.
    expect(stepChoice(REST_CHOICES, 100, 1)).toBe(120);
    expect(stepChoice(REST_CHOICES, 100, -1)).toBe(90);
    expect(stepChoice(REST_CHOICES, 900, -1)).toBe(300);
  });

  it("offers the agreed rest times, each stored in seconds", async () => {
    expect(REST_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["Off", 0],
      ["30 s", 30],
      ["45 s", 45],
      ["1 min", 60],
      ["1 min 30 s", 90],
      ["2 min", 120],
      ["2 min 30 s", 150],
      ["3 min", 180],
      ["4 min", 240],
      ["5 min", 300],
    ]);
    const store = await open();
    for (const [choice, seconds] of [
      [REST_CHOICES[0], 0],
      [REST_CHOICES[4], 90],
      [REST_CHOICES[9], 300],
    ] as const) {
      saveSettings(store, { defaultRestSeconds: choice?.value as number });
      expect(stored(store)?.defaultRestSeconds).toBe(seconds);
    }
    store.close();
  });

  it("maps previous values, weight units and weekdays to their stored values", async () => {
    expect(PREVIOUS_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["Any workout", "any_workout"],
      ["Same routine", "same_routine"],
    ]);
    expect(WEIGHT_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["kg", "kg"],
      ["lbs", "lbs"],
    ]);
    expect(WEEKDAY_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["Monday", 1],
      ["Tuesday", 2],
      ["Wednesday", 3],
      ["Thursday", 4],
      ["Friday", 5],
      ["Saturday", 6],
      ["Sunday", 0],
    ]);
    expect(DISTANCE_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["km", "km"],
      ["miles", "miles"],
    ]);
    expect(SHORT_DISTANCE_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["m", "m"],
      ["yd", "yd"],
    ]);
    expect(MEASUREMENT_CHOICES.map((c) => [c.label, c.value])).toEqual([
      ["cm", "cm"],
      ["in", "in"],
    ]);
    // Every offered value is one the record accepts.
    const store = await open();
    for (const c of PREVIOUS_CHOICES) saveSettings(store, { previousValues: c.value });
    for (const c of WEIGHT_CHOICES) saveSettings(store, { weightUnit: c.value });
    for (const c of WEEKDAY_CHOICES) saveSettings(store, { firstWeekday: c.value });
    for (const c of REST_CHOICES) saveSettings(store, { defaultRestSeconds: c.value });
    for (const c of DISTANCE_CHOICES) saveSettings(store, { distanceUnit: c.value });
    for (const c of SHORT_DISTANCE_CHOICES) saveSettings(store, { shortDistanceUnit: c.value });
    for (const c of MEASUREMENT_CHOICES) saveSettings(store, { measurementUnit: c.value });
    expect(stored(store)).toMatchObject({
      previousValues: "same_routine",
      weightUnit: "lbs",
      distanceUnit: "miles",
      shortDistanceUnit: "yd",
      measurementUnit: "in",
      firstWeekday: 0,
      defaultRestSeconds: 300,
    });
    store.close();
  });

  it("labels the current value, including a rest time that isn't offered", () => {
    expect(choiceLabel(WEEKDAY_CHOICES, 0)).toBe("Sunday");
    expect(choiceLabel(PREVIOUS_CHOICES, "same_routine")).toBe("Same routine");
    expect(restLabel(0)).toBe("Off");
    expect(restLabel(90)).toBe("1 min 30 s");
    expect(restLabel(100)).toBe("1 min 40 s");
    expect(restLabel(20)).toBe("20 s");
    expect(restLabel(600)).toBe("10 min");
  });
});

it("changes what the screens read", { timeout: 60_000 }, async () => {
  const store = await open();
  const now = new Date(2026, 10, 12, 20); // Thursday 12 November 2026
  seedSyntheticData(store, now);
  expect(trainData(store, now.getTime()).week.days.map((d) => d.letter)).toEqual([
    "M",
    "T",
    "W",
    "T",
    "F",
    "S",
    "S",
  ]);
  saveSettings(store, { firstWeekday: 0 });
  expect(trainData(store, now.getTime()).week.days.map((d) => d.name)).toEqual([
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]);

  saveSettings(store, { weightUnit: "lbs", defaultRestSeconds: 150 });
  expect(readSettings(store)).toMatchObject({ weightUnit: "lbs", defaultRestSeconds: 150 });
  expect(historyData(store).settings.weightUnit).toBe("lbs");
  store.close();
});

it("counts warm-ups in a workout's totals only while the setting is on", {
  timeout: 60_000,
}, async () => {
  const store = await open();
  saveSettings(store, { countWarmups: true, defaultRestSeconds: 45 });
  const id = beginWorkout(store);
  addExercise(store, id, EXERCISES.curl, readSettings(store).defaultRestSeconds);
  addSet(store, liveData(store)?.tree.entries[0]?.entry.id as string);
  const entry = liveData(store)?.tree.entries[0];
  expect(entry?.entry.content.restSeconds).toBe(45);
  const [warmup, work] = entry?.sets ?? [];
  if (!warmup || !work) throw new Error("expected two sets");
  updateSet(store, warmup.id, { type: "warmup" });
  logSet(store, warmup.id, { weightKg: 10, reps: 10 });
  logSet(store, work.id, { weightKg: 20, reps: 5 });
  // 10 × 10 + 20 × 5
  expect(liveData(store)?.summary).toMatchObject({ sets: 2, volumeKg: 200 });
  saveSettings(store, { countWarmups: false });
  expect(liveData(store)?.summary).toMatchObject({ sets: 1, volumeKg: 100 });
  store.close();
});
