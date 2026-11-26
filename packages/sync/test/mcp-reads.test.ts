import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Submission } from "@leve/contract";
import { ServerStorage } from "@leve/storage/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { type Principal, SCOPES, SyncService } from "../src/server/index.ts";
import { createMcpEndpoint } from "../src/server/mcp/index.ts";
import { engine } from "./support/harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent = (account: string, scopes: string[] = [SCOPES.read]): Principal => ({
  account,
  client: { kind: "agent", id: "https://client.test/meta.json", name: "Coach" },
  scopes,
});

let submissions = 0;
/** Writes records the way a phone's upload does: through the service's one write path. */
async function write(
  service: SyncService,
  account: string,
  records: [string, string, JsonObject][],
) {
  const list: Submission[] = records.map(([kind, id, content]) => ({
    op: "put",
    submissionId: `sub-${++submissions}`,
    kind,
    id,
    baseRevision: null,
    content,
  }));
  const results = await service.submit(account, "1.0", list);
  for (const result of results) expect(result.status, JSON.stringify(result)).toBe("accepted");
}

const workout = (title: string, startedAt: string, endedAt: string | null): JsonObject => ({
  title,
  startedAt,
  endedAt,
  routineId: null,
  initialPlan: null,
});
const entry = (
  workoutId: string,
  exerciseId: string,
  exerciseName: string,
  exerciseType = "weight_reps",
): JsonObject => ({
  workoutId,
  exerciseId,
  exerciseName,
  exerciseType,
  position: 1,
  supersetId: null,
  restSeconds: 120,
  doubleDumbbellVolume: false,
});
const set = (
  workoutExerciseId: string,
  position: number,
  values: JsonObject,
  completedAt: string | null = "2026-11-02T18:10:00.000Z",
): JsonObject => ({
  workoutExerciseId,
  position,
  type: "normal",
  weightKg: null,
  reps: null,
  distanceMeters: null,
  durationSeconds: null,
  count: null,
  rpe: null,
  completedAt,
  repsInReserve: null,
  planSlot: null,
  ...values,
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "leve-mcp-"));
  dirs.push(dir);
  const storage = new ServerStorage({ engine, directory: dir, appVersion: "mcp-test" });
  const service = new SyncService({ storage });
  const endpoint = createMcpEndpoint({ service, version: "test" });

  await write(service, "alice", [
    [
      "settings",
      "settings",
      {
        weightUnit: "kg",
        distanceUnit: "km",
        shortDistanceUnit: "m",
        measurementUnit: "cm",
        firstWeekday: 1,
        defaultRestSeconds: 120,
        rpeEnabled: false,
        countWarmups: false,
        previousValues: "any_workout",
        autoUpdateRoutineValues: true,
        trackRepsInReserve: false,
      },
    ],
    [
      "body_measurement",
      "bm1",
      { takenAt: "2026-11-01T07:00:00.000Z", bodyweightKg: 80, fatPercent: null },
    ],
    ["workout", "w1", workout("Push", "2026-11-02T18:00:00.000Z", "2026-11-02T19:00:00.000Z")],
    ["workout_exercise", "w1e1", entry("w1", "builtin:barbell-bench-press", "Bench Press")],
    ["workout_set", "w1s0", set("w1e1", 0, { type: "warmup", weightKg: 40, reps: 10 })],
    ["workout_set", "w1s1", set("w1e1", 1, { weightKg: 80, reps: 5 })],
    ["workout_set", "w1s2", set("w1e1", 2, { weightKg: 80, reps: 5 })],
    [
      "workout_note",
      "n1",
      {
        workoutId: "w1",
        pinned: false,
        text: "Shoulder felt tight",
        createdAt: "2026-11-02T19:00:00.000Z",
        agent: null,
      },
    ],
    [
      "workout_note_comment",
      "c1",
      {
        noteId: "n1",
        text: "Warm up longer next time",
        createdAt: "2026-11-02T20:00:00.000Z",
        agent: "Coach",
      },
    ],
    ["workout", "w2", workout("Pull", "2026-11-05T18:00:00.000Z", "2026-11-05T18:45:00.000Z")],
    ["workout_exercise", "w2e1", entry("w2", "builtin:pull-up", "Pull-up", "bodyweight_reps")],
    ["workout_set", "w2s1", set("w2e1", 1, { reps: 8 })],
    ["workout_exercise", "w2e2", entry("w2", "builtin:barbell-bench-press", "Bench Press")],
    ["workout_set", "w2s2", set("w2e2", 1, { weightKg: 85, reps: 2 })],
    ["workout", "w3", workout("Legs", "2026-11-08T18:00:00.000Z", null)],
    ["workout_exercise", "w3e1", entry("w3", "builtin:back-squat", "Squat")],
    ["workout_set", "w3s1", set("w3e1", 1, { weightKg: 100, reps: 5 }, null)],
    ["routine_folder", "f1", { title: "Strength", position: 1 }],
    [
      "routine",
      "r1",
      {
        title: "Push A",
        folderId: "f1",
        position: 1,
        effortScale: null,
        exercises: [
          {
            id: "re1",
            exerciseId: "builtin:barbell-bench-press",
            exerciseName: "Bench Press",
            exerciseType: "weight_reps",
            supersetId: null,
            restSeconds: 120,
            useRepRange: false,
            sets: [
              {
                id: "rs1",
                type: "normal",
                weightKg: 80,
                reps: 5,
                repRangeMin: null,
                repRangeMax: null,
                distanceMeters: null,
                durationSeconds: null,
                count: null,
                rpe: null,
                repsInReserve: null,
              },
            ],
          },
        ],
      },
    ],
    [
      "exercise_note",
      "en1",
      {
        exerciseId: "builtin:barbell-bench-press",
        workoutId: "w1",
        pinned: true,
        text: "Elbows in",
        createdAt: "2026-11-02T18:30:00.000Z",
        agent: null,
      },
    ],
  ]);
  await write(service, "bob", [
    [
      "workout",
      "bob-w1",
      workout("Bob's secret session", "2026-11-03T08:00:00.000Z", "2026-11-03T09:00:00.000Z"),
    ],
    ["workout_exercise", "bob-e1", entry("bob-w1", "builtin:deadlift", "Deadlift")],
    ["workout_set", "bob-s1", set("bob-e1", 1, { weightKg: 250, reps: 1 })],
  ]);

  /** A real MCP client, connected over Streamable HTTP to the endpoint signed in as `principal`. */
  const connect = async (principal: Principal) => {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://leve.test/mcp"), {
      fetch: (input, init) => endpoint(new Request(input, init), principal),
    });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: { text: string }[];
      };
    };
    return { client, call };
  };
  return { service, endpoint, connect };
}

describe("MCP reads", () => {
  it("lists the read tools, each marked read-only", async () => {
    const { connect } = await setup();
    const { client } = await connect(agent("alice"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_exercise_history",
      "get_progress",
      "get_routine",
      "get_settings",
      "get_workout",
      "list_body_measurements",
      "list_exercise_notes",
      "list_exercises",
      "list_routines",
      "list_workouts",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
  });

  it("lists workouts newest first with the app's figures, and pages", async () => {
    const { connect, service } = await setup();
    await write(service, "alice", [
      ["workout", "w2b", workout("Other session", "2026-11-05T18:00:00.000Z", null)],
    ]);
    const { call } = await connect(agent("alice"));
    const first = (await call("list_workouts", { limit: 2 })).structuredContent as {
      workouts: Record<string, unknown>[];
      nextCursor: { startedAt: string; id: string } | null;
    };
    expect(first.workouts.map((w) => [w.id, w.inProgress])).toEqual([
      ["w3", true],
      ["w2", false],
    ]);
    // Pull-ups count the 80 kg bodyweight: 8 × 80 = 640, plus bench 85 × 2 = 170.
    expect(first.workouts[1]).toMatchObject({ volumeKg: 810, sets: 2, reps: 10, minutes: 45 });
    expect(first.nextCursor).toEqual({ startedAt: "2026-11-05T18:00:00.000Z", id: "w2" });
    const second = (await call("list_workouts", { cursor: first.nextCursor }))
      .structuredContent as {
      workouts: Record<string, unknown>[];
      nextCursor: unknown;
    };
    // The warm-up doesn't count: countWarmups is off.
    expect(second.workouts).toMatchObject([
      { id: "w2b" },
      { id: "w1", volumeKg: 800, sets: 2, reps: 10 },
    ]);
    expect(second.nextCursor).toBeNull();
    const ranged = (
      await call("list_workouts", {
        from: "2026-11-04T00:00:00.000Z",
        to: "2026-11-06T00:00:00.000Z",
      })
    ).structuredContent as { workouts: { id: string }[] };
    expect(ranged.workouts.map((w) => w.id)).toEqual(["w2", "w2b"]);
  });

  it("shows a workout in full, with the revisions to write against", async () => {
    const { connect, service } = await setup();
    const { call } = await connect(agent("alice"));
    const result = (await call("get_workout", { id: "w1" })).structuredContent as {
      workout: { id: string; revision: number; title: string };
      exercises: { id: string; revision: number; sets: { id: string; revision: number }[] }[];
      notes: { text: string; comments: { text: string; agent: string }[] }[];
      exerciseNotes: { text: string }[];
    };
    const stored = await service.read("alice", "workout", "w1", "1.0");
    expect(result.workout).toMatchObject({ id: "w1", title: "Push", revision: stored?.revision });
    expect(result.exercises[0]?.sets.map((s) => s.id)).toEqual(["w1s0", "w1s1", "w1s2"]);
    for (const s of result.exercises[0]?.sets ?? []) expect(s.revision).toBeGreaterThan(0);
    expect(result.notes).toMatchObject([
      {
        text: "Shoulder felt tight",
        comments: [{ text: "Warm up longer next time", agent: "Coach" }],
      },
    ]);
    expect(result.exerciseNotes).toMatchObject([{ text: "Elbows in" }]);
    const missing = await call("get_workout", { id: "nope" });
    expect(missing.isError).toBe(true);
  });

  it("gives exercise history, records and progress from finished workouts only", async () => {
    const { connect } = await setup();
    const { call } = await connect(agent("alice"));
    const exercises = (await call("list_exercises")).structuredContent as {
      exercises: { exerciseId: string; sessions: number }[];
    };
    // The squat is only in the workout still in progress.
    expect(exercises.exercises.map((e) => [e.exerciseId, e.sessions])).toEqual([
      ["builtin:barbell-bench-press", 2],
      ["builtin:pull-up", 1],
    ]);
    const history = (
      await call("get_exercise_history", {
        exerciseId: "builtin:barbell-bench-press",
      })
    ).structuredContent as {
      sessions: { workoutId: string; best: Record<string, number> }[];
      records: { metric: string; workoutId: string }[];
    };
    expect(history.sessions.map((s) => s.workoutId)).toEqual(["w2", "w1"]);
    expect(history.sessions[1]?.best.oneRepMaxKg).toBeCloseTo(93.33, 2);
    expect(history.records).toContainEqual(
      expect.objectContaining({ metric: "oneRepMax", workoutId: "w1" }),
    );
    expect(history.records).toContainEqual(
      expect.objectContaining({ metric: "heaviest", workoutId: "w2" }),
    );

    const progress = (await call("get_progress", { from: "2026-11-01T00:00:00.000Z" }))
      .structuredContent as {
      totals: Record<string, number>;
      weeks: Record<string, unknown>[];
      exercises: { exerciseId: string; sessions: { workoutId: string }[] }[];
    };
    expect(progress.totals).toEqual({
      workouts: 2,
      minutes: 105,
      volumeKg: 1610,
      sets: 4,
      reps: 20,
    });
    expect(progress.weeks).toEqual([{ weekStart: "2026-11-02", ...progress.totals }]);
    expect(progress.exercises[0]).toMatchObject({
      exerciseId: "builtin:barbell-bench-press",
      sessions: [{ workoutId: "w1" }, { workoutId: "w2" }],
    });
  });

  it("reads routines, notes, measurements and settings", async () => {
    const { connect } = await setup();
    const { call } = await connect(agent("alice"));
    const routines = (await call("list_routines")).structuredContent as {
      folders: { id: string }[];
      routines: { id: string; exercises: { name: string; sets: number }[] }[];
    };
    expect(routines.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(routines.routines).toMatchObject([
      { id: "r1", exercises: [{ name: "Bench Press", sets: 1 }] },
    ]);
    const routine = (await call("get_routine", { id: "r1" })).structuredContent as {
      routine: { title: string };
    };
    expect(routine.routine.title).toBe("Push A");
    const notes = (await call("list_exercise_notes", { pinnedOnly: true })).structuredContent as {
      notes: { id: string }[];
    };
    expect(notes.notes.map((n) => n.id)).toEqual(["en1"]);
    const measurements = (await call("list_body_measurements")).structuredContent as {
      measurements: { bodyweightKg: number }[];
    };
    expect(measurements.measurements).toMatchObject([{ bodyweightKg: 80 }]);
    const settings = (await call("get_settings")).structuredContent as {
      settings: { countWarmups: boolean };
    };
    expect(settings.settings.countWarmups).toBe(false);
  });
});

describe("MCP access is one account's", () => {
  it("never shows another account's records, whatever the arguments name", async () => {
    const { connect } = await setup();
    const { call } = await connect(agent("alice"));
    const listed = JSON.stringify((await call("list_workouts", { limit: 100 })).structuredContent);
    expect(listed).not.toContain("bob");
    expect(listed).not.toContain("Deadlift");
    // Bob's workout id, asked for directly, doesn't exist for Alice.
    const direct = await call("get_workout", { id: "bob-w1" });
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct)).not.toContain("secret");
    const history = await call("get_exercise_history", { exerciseId: "builtin:deadlift" });
    expect(history.isError).toBe(true);

    const bob = await connect(agent("bob"));
    const bobs = (await bob.call("list_workouts")).structuredContent as {
      workouts: { id: string }[];
    };
    expect(bobs.workouts.map((w) => w.id)).toEqual(["bob-w1"]);
  });

  it("answers 2026-07-28 requests too, for the signed-in account only", async () => {
    const { endpoint } = await setup();
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "modern", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const call = async (principal: Principal, name: string, args: Record<string, unknown>) => {
      const response = await endpoint(
        new Request("https://leve.test/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": name,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args, _meta: meta },
          }),
        }),
        principal,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: { isError?: boolean; structuredContent: unknown };
      };
    };
    const alice = await call(agent("alice"), "get_workout", { id: "w1" });
    expect(alice.result.structuredContent).toMatchObject({ workout: { id: "w1" } });
    const across = await call(agent("alice"), "get_workout", { id: "bob-w1" });
    expect(across.result.isError).toBe(true);
    const bob = await call(agent("bob"), "get_workout", { id: "bob-w1" });
    expect(bob.result.structuredContent).toMatchObject({ workout: { id: "bob-w1" } });
  });

  it("refuses a principal without read access before any tool runs", async () => {
    const { endpoint } = await setup();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const request = () =>
      new Request("https://leve.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body,
      });
    expect((await endpoint(request(), agent("alice", []))).status).toBe(403);
    expect((await endpoint(request(), agent("alice", ["profile"]))).status).toBe(403);
    const write = await endpoint(request(), agent("alice", [SCOPES.write]));
    expect(write.status).toBe(200);
  });

  it("reaches a new account without creating anything another account can see", async () => {
    const { connect } = await setup();
    const { call } = await connect(agent("carol"));
    const workouts = (await call("list_workouts")).structuredContent as { workouts: unknown[] };
    expect(workouts.workouts).toEqual([]);
  });
});
