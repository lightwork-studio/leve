import type { RecordContent } from "@leve/contract";
import { LIMITS } from "@leve/core";
import type { DeviceStore } from "@leve/storage";
import type { WorkoutNote } from "../model/types.ts";
import { newId } from "./ids.ts";

export function workoutNoteReadOnlyReason(store: DeviceStore): string | null {
  const { account, release, refreshFrom, restoring } = store.syncState();
  if (account === null) return null;
  if (release === null || !store.contract.featureAvailable("workout_journal", release))
    return "Update the connected server to edit workout notes.";
  if (restoring || refreshFrom) return "Workout notes will be editable when this sync finishes.";
  return null;
}

/** Release a reminder without editing its source text or linked reply. */
export function unpinWorkoutNote(store: DeviceStore, workoutId: string, noteId: string) {
  const reason = workoutNoteReadOnlyReason(store);
  if (reason) throw Error(reason);
  const source = store.get("workout", workoutId);
  const note = store.get("workout_note", noteId);
  if (
    !source?.content ||
    source.deleted ||
    !note?.content ||
    note.deleted ||
    note.content.workoutId !== workoutId
  )
    throw Error("This note is no longer available in its source workout.");
  if (
    (source.status === "conflict" && source.server?.state === "deleted") ||
    note.status === "conflict" ||
    note.status === "invalid"
  )
    throw Error("Review the sync issue in the source workout before unpinning this note.");
  if (note.content.kind === "sticky")
    store.put("workout_note", noteId, { ...note.content, kind: "session" });
}

export interface NoteDraft {
  text: string;
  kind: WorkoutNote["kind"];
  reply: string;
}

/** Apply one note edit to the latest local workout. Other notes may have changed since opening. */
export function writeWorkoutNote(
  store: DeviceStore,
  workoutId: string,
  original: WorkoutNote | null,
  draft: NoteDraft | null,
) {
  const reason = workoutNoteReadOnlyReason(store);
  if (reason) throw Error(reason);
  const row = store.get("workout", workoutId);
  if (!row?.content || row.deleted) throw Error("This workout is no longer available.");
  const currentRow = original ? store.get("workout_note", original.id) : null;
  const content = currentRow?.deleted ? null : currentRow?.content;
  const current = content as unknown as RecordContent<"workout_note"> | null;
  if (
    original &&
    (current?.workoutId !== workoutId ||
      !current ||
      current.text !== original.text ||
      current.kind !== original.kind ||
      current.createdAt !== original.createdAt ||
      current.reply?.text !== original.reply?.text ||
      current.reply?.createdAt !== original.reply?.createdAt)
  ) {
    throw Error("This note changed. Reopen it to see the latest version.");
  }
  if (currentRow?.status === "conflict")
    throw Error("Review the sync issue before editing this note.");
  if (!draft && !original) return;
  if (draft) {
    const text = draft.text.trim();
    const answer = draft.reply.trim();
    if (!text) throw Error("Enter a note.");
    if (text.length > LIMITS.noteLength || answer.length > LIMITS.noteLength)
      throw Error("The note or reply is too long.");
    const now = new Date().toISOString();
    const note = {
      workoutId,
      createdAt: current?.createdAt ?? now,
      text,
      kind: draft.kind,
      reply: answer ? { text: answer, createdAt: current?.reply?.createdAt ?? now } : null,
    };
    store.put("workout_note", original?.id ?? newId(), note);
  } else if (original) {
    store.delete("workout_note", original.id);
  }
}
