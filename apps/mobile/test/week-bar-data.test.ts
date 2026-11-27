import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it } from "vitest";
import { lastTime, progressData, weekBarData } from "../src/data/read.ts";
import { seedSyntheticData } from "../src/data/seed.ts";
import { recordsByWorkout } from "../src/model/progress.ts";
import type { Workout } from "../src/model/types.ts";
import { monogram } from "../src/model/week-bar.ts";

const SQL = await initSqlJs();
let n = 0;
const open = () =>
  openDeviceStore({
    engine: createSqlJsEngine(SQL),
    path: `/week-bar-${n++}.db`,
    appVersion: "test",
  });

it("reads each day's volume against the routine's last session, and its records", {
  timeout: 60_000,
}, async () => {
  const store = await open();
  const now = new Date(2026, 10, 12, 20); // Thursday 12 November 2026
  seedSyntheticData(store, now);
  const { index } = progressData(store);
  const held = recordsByWorkout(index);
  const bar = weekBarData(store, now.getTime(), held);
  const shown = bar.days.flatMap((day) => day.workouts);
  // The seed trains this week, from routines done before, and sets records along the way.
  expect(shown.length).toBeGreaterThan(1);
  expect(shown.some((w) => w.lastVolumeKg !== null)).toBe(true);
  expect(shown.some((w) => w.records > 0)).toBe(true);
  for (const w of shown) {
    // The last session is the one the saved workout's own comparison uses.
    expect(w.lastVolumeKg).toBe(lastTime(store, w.id)?.volumeKg ?? null);
    expect(w.records).toBe(held.get(w.id)?.length ?? 0);
  }
  // Without the index read yet, the bar shows no records rather than waiting for it.
  expect(
    weekBarData(store, now.getTime(), null).days.flatMap((d) => d.workouts.map((w) => w.records)),
  ).toEqual(shown.map(() => 0));

  // Push day keeps PD, so Pull day, trained later, moves on to PU.
  const pull = shown.find((w) => w.title === "Pull day");
  expect(pull?.monogram).toBe("PU");
  // Once its routine is deleted, its workouts are named from their own titles, clash or not.
  const routineId = (store.get("workout", pull?.id ?? "")?.content as Workout | null)?.routineId;
  store.delete("routine", routineId as string);
  const after = weekBarData(store, now.getTime(), held)
    .days.flatMap((day) => day.workouts)
    .find((w) => w.id === pull?.id);
  expect(after?.monogram).toBe(monogram("Pull day"));
  expect(after?.monogram).toBe("PD");
  store.close();
});
