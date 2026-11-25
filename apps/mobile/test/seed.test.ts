import { openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import initSqlJs from "sql.js";
import { expect, it } from "vitest";
import { firstStart, seedSyntheticData } from "../src/data/seed.ts";
import { saveSettings } from "../src/data/settings-actions.ts";

const SQL = await initSqlJs();
const open = () =>
  openDeviceStore({ engine: createSqlJsEngine(SQL), path: "/seed.db", appVersion: "test" });
const summary = (store: Awaited<ReturnType<typeof open>>) =>
  store.db
    .all("SELECT kind, count(*) AS n FROM records GROUP BY kind ORDER BY kind")
    .map((row) => `${row.kind}:${row.n}`);

// A Thursday evening (local time): this week's Monday and Wednesday sessions have happened,
// Friday's hasn't.
const NOW = new Date(2026, 10, 12, 20, 0);

it("seeds valid records, the same way every time", { timeout: 90_000 }, async () => {
  const first = await open();
  seedSyntheticData(first, NOW);
  const second = await open();
  // A development build's first start seeds the same data.
  expect(firstStart(second, true, NOW)).toBe(true);
  expect(summary(first)).toEqual([
    "body_measurement:13",
    "exercise_note:3",
    "exercise_note_comment:1",
    "routine:5",
    "routine_folder:2",
    "settings:1",
    "workout:40",
    "workout_exercise:176",
    "workout_note:2",
    "workout_note_comment:1",
    "workout_set:565",
  ]);
  expect(summary(second)).toEqual(summary(first));
  first.close();
  second.close();
});

it("never dates anything after the moment it seeds", { timeout: 180_000 }, async () => {
  for (const now of [
    new Date(2026, 10, 9, 0, 30), // Monday just after midnight
    new Date(2026, 10, 9, 18, 20), // Monday, during the first session
    new Date(2026, 10, 15, 23, 59), // Sunday night
    new Date(2026, 2, 30, 12, 0), // the Monday after daylight saving starts in Europe
  ]) {
    const store = await open();
    seedSyntheticData(store, now);
    for (const row of store.db.all("SELECT kind, local_content FROM records")) {
      const content = JSON.parse(String(row.local_content)) as Record<string, unknown>;
      for (const field of ["startedAt", "endedAt", "takenAt", "completedAt", "createdAt"]) {
        if (typeof content[field] === "string") {
          expect(
            Date.parse(content[field] as string),
            `${row.kind}.${field} at ${now}`,
          ).toBeLessThanOrEqual(now.getTime());
        }
      }
      if (row.kind === "workout") expect(content.endedAt).not.toBeNull();
    }
    expect(store.get("settings", "settings")).not.toBeNull();
    store.close();
  }
});

it("leaves a new install empty when the build has no sample data", async () => {
  const store = await open();
  expect(firstStart(store, false, NOW)).toBe(false);
  expect(summary(store)).toEqual([]);
});

it("never seeds over a workout logged without ever opening Settings", async () => {
  const store = await open();
  store.put("workout", "real", {
    title: "Real session",
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    routineId: null,
  });
  expect(firstStart(store, true, NOW)).toBe(false);
  expect(summary(store)).toEqual(["workout:1"]);
});

it("never seeds over a store that has been set up, whatever the build", async () => {
  const store = await open();
  saveSettings(store, {});
  expect(firstStart(store, true, NOW)).toBe(false);
  expect(firstStart(store, false, NOW)).toBe(false);
  expect(summary(store)).toEqual(["settings:1"]);
});

it("never seeds a phone tied to an account, even an empty one", async () => {
  // The sample data would sync into the account without asking.
  const store = await open();
  store.bindAccount("https://sync.test", "user_1");
  expect(firstStart(store, true, NOW)).toBe(false);
  expect(summary(store)).toEqual([]);
});
