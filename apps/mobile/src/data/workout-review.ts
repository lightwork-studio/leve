import { jsonEqual } from "@leve/contract";
import type { DeviceRecord, DeviceStore, Resolution } from "@leve/storage";
import { newId } from "./ids.ts";
import { rejectedWorkoutDeletion, reviewWorkoutId } from "./read.ts";
import { discardActiveWorkout, workoutRestReadOnlyReason } from "./workout-actions.ts";
import { workoutNoteReadOnlyReason } from "./workout-notes.ts";

export function unavailableReviewFields(store: DeviceStore, row: DeviceRecord) {
  const sync = store.syncState();
  const release = sync.release ?? store.contract.latest;
  const previous = sync.refreshFrom && store.contract.fieldNames(row.kind, sync.refreshFrom);
  const known = store.contract
    .fieldNames(row.kind, release)
    .filter((field) => !previous || previous.includes(field));
  if (row.deleted)
    return store.contract
      .fieldNames(row.kind, store.contract.latest)
      .filter((field) => !known.includes(field));
  return [...new Set([...row.partialFields, ...Object.keys(row.content ?? {})])].filter(
    (field) =>
      !known.includes(field) &&
      (row.partialFields.includes(field) ||
        !jsonEqual(row.content?.[field] ?? null, row.server?.content?.[field] ?? null)),
  );
}

function checkedWorkoutDetail(store: DeviceStore, workoutId: string, shown: DeviceRecord) {
  if (!["workout", "workout_note", "workout_rest", "workout_exercise"].includes(shown.kind))
    throw Error("Unknown workout detail.");
  const row = store.get(shown.kind, shown.id);
  if (
    !row ||
    (row.kind === "workout" ? row.id : reviewWorkoutId(row)) !== workoutId ||
    !row.problem ||
    !jsonEqual(row, shown)
  )
    throw Error("This record changed. Review the latest versions before choosing.");
  const reason =
    row.kind === "workout_note"
      ? workoutNoteReadOnlyReason(store)
      : row.kind === "workout_rest"
        ? workoutRestReadOnlyReason(store)
        : null;
  if (reason) throw Error(reason);
  if (row.inFlight) throw Error("Finish the current sync before choosing a version.");
  return row;
}

export function workoutDeletionSnapshot(store: DeviceStore, workoutId: string) {
  const owner = store.get("workout", workoutId);
  if (!owner?.content) return null;
  const entries = store.list("workout_exercise", { parentId: workoutId });
  return {
    owner,
    serverDescendants: store.serverDescendants("workout", workoutId),
    entries,
    sets: store.list("workout_set", { parentIds: entries.map((entry) => entry.id) }),
    notes: store.list("workout_note", { parentId: workoutId }),
    rest: store.get("workout_rest", workoutId),
  };
}

export function discardReviewedActiveWorkout(
  store: DeviceStore,
  id: string,
  reviewed: ReturnType<typeof workoutDeletionSnapshot>,
) {
  if (!reviewed || !jsonEqual(reviewed, workoutDeletionSnapshot(store, id)))
    throw Error("The active workout changed. Review it before discarding.");
  discardActiveWorkout(store, id);
}

export function deletedWorkoutReview(store: DeviceStore, workoutId: string) {
  const owner = store.get("workout", workoutId);
  return owner?.status === "conflict" && owner.server?.state === "deleted"
    ? workoutDeletionSnapshot(store, workoutId)
    : null;
}

export function recoverDeletedWorkout(
  store: DeviceStore,
  workoutId: string,
  shown: DeviceRecord,
  reviewed: NonNullable<ReturnType<typeof deletedWorkoutReview>>,
  choice: "save_as_new" | "keep_theirs",
) {
  checkedWorkoutDetail(store, workoutId, shown);
  if (reviewed.owner.inFlight || !jsonEqual(reviewed, deletedWorkoutReview(store, workoutId)))
    throw Error("The workout changed. Review the latest version before choosing.");
  return store.resolve(
    "workout",
    workoutId,
    choice === "save_as_new" ? { choice, newId: newId() } : { choice },
  );
}

/** Discarding this entry removes its retained sets together with it. */
export function exerciseDeletionSets(store: DeviceStore, row: DeviceRecord) {
  if (
    row.kind !== "workout_exercise" ||
    (row.server?.state !== "deleted" && (row.server || row.keptContent))
  )
    return null;
  return store.list("workout_set", { parentId: row.id });
}

export function needsExerciseRestore(row: DeviceRecord) {
  return row.kind === "workout_exercise" && row.deleted && row.server?.state === "live";
}

export function workoutRestoreBlocked(store: DeviceStore, row: DeviceRecord) {
  if (
    row.kind === "workout" &&
    (row.deleted || row.content?.endedAt != null) &&
    (row.server ? row.server.content : row.keptContent)?.endedAt === null &&
    store.activeWorkout()
  )
    return "Finish or discard the current workout before restoring this unfinished workout.";
  return null;
}

export function resolveWorkoutRecord(
  store: DeviceStore,
  workoutId: string,
  shown: DeviceRecord,
  choice: Resolution["choice"],
  reviewedSets?: DeviceRecord[] | null,
) {
  const row = checkedWorkoutDetail(store, workoutId, shown);
  const blocked = choice === "keep_theirs" && workoutRestoreBlocked(store, row);
  if (blocked) throw Error(blocked);
  if (rejectedWorkoutDeletion(row)) {
    if (choice !== "keep_theirs" || store.syncState().restoring || store.syncState().refreshFrom)
      throw Error("Finish syncing and restore the workout before reviewing its current contents.");
    return store.resolve("workout", workoutId, { choice });
  }
  if (
    row.kind === "workout" &&
    (!row.content ||
      row.server?.state !== "live" ||
      row.status !== "conflict" ||
      store.syncState().restoring ||
      unavailableReviewFields(store, row).length > 0 ||
      choice === "save_as_new")
  )
    throw Error("Review the current workout before choosing.");
  if (row.problem?.reason === "parent_deleted" || deletedWorkoutReview(store, workoutId))
    throw Error("Review the deleted workout to keep or discard its changes.");
  if (needsExerciseRestore(row) && choice !== "keep_theirs")
    throw Error("Restore this exercise and review its current sets before deleting it.");
  const sets = exerciseDeletionSets(store, row);
  if (sets && (!reviewedSets || !jsonEqual(sets, reviewedSets)))
    throw Error("The retained sets changed. Review them before choosing.");
  return store.resolve(
    row.kind,
    row.id,
    choice === "save_as_new" ? { choice, newId: newId() } : { choice },
  );
}
