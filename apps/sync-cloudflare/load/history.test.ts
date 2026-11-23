import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDeviceStore } from "@leve/storage";
import { createNodeSqliteEngine } from "@leve/storage/node";
import { afterAll, describe, expect, it } from "vitest";
import { history } from "./history.ts";

// The load tests are only meaningful if the made-up history is data a phone accepts, so every
// record goes through real phone storage here.

const dir = mkdtempSync(join(tmpdir(), "leve-history-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("load test history", () => {
  it("is valid phone data, four sessions and one bodyweight entry a week", async () => {
    const records = history("t", 2, Date.parse("2026-11-20T00:00:00Z"));
    expect(records.filter((r) => r.kind === "workout")).toHaveLength(8);
    expect(records.filter((r) => r.kind === "body_measurement")).toHaveLength(2);
    expect(records.filter((r) => r.kind === "workout_set")).toHaveLength(8 * 19);

    const store = await openDeviceStore({
      engine: createNodeSqliteEngine(),
      path: join(dir, "phone.db"),
      appVersion: "test",
    });
    store.putMany(records);
    expect(store.summary().pending).toBe(records.length);
    expect(store.problems()).toEqual([]);
    store.close();
  });
});
