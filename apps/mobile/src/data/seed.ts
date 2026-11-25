import type { JsonObject } from "@leve/contract";
import type { DeviceStore } from "@leve/storage";
import { type BuiltInExercise, EXERCISES as X } from "./exercises.ts";

// Synthetic data for previews: a few routines in folders and about three months of workouts. It is
// made up and deterministic for a given "now", so a reset always gives the same picture.

type Plan = {
  exercise: BuiltInExercise;
  sets: number;
  weightKg: number | null;
  reps: [number, number];
};

const ROUTINES: { id: string; title: string; folder: string | null; plan: Plan[] }[] = [
  {
    id: "seed-routine-push",
    title: "Push day",
    folder: "seed-folder-ppl",
    plan: [
      { exercise: X.bench, sets: 3, weightKg: 80, reps: [6, 8] },
      { exercise: X.ohp, sets: 3, weightKg: 45, reps: [6, 8] },
      { exercise: X.incline, sets: 3, weightKg: 26, reps: [8, 10] },
      { exercise: X.lateral, sets: 3, weightKg: 10, reps: [12, 15] },
      { exercise: X.pushdown, sets: 3, weightKg: 30, reps: [10, 12] },
    ],
  },
  {
    id: "seed-routine-pull",
    title: "Pull day",
    folder: "seed-folder-ppl",
    plan: [
      { exercise: X.deadlift, sets: 3, weightKg: 140, reps: [4, 6] },
      { exercise: X.pullup, sets: 3, weightKg: null, reps: [6, 10] },
      { exercise: X.row, sets: 3, weightKg: 70, reps: [8, 10] },
      { exercise: X.facepull, sets: 3, weightKg: 25, reps: [12, 15] },
      { exercise: X.curl, sets: 3, weightKg: 14, reps: [10, 12] },
    ],
  },
  {
    id: "seed-routine-legs",
    title: "Legs",
    folder: "seed-folder-ppl",
    plan: [
      { exercise: X.squat, sets: 3, weightKg: 110, reps: [5, 8] },
      { exercise: X.rdl, sets: 3, weightKg: 90, reps: [8, 10] },
      { exercise: X.legpress, sets: 3, weightKg: 180, reps: [10, 12] },
      { exercise: X.legcurl, sets: 3, weightKg: 45, reps: [10, 12] },
      { exercise: X.calf, sets: 4, weightKg: 60, reps: [12, 15] },
    ],
  },
  {
    id: "seed-routine-mobility",
    title: "Morning mobility",
    folder: "seed-folder-mobility",
    plan: [
      { exercise: X.plank, sets: 3, weightKg: null, reps: [0, 0] },
      { exercise: X.stretch, sets: 2, weightKg: null, reps: [0, 0] },
    ],
  },
  {
    id: "seed-routine-full",
    title: "Full body",
    folder: null,
    plan: [
      { exercise: X.squat, sets: 3, weightKg: 100, reps: [6, 8] },
      { exercise: X.bench, sets: 3, weightKg: 75, reps: [6, 8] },
      { exercise: X.row, sets: 3, weightKg: 65, reps: [8, 10] },
    ],
  },
];

const iso = (time: number) => new Date(time).toISOString();

/** A target set for a routine. Timed exercises get 45 seconds; others a weight and rep range. */
function targetSet(id: string, plan: Plan): JsonObject {
  const timed = plan.exercise.type === "duration";
  return {
    id,
    type: "normal",
    weightKg: plan.weightKg,
    reps: null,
    repRangeMin: timed ? null : plan.reps[0],
    repRangeMax: timed ? null : plan.reps[1],
    distanceMeters: null,
    durationSeconds: timed ? 45 : null,
    count: null,
    rpe: null,
  };
}

/**
 * Prepares a newly opened store. With sample data on, a store holding nothing at all gets the
 * synthetic data; otherwise it is left exactly as it is, so a new install starts empty. Anything
 * already stored, even one workout logged without ever opening Settings, means it is never seeded
 * over. Returns whether it seeded.
 */
export function firstStart(
  store: DeviceStore,
  sampleData: boolean,
  now: Date = new Date(),
): boolean {
  if (!wantsSampleData(store, sampleData)) return false;
  seedSyntheticData(store, now);
  return true;
}

/** Whether a newly opened store gets the synthetic data (see firstStart). */
export function wantsSampleData(store: DeviceStore, sampleData: boolean): boolean {
  return sampleData && !store.db.get("SELECT 1 FROM records LIMIT 1");
}

export function seedSyntheticData(store: DeviceStore, now: Date = new Date()): void {
  store.put("routine_folder", "seed-folder-ppl", { title: "Push · Pull · Legs", position: 1 });
  store.put("routine_folder", "seed-folder-mobility", { title: "Mobility", position: 2 });

  ROUTINES.forEach((routine, index) => {
    store.put("routine", routine.id, {
      title: routine.title,
      folderId: routine.folder,
      position: index + 1,
      exercises: routine.plan.map((plan, e) => ({
        id: `${routine.id}-e${e + 1}`,
        exerciseId: plan.exercise.id,
        exerciseName: plan.exercise.name,
        exerciseType: plan.exercise.type,
        supersetId: null,
        restSeconds: plan.exercise.type === "duration" ? 30 : 120,
        useRepRange: plan.exercise.type !== "duration",
        sets: Array.from({ length: plan.sets }, (_, s) =>
          targetSet(`${routine.id}-e${e + 1}-s${s + 1}`, plan),
        ),
      })),
    });
  });

  // Twelve weeks of training, getting a little stronger: push, pull and legs at 18:00 local time
  // on Monday, Wednesday and Friday, with a few sessions missed, a full-body session on some
  // Saturdays and morning mobility on some Tuesdays. Nothing is dated after `now`.
  const [push, pull, legs, mobility, full] = ROUTINES as [Seeded, Seeded, Seeded, Seeded, Seeded];
  const at = (week: number, weekday: number, hour: number) => {
    const date = new Date(now);
    date.setHours(hour, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7) - week * 7 + weekday);
    return date.getTime();
  };
  let session = 0;
  const pushDays: { id: string; start: number }[] = [];
  for (let week = WEEKS - 1; week >= 0; week--) {
    const progress = WEEKS - 1 - week;
    const plan: [Seeded, number, number][] = [
      [push, 0, 18],
      [pull, 2, 18],
      [legs, 4, 18],
    ];
    if (week % 2 === 0) plan.push([mobility, 1, 7]);
    if (week % 4 === 1) plan.push([full, 5, 10]);
    for (const [routine, weekday, hour] of plan.sort((x, y) => x[1] - y[1])) {
      if (MISSED.has(`${week}:${weekday}`)) continue;
      const start = at(week, weekday, hour);
      if (start + workoutMinutes(routine) * 60_000 > now.getTime()) continue;
      session += 1;
      logWorkout(store, `seed-workout-${session}`, routine, start, progress);
      if (routine === push) pushDays.push({ id: `seed-workout-${session}`, start });
    }
  }
  seedNotes(store, pushDays, now.getTime());

  for (let week = WEEKS; week >= 0; week--) {
    const takenAt = at(week, 0, 7);
    if (takenAt > now.getTime()) continue;
    store.put("body_measurement", `seed-measurement-${WEEKS + 1 - week}`, {
      takenAt: iso(takenAt),
      bodyweightKg: Math.round((83.6 - (WEEKS - week) * 0.1) * 10) / 10,
      fatPercent: null,
    });
  }

  // Settings last: a seed cut short is redone on the next start, as it only checks for them.
  store.put("settings", "settings", {
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
  });
}

type Seeded = (typeof ROUTINES)[number];

/**
 * Notes on the push day, so the next one shows each kind: pinned setup notes on two exercises and
 * on the workout, and notes from last time with a coach's reply.
 */
function seedNotes(store: DeviceStore, pushDays: { id: string; start: number }[], now: number) {
  const first = pushDays[0];
  const last = pushDays.at(-1);
  if (!first || !last) return;
  const during = (day: { start: number }, minutes: number) => iso(day.start + minutes * 60_000);
  // The reply came the next morning, or an hour ago if that is later than now.
  const replied = iso(Math.min(last.start + 15 * 60 * 60_000, now - 60 * 60_000));
  const exerciseNote = (
    id: string,
    exerciseId: string,
    day: typeof first,
    text: string,
    pinned: boolean,
  ) =>
    store.put("exercise_note", id, {
      exerciseId,
      workoutId: day.id,
      pinned,
      text,
      createdAt: during(day, 20),
      agent: null,
    });
  exerciseNote(
    "seed-note-grip",
    X.bench.id,
    first,
    "Grip just outside the rings, feet tucked",
    true,
  );
  exerciseNote("seed-note-incline", X.incline.id, first, "Bench at 30°, seat on 3", true);
  exerciseNote(
    "seed-note-slow",
    X.bench.id,
    last,
    "Last rep of set 3 was slow off the chest",
    false,
  );
  store.put("exercise_note_comment", "seed-comment-slow", {
    noteId: "seed-note-slow",
    text: "Keep 92.5 kg and aim for 8, 7, 7 again. Add weight when all three sets hit 8.",
    createdAt: replied,
    agent: "Coach",
  });
  store.put("workout_note", "seed-note-warmup", {
    workoutId: first.id,
    pinned: true,
    text: "Band pull-aparts before the first press",
    createdAt: during(first, 5),
    agent: null,
  });
  store.put("workout_note", "seed-note-sleep", {
    workoutId: last.id,
    pinned: false,
    text: "Slept 5 hours, felt flat. Waited ten minutes for the rack.",
    createdAt: during(last, 70),
    agent: null,
  });
  store.put("workout_note_comment", "seed-comment-sleep", {
    noteId: "seed-note-sleep",
    text: "Sleep was under 6 hours twice this week. Start with your top set while you're fresh.",
    createdAt: replied,
    agent: "Coach",
  });
}

const WEEKS = 12;

/** Sessions skipped, as "weeks ago:weekday", so the weeks aren't all alike. */
const MISSED = new Set(["10:4", "7:2", "5:0", "3:4"]);

/** Heavy barbell lifts that get a warm-up set when a routine opens with them. */
const WARM_UP_FIRST = new Set<string>([X.bench.id, X.deadlift.id, X.squat.id]);

const warmsUp = (routine: Seeded) => WARM_UP_FIRST.has(routine.plan[0]?.exercise.id ?? "");

/** How long a seeded session of a routine lasts: three minutes a set, plus two. */
function workoutMinutes(routine: Seeded): number {
  const sets = routine.plan.reduce((sum, plan) => sum + plan.sets, 0) + (warmsUp(routine) ? 1 : 0);
  return sets * 3 + 2;
}

function logWorkout(
  store: DeviceStore,
  id: string,
  routine: Seeded,
  start: number,
  progress: number,
): void {
  let clock = start;
  const sets: [string, JsonObject][] = [];
  const entries: [string, JsonObject][] = [];
  routine.plan.forEach((plan, e) => {
    const entryId = `${id}-e${e + 1}`;
    entries.push([
      entryId,
      {
        workoutId: id,
        exerciseId: plan.exercise.id,
        exerciseName: plan.exercise.name,
        exerciseType: plan.exercise.type,
        position: e + 1,
        supersetId: null,
        restSeconds: 120,
        doubleDumbbellVolume: false,
      },
    ]);
    const timed = plan.exercise.type === "duration";
    // A step up in weight every second week, with the reps dipping now and then.
    const weight = plan.weightKg === null ? null : plan.weightKg + Math.floor(progress / 2) * 2.5;
    const planned: { type: string; weightKg: number | null; reps: number | null }[] = [];
    if (e === 0 && warmsUp(routine) && weight !== null) {
      planned.push({ type: "warmup", weightKg: Math.round(weight / 5) * 2.5, reps: 10 });
    }
    for (let s = 0; s < plan.sets; s++) {
      const dip = (s === plan.sets - 1 ? 1 : 0) + ((progress + s + e) % 4 === 0 ? 1 : 0);
      planned.push({ type: "normal", weightKg: weight, reps: timed ? null : plan.reps[1] - dip });
    }
    planned.forEach((set, s) => {
      clock += 3 * 60 * 1000;
      sets.push([
        `${entryId}-s${s + 1}`,
        {
          workoutExerciseId: entryId,
          position: s + 1,
          type: set.type,
          weightKg: set.weightKg,
          reps: set.reps,
          distanceMeters: null,
          durationSeconds: timed ? 40 + progress * 2 + (s % 2) * 5 : null,
          count: null,
          rpe: null,
          completedAt: iso(clock),
        },
      ]);
    });
  });
  store.put("workout", id, {
    title: routine.title,
    startedAt: iso(start),
    endedAt: iso(clock + 2 * 60 * 1000),
    routineId: routine.id,
  });
  for (const [entryId, content] of entries) store.put("workout_exercise", entryId, content);
  for (const [setId, content] of sets) store.put("workout_set", setId, content);
}
