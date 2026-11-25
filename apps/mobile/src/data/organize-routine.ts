import { type JsonObject, jsonEqual, MAX_POSITION } from "@leve/contract";
import { type EffortScale, LIMITS } from "@leve/core";
import type { DeviceStore } from "@leve/storage";

import { nextRoutinePosition, type StoredPlan } from "./routine-actions.ts";

export interface RoutineLocation {
  title: string;
  folderId: string | null;
  notes?: string;
  effortScale?: EffortScale | null;
}

/** Apply only the fields the user changed to the latest local copy. */
export function organizeRoutine(
  store: DeviceStore,
  id: string,
  opened: RoutineLocation,
  draft: RoutineLocation,
  plan?: { opened: StoredPlan; next: StoredPlan },
) {
  const rename = draft.title !== opened.title;
  const move = draft.folderId !== opened.folderId;
  const editPlan = plan && !jsonEqual(plan.opened, plan.next);
  const editNotes = draft.notes !== undefined && draft.notes !== opened.notes;
  const editScale = draft.effortScale !== undefined && draft.effortScale !== opened.effortScale;
  if (!rename && !move && !editPlan && !editNotes && !editScale) return;
  const record = store.get("routine", id);
  if (record?.deleted || !record?.content) throw new Error("This routine is no longer available.");
  if (record.problem || record.fromRestore)
    throw new Error("Resolve the sync issue on this routine before changing it.");
  const current = record.content;
  if (
    (rename && current.title !== opened.title) ||
    (move && current.folderId !== opened.folderId)
  ) {
    throw new Error("This routine changed. Reopen it to see the latest name and folder.");
  }
  const next = { ...current };
  if (editNotes) {
    if (current.notes !== opened.notes && current.notes !== draft.notes)
      throw new Error("The routine notes changed. Reopen the routine to see the latest notes.");
    next.notes = draft.notes;
  }
  if (editPlan || editScale) {
    if (
      (current.effortScale ?? null) !== (opened.effortScale ?? null) ||
      (plan && !jsonEqual(current.exercises, plan.opened))
    )
      throw new Error("The plan changed. Reopen the routine to see the latest exercises.");
  }
  if (editPlan) {
    if (!plan.next.length) throw new Error("Add an exercise to the routine.");
    next.exercises = plan.next;
  }
  if (editScale) next.effortScale = draft.effortScale;
  if (rename) {
    const title = draft.title.trim();
    if (!title || title.length > LIMITS.titleLength)
      throw new Error(`Enter a name of 1–${LIMITS.titleLength} characters.`);
    next.title = title;
  }
  if (move) {
    if (draft.folderId !== null) {
      const target = store.get("routine_folder", draft.folderId);
      if (!target?.content || target.deleted) throw new Error("Choose an available folder.");
    }
    next.folderId = draft.folderId;
    next.position = nextRoutinePosition(store, draft.folderId);
  }
  if (!jsonEqual(current, next)) store.put("routine", id, next);
}

/**
 * The routines Train shows together with `id`, in Train's order: the routines of its folder, or,
 * when it has none or its folder is gone, the routines not in a folder.
 */
function routineGroupOf(store: DeviceStore, id: string) {
  const folders = new Set(
    store
      .list("routine_folder")
      .filter((row) => row.content && !row.deleted)
      .map((row) => row.id),
  );
  const groupOf = (content: JsonObject) => {
    const filed = typeof content.folderId === "string" ? content.folderId : null;
    return filed && folders.has(filed) ? filed : null;
  };
  const moved = store.get("routine", id);
  if (moved?.deleted || !moved?.content) throw new Error("This routine is no longer available.");
  const group = groupOf(moved.content);
  const position = (content: JsonObject | null) => Number(content?.position ?? 0);
  return store
    .list("routine")
    .filter((row) => row.content && !row.deleted && groupOf(row.content) === group)
    .sort((a, b) => position(a.content) - position(b.content) || (a.id < b.id ? -1 : 1));
}

/**
 * Moves a routine to place `to` among the routines Train shows with it. `seen` is that group's
 * order as it was on screen; a group that changed since is refused, so a drop never lands
 * somewhere the person didn't see. Only the routine's position changes, to one between its new
 * neighbours', unless no number fits there: then the group is numbered afresh, changing each
 * routine whose position moves.
 */
export function moveRoutine(store: DeviceStore, id: string, seen: readonly string[], to: number) {
  const group = routineGroupOf(store, id);
  if (
    !jsonEqual(
      group.map((row) => row.id),
      [...seen],
    )
  )
    throw new Error("Your routines changed. Try moving it again.");
  const from = group.findIndex((row) => row.id === id);
  const moved = group[from];
  if (!moved?.content || to === from || to < 0 || to >= group.length) return;
  if (moved.problem || moved.fromRestore)
    throw new Error("Resolve the sync issue on this routine before moving it.");
  const order = [...group];
  order.splice(from, 1);
  order.splice(to, 0, moved);
  const before = order[to - 1]?.content?.position;
  const after = order[to + 1]?.content?.position;
  const low = typeof before === "number" ? before : -MAX_POSITION;
  const high = typeof after === "number" ? after : MAX_POSITION;
  const position =
    before === undefined ? high - 1 : after === undefined ? low + 1 : (low + high) / 2;
  if (low < position && position < high) {
    store.put("routine", id, { ...moved.content, position });
    return;
  }
  // Equal neighbours, exhausted floating-point precision, or the protocol bound leave no gap.
  const writes = order.flatMap((row, i) => {
    if (!row.content || row.content.position === i + 1) return [];
    if (row.problem || row.fromRestore)
      throw new Error("Resolve the sync issues in this folder before reordering it.");
    return [{ kind: "routine", id: row.id, content: { ...row.content, position: i + 1 } }];
  });
  store.putMany(writes);
}

/**
 * Deletes the routine as it was opened. Workouts started from it keep their own copy of what was
 * done, so History is unchanged; a workout running from it carries on. A version that arrived since
 * it was opened is refused, so an edit made elsewhere is never deleted unseen.
 */
export function deleteRoutine(store: DeviceStore, id: string, opened: JsonObject): void {
  const record = store.get("routine", id);
  if (record?.deleted || !record?.content) throw new Error("This routine is no longer available.");
  if (record.problem) throw new Error("Resolve the sync issue on this routine before deleting it.");
  if (record.fromRestore) throw new Error("Sync this routine before deleting it.");
  if (!jsonEqual(record.content, opened))
    throw new Error("This routine changed. Reopen it to see the latest before deleting it.");
  store.delete("routine", id);
}
