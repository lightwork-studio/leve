import { describe, expect, it } from "vitest";
import {
  type ContractDefinition,
  createContract,
  jsonBytes,
  leveContract,
  MAX_RECORD_BYTES,
  negotiate,
  s,
} from "../src/index.ts";

const base = {
  releases: ["1.0", "1.1"],
  kinds: {
    workout: {
      since: "1.0",
      fields: {
        title: { schema: s.string({ maxLength: 10 }), since: "1.0", required: true },
        effort: { schema: s.nullable(s.integer(1, 10)), since: "1.1" },
      },
    },
  },
  features: {
    effort: { since: "1.1", description: "Effort", fields: [["workout", "effort"]] },
  },
} as const satisfies ContractDefinition;

describe("contract definitions", () => {
  it("refuses a required field in a minor release", () => {
    const fields = {
      ...base.kinds.workout.fields,
      effort: { schema: s.integer(1, 10), since: "1.1", required: true },
    };
    const broken = {
      ...base,
      kinds: { workout: { since: "1.0", fields } },
    } as unknown as ContractDefinition;
    expect(() => createContract(broken)).toThrow(/minor release must be optional/);
  });

  it("refuses a kind below an existing kind in a minor release", () => {
    const broken = {
      ...base,
      kinds: {
        ...base.kinds,
        lap: {
          since: "1.1",
          parent: { kind: "workout", field: "workoutId" },
          fields: {
            workoutId: { schema: s.string({ maxLength: 64 }), since: "1.1", required: true },
          },
        },
      },
    } as unknown as ContractDefinition;
    expect(() => createContract(broken)).toThrow(/needs a major release/);
    // Without a parent, a new kind is an ordinary minor addition.
    const { parent: _parent, ...lap } = broken.kinds.lap as { parent: unknown };
    expect(() =>
      createContract({
        ...broken,
        kinds: { ...broken.kinds, lap },
      } as unknown as ContractDefinition),
    ).not.toThrow();
  });

  it("refuses an optional field that is not nullable", () => {
    const broken = {
      ...base,
      kinds: {
        workout: {
          since: "1.0",
          fields: { note: { schema: s.string({ maxLength: 3 }), since: "1.0" } },
        },
      },
      features: {},
    } as unknown as ContractDefinition;
    expect(() => createContract(broken)).toThrow(/must be nullable/);
  });

  it("refuses a feature whose fields are newer than the feature", () => {
    const broken = {
      ...base,
      features: { effort: { since: "1.0", description: "", fields: [["workout", "effort"]] } },
    } as unknown as ContractDefinition;
    expect(() => createContract(broken)).toThrow(/missing in 1.0/);
  });

  const contract = createContract(base);

  it("encodes exactly the release's fields and reports values it had to leave out", () => {
    expect(contract.encode("workout", { title: "A", effort: 7 }, "1.0")).toEqual({
      content: { title: "A" },
      omitted: ["effort"],
      issues: [],
    });
    expect(contract.encode("workout", { title: "A", effort: null }, "1.0").omitted).toEqual([]);
    expect(contract.encode("workout", { title: "A" }, "1.1").content).toEqual({
      title: "A",
      effort: null,
    });
  });

  it("requires every release field on the wire and rejects newer ones", () => {
    expect(contract.decode("workout", { title: "A" }, "1.1")).toHaveLength(1);
    expect(contract.decode("workout", { title: "A", effort: 3 }, "1.0")[0]?.message).toBe(
      "unknown field",
    );
  });

  it("keeps stored values of fields the sender's release doesn't define", () => {
    const stored = { title: "Old", effort: 8 };
    expect(contract.applyOmissionRule("workout", stored, { title: "New" }, "1.0")).toEqual({
      title: "New",
      effort: 8,
    });
    expect(
      contract.applyOmissionRule("workout", stored, { title: "New", effort: null }, "1.1"),
    ).toEqual({ title: "New", effort: null });
  });

  it("makes features available from their release", () => {
    expect(contract.featureAvailable("effort", "1.0")).toBe(false);
    expect(contract.featureAvailable("effort", "1.1")).toBe(true);
    expect(contract.features("1.0")).toEqual([]);
  });
});

describe("negotiation", () => {
  it("picks the highest common release", () => {
    expect(negotiate(["1.0", "1.1", "2.0"], ["1.0", "1.1"])).toEqual({ ok: true, release: "1.1" });
  });

  it("says which side is behind", () => {
    expect(negotiate(["2.0"], ["1.0", "1.1"])).toMatchObject({ ok: false, update: "server" });
    expect(negotiate(["1.0"], ["2.0"])).toMatchObject({ ok: false, update: "client" });
    expect(negotiate(["garbage"], ["1.0"])).toMatchObject({ ok: false, update: "client" });
  });
});

describe("Leve's contract", () => {
  it("names each child's parent", () => {
    expect(leveContract.childKinds("workout")).toEqual([
      { kind: "workout_rest", field: "workoutId" },
      { kind: "workout_note", field: "workoutId" },
      { kind: "workout_exercise", field: "workoutId" },
    ]);
    expect(leveContract.parentOf("workout_set", { workoutExerciseId: "e1" })).toEqual({
      kind: "workout_exercise",
      id: "e1",
    });
  });

  it("normalizes missing optional fields to null", () => {
    const normalized = leveContract.normalize("workout", {
      title: "A",
      description: "",
      startedAt: "2026-11-10T10:00:00.000Z",
    });
    expect(normalized).toMatchObject({ endedAt: null, routineId: null });
    expect(leveContract.validateContent("workout", normalized)).toEqual([]);
  });
});

describe("record size", () => {
  const note = (text: string, index: number) => ({
    id: `n${index}`,
    text,
    createdAt: "2026-11-10T10:00:00.000Z",
  });
  const entry = (notes: unknown[]) => ({
    workoutId: "w1",
    exerciseId: "bench",
    exerciseName: "Bench",
    exerciseType: "weight_reps",
    position: 1,
    supersetId: null,
    restSeconds: 90,
    notes,
    doubleDumbbellVolume: false,
  });

  it("counts UTF-8 bytes of the JSON text", () => {
    expect(jsonBytes({ a: "é" })).toBe(10);
    expect(jsonBytes("😀")).toBe(6);
  });

  it("rejects a record over the limit even when every field is within its own limit", () => {
    // 100 notes of 10,000 two-byte characters: each note is valid, the record is ~2 MB.
    const huge = entry(Array.from({ length: 100 }, (_, i) => note("é".repeat(10_000), i)));
    expect(jsonBytes(huge)).toBeGreaterThan(MAX_RECORD_BYTES);
    const message = `record larger than ${MAX_RECORD_BYTES} bytes`;
    expect(leveContract.decode("workout_exercise", huge, "1.0")).toContainEqual({
      path: "$",
      message,
    });
    expect(leveContract.validateContent("workout_exercise", huge)).toContainEqual({
      path: "$",
      message,
    });
    const fits = entry(Array.from({ length: 9 }, (_, i) => note("é".repeat(10_000), i)));
    expect(leveContract.decode("workout_exercise", fits, "1.0")).toEqual([]);
  });
});
