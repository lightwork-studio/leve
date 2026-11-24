import type { Contract, JsonObject, ReleaseId } from "./definition.ts";
import { NEGOTIATION_DESCRIPTION, releaseMessages, releaseRules } from "./messages.ts";
import { parse } from "./schema.ts";

/*
 * What gets frozen for a release. The frozen copy is compared with this output in CI, so a change
 * to the shared definitions that alters a frozen release fails.
 */

export function describeFrozenRelease(contract: Contract, release: ReleaseId) {
  const { kinds, features } = contract.describeRelease(release);
  return {
    release,
    kinds,
    features,
    messages: releaseMessages(contract, release).describe(),
    rules: releaseRules(contract, release),
    negotiation: NEGOTIATION_DESCRIPTION,
  };
}

const WORKOUT = "0b5c3f1e-6f1a-4c39-9a51-2f5e8d7c1a01";
const ENTRY = "0b5c3f1e-6f1a-4c39-9a51-2f5e8d7c1a02";
const SET = "0b5c3f1e-6f1a-4c39-9a51-2f5e8d7c1a03";
const T = "2026-11-10T18:30:00.000Z";
const LINEAGE = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

/** One realistic record of every kind, in current logical form. */
export const SAMPLE_CONTENT: Record<string, JsonObject> = {
  workout_rest: { workoutId: WORKOUT, seconds: 75 },
  workout_note: {
    workoutId: WORKOUT,
    kind: "sticky",
    text: "Adjust the bench",
    createdAt: T,
    reply: null,
  },
  workout: {
    title: "Push day",
    description: "",
    startedAt: T,
    endedAt: null,
    routineId: null,
    initialPlan: { title: "Push day", effortScale: "rpe", exercises: [] },
  },
  workout_exercise: {
    workoutId: WORKOUT,
    exerciseId: "bench-press-barbell",
    exerciseName: "Bench Press (Barbell)",
    exerciseType: "weight_reps",
    position: 1,
    supersetId: null,
    restSeconds: 120,
    notes: [{ id: "note-1", text: "Pause at the bottom", createdAt: T }],
    doubleDumbbellVolume: false,
  },
  workout_set: {
    workoutExerciseId: ENTRY,
    position: 1,
    type: "normal",
    weightKg: 82.5,
    reps: 5,
    distanceMeters: null,
    durationSeconds: null,
    count: null,
    rpe: 8.5,
    completedAt: T,
  },
  routine: {
    title: "Upper A",
    notes: "",
    folderId: null,
    position: 1,
    effortScale: "rir",
    exercises: [
      {
        id: "routine-exercise-1",
        exerciseId: "bench-press-barbell",
        exerciseName: "Bench Press (Barbell)",
        exerciseType: "weight_reps",
        supersetId: null,
        restSeconds: 120,
        notes: [],
        useRepRange: true,
        sets: [
          {
            id: "routine-set-1",
            type: "warmup",
            weightKg: 40,
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
  routine_folder: { title: "Strength", position: 1 },
  custom_exercise: {
    name: "Sled Push",
    type: "weight_distance",
    primaryMuscle: "quadriceps",
    secondaryMuscles: ["glutes", "calves"],
    equipment: "other",
    usesBodyweight: false,
    archived: false,
  },
  body_measurement: { takenAt: T, bodyweightKg: 80.2, fatPercent: null },
  settings: {
    weightUnit: "kg",
    distanceUnit: "km",
    shortDistanceUnit: "m",
    measurementUnit: "cm",
    firstWeekday: 1,
    defaultRestSeconds: 90,
    rpeEnabled: true,
    countWarmups: true,
    previousValues: "any_workout",
    autoUpdateRoutineValues: true,
  },
};

const SAMPLE_IDS: Record<string, string> = {
  workout_note: "note-1",
  workout_rest: WORKOUT,
  workout: WORKOUT,
  workout_exercise: ENTRY,
  workout_set: SET,
  routine: "routine-1",
  routine_folder: "folder-1",
  custom_exercise: "custom-1",
  body_measurement: "measurement-1",
  settings: "settings",
};

/** Example messages of a release, produced by the real encoder and checked against its schemas. */
export function exampleMessages(contract: Contract, release: ReleaseId) {
  const messages = releaseMessages(contract, release);
  const content = (kind: string) => {
    const encoded = contract.encode(kind, SAMPLE_CONTENT[kind] ?? {}, release);
    if (encoded.issues.length > 0) throw new Error(`sample ${kind} does not encode`);
    return encoded.content;
  };
  const kinds = contract.kindNames(release);
  // A first upload: every kind is created (revisions 1..n in request order), then the set is
  // edited, then its exercise entry is deleted (the set's marker, then the entry's).
  const created = kinds.length;
  const pushRequest = parse(messages.pushRequest, {
    release,
    lineage: LINEAGE,
    submissions: [
      ...kinds.map((kind, index) => ({
        op: "put",
        submissionId: `submission-${index + 1}`,
        kind,
        id: SAMPLE_IDS[kind],
        baseRevision: null,
        content: content(kind),
      })),
      {
        op: "put",
        submissionId: "submission-update",
        kind: "workout_set",
        id: SET,
        baseRevision: kinds.indexOf("workout_set") + 1,
        content: { ...content("workout_set"), reps: 6 },
      },
      {
        op: "delete",
        submissionId: "submission-delete",
        kind: "workout_exercise",
        id: ENTRY,
        baseRevision: kinds.indexOf("workout_exercise") + 1,
        descendants: [{ kind: "workout_set", id: SET, revision: created + 1 }],
      },
    ],
  });
  const pushResponse = parse(messages.pushResponse, {
    release,
    results: [
      ...kinds.map((_kind, index) => ({
        status: "accepted",
        submissionId: `submission-${index + 1}`,
        revision: index + 1,
      })),
      { status: "accepted", submissionId: "submission-update", revision: created + 1 },
      { status: "accepted", submissionId: "submission-delete", revision: created + 3 },
    ],
  });
  // Answers that keep the change on the device.
  const rejectedRequest = parse(messages.pushRequest, {
    release,
    lineage: LINEAGE,
    submissions: [
      {
        op: "put",
        submissionId: "submission-stale",
        kind: "workout",
        id: WORKOUT,
        baseRevision: 3,
        content: { ...content("workout"), title: "Push day A" },
      },
      {
        op: "put",
        submissionId: "submission-orphan",
        kind: "workout_set",
        id: "set-under-new-entry",
        baseRevision: null,
        content: { ...content("workout_set"), workoutExerciseId: "entry-not-uploaded" },
      },
      {
        op: "put",
        submissionId: "submission-bad",
        kind: "body_measurement",
        id: "measurement-2",
        baseRevision: null,
        content: { ...content("body_measurement"), fatPercent: 120 },
      },
      {
        op: "delete",
        submissionId: "submission-settings",
        kind: "settings",
        id: "settings",
        baseRevision: 5,
        descendants: [],
      },
    ],
  });
  const rejectedResponse = parse(messages.pushResponse, {
    release,
    results: [
      {
        status: "conflict",
        submissionId: "submission-stale",
        reason: "stale",
        current: {
          state: "live",
          kind: "workout",
          id: WORKOUT,
          revision: 12,
          content: { ...content("workout"), title: "Chest day" },
        },
      },
      { status: "retry_later", submissionId: "submission-orphan", reason: "parent_missing" },
      {
        status: "invalid",
        submissionId: "submission-bad",
        code: "invalid_content",
        message: "$.fatPercent must be 0..100",
      },
      {
        status: "invalid",
        submissionId: "submission-settings",
        code: "not_deletable",
        message: "settings can be changed but not deleted",
      },
    ],
  });
  const pullRequest = parse(messages.pullRequest, {
    release,
    lineage: LINEAGE,
    cursor: 0,
    limit: 100,
    waitMs: 20000,
  });
  const pullResponse = parse(messages.pullResponse, {
    release,
    changes: [
      ...kinds.map((kind, index) => ({
        state: "live",
        kind,
        id: SAMPLE_IDS[kind],
        revision: index + 1,
        content: content(kind),
      })),
      // Each record appears once per page, at its latest revision.
      { state: "deleted", kind: "workout_set", id: "set-removed", revision: 20 },
      { state: "unavailable", kind: "routine", id: "routine-2", revision: 21 },
    ],
    cursor: 21,
    hasMore: false,
  });
  return {
    helloRequest: { releases: [release], app: "0.1.0" },
    helloResponse: {
      release,
      features: contract.features(release),
      revision: 21,
      lineage: LINEAGE,
      restoredFrom: { lineage: "1d0f3c2b-7a6e-4c5d-8b9a-0f1e2d3c4b5a", restorePoint: 18 },
    },
    pushRequest,
    pushResponse,
    rejectedRequest,
    rejectedResponse,
    pullRequest,
    pullResponse,
    errors: [
      {
        error: {
          code: "update_required",
          message: "This server needs a newer app",
          update: "client",
          serverReleases: [release],
        },
      },
      { error: { code: "cursor_reset", message: "Download everything again" } },
      { error: { code: "invalid_request", message: "$.cursor expected an integer" } },
    ],
  };
}
