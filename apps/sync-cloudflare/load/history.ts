import type { JsonObject } from "@leve/contract";

// A made-up, deterministic training history for load tests: four sessions a week, six exercises a
// session, three working sets plus a warm-up on the first exercise, and a weekly bodyweight entry.

const EXERCISES = [
  ["barbell-bench-press", "Bench Press"],
  ["barbell-squat", "Squat"],
  ["barbell-deadlift", "Deadlift"],
  ["overhead-press", "Overhead Press"],
  ["barbell-row", "Barbell Row"],
  ["pull-up", "Pull Up"],
  ["lateral-raise", "Lateral Raise"],
  ["triceps-pushdown", "Triceps Pushdown"],
  ["biceps-curl", "Biceps Curl"],
  ["leg-press", "Leg Press"],
  ["leg-curl", "Leg Curl"],
  ["calf-raise", "Calf Raise"],
] as const;

export interface HistoryRecord {
  kind: string;
  id: string;
  content: JsonObject;
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (time: number) => new Date(time).toISOString();

/** One logged session: the workout, its exercises and their sets, parents first. */
export function workoutRecords(prefix: string, index: number, start: number): HistoryRecord[] {
  const id = `${prefix}-w${index}`;
  const records: HistoryRecord[] = [];
  const children: HistoryRecord[] = [];
  let clock = start;
  for (let e = 0; e < 6; e++) {
    const [exerciseId, exerciseName] =
      EXERCISES[(index * 3 + e) % EXERCISES.length] ?? EXERCISES[0];
    const entryId = `${id}-e${e + 1}`;
    children.push({
      kind: "workout_exercise",
      id: entryId,
      content: {
        workoutId: id,
        exerciseId,
        exerciseName,
        exerciseType: "weight_reps",
        position: e + 1,
        supersetId: null,
        restSeconds: 120,
        doubleDumbbellVolume: false,
      },
    });
    const sets = e === 0 ? 4 : 3;
    for (let s = 0; s < sets; s++) {
      clock += 3 * 60 * 1000;
      children.push({
        kind: "workout_set",
        id: `${entryId}-s${s + 1}`,
        content: {
          workoutExerciseId: entryId,
          position: s + 1,
          type: e === 0 && s === 0 ? "warmup" : "normal",
          weightKg: 40 + ((index + e * 7) % 60) + 2.5 * (s % 2),
          reps: 5 + ((index + s) % 6),
          distanceMeters: null,
          durationSeconds: null,
          count: null,
          rpe: null,
          completedAt: iso(clock),
        },
      });
    }
  }
  records.push({
    kind: "workout",
    id,
    content: {
      title: `Session ${index}`,
      startedAt: iso(start),
      endedAt: iso(clock + 2 * 60 * 1000),
      routineId: null,
    },
  });
  return [...records, ...children];
}

/** `weeks` of training ending at `end`. */
export function history(prefix: string, weeks: number, end: number): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  const first = end - weeks * 7 * DAY;
  let index = 0;
  for (let week = 0; week < weeks; week++) {
    for (const weekday of [0, 1, 3, 5]) {
      const start = first + (week * 7 + weekday) * DAY + 18 * 60 * 60 * 1000;
      records.push(...workoutRecords(prefix, index++, start));
    }
    records.push({
      kind: "body_measurement",
      id: `${prefix}-m${week}`,
      content: {
        takenAt: iso(first + week * 7 * DAY + 7 * 60 * 60 * 1000),
        bodyweightKg: 80 + (week % 10) / 10,
        fatPercent: null,
      },
    });
  }
  return records;
}
