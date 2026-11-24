import { expect, it, vi } from "vitest";
import { openEngine } from "../src/data/engine.web.ts";

vi.mock("../src/build-info.ts", () => ({ buildInfo: { webDemo: true } }));
vi.mock("../src/data/web-sql.ts", async () => {
  const { default: initSqlJs } = await import("sql.js");
  return { loadWebSql: () => initSqlJs() };
});
vi.mock("../src/data/browser-files.ts", () => ({
  claimBrowserData: () => {
    throw new Error("The demo tried to claim persistent storage");
  },
  loadBrowserFiles: () => {
    throw new Error("The demo tried to load persistent data");
  },
}));

it("reopens only the current demo's edits and starts a fresh database for the next demo", async () => {
  const path = "/demo.db";
  const demo = await openEngine();
  const connection = demo.engine.open(path);
  connection.exec("CREATE TABLE workouts (name TEXT); INSERT INTO workouts VALUES ('Demo edit');");
  connection.close();
  await demo.flush();

  const reopened = demo.engine.open(path);
  expect(reopened.all("SELECT name FROM workouts")).toEqual([{ name: "Demo edit" }]);
  reopened.close();
  expect(demo.paths()).toEqual([path]);

  const nextDemo = await openEngine();
  expect(nextDemo.paths()).toEqual([]);
  expect(nextDemo.engine.exists(path)).toBe(false);
  expect(demo.engine.exists(path)).toBe(true);
});
