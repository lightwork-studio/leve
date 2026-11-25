import { type JsonObject, jsonEqual } from "@leve/contract";
import type { DeviceRecord, DeviceStore } from "@leve/storage";
import type { ExerciseNote, NoteComment, WithId, Workout, WorkoutEntry } from "../model/types.ts";
import { type ExerciseCardNotes, exerciseCardNotes } from "../model/workout-notes.ts";
import { newId } from "./ids.ts";
import { checkedNoteText, workoutNoteReadOnlyReason } from "./workout-notes.ts";

// Exercise notes and the comments on workout and exercise notes. An exercise note belongs to the
// exercise, not to the workout it was written in, so a pinned one outlives that workout.

/** How many pinned notes one exercise may have. */
export const MAX_PINNED_PER_EXERCISE = 20;
/** How many comments one note may have. */
export const MAX_COMMENTS_PER_NOTE = 100;

export type NoteKind = "workout_note" | "exercise_note";
const COMMENT_KIND = {
  workout_note: "workout_note_comment",
  exercise_note: "exercise_note_comment",
} as const;

export function exerciseNoteReadOnlyReason(store: DeviceStore): string | null {
  const { account, release, refreshFrom, restoring } = store.syncState();
  if (account === null) return null;
  if (release === null || !store.contract.featureAvailable("exercise_notes", release))
    return "Update the connected server to edit exercise notes.";
  if (restoring || refreshFrom) return "Exercise notes will be editable when this sync finishes.";
  return null;
}

function readOnlyReason(store: DeviceStore, kind: NoteKind) {
  return kind === "workout_note"
    ? workoutNoteReadOnlyReason(store)
    : exerciseNoteReadOnlyReason(store);
}

function asExerciseNote({ id, content }: DeviceRecord): ExerciseNote {
  const note = content as unknown as Omit<ExerciseNote, "id">;
  return { ...note, id, workoutId: note.workoutId ?? null, agent: note.agent ?? null };
}

function asComment({ id, content }: DeviceRecord): NoteComment {
  const comment = content as unknown as Omit<NoteComment, "id">;
  return { ...comment, id, agent: comment.agent ?? null };
}

/** Every live exercise note, by exercise. */
export function exerciseNotesByExercise(store: DeviceStore) {
  const byExercise = new Map<string, ExerciseNote[]>();
  for (const row of store.list("exercise_note")) {
    const note = asExerciseNote(row);
    const notes = byExercise.get(note.exerciseId) ?? [];
    notes.push(note);
    byExercise.set(note.exerciseId, notes);
  }
  return byExercise;
}

/** Comments on notes of one kind, by note, oldest first. */
export function commentsByNote(store: DeviceStore, kind: NoteKind) {
  const byNote = new Map<string, NoteComment[]>();
  for (const row of store.list(COMMENT_KIND[kind])) {
    const comment = asComment(row);
    const comments = byNote.get(comment.noteId) ?? [];
    comments.push(comment);
    byNote.set(comment.noteId, comments);
  }
  for (const comments of byNote.values())
    comments.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  return byNote;
}

/**
 * The notes each exercise card of a workout shows, by exercise id. Notes that aren't pinned are due
 * once, in the next workout that includes their exercise.
 */
export function workoutExerciseNotes(
  store: DeviceStore,
  workoutId: string,
  history: ReadonlyMap<string, WithId<Workout>[]> = workoutsByExercise(store),
): Map<string, ExerciseCardNotes> {
  const result = new Map<string, ExerciseCardNotes>();
  const row = store.get("workout", workoutId);
  if (!row?.content || row.deleted) return result;
  const target: WithId<Workout> = { id: workoutId, content: row.content as unknown as Workout };
  const exerciseIds = new Set(
    store
      .list("workout_exercise", { parentId: workoutId })
      .map((entry) => (entry.content as unknown as WorkoutEntry).exerciseId),
  );
  if (exerciseIds.size === 0) return result;
  const notes = exerciseNotesByExercise(store);
  if (![...exerciseIds].some((id) => notes.has(id))) return result;
  const comments = commentsByNote(store, "exercise_note");
  for (const exerciseId of exerciseIds) {
    const own = notes.get(exerciseId);
    if (!own) continue;
    result.set(exerciseId, exerciseCardNotes(own, target, history.get(exerciseId) ?? [], comments));
  }
  return result;
}

/**
 * The workouts that include each exercise. It reads all of history, so the running workout keeps
 * it until history changes rather than reading it again for every set.
 */
export function workoutsByExercise(store: DeviceStore) {
  const workouts = new Map(
    store
      .list("workout")
      .map((workout) => [
        workout.id,
        { id: workout.id, content: workout.content as unknown as Workout },
      ]),
  );
  const byExercise = new Map<string, WithId<Workout>[]>();
  for (const entry of store.list("workout_exercise")) {
    const { exerciseId, workoutId: owner } = entry.content as unknown as WorkoutEntry;
    const workout = workouts.get(owner);
    if (!workout) continue;
    const list = byExercise.get(exerciseId) ?? [];
    if (!list.some((item) => item.id === workout.id)) list.push(workout);
    byExercise.set(exerciseId, list);
  }
  return byExercise;
}

/** Notes written in one workout, by exercise id, oldest first: what a finished workout shows. */
export function notesWrittenIn(store: DeviceStore, workoutId: string) {
  const result = new Map<string, ExerciseNote[]>();
  for (const notes of exerciseNotesByExercise(store).values())
    for (const note of notes)
      if (note.workoutId === workoutId) {
        const list = result.get(note.exerciseId) ?? [];
        list.push(note);
        result.set(note.exerciseId, list);
      }
  for (const list of result.values())
    list.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  return result;
}

function pinnedCount(store: DeviceStore, exerciseId: string, except?: string) {
  return (exerciseNotesByExercise(store).get(exerciseId) ?? []).filter(
    (note) => note.pinned && note.id !== except,
  ).length;
}

function editableNote(store: DeviceStore, kind: NoteKind, id: string) {
  const reason = readOnlyReason(store, kind);
  if (reason) throw Error(reason);
  const row = store.get(kind, id);
  if (!row?.content || row.deleted) throw Error("This note is no longer available.");
  if (row.status === "conflict" || row.status === "invalid")
    throw Error("Review the sync issue on this note first.");
  return row;
}

/**
 * Write a new note on an exercise. `workoutId` is the workout it was written in, or null when it
 * was written outside one, such as on the exercise screen. Returns the new note's id.
 */
export function addExerciseNote(
  store: DeviceStore,
  note: { exerciseId: string; workoutId: string | null; text: string; pinned: boolean },
) {
  const reason = exerciseNoteReadOnlyReason(store);
  if (reason) throw Error(reason);
  const text = checkedNoteText(note.text);
  if (note.workoutId !== null) {
    const workout = store.get("workout", note.workoutId);
    if (!workout?.content || workout.deleted) throw Error("This workout is no longer available.");
  }
  if (note.pinned && pinnedCount(store, note.exerciseId) >= MAX_PINNED_PER_EXERCISE)
    throw Error(`This exercise already has ${MAX_PINNED_PER_EXERCISE} pinned notes.`);
  const id = newId();
  store.put("exercise_note", id, {
    exerciseId: note.exerciseId,
    workoutId: note.workoutId,
    pinned: note.pinned,
    text,
    createdAt: new Date().toISOString(),
    agent: null,
  });
  return id;
}

/** Change an exercise note's text. Only the lifter's own notes can be changed here. */
export function editExerciseNote(store: DeviceStore, id: string, text: string) {
  const row = editableNote(store, "exercise_note", id);
  if ((row.content?.agent ?? null) !== null)
    throw Error("Only the agent that wrote this note can change its text.");
  store.put("exercise_note", id, { ...(row.content as JsonObject), text: checkedNoteText(text) });
}

/** Pin or unpin an exercise note. */
export function setExerciseNotePinned(store: DeviceStore, id: string, pinned: boolean) {
  const row = editableNote(store, "exercise_note", id);
  const content = row.content as JsonObject;
  if (content.pinned === pinned) return;
  if (pinned && pinnedCount(store, content.exerciseId as string, id) >= MAX_PINNED_PER_EXERCISE)
    throw Error(`This exercise already has ${MAX_PINNED_PER_EXERCISE} pinned notes.`);
  store.put("exercise_note", id, { ...content, pinned });
}

/** Delete an exercise note with its comments. */
export function deleteExerciseNote(store: DeviceStore, id: string) {
  const reason = exerciseNoteReadOnlyReason(store);
  if (reason) throw Error(reason);
  const row = store.get("exercise_note", id);
  if (!row?.content || row.deleted) return;
  store.delete("exercise_note", id);
}

/** Add the lifter's comment to a workout or exercise note. Returns the new comment's id. */
export function addNoteComment(store: DeviceStore, kind: NoteKind, noteId: string, text: string) {
  editableNote(store, kind, noteId);
  if ((commentsByNote(store, kind).get(noteId)?.length ?? 0) >= MAX_COMMENTS_PER_NOTE)
    throw Error(`This note already has ${MAX_COMMENTS_PER_NOTE} comments.`);
  const id = newId();
  store.put(COMMENT_KIND[kind], id, {
    noteId,
    text: checkedNoteText(text),
    createdAt: new Date().toISOString(),
    agent: null,
  });
  return id;
}

/** Delete one of the lifter's own comments. */
export function deleteNoteComment(store: DeviceStore, kind: NoteKind, id: string) {
  const reason = readOnlyReason(store, kind);
  if (reason) throw Error(reason);
  const row = store.get(COMMENT_KIND[kind], id);
  if (!row?.content || row.deleted) return;
  if ((row.content.agent ?? null) !== null) throw Error("Only its agent can delete this comment.");
  store.delete(COMMENT_KIND[kind], id);
}

/**
 * Settle a note or comment's sync problem with the version the lifter picked: this device's, or
 * the one the server holds.
 */
export function resolveNoteProblem(
  store: DeviceStore,
  shown: DeviceRecord,
  choice: "keep_mine" | "keep_theirs",
) {
  const row = store.get(shown.kind, shown.id);
  if (!row?.problem || !jsonEqual(row, shown))
    throw Error("This note changed. Review the latest versions before choosing.");
  const kind: NoteKind = row.kind.startsWith("workout_note") ? "workout_note" : "exercise_note";
  const reason = readOnlyReason(store, kind);
  if (reason) throw Error(reason);
  if (row.inFlight) throw Error("Finish the current sync before choosing a version.");
  if (choice === "keep_mine" && !row.content)
    throw Error("This note was deleted here. Take the other version to keep it.");
  return store.resolve(row.kind, row.id, { choice });
}
