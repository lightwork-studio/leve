import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_RELEASES, type ReleaseId, SERVER_RELEASES } from "@leve/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as PeerModule from "../../contract/history/1.0/peer.ts";
import { previewFrozen } from "../../contract/test/support/preview-contract.ts";
import { bodyMeasurement, ENDED, entry, HISTORY, set, workout } from "./support/content.ts";
import { expectSynced, type ServerHarness, World } from "./support/harness.ts";

/*
 * The compatibility matrix, derived from the supported-release registry: every server
 * configuration this build can run, against every archived historical peer, on real SQLite.
 * Every reply is checked by the peer against its frozen copy of the release.
 */

type Json = Record<string, unknown>;
type Peer = PeerModule.HistoricalPeer;

const historyDir = fileURLToPath(HISTORY);
const archived = readdirSync(historyDir)
  .filter((name) => existsSync(new URL(`${name}/peer.ts`, HISTORY)))
  .sort();
const registry = JSON.parse(
  readFileSync(new URL("../../contract/frozen/registry.json", import.meta.url), "utf8"),
) as { releases: { release: string }[] };

/** Independent release ordering for the expected update_required side. */
const newer = (a: string, b: string) => {
  const [am = 0, an = 0] = a.split(".").map(Number);
  const [bm = 0, bn = 0] = b.split(".").map(Number);
  return am > bm || (am === bm && an > bn);
};

/** Features each release provides, written out per release. A new release must add its row. */
const EXPECTED_FEATURES: Record<string, string[]> = {
  "1.0": [
    "body_measurements",
    "custom_exercises",
    "reps_in_reserve",
    "routines",
    "rpe",
    "track_reps_in_reserve",
    "workout_journal",
    "workout_rest",
    "workouts",
  ],
};

const serverConfigs: (readonly ReleaseId[])[] = [
  SERVER_RELEASES,
  ...SERVER_RELEASES.filter(() => SERVER_RELEASES.length > 1).map((r) => [r]),
];

interface MatrixCase {
  server: readonly ReleaseId[];
  peer: string;
  expect: "works" | "update_required";
}
const cases: MatrixCase[] = serverConfigs.flatMap((server) =>
  [...archived, "1.1", "1.2", "2.0"].map((peer) => ({
    server,
    peer,
    expect: server.includes(peer as ReleaseId) ? "works" : "update_required",
  })),
);

async function loadPeer(release: string) {
  if (archived.includes(release)) {
    const module = (await import(new URL(`${release}/peer.ts`, HISTORY).href)) as typeof PeerModule;
    return { module, contract: module.loadContract(new URL(`${release}/`, HISTORY)) };
  }
  const module = await import("../../contract/history/1.0/peer.ts");
  return { module, contract: previewFrozen(release as ReleaseId) };
}

let world: World;
beforeEach(() => {
  world = new World();
});
afterEach(async () => {
  await world.dispose();
});

describe("registry coverage", () => {
  it("has an archived peer and matrix coverage for every advertised release", () => {
    const advertised = [...new Set([...SERVER_RELEASES, ...CLIENT_RELEASES])];
    expect(advertised).toEqual(["1.0"]);
    expect(archived).toEqual(["1.0"]);
    expect(registry.releases.map(({ release }) => release)).toEqual(["1.0"]);
    for (const release of advertised) {
      expect(archived, `archived peer for ${release}`).toContain(release);
      expect(
        cases.some((c) => c.peer === release && c.expect === "works"),
        `matrix case for ${release}`,
      ).toBe(true);
      expect(EXPECTED_FEATURES[release], `expected features for ${release}`).toBeDefined();
    }
    for (const { release } of registry.releases) {
      expect(archived, `every frozen release ${release} is archived`).toContain(release);
    }
  });
});

describe.each(cases)("server $server × archived peer $peer", (matrixCase) => {
  let server: ServerHarness;
  let module: typeof PeerModule;
  let frozen: PeerModule.FrozenContract;
  let ids = 0;
  const peer = (name = "p"): Peer => {
    const instance = new module.HistoricalPeer(frozen, server.transport("alice"));
    instance.newSubmissionId = () => `${name}-${++ids}`;
    return instance;
  };
  /** A peer that has connected (hello) and so knows the account's lineage. */
  const connected = async (name = "p"): Promise<Peer> => {
    const instance = peer(name);
    await instance.hello();
    return instance;
  };
  /** Fills nullable fields a later release added, from the peer's own frozen description. */
  const full = (kind: string, content: Json): Json => {
    const properties = frozen.kinds[kind]?.content.properties as Record<string, unknown>;
    const filled: Json = { ...content };
    for (const field of Object.keys(properties)) if (!(field in filled)) filled[field] = null;
    return filled;
  };
  const valid = (description: unknown, value: unknown) =>
    expect(module.check(description, value)).toEqual([]);

  beforeEach(async () => {
    ({ module, contract: frozen } = await loadPeer(matrixCase.peer));
    server = world.server({ releases: matrixCase.server });
  });

  if (matrixCase.expect === "update_required") {
    it("answers update_required, naming the side that is behind", async () => {
      const p = peer();
      const reply = await p.hello();
      const behind = matrixCase.server.every((r) => newer(matrixCase.peer, r))
        ? "server"
        : "client";
      expect(reply).toEqual({
        error: {
          code: "update_required",
          message: expect.any(String),
          update: behind,
          serverReleases: [...matrixCase.server],
        },
      });
      const push = await p.call("/sync/push", { release: p.release, submissions: [] });
      expect(push.body).toMatchObject({ error: { code: "unsupported_release" } });
    });
    return;
  }

  const W = "w-1";
  const E = "e-1";
  const S1 = "s-1";
  const S2 = "s-2";
  const contents = (): [string, string, Json][] => [
    [
      "workout",
      W,
      workout("Legs", {
        endedAt: ENDED,
        description: "Heavy",
        initialPlan: { title: "Legs", effortScale: "rpe", exercises: [] },
      }),
    ],
    [
      "workout_exercise",
      E,
      entry(W, "Squat (Barbell)", {
        position: -1e15,
        supersetId: 0,
        restSeconds: 0,
        notes: [{ id: "n1", text: "", createdAt: ENDED }],
      }),
    ],
    ["workout_set", S1, set(E, { weightKg: 0, reps: 0, rpe: null, completedAt: null })],
    [
      "workout_set",
      S2,
      set(E, {
        position: 1e15,
        type: "warmup",
        weightKg: 102.25,
        reps: 10_000,
        distanceMeters: 0.001,
        durationSeconds: 59.9,
        count: 0,
        rpe: 7.5,
        completedAt: "2026-11-10T18:59:59.999Z",
      }),
    ],
    ["body_measurement", "m-1", bodyMeasurement(null)],
    ["routine_folder", "f-1", { title: "Strength", position: 0 }],
    [
      "custom_exercise",
      "c-1",
      {
        name: "Sled Push",
        type: "weight_distance",
        primaryMuscle: "quadriceps",
        secondaryMuscles: [],
        equipment: "other",
        usesBodyweight: false,
        archived: false,
      },
    ],
    [
      "routine",
      "r-1",
      {
        title: "Upper A",
        effortScale: "rir",
        notes: "",
        folderId: "f-1",
        position: 1,
        exercises: [
          {
            id: "re-1",
            exerciseId: "bench-press-barbell",
            exerciseName: "Bench Press (Barbell)",
            exerciseType: "weight_reps",
            supersetId: null,
            restSeconds: 120,
            notes: [],
            useRepRange: false,
            sets: [
              {
                id: "rs-1",
                type: "normal",
                weightKg: 0,
                reps: null,
                repRangeMin: 8,
                repRangeMax: 10,
                distanceMeters: null,
                durationSeconds: null,
                count: null,
                rpe: null,
                repsInReserve: 0,
              },
            ],
          },
        ],
      },
    ],
    [
      "settings",
      "settings",
      {
        weightUnit: "lbs",
        distanceUnit: "miles",
        shortDistanceUnit: "yd",
        measurementUnit: "in",
        firstWeekday: 0,
        defaultRestSeconds: 0,
        rpeEnabled: false,
        countWarmups: false,
        previousValues: "same_routine",
        autoUpdateRoutineValues: false,
      },
    ],
  ];

  async function created() {
    const writer = peer("writer");
    const hello = await writer.hello();
    expect(hello).toEqual({
      release: matrixCase.peer,
      features: EXPECTED_FEATURES[matrixCase.peer],
      revision: 0,
      lineage: expect.stringMatching(/^[A-Za-z0-9._:-]{1,64}$/),
      restoredFrom: null,
    });
    const submissions = contents().map(([kind, id, content]) =>
      writer.put(kind, id, full(kind, content)),
    );
    const reply = (await writer.push(submissions)) as { results: Json[] };
    expect(reply.results.map((r) => [r.status, r.revision])).toEqual(
      submissions.map((_, i) => ["accepted", i + 1]),
    );
    return { writer, submissions };
  }

  it("creates and reads every kind with zero, false, null, boundaries and precision intact", async () => {
    await created();
    const reader = await connected("reader");
    const changes = await reader.pull(3);
    expect(changes).toEqual(
      contents().map(([kind, id, content], i) => ({
        state: "live",
        kind,
        id,
        revision: i + 1,
        content: full(kind, content),
      })),
    );
    expect(reader.cursor).toBe(9);
    // The MCP read path answers the same copy.
    const read = await server.service.read(
      "alice",
      "workout_set",
      S1,
      matrixCase.peer as ReleaseId,
    );
    valid(frozen.messages.pullResponse.properties.changes.of, read);
    expect(read).toEqual({
      state: "live",
      kind: "workout_set",
      id: S1,
      revision: 3,
      content: full("workout_set", set(E, { weightKg: 0, reps: 0 })),
    });
  });

  it("updates with null clearing a value and a missing field rejected", async () => {
    const { writer } = await created();
    const update = writer.put(
      "workout_set",
      S2,
      full("workout_set", set(E, { position: 2, weightKg: null, reps: 8, rpe: 9.5, count: null })),
    );
    expect(await writer.push([update])).toEqual({
      release: matrixCase.peer,
      results: [{ status: "accepted", submissionId: update.submissionId, revision: 10 }],
    });
    const reader = await connected("reader");
    await reader.pull();
    expect(reader.records.get(`workout_set/${S2}`)?.content).toEqual(
      full("workout_set", set(E, { position: 2, weightKg: null, reps: 8, rpe: 9.5 })),
    );

    // A field the release defines must be present; leaving it out is invalid, never "keep".
    const missing = { ...(update.content as Json) };
    delete missing.rpe;
    const reply = (await writer.push([
      { ...update, submissionId: "missing-1", baseRevision: 10, content: missing },
    ])) as { results: Json[] };
    expect(reply.results).toEqual([
      {
        status: "invalid",
        submissionId: "missing-1",
        code: "invalid_content",
        message: expect.stringContaining("rpe"),
      },
    ]);
    expect((await server.row("alice", "workout_set", S2))?.revision).toBe(10);
  });

  it("rejects unknown fields, bad enums, out-of-range and malformed values without storing them", async () => {
    await created();
    const writer = await connected("writer2");
    await writer.pull();
    const base = (await server.row("alice", "workout_set", S1))?.revision ?? -1;
    const good = full("workout_set", set(E, { weightKg: 0, reps: 0 }));
    const before = await server.row("alice", "workout_set", S1);
    const bad: [string, Json][] = [
      ["unknown field", { ...good, effortRating: 5 }],
      ["unknown enum value", { ...good, type: "cluster" }],
      ["rpe off the scale", { ...good, rpe: 6.5 }],
      ["weight above maximum", { ...good, weightKg: 2000.5 }],
      ["negative weight", { ...good, weightKg: -1 }],
      ["fractional reps", { ...good, reps: 1.5 }],
      ["reps above maximum", { ...good, reps: 10_001 }],
      ["number as string", { ...good, reps: "5" }],
      ["local date-time", { ...good, completedAt: "2026-11-10 18:00:00" }],
      ["missing required", { ...good, workoutExerciseId: undefined }],
    ];
    const submissions = bad.map(([label], i) => ({
      op: "put",
      submissionId: `bad-${i}`,
      kind: "workout_set",
      id: S1,
      baseRevision: base,
      content: JSON.parse(JSON.stringify(bad[i]?.[1])),
      label,
    }));
    const reply = (await writer.push(submissions.map(({ label: _, ...s }) => s))) as {
      results: Json[];
    };
    reply.results.forEach((result, i) => {
      expect(result, bad[i]?.[0]).toMatchObject({ status: "invalid", code: "invalid_content" });
    });
    expect(await server.row("alice", "workout_set", S1)).toEqual(before);
    expect(await server.receipts("alice")).toHaveLength(9);

    // Boundaries that are allowed.
    const edge = writer.put(
      "workout_set",
      S1,
      full("workout_set", set(E, { weightKg: 2000, reps: 10_000, rpe: 10, position: -1e15 })),
    );
    expect(await writer.push([edge])).toMatchObject({
      results: [{ status: "accepted", revision: 10 }],
    });
    const title = "x".repeat(100);
    expect(
      await writer.push([writer.put("workout", W, full("workout", workout(title)))]),
    ).toMatchObject({ results: [{ status: "accepted" }] });
    expect(
      (await writer.push([
        {
          ...writer.put("workout", W, full("workout", workout(title))),
          content: workout(`${title}x`),
        },
      ])) as Json,
    ).toMatchObject({ results: [{ status: "invalid", code: "invalid_content" }] });
  });

  it("answers a stale writer with a conflict carrying the current copy", async () => {
    await created();
    const stale = await connected("stale");
    await stale.pull();
    const fresh = await connected("fresh");
    await fresh.pull();
    await fresh.push([fresh.put("workout", W, full("workout", workout("Fresh")))]);
    const reply = (await stale.push([
      stale.put("workout", W, full("workout", workout("Stale"))),
    ])) as { results: Json[] };
    expect(reply.results).toEqual([
      {
        status: "conflict",
        submissionId: expect.any(String),
        reason: "stale",
        current: {
          state: "live",
          kind: "workout",
          id: W,
          revision: 10,
          content: full("workout", workout("Fresh")),
        },
      },
    ]);
    expect(stale.records.get(`workout/${W}`)?.revision).toBe(10);
    const create = {
      ...stale.put("workout", W, full("workout", workout("again"))),
      baseRevision: null,
    };
    expect(await stale.push([create])).toMatchObject({
      results: [{ status: "conflict", reason: "exists" }],
    });
  });

  it("deletes a workout with its children and keeps content-free markers", async () => {
    const { writer } = await created();
    const reader = await connected("reader");
    await reader.pull();
    const del = writer.delete("workout", W);
    expect(await writer.push([del])).toEqual({
      release: matrixCase.peer,
      results: [{ status: "accepted", submissionId: del.submissionId, revision: 13 }],
    });
    const changes = await reader.pull();
    expect(changes).toEqual([
      { state: "deleted", kind: "workout_set", id: S1, revision: 10 },
      { state: "deleted", kind: "workout_set", id: S2, revision: 11 },
      { state: "deleted", kind: "workout_exercise", id: E, revision: 12 },
      { state: "deleted", kind: "workout", id: W, revision: 13 },
    ]);
    const revive = reader.put("workout_set", S1, full("workout_set", set(E)));
    expect(await reader.push([revive])).toMatchObject({
      results: [{ status: "conflict", reason: "deleted", current: { state: "deleted" } }],
    });
    expect(await reader.push([reader.delete("workout", W)])).toMatchObject({
      results: [{ status: "accepted", revision: 13 }],
    });
    const child = reader.put(
      "workout_exercise",
      "e-new",
      full("workout_exercise", entry(W, "New")),
    );
    expect(await reader.push([child])).toMatchObject({
      results: [{ status: "conflict", reason: "parent_deleted", current: null }],
    });
    expect((await server.rows("alice")).filter((r) => r.state === "deleted")).toHaveLength(4);
  });

  it("recognises retries and rejects a reused id with other content", async () => {
    const { writer, submissions } = await created();
    const first = submissions[0] as Json;
    expect(await writer.push([first])).toEqual({
      release: matrixCase.peer,
      results: [{ status: "accepted", submissionId: first.submissionId, revision: 1 }],
    });
    const del = writer.delete("workout_set", S1);
    await writer.push([del]);
    expect(await writer.push([del])).toMatchObject({
      results: [{ status: "accepted", revision: 10 }],
    });
    expect(
      await writer.push([{ ...first, content: full("workout", workout("other")) }]),
    ).toMatchObject({ results: [{ status: "invalid", code: "submission_reused" }] });
    expect(await server.head("alice")).toBe(10);
  });

  it("refuses non-singleton settings and answers malformed requests with the error envelope", async () => {
    const p = peer();
    await p.hello();
    const settings = contents().find(([kind]) => kind === "settings")?.[2] as Json;
    expect(
      await p.push([{ ...p.put("settings", "settings", full("settings", settings)), id: "other" }]),
    ).toMatchObject({ results: [{ status: "invalid", code: "not_singleton" }] });
    // Settings can be changed but never deleted.
    await p.push([p.put("settings", "settings", full("settings", settings))]);
    expect(await p.push([p.delete("settings", "settings")])).toMatchObject({
      results: [{ status: "invalid", code: "not_deletable" }],
    });
    expect((await server.row("alice", "settings", "settings"))?.state).toBe("live");

    const L = p.lineage;
    const errors: [string, Json, number, string][] = [
      ["/sync/push", { release: "0.9", submissions: [] }, 400, "unsupported_release"],
      ["/sync/push", { release: p.release }, 400, "invalid_request"],
      [
        "/sync/push",
        {
          release: p.release,
          lineage: L,
          submissions: [
            { op: "delete", submissionId: "same", kind: "workout", id: "a", baseRevision: 1 },
            { op: "delete", submissionId: "same", kind: "workout", id: "b", baseRevision: 1 },
          ],
        },
        400,
        "invalid_request",
      ],
      [
        "/sync/push",
        {
          release: p.release,
          lineage: L,
          submissions: [{ op: "upsert", submissionId: "x", kind: "workout", id: "a" }],
        },
        400,
        "invalid_request",
      ],
      [
        "/sync/push",
        {
          release: p.release,
          lineage: L,
          submissions: [
            { op: "delete", submissionId: "x", kind: "spaceship", id: "a", baseRevision: 1 },
          ],
        },
        400,
        "invalid_request",
      ],
      [
        "/sync/push",
        {
          release: p.release,
          lineage: L,
          submissions: [
            {
              op: "put",
              submissionId: "x",
              kind: "workout",
              id: "a",
              baseRevision: null,
              content: [],
            },
          ],
        },
        400,
        "invalid_request",
      ],
      ["/sync/pull", { release: p.release, lineage: L, cursor: -1 }, 400, "invalid_request"],
      [
        "/sync/pull",
        { release: p.release, lineage: L, cursor: 0, limit: 501 },
        400,
        "invalid_request",
      ],
      ["/sync/hello", { releases: "1.0", app: "x" }, 400, "invalid_request"],
      [
        "/sync/push",
        {
          release: p.release,
          lineage: L,
          submissions: [
            { op: "delete", submissionId: "x", kind: "workout", id: "a", baseRevision: 1 },
          ],
        },
        400,
        "invalid_request",
      ],
      [
        "/sync/push",
        { release: p.release, lineage: "other", submissions: [] },
        409,
        "cursor_reset",
      ],
      ["/sync/pull", { release: p.release, lineage: "other", cursor: 0 }, 409, "cursor_reset"],
      // A cursor ahead of the server's counter: the server starts a new lineage.
      ["/sync/pull", { release: p.release, lineage: L, cursor: 5 }, 409, "cursor_reset"],
      ["/sync/pull", { release: p.release, lineage: L, cursor: 0 }, 409, "cursor_reset"],
    ];
    for (const [path, body, status, code] of errors) {
      const reply = await p.call(path, body);
      expect([path, reply.status, (reply.body.error as Json)?.code]).toEqual([path, status, code]);
      valid(frozen.negotiation.errorResponse, reply.body);
    }
    const unsupported = await p.call("/sync/push", { release: "0.9", submissions: [] });
    expect((unsupported.body.error as Json).serverReleases).toEqual([...matrixCase.server]);
    expect(await server.head("alice")).toBe(1);
    // After the rotation every device has to connect again and gets the new lineage.
    await p.hello();
    expect(p.lineage).not.toBe(L);
    expect(await p.pull()).toHaveLength(1);
  });

  it("serves the current client negotiating this release", async () => {
    const phone = await world.phone("phone", {
      account: "alice",
      server: "s",
      transport: server.transport("alice"),
    });
    const p = peer("p");
    await p.hello();
    await p.push([p.put("workout", W, full("workout", workout("From the old client")))]);
    phone.store.put("workout", "w-phone", workout("From the phone"));
    const shared = matrixCase.server.filter((release) => CLIENT_RELEASES.includes(release)).at(-1);
    if (!shared) {
      expect(await phone.sync()).toMatchObject({ state: "update_required" });
      expect(phone.store.get("workout", "w-phone")?.status).toBe("pending");
      expect(await server.row("alice", "workout", "w-phone")).toBeUndefined();
      return;
    }
    expect(await phone.sync()).toEqual({ state: "synced", pushed: 1, pulled: 2 });
    expect(phone.store.syncState()).toMatchObject({
      release: shared,
      features: EXPECTED_FEATURES[shared],
    });
    const old = phone.store.get("workout", W)?.content;
    phone.store.put("workout", W, { ...old, title: "Edited on the phone" });
    phone.store.delete("workout", "w-phone");
    expectSynced(await phone.sync());
    const changes = await p.pull();
    expect(changes.map((c) => [c.id, c.state, (c.content as Json | undefined)?.title])).toEqual([
      [W, "live", "Edited on the phone"],
      ["w-phone", "deleted", undefined],
    ]);
  });
});

it("round-trips the consolidated workout fields and records on a fresh 1.0 account", async () => {
  const server = world.server();
  const opts = { server: "s", account: "alice", transport: server.transport("alice") };
  const writer = await world.phone("writer", opts);
  const reader = await world.phone("reader", opts);
  const plan = { title: "Strength", exercises: [] };
  const note = {
    workoutId: "w",
    kind: "sticky",
    text: "Check grip",
    createdAt: ENDED,
    reply: { text: "Keep the same setup", createdAt: ENDED },
  };
  writer.store.put("workout", "w", workout("Squats", { initialPlan: plan }));
  writer.store.put("workout_exercise", "e", entry("w", "Squat"));
  writer.store.put(
    "workout_set",
    "s",
    set("e", { repsInReserve: 0, planSlot: { exercise: 0, set: 0 } }),
  );
  writer.store.put("workout_note", "n", note);
  writer.store.put("workout_rest", "w", { workoutId: "w", seconds: 0 });

  expect(await writer.sync()).toMatchObject({ state: "synced", pushed: 5 });
  expectSynced(await reader.sync());
  await reader.restart();

  expect(reader.store.syncState()).toMatchObject({
    release: "1.0",
    features: EXPECTED_FEATURES["1.0"],
  });
  expect(reader.store.get("workout", "w")?.content?.initialPlan).toEqual(plan);
  expect(reader.store.get("workout_set", "s")?.content).toMatchObject({
    repsInReserve: 0,
    planSlot: { exercise: 0, set: 0 },
  });
  expect(reader.store.get("workout_note", "n")?.content).toEqual(note);
  expect(reader.store.get("workout_rest", "w")?.content).toEqual({ workoutId: "w", seconds: 0 });
});
