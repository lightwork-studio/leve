import { type JsonObject, jsonBytes, MAX_RECORD_BYTES } from "@leve/contract";

/** A 1.2 workout whose snapshot and description exactly fill the wire limit. */
export function maximumWorkout(): JsonObject {
  const target = {
    type: "normal",
    reps: 8,
    weightKg: 60,
    repRangeMin: null,
    repRangeMax: null,
    distanceMeters: null,
    durationSeconds: null,
    count: null,
    rpe: null,
  };
  const exercise = {
    exerciseId: "press",
    exerciseName: "Press",
    exerciseType: "weight_reps",
    restSeconds: 90,
    supersetId: null,
    useRepRange: false,
  };
  const exercises: JsonObject[] = [];
  const record = {
    title: "Recorded training",
    description: "",
    startedAt: "2026-11-01T09:00:00.000Z",
    endedAt: "2026-11-01T10:00:00.000Z",
    routineId: null,
    initialPlan: { title: "Strength", exercises },
  };
  for (;;) {
    const remaining = MAX_RECORD_BYTES - jsonBytes(record);
    if (remaining <= 2000) {
      record.description = "x".repeat(remaining);
      return record;
    }
    const count = Math.min(
      150,
      Math.floor((remaining - jsonBytes(exercise) - 32) / (jsonBytes(target) + 1)),
    );
    exercises.push({ ...exercise, sets: Array.from({ length: count }, () => target) });
  }
}
