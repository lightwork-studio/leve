// SPDX-FileCopyrightText: Leve contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { MAX_PAGE_BYTES } from "@leve/contract";
import {
  buildProgress,
  countsTowardTotals,
  type ExerciseType,
  exerciseRecords,
  isRepBased,
  type SessionBest,
  setVolumeKg,
  type WorkoutTree,
  workoutMinutes,
} from "@leve/core";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { WorkoutReadSelection } from "../service.ts";
import type { AccountView, ReadKind, Shown } from "./account-view.ts";

/*
 * Read tools. Every record comes with its id and revision, so a later write can say which copy it
 * is based on. Values are in the units records store (kg, metres, seconds, UTC times); the
 * account's settings say which units the lifter sees.
 */

type ViewLoader = (
  kinds: readonly ReadKind[],
  workouts?: WorkoutReadSelection,
) => Promise<AccountView>;

const workoutKinds = [
  "workout",
  "workout_exercise",
  "workout_set",
  "settings",
  "body_measurement",
  "custom_exercise",
] as const satisfies readonly ReadKind[];
const noteKinds = ["exercise_note", "exercise_note_comment"] as const satisfies readonly ReadKind[];

const UNITS =
  "Weights are in kg, distances in metres, durations in seconds and times in UTC, as stored; " +
  "get_settings says which units the lifter uses.";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (value: Record<string, unknown>): ToolResult => {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_PAGE_BYTES) {
    return refuse(
      "The result is too large. Use a smaller date range or page size where available.",
    );
  }
  return { content: [{ type: "text", text }], structuredContent: value };
};
const refuse = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const isoTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const range = {
  from: isoTime.optional().describe("Only from this time on (inclusive), ISO 8601"),
  to: isoTime.optional().describe("Only before this time (exclusive), ISO 8601"),
};
const inRange = (time: number, from?: string, to?: string) =>
  (from === undefined || time >= Date.parse(from)) && (to === undefined || time < Date.parse(to));

const utcTime = (value: string) => new Date(value).toISOString();
const utcRange = (from?: string, to?: string) => ({
  ...(from === undefined ? {} : { from: utcTime(from) }),
  ...(to === undefined ? {} : { to: utcTime(to) }),
});
const workoutCursor = z.object({ startedAt: isoTime, id: z.string().min(1) });

const record = ({ id, revision, content }: Shown) => ({ id, revision, ...content });

/** A workout's figures as the app's history shows them. */
function workoutFigures(
  tree: WorkoutTree,
  view: AccountView,
  options: {
    countWarmups: boolean;
    bodyweightAt: (t: number) => number | null;
    uses: (id: string) => boolean;
  },
) {
  const bodyweightKg = options.bodyweightAt(Date.parse(tree.workout.content.startedAt));
  let volumeKg = 0;
  let sets = 0;
  let reps = 0;
  const exercises: { exerciseId: string; name: string; sets: number }[] = [];
  for (const { entry, sets: entrySets } of tree.entries) {
    const counted = entrySets.filter((s) => countsTowardTotals(s.content, options.countWarmups));
    sets += counted.length;
    if (isRepBased(entry.content.exerciseType as ExerciseType)) {
      for (const set of counted) reps += set.content.reps ?? 0;
    }
    const usesBodyweight = options.uses(entry.content.exerciseId);
    for (const set of counted) {
      volumeKg += setVolumeKg(set.content, entry.content, { usesBodyweight, bodyweightKg });
    }
    if (entrySets.some((s) => s.content.completedAt !== null)) {
      exercises.push({
        exerciseId: entry.content.exerciseId,
        name: entry.content.exerciseName,
        sets: counted.length,
      });
    }
  }
  const workout = view.get("workout", tree.workout.id) as Shown;
  return {
    id: workout.id,
    revision: workout.revision,
    title: tree.workout.content.title,
    startedAt: tree.workout.content.startedAt,
    endedAt: tree.workout.content.endedAt,
    inProgress: tree.workout.content.endedAt === null,
    routineId: tree.workout.content.routineId,
    minutes: workoutMinutes(tree.workout.content),
    volumeKg: Math.round(volumeKg * 10) / 10,
    sets,
    reps,
    exercises,
  };
}

const figureOptions = (view: AccountView) => ({
  countWarmups: view.settings().countWarmups,
  bodyweightAt: view.bodyweightAt(),
  uses: view.usesBodyweight(),
});

const progressOptions = (view: AccountView) => {
  const { countWarmups, bodyweightAt, uses } = figureOptions(view);
  return { countWarmups, bodyweightAt, usesBodyweight: uses };
};

const withComments =
  (view: AccountView, kind: "workout_note_comment" | "exercise_note_comment") => (note: Shown) => ({
    ...record(note),
    comments: view.children(kind, note.id).map(record),
  });

const bests = (best: SessionBest) =>
  Object.fromEntries(Object.entries(best).filter(([, value]) => value !== null));

const emptyTotals = () => ({ workouts: 0, minutes: 0, volumeKg: 0, sets: 0, reps: 0 });
type Totals = ReturnType<typeof emptyTotals>;

function addWorkout(total: Totals, workout: Omit<Totals, "workouts">) {
  total.workouts += 1;
  total.minutes += workout.minutes;
  total.volumeKg = Math.round((total.volumeKg + workout.volumeKg) * 10) / 10;
  total.sets += workout.sets;
  total.reps += workout.reps;
}

const dateInZone = (timeZone: string) =>
  new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

const timeZoneName = z.string().refine((value) => {
  try {
    dateInZone(value);
    return !/^[+-]/.test(value);
  } catch {
    return false;
  }
}, "Use an IANA time zone such as Europe/Berlin");

function weekOf(time: number, firstWeekday: number, date: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(
    date.formatToParts(time).map(({ type, value }) => [type, value]),
  );
  const start = new Date(
    `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day}T00:00:00.000Z`,
  );
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() - firstWeekday + 7) % 7));
  return start.toISOString().slice(0, 10);
}

export function registerReadTools(server: McpServer, load: ViewLoader): void {
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "get_settings",
    {
      title: "Settings",
      description: `The lifter's settings: preferred units, first weekday, whether warm-ups count toward figures. ${UNITS}`,
      annotations: readOnly,
    },
    async () => {
      const view = await load(["settings"]);
      const stored = view.get("settings", "settings");
      return ok({ revision: stored?.revision ?? null, settings: view.settings() });
    },
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List workouts",
      description:
        "Workouts newest first, with their totals and exercises (finished and in progress). " +
        `Pass the previous page's \`nextCursor\` as \`cursor\` to keep paging. ${UNITS}`,
      inputSchema: z.object({
        ...range,
        cursor: workoutCursor.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: readOnly,
    },
    async ({ from, to, cursor, limit }) => {
      const view = await load(workoutKinds, {
        ...utcRange(from, to),
        ...(cursor ? { cursor: { ...cursor, startedAt: utcTime(cursor.startedAt) } } : {}),
        limit: limit + 1,
      });
      const options = figureOptions(view);
      const matching = view.list("workout");
      const page = matching.slice(0, limit);
      const last = page.at(-1);
      return ok({
        workouts: page.map((w) => workoutFigures(view.tree(w), view, options)),
        nextCursor:
          matching.length > limit && last
            ? { startedAt: String(last.content.startedAt), id: last.id }
            : null,
      });
    },
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get a workout",
      description:
        "One workout in full: its details, each exercise entry with its sets, the rest preference, " +
        `its notes with their comments, and exercise notes written during it. ${UNITS}`,
      inputSchema: z.object({ id: z.string().min(1).describe("The workout id") }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const view = await load(
        [...workoutKinds, "workout_rest", "workout_note", "workout_note_comment", ...noteKinds],
        { id },
      );
      const workout = view.get("workout", id);
      if (!workout) return refuse(`No workout ${id}. list_workouts shows the workouts there are.`);
      const tree = view.tree(workout);
      const rest = view.get("workout_rest", id);
      return ok({
        workout: record(workout),
        totals: workoutFigures(tree, view, figureOptions(view)),
        rest: rest ? record(rest) : null,
        exercises: view.children("workout_exercise", id).map((entry) => ({
          ...record(entry),
          sets: view.children("workout_set", entry.id).map(record),
        })),
        notes: view.children("workout_note", id).map(withComments(view, "workout_note_comment")),
        exerciseNotes: view
          .children("exercise_note", id)
          .map(withComments(view, "exercise_note_comment")),
      });
    },
  );

  server.registerTool(
    "list_exercises",
    {
      title: "List exercises",
      description:
        "The exercises the lifter has logged in finished workouts, most recently done first, with " +
        "how often and when, plus custom exercises not done yet. Use the ids with " +
        "get_exercise_history.",
      inputSchema: z.object({
        query: z.string().optional().describe("Only exercises whose name contains this"),
      }),
      annotations: readOnly,
    },
    async ({ query }) => {
      const view = await load(workoutKinds);
      const index = buildProgress(view.trees(), progressOptions(view));
      const custom = new Map(view.list("custom_exercise").map((e) => [e.id, e]));
      const needle = query?.trim().toLowerCase() ?? "";
      const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
      const done = index.exercises.map((history) => ({
        exerciseId: history.exerciseId,
        name: history.name,
        type: history.type,
        custom: custom.has(history.exerciseId),
        sessions: history.sessions.length,
        sets: history.sets,
        lastDoneAt: history.sessions[0]?.startedAt ?? null,
      }));
      const notDone = [...custom.values()]
        .filter((e) => !index.byExercise.has(e.id))
        .map((e) => ({
          exerciseId: e.id,
          name: String(e.content.name),
          type: String(e.content.type),
          custom: true,
          archived: e.content.archived === true,
          sessions: 0,
          sets: 0,
          lastDoneAt: null,
        }));
      return ok({ exercises: [...done, ...notDone].filter((e) => matches(e.name)) });
    },
  );

  server.registerTool(
    "get_exercise_history",
    {
      title: "Exercise history",
      description:
        "One exercise's sessions newest first, each with its sets and best values, and its " +
        "all-time records. Only finished workouts count, and warm-ups only if the setting says " +
        `so. Estimated one-rep max uses the Epley formula. ${UNITS}`,
      inputSchema: z.object({
        exerciseId: z.string().min(1).describe("From list_exercises"),
        limit: z.number().int().min(1).max(200).default(20).describe("Sessions to return"),
      }),
      annotations: readOnly,
    },
    async ({ exerciseId, limit }) => {
      const view = await load(workoutKinds, { exerciseId, finished: true });
      const index = buildProgress(view.trees(), progressOptions(view));
      const history = index.byExercise.get(exerciseId);
      if (!history) {
        return refuse(`No finished sessions of ${exerciseId}. list_exercises shows the ids.`);
      }
      return ok({
        exerciseId,
        name: history.name,
        type: history.type,
        usesBodyweight: history.usesBodyweight,
        sessionCount: history.sessions.length,
        records: exerciseRecords(history),
        sessions: history.sessions.slice(0, limit).map((session) => ({
          workoutId: session.workoutId,
          workoutTitle: session.workoutTitle,
          startedAt: session.startedAt,
          countedSets: session.counted,
          best: bests(session.best),
          sets: session.sets.map(({ id, content }) => ({
            id,
            revision: view.get("workout_set", id)?.revision,
            ...content,
          })),
        })),
      });
    },
  );

  server.registerTool(
    "get_progress",
    {
      title: "Progress",
      description:
        "Training over a period: finished workouts, weekly and period totals, and for " +
        "the exercises done most often, each session's best values (oldest first) for spotting " +
        `trends. ${UNITS}`,
      inputSchema: z.object({
        ...range,
        timeZone: timeZoneName
          .default("UTC")
          .describe("Time zone for grouping weeks, default UTC."),
        exercises: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(10)
          .describe("How many of the most frequent exercises to include"),
      }),
      annotations: readOnly,
    },
    async ({ from, to, exercises, timeZone }) => {
      const view = await load(workoutKinds, { ...utcRange(from, to), finished: true });
      const index = buildProgress(view.trees(), progressOptions(view));
      const { workouts } = index;
      const totals = emptyTotals();
      const weeks = new Map<string, Totals>();
      const { firstWeekday } = view.settings();
      const date = dateInZone(timeZone);
      for (const workout of workouts) {
        addWorkout(totals, workout);
        const week = weekOf(workout.time, firstWeekday, date);
        const weekTotals = weeks.get(week) ?? emptyTotals();
        addWorkout(weekTotals, workout);
        weeks.set(week, weekTotals);
      }
      const byExercise = [...index.exercises]
        .filter(({ sessions }) => sessions.length > 0)
        .sort((a, b) => b.sessions.length - a.sessions.length)
        .slice(0, exercises);
      return ok({
        totals,
        weeks: [...weeks].map(([weekStart, totals]) => ({ weekStart, ...totals })),
        workouts: workouts.map((w) => ({
          id: w.id,
          startedAt: new Date(w.time).toISOString(),
          minutes: w.minutes,
          volumeKg: w.volumeKg,
          sets: w.sets,
          reps: w.reps,
        })),
        exercises: byExercise.map(({ exerciseId, name, type, sessions }) => ({
          exerciseId,
          name,
          type,
          sessions: [...sessions].reverse().map((s) => ({
            workoutId: s.workoutId,
            startedAt: s.startedAt,
            best: bests(s.best),
          })),
        })),
      });
    },
  );

  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description: "Routine folders and routines in their order, with each routine's exercises.",
      annotations: readOnly,
    },
    async () => {
      const view = await load(["routine", "routine_folder"]);
      const byPosition = (a: Shown, b: Shown) =>
        Number(a.content.position) - Number(b.content.position) || (a.id < b.id ? -1 : 1);
      return ok({
        folders: [...view.list("routine_folder")].sort(byPosition).map(record),
        routines: [...view.list("routine")].sort(byPosition).map((routine) => ({
          id: routine.id,
          revision: routine.revision,
          title: routine.content.title,
          folderId: routine.content.folderId,
          position: routine.content.position,
          exercises: (Array.isArray(routine.content.exercises)
            ? routine.content.exercises
            : []
          ).map((e) => {
            const exercise = e as { exerciseId: string; exerciseName: string; sets: unknown[] };
            return {
              exerciseId: exercise.exerciseId,
              name: exercise.exerciseName,
              sets: exercise.sets.length,
            };
          }),
        })),
      });
    },
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get a routine",
      description: `One routine in full, with its exercises and target sets. ${UNITS}`,
      inputSchema: z.object({ id: z.string().min(1).describe("The routine id") }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const view = await load(["routine"]);
      const routine = view.get("routine", id);
      if (!routine) return refuse(`No routine ${id}. list_routines shows the routines there are.`);
      return ok({ routine: record(routine) });
    },
  );

  server.registerTool(
    "list_exercise_notes",
    {
      title: "List exercise notes",
      description:
        "Notes on exercises with their comments, newest first. Pinned notes show again each time " +
        "the exercise comes up.",
      inputSchema: z.object({
        exerciseId: z.string().min(1).optional().describe("Only notes on this exercise"),
        pinnedOnly: z.boolean().default(false),
      }),
      annotations: readOnly,
    },
    async ({ exerciseId, pinnedOnly }) => {
      const view = await load(noteKinds);
      const notes = view
        .list("exercise_note")
        .filter((n) => exerciseId === undefined || n.content.exerciseId === exerciseId)
        .filter((n) => !pinnedOnly || n.content.pinned === true)
        .sort((a, b) => (String(a.content.createdAt) < String(b.content.createdAt) ? 1 : -1));
      return ok({ notes: notes.map(withComments(view, "exercise_note_comment")) });
    },
  );

  server.registerTool(
    "list_body_measurements",
    {
      title: "List body measurements",
      description: `Body measurements newest first: bodyweight in kg and body fat in percent. ${UNITS}`,
      inputSchema: z.object({ ...range, limit: z.number().int().min(1).max(500).default(100) }),
      annotations: readOnly,
    },
    async ({ from, to, limit }) => {
      const view = await load(["body_measurement"]);
      const taken = (m: Shown) => Date.parse(String(m.content.takenAt));
      const measurements = view
        .list("body_measurement")
        .filter((m) => inRange(taken(m), from, to))
        .sort((a, b) => taken(b) - taken(a))
        .slice(0, limit);
      return ok({ measurements: measurements.map(record) });
    },
  );
}
