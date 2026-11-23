// What screens show, read from the device store. Pure functions, so they run in tests as they do
// in the app; the hooks in queries.ts call them.
import { defaultSettings, type Exercise } from "@leve/core";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { workoutAsSaved } from "../model/finish-preview.ts";
import { type TargetLookup, workoutMuscleSets } from "../model/muscle-map.ts";
import { groupByMonth, summarize, type WorkoutTree } from "../model/past-workouts.ts";
import { buildProgress, recordsByWorkout, workoutRecords } from "../model/progress.ts";
import { compareBarcodes, versusLastTime } from "../model/session-compare.ts";
import { routineGroups, startOfWeek, upNextRoutine, weekSummary } from "../model/train.ts";
import type {
  Folder,
  Routine,
  Settings,
  WithId,
  Workout,
  WorkoutEntry,
  WorkoutNote,
  WorkoutSet,
} from "../model/types.ts";
import { bestSet, loggedExercises } from "../model/workout-done.ts";
import { carriedWorkoutNotes, journalSessionNumbers } from "../model/workout-notes.ts";
import { builtInExercise, builtInTargets } from "./exercises.ts";
import { withoutHeldSet } from "./set-removal.ts";

function records<T>(store: DeviceStore, kind: string, parentId?: string): WithId<T>[] {
  return store
    .list(kind, parentId === undefined ? {} : { parentId })
    .map((record) => ({ id: record.id, content: record.content as unknown as T }));
}

/**
 * The settings record, or core's defaults while it is missing. Tracking reps in reserve is on only
 * when the record says so: a copy saved before the setting existed, or one that never set it, reads
 * as off.
 */
export function readSettings(store: DeviceStore): Settings {
  const defaults = defaultSettings();
  const content = store.get("settings", "settings")?.content as Partial<Settings> | undefined;
  return {
    weightUnit: defaults.weightUnit,
    distanceUnit: defaults.distanceUnit,
    shortDistanceUnit: defaults.shortDistanceUnit,
    measurementUnit: defaults.measurementUnit,
    firstWeekday: defaults.firstWeekday,
    defaultRestSeconds: defaults.defaultRestSeconds,
    countWarmups: defaults.countWarmups,
    previousValues: defaults.previousValues,
    ...content,
    trackRepsInReserve: content?.trackRepsInReserve === true,
  };
}

export function rejectedWorkoutDeletion(row: DeviceRecord) {
  const oversized =
    row.status === "invalid" && row.problem?.reason === "invalid:too_many_descendants";
  return (
    row.kind === "workout" &&
    row.deleted &&
    (row.server?.state === "live" ||
      (!row.server && !!row.keptContent && (row.problem?.reason === "restored" || oversized))) &&
    (row.status === "conflict" || oversized)
  );
}

export function reviewWorkoutId(row: DeviceRecord) {
  return row.content?.workoutId ?? row.server?.content?.workoutId ?? row.keptContent?.workoutId;
}

export function workoutDetailProblems(store: DeviceStore, workoutId: string) {
  return store
    .problems()
    .filter((row) =>
      row.kind === "workout"
        ? row.id === workoutId &&
          row.status === "conflict" &&
          !!row.content &&
          (row.server?.state === "live" || row.server?.state === "deleted")
        : row.kind === "workout_set"
          ? row.deleted &&
            row.status === "conflict" &&
            typeof row.server?.content?.workoutExerciseId === "string" &&
            store.get("workout_exercise", row.server.content.workoutExerciseId)?.content
              ?.workoutId === workoutId
          : row.kind === "workout_rest"
            ? row.id === workoutId
            : row.kind === "workout_exercise" && reviewWorkoutId(row) === workoutId,
    );
}

/** Notes need workout headers only, including sessions without notes which may have received a reply. */
export function workoutJournalData(
  store: DeviceStore,
  workoutId: string,
  { numberMatchingSessions = false } = {},
) {
  const row = store.get("workout", workoutId);
  if (!row?.content || row.deleted) return null;
  const workout = { id: workoutId, content: row.content as unknown as Workout };
  const notesByWorkout = new Map<string, WorkoutNote[]>();
  for (const { id, content } of records<Omit<WorkoutNote, "id"> & { workoutId: string }>(
    store,
    "workout_note",
  )) {
    const notes = notesByWorkout.get(content.workoutId) ?? [];
    notes.push({ ...content, id, reply: content.reply ?? null });
    notesByWorkout.set(content.workoutId, notes);
  }
  const notes = notesByWorkout.get(workoutId) ?? [];
  const hasOtherNotes = notesByWorkout.size > (notes.length ? 1 : 0);
  const workouts =
    hasOtherNotes || numberMatchingSessions ? records<Workout>(store, "workout") : [];
  const carried = hasOtherNotes ? carriedWorkoutNotes(workouts, workout, notesByWorkout) : [];
  const sessionNumbers = numberMatchingSessions ? journalSessionNumbers(workouts) : undefined;
  const rejected = store.problems().filter((item) => item.kind === "workout_note");
  const problems = rejected.filter((item) => reviewWorkoutId(item) === workoutId);
  const rejectedIds = new Set(rejected.map((item) => item.id));
  return { workout, notes, carried, problems, rejectedIds, sessionNumbers };
}

/** Older sets can omit the timestamp. Screens use null for an unfinished set. */
function displayedSet(record: DeviceRecord): WithId<WorkoutSet> {
  const content = record.content as unknown as WorkoutSet;
  return {
    id: record.id,
    content: content.completedAt === undefined ? { ...content, completedAt: null } : content,
  };
}

export function readWorkoutTree(store: DeviceStore, workoutId: string): WorkoutTree | null {
  const record = store.get("workout", workoutId);
  if (!record?.content || record.deleted) return null;
  const entries = records<WorkoutEntry>(store, "workout_exercise", workoutId);
  // Every entry's sets in one read, then shared out (in position order) by entry.
  const sets = new Map<string, WorkoutTree["entries"][number]["sets"]>();
  for (const record of store.list("workout_set", { parentIds: entries.map((e) => e.id) })) {
    const set = {
      ...displayedSet(record),
      ...(record.status === "conflict" &&
      (record.server?.state === "live" || record.server?.state === "deleted")
        ? { needsSyncReview: true as const }
        : {}),
    };
    const list = sets.get(set.content.workoutExerciseId) ?? [];
    list.push(set);
    sets.set(set.content.workoutExerciseId, list);
  }
  return {
    workout: { id: record.id, content: record.content as unknown as Workout },
    entries: entries.map((entry) => ({ entry, sets: sets.get(entry.id) ?? [] })),
  };
}

/** Every workout's tree from three reads, however long the history is. */
export function readAllWorkoutTrees(store: DeviceStore): WorkoutTree[] {
  const setsByEntry = new Map<string, WithId<WorkoutSet>[]>();
  for (const record of store.list("workout_set")) {
    const set = displayedSet(record);
    const list = setsByEntry.get(set.content.workoutExerciseId) ?? [];
    list.push(set);
    setsByEntry.set(set.content.workoutExerciseId, list);
  }
  const entriesByWorkout = new Map<string, WorkoutTree["entries"]>();
  for (const entry of records<WorkoutEntry>(store, "workout_exercise")) {
    const list = entriesByWorkout.get(entry.content.workoutId) ?? [];
    list.push({ entry, sets: setsByEntry.get(entry.id) ?? [] });
    entriesByWorkout.set(entry.content.workoutId, list);
  }
  return records<Workout>(store, "workout").map((workout) => ({
    workout,
    entries: entriesByWorkout.get(workout.id) ?? [],
  }));
}

function bodyweightMeasurements(store: DeviceStore) {
  return records<{ takenAt: string; bodyweightKg: number | null }>(store, "body_measurement")
    .flatMap(({ id, content: { takenAt, bodyweightKg } }) =>
      bodyweightKg === null ? [] : [{ id, at: Date.parse(takenAt), kg: bodyweightKg }],
    )
    .sort((a, b) => a.at - b.at);
}

/** Finds the latest bodyweight measured at or before a moment, after one read. */
export function bodyweightLookup(
  store: DeviceStore,
  measured = bodyweightMeasurements(store),
): (time: number) => number | null {
  return (time) => {
    let low = 0;
    let high = measured.length - 1;
    let found: number | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const m = measured[mid] as { at: number; kg: number };
      if (m.at <= time) {
        found = m.kg;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found;
  };
}

/** Whether an exercise's volume includes bodyweight: the custom exercise's flag, or the library's. */
export function bodyweightFlags(store: DeviceStore): (exerciseId: string) => boolean {
  const custom = new Map(
    records<{ usesBodyweight: boolean }>(store, "custom_exercise").map((e) => [
      e.id,
      e.content.usesBodyweight,
    ]),
  );
  return (id) => custom.get(id) ?? builtInExercise(id)?.usesBodyweight ?? false;
}

export function trainData(store: DeviceStore, now: number) {
  const settings = readSettings(store);
  const workouts = records<Workout>(store, "workout");
  const routines = records<Routine>(store, "routine");
  const folders = records<Folder>(store, "routine_folder");
  // Only this week's finished workouts are read in full, for the week's volume and sets.
  const weekStart = startOfWeek(now, settings.firstWeekday);
  const bodyweightAt = bodyweightLookup(store);
  const usesBodyweight = bodyweightFlags(store);
  const figures = new Map<string, { volumeKg: number; sets: number }>();
  for (const w of workouts) {
    if (w.content.endedAt === null || Date.parse(w.content.startedAt) < weekStart) continue;
    const tree = readWorkoutTree(store, w.id);
    if (!tree) continue;
    const { volumeKg, sets } = summarize(tree, {
      countWarmups: settings.countWarmups,
      bodyweightKg: bodyweightAt(Date.parse(w.content.startedAt)),
      usesBodyweight,
    });
    figures.set(w.id, { volumeKg, sets });
  }
  return {
    settings,
    week: weekSummary(workouts, now, settings.firstWeekday, (id) => figures.get(id)),
    groups: routineGroups(routines, folders, workouts, now),
    upNext: upNextRoutine(routines, folders, workouts),
    active: store.activeWorkout(),
  };
}

/** History: every finished workout by month. */
export function historyData(store: DeviceStore) {
  const settings = readSettings(store);
  const bodyweightAt = bodyweightLookup(store);
  const usesBodyweight = bodyweightFlags(store);
  const summaries = readAllWorkoutTrees(store)
    .filter((tree) => tree.workout.content.endedAt !== null)
    .map((tree) =>
      summarize(tree, {
        countWarmups: settings.countWarmups,
        bodyweightKg: bodyweightAt(Date.parse(tree.workout.content.startedAt)),
        usesBodyweight,
      }),
    );
  return {
    settings,
    rejectedDeletions: store.problems().filter(rejectedWorkoutDeletion),
    months: groupByMonth(summaries),
  };
}

function muscleLookup(
  store: DeviceStore,
  exercises = records<Exercise>(store, "custom_exercise"),
): TargetLookup {
  const custom = new Map(
    exercises.map(({ id, content }) => [
      id,
      { primaryMuscles: [content.primaryMuscle], secondaryMuscles: content.secondaryMuscles },
    ]),
  );
  return (id) => custom.get(id) ?? builtInTargets(id);
}

export function workoutDetail(store: DeviceStore, workoutId: string) {
  const tree = readWorkoutTree(store, workoutId);
  if (!tree) return null;
  const settings = readSettings(store);
  const summary = summarize(tree, {
    countWarmups: settings.countWarmups,
    bodyweightKg: bodyweightLookup(store)(Date.parse(tree.workout.content.startedAt)),
    usesBodyweight: bodyweightFlags(store),
  });
  return {
    tree,
    needsDetailReview: workoutDetailProblems(store, tree.workout.id).length > 0,
    settings,
    muscleSets: workoutMuscleSets(tree, settings.countWarmups, muscleLookup(store)),
    excludedWarmups: summary.excludedWarmups,
    routineTitle: tree.workout.content.initialPlan?.title ?? null,
    summary,
  };
}

/**
 * The previous finished session of the same routine as a workout, summarised, for "compared with
 * last time"; null when the workout has no routine or the routine has no earlier session.
 */
export function lastTime(store: DeviceStore, workoutId: string) {
  const workout = store.get("workout", workoutId)?.content as Workout | null | undefined;
  if (!workout?.routineId) return null;
  const startedAt = Date.parse(workout.startedAt);
  let latest: WithId<Workout> | null = null;
  for (const other of records<Workout>(store, "workout")) {
    const c = other.content;
    if (other.id === workoutId || c.routineId !== workout.routineId || c.endedAt === null) continue;
    const at = Date.parse(c.startedAt);
    if (at < startedAt && (!latest || at > Date.parse(latest.content.startedAt))) latest = other;
  }
  if (!latest) return null;
  return workoutDetail(store, latest.id)?.summary ?? null;
}

/** The workout in progress with what the screen needs around it, or null. */
export function liveData(store: DeviceStore) {
  const active = store.activeWorkout();
  if (!active) return null;
  const read = readWorkoutTree(store, active.id);
  if (!read) return null;
  // A set just removed is left out at once, while it can still be undone.
  const tree = withoutHeldSet(store, read);
  const settings = readSettings(store);
  const usesBodyweight = bodyweightFlags(store);
  const summary = summarize(tree, {
    countWarmups: settings.countWarmups,
    bodyweightKg: bodyweightLookup(store)(Date.parse(tree.workout.content.startedAt)),
    usesBodyweight,
  });
  // Past workouts (for previous values) are read separately: see usePastWorkouts.
  return {
    tree,
    needsDetailReview: workoutDetailProblems(store, tree.workout.id).length > 0,
    settings,
    initialPlan: tree.workout.content.initialPlan ?? null,
    summary,
    muscleSets: workoutMuscleSets(tree, settings.countWarmups, muscleLookup(store)),
  };
}

/**
 * Everything the progress screens show, from one read of the whole history: weekly figures, every
 * exercise's sessions and the latest bodyweight. The hooks share it until the data changes.
 */
export function progressData(store: DeviceStore) {
  const settings = readSettings(store);
  const measurements = bodyweightMeasurements(store);
  const bodyweightAt = bodyweightLookup(store, measurements);
  const index = buildProgress(readAllWorkoutTrees(store), {
    countWarmups: settings.countWarmups,
    bodyweightAt,
    usesBodyweight: bodyweightFlags(store),
  });
  const custom = records<Exercise>(store, "custom_exercise");
  const equipment = new Map(custom.map(({ id, content }) => [id, content.equipment]));
  return {
    settings,
    index,
    equipmentFor: (id: string) => equipment.get(id) ?? builtInExercise(id)?.equipment.toLowerCase(),
    muscleTargets: muscleLookup(store, custom),
    latestBodyweightKg: measurements.at(-1)?.kg ?? null,
    measurements,
  };
}

export type ProgressData = ReturnType<typeof progressData>;

const revisions = new WeakMap<DeviceStore, number>();
const progressCache = new WeakMap<DeviceStore, { version: number; data: ProgressData }>();

export function applyAppChange<T>(
  store: DeviceStore,
  write: (store: DeviceStore) => T,
  scope?: "active-workout",
) {
  const result = write(store);
  const historyVersion = (revisions.get(store) ?? 0) + (scope === "active-workout" ? 0 : 1);
  revisions.set(store, historyVersion);
  return { result, historyVersion };
}

export function sharedProgress(store: DeviceStore, version: number): ProgressData {
  const cached = progressCache.get(store);
  if (cached?.version === version) return cached.data;
  const data = progressData(store);
  progressCache.set(store, { version, data });
  return data;
}

/**
 * What finishing the workout in progress would show, worked out before it is saved: the workout
 * as it would be saved (see workoutAsSaved), its figures, the records it would set, how it compares
 * with last time, and its sets against last time's. Records and comparisons are judged against
 * every finished workout, exactly as they are once it is saved. Null without a workout in progress.
 */
export function finishPreview(store: DeviceStore, countForRoutine: boolean, now = Date.now()) {
  const active = store.activeWorkout();
  if (!active) return null;
  const live = readWorkoutTree(store, active.id);
  if (!live) return null;
  const tree = workoutAsSaved(live, { countForRoutine, now });
  const settings = readSettings(store);
  const measurements = bodyweightMeasurements(store);
  const bodyweightAt = bodyweightLookup(store, measurements);
  const usesBodyweight = bodyweightFlags(store);
  const index = buildProgress(
    [...readAllWorkoutTrees(store).filter(({ workout }) => workout.id !== tree.workout.id), tree],
    { countWarmups: settings.countWarmups, bodyweightAt, usesBodyweight },
  );
  const summary = summarize(tree, {
    countWarmups: settings.countWarmups,
    bodyweightKg: bodyweightAt(Date.parse(tree.workout.content.startedAt)),
    usesBodyweight,
  });
  // The routine's last session is only compared with when this one counts for the routine.
  const last = countForRoutine ? lastTime(store, tree.workout.id) : null;
  const held = recordsByWorkout(index).get(tree.workout.id) ?? [];
  const recordSets = new Set(held.flatMap((record) => (record.setId ? [record.setId] : [])));
  return {
    tree,
    summary,
    last,
    records: workoutRecords(index, tree),
    versus: versusLastTime(index, tree, summary, last),
    bars: compareBarcodes(index, tree, recordSets),
    best: bestSet(tree, settings.countWarmups),
    exercises: loggedExercises(tree),
  };
}
