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

/** Stop a pinned note from coming back, without touching its text or comments. */
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
  if (note.content.pinned === true)
    store.put("workout_note", noteId, { ...note.content, pinned: false });
}

/**
 * Whether notes on this workout can be pinned: pinned notes come back in later workouts of its
 * routine, so a workout without one has nowhere for them to go.
 */
export function canPinWorkoutNotes(workout: { routineId?: unknown }) {
  return typeof workout.routineId === "string";
}

export interface NoteDraft {
  text: string;
  pinned: boolean;
}

/** The note text as it will be saved, or an error for one that can't be. */
export function checkedNoteText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw Error("Enter a note.");
  if (trimmed.length > LIMITS.noteLength) throw Error("The note is too long.");
  return trimmed;
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
      current.pinned !== original.pinned ||
      current.createdAt !== original.createdAt)
  ) {
    throw Error("This note changed. Reopen it to see the latest version.");
  }
  if (currentRow?.status === "conflict")
    throw Error("Review the sync issue before editing this note.");
  if (original && (current?.agent ?? null) !== null && draft && draft.text !== original.text)
    throw Error("Only the agent that wrote this note can change its text.");
  if (draft?.pinned && !current?.pinned && !canPinWorkoutNotes(row.content))
    throw Error("Only notes on a routine workout can be pinned.");
  if (!draft && !original) return;
  if (draft) {
    // Text left as it was is kept exactly, so pinning an agent's note never trims it.
    const text =
      current && draft.text === current.text ? current.text : checkedNoteText(draft.text);
    const note = {
      workoutId,
      createdAt: current?.createdAt ?? new Date().toISOString(),
      text,
      pinned: draft.pinned,
      agent: current?.agent ?? null,
    };
    store.put("workout_note", original?.id ?? newId(), note);
  } else if (original) {
    store.delete("workout_note", original.id);
  }
}
