import { type JsonObject, jsonEqual, MAX_POSITION } from "@leve/contract";
import { type EffortScale, LIMITS } from "@leve/core";
import type { DeviceStore } from "@leve/storage";

import type { StoredPlan } from "./routine-actions.ts";

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
    const siblings = store.list("routine").filter((r) => r.content?.folderId === draft.folderId);
    const last = siblings.at(-1)?.content?.position;
    next.folderId = draft.folderId;
    next.position = Math.min(MAX_POSITION, typeof last === "number" ? last + 1 : 1);
  }
  if (!jsonEqual(current, next)) store.put("routine", id, next);
}

/**
 * Deletes the routine as it was opened. Workouts started from it keep their own copy of what was
 * done, so History is unchanged; a workout running from it carries on. A version that arrived since
 * it was opened is refused, so an edit made elsewhere is never deleted unseen.
 */
export function deleteRoutine(store: DeviceStore, id: string, opened: JsonObject): void {
  const record = store.get("routine", id);
  if (record?.deleted || !record?.content) throw new Error("This routine is no longer available.");
  if (record.problem || record.fromRestore)
    throw new Error("Resolve the sync issue on this routine before deleting it.");
  if (!jsonEqual(record.content, opened))
    throw new Error("This routine changed. Reopen it to see the latest before deleting it.");
  store.delete("routine", id);
}
