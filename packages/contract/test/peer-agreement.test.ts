import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leveContract, type ReleaseId, validate } from "../src/index.ts";

// The archived peer validates with its own interpreter of the frozen description. Both must agree,
// otherwise the frozen description doesn't say what the runtime enforces.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releases = readdirSync(join(root, "history")) as ReleaseId[];

const dates = [
  "2026-11-10T19:57:06.000Z",
  "2026-11-10T19:57:06Z",
  "2026-11-10T19:57+01:00",
  "2026-11-10 19:57:06Z",
  "Tue Nov 10 2026 19:5",
  "2026-02-30T00:00:00.000Z",
  "2026-13-01T00:00:00.000Z",
  "2026-11-10T24:00:00.000Z",
];
const measurement = (overrides: Record<string, unknown>) => ({
  takenAt: "2026-11-10T19:57:06.000Z",
  bodyweightKg: 80,
  fatPercent: null,
  ...overrides,
});
const cases: [string, Record<string, unknown>][] = [
  ...dates.map((takenAt): [string, Record<string, unknown>] => [takenAt, measurement({ takenAt })]),
  ["zero", measurement({ bodyweightKg: 0 })],
  ["too heavy", measurement({ bodyweightKg: 2000.5 })],
  ["missing nullable", { takenAt: "2026-11-10T19:57:06.000Z", bodyweightKg: 1 }],
  ["constructor", measurement({ constructor: 1 })],
  ["__proto__", { ...measurement({}), ...JSON.parse('{"__proto__":1}') }],
  ["extra", measurement({ waistCm: 80 })],
];

describe.each(releases)("archived peer %s agrees with the runtime", async (release) => {
  const peer = await import(join(root, "history", release, "peer.ts"));
  const frozen = peer.loadContract(new URL(`../history/${release}/`, import.meta.url));
  it.each(cases)("%s", (_name, content) => {
    const runtime = validate(leveContract.wireSchema("body_measurement", release), content);
    const archived = peer.check(frozen.kinds.body_measurement.content, content);
    expect(archived.length === 0).toBe(runtime.length === 0);
  });
});
