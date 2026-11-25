import { type JsonObject, jsonEqual, MAX_POSITION } from "@leve/contract";
import { LIMITS } from "@leve/core";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import { autoTitle, emptyWorkoutSet, entryContent, startWorkout } from "../model/live.ts";
import { missingMeasurements, setRangeError } from "../model/log-values.ts";
import type { Routine, Workout, WorkoutEntry, WorkoutSet } from "../model/types.ts";
import { pickerLibrary } from "./custom-exercises.ts";
import type { BuiltInExercise } from "./exercises.ts";
import { newId } from "./ids.ts";
import { parseRestSeconds } from "./settings-actions.ts";

// Changes to a workout in progress. Every change is stored at once, so a restart shows the workout
// exactly as it was; the screens call these through `change()` so they render again.

/** A change the user can fix, with a message to show. */
export class WorkoutActionError extends Error {
  override name = "WorkoutActionError";
}

const asJson = (value: object) => value as unknown as JsonObject;

const content = <T>(store: DeviceStore, kind: string, id: string): T => {
  const record = store.get(kind, id);
  if (!record?.content || record.deleted) throw new Error(`${kind}/${id} doesn't exist`);
  return record.content as unknown as T;
};

/** Starts a workout, or returns the one already running: a device runs one at a time. */
export function beginWorkout(store: DeviceStore, routineId?: string): string {
  const running = store.activeWorkout();
  if (running) return running.id;
  const { id, records } = workoutStart(store, routineId);
  store.putMany(records);
  return id;
}

/**
 * Starts the routine, refusing while any workout is running (where `beginWorkout` would open that
 * one instead): the person asked for this routine.
 */
export function beginRoutineWorkout(store: DeviceStore, routineId: string): string {
  if (store.activeWorkout())
    throw new WorkoutActionError("Another workout is running. Finish or discard it first.");
  const { id, records } = workoutStart(store, routineId);
  store.putMany(records);
  return id;
}

/** The records a new workout starts with, from the routine when there is one, not yet stored. */
export function workoutStart(store: DeviceStore, routineId?: string) {
  if (routineId) {
    const routine = store.get("routine", routineId);
    if (!routine?.content || routine.deleted)
      throw new WorkoutActionError("This routine no longer exists.");
  }
  const routine = routineId
    ? { id: routineId, content: content<Routine>(store, "routine", routineId) }
    : undefined;
  const started = startWorkout({ ...(routine ? { routine } : {}), now: Date.now(), newId });
  return {
    id: started.workout.id,
    records: [
      { kind: "workout", id: started.workout.id, content: asJson(started.workout.content) },
      ...started.entries.map(({ id, content }) => ({
        kind: "workout_exercise",
        id,
        content: entryContent(content),
      })),
      ...started.sets.map(({ id, content }) => ({
        kind: "workout_set",
        id,
        content: asJson(content),
      })),
    ],
  };
}

export function canRecordSetReserve(store: DeviceStore, scale: "rir" | "rpe" = "rir"): boolean {
  const { account, release, refreshFrom, restoring } = store.syncState();
  return (
    account === null ||
    (!refreshFrom &&
      !restoring &&
      release !== null &&
      store.contract.featureAvailable(scale === "rpe" ? "rpe" : "reps_in_reserve", release))
  );
}

function checkReserveWrite(store: DeviceStore, reserve: WorkoutSet["repsInReserve"]) {
  if (reserve !== undefined && !canRecordSetReserve(store)) {
    throw new WorkoutActionError(
      "Finish syncing with a compatible server to edit reps in reserve.",
    );
  }
}

function editableSet(store: DeviceStore, setId: string): WorkoutSet {
  const set = store.get("workout_set", setId);
  if (set?.status === "conflict")
    throw new WorkoutActionError("Review the conflicting set before changing it.");
  if (!set?.content || set.deleted) throw new WorkoutActionError("This set no longer exists.");
  return set.content as unknown as WorkoutSet;
}

type OpenedSet = {
  expectedVersion?: string;
  id: string;
  values: WorkoutSet;
  parent: JsonObject | null;
  exerciseType: string;
};

function checkSetExercise(
  store: DeviceStore,
  setId: string,
  latest: WorkoutSet,
  opened: OpenedSet,
) {
  const parent = store.get("workout_exercise", latest.workoutExerciseId);
  if (
    opened.id !== setId ||
    latest.workoutExerciseId !== opened.values.workoutExerciseId ||
    !opened.parent ||
    !parent?.content ||
    parent.deleted ||
    parent.content.workoutId !== opened.parent.workoutId ||
    parent.content.exerciseId !== opened.parent.exerciseId ||
    parent.content.exerciseType !== opened.exerciseType
  )
    throw new WorkoutActionError("This exercise changed. Reopen the set to see the latest values.");
}

export function updateSet(
  store: DeviceStore,
  setId: string,
  patch: Partial<WorkoutSet>,
  opened?: OpenedSet,
): void {
  checkReserveWrite(store, patch.repsInReserve);
  if (patch.rpe !== undefined && !canRecordSetReserve(store, "rpe"))
    throw new WorkoutActionError("Finish syncing with a compatible server to edit RPE.");
  const latest = editableSet(store, setId);
  if (opened) {
    checkSetExercise(store, setId, latest, opened);
    const fields = Object.keys(patch) as (keyof WorkoutSet)[];
    if (
      (latest.completedAt ?? null) !== (opened.values.completedAt ?? null) ||
      fields.some(
        (field) =>
          (latest[field] ?? null) !== (opened.values[field] ?? null) &&
          (latest[field] ?? null) !== (patch[field] ?? null),
      )
    )
      throw new WorkoutActionError("This set changed. Reopen the set to see the latest values.");
    if (fields.every((field) => latest[field] === patch[field])) return;
  }
  const updated = { ...latest, ...patch };
  const error = setRangeError(updated);
  if (error) throw new WorkoutActionError(error);
  store.put("workout_set", setId, asJson(updated), opened?.expectedVersion);
}

export function logSet(
  store: DeviceStore,
  setId: string,
  values: Partial<WorkoutSet>,
  opened?: OpenedSet,
): void {
  updateSet(store, setId, { ...values, completedAt: new Date().toISOString() }, opened);
}

export function unlogSet(store: DeviceStore, setId: string): void {
  updateSet(store, setId, { completedAt: null });
}

/** Adds a set after the entry's last one, with the same type and weight. */
export function addSet(store: DeviceStore, entryId: string): string {
  const sets = store.list("workout_set", { parentId: entryId });
  const last = sets.at(-1)?.content as WorkoutSet | undefined;
  const id = newId();
  const writes: WorkoutWrite[] = [];
  const position = appendPosition(sets, writes);
  writes.push({
    kind: "workout_set",
    id,
    content: asJson({
      ...emptyWorkoutSet(entryId),
      position,
      type: last?.type === "warmup" ? "normal" : (last?.type ?? "normal"),
      weightKg: last?.weightKg ?? null,
    } satisfies WorkoutSet),
  });
  store.putMany(writes);
  return id;
}

type WorkoutWrite = { kind: string; id: string; content: JsonObject };

function appendPosition(rows: DeviceRecord[], writes: WorkoutWrite[], count = 1) {
  const next = Number(rows.at(-1)?.content?.position ?? 0) + 1;
  if (next + count - 1 <= MAX_POSITION) return next;
  if (rows.length + count > MAX_POSITION) throw new WorkoutActionError("This workout is full.");
  for (const [index, row] of rows.entries()) {
    if (!row.content || row.content.position === index + 1) continue;
    if (row.inFlight || row.fromRestore || (row.status !== "synced" && row.status !== "pending"))
      throw new WorkoutActionError("Resolve the sync issue before changing this workout’s order.");
    writes.push({ kind: row.kind, id: row.id, content: { ...row.content, position: index + 1 } });
  }
  return rows.length + 1;
}

function workoutEntry(
  workoutId: string,
  exercise: BuiltInExercise,
  position: number,
  restSeconds: number,
): WorkoutEntry {
  return {
    workoutId,
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    exerciseType: exercise.type,
    position,
    supersetId: null,
    restSeconds,
    doubleDumbbellVolume: false,
  };
}

/** Save a missed set of an exercise already in a finished workout. */
export function addHistoricalSet(
  store: DeviceStore,
  workoutId: string,
  expectedType: string,
  set: { id: string; content: WorkoutSet },
  openedEntry?: JsonObject | null,
) {
  checkReserveWrite(store, set.content.repsInReserve);
  const entryId = set.content.workoutExerciseId;
  const workout = content<Workout>(store, "workout", workoutId);
  if (!workout.endedAt)
    throw new WorkoutActionError("The workout or exercise changed. Reopen it to add a set.");
  if (store.get("workout_set", set.id))
    throw new WorkoutActionError("This set has already been saved.");
  const writes: WorkoutWrite[] = [];
  const entry = content<WorkoutEntry>(store, "workout_exercise", entryId);
  if (
    entry.workoutId !== workoutId ||
    entry.exerciseType !== expectedType ||
    (openedEntry !== undefined && entry.exerciseId !== openedEntry?.exerciseId)
  )
    throw new WorkoutActionError("The workout or exercise changed. Reopen it to add a set.");
  const position = appendPosition(store.list("workout_set", { parentId: entryId }), writes);
  const logged = { ...set.content, position, completedAt: workout.endedAt, planSlot: null };
  const error = historicalSetError(expectedType, logged);
  if (error) throw new WorkoutActionError(error);
  writes.push({ kind: "workout_set", id: set.id, content: asJson(logged) });
  store.putMany(writes);
}

/** Why a set logged after the fact can't be saved, if it can't. */
function historicalSetError(type: string, logged: WorkoutSet): string | undefined {
  const missing = missingMeasurements(type, logged);
  if (missing.includes("reps")) return "Enter reps to log this set.";
  if (missing.includes("duration")) return "Enter a time to log this set.";
  if (type === "weight_distance" && logged.distanceMeters === null && logged.weightKg === null)
    return "Enter a weight or distance to log this set.";
  return setRangeError(logged);
}

export type HistoricalExercise = {
  /** The new entry's id, chosen when the sets were drafted so a repeated save can't add it twice. */
  entryId: string;
  exercise: BuiltInExercise;
  sets: { id: string; content: WorkoutSet }[];
};

/**
 * Add exercises missing from a finished workout, each with the sets done, in a single local
 * transaction. The sets are stamped with the workout's finish time, as single missed sets are.
 * Nothing is saved unless every exercise still matches the library and every set is valid.
 */
export function addHistoricalExercises(
  store: DeviceStore,
  workoutId: string,
  additions: readonly HistoricalExercise[],
) {
  if (!additions.length) throw new WorkoutActionError("Select an exercise to add.");
  const workout = content<Workout>(store, "workout", workoutId);
  if (!workout.endedAt)
    throw new WorkoutActionError("The workout changed. Reopen it to add exercises.");
  const library = new Map(pickerLibrary(store).map((row) => [row.id, row]));
  const writes: WorkoutWrite[] = [];
  const first = appendPosition(
    store.list("workout_exercise", { parentId: workoutId }),
    writes,
    additions.length,
  );
  const ids = new Set<string>();
  for (const [index, { entryId, exercise: choice, sets }] of additions.entries()) {
    const exercise = library.get(choice.id);
    if (!exercise || exercise.name !== choice.name || exercise.type !== choice.type)
      throw new WorkoutActionError(`${choice.name} changed. Choose it again from the library.`);
    if (!sets.length) throw new WorkoutActionError(`Enter a set for ${exercise.name}.`);
    for (const id of [entryId, ...sets.map((set) => set.id)]) {
      if (ids.has(id) || store.get("workout_exercise", id) || store.get("workout_set", id))
        throw new WorkoutActionError("These exercises have already been saved.");
      ids.add(id);
    }
    writes.push({
      kind: "workout_exercise",
      id: entryId,
      content: entryContent(workoutEntry(workoutId, exercise, first + index, 0)),
    });
    for (const [position, set] of sets.entries()) {
      checkReserveWrite(store, set.content.repsInReserve);
      const logged: WorkoutSet = {
        ...set.content,
        workoutExerciseId: entryId,
        position: position + 1,
        completedAt: workout.endedAt,
        planSlot: null,
      };
      const error = historicalSetError(exercise.type, logged);
      if (error) throw new WorkoutActionError(`${exercise.name}, set ${position + 1}: ${error}`);
      writes.push({ kind: "workout_set", id: set.id, content: asJson(logged) });
    }
  }
  store.putMany(writes);
}

function appendExercises(
  store: DeviceStore,
  workoutId: string,
  entries: { id: string; exercise: BuiltInExercise }[],
  defaultRestSeconds: number,
) {
  const writes: WorkoutWrite[] = [];
  const first = appendPosition(
    store.list("workout_exercise", { parentId: workoutId }),
    writes,
    entries.length,
  );
  const rest = workoutRest(store, workoutId) ?? defaultRestSeconds;
  for (const [index, { id, exercise }] of entries.entries()) {
    writes.push(
      {
        kind: "workout_exercise",
        id,
        content: entryContent(workoutEntry(workoutId, exercise, first + index, rest)),
      },
      { kind: "workout_set", id: newId(), content: asJson(emptyWorkoutSet(id)) },
    );
  }
  store.putMany(writes);
}

/** Adds an exercise at the end of the workout, with one empty set. */
export function addExercise(
  store: DeviceStore,
  workoutId: string,
  exercise: BuiltInExercise,
  defaultRestSeconds: number,
): string {
  const id = newId();
  appendExercises(store, workoutId, [{ id, exercise }], defaultRestSeconds);
  return id;
}

/** Resolve the picker choices against the current catalog, then save the ordered batch together. */
export function addSelectedExercises(
  store: DeviceStore,
  workoutId: string,
  selected: readonly BuiltInExercise[],
  defaultRestSeconds: number,
): string[] {
  if (!selected.length) throw new WorkoutActionError("Select an exercise to add.");
  if (content<Workout>(store, "workout", workoutId).endedAt)
    throw new WorkoutActionError("This workout has finished.");
  const library = new Map(pickerLibrary(store).map((exercise) => [exercise.id, exercise]));
  const entries = selected.map((choice) => {
    const exercise = library.get(choice.id);
    if (!exercise || exercise.type !== choice.type || exercise.name !== choice.name)
      throw new WorkoutActionError(`${choice.name} changed. Review your selection and try again.`);
    return { id: newId(), exercise };
  });
  appendExercises(store, workoutId, entries, defaultRestSeconds);
  return entries.map(({ id }) => id);
}

function activeEntry(store: DeviceStore, workoutId: string, entryId: string) {
  const entry = content<WorkoutEntry>(store, "workout_exercise", entryId);
  if (entry.workoutId !== workoutId || content<Workout>(store, "workout", workoutId).endedAt) {
    throw new WorkoutActionError("This exercise is no longer in the current workout.");
  }
  return entry;
}

/** Add to this session’s entry, retaining cues already on the template or appended after the editor opened. */
export function addExerciseNote(
  store: DeviceStore,
  workoutId: string,
  entryId: string,
  text: string,
) {
  const entry = activeEntry(store, workoutId, entryId);
  const row = store.get("workout_exercise", entryId);
  if (row?.problem || row?.fromRestore || row?.status === "conflict")
    throw new WorkoutActionError("Resolve the sync issue on this exercise before adding a note.");
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > LIMITS.noteLength)
    throw new WorkoutActionError(`Enter a note of 1–${LIMITS.noteLength} characters.`);
  const notes = entry.notes ?? [];
  if (notes.length >= 100) throw new WorkoutActionError("This exercise already has 100 notes.");
  store.put(
    "workout_exercise",
    entryId,
    asJson({
      ...entry,
      notes: [...notes, { id: newId(), text: trimmed, createdAt: new Date().toISOString() }],
    }),
  );
}

/** Set the timer for subsequent sets of this exercise in the running workout. */
export function setExerciseRest(
  store: DeviceStore,
  workoutId: string,
  entryId: string,
  text: string,
  originalSeconds?: number,
) {
  const entry = activeEntry(store, workoutId, entryId);
  const restSeconds = parseRestSeconds(text);
  if (restSeconds === null) throw new WorkoutActionError("Enter 0–3600 seconds of rest.");
  if (restSeconds === entry.restSeconds) return;
  if (originalSeconds !== undefined && originalSeconds !== entry.restSeconds)
    throw new WorkoutActionError(
      "Exercise rest changed. Reopen the exercise controls to see the latest time.",
    );
  store.put("workout_exercise", entryId, asJson({ ...entry, restSeconds }));
}

/** Reorder the actual entries. Their sets and original routine targets follow their stable IDs. */
export function moveWorkoutExercise(
  store: DeviceStore,
  workoutId: string,
  entryId: string,
  direction: -1 | 1,
) {
  activeEntry(store, workoutId, entryId);
  const entries = store.list("workout_exercise", { parentId: workoutId });
  const from = entries.findIndex((item) => item.id === entryId);
  const to = from + direction;
  const moved = entries[from];
  if (!moved || !entries[to]) return;
  entries.splice(from, 1);
  entries.splice(to, 0, moved);
  const before = entries[to - 1]?.content?.position;
  const after = entries[to + 1]?.content?.position;
  const low = typeof before === "number" ? before : -MAX_POSITION;
  const high = typeof after === "number" ? after : MAX_POSITION;
  const position =
    before === undefined ? high - 1 : after === undefined ? low + 1 : (low + high) / 2;
  if (low < position && position < high && moved.content) {
    store.put("workout_exercise", entryId, { ...moved.content, position });
    return;
  }
  // Adjacent ties, exhausted floating-point precision, or the protocol bound leave no gap.
  store.putMany(
    entries.flatMap((entry, i) =>
      entry.content && entry.content.position !== i + 1
        ? [
            {
              kind: "workout_exercise",
              id: entry.id,
              content: { ...entry.content, position: i + 1 },
            },
          ]
        : [],
    ),
  );
}

export function exerciseRemovalSnapshot(store: DeviceStore, entryId: string) {
  return {
    entry: store.get("workout_exercise", entryId),
    sets: store.list("workout_set", { parentId: entryId }),
    server: store.serverDescendants("workout_exercise", entryId),
  };
}

export function removeWorkoutExercise(
  store: DeviceStore,
  workoutId: string,
  entryId: string,
  reviewed?: ReturnType<typeof exerciseRemovalSnapshot>,
) {
  activeEntry(store, workoutId, entryId);
  if (reviewed && !jsonEqual(reviewed, exerciseRemovalSnapshot(store, entryId)))
    throw new WorkoutActionError("The exercise changed. Review it before removing it.");
  store.delete("workout_exercise", entryId);
}

/**
 * When a workout that started at `startedAt` ends if it lasted `seconds`: never before its start
 * and never after now, or the duration is refused.
 */
export function durationEnd(startedAt: string, seconds: number, now = Date.now()): string {
  const end = Date.parse(startedAt) + seconds * 1000;
  if (!Number.isFinite(end) || seconds < 0 || end > now)
    throw new WorkoutActionError("Enter a duration that ends between the workout start and now.");
  return new Date(end).toISOString();
}

/**
 * Ends the workout now, or after `durationSeconds` when the lifter set how long it lasted (see
 * durationEnd). Provisional rules: sets that were never logged are removed, and so are local-only
 * exercises left without sets; an untitled workout is named after the time of day it started.
 */
export function finishWorkout(
  store: DeviceStore,
  workoutId: string,
  details: Partial<Pick<Workout, "title" | "description">> & {
    countForRoutine: boolean;
    durationSeconds?: number;
  },
  original?: Partial<Pick<Workout, "title" | "description" | "startedAt" | "endedAt">>,
): void {
  const workout = content<Workout>(store, "workout", workoutId);
  if (workout.endedAt) throw new WorkoutActionError("This workout has already finished.");
  if (original) checkWorkoutDraft(workout, original, details);
  const endedAt =
    details.durationSeconds === undefined
      ? new Date(Math.max(Date.now(), Date.parse(workout.startedAt))).toISOString()
      : durationEnd(workout.startedAt, details.durationSeconds);
  const entries = store.list("workout_exercise", { parentId: workoutId });
  const removals: { kind: string; id: string }[] = [];
  let hasLoggedSet = false;
  for (const entry of entries) {
    const sets = store.list("workout_set", { parentId: entry.id });
    const unlogged = sets.filter((set) => !set.content?.completedAt);
    const empty = unlogged.length === sets.length;
    hasLoggedSet ||= !empty;
    if (
      (empty && (entry.problem || entry.inFlight)) ||
      unlogged.some((set) => set.problem || set.inFlight)
    ) {
      throw new WorkoutActionError(
        "Finish syncing and review workout or set conflicts before finishing.",
      );
    }
    // A shared entry can gain a corrected or entirely new set after Finish, even while offline.
    // Keep the entry and delete each skipped set against its own revision.
    const hasNotes = Array.isArray(entry.content?.notes) && entry.content.notes.length > 0;
    if (empty && !hasNotes && store.isLocalOnlyTree("workout_exercise", entry.id)) {
      removals.push({ kind: "workout_exercise", id: entry.id });
    } else {
      for (const set of unlogged) removals.push({ kind: "workout_set", id: set.id });
    }
  }
  if (!hasLoggedSet) throw new WorkoutActionError("Log at least one set, or discard the workout.");
  if (store.get("workout", workoutId)?.problem)
    throw new WorkoutActionError("Review the workout sync issue before finishing.");
  const finished: Workout = {
    ...workout,
    title:
      (details.title?.trim().slice(0, LIMITS.titleLength) ?? workout.title) ||
      autoTitle(workout.startedAt),
    description:
      details.description?.trim().slice(0, LIMITS.descriptionLength) ?? workout.description,
    routineId: details.countForRoutine ? workout.routineId : null,
    endedAt,
  };
  store.putAndDelete([{ kind: "workout", id: workoutId, content: asJson(finished) }], removals);
}

/** Deletes the workout and everything in it. */
export function discardWorkout(store: DeviceStore, workoutId: string): void {
  store.delete("workout", workoutId);
}

/** A stale screen must never discard a finished or replacement session. */
export function discardActiveWorkout(store: DeviceStore, workoutId: string) {
  checkActiveDiscard(store, workoutId);
  discardWorkout(store, workoutId);
}

/** Refuses unless the workout is the active one and can be discarded as it stands. */
export function checkActiveDiscard(store: DeviceStore, workoutId: string) {
  const active = store.activeWorkout();
  if (
    active?.id !== workoutId ||
    active.status === "conflict" ||
    (active.server && (active.server.state !== "live" || active.server.content?.endedAt != null))
  )
    throw new WorkoutActionError("The active workout changed. Review it before discarding.");
}

type WorkoutDetailsPatch = Partial<Pick<Workout, "title" | "description">> & {
  durationSeconds?: number;
};

function checkWorkoutDraft(
  workout: Workout,
  original: Partial<Workout>,
  patch: WorkoutDetailsPatch,
) {
  const changed = (["title", "description"] as const).some(
    (field) => patch[field] !== undefined && workout[field] !== original[field],
  );
  if (
    changed ||
    (patch.durationSeconds !== undefined &&
      (workout.startedAt !== original.startedAt || workout.endedAt !== original.endedAt))
  )
    throw new WorkoutActionError(
      "Workout details changed. Reopen the editor to see the latest version.",
    );
}

export function workoutRest(store: DeviceStore, id: string): number | null {
  const row = store.get("workout_rest", id);
  return typeof row?.content?.seconds === "number" && !row.deleted ? row.content.seconds : null;
}

export function workoutRestReadOnlyReason(store: DeviceStore): string | null {
  const { account, release, refreshFrom, restoring } = store.syncState();
  if (account === null) return null;
  if (!release || !store.contract.featureAvailable("workout_rest", release))
    return "Update the connected server to change workout rest.";
  if (restoring || refreshFrom) return "Workout rest will be editable when this sync finishes.";
  return null;
}

interface WorkoutRestEdit {
  originalSeconds: number | null;
  seconds: number | null;
  /** Entry IDs and rest values seen when the user opened the editor. */
  applyTo?: ReadonlyMap<string, number>;
}

/** Save only the running workout fields the lifter changed. */
export function updateRunningWorkoutDetails(
  store: DeviceStore,
  workoutId: string,
  original: Workout,
  patch: Partial<Pick<Workout, "title" | "description">>,
  rest?: WorkoutRestEdit,
) {
  const workout = content<Workout>(store, "workout", workoutId);
  if (workout.endedAt) throw new WorkoutActionError("This workout has already finished.");
  checkWorkoutDraft(workout, original, patch);
  const records = [];
  if (rest) {
    const reason = workoutRestReadOnlyReason(store);
    if (reason) throw new WorkoutActionError(reason);
    if (store.get("workout_rest", workoutId)?.status === "conflict")
      throw new WorkoutActionError("Review the sync issue before changing workout rest.");
    if (workoutRest(store, workoutId) !== rest.originalSeconds)
      throw new WorkoutActionError(
        "Workout rest changed. Reopen the editor to see the latest value.",
      );
    if (rest.seconds !== null && parseRestSeconds(String(rest.seconds)) !== rest.seconds)
      throw new WorkoutActionError("Enter 0–3600 seconds of rest.");
    if (rest.seconds !== rest.originalSeconds)
      records.push({
        kind: "workout_rest",
        id: workoutId,
        content: { workoutId, seconds: rest.seconds },
      });
    if (rest.applyTo) {
      if (rest.seconds === null)
        throw new WorkoutActionError("Enter a rest time to apply to the exercises already here.");
      const entries = store.list("workout_exercise", { parentId: workoutId });
      if (
        entries.length !== rest.applyTo.size ||
        entries.some((entry) => rest.applyTo?.get(entry.id) !== entry.content?.restSeconds)
      )
        throw new WorkoutActionError(
          "The exercises or their rest times changed. Reopen the editor before applying to all.",
        );
      for (const entry of entries) {
        if (entry.content && entry.content.restSeconds !== rest.seconds)
          records.push({
            kind: "workout_exercise",
            id: entry.id,
            content: { ...entry.content, restSeconds: rest.seconds },
          });
      }
    }
  }
  if (Object.keys(patch).length)
    records.push({
      kind: "workout",
      id: workoutId,
      content: asJson({
        ...workout,
        title: patch.title?.trim() ?? workout.title,
        description: patch.description?.trim() ?? workout.description,
      }),
    });
  if (records.length) store.putMany(records);
}

/** Correct only the saved workout fields the lifter edited. Keep the start time and routine link. */
export function updateWorkoutDetails(
  store: DeviceStore,
  workoutId: string,
  patch: WorkoutDetailsPatch,
  original?: Workout,
) {
  const workout = content<Workout>(store, "workout", workoutId);
  if (!workout.endedAt)
    throw new WorkoutActionError("Finish the workout before editing its details.");
  if (original) checkWorkoutDraft(workout, original, patch);
  const title = patch.title === undefined ? workout.title : patch.title.trim();
  if (patch.title !== undefined && !title) throw new WorkoutActionError("Enter a workout name.");
  let endedAt = workout.endedAt;
  if (patch.durationSeconds !== undefined)
    endedAt = durationEnd(workout.startedAt, patch.durationSeconds);
  store.put(
    "workout",
    workoutId,
    asJson({
      ...workout,
      title,
      endedAt,
      description: patch.description?.trim() ?? workout.description,
    }),
  );
}

export function removeWorkoutSet(store: DeviceStore, setId: string, opened?: OpenedSet) {
  const set = editableSet(store, setId);
  if (opened) {
    checkSetExercise(store, setId, set, opened);
    if (
      !jsonEqual(
        { ...set, completedAt: set.completedAt ?? null },
        { ...opened.values, completedAt: opened.values.completedAt ?? null },
      )
    )
      throw new WorkoutActionError("This set changed. Reopen the set before removing it.");
  }
  const entry = content<WorkoutEntry>(store, "workout_exercise", set.workoutExerciseId);
  const workout = content<Workout>(store, "workout", entry.workoutId);
  if (workout.endedAt && set.completedAt) {
    const entries = store.list("workout_exercise", { parentId: entry.workoutId });
    const others = store.list("workout_set", { parentIds: entries.map((item) => item.id) });
    if (!others.some((other) => other.id !== setId && other.content?.completedAt)) {
      throw new WorkoutActionError(
        "This is the only logged set. To remove the session, choose Delete workout in Edit workout.",
      );
    }
  }
  store.delete("workout_set", setId);
}
