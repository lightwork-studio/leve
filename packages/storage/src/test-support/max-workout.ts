import { type JsonObject, jsonBytes, MAX_RECORD_BYTES } from "@leve/contract";

const TITLE_LENGTH = 100;

/** A 1.2 workout whose snapshot exactly fills the wire limit. */
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
  const initialPlan = { title: "Strength", exercises };
  const record = {
    title: "Recorded training",
    startedAt: "2026-11-01T09:00:00.000Z",
    endedAt: "2026-11-01T10:00:00.000Z",
    routineId: null,
    initialPlan,
  };
  for (;;) {
    const remaining = MAX_RECORD_BYTES - jsonBytes(record);
    if (remaining <= 2000) break;
    const count = Math.min(
      150,
      Math.floor((remaining - jsonBytes(exercise) - 32) / (jsonBytes(target) + 1)),
    );
    exercises.push({ ...exercise, sets: Array.from({ length: count }, () => target) });
  }
  // The last bytes go to exercises without sets, then to the names, which can grow to the title
  // limit: together they can take up any remainder.
  const empty = { ...exercise, exerciseName: "P", sets: [] };
  const extra = Math.floor((MAX_RECORD_BYTES - jsonBytes(record)) / (jsonBytes(empty) + 1));
  for (let i = 0; i < extra; i++) exercises.push({ ...empty });
  const named: { content: JsonObject; field: string }[] = [
    { content: record, field: "title" },
    { content: initialPlan, field: "title" },
    ...exercises.slice(-extra || exercises.length).map((content) => ({
      content,
      field: "exerciseName",
    })),
  ];
  for (const { content, field } of named) {
    const remaining = MAX_RECORD_BYTES - jsonBytes(record);
    const text = String(content[field]);
    const grow = Math.min(remaining, TITLE_LENGTH - text.length);
    if (grow > 0) content[field] = text + "x".repeat(grow);
  }
  if (jsonBytes(record) !== MAX_RECORD_BYTES) throw Error("The maximum workout doesn't fit.");
  return record;
}
